/** Explicit read-only third-party TOOLING resolver, never installed Z5 proof.
 * No @finnor, project aliases, relative or foreign project-source fallback. */
import Module, { registerHooks, createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
import childProcess from "node:child_process";
const pool = process.env.FINNOR_Z5_TOOLING_POOL;
const backendPool = process.env.FINNOR_Z5_TOOLING_BACKEND_POOL;
const pools = [pool, backendPool].filter(Boolean);
if (!pool || !pools.every(p => path.isAbsolute(p))) throw Error("Explicit absolute third-party tooling pools required");
const requires = pools.map(p => createRequire(path.join(p, "package.json"))), borrowed = new Set();
let resolvingPool = false;
const forbidden = specifier => typeof specifier !== "string" || specifier.startsWith(".") || specifier.startsWith("/")
  || specifier.startsWith("@finnor/") || specifier.startsWith("@/") || specifier.includes(":");
function resolveTool(specifier, error) {
  if (resolvingPool || forbidden(specifier)) throw error;
  let resolved;
  try {
    resolvingPool = true;
    for (const require of requires) {
      try { resolved = require.resolve(specifier); break; } catch { /* Next explicit third-party tooling pool. */ }
    }
  } finally { resolvingPool = false; }
  if (!resolved || !realpathSync(resolved).includes("/node_modules/"))
    throw Error("Foreign project-source fallback refused: " + specifier);
  borrowed.add(specifier); return resolved;
}
// require.resolve and the installed TS loader's legacy resolver do not enter
// synchronous module hooks. Keep exactly the same third-party-only boundary.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(specifier, ...args) {
  try { return resolveFilename.call(this, specifier, ...args); }
  catch (error) { return resolveTool(specifier, error); }
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (resolvingPool) return nextResolve(specifier, context);
  try { return nextResolve(specifier, context); }
  catch (error) {
    return { url: pathToFileURL(resolveTool(specifier, error)).href, shortCircuit: true };
  }
} });
// The existing metadata reader intentionally strips every credential/env hook.
// Propagate ONLY this explicitly requested tooling bridge to that exact reader.
// Its original network/action denial and original project sources remain intact.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const metadataReader = path.join(root, "scripts/centropy/read-canonical-planner.mjs");
const execute = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  if (Array.isArray(args) && args.includes(metadataReader) && options?.cwd === path.join(root, "finnor-os"))
    return execute.call(this, file, args, { ...options, env: { ...options.env,
      FINNOR_Z5_TOOLING_POOL: pool, ...(backendPool ? { FINNOR_Z5_TOOLING_BACKEND_POOL: backendPool } : {}),
      NODE_OPTIONS: "--import=" + fileURLToPath(import.meta.url) } });
  return execute.call(this, file, args, options);
};
syncBuiltinESMExports();
process.once("exit", () => process.stderr.write(JSON.stringify({ schema: "finnor.z5.explicit-engineering-tooling.v1",
  pools, borrowedThirdPartyTooling: [...borrowed].sort(), borrowedProjectSources: 0, installedZ5Proof: false }) + "\n"));
