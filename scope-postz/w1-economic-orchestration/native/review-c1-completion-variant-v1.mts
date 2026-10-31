/** Failure-first C1 driver (remaining-roots-failure-contract-v1.md).
 * Extracts the REAL native completion guard block from the current
 * orchestration/src/objective-loop.ts by string markers and executes it
 * against a real disposable embedded PostgreSQL (migrated) through the real
 * @finnor/db transaction/schema helpers and the real
 * completeWorkPlanRevisionTx; only pure fixtures (current/boundPlan/params)
 * are injected, mirroring the completed-plan recovery caller.
 * Broken signature C1_NATIVE_COMPLETION_VARIANT_REQUIRED: the recovery call
 * site omits economicReadCompletion (optional-bag type marker) and the real
 * guard throws "Native private read completion requires its original
 * accepted proof." on recovery-shaped params (boundary + completed +
 * verified result, original input and proof in hand).
 * Repaired: the type is the discriminated NATIVE_READ_COMPLETED_VERIFIED
 * variant, the recovery caller supplies it, the guard accepts the complete
 * triple on a consistent fixture, superseded (not accepted) on a mismatched
 * original input, and still throws on the legacy partial shape. */
import { strict as assert } from "node:assert";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { ownDisposablePostgres, closeDisposablePostgres } from "../../../finnor-os/scripts/postz-w1/disposable-postgres.mjs";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination) && !existsSync(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
// --source <path>: run against a pristine extracted source (e.g. the committed
// pre-repair file via git show) so broken evidence stays reproducible after
// the repair lands; defaults to the live file.
const sourceFlag = process.argv.indexOf("--source");
const sourcePath = sourceFlag > 0 ? process.argv[sourceFlag + 1]!
  : join(root, "finnor-os/packages/orchestration/src/objective-loop.ts");
const source = readFileSync(sourcePath, "utf8");

// Marker checks: the type shape and the recovery call site.
const oldType = source.includes("economicReadCompletion?: { workInputId: string; proof: CompletionProof };");
const newType = source.includes('kind: "NATIVE_READ_COMPLETED_VERIFIED"');
const recoveryAt = source.indexOf("recoveredCompletionProof: proof");
assert(recoveryAt > 0, "RECOVERY_CALL_SITE_MARKERS_CHANGED");
const callStart = source.lastIndexOf("return (await finishIteration({", recoveryAt);
const callEnd = source.indexOf("})).outcome;", recoveryAt);
const recoveryCall = source.slice(callStart, callEnd);
const recoverySuppliesCompletion = /economicReadCompletion/.test(recoveryCall);

// Extract the real guard block verbatim.
const guardStartMarker = 'if (params.economicReadBoundary && params.outcome === "completed") {';
const guardStart = source.indexOf(guardStartMarker);
const guardEnd = source.indexOf("const nextNoProgress =", guardStart);
assert(guardStart > 0 && guardEnd > guardStart, "GUARD_MARKERS_CHANGED");
const guardText = source.slice(guardStart, guardEnd).trimEnd();
const scratch = mkdtempSync(join(tmpdir(), "finnor-w1-c1-"));
const owned = ownDisposablePostgres(scratch, join(scratch, "db"), destination + ".cleanup.json");
try {
const generated = join(scratch, "guard.mts");
writeFileSync(generated, `export async function runGuard(deps: any, params: any, current: any, boundPlan: any, db: any) {
  const { workInputs, users, workObjectiveLoops, and, eq, desc, sql, isRecord, planningHash, completeWorkPlanRevisionTx, boundCompletion } = deps;
  ${guardText}
  return { accepted: true as const };
}
`);
const { runGuard } = await import(pathToFileURL(generated).href);

const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const requireFinnor = createRequire(join(root, "finnor-os/package.json"));
const embeddedModule = requireFinnor("embedded-postgres");
const EmbeddedPostgres = embeddedModule.default ?? embeddedModule;
const database = owned.attach(new EmbeddedPostgres({ databaseDir: join(scratch, "db"), user: "finnor", password: "finnor", port,
  persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"], onLog: () => undefined, onError: () => undefined }));
await database.initialise(); await database.start();
await database.createDatabase("w1_c1");
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
const { migrate } = await import("../../../finnor-os/packages/db/migrate");
await migrate(`postgres://finnor:finnor@127.0.0.1:${port}/w1_c1`);
process.env.DATABASE_URL = `postgres://finnor:finnor@127.0.0.1:${port}/w1_c1?sslmode=disable`;

const dbModule = await import("../../../finnor-os/packages/db/index");
const planning = requireFinnor("@finnor/planning");
const { withTenant, workInputs, users, workObjectiveLoops, works, tenants, workPlanRevisions, completeWorkPlanRevisionTx } = dbModule as never as Record<string, any>;
const planningHash = planning.sha256 as (value: unknown) => string;
const drizzle = requireFinnor("drizzle-orm");
const { and, eq, desc, sql } = drizzle;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

// Fixture: one tenant/principal/work/input/loop + one completed bound plan
// revision carrying a verified CompletionProof (the recovery shape).
const tenantId = randomUUID(), principal = randomUUID(), workId = randomUUID();
const inputId = randomUUID(), loopId = randomUUID(), planId = randomUUID();
const successCondition = { kind: "w1-c1", criteria: [{ id: "c1", description: "read finished" }] };
const verification = { state: "verified", checkedAt: new Date().toISOString(), queryExecutionIds: [randomUUID()] };
const proof = { version: 1, finalPlanRevisionId: planId, planRevisionId: planId, planSemanticHash: "sha256:" + "e".repeat(64),
  goalSemanticHash: "sha256:" + "b".repeat(64), successConditionHash: planningHash(successCondition), verified: true,
  verifiedAt: verification.checkedAt, verification, evidenceRefs: [] };
const future = new Date(Date.now() + 3_600_000);
await withTenant(tenantId, async (db: any) => {
  await db.insert(tenants).values({ id: tenantId, name: "w1-c1" }).onConflictDoNothing();
  await db.insert(users).values({ tenantId, id: principal, status: "active", email: "w1-c1@example.invalid", name: "w1-c1", role: "owner" });
  await db.insert(works).values({ tenantId, id: workId, title: "w1-c1", createdBy: principal,
    initialChannel: "text", initialInstruction: "read" });
  await db.insert(workInputs).values({ tenantId, id: inputId, workId, createdBy: principal, instructionText: "read",
    instructionId: randomUUID(), channel: "text" });
  await db.insert(workObjectiveLoops).values({ tenantId, id: loopId, workId, revision: 1, leaseOwner: "w1-c1-driver",
    leaseUntil: future, deadlineAt: future, createdBy: principal, objective: "read", successCondition,
    state: "continue", stepCount: 1, maxSteps: 5, initialChannel: "text" });
  await db.insert(workPlanRevisions).values({ tenantId, id: planId, workId, workInputId: inputId, objectiveLoopId: loopId,
    status: "completed", completionProof: proof, revision: 1, reason: "initial", completedAt: new Date(),
    goalSpec: { version: "1", successCondition, semanticHash: "sha256:" + "b".repeat(64) },
    constraintSet: { semanticHash: "sha256:" + "c".repeat(64) }, planningSnapshot: { version: "1", semanticHash: "sha256:" + "d".repeat(64) },
    candidateSummary: {}, validation: { version: "1" },
    planGraph: { version: "1", nodes: [], edges: [], semanticHash: "sha256:" + "e".repeat(64) },
    score: {}, goalHash: "sha256:" + "b".repeat(64), constraintHash: "sha256:" + "c".repeat(64),
    worldSnapshotHash: "sha256:" + "d".repeat(64), graphHash: "sha256:" + "e".repeat(64), semanticHash: "sha256:" + "e".repeat(64) });
});
const current = { id: loopId, workId, createdBy: principal, objective: "read", successCondition, state: "continue" };
const boundPlan = { id: planId, status: "completed", completionProof: proof, workId, workInputId: inputId,
  objectiveLoopId: loopId, goalSpec: { successCondition } };
const loopRef = { revision: 1, leaseOwner: "w1-c1-driver" };
const deps = { workInputs, users, workObjectiveLoops, and, eq, desc, sql, isRecord, planningHash, completeWorkPlanRevisionTx,
  boundCompletion: proof };

const run = async (extra: Record<string, unknown>) => withTenant(tenantId, async (db: any) => {
  try {
    const value = await runGuard(deps, { tenantId, loop: loopRef, outcome: "completed",
      successVerification: verification, economicReadBoundary: true, ...extra }, current, boundPlan, db);
    return { threw: null as string | null, value };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error), value: null };
  }
});

const receipt: Record<string, unknown> = { schema: "finnor.w1.c1-completion-variant.v1",
  markers: { optionalBagType: oldType, discriminatedVariantType: newType, recoveryCallerSuppliesCompletion: recoverySuppliesCompletion } };
let defect: boolean;
let observed: string;
if (oldType && !recoverySuppliesCompletion) {
  // Broken baseline: recovery-shaped params (boundary + completed + verified;
  // original input and proof in the caller's hand but inexpressible).
  const blocked = await run({ observation: { recoveredCompletionProof: proof } });
  observed = blocked.threw && /original accepted proof/.test(blocked.threw)
    ? "C1_NATIVE_COMPLETION_VARIANT_REQUIRED" : `C1_UNEXPECTED:${blocked.threw ?? JSON.stringify(blocked.value)}`;
  defect = observed === "C1_NATIVE_COMPLETION_VARIANT_REQUIRED";
} else if (newType && recoverySuppliesCompletion) {
  const completion = { kind: "NATIVE_READ_COMPLETED_VERIFIED", workInputId: inputId, proof, verification };
  const accepted = await run({ economicReadCompletion: completion });
  const legacy = await run({ economicReadCompletion: { workInputId: inputId, proof } });
  const mismatched = await run({ economicReadCompletion: { ...completion, workInputId: randomUUID() } });
  const ok = !accepted.threw && (accepted.value as { accepted?: boolean })?.accepted === true
    && !!legacy.threw && /original accepted proof/.test(legacy.threw)
    && !mismatched.threw && (mismatched.value as { superseded?: boolean })?.superseded === true;
  Object.assign(receipt, { accepted, legacy, mismatched });
  observed = ok ? "C1_DISCRIMINATED_COMPLETION_VARIANT_ENFORCED" : "C1_REPAIR_INCOMPLETE";
  defect = !ok;
} else {
  observed = "C1_SOURCE_MARKERS_INCONSISTENT";
  defect = true;
}
Object.assign(receipt, { observed, defect });
writeFileSync(destination, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ observed, defect, markers: receipt.markers }));
process.exitCode = defect ? 1 : 0;
} finally {
  await closeDisposablePostgres(owned, [async () => (await import("../../../finnor-os/packages/db/index")).closePool()]);
}
