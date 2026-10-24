/** Fixture-only orchestration preregistered in s8-live-gates-contract.md.
 * No HTTP relay, replacement executor, currentness producer or product hook. */
import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import type { ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "../../packages/private-equity/src/types";
import {
  ApplicationSnapshotSchema, sameX2Ref, X2RefSchema, x2Digest, x2Ref,
} from "../../packages/private-equity/src/application-semantics/contracts";
import { applicationArtifact, applicationSession } from "../../packages/private-equity/src/application-semantics/store";
import {
  ApplicationActivationSchema, ApplicationCurrentnessBodySchema, ApplicationPortRefSchema,
  ApplicationUseCommandSchema, ApplicationUseLeaseSchema, applicationRef,
  type ApplicationCapabilityUseLease,
} from "../../packages/capability-evolution/src/application-semantics-port";
import { resolveEconomicOwnerReference } from "../../packages/governed-execution/src/owner-transport";
import type {
  NativeS8ApplicationCommandNegativeInput, NativeS8ApplicationCommandNegativeReport, NativeS8Fixture,
} from "./native-s8-fixture.mts";

type IsolatedInput = Extract<NativeS8ApplicationCommandNegativeInput,
  { phase: "isolated-live-use" | "isolated-expired-activation" }>;
interface Worker<T> { child: ChildProcess; completed: Promise<T> }
interface Coverage {
  boundary: string;
  status: "EXECUTED" | "NOT_RUN_INTERNAL_PREREQUISITE";
  reason: string;
}
const snapshotSchema = z.object({
  applications: z.object({
    revisions: z.array(z.object({
      ref: ApplicationPortRefSchema, originalParentRef: X2RefSchema, scope: z.record(z.string(), z.unknown()),
      revoked: z.boolean(), protocolRef: ApplicationPortRefSchema.nullable(),
      evaluationRef: ApplicationPortRefSchema.nullable(), admissionRef: ApplicationPortRefSchema.nullable(),
      activationRef: ApplicationPortRefSchema.nullable(),
      domain: z.object({ active: z.string().nullable() }).passthrough(),
    }).passthrough()).max(256),
    counts: z.object({ revisions: z.number().int(), uses: z.number().int() }).passthrough(),
  }).passthrough(),
  page: z.object({ offset: z.literal(0), limit: z.literal(256), complete: z.literal(true),
    nextOffset: z.null() }).passthrough(),
}).passthrough();
const codeOf = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
  ? error.message : "X2_S8_LIVE_GATE_FAILED";
const commandFor = (lease: ApplicationCapabilityUseLease) => ApplicationUseCommandSchema.parse({
  revisionRef: lease.revisionRef, modelRef: lease.modelRef, checkRef: lease.checkRef,
  originalParentRef: lease.originalParentRef, originalParentDigest: lease.originalParentDigest,
  profile: lease.profile, request: lease.request,
});

export interface NativeS8LiveGatePreparation {
  tenantId: string; principalId: string; name: string; first: number; second: number;
  close(): Promise<void>;
}
/** Install observer DDL before the real owner's immutable schema cut. Only the
 * advisory lock changes during use; it never creates a lease or an observation. */
export async function prepareNativeS8LiveGate(input: {
  sql: pg.Client; tenantId: string; principalId: string;
}): Promise<NativeS8LiveGatePreparation> {
  assert(process.env.FINNOR_ENVIRONMENT === "staging" && process.env.FINNOR_X2_PROFILE === "ordinary_disposable",
    "X2_S8_LIVE_GATE_DISPOSABLE_ENVIRONMENT_REQUIRED");
  const tenantId = z.string().uuid().parse(input.tenantId), principalId = z.string().uuid().parse(input.principalId);
  const database = (await input.sql.query("SELECT current_database() database,current_user role")).rows[0];
  assert(database?.database === "x2_native" && database.role === "x2_owner", "X2_S8_LIVE_GATE_OWNED_DATABASE_REQUIRED");
  const name = "x2_s8_live_gate_" + randomBytes(6).toString("hex");
  const key = randomBytes(8), first = key.readInt32BE(0), second = key.readInt32BE(4);
  await input.sql.query(`CREATE FUNCTION finnor_os.${name}() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $gate$
DECLARE prior_timeout text;
BEGIN
  IF NEW.tenant_id='${tenantId}'::uuid AND NEW.principal_id='${principalId}'::uuid
    AND NEW.kind='S8_EXACT_APPLICATION_USE'
    AND (SELECT count(*) FROM finnor_os.application_semantics_events
      WHERE tenant_id=NEW.tenant_id AND principal_id=NEW.principal_id
        AND session_id=NEW.session_id AND kind='S8_EXACT_APPLICATION_USE')=1 THEN
    prior_timeout := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout','8s',true);
    PERFORM pg_advisory_xact_lock(${first},${second});
    PERFORM set_config('lock_timeout',prior_timeout,true);
  END IF;
  RETURN NEW;
END; $gate$`);
  try {
    await input.sql.query(`CREATE TRIGGER ${name} BEFORE INSERT ON finnor_os.application_semantics_events
      FOR EACH ROW EXECUTE FUNCTION finnor_os.${name}()`);
  } catch(error) {
    await input.sql.query(`DROP FUNCTION finnor_os.${name}()`);
    throw error;
  }
  return {tenantId,principalId,name,first,second,async close(){
    await input.sql.query(`DROP TRIGGER ${name} ON finnor_os.application_semantics_events`);
    await input.sql.query(`DROP FUNCTION finnor_os.${name}()`);
  }};
}

export async function runNativeS8LiveGates<T>(input: {
  fixture: NativeS8Fixture; ctx: PeMutationContext; sql: pg.Client; adminUrl: string; sessionId: string;
  prepared: NativeS8LiveGatePreparation;
  startWorker(id: string): Promise<Worker<T>>;
  external(): Promise<{ digest: string; sequence: number }>;
  save(name: string, value: unknown): Promise<void>;
  /** Only already-genuine, explicitly nominated disposable subjects. Never constructed here. */
  isolatedInputs?: readonly IsolatedInput[];
}): Promise<{ row: T; live: NativeS8ApplicationCommandNegativeReport;
  isolated: NativeS8ApplicationCommandNegativeReport[]; coverage: Coverage[]; summary: Record<string, unknown> }> {
  const { fixture, ctx, sql } = input;
  const tenant = z.string().uuid().parse(ctx.auth.tenantId), actor = z.string().uuid().parse(ctx.auth.employeeId);
  const sessionId = z.string().uuid().parse(input.sessionId);
  assert.equal(input.prepared.tenantId,tenant,"X2_S8_LIVE_GATE_PREPARED_TENANT");
  assert.equal(input.prepared.principalId,actor,"X2_S8_LIVE_GATE_PREPARED_PRINCIPAL");
  const {first,second}=input.prepared;
  const controller = new pg.Client({ connectionString: input.adminUrl, connectionTimeoutMillis: 5000 });
  const abort = new AbortController();
  const isolated: NativeS8ApplicationCommandNegativeReport[] = [], coverage: Coverage[] = [];
  const evidence: Record<string, unknown> = { schema: "finnor.x2.s8-live-gates.v1", verdict: "FAIL",
    startedAt: new Date().toISOString(), eventOrdinal: 2, pauseLimitMs: 8000, suiteLimitMs: 7000,
    fixtureRevisionRef: fixture.candidate.ref, sessionId, isolatedCoverage: coverage,
    separateBusinessOracleRequired: true, billingUSD: null, humanWork: null,
    aggregateSimultaneousMemory: null, protectedAdmission: false, executionAuthorityGranted: false };
  let connected = false, locked = false;
  let worker: Worker<T> | undefined, workerSettled = false, workerOutcome: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, live: NativeS8ApplicationCommandNegativeReport | undefined;
  let row: T | undefined, caught: unknown;
  const active = () => assert(!abort.signal.aborted, "X2_S8_LIVE_GATE_DEADLINE");
  const stopOnTimeout = () => {
    abort.abort();
    if (worker && !workerSettled) worker.child.kill("SIGKILL");
  };
  try {
    assert(process.env.FINNOR_ENVIRONMENT === "staging" && process.env.FINNOR_X2_PROFILE === "ordinary_disposable",
      "X2_S8_LIVE_GATE_DISPOSABLE_ENVIRONMENT_REQUIRED");
    const contractPath = resolve(import.meta.dirname, "../../../scope-frontier5/x2-software-semantics-compiler/s8-live-gates-contract.md");
    const contractDigest = createHash("sha256").update(await readFile(contractPath)).digest("hex");
    evidence.precodeContract = { path: contractPath, sha256: contractDigest };
    await fixture.assertSourceCut();
    const session = await applicationSession(ctx, sessionId), candidate = fixture.candidate;
    assert(sameX2Ref(session.original_parent_ref, candidate.originalParent.originalParentRef),
      "X2_S8_LIVE_GATE_ORIGINAL_PARENT");
    const read = await fixture.commandAs("reader", "READ", { offset: 0, limit: 256 });
    assert.equal(read.status, 200, "X2_S8_LIVE_GATE_CANONICAL_READ");
    const state = snapshotSchema.parse(read.body);
    assert.equal(state.applications.counts.revisions, state.applications.revisions.length,
      "X2_S8_LIVE_GATE_COMPLETE_OWNER_STATE");
    const primary = state.applications.revisions.find(value => sameX2Ref(value.ref, candidate.ref));
    assert(primary?.activationRef && !primary.revoked && primary.domain.active === candidate.ref.id,
      "X2_S8_LIVE_GATE_PRIMARY_ACTIVATION");
    const activationRead = await resolveEconomicOwnerReference({ semanticOwner: "S8", tenantId: tenant, principalId: actor },
      primary.activationRef, { purpose: "CONSUMER", rightsRef: session.parent.rightsRevision });
    assert.equal(activationRead.protectionDomain, "DISPOSABLE_TEST_AUTHORITY", "X2_S8_LIVE_GATE_ACTIVATION_DOMAIN");
    const activation = z.object({ body: ApplicationActivationSchema, keyId: z.string(), signature: z.string() })
      .strict().parse(activationRead.reference.content);
    assert(sameX2Ref(applicationRef("activate", activation), primary.activationRef)
      && sameX2Ref(activation.body.revisionRef, candidate.ref), "X2_S8_LIVE_GATE_ACTIVATION_IDENTITY");
    assert.equal(activation.body.validUntil, session.parent.deadlineAt, "X2_S8_LIVE_GATE_UNCHANGED_ACTIVATION_DEADLINE");
    const acquisitions = (await sql.query<{
      id: string; original_parent_ref: ExperimentRef; model_ref: ExperimentRef | null; check_ref: ExperimentRef | null;
    }>("SELECT id,original_parent_ref,model_ref,check_ref FROM finnor_os.application_semantics_sessions"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND id=parent_id ORDER BY created_at,id LIMIT 257", [tenant, actor])).rows;
    assert(acquisitions.length <= 256, "X2_S8_LIVE_GATE_ACQUISITION_BOUND");
    const otherDomains = state.applications.revisions.filter(value => !value.revoked && value.protocolRef
      && value.evaluationRef && value.admissionRef && value.activationRef && value.domain.active === value.ref.id
      && x2Digest({ originalParentRef: value.originalParentRef, scope: value.scope })
        !== x2Digest({ originalParentRef: candidate.originalParent.originalParentRef, scope: candidate.scope }));
    evidence.applicability = { primaryActivationRef: primary.activationRef, originalDeadline: session.parent.deadlineAt,
      primaryActivationValidUntil: activation.body.validUntil, primaryExpiryWhileParentCurrent: false,
      separateNativeAcquisitions: acquisitions.filter(value => !sameX2Ref(value.original_parent_ref, session.original_parent_ref)).length,
      activeIndependentOtherDomains: otherDomains.map(value => value.ref),
      nominatedIsolatedPhases: (input.isolatedInputs ?? []).map(value => value.phase),
      qualificationGap: "INTERNAL_NATIVE_SUBJECT_ORCHESTRATION_NOT_EXTERNAL_QUALIFICATION" };
    const nominated = input.isolatedInputs ?? [];
    assert(nominated.length <= 2 && new Set(nominated.map(value => value.phase)).size === nominated.length,
      "X2_S8_LIVE_GATE_FINITE_ISOLATED_INPUTS");
    for (const subject of nominated) {
      assert(!sameX2Ref(subject.candidate.originalParent.originalParentRef, session.original_parent_ref)
        && acquisitions.some(value => sameX2Ref(value.original_parent_ref, subject.candidate.originalParent.originalParentRef)
          && value.model_ref && sameX2Ref(value.model_ref, subject.candidate.modelRef)
          && value.check_ref && sameX2Ref(value.check_ref, subject.candidate.checkRef)),
      "X2_S8_LIVE_GATE_SEPARATE_ACTUAL_NATIVE_ACQUISITION_REQUIRED");
      const before = await input.external();
      const report = await fixture.checkApplicationCommandNegatives(subject, { signal: AbortSignal.timeout(7000) });
      const after = await input.external();
      assert.equal(after.digest, before.digest, "X2_S8_LIVE_GATE_ISOLATED_CHANGED_APPLICATION");
      assert.equal(after.sequence, before.sequence, "X2_S8_LIVE_GATE_ISOLATED_CHANGED_JOURNAL");
      isolated.push(report);
    }
    for (const phase of ["isolated-live-use", "isolated-expired-activation"] as const) {
      const supplied = isolated.find(value => value.phase === phase);
      coverage.push({ boundary: phase, status: supplied ? "EXECUTED" : "NOT_RUN_INTERNAL_PREREQUISITE",
        reason: supplied ? "Existing hook ran against its explicitly nominated, separately native-acquired owner subject."
          : phase === "isolated-live-use"
            ? "No genuine different-domain acquisition/candidate with its own independent lifecycle and live lease was supplied; the unactivated sibling does not qualify."
            : "No already-expired original signed activation on a different current native parent was supplied. The primary's authentic activation expires exactly with its parent, so primary-only expiry cannot test this guard." });
    }
    coverage.push({ boundary: "cumulative-use-and-cost-bounds",
      status: isolated.some(value => value.cases.some(test => test.id === "isolated-cumulative-resource" && test.passed))
        ? "EXECUTED" : "NOT_RUN_INTERNAL_PREREQUISITE",
      reason: "Requires a nominated independent live subject already at an actual signed use/cost bound; this driver creates no leases or changed costs to exhaust it." });
    await controller.connect(); connected = true;
    await controller.query("SET statement_timeout='5s'");
    const database = (await controller.query<{ pid: number; database: string; role: string }>(
      "SELECT pg_backend_pid() pid,current_database() database,current_user role")).rows[0];
    assert(database?.database === "x2_native" && database.role === "x2_owner", "X2_S8_LIVE_GATE_OWNED_DATABASE_REQUIRED");
    const controllerPid = Number(database.pid);
    await controller.query("SELECT pg_advisory_lock($1::integer,$2::integer)", [first, second]); locked = true;
    worker = await input.startWorker(sessionId);
    workerOutcome = worker.completed.then(() => { workerSettled = true; }, () => { workerSettled = true; });
    const waitUntil = Math.min(Date.now() + 60000, Date.parse(session.parent.deadlineAt));
    const blockedWriters = () => sql.query<{ pid: number; usename: string; wait_event: string }>(
      "SELECT pid,usename,wait_event FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))"
      + " AND query LIKE 'INSERT INTO finnor_os.application_semantics_events%'", [controllerPid]);
    let blocked: Awaited<ReturnType<typeof blockedWriters>>["rows"] = [];
    while (Date.now() < waitUntil && !workerSettled) {
      blocked = (await blockedWriters()).rows;
      if (blocked.length) break;
      await new Promise<void>(yes => setTimeout(yes, 25));
    }
    assert.equal(blocked.length, 1, "X2_S8_LIVE_GATE_REAL_SECOND_USE_PAUSE_REQUIRED");
    assert.equal(blocked[0]!.usename, "finnor_worker", "X2_S8_LIVE_GATE_ORDINARY_WORKER_REQUIRED");
    const pausedAt = Date.now();
    timer = setTimeout(stopOnTimeout, 7000);
    evidence.pause = { controllerPid, workerPid: worker.child.pid, blockedDatabasePid: blocked[0]!.pid,
      workerDatabaseRole: blocked[0]!.usename, observedAt: new Date(pausedAt).toISOString() };
    const pending = (await sql.query<{ body: unknown; artifact_id: string; version: string; content_digest: string }>(
      "SELECT a.body,a.artifact_id,a.version,a.content_digest FROM finnor_os.application_semantics_artifacts a"
      + " JOIN finnor_os.application_semantics_requests r ON r.id::text=a.body->'request'->>'requestId'"
      + " AND r.tenant_id=a.tenant_id AND r.principal_id=a.principal_id"
      + " WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.semantic_owner='S8' AND NOT a.private"
      + " AND a.body->>'schema'='finnor.s8.application-use.v1' AND r.session_id=$3 AND r.status='PREPARED'"
      + " AND NOT r.possible_egress AND NOT r.acknowledged AND r.observation_ref IS NULL LIMIT 2",
      [tenant, actor, sessionId])).rows;
    assert.equal(pending.length, 1, "X2_S8_LIVE_GATE_EXACT_PREPARED_NATIVE_LEASE_REQUIRED");
    const lease = ApplicationUseLeaseSchema.parse(pending[0]!.body), command = commandFor(lease);
    assert(sameX2Ref(applicationRef("use", lease), { owner: "S8", id: pending[0]!.artifact_id,
      version: pending[0]!.version, contentDigest: pending[0]!.content_digest })
      && sameX2Ref(lease.revisionRef, candidate.ref), "X2_S8_LIVE_GATE_NATIVE_LEASE_IDENTITY");
    const current = ApplicationCurrentnessBodySchema.parse(await applicationArtifact(ctx, lease.currentnessRef));
    const observationRef = current.evidenceRefs.find(value => value.owner === "COMPUTER");
    assert(observationRef, "X2_S8_LIVE_GATE_ORIGINAL_OBSERVATION_REQUIRED");
    const observation = ApplicationSnapshotSchema.parse(await applicationArtifact(ctx, observationRef));
    const suiteDeadline = Math.min(pausedAt + 7000, Date.parse(lease.expiresAt), Date.parse(current.expiresAt),
      Date.parse(observation.observedAt) + 30000, Date.parse(session.parent.deadlineAt));
    clearTimeout(timer);
    assert(Date.now() < suiteDeadline, "X2_S8_LIVE_GATE_ORIGINAL_WINDOW_EXPIRED");
    timer = setTimeout(stopOnTimeout, suiteDeadline - Date.now());
    const claims = (await sql.query<{ id: string; claim_fence: string; attempts: number }>(
      "SELECT id,claim_fence,attempts FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'sessionId'=$2"
      + " AND status='running' LIMIT 2", [tenant, sessionId])).rows;
    assert.equal(claims.length, 1, "X2_S8_LIVE_GATE_REAL_RUNNING_CLAIM_REQUIRED");
    const originals = (await sql.query<{ artifact_id: string; version: string; content_digest: string; body: unknown }>(
      "SELECT artifact_id,version,content_digest,body FROM finnor_os.application_semantics_artifacts"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S4' AND NOT private"
      + " AND body->>'schema'='finnor.x2.application-s8-currentness.v1' ORDER BY created_at DESC LIMIT 65", [tenant, actor])).rows;
    assert(originals.length <= 64, "X2_S8_LIVE_GATE_CURRENTNESS_SCAN_BOUND");
    let alternateCurrentnessRef: ExperimentRef | undefined;
    for (const original of originals) {
      const body = ApplicationCurrentnessBodySchema.parse(original.body);
      const ref = { owner: "S4", id: original.artifact_id, version: original.version, contentDigest: original.content_digest };
      assert(sameX2Ref(ref, x2Ref("S4", "application-s8-currentness", body)), "X2_S8_LIVE_GATE_CURRENTNESS_IDENTITY");
      if (!alternateCurrentnessRef && !sameX2Ref(ref, lease.currentnessRef)
        && body.requestBindingDigest !== lease.requestBindingDigest
        && Date.parse(body.checkedAt) <= Date.now() && Date.parse(body.expiresAt) > suiteDeadline) alternateCurrentnessRef = ref;
    }
    const nativeBefore = (await sql.query("SELECT status,possible_egress,acknowledged,observation_ref,wire_digest"
      + " FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [tenant, actor, lease.request.requestId])).rows;
    const before = await input.external();
    active();
    live = await fixture.checkApplicationCommandNegatives({ phase: "live-use", command, lease,
      ...(alternateCurrentnessRef ? { alternateCurrentnessRef } : {}) }, { signal: abort.signal });
    active();
    assert.equal(live.verdict, "PASS", "X2_S8_LIVE_GATE_NEGATIVE_PHASE_FAILED");
    const after = await input.external();
    const nativeAfter = (await sql.query("SELECT status,possible_egress,acknowledged,observation_ref,wire_digest"
      + " FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [tenant, actor, lease.request.requestId])).rows;
    assert.equal(x2Digest(nativeAfter), x2Digest(nativeBefore), "X2_S8_LIVE_GATE_NATIVE_REQUEST_CHANGED");
    assert.equal(after.digest, before.digest, "X2_S8_LIVE_GATE_NEGATIVES_CHANGED_APPLICATION");
    assert.equal(after.sequence, before.sequence, "X2_S8_LIVE_GATE_NEGATIVES_CHANGED_JOURNAL");
    assert.equal((await blockedWriters()).rows[0]?.pid, blocked[0]!.pid, "X2_S8_LIVE_GATE_PAUSE_OWNERSHIP_LOST");
    active();
    assert(Date.now() < suiteDeadline, "X2_S8_LIVE_GATE_LATE_SUITE");
    evidence.live = { phase: live.phase, artifactPath: live.artifactPath, inputArtifactPath: live.inputArtifactPath,
      useId: lease.useId, commandDigest: x2Digest(command), leaseDigest: x2Digest(lease), claim: claims[0],
      leaseExpiresAt: lease.expiresAt, currentnessExpiresAt: current.expiresAt,
      suiteDeadline: new Date(suiteDeadline).toISOString(), pauseMs: Date.now() - pausedAt,
      applicationBeforeDigest: before.digest, applicationAfterDigest: after.digest,
      journalSequence: before.sequence, nativeRequestDigest: x2Digest(nativeBefore) };
    coverage.push({ boundary: "different-genuine-currentness-preimage",
      status: live.cases.some(value => value.id === "use-other-real-currentness" && value.passed)
        ? "EXECUTED" : "NOT_RUN_INTERNAL_PREREQUISITE",
      reason: alternateCurrentnessRef ? "Existing hook owner-read-back and tested the different live native S4 preimage."
        : "No different incompatible native S4 preimage remained valid for the original bounded suite; no stamp was created or refreshed." });
    // Validation is complete while still paused. Do not inject a timeout SIGKILL
    // into an already released, legitimately dispatching positive worker.
    clearTimeout(timer); timer = undefined;
    const unlocked = await controller.query<{ released: boolean }>(
      "SELECT pg_advisory_unlock($1::integer,$2::integer) released", [first, second]);
    assert.equal(unlocked.rows[0]?.released, true, "X2_S8_LIVE_GATE_LOCK_NOT_OWNED");
    locked = false;
    row = await worker.completed;
    await fixture.assertSourceCut();
    assert.equal(createHash("sha256").update(await readFile(contractPath)).digest("hex"), contractDigest,
      "X2_S8_LIVE_GATE_CONTRACT_CHANGED");
    evidence.verdict = "PASS";
  } catch (error) {
    caught = error;
    evidence.failureCode = codeOf(error);
  } finally {
    abort.abort();
    if (timer) clearTimeout(timer);
    if (caught && worker && !workerSettled) worker.child.kill("SIGKILL");
    if (workerOutcome) await workerOutcome;
    const cleanupFailures: string[] = [];
    if (connected) {
      if (locked) try { await controller.query("SELECT pg_advisory_unlock($1::integer,$2::integer)", [first, second]); }
      catch { cleanupFailures.push("ADVISORY_UNLOCK"); }
    }
    try { await controller.end(); } catch { cleanupFailures.push("CONTROLLER_CLOSE"); }
    evidence.cleanupFailures = cleanupFailures;
    if (cleanupFailures.length) {
      caught = Error("X2_S8_LIVE_GATE_CLEANUP_FAILED"); evidence.verdict = "FAIL";
      evidence.failureCode = "X2_S8_LIVE_GATE_CLEANUP_FAILED";
    }
    evidence.finishedAt = new Date().toISOString();
    await input.save("native-s8-live-gates.json", evidence);
  }
  if (caught) throw caught;
  assert(live && row !== undefined, "X2_S8_LIVE_GATE_RESULT_REQUIRED");
  return { row, live, isolated, coverage, summary: evidence };
}
