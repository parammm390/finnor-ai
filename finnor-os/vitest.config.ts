import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // finnor-os is a backend monorepo with zero CSS of its own, but Vite's CSS plugin
  // eagerly resolves a postcss config at server-init time regardless of `test.css` --
  // `postcss-load-config`'s searchPath starts at finnor-os and, finding no config here,
  // walks UP into the marketing site's postcss.config.js at the true repo root
  // (finnor-os/ lives nested inside it), which needs `tailwindcss` -- a dependency this
  // workspace's own `npm ci` never installs. Worked locally by accident only because the
  // repo root's own node_modules (installed separately for marketing-site work) happened
  // to already have it; crashed for real on a clean CI checkout with `Cannot find module
  // 'tailwindcss'`, the first real signal from this repo's first-ever green CI run.
  // Passing a literal (empty) postcss config here bypasses the filesystem search
  // entirely -- verified by reproducing the exact CI crash locally (temporarily hiding
  // node_modules/tailwindcss) before and after this fix.
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@finnor/shared-types": r("./packages/shared-types/src/index.ts"),
      "@finnor/policy-schema": r("./packages/policy-schema/src/index.ts"),
      // Deep subpath imports (apps/api's admin/migrate route uses these two) — must
      // come before the bare "@finnor/db" entry below since Vite's object-form alias
      // resolves in listed order and a bare key would otherwise never get reached for
      // these more specific ones if it matched first.
      "@finnor/db/migrate": r("./packages/db/migrate.ts"),
      "@finnor/db/seed": r("./packages/db/seed.ts"),
      "@finnor/db/migrations-bundle": r("./packages/db/migrations-bundle.ts"),
      "@finnor/db": r("./packages/db/index.ts"),
      "@finnor/authority": r("./packages/authority/src/index.ts"),
      "@finnor/computer": r("./packages/computer/src/index.ts"),
      "@finnor/data-platform": r("./packages/data-platform/src/index.ts"),
      "@finnor/import-engine": r("./packages/import-engine/src/index.ts"),
      "@finnor/workflow-runtime": r("./packages/workflow-runtime/src/index.ts"),
      "@finnor/memory": r("./packages/memory/src/index.ts"),
      "@finnor/security": r("./packages/security/src/index.ts"),
      "@finnor/tools/llm": r("./packages/tools/src/llm.ts"),
      "@finnor/tools/registry": r("./packages/tools/src/registry.ts"),
      "@finnor/tools/firecrawl": r("./packages/tools/src/firecrawl.ts"),
      "@finnor/tools": r("./packages/tools/src/index.ts"),
      "@finnor/orchestration": r("./packages/orchestration/src/index.ts"),
      "@finnor/voice-os": r("./packages/voice-os/src/index.ts"),
      "@finnor/read-models": r("./packages/read-models/src/index.ts"),
      "@finnor/private-equity": r("./packages/private-equity/src/index.ts"),
      "@finnor/plugins-shared": r("./packages/domain-plugins/shared/plugin-interface.ts"),
    },
  },
  test: {
    // Keep package-local contract tests in the default suite. Restricting discovery
    // to tests/ silently skipped the orchestration trace sanitizer and ops-overview
    // plugin tests even though `npm test` appeared green.
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts", "apps/**/*.test.ts"],
    setupFiles: ["./tests/vertical-fixture-setup.ts"],
    testTimeout: 30_000,
    pool: "forks",
    // Integration tests share ONE real database (migrations, jobs table, tenant rows).
    // Running test files in parallel races on shared mutable state (and on catalog-level
    // DDL like ALTER ROLE during migrate()) — serialize files, keep tests within a file
    // concurrent since those were written to be independent of each other.
    fileParallelism: false,
  },
});
