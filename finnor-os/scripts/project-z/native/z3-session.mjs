/**
 * Z3 native session (Level 2): original Work whose instruction IS the Z3 native
 * map -> real X1 parent -> real X2 acquisition + S4 acceptance -> governed
 * origin child -> Z3 synthesis (approved producer bundle, independent checker)
 * -> the Z3 S4 writer selects the first canonical step -> the X2 worker
 * consumes it under the original S5 reservation -> Z3 continues from the
 * retained owner receipt.
 *
 * Launcher: `--profiles=z0,z3 --z3-producer=<abs path> ` with `--no-worker`
 * so this scenario owns the production worker (it registers the Z3 handlers).
 * Every case records PASS / FAIL / NOT_RUN with its reason; a failed case never
 * stops later cases that do not depend on it. Evidence: FINNOR_NATIVE_EVIDENCE.
 *
 * The map is a deliberately small standing responsibility over the portal
 * record: draft it, validate it, then it stays VALIDATED. No renewal, no
 * settlement, no fairness assumption, no modeled S5 allowance (the real S5
 * debit still happens and is measured). An outcome the map does not name makes
 * Z3 stop with a typed refusal; it is never guessed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent, driveAcquisitionToModelReady,
} from "./x1-origin-fixture.mts";

const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("Z3_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const env = readNativeEnvironment(state);
const privateRoot = join(state, "z3-private");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SENSITIVE = /token|secret|password|authorization|apikey|credential|headers/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
};
let sequence = 0;
const record = (name, value) => writeFileSync(join(evidence, `z3s-${String(++sequence).padStart(3, "0")}-${name}.json`),
  JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
const results = [];
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const detail = await body();
    results.push({ id, title, outcome: detail?.outcome ?? "PASS", started, detail: redact(detail?.detail ?? detail ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, error: String(error?.message ?? error).slice(0, 1200) });
  }
  record("case-" + id, results.at(-1));
  console.log(JSON.stringify({ case: id, outcome: results.at(-1).outcome, error: results.at(-1).error }));
}
const notRun = (id, title, reason) => { results.push({ id, title, outcome: "NOT_RUN", reason }); record("case-" + id, results.at(-1)); };
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };
const waitFor = async (label, ms, probe, every = 1500) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw Error("TIMEOUT_" + label);
    await sleep(every);
  }
};
const refusedWith = async (call, ...codes) => {
  try { await call(); } catch (error) {
    const text = String(error?.code ?? "") + " " + String(error?.message ?? error) + " " + JSON.stringify(error?.body ?? "");
    return { refused: true, matched: codes.find(code => text.includes(code)) ?? null, text: text.slice(0, 300) };
  }
  return { refused: false, matched: null, text: "NOT_REFUSED" };
};

for (const key of ["DATABASE_URL", "FINNOR_ENVIRONMENT", "FINNOR_P4_PROFILE", "FINNOR_X2_PROFILE", "FINNOR_X2_SOURCE_ROOT",
  "FINNOR_X2_DISPOSABLE_SECRET_ROOT"]) if (env[key] !== undefined) process.env[key] = env[key];
process.env.AUTH_DEV_BYPASS = "0";

/* ---- the Z3 native map (the original Work instruction) ---- */
const LATE_BOUND_REVISION = { owner: "S4", id: "z3-late-bound-origin-model", version: "late-bound-v1",
  contentDigest: "33e3a8208acc6c82599a6c45f1f09c269e1f67c1cb361df645942c91c8988095" };
