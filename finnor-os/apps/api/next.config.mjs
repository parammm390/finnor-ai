/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

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
  serverExternalPackages: ["pg", "ioredis", "groq-sdk", "pdf-parse", "pino", "thread-stream", "pino-pretty", "@axiomhq/pino", "tsx", "esbuild", "fs-ext"],
  // The separately compiled S6 runtime uses Node ESM .js specifiers. Resolve
  // those same imports to original TS when bundling the ordinary API client.
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
  webpack: (config) => {
    // Native numerical workers read and hash their original files. Webpack's
    // asset URL wrapper is not a Node file URL and cannot replace that binding.
    config.module.parser = {
      ...config.module.parser,
      javascript: { ...config.module.parser?.javascript, url: false, worker: false },
    };
    return config;
  },
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};
export default nextConfig;
