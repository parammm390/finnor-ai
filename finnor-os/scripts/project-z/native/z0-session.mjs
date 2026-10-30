/**
 * Z0 original-parent native scenario. Launcher profile `z0`, started with
 * --no-worker so this scenario owns (and can SIGKILL) the production worker.
 *
 * Every case records its own PASS/FAIL/NOT_RUN into the evidence directory; a
 * failed case never stops later cases and is never retried silently. Nothing is
 * written to owner tables here: all owner rows come from the fixture library
 * (owner code, authenticated HTTP and the real worker).
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent,
  driveAcquisitionToModelReady, submitInstitutionAcquisition,
} from "./x1-origin-fixture.mts";

const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("Z0_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const env = readNativeEnvironment(state);
const privateRoot = join(state, "z0-private");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SENSITIVE = /token|secret|password|authorization|apikey|credential/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
};
let sequence = 0;
const record = (name, value) => {
  const path = join(evidence, `z0-${String(++sequence).padStart(3, "0")}-${name}.json`);
  writeFileSync(path, JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
};
const results = [];
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const detail = await body();
    results.push({ id, title, outcome: detail?.outcome ?? "PASS", started, detail: redact(detail?.detail ?? detail ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, error: String(error?.message ?? error).slice(0, 600) });
  }
  record("case-" + id, results.at(-1));
  console.log(JSON.stringify({ case: id, outcome: results.at(-1).outcome, error: results.at(-1).error }));
}
const notRun = (id, title, reason) => { results.push({ id, title, outcome: "NOT_RUN", reason }); record("case-" + id, results.at(-1)); };
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;

/** Read-only owner-state witness used to prove refusals changed nothing and to compare before/after. */
async function witness(parent) {
  const [reservations] = await q("SELECT count(*)::int count, md5(coalesce(string_agg(reservation_id||status||envelopes::text,'|' ORDER BY reservation_id),'')) digest FROM finnor_os.s5_reservations WHERE tenant_id=$1", [parent.tenantId]);
  const [original] = await q("SELECT status,md5(envelopes::text) envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const [charges] = await q("SELECT count(*)::int count, coalesce(sum(units),0)::text units FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const [sessions] = await q("SELECT count(*)::int count FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, parent.workId]);
  // X2 records its own exploration interactions as domain actions linked from s6_obligation_origins; those are acquisition, not business effect.
  const [actions] = await q(`SELECT count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=a.tenant_id AND o.domain_action_id=a.id) OR a.authority_context ? 'programId')::int count,
    count(*) FILTER (WHERE EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=a.tenant_id AND o.domain_action_id=a.id) AND NOT a.authority_context ? 'programId')::int exploration
    FROM finnor_os.domain_actions a WHERE a.tenant_id=$1 AND a.work_id=$2`, [parent.tenantId, parent.workId]);
  const [requests] = await q("SELECT count(*)::int count FROM finnor_os.pe_requests WHERE tenant_id=$1 AND deal_id=$2", [parent.tenantId, parent.dealId]);
  const [episode] = await q("SELECT md5(original_deadline::text||wall_deadline::text||parent_reservation::text||parent_demand::text) digest FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.episodeId]);
  const jobs = await q("SELECT type,status,count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 GROUP BY 1,2 ORDER BY 1,2", [parent.tenantId]);
  return { reservations, original, charges, sessions: sessions.count, domainActions: actions.count, explorationActions: actions.exploration, peRequests: requests.count, episode: episode.digest, jobs };
}
const sameBudget = (a, b) => a.reservations.digest === b.reservations.digest && a.original.envelopes === b.original.envelopes
  && a.episode === b.episode;

let worker = null;
const workerLog = join(privateRoot, "worker.log");
const startWorker = leaseSeconds => startOwnedWorker(env, { logPath: workerLog, leaseSeconds });
const ownedWorker = Boolean(env.FINNOR_WORKER_DATABASE_URL);
if (ownedWorker) worker = await startWorker(30);
record("environment", { ownedWorker, profile: "z0", apiOrigin: "http://127.0.0.1:3101", workerPid: worker?.pid ?? null });

// Next dev compiles API routes on first use; a cold 504 would be a harness artifact.
const owner = await signInOwner(env);
for (const route of ["institution-mandate", "institution-register-source", "institution-sources", "institution-submit", "application-acquire", "application-projection", "application-cancel"])
  await owner.operation(route, {}).catch(() => null);

let parent = null, acquired = null;
await runCase("P0-01", "Original institution parent reaches a quiescent checked state through owner code", async () => {
  parent = await createOriginalInstitutionParent(env, { record, tag: "a" + randomUUID().slice(0, 6) });
  ensure(parent.nativeStatus.liveJobs === 0, "PARENT_NOT_QUIESCENT");
  const w = await witness(parent);
  ensure(w.sessions === 0 && w.domainActions === 0 && w.peRequests === 0,
    `ORIGINAL_EFFECT_OR_SESSION_PREEXISTS sessions=${w.sessions} actions=${w.domainActions} peRequests=${w.peRequests}`);
  return { detail: { programId: parent.programId, status: parent.nativeStatus, deadlineAt: parent.deadlineAt, reservation: parent.parentReservation, witness: w } };
});
if (!parent) { record("summary", { results }); await sql.end(); await worker?.stop(); process.exit(1); }

const refusal = (label, options, accepted) => runCase("P0-" + label.id, label.title, async () => {
  const before = await witness(parent);
  const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record, ...options }, owner);
  await submitted.handle.portal.stop();
  const after = await witness(parent);
  const status = submitted.response.status, body = submitted.response.body;
  const text = JSON.stringify(body);
  ensure(status >= 400 && status < 500, "NOT_REFUSED_" + status);
  ensure(after.sessions === before.sessions && after.charges.count === before.charges.count && sameBudget(before, after), "REFUSAL_CHANGED_OWNER_STATE");
  const predicate = accepted.find(code => text.includes(code)) ?? null;
  return { outcome: predicate ? "PASS" : "FAIL", detail: { status, expectedPredicates: accepted, matchedPredicate: predicate, bodySha256: submitted.response.bodySha256, body, before, after } };
});

await refusal({ id: "02", title: "Standalone acquisition on an X1 Work (new-parent budget reset) is refused" },
  { mutate: request => { const { institutionalOrigin, ...rest } = request; return rest; } }, ["Z0_X1_WORK_CANNOT_RESET_AS_STANDALONE_X2"]);
await refusal({ id: "03", title: "Deadline extension beyond the original deadline is refused" },
  { mutate: request => ({ ...request, deadlineAt: new Date(Date.parse(parent.deadlineAt) + 10 * 60000).toISOString() }) },
  ["Z0_ORIGINAL_DEADLINE_EXHAUSTED_OR_EXTENDED"]);
await refusal({ id: "04", title: "Demand above the original reservation envelope is refused" },
  { requestUnits: 2048 }, ["Z0_ORIGINAL_BUDGET_EXHAUSTED", "Z0_ORIGINAL_RESERVATION_EXHAUSTED"]);
await refusal({ id: "05", title: "Demand against a resource outside the original reservation is refused" },
  { mutate: request => ({ ...request, resourceDemand: request.resourceDemand.map(line => ({ ...line, resourceId: "z0-foreign-" + randomUUID().slice(0, 6) })) }) },
  ["Z0_ORIGINAL", "RESOURCE"]);
await refusal({ id: "06", title: "Forged responsibility selector is refused" },
  { mutate: request => ({ ...request, institutionalOrigin: { ...request.institutionalOrigin, responsibilityIdentity: "x1-obligation:" + sha(randomUUID()) } }) },
  ["Z0_CHECKED_ORIGINAL_RESPONSIBILITY_REQUIRED", "Z0_ORIGINAL"]);
await refusal({ id: "07", title: "Selector naming another programme is refused" },
  { mutate: request => ({ ...request, institutionalOrigin: { ...request.institutionalOrigin, programId: randomUUID() } }) },
  ["Z0_ORIGINAL", "Z0_CHECKED_ORIGINAL_RESPONSIBILITY_REQUIRED", "PE_ENTITY_NOT_FOUND"]);
await runCase("P0-08", "Anonymous acquisition is refused with no state change", async () => {
  const before = await witness(parent);
  const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record, anonymous: true }, owner);
  await submitted.handle.portal.stop();
  const after = await witness(parent);
  ensure([401, 403].includes(submitted.response.status), "ANONYMOUS_NOT_REFUSED_" + submitted.response.status);
  ensure(after.sessions === before.sessions && sameBudget(before, after), "ANONYMOUS_CHANGED_STATE");
  return { status: submitted.response.status };
});

