/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const nextConfig = {
  // This repository has no ESLint build contract. Recovery worktrees can be nested
  // below unrelated checkouts with an ESLint config, which Next would otherwise
  // discover and execute. TypeScript validation remains enabled below by default.
  eslint: { ignoreDuringBuilds: true },
  // Release builds provide a commit-derived value. Keeping the Next build ID
  // deterministic makes the runtime release record independently checkable.
  generateBuildId: async () => process.env.FINNOR_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA || null,
  transpilePackages: [
    "@finnor/shared-types",
    "@finnor/policy-schema",
    "@finnor/db",
    "@finnor/provider-microsoft365",
    "@finnor/memory",
    "@finnor/tools",
    "@finnor/orchestration",
  ],
  // pdf-parse starts its own Node worker during verified corpus ingestion, and Pino's
  // transport starts a thread-stream worker for structured logs. Bundling either
  // rewrites its worker path into `.next/server/chunks/lib/worker.js`, which does not
  // exist at static-generation time. Keep the Node-only stacks external.
  serverExternalPackages: ["pg", "ioredis", "groq-sdk", "pdf-parse", "pino", "thread-stream", "pino-pretty", "@axiomhq/pino", "tsx", "esbuild", "fs-ext", "@finnor/source-custody"],
  // The separately compiled S6 runtime uses Node ESM .js specifiers. Resolve
  // those same imports to original TS when bundling the ordinary API client.
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  webpack: (config, { webpack, isServer }) => {
    // Native numerical workers read and hash their original files. Webpack's
    // asset URL wrapper is not a Node file URL and cannot replace that binding.
    config.module.parser = {
      ...config.module.parser,
      // createRequire().resolve("tsx") resolves a loader filename, not an ESM
      // import. Preserve Node's native resolution rather than compiling it into
      // a webpack module ID or applying webpack's require-of-ESM rejection.
      javascript: { ...config.module.parser?.javascript, url: false, worker: false, createRequire: false },
    };
    if (isServer) {
      // API release builds use an isolated context once. Avoid writing a large
      // disposable disk cache alongside the immutable function artifacts.
      config.cache = { type: "memory" };
      // These four imports deliberately load retained, hashed TS producer
      // files. A webpack expression-context module cannot represent file URLs.
      config.module.rules.push({
        test: /[/\\]branch-fabric[/\\]producer-adapters\.ts$/,
        parser: { import: false },
      });
      // Native methods hash and execute original source files. Bind their
      // import.meta paths to the deployed canonical tree, not the build host
      // or a webpack chunk. This changes packaging, not the native method.
      const meta = (method, original) => webpack.DefinePlugin.runtimeValue(({ module }) => {
        const source = module.resource?.split("?")[0];
        const path = source && relative(repositoryRoot, source).replaceAll("\\", "/");
        if (path && /^finnor-os\/(?:packages|scripts|apps)\//.test(path) && !path.includes("/node_modules/")) {
          return `require("@finnor/source-custody").${method}(${JSON.stringify(path)})`;
        }
        return JSON.stringify(source ? original(source) : "");
      }, true);
      config.plugins.push(new webpack.DefinePlugin({
        "import.meta.url": meta("sourceURL", source => new URL(`file://${source}`).href),
        "import.meta.dirname": meta("sourceDirectory", dirname),
      }));
    }
    return config;
  },
  outputFileTracingRoot: repositoryRoot,
  outputFileTracingIncludes: {
    "/api/*": [
      "../../../package-lock.json", "../../../infra/deployment/production.contract.json",
      "../../tsconfig.json", "../../tsconfig.base.json",
      "../../package-lock.json", "../../packages/**/*.ts", "../../packages/**/*.mts",
      "../../packages/**/*.m", "../../packages/**/*.py", "../../packages/**/*.sql",
      "../../packages/**/*.mjs", "../../packages/**/*.cjs",
      "../../packages/**/package.json", "../../packages/source-custody/index.cjs",
      "../../packages/**/fixtures/*.json", "../../scripts/p3/**/*.{ts,mts,cjs,mjs}",
      "../../apps/worker/src/**/*.ts", "./app/api/**/*.ts",
      "../../node_modules/fs-ext/**/*", "../../node_modules/tsx/**/*", "../../node_modules/esbuild/**/*",
    ],
  },
};
export default nextConfig;
