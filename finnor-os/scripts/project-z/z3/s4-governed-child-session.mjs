/**
 * Z3 S4 governed origin-child native scenario (application-owner half).
 * Launcher profile `z0` (x1 + x2) started with --no-worker so this scenario
 * owns the production worker. Evidence is written to FINNOR_NATIVE_EVIDENCE;
 * every case records PASS / FAIL / NOT_RUN with its reason and a failed case
 * never stops later cases.
 *
 * Scope statement (also written to summary.json): real X1 original parent, real
 * X2 acquisition and S4 acceptance (fixture library), then the new governed
 * origin-child request, parking, selection table rules, owner-side consumption
 * of one selection and the inherited-deadline expiry. The selection row and the
 * Z3 session row used by the consumption case are FIXTURE rows inserted by
 * the scenario administrator; they are NOT Z3 writer evidence. The Z3 writer
 * and receipt reader (selectGeneralExecutableOperationTx) are NOT_RUN here:
 * a Z3 native map binds the application model revision, and that revision
 * exists only after the acquisition, which needs the original Work input that
 * the map would have to be written into.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent, driveAcquisitionToModelReady,
} from "../native/x1-origin-fixture.mts";

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
const record = (name, value) => writeFileSync(join(evidence, `z3-${String(++sequence).padStart(3, "0")}-${name}.json`),
  JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
const results = [];
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const detail = await body();
    results.push({ id, title, outcome: detail?.outcome ?? "PASS", started, detail: redact(detail?.detail ?? detail ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, error: String(error?.message ?? error).slice(0, 800) });
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
const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;
const api = await import("../../../packages/private-equity/src/application-semantics/api");
const store = await import("../../../packages/private-equity/src/application-semantics/store");
const portalAdmin = await import("../../x2/fixtures/admin.mjs");
const portalStore = await import("../../x2/fixtures/store.mjs");

const workerLog = join(privateRoot, "worker.log");
const worker = env.FINNOR_WORKER_DATABASE_URL ? await startOwnedWorker(env, { logPath: workerLog, leaseSeconds: 30 }) : null;
record("environment", { ownedWorker: Boolean(worker), profile: "z0", workerPid: worker?.pid ?? null });
const owner = await signInOwner(env);
for (const route of ["institution-mandate", "institution-register-source", "institution-sources", "institution-submit", "application-acquire", "application-projection"])
  await owner.operation(route, {}).catch(() => null);

const DEADLINE_CAP_MS = 14 * 60000;
let parent = null, acquired = null;
await runCase("G01", "Original X1 parent reaches MODEL_READY with S4 acceptance (real owners)", async () => {
  parent = await createOriginalInstitutionParent(env, { record, tag: "g" + randomUUID().slice(0, 6) });
  acquired = await driveAcquisitionToModelReady(env, parent, { privateRoot, record, deadlineCapMs: DEADLINE_CAP_MS });
  ensure(acquired.status === "MODEL_READY" && acquired.acceptance?.acceptanceRef, "PARENT_NOT_MODEL_READY_AND_ACCEPTED");
  return { detail: { sessionId: acquired.sessionId, deadlineAt: acquired.deadlineAt, model: acquired.model, acceptance: acquired.acceptance } };
});
if (!acquired) {
  for (const id of ["G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11"]) notRun(id, "requires G01", "PARENT_FIXTURE_FAILED");
  record("summary", { results }); await sql.end(); await worker?.stop(); process.exit(1);
}

const ctx = { auth: { tenantId: parent.tenantId, userId: parent.ownerId, employeeId: parent.ownerId, role: "owner" } };
const root = { entityType: "pe_deal", entityId: parent.dealId };
const children = async () => q("SELECT id,status,reason,parent,composition_ref,deadline_at FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND parent_id=$2 AND id<>parent_id",
  [parent.tenantId, acquired.sessionId]);
const witness = async () => {
  const [reservation] = await q("SELECT md5(envelopes::text||status) d FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const [charges] = await q("SELECT count(*)::int n, coalesce(sum(units),0)::text units FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const [actions] = await q("SELECT count(*)::int n FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, parent.workId]);
  const [consumptions] = await q("SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1", [parent.tenantId]);
  const [requests] = await q("SELECT count(*)::int n FROM finnor_os.application_semantics_requests r JOIN finnor_os.application_semantics_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id WHERE r.tenant_id=$1 AND s.work_id=$2", [parent.tenantId, parent.workId]);
  const [work] = await q("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.workId]);
  const [episode] = await q("SELECT md5(original_deadline::text||wall_deadline::text||parent_reservation::text||parent_demand::text) d FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.episodeId]);
  const portal = (await portalStore.snapshot(acquired.portal.dir)).state;
  return { reservation: reservation?.d, charges, domainActions: actions.n, s5Consumptions: consumptions.n, requests: requests.n, workStatus: work.status,
    episode: episode.d, portalRecords: sha(portal.records) };
};
const objective = () => JSON.parse(readFileSync(join(acquired.portal.dir, "held-out-objective.json"), "utf8"));
const executeInput = async (overrides = {}) => {
  const target = objective();
  const [artifact] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, acquired.model.ref.id]);
  const names = new Set();
  for (const operation of artifact.body.operations ?? []) for (const parameter of operation.parameters ?? []) if (parameter.kind === "quantity") names.add(parameter.name);
  ensure(names.size === 1, "FROZEN_MODEL_UNAMBIGUOUS_QUANTITY_SIGNATURE_REQUIRED");
  const quantity = { kind: "quantity", decimal: target.reporting.amount, currency: target.reporting.currency, entity: target.reporting.entity,
    unit: target.reporting.unit, time: target.reporting.date, basis: target.reporting.basis };
  return { root, workId: parent.workId, sessionId: acquired.sessionId, executionProfileId: acquired.profileIds[0], targetId: target.recordId,
    goal: { phase: "APPROVED", reporting: quantity }, parameters: { [[...names][0]]: quantity }, idempotencyKey: "z3-governed-" + randomUUID(), ...overrides };
};
const before = await witness();
record("witness-before-child", before);

await runCase("G02", "Non-owner and foreign-work governed requests are refused with no child", async () => {
  const input = await executeInput();
  const member = await refusedWith(() => api.requestInstitutionApplicationExecution({ auth: { ...ctx.auth, role: "member" } }, input));
  const foreignWork = await refusedWith(() => api.requestInstitutionApplicationExecution(ctx, { ...input, workId: randomUUID() }), "Z3_ORIGINAL_WORK_AND_GOVERNED_PROFILE_REQUIRED");
  ensure(member.refused && foreignWork.refused && foreignWork.matched, "NOT_REFUSED:" + JSON.stringify({ member, foreignWork }));
  ensure((await children()).length === 0, "REFUSAL_CREATED_CHILD");
  return { detail: { member, foreignWork } };
});
await runCase("G03", "A demonstration target and a target outside the learned profile are refused", async () => {
  const demonstration = await refusedWith(async () => api.requestInstitutionApplicationExecution(ctx, await executeInput({ targetId: acquired.credentials.recordIds[0] })), "X2_FRESH_RECORD_MUST_NOT_BE_A_DEMONSTRATION");
  const outside = await refusedWith(async () => api.requestInstitutionApplicationExecution(ctx, await executeInput()));
  ensure(demonstration.matched && outside.refused, "NOT_REFUSED:" + JSON.stringify({ demonstration, outside }));
  ensure((await children()).length === 0, "REFUSAL_CREATED_CHILD");
  return { detail: { demonstration, outside } };
});

let child = null, requestInput = null;
await runCase("G04", "Governed child of the accepted origin parent is created with the original reservation and deadline", async () => {
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
  const [parentRow] = await q("SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, acquired.sessionId]);
  child = row;
  ensure(row.parent_id === parentRow.id && row.id !== row.parent_id, "NOT_A_CHILD");
  ensure(row.parent.viabilityGoverned?.schema === "finnor.s4.z3-governed-origin-child.v1" && row.parent.viabilityGoverned.autonomousExecution === false, "GOVERNED_MARKER_MISSING");
  for (const column of ["work_id", "work_input_id", "work_input_digest", "allocation_ref", "reservation_ref", "original_parent_ref", "root_consumption_ref", "model_ref", "check_ref", "rights_revision"]) {
    ensure(sha(row[column]) === sha(parentRow[column]), "CHILD_DIFFERS_FROM_PARENT:" + column);
  }
  ensure(new Date(row.deadline_at).getTime() === new Date(parentRow.deadline_at).getTime(), "DEADLINE_NOT_INHERITED");
  const after = await witness();
  ensure(after.reservation === before.reservation && after.episode === before.episode, "NEW_ALLOWANCE_OR_ORIGINAL_BUDGET_CHANGED");
  return { detail: { childId: row.id, status: response.status, deadlineAt: row.deadline_at, governed: row.parent.viabilityGoverned, witnessBefore: before, witnessAfter: after } };
});
if (!child) {
  for (const id of ["G05", "G06", "G07", "G08", "G09", "G10"]) notRun(id, "requires G04", "GOVERNED_CHILD_NOT_CREATED");
} else {
  await runCase("G05", "Replay is idempotent; a second child or a changed payload under the same key is refused", async () => {
    const replay = await api.requestInstitutionApplicationExecution(ctx, requestInput);
    const second = await refusedWith(async () => api.requestInstitutionApplicationExecution(ctx, { ...requestInput, idempotencyKey: "z3-governed-second-" + randomUUID() }), "Z3_ORIGINAL_EXECUTION_CHILD_ALREADY_EXISTS");
    const changed = await refusedWith(async () => api.requestInstitutionApplicationExecution(ctx, { ...requestInput, goal: { ...requestInput.goal, phase: "SUBMITTED" } }), "X2_EXECUTION_IDEMPOTENCY_CONFLICT");
    ensure(replay.sessionId === child.id && second.matched && changed.refused, "REPLAY_RULES_VIOLATED:" + JSON.stringify({ replay, second, changed }));
    ensure((await children()).length === 1, "CHILD_COUNT_CHANGED");
    return { detail: { replay, second, changed } };
  });

  let parked = null, parkedWitness = null;
  await runCase("G06", "Governed child composes then parks in PLANNING with no S5 debit, S6 effect or wire (D4/C14)", async () => {
    parked = await waitFor("CHILD_PARKED", 600000, async () => {
      const [row] = await q(`SELECT s.status,s.reason,s.composition_ref,(SELECT count(*)::int FROM finnor_os.application_semantics_events e WHERE e.tenant_id=s.tenant_id AND e.session_id=s.id AND e.kind='Z3_GOVERNED_CHILD_PARKED_FOR_SELECTION') parked
        FROM finnor_os.application_semantics_sessions s WHERE s.tenant_id=$1 AND s.id=$2`, [parent.tenantId, child.id]);
      if (["FAILED", "STALE", "BLOCKED", "CANCELLED", "UNKNOWN", "COMPLETED"].includes(row.status)) throw Error(`CHILD_${row.status}:${row.reason}`);
      return row.status === "PLANNING" && row.composition_ref && row.parked > 0 ? row : null;
    });
    await sleep(20000);
    parkedWitness = await witness();
    const [own] = await q("SELECT (SELECT count(*)::int FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2) requests,(SELECT count(*)::int FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND session_id=$2) selections", [parent.tenantId, child.id]);
    ensure(own.requests === 0 && own.selections === 0, "CHILD_ACTED_WITHOUT_SELECTION");
    ensure(parkedWitness.charges.n === before.charges.n && parkedWitness.s5Consumptions === before.s5Consumptions && parkedWitness.domainActions === before.domainActions, "S5_S6_ROWS_CHANGED_BY_PARKED_CHILD");
    ensure(parkedWitness.workStatus !== "completed", "ORIGINAL_WORK_COMPLETED_BY_CHILD");
    return { detail: { parked, own, witnessBefore: before, witnessParked: parkedWitness, portalRecordsUnchangedSinceBefore: parkedWitness.portalRecords === before.portalRecords } };
  });

  await runCase("G07", "Selection table is retained and once-only: preimage immutable, no delete, terminal frozen, one live selection per step", async () => {
    const [composition] = parked ? await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, parked.composition_ref.id]) : [];
    ensure(composition?.body?.steps?.length, "COMPOSITION_STEPS_REQUIRED");
    const step = composition.body.steps[0];
    const z3Session = randomUUID(), cursor = sha("fixture-cursor-a");
    await q(`INSERT INTO finnor_os.z3_viability_sessions(tenant_id,id,principal_id,work_id,work_input_id,original_parent_id,arena_digest,binding_digest,arena,binding,reservation_ref,status,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,'{}'::jsonb,'{}'::jsonb,$8::jsonb,'VIABLE',$9)`,
      [parent.tenantId, z3Session, parent.ownerId, parent.workId, child.work_input_id, parent.episodeId, sha("fixture-arena"), JSON.stringify(parent.parentReservation), child.deadline_at]);
    const insert = (id, cursorDigest, edge, stepId = step.id) => q(`INSERT INTO finnor_os.z3_application_selections(tenant_id,id,principal_id,session_id,parent_session_id,work_id,work_input_id,composition_ref,composition_digest,step_id,step_index,operation_id,semantic_revision,original_grant_ref,z3_session_id,z3_edge_index,z3_cursor_digest,z3_map_digest,z3_job_id,z3_claim_token_digest,z3_claim_fence,z3_delivery_attempt_id,z3_session_generation,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,0,$11,'1',$12::jsonb,$13,$14,$15,$16,$17,$18,1,$19,1,$20) RETURNING id`,
      [parent.tenantId, id, parent.ownerId, child.id, acquired.sessionId, parent.workId, child.work_input_id, JSON.stringify(child.composition_ref ?? parked.composition_ref),
        (parked.composition_ref).contentDigest, stepId, step.operationId, JSON.stringify(parked.composition_ref), z3Session, edge, cursorDigest, sha("fixture-map"), randomUUID(), sha("claim"), randomUUID(), child.deadline_at]);
    const first = randomUUID();
    await insert(first, cursor, 0);
    const checks = {};
    checks.duplicateEdge = await refusedWith(() => insert(randomUUID(), cursor, 0), "z3_application_selection_edge");
    checks.secondLiveSelectionOfSameStep = await refusedWith(() => insert(randomUUID(), sha("fixture-cursor-b"), 1), "z3_application_selection_live_step");
    checks.preimageChange = await refusedWith(() => q("UPDATE finnor_os.z3_application_selections SET step_id='other' WHERE tenant_id=$1 AND id=$2", [parent.tenantId, first]), "preimage cannot change");
    checks.delete = await refusedWith(() => q("DELETE FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND id=$2", [parent.tenantId, first]), "retained");
    checks.receiptWithoutRetained = await refusedWith(() => q("UPDATE finnor_os.z3_application_selections SET status='RESULT_RETAINED' WHERE tenant_id=$1 AND id=$2", [parent.tenantId, first]), "transition invalid", "check");
    await q("UPDATE finnor_os.z3_application_selections SET status='STALE',reason='FIXTURE_STALE' WHERE tenant_id=$1 AND id=$2", [parent.tenantId, first]);
    checks.terminalFrozen = await refusedWith(() => q("UPDATE finnor_os.z3_application_selections SET status='SELECTED' WHERE tenant_id=$1 AND id=$2", [parent.tenantId, first]), "terminal state cannot change");
    for (const [name, value] of Object.entries(checks)) ensure(value.refused, "NOT_REFUSED:" + name + ":" + value.text);
    return { detail: { checks, z3SessionFixtureRow: z3Session, qualification: "FIXTURE_ROWS_NOT_Z3_WRITER_EVIDENCE" } };
  });

  await runCase("G08", "S5 inherited consumption through a live selection (SQL branch) and the owner-side consumption of one selection", async () => {
    const [composition] = await q("SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND artifact_id=$2", [parent.tenantId, parked.composition_ref.id]);
    const step = composition.body.steps[0];
    const [z3] = await q("SELECT id FROM finnor_os.z3_viability_sessions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at LIMIT 1", [parent.tenantId, parent.workId]);
    const selectionId = randomUUID();
    await q(`INSERT INTO finnor_os.z3_application_selections(tenant_id,id,principal_id,session_id,parent_session_id,work_id,work_input_id,composition_ref,composition_digest,step_id,step_index,operation_id,semantic_revision,original_grant_ref,z3_session_id,z3_edge_index,z3_cursor_digest,z3_map_digest,z3_job_id,z3_claim_token_digest,z3_claim_fence,z3_delivery_attempt_id,z3_session_generation,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,0,$11,'1',$12::jsonb,$13,7,$14,$15,$16,$17,1,$18,1,$19)`,
      [parent.tenantId, selectionId, parent.ownerId, child.id, acquired.sessionId, parent.workId, child.work_input_id, JSON.stringify(parked.composition_ref),
        parked.composition_ref.contentDigest, step.id, step.operationId, JSON.stringify(parked.composition_ref), z3.id, sha("fixture-cursor-live"), sha("fixture-map"), randomUUID(), sha("claim"), randomUUID(), child.deadline_at]);
    const [row] = await q("SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, child.id]);
    const client = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL }); await client.connect();
    try { await store.enqueueApplicationSelection(ctx, row, selectionId, client); } finally { await client.end(); }
    const outcome = await waitFor("SELECTION_OUTCOME", 420000, async () => {
      const [selection] = await q("SELECT status,reason,receipt_ref FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND id=$2", [parent.tenantId, selectionId]);
      const [session] = await q("SELECT status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, child.id]);
      return ["RESULT_RETAINED", "REFUSED", "STALE"].includes(selection.status) || ["FAILED", "STALE", "UNKNOWN", "BLOCKED"].includes(session.status) ? { selection, session } : null;
    }, 3000);
    const after = await witness();
    const events = await q("SELECT kind,left(body::text,400) body FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind NOT LIKE 'PHYSICAL_%' ORDER BY created_at,event_id", [parent.tenantId, child.id]);
    const own = await q("SELECT node_id,status,possible_egress FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2", [parent.tenantId, child.id]);
    record("selection-consumption-observed", { selectionId, outcome, requests: own, witnessAfter: after, events });
    ensure(outcome.selection.status === "RESULT_RETAINED", "SELECTED_STEP_NOT_CONSUMED:" + JSON.stringify(outcome));
    ensure(after.charges.n > parkedWitness.charges.n, "NO_S5_DEBIT_AGAINST_ORIGINAL_RESERVATION");
    return { detail: { selectionId, outcome, requests: own, witnessAfter: after, qualification: "FIXTURE_SELECTION_ROW_NOT_Z3_WRITER_EVIDENCE" } };
  });

  await runCase("G09", "Inherited deadline: the child ends through the delayed expiry job and the original keeps its responsibility", async () => {
    const wait = Math.max(0, new Date(child.deadline_at).getTime() - Date.now()) + 90000;
    const ended = await waitFor("CHILD_EXPIRY", wait + 120000, async () => {
      const [row] = await q("SELECT status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, child.id]);
      return ["BLOCKED", "FAILED", "STALE", "CANCELLED", "COMPLETED"].includes(row.status) ? row : null;
    }, 5000);
    const live = await q("SELECT id,status FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND session_id=$2 AND status IN('SELECTED','CONSUMING')", [parent.tenantId, child.id]);
    const after = await witness();
    ensure(ended.status === "BLOCKED" && ended.reason === "X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED" || ended.status === "COMPLETED", "CHILD_DID_NOT_EXPIRE:" + JSON.stringify(ended));
    ensure(live.length === 0, "LIVE_SELECTION_AFTER_EXPIRY");
    ensure(after.workStatus !== "completed" && after.reservation === before.reservation || ended.status === "COMPLETED", "ORIGINAL_WORK_OR_ALLOCATION_ALTERED");
    return { detail: { ended, liveSelections: live, witnessAfter: after } };
  });
}

notRun("G10", "Z3 writer + receipt reader over a real original Work (C-states through E-states)", "BLOCKED_B3: the Z3 native map must embed the application model revision, which exists only after the acquisition that requires the original Work input; Z0 A5 refuses an appended input");
notRun("G11", "Physical SIGKILL boundaries, duplicate delivery, cancellation, revocation, exhausted-reservation fallback", "NOT_IMPLEMENTED_IN_THIS_SCENARIO: need the S8 consumer fixture and fault points; see report");

const summary = { schema: "finnor.project-z.native.z3-s4-governed-child.v1", finishedAt: new Date().toISOString(), results,
  counts: Object.fromEntries(["PASS", "FAIL", "NOT_RUN"].map(k => [k, results.filter(r => r.outcome === k).length])),
  inputs: { profile: "z0", noWorker: true, deadlineCapMs: DEADLINE_CAP_MS, scenarioSha256: sha(readFileSync(new URL(import.meta.url))) },
  qualification: "DISPOSABLE_NATIVE_STACK_NOT_ACCEPTANCE_NOT_PROTECTED_ADMISSION" };
record("summary", summary);
await acquired.portal.stop().catch(() => null);
await sql.end();
await worker?.stop("SIGTERM");
process.exit(0);
