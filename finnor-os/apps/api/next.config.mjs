/** @type {import('next').NextConfig} */
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const z1TraceFiles = (() => {
  if (process.env.FINNOR_Z1_PACKAGE_BUILD !== "1") return [];
  const base = "../../packages/private-equity/src/project-z/z1-shared-work/";
  const manifest = JSON.parse(readFileSync(new URL(base+"installed-source-files.json",import.meta.url),"utf8"));
  if (manifest.schema !== "finnor.z1.native-source-files.v1" || !Array.isArray(manifest.files) ||
      manifest.files.length < 30 || manifest.files.length > 20000) throw new Error("Z1_WHOLE_OWNER_TRACE_MANIFEST_REQUIRED");
  return [base+"installed-source.json",base+"installed-source-files.json",...manifest.files.map(file => {
    if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").some(part=>part==="."||part==="..") ||
        /[\\%?#\u0000-\u001f]/.test(file.path)) throw new Error("Z1_TRACE_PATH_REQUIRED");
    // Next 15 changes backslashes to slashes before globbing, so ordinary
    // backslash escaping is lost. Bracket escapes preserve literal filenames.
    return [...relative(fileURLToPath(new URL("./",import.meta.url)),resolve(repositoryRoot,file.path))]
      .map(character => character === "[" ? "[[]" :
        "*?{}()+@".includes(character) ? "["+character+"]" : character).join("");
  })];
})();

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
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
    ...(process.env.FINNOR_Z2_BUILD_GRAPH === "1" ? { cpus: 1, webpackMemoryOptimizations: true } : {}),
  },
  webpack: (config, { webpack, isServer, nextRuntime }) => {
    // Native numerical workers read and hash their original files. Webpack's
    // asset URL wrapper is not a Node file URL and cannot replace that binding.
    config.module.parser = {
      ...config.module.parser,
      // createRequire().resolve("tsx") resolves a loader filename, not an ESM
      // import. Preserve Node's native resolution rather than compiling it into
      // a webpack module ID or applying webpack's require-of-ESM rejection.
      javascript: { ...config.module.parser?.javascript, url: false, worker: false, createRequire: false },
    };
    if (isServer && nextRuntime === "nodejs") {
      // Edge middleware is also a server compilation. Keep its framework
      // shims; only Node routes have real filesystem/source-custody identity.
      // Keep actual emitted CJS module identity separate from canonical source custody.
      config.node = { ...config.node, __filename: false, __dirname: false };
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
        "process.env.FINNOR_V4_BUILD_SOURCE_FILES_DIGEST": webpack.DefinePlugin.runtimeValue(() => {
          const manifest = new URL("../../packages/private-equity/src/capital-formation/method-files.json", import.meta.url);
          const paths = JSON.parse(readFileSync(manifest, "utf8"));
          const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value)
            ? "[" + value.map(canonical).join(",") + "]" : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
          const files = paths.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(new URL(path, new URL("../../../", import.meta.url)))).digest("hex") }));
          return JSON.stringify(createHash("sha256").update(canonical(files)).digest("hex"));
        }, true),
        "import.meta.url": meta("sourceURL", source => new URL(`file://${source}`).href),
        "import.meta.dirname": meta("sourceDirectory", dirname),
      }));
    }
    return config;
  },
  outputFileTracingRoot: repositoryRoot,
  outputFileTracingExcludes: {"/api/*": [
    "../../packages/epistemic-runtime/native/z4-execution-proof/target/**",
    "../../packages/epistemic-runtime/native/z4-execution-proof/.cargo-home/**",
    "../../packages/epistemic-runtime/native/z4-execution-proof/.cargo/**",
    "../../packages/epistemic-runtime/native/z4-execution-proof/.toolchain/**",
  ]},
  outputFileTracingIncludes: {
    "/api/*": [
      "../../../package-lock.json", "../../../infra/deployment/production.contract.json",
      "../../tsconfig.json", "../../tsconfig.base.json",
      "../../package-lock.json", "../../packages/**/*.ts", "../../packages/**/*.mts",
      "../../packages/private-equity/src/primary-diligence/checker-spec.md",
      "../../packages/private-equity/src/bilateral-opportunities/checker-spec.md",
      "../../packages/**/*.m", "../../packages/**/*.py", "../../packages/**/*.sql",
      "../../packages/**/*.mjs", "../../packages/**/*.cjs",
      "../../packages/private-equity/src/capital-formation/method-files.json",
      "../../packages/private-equity/src/economic-action-theory/profile.json",
      "../../packages/private-equity/src/interaction-synthesis/profile.json",
      "../../packages/epistemic-runtime/src/project-z/z2-coalitions/**/*",
      "../../packages/private-equity/src/project-z/z2-coalitions/**/*",
      "../../packages/orchestration/src/project-z/z2-coalitions/**/*",
      "../../packages/**/package.json", "../../packages/source-custody/index.cjs",
      "../../packages/**/fixtures/*.json", "../../scripts/p3/**/*.{ts,mts,cjs,mjs}",
      "../../scripts/r4/requirements.lock",
      "../../scripts/release/action-hardening-spec.ts",
      "../../../scripts/release/production-mutation-guard.mjs",
      "../../apps/worker/src/**/*.ts", "./app/api/**/*.ts",
      "../../node_modules/fs-ext/**/*", "../../node_modules/tsx/**/*", "../../node_modules/esbuild/**/*", "../../node_modules/zod/**/*",
      // Native X3/X5/X4 source cuts also bind maintained UI and stamp inputs.
      // They must travel with the emitted API, not depend on the build host.
      "../../../src/components/centropy/canvas/*.ts", "../../../src/components/centropy/canvas/*.tsx",
      "../../../src/lib/centropy/capability-manifest.generated.json",
      "../../scripts/x3/stamp-source.mts", "../../scripts/x5/stamp-source.mts", "../../scripts/x4/stamp-source.mts",
      "../../Dockerfile.worker", "./next.config.mjs",
      // Z4 installed verification binds both source and native runtime, never build-host fallback.
      "../../../package.json", "../../package.json",
      "../../../z4-reconstruction-source.json",
      "../../../scope-z/phase-evidence/z4/installed-provenance.json",
      "../../../next.config.mjs",
      "../../../tsconfig.json", "../../tsconfig.json", "../../tsconfig.base.json",
      "./tsconfig.json", "./lib/auth.ts",
      "../../../src/components/centropy/world/WorldWorkRecord.tsx",
      "../../../src/components/centropy/lib/api.ts",
      "../../../src/components/centropy/lib/use-private-request-scope.ts",
      "../../../src/app/api/centropy/*/route.ts",
      "../../node_modules/@esbuild/linux-x64/**/*",
      "../../packages/private-equity/src/project-z/z4-execution-proof/*.tsx",
      "../../packages/epistemic-runtime/native/z4-execution-proof/bin/*",
      "../../packages/epistemic-runtime/native/z4-execution-proof/build-identity.json",
      "../../packages/epistemic-runtime/native/z4-execution-proof/supervise.py",
      "../../packages/epistemic-runtime/native/z4-execution-proof/Cargo.toml",
      "../../packages/epistemic-runtime/native/z4-execution-proof/Cargo.lock",
      "../../packages/epistemic-runtime/native/z4-execution-proof/rust-toolchain.toml",
      "../../packages/epistemic-runtime/native/z4-execution-proof/src/*.rs",
      "../../packages/epistemic-runtime/native/z4-execution-proof/NOVA-LICENSE.txt",
      "../../scripts/project-z/z4/*.{py,mts,mjs,json,md}",
      "./lib/**/*.ts",
      "../../packages/**/project-z/z1-shared-work/*.tsx",
      "../../scripts/project-z/z1/**/*",
      ...z1TraceFiles,
    ],
  },
};
export default nextConfig;