// Model operation ids are `<descriptor id>.<first 16 hex of x2Digest({role})>`; the editor digest is run-independent
// (observed in w3-gov-07: api.draft.341b4342bc094cce, api.validate.341b4342bc094cce, approver api.approve.d46a2b0d5f03a280).
const OPERATIONS = { draft: { id: "api.draft.341b4342bc094cce", semanticRevision: "1" }, validate: { id: "api.validate.341b4342bc094cce", semanticRevision: "1" } };
const predicate = values => ({ observerId: "portal", revision: LATE_BOUND_REVISION, values });
const unit = (id, owner, observation) => ({ id, owner, observation, safe: true, remaining: 0, unknown: [] });
function buildMap() {
  const arena = {
    schema: "finnor.z3.public-arena.v1", id: "z3-native-portal-draft-validate", observationMode: "PUBLIC_PERFECT_INFORMATION",
    states: [unit("c-new", "C", "obs-new"), unit("e-drafted", "E", "obs-drafted"), unit("c-drafted", "C", "obs-draft-held"),
      unit("e-validated", "E", "obs-validated")],
    edges: [
      { from: "c-new", to: "e-drafted", action: "DRAFT", renewalRef: null, settlementRef: null },
      { from: "e-drafted", to: "c-drafted", action: "DRAFTED", renewalRef: null, settlementRef: null },
      { from: "c-drafted", to: "e-validated", action: "VALIDATE", renewalRef: null, settlementRef: null },
      { from: "e-validated", to: "e-validated", action: "STAYS_VALIDATED", renewalRef: null, settlementRef: null },
    ],
    initial: ["c-new"], assumptions: [], goals: [["e-validated"]],
    resources: { capacity: 0, maximum: 0, obligationIds: [], renewalRefs: [], settlementRefs: [], unknownOccupiesCapacity: true },
  };
  return {
    schema: "finnor.z3.original-native-map.v2", profile: "S4_TYPED_OWNER_OPERATIONS", arena,
    observers: [{ id: "portal", kind: "APPLICATION_SNAPSHOT", lateBinding: "ACCEPTED_ORIGIN_MODEL", observation: "CURRENT_ORIGINAL_LAWFUL_READBACK" }],
    controller: [
      { edgeIndex: 0, operation: { kind: "APPLICATION_COMPOSE", observerId: "portal", operationId: OPERATIONS.draft.id, semanticRevision: OPERATIONS.draft.semanticRevision } },
      { edgeIndex: 2, operation: { kind: "APPLICATION_COMPOSE", observerId: "portal", operationId: OPERATIONS.validate.id, semanticRevision: OPERATIONS.validate.semanticRevision } },
    ],
    observations: [
      { stateId: "c-new", predicate: predicate({ $view: "CONTEXT", "state.phase": "NEW" }) },
      { stateId: "e-drafted", predicate: predicate({ $view: "OPERATION_RETURNED", operationId: OPERATIONS.draft.id, "state.phase": "DRAFT" }) },
      { stateId: "c-drafted", predicate: predicate({ $view: "CONTEXT", "state.phase": "DRAFT" }) },
      { stateId: "e-validated", predicate: predicate({ "state.phase": "VALIDATED" }) },
    ],
    environment: [
      { edgeIndex: 1, predicate: predicate({ $view: "OPERATION_RETURNED", operationId: OPERATIONS.draft.id, "state.phase": "DRAFT" }) },
      { edgeIndex: 3, predicate: predicate({ "state.phase": "VALIDATED" }) },
    ],
    assumptions: [],
    goals: [{ index: 0, clauses: [predicate({ "state.phase": "VALIDATED" })] }, { index: 1, clauses: [] }].slice(0, 1),
    resources: { meaning: "NO_MODELED_EFFECT_RESOURCE_NOT_COMPUTE_ALLOWANCE", capacityObserverId: null, renewals: [], settlements: [] },
  };
}
const MAP = buildMap();

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;
const api = await import("../../../packages/private-equity/src/application-semantics/api");
const portalAdmin = await import("../../x2/fixtures/admin.mjs");
const portalStore = await import("../../x2/fixtures/store.mjs");

const workerLog = join(privateRoot, "worker.log");
let worker = env.FINNOR_WORKER_DATABASE_URL ? await startOwnedWorker(env, { logPath: workerLog, leaseSeconds: 30 }) : null;
record("environment", { ownedWorker: Boolean(worker), profiles: "z0,z3", workerPid: worker?.pid ?? null, mapSha256: sha(MAP) });
const owner = await signInOwner(env);

