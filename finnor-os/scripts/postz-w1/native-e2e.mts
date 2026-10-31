import { strict as assert } from "node:assert";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { observeNativeRun } from "./native-observe.mjs";
import { driveNativeProgram } from "./native-drive.mjs";

const fixtureSchema = z.object({
  schema: z.literal("finnor.w1.native-fixture.v1"),
  fixture: z.literal("P1_LIABILITY_ARITHMETIC"),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), foreignPrincipalId: z.string().uuid(),
  programId: z.string().uuid(), root: z.object({ entityType: z.string(), entityId: z.string().uuid() }).strict(),
  apiOrigin: z.string().url(), bearerEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  foreignBearerEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  databaseEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  searchRequest: z.record(z.string(), z.unknown()),
  rightsEvidenceRef: z.string().min(1),
}).strict();
const fixturePath = resolve(process.env.FINNOR_W1_NATIVE_FIXTURE ?? "");
const destination = resolve(process.env.FINNOR_W1_NATIVE_EVIDENCE ?? "");
assert(process.env.FINNOR_W1_NATIVE_FIXTURE && process.env.FINNOR_W1_NATIVE_EVIDENCE, "Exact private disposable fixture and new evidence paths required");
const original = await readFile(fixturePath);
const fixture = fixtureSchema.parse(JSON.parse(original.toString("utf8")));
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(fixture.apiOrigin).hostname), "Disposable local API only");
const token = process.env[fixture.bearerEnvironment], foreignToken = process.env[fixture.foreignBearerEnvironment];
const databaseUrl = process.env[fixture.databaseEnvironment];
assert(token && foreignToken && databaseUrl, "Secure fixture bindings absent");
assert.equal(process.env.AUTH_DEV_BYPASS, "0", "Header bypass is not bearer qualification");
assert.notEqual(process.env.NODE_ENV, "production", "Disposable verification only");
assert.equal(process.env.FINNOR_P4_PROFILE, "ordinary_disposable");
assert(process.env.DATABASE_URL, "Original application pool binding required");
const observedDatabase = new URL(databaseUrl), applicationDatabase = new URL(process.env.DATABASE_URL);
for (const url of [observedDatabase, applicationDatabase]) {
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Disposable local PostgreSQL only");
  assert(!["host", "hostaddr", "port", "database", "service"].some(key => url.searchParams.has(key)),
    "Connection overrides cannot bypass the local database fence");
}
assert.equal(observedDatabase.port || "5432", applicationDatabase.port || "5432");
assert.equal(observedDatabase.pathname, applicationDatabase.pathname, "Observer and original queue must use the same disposable database");
await mkdir(destination, { recursive: false });
const startedAt = new Date().toISOString(), started = performance.now();
const admin = new pg.Client({ connectionString: databaseUrl });
let outcome: unknown = { status: "NOT_RUN" };
const steps: unknown[] = [];
async function api(operation: string, body: unknown, bearer: string | null = token ?? null) {
  const response = await fetch(new URL("/api/company-brain/" + operation, fixture.apiOrigin), {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  const result = { status: response.status, body: await response.json() };
  steps.push({ operation, status: result.status, observedAt: new Date().toISOString() });
  return result;
}
try {
  await admin.connect();
  const existing = (await admin.query("SELECT id FROM finnor_os.p1_requests WHERE id=$1 AND tenant_id=$2 AND principal_id=$3", [fixture.programId, fixture.tenantId, fixture.principalId])).rows;
  assert.equal(existing.length, 1, "Original canonical P1 Work must exist");
  const anonymous = await api("economic-orchestration-projection", { root: fixture.root, workId: (await admin.query("SELECT work_id FROM finnor_os.p1_requests WHERE id=$1", [fixture.programId])).rows[0].work_id }, null);
  assert.equal(anonymous.status, 401);
  const submitted = await api("economic-orchestration-submit", fixture.searchRequest);
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  const accepted = z.object({ searchId: z.string().uuid() }).passthrough().parse(submitted.body);
  const { JobQueue } = await import("../../apps/worker/src/queue");
  const { PRODUCTION_JOB_CONTRACTS } = await import("../../packages/db/compute-contract");
  const queue = new JobQueue("postz-w1-native-driver", 1);
  queue.register("run_harness_program_v1", (await import("../../packages/private-equity/src/program-synthesis/worker")).runHarnessProgramJob, PRODUCTION_JOB_CONTRACTS.run_harness_program_v1);
  queue.register("run_evidence_derivation_v1", (await import("../../packages/private-equity/src/evidence-execution/worker")).runEvidenceDerivationJob, PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
  queue.register("run_compute_search_unit_v1", (await import("../../packages/private-equity/src/compute-search/worker")).runComputeSearchUnitJob, PRODUCTION_JOB_CONTRACTS.run_compute_search_unit_v1);
  assert.equal(await driveNativeProgram(admin, queue, fixture.programId, started), "TESTED");
  const projection = await api("program-read", { programId: fixture.programId });
  assert.equal(projection.status, 200);
  const program = z.object({ program: z.record(z.string(), z.unknown()) }).passthrough().parse(projection.body).program;
  const foreign = await api("economic-orchestration-read", { searchId: accepted.searchId }, foreignToken);
  assert.equal(foreign.status, 404);
  outcome = await observeNativeRun(admin, fixture, accepted.searchId, program,
    { bypass: false, anonymousStatus: anonymous.status, foreignStatus: foreign.status }, destination);
} catch (error) {
  outcome = { status: "FAIL", message: String(error), stack: error instanceof Error ? error.stack : null };
  process.exitCode = 1;
} finally {
  await admin.end().catch(() => undefined);
  const { closePool } = await import("@finnor/db");
  await closePool();
  await writeFile(join(destination, "driver-receipt.json"), JSON.stringify({
    schema: "finnor.w1.native-driver.v1", startedAt, endedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
    originalFixtureSha256: createHash("sha256").update(original).digest("hex"), rightsEvidenceRef: fixture.rightsEvidenceRef,
    node: process.version, command: "node --import=tsx scripts/postz-w1/native-e2e.mts",
    steps, outcome, costs: { usd: null, status: "UNKNOWN", scope: "ACTUAL_NATIVE_ATTEMPTS_PLUS_DRIVER_ENGINEERING" },
    nativePositiveOnly: true, interruption: "NOT_RUN", mounted: "NOT_RUN", coldReconstruction: "NOT_RUN",
    protectedAdmission: false, independentlyProtected: false,
  }, null, 2) + "\n");
}
