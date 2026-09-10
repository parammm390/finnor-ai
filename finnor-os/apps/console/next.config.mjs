/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";

const nextConfig = {
  // Avoid inheriting an ESLint configuration from a parent recovery checkout.
  // The production build still performs Next's TypeScript validation.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ["@finnor/shared-types", "@finnor/policy-schema"],
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};
export default nextConfig;
