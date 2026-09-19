import { afterEach, describe, expect, it } from "vitest";

import { FakeSurface, type FakePageState } from "../src/surface/FakeSurface";
import { GuardedSurface, ControlNotOwnedError, EscalationRequired } from "../src/surface/GuardedSurface";
import { LocatorUnresolvedError } from "../src/surface/Surface";
import { loadPolicy, clearPolicyCache, PolicyViolation, type Policy } from "../src/guardrails/policy";
import { redact, redactDeep, registerPiiValue, registerSecretValue, clearRegistry, buildMaskSpecs } from "../src/guardrails/redact";
import type { LocatorSpec } from "../src/schema/capability";

const POLICY_PATH = new URL("../policy.yaml", import.meta.url).pathname;

function loadTestPolicy(): Policy {
  clearPolicyCache();
  return loadPolicy(POLICY_PATH);
}

const HOME_STATE: FakePageState = {
  url: "http://localhost:4173/",
  title: "CU Console",
  snapshotText: "e0: link 'Home'",
};

function makeSpec(locators: LocatorSpec["strategyChain"]): LocatorSpec {
  return { strategyChain: locators };
}

/** Deep-clones the loaded policy fixture and overrides `risk.irreversible_policy`. */
function withIrreversiblePolicy(policy: Policy, irreversiblePolicy: Policy["risk"]["irreversible_policy"]): Policy {
  return {
    ...policy,
    risk: { ...policy.risk, irreversible_policy: irreversiblePolicy },
  };
}

/** Deep-clones the loaded policy fixture and overrides `allowlist.actions`. */
function withAllowedActions(policy: Policy, actions: string[]): Policy {
  return {
    ...policy,
    allowlist: { ...policy.allowlist, actions },
  };
}

