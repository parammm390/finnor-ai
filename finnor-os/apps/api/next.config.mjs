/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

const nextConfig = {
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
  serverExternalPackages: ["pg", "ioredis", "groq-sdk", "pdf-parse", "pino", "thread-stream", "pino-pretty", "@axiomhq/pino"],
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};
export default nextConfig;