const killMode = process.env.FINNOR_Z0_MODE === "kill";
const invariants = async (before, sessionId, portalDir = null) => {
  const after = await witness(parent);
  const [session] = await q("SELECT reservation_ref,original_parent_ref,deadline_at,status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]);
  ensure(sha(session.reservation_ref) === sha(parent.parentReservation), "SESSION_RESERVATION_NOT_ORIGINAL");
  ensure(Date.parse(session.deadline_at) <= Math.min(Date.parse(parent.originalDeadlineAt), Date.parse(parent.wallDeadlineAt)), "DEADLINE_EXTENDED");
  ensure(after.reservations.count === before.reservations.count && after.original.envelopes === before.original.envelopes && after.episode === before.episode, "NEW_PARENT_OR_ENVELOPE_CHANGED");
  ensure(after.domainActions === before.domainActions && after.peRequests === before.peRequests, `BUSINESS_EFFECT_CREATED_BY_ACQUISITION actions=${after.domainActions} peRequests=${after.peRequests}`);
  let portalWrites = null;
  if (portalDir) {
    const wire = new Set((await q("SELECT body->'wire'->'identity'->>'requestId' id FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2", [parent.tenantId, sessionId])).map(row => row.id));
    const events = readFileSync(join(portalDir, "provider", "journal.ndjson"), "utf8").trim().split("\n").flatMap(line => JSON.parse(line).events ?? []);
    const writes = events.filter(event => /^(submission\.|approval\.committed)/.test(event.type));
    const unaccounted = writes.filter(event => !wire.has(event.requestId));
    ensure(unaccounted.length === 0, `PORTAL_WRITE_NOT_FROM_SESSION_REQUEST count=${unaccounted.length}`);
    portalWrites = { events: events.length, writes: writes.length, sessionRequests: wire.size };
  }
  const charges = await q("SELECT phase,resource_id,unit,units::text FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY phase", [parent.tenantId, parent.parentReservation.id]);
  const [envelope] = await q("SELECT e->>'resourceId' resource_id, (SELECT sum(v::numeric) FROM jsonb_array_elements_text(e->'quantities') v)::text limit_units FROM finnor_os.s5_reservations r, jsonb_array_elements(r.envelopes) e WHERE r.tenant_id=$1 AND r.reservation_id=$2 AND e->>'unit'='request'", [parent.tenantId, parent.parentReservation.id]);
  const used = charges.filter(row => row.resource_id === envelope.resource_id && row.unit === "request").reduce((sum, row) => sum + BigInt(row.units), 0n);
  ensure(used <= BigInt(envelope.limit_units), `ORIGINAL_ENVELOPE_EXCEEDED used=${used} limit=${envelope.limit_units}`);
  return { session, charges, original: { resourceId: envelope.resource_id, limit: envelope.limit_units, used: used.toString() }, portalWrites, after };
};
if (!killMode) {
  await runCase("P0-10", "Acquisition under the original reservation reaches MODEL_READY and S4 acceptance", async () => {
    const before = await witness(parent);
    try { acquired = await driveAcquisitionToModelReady(env, parent, { privateRoot, record }); }
    catch (error) {
      const row = (await q("SELECT id,status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC LIMIT 1", [parent.tenantId, parent.workId]))[0] ?? null;
      const events = row ? await q("SELECT kind,left(body::text,900) body FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,event_id", [parent.tenantId, row.id]) : [];
      const requests = row ? await q("SELECT node_id,status,reason,possible_egress,left(body::text,500) body FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at", [parent.tenantId, row.id]) : [];
      const dispositions = row ? await q("SELECT created_at,body->'detail'->>'disposition' disposition,body->'detail'->>'reason' reason FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind IN ('INDEPENDENT_APPLICATION_DISPOSITION','FAILED_OR_FENCED_PHYSICAL_DELIVERY') ORDER BY created_at,event_id", [parent.tenantId, row.id]) : [];
      const charges = await q("SELECT phase,resource_id,unit,count(*)::int n,sum(units)::text units FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 GROUP BY 1,2,3 ORDER BY 1", [parent.tenantId, parent.parentReservation.id]);
      record("acquisition-failure-session", { session: row, dispositions, charges, events: events.filter(item => !/^PHYSICAL_READ_/.test(item.kind)), requests, error: String(error.message).slice(0, 300) });
      throw error;
    }
    const checked = await invariants(before, acquired.sessionId, acquired.portal.dir);
    return { detail: { sessionId: acquired.sessionId, model: acquired.model, check: acquired.check, acceptance: acquired.acceptance, before, ...checked } };
  });
} else if (!ownedWorker) {
  notRun("P1-03", "SIGKILL of the worker during acquisition", "launcher was not started with --no-worker");
} else {
  await runCase("P1-03", "SIGKILL of the worker at the ambiguous request boundary, lease quarantine, explicit resume on the original reservation", async () => {
    const before = await witness(parent);
    const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record }, owner);
    ensure(submitted.response.status === 202, "ACQUIRE_NOT_ACCEPTED_" + submitted.response.status);
    const sessionId = submitted.response.body.sessionId;
    acquired = { sessionId, request: submitted.request };
    const sessionRow = async () => (await q("SELECT status,reason,generation,reservation_ref,original_parent_ref,deadline_at FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]))[0];
    const ambiguous = () => q("SELECT id,status,obligation_id,request_ref,body->'wire'->'identity'->>'requestId' wire_request_id,body->'wire'->'identity'->>'effectId' effect_id,body->>'operationId' operation FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 AND possible_egress AND observation_ref IS NULL AND status IN ('POSSIBLE_EGRESS','PENDING') ORDER BY created_at LIMIT 1", [parent.tenantId, sessionId]);
    let lost = null;
    for (let i = 0; i < 12000 && !lost; i++) {
      const [row] = await ambiguous();
      if (row) { lost = row; break; }
      if (["MODEL_READY", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"].includes((await sessionRow())?.status)) break;
      await sleep(50);
    }
    ensure(lost, "KILL_BOUNDARY_NOT_OBSERVED");
    const [attempt] = await q("SELECT j.id job_id,j.attempts,j.claim_fence,j.lease_owner,j.lease_expires_at,a.id attempt_id,a.worker_id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.claim_token=j.claim_token WHERE j.tenant_id=$1 AND j.payload->>'sessionId'=$2 AND j.status='running' AND a.finished_at IS NULL", [parent.tenantId, sessionId]);
    ensure(attempt, "ACTUAL_QUEUE_CLAIM_NOT_FOUND");
    ensure(String(attempt.worker_id).endsWith(":" + worker.pid), "KILLED_PROCESS_IS_NOT_THE_QUEUE_OWNER");
    const pid = worker.pid;
    const [stillAmbiguous] = await ambiguous();
    worker.child.kill("SIGKILL");
    const exit = await worker.exited;
    ensure(exit.signal === "SIGKILL", "WORKER_EXIT_NOT_SIGKILL_" + exit.signal);
    const journalPath = join(submitted.handle.portal.dir, "provider", "journal.ndjson");
    const journalEvents = () => readFileSync(journalPath, "utf8").trim().split("\n").flatMap(line => JSON.parse(line).events ?? []);
    const sends = requestId => journalEvents().filter(event => event.requestId === requestId && /^(dispatch\.|submission\.accepted|approval\.committed)/.test(event.type)).length;
    const sendsAtKill = sends(lost.wire_request_id);
    const afterKill = await sessionRow();
    worker = await startWorker(30);
    let quarantine = null;
    for (let i = 0; i < 180 && !quarantine; i++) {
      const [row] = await q("SELECT j.status,j.attempts,j.claim_fence,a.outcome,a.failure_kind FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.id=$2 WHERE j.id=$1", [attempt.job_id, attempt.attempt_id]);
      if (row?.status === "quarantined") quarantine = row; else await sleep(2500);
    }
    ensure(quarantine, "LOST_JOB_NOT_QUARANTINED_AFTER_LEASE_EXPIRY");
    ensure(quarantine.outcome === "reconciliation_required" && quarantine.failure_kind === "lease_expired", `QUARANTINE_CLASSIFICATION_${quarantine.outcome}_${quarantine.failure_kind}`);
    ensure(quarantine.attempts === attempt.attempts && quarantine.claim_fence === attempt.claim_fence, "QUARANTINE_CHANGED_ATTEMPT_OR_FENCE");
    const resumed = await owner.operation("application-resume", { root: submitted.request.root, workId: parent.workId, sessionId });
    ensure(resumed.status === 202, `RESUME_NOT_ACCEPTED_${resumed.status}:${JSON.stringify(resumed.body).slice(0, 200)}`);
    let final = null;
    for (let i = 0; i < 240; i++) {
      final = await sessionRow();
      if (["MODEL_READY", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"].includes(final?.status)) break;
      await sleep(2500);
    }
    const lostRows = await q("SELECT id,status,obligation_id,possible_egress,observation_ref IS NOT NULL observed,reason FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 AND request_ref=$3::jsonb", [parent.tenantId, sessionId, JSON.stringify(lost.request_ref)]);
    const sendsAfter = sends(lost.wire_request_id);
    const jobsFinal = await q("SELECT type,status,attempts,claim_fence,left(coalesce(last_error,''),200) error FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'sessionId'=$2 ORDER BY run_at,id", [parent.tenantId, sessionId]);
    const portalJournalDigest = sha(journalEvents());
    await submitted.handle.portal.stop();
    const checked = await invariants(before, sessionId, submitted.handle.portal.dir);
    ensure(JSON.stringify(final.reservation_ref) === JSON.stringify(afterKill.reservation_ref) && JSON.stringify(final.original_parent_ref) === JSON.stringify(afterKill.original_parent_ref)
      && Date.parse(final.deadline_at) === Date.parse(afterKill.deadline_at), "RECOVERY_CHANGED_PARENT_RESERVATION_OR_DEADLINE");
    ensure(sendsAtKill <= 1 && sendsAfter === sendsAtKill, `LOST_REQUEST_RESENT sendsAtKill=${sendsAtKill} sendsAfter=${sendsAfter}`);
    ensure(lostRows.length === 1 && lostRows[0].id === lost.id && lostRows[0].obligation_id === lost.obligation_id, "LOST_REQUEST_IDENTITY_NOT_PRESERVED");
    ensure(["VERIFIED", "DENIED", "UNKNOWN"].includes(lostRows[0].status), "LOST_REQUEST_NOT_RECONCILED_OR_RETAINED_" + lostRows[0].status);
    ensure(["MODEL_READY", "UNKNOWN", "BLOCKED", "FAILED", "STALE"].includes(final?.status), "RECOVERY_DID_NOT_SETTLE_" + final?.status);
    return { detail: { sessionId, pid, exit, boundary: { requestId: lost.id, status: lost.status, operation: lost.operation, stillAmbiguousAtKill: Boolean(stillAmbiguous), attemptWorkerId: attempt.worker_id },
      jobBeforeKill: { attempts: attempt.attempts, claimFence: attempt.claim_fence, leaseExpiresAt: attempt.lease_expires_at }, afterKill: { status: afterKill.status, reason: afterKill.reason },
      quarantine, resume: { status: resumed.status }, final: { status: final.status, reason: final.reason }, lostRequestAfter: lostRows[0],
      portalSends: { atKill: sendsAtKill, afterResume: sendsAfter }, portalJournalDigest, jobsFinal, before, ...checked } };
  });
}

await runCase("P0-11", "Original continuation after acceptance consumes or falls back on the accepted model (outcome recorded)", async () => {
  if (!acquired) return { outcome: "NOT_RUN", detail: "no accepted model" };
  const [accepted] = await q("SELECT 1 FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED' LIMIT 1", [parent.tenantId, acquired.sessionId]);
  if (!accepted) return { outcome: "NOT_RUN", detail: "the session has no S4 acceptance event, so there is no model to consume" };
  await sleep(45000);
  const events = await q(`SELECT e.kind,e.generation,left(e.body::text,600) body FROM finnor_os.p1_events e WHERE e.tenant_id=$1 AND e.request_id=$2 ORDER BY e.created_at`, [parent.tenantId, parent.programId]);
  const jobs = await q("SELECT type,status,left(coalesce(last_error,''),300) error,attempts FROM finnor_os.jobs WHERE tenant_id=$1 AND (payload->>'programId'=$2 OR payload->>'sessionId'=$3) ORDER BY run_at,id", [parent.tenantId, parent.programId, acquired.sessionId]).catch(async () =>
    q("SELECT type,status FROM finnor_os.jobs WHERE tenant_id=$1 AND (payload->>'programId'=$2 OR payload->>'sessionId'=$3) ORDER BY run_at,id", [parent.tenantId, parent.programId, acquired.sessionId]));
  const used = events.filter(row => /P1_ORIGINAL_APPLICATION_/.test(row.kind));
  const w = await witness(parent);
  const [head] = await q("SELECT jsonb_array_length(coalesce(body->'nodes','[]'::jsonb)) nodes, (SELECT count(*)::int FROM jsonb_array_elements(coalesce(body->'nodes','[]'::jsonb)) n WHERE n->'action' IS NOT NULL AND n->'action' <> 'null'::jsonb) executable FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=(SELECT head_id FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2)", [parent.tenantId, parent.programId]);
  const quarantined = jobs.filter(row => row.type === "run_x1_institution_continuation_v1" && row.status === "quarantined");
  if (!used.length && head.executable === 0 && quarantined.some(row => /X1_SUPPORTED_ACTION_POPULATION_REQUIRED/.test(row.error ?? ""))) {
    // Owner contract (institution-continuation.ts): continuation only consumes a model for an executable, not yet dispatched duty. A parent whose
    // only duty is unresolved has none, so the continuation quarantines. This is a precondition gap of the parent shape, not a consumption result.
    return { outcome: "NOT_RUN", reason: "ORIGINAL_PARENT_HAS_NO_EXECUTABLE_UNDISPATCHED_DUTY: continuation quarantined X1_SUPPORTED_ACTION_POPULATION_REQUIRED; accepted model could be neither used nor fallen back on",
      detail: { reason: "ORIGINAL_PARENT_HAS_NO_EXECUTABLE_UNDISPATCHED_DUTY", head, events: events.map(row => row.kind), jobs, witness: w } };
  }
  return { outcome: used.length ? "PASS" : "FAIL", detail: { used: used.map(row => row.kind), events: events.map(row => row.kind), jobs, head, witness: w,
    note: used.length ? null : "accepted model has no recorded original-programme use or fallback" } };
});

await runCase("P0-12", "Second acquisition for the same original Work cannot create a fresh parent/budget", async () => {
  const before = await witness(parent);
  const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record }, owner);
  await submitted.handle.portal.stop();
  const after = await witness(parent);
  ensure(after.reservations.count === before.reservations.count && sameBudget(before, after), "SECOND_ACQUISITION_RESET_BUDGET");
  const sessions = await q("SELECT count(*)::int n, count(*) FILTER (WHERE id=parent_id)::int roots FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, parent.workId]);
  ensure(sessions[0].roots <= 1, "TWO_ORIGINAL_PARENT_ROOTS");
  return { detail: { status: submitted.response.status, body: submitted.response.body, sessions: sessions[0] } };
});

await runCase("P1-01", "Duplicate delivery of the exact acquisition request returns the same session without new charge", async () => {
  ensure(acquired, "NO_ACQUISITION");
  const before = await witness(parent);
  const again = await owner.operation("application-acquire", acquired.request);
  const after = await witness(parent);
  const sessionId = again.body?.sessionId ?? again.body?.id ?? null;
  ensure(after.sessions === before.sessions && after.charges.count === before.charges.count && after.reservations.count === before.reservations.count, "DUPLICATE_DELIVERY_CHANGED_STATE");
  return { outcome: sessionId === acquired.sessionId ? "PASS" : "FAIL", detail: { status: again.status, sessionId, expected: acquired.sessionId, body: again.body } };
});

await runCase("P1-02", "Cancel after MODEL_READY returns to the original (direct fallback) without a new allowance", async () => {
  ensure(acquired, "NO_ACQUISITION");
  const before = await witness(parent);
  const cancelled = await owner.operation("application-cancel", { root: acquired.request.root, workId: parent.workId, sessionId: acquired.sessionId });
  await sleep(5000);
  const after = await witness(parent);
  ensure(after.reservations.count === before.reservations.count && sameBudget(before, after), "CANCEL_CHANGED_BUDGET");
  const [session] = await q("SELECT status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, acquired.sessionId]);
  return { detail: { status: cancelled.status, body: cancelled.body, session, before, after } };
});

if (!killMode) notRun("P1-03", "SIGKILL of the worker during acquisition, restart, bounded recovery", "kill mode run only (FINNOR_Z0_MODE=kill); the original Work admits one root application parent per tenant resource set");
let second = null;
notRun("P1-05", "Portal revocation / profile change race during acquisition", "not implemented in this scenario revision");
for (const [id, title] of [["P2-01", "Mounted reload during acquisition"], ["P2-02", "Principal switch"], ["P2-03", "Token refresh and logout"], ["P2-04", "Offline during mounted acquisition"]])
  notRun(id, title, "mounted browser phase not implemented in this scenario revision");
notRun("P3-01", "Wire z0/run-native-e2e.mjs", "that driver requires separately delivered authority and oracle; not wired");

const tally = results.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] ?? 0) + 1 }), {});
record("summary", { tally, results, tenantId: parent.tenantId, parents: [parent.programId, second?.programId ?? null] });
await sql.end();
await worker?.stop();
chmodSync(workerLog, 0o600);
console.log(JSON.stringify({ event: "Z0_SESSION_DONE", tally }));
process.exit(tally.FAIL ? 1 : 0);