describe("guardrails", () => {
  afterEach(() => {
    clearRegistry();
    delete process.env.DEMO_PASS;
  });

  // 1. off-allowlist navigate throws PolicyViolation
  describe("allowlist", () => {
    it("throws PolicyViolation for a navigate action off the allowlist (wrong origin)", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(
        guarded.act({ kind: "navigate", value: "http://evil.example.com/steal" }),
      ).rejects.toThrow(PolicyViolation);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("throws PolicyViolation for a navigate action on the right origin but an unlisted route", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(
        guarded.act({ kind: "navigate", value: "http://localhost:4173/admin/secret" }),
      ).rejects.toThrow(PolicyViolation);
    });

    it("allows a navigate action on an allowlisted origin+route", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE, HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(
        guarded.act({ kind: "navigate", value: "http://localhost:4173/member/10001" }),
      ).resolves.toBeUndefined();
      expect(fake.recordedActions).toHaveLength(1);
    });
  });

  // 2. redact() scrubs a registered pii value AND a policy regex pattern hit
  describe("redact", () => {
    it("scrubs a registered pii value out of a string", () => {
      const policy = loadTestPolicy();
      registerPiiValue("Jane Q. Public");
      const result = redact("Member name: Jane Q. Public, approved.", policy);
      expect(result).not.toContain("Jane Q. Public");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs text matching a policy.yaml redaction pattern (email)", () => {
      const policy = loadTestPolicy();
      const result = redact("Contact: teller@example.com for help", policy);
      expect(result).not.toContain("teller@example.com");
      expect(result).toContain("[REDACTED]");
    });

    it("scrubs text matching the acct pattern", () => {
      const policy = loadTestPolicy();
      const result = redact("Account number 123456789012 was debited", policy);
      expect(result).not.toContain("123456789012");
    });

    it("does not leak the suffix of a longer registered value when a shorter registered value is its prefix (regression)", () => {
      // Reproduces the reviewer-found bug: registering "pass1" then "pass12345" and doing
      // one .replace() pass per value in Set insertion (registration) order let the "pass1"
      // pass partially consume "pass12345"'s occurrence, leaving "2345" unredacted. Sorting
      // registered values longest-first before replacing fixes this.
      const policy = loadTestPolicy();
      registerSecretValue("pass1");
      registerSecretValue("pass12345");
      const result = redact("login attempt with password pass12345 failed", policy);
      expect(result).not.toContain("2345");
      expect(result).not.toContain("pass12345");
      expect(result).not.toContain("pass1");
      expect(result).toBe("login attempt with password [REDACTED] failed");
    });

    it("redactDeep walks nested structures, leaving numbers/booleans/null untouched", () => {
      const policy = loadTestPolicy();
      registerPiiValue("secretname");
      const input = {
        a: "hello secretname world",
        b: 42,
        c: true,
        d: null,
        e: ["secretname", 7],
      };
      const result = redactDeep(input, policy) as typeof input;
      expect(result.a).toContain("[REDACTED]");
      expect(result.b).toBe(42);
      expect(result.c).toBe(true);
      expect(result.d).toBeNull();
      expect(result.e[0]).toBe("[REDACTED]");
      expect(result.e[1]).toBe(7);
      // original untouched
      expect(input.a).toBe("hello secretname world");
    });
  });

  // 3. buildMaskSpecs pass-through contract
  describe("buildMaskSpecs", () => {
    it("returns the array it was given (pass-through seam, documented in redact.ts)", () => {
      const specs: LocatorSpec[] = [makeSpec([{ kind: "role", role: "cell", accessibleName: "Balance" }])];
      expect(buildMaskSpecs(specs)).toBe(specs);
    });
  });

  // 4. secret substitution
  describe("secret substitution", () => {
    it("substitutes {{secret:NAME}} with the real env value before delegating to the wrapped surface", async () => {
      process.env.DEMO_PASS = "the-real-secret-value";
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await guarded.act({ kind: "fill", ref: "e1", value: "{{secret:DEMO_PASS}}" });

      expect(fake.recordedActions[0]?.value).toBe("the-real-secret-value");
    });

    it("throws (without leaking the missing var's value, since there is none) when the secret is unset", async () => {
      delete process.env.DOES_NOT_EXIST;
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(
        guarded.act({ kind: "fill", ref: "e1", value: "{{secret:DOES_NOT_EXIST}}" }),
      ).rejects.toThrow(/DOES_NOT_EXIST/);
    });

    it("the redaction registry mechanism scrubs a secret value if it ever appeared in a log entry", () => {
      const policy = loadTestPolicy();
      registerSecretValue("the-real-secret-value");
      const logLine = redact("action value was: the-real-secret-value", policy);
      expect(logLine).not.toContain("the-real-secret-value");
      expect(logLine).toContain("[REDACTED]");
    });

    it("cheap insurance: a thrown GuardedSurface error's .message never contains the resolved secret value, even when the action is subsequently blocked by an unrelated guard", async () => {
      // Today's code has no leak path per code reading (substitution happens after all
      // throwing checks), but this pins that invariant so it stays true if check ordering
      // ever changes.
      process.env.DEMO_PASS = "the-real-secret-value";
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { getOwner: () => "human" });

      let thrown: Error | undefined;
      try {
        await guarded.act({ kind: "fill", ref: "e1", value: "{{secret:DEMO_PASS}}" });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeInstanceOf(ControlNotOwnedError);
      expect(thrown?.message).not.toContain("the-real-secret-value");
    });
  });

  // 5. irreversible_policy: "escalate"
  describe("irreversible risk under irreversible_policy: escalate", () => {
    it("throws EscalationRequired on a draft capability", async () => {
      const policy = loadTestPolicy();
      expect(policy.risk.irreversible_policy).toBe("escalate");
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "draft" });

      await expect(
        guarded.act({ kind: "click", ref: "e2", risk: "irreversible" }),
      ).rejects.toThrow(EscalationRequired);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("proceeds without throwing on an approved capability, and the inner surface receives it", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "approved" });

      await guarded.act({ kind: "click", ref: "e2", risk: "irreversible" });

      expect(fake.recordedActions).toHaveLength(1);
      expect(fake.recordedActions[0]?.risk).toBe("irreversible");
    });
  });

  // irreversible_policy: "block" and "allow_if_approved" — untested branches flagged by
  // code review (the shipped policy.yaml is always "escalate", so these two of three
  // branches of the most safety-critical conditional in GuardedSurface were never exercised).
  describe("irreversible risk under irreversible_policy: block", () => {
    it("throws PolicyViolation regardless of capabilityStatus (draft)", async () => {
      const policy = withIrreversiblePolicy(loadTestPolicy(), "block");
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "draft" });

      await expect(
        guarded.act({ kind: "click", ref: "e2", risk: "irreversible" }),
      ).rejects.toThrow(PolicyViolation);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("throws PolicyViolation regardless of capabilityStatus (approved)", async () => {
      const policy = withIrreversiblePolicy(loadTestPolicy(), "block");
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "approved" });

      await expect(
        guarded.act({ kind: "click", ref: "e2", risk: "irreversible" }),
      ).rejects.toThrow(PolicyViolation);
      expect(fake.recordedActions).toHaveLength(0);
    });
  });

  describe("irreversible risk under irreversible_policy: allow_if_approved", () => {
    it("throws PolicyViolation on a draft capability", async () => {
      const policy = withIrreversiblePolicy(loadTestPolicy(), "allow_if_approved");
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "draft" });

      await expect(
        guarded.act({ kind: "click", ref: "e2", risk: "irreversible" }),
      ).rejects.toThrow(PolicyViolation);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("proceeds without throwing on an approved capability", async () => {
      const policy = withIrreversiblePolicy(loadTestPolicy(), "allow_if_approved");
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "approved" });

      await guarded.act({ kind: "click", ref: "e2", risk: "irreversible" });

      expect(fake.recordedActions).toHaveLength(1);
    });
  });

  describe("isActionAllowed", () => {
    it("blocks an action kind that isn't in a narrowed allowlist (extract missing)", async () => {
      const policy = withAllowedActions(loadTestPolicy(), ["click", "fill", "select_option", "navigate", "wait_for"]);
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(
        guarded.act({ kind: "extract", ref: "e3", extractName: "balance" }),
      ).rejects.toThrow(PolicyViolation);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("still allows an action kind present in the narrowed allowlist", async () => {
      const policy = withAllowedActions(loadTestPolicy(), ["click", "fill", "select_option", "navigate", "wait_for"]);
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(guarded.act({ kind: "click", ref: "e1" })).resolves.toBeUndefined();
    });
  });

  // 6. ControlNotOwnedError
  describe("control ownership", () => {
    it("throws ControlNotOwnedError when getOwner() reports anything other than automation", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy, { getOwner: () => "human" });

      await expect(guarded.act({ kind: "click", ref: "e1" })).rejects.toThrow(ControlNotOwnedError);
      expect(fake.recordedActions).toHaveLength(0);
    });

    it("does not throw when getOwner() reports automation (the default)", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([HOME_STATE]);
      const guarded = new GuardedSurface(fake, policy);

      await expect(guarded.act({ kind: "click", ref: "e1" })).resolves.toBeUndefined();
    });
  });

  // 7. LocatorUnresolvedError + FakeSurface tier fallback
  describe("locator resolution", () => {
    it("throws LocatorUnresolvedError when every tier fails to resolve", async () => {
      const state: FakePageState = {
        ...HOME_STATE,
        resolves: () => false,
      };
      const fake = new FakeSurface([state]);
      const spec = makeSpec([
        { kind: "role", role: "button", accessibleName: "Search" },
        { kind: "css", selector: ".c1" },
      ]);

      await expect(fake.act({ kind: "click", target: spec })).rejects.toThrow(LocatorUnresolvedError);
    });

    it("resolves at tier 1 when tier 0 fails and tier 1 succeeds, and does not throw", async () => {
      const state: FakePageState = {
        ...HOME_STATE,
        resolves: (_locator, tier) => tier === 1,
      };
      const fake = new FakeSurface([state]);
      const spec = makeSpec([
        { kind: "role", role: "button", accessibleName: "Search" },
        { kind: "css", selector: ".c1" },
      ]);

      const resolved = await fake.resolve(spec);
      expect(resolved).toEqual({ tier: 1, kind: "css" });

      await expect(fake.act({ kind: "click", target: spec })).resolves.toBeUndefined();
      expect(fake.recordedActions).toHaveLength(1);
    });

    it("propagates LocatorUnresolvedError through GuardedSurface.act() unchanged", async () => {
      const policy = loadTestPolicy();
      const state: FakePageState = { ...HOME_STATE, resolves: () => false };
      const fake = new FakeSurface([state]);
      const guarded = new GuardedSurface(fake, policy);
      const spec = makeSpec([{ kind: "role", role: "button", accessibleName: "Search" }]);

      await expect(guarded.act({ kind: "click", target: spec })).rejects.toThrow(LocatorUnresolvedError);
    });
  });
});
