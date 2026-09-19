import { describe, expect, it } from "vitest";

import { FakeSurface, type FakePageState } from "../src/surface/FakeSurface";
import { locateStep } from "../src/replay/locate";
import type { LocatorSpec } from "../src/schema/capability";

const BASE_STATE: FakePageState = {
  url: "http://localhost:4173/",
  title: "CU Console",
  snapshotText: "e0: link 'Home'",
};

function makeSpec(chain: LocatorSpec["strategyChain"]): LocatorSpec {
  return { strategyChain: chain };
}

describe("locateStep", () => {
  it("resolves at tier 1 when tier 0 fails and tier 1 succeeds (SPEC §13 locate scenario)", async () => {
    const state: FakePageState = { ...BASE_STATE, resolves: (_locator, tier) => tier === 1 };
    const fake = new FakeSurface([state]);
    const spec = makeSpec([
      { kind: "role", role: "button", accessibleName: "Search" },
      { kind: "css", selector: ".c1" },
    ]);

    const resolved = await locateStep(fake, spec);

    expect(resolved).toEqual({ tier: 1, kind: "css" });
  });

  it("returns null when every tier fails to resolve (SPEC §13 locate scenario)", async () => {
    const state: FakePageState = { ...BASE_STATE, resolves: () => false };
    const fake = new FakeSurface([state]);
    const spec = makeSpec([
      { kind: "role", role: "button", accessibleName: "Search" },
      { kind: "css", selector: ".c1" },
      { kind: "xpath", selector: "//button" },
    ]);

    const resolved = await locateStep(fake, spec);

    expect(resolved).toBeNull();
  });

  it("resolves at tier 0 when the first tier already succeeds", async () => {
    const state: FakePageState = { ...BASE_STATE, resolves: (_locator, tier) => tier === 0 };
    const fake = new FakeSurface([state]);
    const spec = makeSpec([{ kind: "role", role: "link", accessibleName: "Home" }]);

    const resolved = await locateStep(fake, spec);

    expect(resolved).toEqual({ tier: 0, kind: "role" });
  });

  it("is a thin pass-through of surface.resolve() — a state with no `resolves` predicate at all resolves to null", async () => {
    const fake = new FakeSurface([BASE_STATE]);
    const spec = makeSpec([{ kind: "role", role: "link", accessibleName: "Home" }]);

    const resolved = await locateStep(fake, spec);

    expect(resolved).toBeNull();
  });
});