const DEADLINE_CAP_MS = 24 * 60000;
let parent = null, acquired = null;
await runCase("Z01", "Original Work whose instruction is the Z3 native map reaches MODEL_READY with S4 acceptance (real owners)", async () => {
  parent = await createOriginalInstitutionParent(env, { record, tag: "z" + randomUUID().slice(0, 6), instruction: JSON.stringify(MAP) });
  const [input] = await q("SELECT instruction_text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at", [parent.tenantId, parent.workId]);
  ensure(sha(input.instruction_text) === sha(JSON.stringify(MAP)), "ORIGINAL_WORK_INPUT_IS_NOT_THE_MAP");
  acquired = await driveAcquisitionToModelReady(env, parent, { privateRoot, record, deadlineCapMs: DEADLINE_CAP_MS, requestUnits: 480, timeoutMs: 1200000 });
  ensure(acquired.status === "MODEL_READY" && acquired.acceptance?.acceptanceRef, "PARENT_NOT_MODEL_READY_AND_ACCEPTED");
  return { detail: { sessionId: acquired.sessionId, deadlineAt: acquired.deadlineAt, model: acquired.model, acceptance: acquired.acceptance,
    workInputCount: (await q("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, parent.workId]))[0].n } };
});
const ALL = ["Z02", "Z03", "Z04", "Z05", "Z06", "Z07", "Z08", "Z09", "Z10"];
const finish = async code => {
  record("summary", { schema: "finnor.project-z.native.z3-session.v1", finishedAt: new Date().toISOString(), results,
    counts: Object.fromEntries(["PASS", "FAIL", "NOT_RUN"].map(k => [k, results.filter(r => r.outcome === k).length])),
    inputs: { profiles: "z0,z3", noWorker: true, deadlineCapMs: DEADLINE_CAP_MS, mapSha256: sha(MAP), scenarioSha256: sha(readFileSync(new URL(import.meta.url))) },
    qualification: "DISPOSABLE_NATIVE_STACK_NOT_ACCEPTANCE_NOT_PROTECTED_ADMISSION" });
  await acquired?.portal.stop().catch(() => null);
  await sql.end();
  await worker?.stop("SIGTERM");
  process.exit(code);
};
if (!acquired) {
  for (const id of ALL) notRun(id, "requires Z01", "PARENT_FIXTURE_FAILED");
  await finish(1);
}

const ctx = { auth: { tenantId: parent.tenantId, userId: parent.ownerId, employeeId: parent.ownerId, role: "owner" } };
const root = { entityType: "pe_deal", entityId: parent.dealId };
const portalJournalLines = () => {
  try { return readFileSync(join(acquired.portal.dir, "provider", "journal.ndjson"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
};
const witness = async () => {
  const [charges] = await q("SELECT count(*)::int n, coalesce(sum(units),0)::text units FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const phases = await q("SELECT phase,count(*)::int n FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 GROUP BY phase ORDER BY phase", [parent.tenantId, parent.parentReservation.id]);
  const [reservation] = await q("SELECT md5(envelopes::text) envelopes,status FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const [reservations] = await q("SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1", [parent.tenantId]);
  const [consumptions] = await q("SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1", [parent.tenantId]);
  const [work] = await q("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.workId]);
  const [episode] = await q("SELECT md5(original_deadline::text||wall_deadline::text||parent_reservation::text) d FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.episodeId]);
  const [p1] = await q("SELECT attempts_used,steps_used FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at LIMIT 1", [parent.tenantId, parent.workId]);
  const effects = await q("SELECT status,count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1 GROUP BY status ORDER BY status", [parent.tenantId]);
  const portal = (await portalStore.snapshot(acquired.portal.dir)).state;
  return { charges, chargesByPhase: phases, reservation, reservationsInTenant: reservations.n, s5Consumptions: consumptions.n, workStatus: work.status, episode: episode.d,
    p1Used: p1, effects, portalJournalLines: portalJournalLines(), portalPhases: Object.values(portal.records ?? {}).map(item => `${item.recordId}:${item.phase}`) };
};
const objective = () => JSON.parse(readFileSync(join(acquired.portal.dir, "held-out-objective.json"), "utf8"));
const executeInput = async () => {
  const target = objective();
  const [artifact] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, acquired.model.ref.id]);
  const names = new Set();
  for (const operation of artifact.body.operations ?? []) for (const parameter of operation.parameters ?? []) if (parameter.kind === "quantity") names.add(parameter.name);
  ensure(names.size === 1, "FROZEN_MODEL_UNAMBIGUOUS_QUANTITY_SIGNATURE_REQUIRED");
  const quantity = { kind: "quantity", decimal: target.reporting.amount, currency: target.reporting.currency, entity: target.reporting.entity,
    unit: target.reporting.unit, time: target.reporting.date, basis: target.reporting.basis };
  return { root, workId: parent.workId, sessionId: acquired.sessionId, executionProfileId: acquired.profileIds[0], targetId: target.recordId,
    goal: { phase: "APPROVED", reporting: quantity }, parameters: { [[...names][0]]: quantity }, idempotencyKey: "z3-native-" + randomUUID() };
};
// SubmitSchema is strict and selects only by Work and idempotency key; read and recover carry the root.
const viability = async (operation, body) => owner.operation(operation, operation === "viability-submit" ? body : { ...body, root });
const sessions = () => q("SELECT id,status,reason,s4_consumed,generation,candidate_digest,check_digest FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at", [parent.tenantId, parent.workId]);
const before = await witness();
record("witness-before", before);

await runCase("Z02", "Z3 submit before any governed child exists is refused by the late-bound owner and creates no Z3 session", async () => {
  const response = await viability("viability-submit", { workId: parent.workId, idempotencyKey: "z3-early-" + randomUUID() });
  ensure(response.status === 422 && response.body?.code === "VIABILITY_PREDICATE_UNPASSED" && /^Z3_/.test(response.body?.predicate ?? ""),
    "EARLY_SUBMIT_NOT_REFUSED_BY_A_TYPED_Z3_PREDICATE:" + response.status + ":" + JSON.stringify(response.body).slice(0, 300));
  ensure((await sessions()).length === 0, "EARLY_SUBMIT_CREATED_SESSION");
  return { detail: { status: response.status, body: response.body } };
});

let child = null, requestInput = null, parked = null;
await runCase("Z03", "Governed origin child of the accepted parent is created and parks with the canonical composition", async () => {
  await portalAdmin.releaseHeldOut(acquired.portal.dir);
  const target = objective();
  const tenantSecrets = join(env.FINNOR_X2_DISPOSABLE_SECRET_ROOT, parent.tenantId);
  const credentials = JSON.parse(readFileSync(join(acquired.portal.dir, "credentials.json"), "utf8"));
  for (const [index, role, grantKey] of [[0, "editor", "submittingGrantId"], [1, "approver", "approvingGrantId"]]) {
    const [{ restrictions }] = await q("SELECT restrictions FROM finnor_os.auth_profiles WHERE id=$1", [acquired.profileIds[index]]);
    restrictions.applicationSemantics.allowedTargets = [target.recordId];
    restrictions.applicationSemantics.allowedEntities = [target.reporting.entity];
    await q("UPDATE finnor_os.auth_profiles SET restrictions=$2::jsonb,connection_revision=connection_revision+1,updated_at=clock_timestamp() WHERE id=$1",
      [acquired.profileIds[index], JSON.stringify(restrictions)]);
    const file = readdirSync(tenantSecrets).find(name => name.startsWith(role + "-" + parent.tag + "-"));
    ensure(file, "PROFILE_SECRET_FILE_NOT_FOUND:" + role);
    writeFileSync(join(tenantSecrets, file), JSON.stringify({ applicationHeaders: JSON.stringify(
      { authorization: "Bearer " + credentials.tokens[role], "x-portal-grant": target[grantKey] }) }), { mode: 0o600 });
  }
  requestInput = await executeInput();
  const response = await api.requestInstitutionApplicationExecution(ctx, requestInput);
  const [row] = await q("SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, response.sessionId]);
  child = row;
  ensure(row.parent_id === acquired.sessionId && row.parent.viabilityGoverned?.schema === "finnor.s4.z3-governed-origin-child.v1", "NOT_A_GOVERNED_CHILD");
  parked = await waitFor("CHILD_PARKED", 600000, async () => {
    const [now] = await q(`SELECT s.status,s.reason,s.composition_ref,(SELECT count(*)::int FROM finnor_os.application_semantics_events e WHERE e.tenant_id=s.tenant_id AND e.session_id=s.id AND e.kind='Z3_GOVERNED_CHILD_PARKED_FOR_SELECTION') parked
      FROM finnor_os.application_semantics_sessions s WHERE s.tenant_id=$1 AND s.id=$2`, [parent.tenantId, child.id]);
    if (["FAILED", "STALE", "BLOCKED", "CANCELLED", "UNKNOWN", "COMPLETED"].includes(now.status)) throw Error(`CHILD_${now.status}:${now.reason}`);
    return now.status === "PLANNING" && now.composition_ref && now.parked > 0 ? now : null;
  });
  const [composed] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, parked.composition_ref.id]);
  const [modelBody] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, acquired.model.ref.id]);
  const steps = (composed?.body?.steps ?? []).map(step => ({ id: step.id, operationId: step.operationId }));
  const operations = (modelBody?.body?.operations ?? []).map(item => ({ id: item.id, semanticRevision: item.semanticRevision }));
  record("model-and-composition-shape", { operations, steps, stateSchema: (modelBody?.body?.stateSchema ?? []).map(field => ({ path: field.path, kind: field.kind })) });
  ensure(steps[0]?.operationId === OPERATIONS.draft.id && steps[1]?.operationId === OPERATIONS.validate.id, "COMPOSITION_DOES_NOT_START_WITH_DRAFT_VALIDATE:" + JSON.stringify(steps));
  for (const item of Object.values(OPERATIONS)) {
    ensure(operations.some(op => op.id === item.id && op.semanticRevision === item.semanticRevision), "MODEL_OPERATION_OR_REVISION_DIFFERS_FROM_MAP:" + item.id);
  }
  return { detail: { childId: child.id, steps, operations, deadlineAt: child.deadline_at } };
});
if (!child || !parked) {
  for (const id of ALL.slice(2)) notRun(id, "requires Z03", "GOVERNED_CHILD_NOT_PARKED");
  await finish(1);
}

let session = null, beforeSubmit = null;
await runCase("Z04", "Z3 submit synthesizes and checks a strategy and the S4 writer selects exactly the first canonical step", async () => {
  const key = "z3-native-submit-" + randomUUID();
  beforeSubmit = await witness();
  const submitted = await viability("viability-submit", { workId: parent.workId, idempotencyKey: key });
  ensure(submitted.status === 200 || submitted.status === 202, "SUBMIT_REFUSED:" + submitted.status + ":" + JSON.stringify(submitted.body).slice(0, 400));
  const sessionId = submitted.body.sessionId;
  session = await waitFor("Z3_FIRST_SELECTION", 360000, async () => {
    const [row] = await q("SELECT id,status,reason,s4_consumed FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]);
    if (["UNREALIZABLE", "UNKNOWN", "STALE", "FAILED"].includes(row.status)) throw Error(`Z3_SESSION_${row.status}:${row.reason}`);
    const selections = await q("SELECT id,status,step_id,step_index,operation_id,z3_edge_index,z3_job_id FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at", [parent.tenantId, child.id]);
    return selections.length ? { row, selections } : null;
  }, 2000);
  const read = await viability("viability-read", { sessionId });
  const jobs = await q("SELECT type,status,count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 GROUP BY type,status ORDER BY type,status", [parent.tenantId]);
  record("z3-first-selection", { submit: submitted.body, read: read.body, selections: session.selections, jobs });
  ensure(session.selections.length === 1 && session.selections[0].operation_id === OPERATIONS.draft.id && session.selections[0].step_index === 0, "FIRST_SELECTION_NOT_THE_FIRST_CANONICAL_STEP");
  ensure(read.body?.candidate && read.body?.check?.status === "VIABLE", "CHECK_NOT_VIABLE:" + JSON.stringify(read.body?.check));
  return { detail: { sessionId, selections: session.selections, check: read.body.check, candidate: read.body.candidate } };
});
if (!session) {
  for (const id of ALL.slice(3)) notRun(id, "requires Z04", "Z3_SESSION_DID_NOT_SELECT");
  await finish(1);
}

let firstDone = null;
await runCase("Z05", "The application owner consumes the selected step under the original reservation and retains one receipt", async () => {
  const selectionId = session.selections[0].id;
  const pre = beforeSubmit;
  firstDone = await waitFor("FIRST_STEP_RETAINED", 420000, async () => {
    const [selection] = await q("SELECT status,reason,receipt_ref FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND id=$2", [parent.tenantId, selectionId]);
    if (["REFUSED", "STALE"].includes(selection.status)) throw Error(`SELECTION_${selection.status}:${selection.reason}`);
    return selection.status === "RESULT_RETAINED" ? selection : null;
  }, 2000);
  const after = await witness();
  const [receipt] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, firstDone.receipt_ref.id]);
  const requests = await q("SELECT node_id,status,possible_egress FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2", [parent.tenantId, child.id]);
  record("first-step-consumption", { selectionId, firstDone, receipt: receipt?.body, requests, witnessBeforeStep: pre, witnessAfterStep: after });
  const executionCharges = witness => witness.chargesByPhase.find(row => row.phase === "EXECUTION")?.n ?? 0;
  ensure(executionCharges(after) > executionCharges(pre), "NO_EXECUTION_S5_DEBIT_AGAINST_THE_ORIGINAL_RESERVATION");
  ensure(after.reservationsInTenant === before.reservationsInTenant && after.reservation.envelopes === before.reservation.envelopes, "A_NEW_RESERVATION_OR_ALLOWANCE_APPEARED");
  ensure(after.portalJournalLines === pre.portalJournalLines + 1, "PORTAL_JOURNAL_NOT_EXACTLY_ONE_NEW_ENTRY:" + pre.portalJournalLines + "->" + after.portalJournalLines);
  ensure(receipt?.body?.disposition === "VERIFIED" && receipt.body.z3?.sessionId === session.row.id, "RECEIPT_NOT_VERIFIED_AND_BOUND_TO_THE_Z3_SESSION");
  return { detail: { selectionId, requests, charges: { before: pre.charges, after: after.charges }, portalPhases: after.portalPhases, afterState: receipt.body.afterState } };
});

await runCase("Z06", "Duplicate recovery requests converge: one continuation, the selection and portal journal are not duplicated", async () => {
  const key = "z3-native-recover-" + randomUUID();
  const first = await viability("viability-recover", { sessionId: session.row.id, idempotencyKey: key });
  const second = await viability("viability-recover", { sessionId: session.row.id, idempotencyKey: key });
  const concurrent = await viability("viability-recover", { sessionId: session.row.id, idempotencyKey: "z3-native-recover-b-" + randomUUID() });
  record("duplicate-recovery", { first: first.body, second: second.body, concurrent: concurrent.body });
  const advanced = await waitFor("Z3_SECOND_SELECTION", 360000, async () => {
    const [row] = await q("SELECT status,reason FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, session.row.id]);
    if (["UNREALIZABLE", "UNKNOWN", "STALE", "FAILED"].includes(row.status)) throw Error(`Z3_SESSION_${row.status}:${row.reason}`);
    const selections = await q("SELECT id,status,step_id,step_index,operation_id,z3_edge_index FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND session_id=$2 ORDER BY step_index,created_at", [parent.tenantId, child.id]);
    return selections.length >= 2 ? selections : null;
  }, 2000);
  const perStep = Object.fromEntries(advanced.map(item => [item.step_index, advanced.filter(other => other.step_index === item.step_index).length]));
  ensure(Object.values(perStep).every(count => count === 1), "DUPLICATE_SELECTION_FOR_A_STEP:" + JSON.stringify(perStep));
  ensure(advanced[1].operation_id === OPERATIONS.validate.id, "SECOND_SELECTION_NOT_VALIDATE");
  const prefixes = await q("SELECT body->'cursor'->>'stateId' state,body->'cursor'->'goalVisits' goals,body->'transitions' transitions FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND session_id=$2 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id", [parent.tenantId, session.row.id]);
  record("z3-continuation", { selections: advanced, prefixes });
  return { detail: { first: first.body, second: second.body, concurrent: concurrent.body, selections: advanced, cursorStates: prefixes.map(item => item.state) } };
});

await runCase("Z07", "Second step is consumed and Z3 reaches the VALIDATED E-state from the retained receipt, never from the portal", async () => {
  const second = (await q("SELECT id FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND session_id=$2 AND step_index=1", [parent.tenantId, child.id]))[0];
  await waitFor("SECOND_STEP_RETAINED", 420000, async () => {
    const [selection] = await q("SELECT status,reason FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND id=$2", [parent.tenantId, second.id]);
    if (["REFUSED", "STALE"].includes(selection.status)) throw Error(`SELECTION_${selection.status}:${selection.reason}`);
    return selection.status === "RESULT_RETAINED";
  }, 2000);
  const recover = await viability("viability-recover", { sessionId: session.row.id, idempotencyKey: "z3-native-recover-c-" + randomUUID() });
  const end = await waitFor("Z3_E_VALIDATED", 360000, async () => {
    const [row] = await q("SELECT status,reason FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, session.row.id]);
    if (["UNREALIZABLE", "UNKNOWN", "STALE", "FAILED"].includes(row.status)) throw Error(`Z3_SESSION_${row.status}:${row.reason}`);
    const [prefix] = await q("SELECT body->'cursor'->>'stateId' state,body->'cursor'->'goalVisits' goals,body->'cursor'->>'transitions' transitions FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND session_id=$2 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id DESC LIMIT 1", [parent.tenantId, session.row.id]);
    return prefix?.state === "e-validated" ? prefix : null;
  }, 2000);
  const after = await witness();
  const read = await viability("viability-read", { sessionId: session.row.id });
  record("z3-final", { recover: recover.body, end, read: read.body, witnessAfter: after });
  ensure(after.reservationsInTenant === before.reservationsInTenant, "A_NEW_RESERVATION_APPEARED");
  ensure(after.workStatus !== "completed", "ORIGINAL_WORK_COMPLETED_BY_THE_SESSION");
  ensure(after.portalJournalLines === beforeSubmit.portalJournalLines + 2, "PORTAL_JOURNAL_NOT_EXACTLY_TWO_NEW_ENTRIES:" + beforeSubmit.portalJournalLines + "->" + after.portalJournalLines);
  ensure(after.portalPhases.includes(objective().recordId + ":VALIDATED"), "PORTAL_RECORD_NOT_VALIDATED:" + after.portalPhases.join(","));
  return { detail: { cursor: end, portalPhases: after.portalPhases, journalLines: after.portalJournalLines, s5Charges: after.charges } };
});

notRun("Z08", "SIGKILL of the application worker after the S5 debit, after the S6 identity, after the wire effect and before receipt retention", "NOT_IMPLEMENTED: see report GAPS (kill windows are not exposed as durable boundaries of the X2 consumer; polled kills cannot name the boundary honestly)");
notRun("Z09", "SIGKILL of the Z3 worker at the CLAIM/STRATEGY/OBSERVATION boundaries over the native stack", "NOT_IMPLEMENTED: the owned worker is spawned without an IPC channel the Z3 disposable boundary hook requires");
notRun("Z10", "Cancellation, revocation, exhausted-reservation fallback and expiry with a live selection under Z3", "NOT_IMPLEMENTED in this scenario; owner-side expiry is covered by w3-gov G09");

await finish(0);
