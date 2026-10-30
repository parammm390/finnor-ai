/** Native-only observations retain real API authentication. No supplied ctx. */
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
let bytes = "";
for await (const chunk of process.stdin) {
  bytes += chunk;
  if (Buffer.byteLength(bytes) > 65536) throw Error("Z0_NATIVE_OBSERVATION_INPUT_BOUND");
}
const input = JSON.parse(bytes);
if (process.env.FINNOR_Z0_NATIVE_AUTHORIZED !== "explicit_disposable_z0"
  || process.env.AUTH_DEV_BYPASS !== "0" || process.env.FINNOR_X2_PROFILE !== "ordinary_disposable"
  || !input.root?.startsWith("/") || !["QUERY", "INVENTORY"].includes(input.operation)) {
  throw Error("Z0_NATIVE_OBSERVATION_AUTHORITY_REQUIRED");
}
const root = await realpath(input.root);
const moduleAt = async path => {
  const actual = await realpath(resolve(root, path));
  if (!actual.startsWith(root + sep)) throw Error("Z0_NATIVE_MODULE_OUTSIDE_TARGET");
  return import(pathToFileURL(actual).href);
};
try {
  if (typeof input.bearer !== "string" || !input.bearer.trim()) throw Error("Z0_NATIVE_BEARER_REQUIRED");
  if (input.operation === "QUERY"
    && !["harness_program_v1", "economic_programme_v1", "confidential_economic_computation_v1"].includes(input.query?.intent)) {
    throw Error("Z0_NATIVE_ORIGINAL_QUERY_REQUIRED");
  }
  const { requireContext } = await moduleAt("finnor-os/apps/api/lib/auth.ts");
  const ctx = await requireContext(new Request(input.apiOrigin + "/api/queries", {
    headers: { authorization: "Bearer " + input.bearer },
  }));
  if (ctx.tenantId !== input.tenantId || ctx.userId !== input.principalId || ctx.role !== "owner") {
    throw Error("Z0_REAL_AUTH_IDENTITY_MISMATCH");
  }
  const authenticatedActor = { tenantId: ctx.tenantId, principalId: ctx.userId, role: ctx.role };
  if (input.operation === "INVENTORY") {
    const { ConvergedInstitutionRuntime } = await moduleAt("finnor-os/packages/orchestration/src/project-z/z0-convergence/index.ts");
    console.log(JSON.stringify({ authenticatedActor, inventory: new ConvergedInstitutionRuntime().capabilities("private_equity") }));
  } else {
    const { getOrchestrator } = await moduleAt("finnor-os/apps/api/lib/orchestrator.ts");
    const response = await getOrchestrator().handleOperationalQuery(input.query, ctx, input.options);
    console.log(JSON.stringify({ authenticatedActor, response }));
  }
} catch (error) {
  const predicate = /^[A-Z][A-Z0-9_]{1,159}$/.test(error?.message ?? "") ? error.message : "Z0_NATIVE_OBSERVATION_FAILED";
  console.log(JSON.stringify({ refused: true, predicate,
    diagnosticSha256: createHash("sha256").update(String(error?.message ?? error)).digest("hex") }));
  process.exitCode = 2;
} finally {
  // Close only this child's own canonical pool. Never borrow a fixture client.
  try {
    const { getPool } = await moduleAt("finnor-os/packages/db/index.ts");
    await getPool().end();
  } catch { /* Some rejected observations never construct a database pool. */ }
}
