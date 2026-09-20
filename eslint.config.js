// Minimal, TypeScript-aware ESLint flat config. Added post-review at explicit user request —
// not part of SPEC.md §1's original stack table (see package.json's "//eslint" comment).
//
// Kept deliberately narrow: tsc --noEmit already runs in strict mode across this whole
// project (see tsconfig.json), so this config layers on checks tsc *doesn't* do —
// unused bindings, floating promises, misused async, accidental non-null assertions — rather
// than re-deriving type-correctness rules tsc already enforces.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // eslint.config.js itself is excluded (not just ignored by the typed ruleset): it's plain
    // Node ESM outside the typed tsconfig.json project (which only includes src/+test/), and
    // ESLint's own convention is to not self-lint the config file under a type-aware ruleset.
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".pw-profile/**",
      "evidence/**",
      "artifacts/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // tsc's own strict mode already catches real type errors; don't duplicate its job with
      // stylistic type-annotation nags.
      "@typescript-eslint/no-inferrable-types": "off",
      // Unused bindings are a real, cheap-to-fix signal tsc doesn't catch by default here
      // (noUnusedLocals/noUnusedParameters aren't set in tsconfig.json).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // A forgotten `await` on a Promise (e.g. a guard check, a write, a browser action) is
      // exactly the class of bug this project's own build history repeatedly found and fixed
      // by hand (readline race conditions, unawaited queues) — worth a standing rule.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // `async` methods that don't `await` internally are a deliberate, pervasive pattern here:
      // Surface/Anthropic-client/etc. interfaces mandate Promise-returning signatures that
      // FakeSurface, test doubles, and a couple of default hook implementations satisfy
      // synchronously. Flagging every one of these would just be noise against an intentional
      // interface-conformance choice, not a real bug.
      "@typescript-eslint/require-await": "off",
      // `any` shows up deliberately in a few narrow spots (tenantOverrides' open-ended patch
      // shape, JSON parsing boundaries) — warn rather than error so those stay visible without
      // blocking the build.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    // Express types `req.body`/`req.query` as `any` by default (no body-parser type
    // augmentation package is in this project's dependency list, and adding one is out of
    // scope for a mock test fixture) — every "unsafe" finding in this deliberately-legacy
    // mock app traces back to that one structural gap, not to a real bug. The app's actual
    // runtime behavior (including malformed-input handling) was independently verified live,
    // repeatedly, via curl during this project's own review process.
    files: ["src/mockapp/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // Test files commonly construct minimal/partial fixtures and use `any` for fake surfaces —
    // relax the stricter checks there rather than fighting the test-authoring style already
    // established across this project's ~120 tests.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
);
