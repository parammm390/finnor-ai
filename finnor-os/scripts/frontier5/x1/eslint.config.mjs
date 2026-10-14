import parser from "@typescript-eslint/parser";

export default [{
  files: ["finnor-os/packages/private-equity/src/institution-program/**/*.ts",
    "finnor-os/packages/db/migration-head.ts",
    "finnor-os/packages/private-equity/src/allocation-store.ts",
    "finnor-os/packages/private-equity/src/program-synthesis/**/*.ts",
    "finnor-os/packages/private-equity/src/live-recompilation/institution-dependencies.ts",
    "finnor-os/packages/orchestration/src/objective-loop.ts",
    "finnor-os/scripts/p5/native-fixture.mts",
    "finnor-os/scripts/p5/native-worker-client.mts",
    "finnor-os/scripts/p5/physical-worker.mts",
    "finnor-os/scripts/p5/run-crash-e2e.mts",
    "finnor-os/scripts/frontier5/x1/**/*.mts",
    "finnor-os/scripts/frontier5/x1/qualification-full-*.mjs",
    "finnor-os/scripts/frontier5/x1/qualification-public-assessment-cases.mjs",
    "finnor-os/scripts/frontier5/x1/qualification-*-cases.mjs",
    "finnor-os/scripts/frontier5/x1/reconstruction-timing-cases.mjs",
    "finnor-os/scripts/frontier5/x1/numeric-context-cases.mjs",
    "finnor-os/scripts/frontier5/x1/canvas-effect-cases.mjs"],
  languageOptions: { parser, parserOptions: { ecmaVersion: "latest", sourceType: "module" } },
  rules: { "no-debugger": "error", "no-constant-condition": "error", "no-duplicate-imports": "error" },
}];
