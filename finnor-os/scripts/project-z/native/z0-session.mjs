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
  driveAcquisitionToModelReady, submitInstitutionAcquisition, createStandaloneApplicationWork,
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
  parent = await createOriginalInstitutionParent(env, { record, tag: "a" + randomUUID().slice(0, 6), shape: "gated-two-supported-and-unresolved" });
  ensure(parent.nativeStatus.liveJobs === 0, "PARENT_NOT_QUIESCENT");
  const w = await witness(parent);
  ensure(w.sessions === 0 && w.domainActions === (parent.gated ? 1 : 0) && w.peRequests === 0,
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


/**
 * `reject` mode (failure model section 12): the remaining G1 rejects and the standalone control, each on the same
 * fresh original parent. It ends the run: the original Work admits one root application parent, and P0-15 consumes it.
 */
if (process.env.FINNOR_Z0_MODE === "reject") {
  const STOP = ["MODEL_READY", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"];
  let ordinary = null;
  await runCase("P0-13a", "An ordinary Work (no X1 episode, own resource) exists beside the original parent", async () => {
    ordinary = await createStandaloneApplicationWork(env, parent);
    const [episodes] = await q("SELECT count(*)::int n FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, ordinary.workId]);
    ensure(episodes.n === 0 && ordinary.workId !== parent.workId && !Object.values(parent.resources).includes(ordinary.resourceId), "ORDINARY_WORK_IS_NOT_ORDINARY");
    return { detail: { workId: ordinary.workId, resourceId: ordinary.resourceId, x1Episodes: episodes.n } };
  });
  const sessionsOf = async workId => (await q("SELECT count(*)::int n FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2", [parent.tenantId, workId]))[0].n;
  await runCase("P0-13", "NO_ORIGINAL_PARENT: an ordinary Work carrying the original parent's selector is refused", async () => {
    if (!ordinary) return { outcome: "NOT_RUN", detail: { reason: "ordinary Work was not created (P0-13a)" } };
    const before = await witness(parent), ordinaryBefore = await sessionsOf(ordinary.workId);
    const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record,
      mutate: request => ({ ...request, workId: ordinary.workId, resourceDemand: [{ resourceId: ordinary.resourceId, unit: "request", amount: "480" }] }) }, owner);
    await submitted.handle.portal.stop();
    const after = await witness(parent);
    ensure(submitted.response.status >= 400 && submitted.response.status < 500, "NOT_REFUSED_" + submitted.response.status);
    ensure(after.sessions === before.sessions && await sessionsOf(ordinary.workId) === ordinaryBefore && after.charges.count === before.charges.count && sameBudget(before, after), "REFUSAL_CHANGED_OWNER_STATE");
    return { detail: { status: submitted.response.status, body: submitted.response.body, before, after } };
  });
  await refusal({ id: "14", title: "DEADLINE_EXPIRED: an already expired deadline is refused" },
    { mutate: request => ({ ...request, deadlineAt: new Date(Date.now() - 60000).toISOString() }) }, ["Z0_ORIGINAL_DEADLINE_EXHAUSTED_OR_EXTENDED", "DEADLINE"]);
  let firstSession = null;
  await runCase("P0-15", "PENDING_LEARNING: a second acquisition while the first session is non-terminal is refused", async () => {
    const before = await witness(parent);
    const first = await submitInstitutionAcquisition(env, parent, { privateRoot, record }, owner);
    ensure(first.response.status === 202, "FIRST_ACQUIRE_NOT_ACCEPTED_" + first.response.status);
    const sessionId = first.response.body.sessionId, statusOf = async () => (await q("SELECT status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]))[0]?.status;
    const state = await statusOf();
    try {
      if (STOP.includes(state)) return { outcome: "NOT_RUN", reason: "PENDING_WINDOW_NOT_REACHED", detail: { statusBeforeSecond: state } };
      const second = await submitInstitutionAcquisition(env, parent, { privateRoot, record, requestUnits: 120 }, owner);
      await second.handle.portal.stop();
      const text = JSON.stringify(second.response.body);
      const roots = (await q("SELECT count(*)::int n FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2 AND id=parent_id", [parent.tenantId, parent.workId]))[0].n;
      const cancelled = await owner.operation("application-cancel", { root: first.request.root, workId: parent.workId, sessionId });
      let final = null;
      for (let i = 0; i < 90 && !STOP.includes(final); i++) { final = await statusOf(); if (!STOP.includes(final)) await sleep(2000); }
      const after = await witness(parent);
      ensure(second.response.status >= 400 && second.response.status < 500, "SECOND_ACQUISITION_NOT_REFUSED_" + second.response.status);
      ensure(roots === 1, "TWO_ORIGINAL_PARENT_ROOTS_" + roots);
      ensure(after.reservations.count === before.reservations.count && after.original.envelopes === before.original.envelopes && after.episode === before.episode, "PENDING_REFUSAL_CHANGED_BUDGET");
      firstSession = { sessionId, final };
      const named = /PENDING|SUBCOMPUTATION/.test(text);
      return { outcome: named ? "PASS" : "FAIL", detail: { predicate: named ? "PENDING_NAMED" : "REFUSED_WITHOUT_PENDING_CODE", statusBeforeSecond: state, secondStatus: second.response.status, body: second.response.body,
        roots, cancel: { status: cancelled.status }, final, before, after } };
    } finally { await first.handle.portal.stop(); }
  });
  await runCase("P0-16", "Standalone X2 on an ordinary Work stays lawful (the Z0 refusal is specific to X1 Works)", async () => {
    if (!ordinary) return { outcome: "NOT_RUN", detail: { reason: "ordinary Work was not created (P0-13a)" } };
    const before = await witness(parent);
    const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record,
      mutate: request => { const { institutionalOrigin, ...rest } = request; return { ...rest, workId: ordinary.workId, resourceDemand: [{ resourceId: ordinary.resourceId, unit: "request", amount: "480" }] }; } }, owner);
    try {
      ensure(submitted.response.status === 202, `STANDALONE_NOT_ACCEPTED_${submitted.response.status}:${JSON.stringify(submitted.response.body).slice(0, 300)}`);
      const sessionId = submitted.response.body.sessionId;
      let row = null;
      for (let i = 0; i < 360; i++) {
        row = (await q("SELECT status,reason,reservation_ref,original_parent_ref,work_id::text FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]))[0];
        if (STOP.includes(row?.status)) break;
        await sleep(2500);
      }
      ensure(STOP.includes(row?.status), "STANDALONE_SESSION_DID_NOT_SETTLE_" + row?.status);
      const after = await witness(parent);
      const [acceptance] = await q("SELECT count(*)::int n FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED'", [parent.tenantId, sessionId]);
      const standaloneReservation = row.reservation_ref?.id ?? null;
      ensure(row.work_id === ordinary.workId, "SESSION_NOT_ON_ORDINARY_WORK");
      ensure((row.original_parent_ref?.institutionalProgramRef ?? null) === null, "STANDALONE_SESSION_CARRIES_INSTITUTIONAL_PROGRAM_REF");
      ensure(standaloneReservation && standaloneReservation !== parent.parentReservation.id, "STANDALONE_SESSION_USES_THE_X1_PARENT_RESERVATION");
      ensure(acceptance.n === 0, "STANDALONE_SESSION_HAS_INSTITUTION_ACCEPTANCE");
      ensure(after.original.envelopes === before.original.envelopes && after.episode === before.episode && after.charges.count === before.charges.count && after.peRequests === before.peRequests, "STANDALONE_ACQUISITION_CHANGED_THE_X1_PARENT");
      return { outcome: row.status === "MODEL_READY" ? "PASS" : "FAIL", detail: { predicate: row.status === "MODEL_READY" ? "STANDALONE_CHECKED_MODEL_READY" : "STANDALONE_SETTLED_" + row.status, status: row.status, reason: row.reason,
        sessionId, standaloneReservation, parentReservation: parent.parentReservation.id, institutionalProgramRef: row.original_parent_ref?.institutionalProgramRef ?? null, before, after, firstInstitutionalSession: firstSession } };
    } finally { await submitted.handle.portal.stop(); }
  });
  notRun("P0-17", "UNSUPPORTED_MODEL / INCOMPLETE_MODEL rejects", "no owner path makes the stock learner emit an unsupported or incomplete model against the disposable portal and hand-written model artifacts are forbidden; observed only through the P0-11 consumer fallback reason in the default mode run");
  notRun("P0-18", "PRIVATE_REPLAY reject", "the disposable portal has no private-source replay surface; the learner refusal is not reachable on this fixture");
  notRun("P0-19", "S6_UNKNOWN reject", "no UNKNOWN S6 obligation exists on the original Work: w0-native-11 resolved the lost request to VERIFIED by independent observation");
  const tallyReject = results.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] ?? 0) + 1 }), {});
  record("summary", { tally: tallyReject, results, tenantId: parent.tenantId, parents: [parent.programId] });
  await sql.end();
  await worker?.stop();
  chmodSync(workerLog, 0o600);
  console.log(JSON.stringify({ event: "Z0_SESSION_DONE", mode: "reject", tally: tallyReject }));
  process.exit(tallyReject.FAIL ? 1 : 0);
}

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
const revokeMode = process.env.FINNOR_Z0_MODE === "revoke";
const TERMINAL = ["MODEL_READY", "FAILED", "BLOCKED", "UNKNOWN", "STALE", "CANCELLED"];
if (!killMode && !revokeMode) {
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
} else if (revokeMode) {
  await runCase("P1-05", "Owner revocation of the application account during acquisition stops the acquisition and only it", async () => {
    const before = await witness(parent);
    const nativeState = async () => ({
      programme: (await q("SELECT status,generation FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.programId]))[0],
      work: (await q("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.workId]))[0],
      others: (await q("SELECT count(*)::int n, md5(coalesce(string_agg(id::text||status,'|' ORDER BY id),'')) digest FROM finnor_os.works WHERE tenant_id=$1 AND id<>$2", [parent.tenantId, parent.workId]))[0],
    });
    const nativeBefore = await nativeState();
    const submitted = await submitInstitutionAcquisition(env, parent, { privateRoot, record }, owner);
    ensure(submitted.response.status === 202, "ACQUIRE_NOT_ACCEPTED_" + submitted.response.status);
    const sessionId = submitted.response.body.sessionId;
    const sessionStatus = async () => (await q("SELECT status,reason FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]))[0];
    const requestCount = async () => (await q("SELECT count(*)::int n FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2", [parent.tenantId, sessionId]))[0].n;
    let reached = false;
    for (let i = 0; i < 12000 && !reached; i++) {
      if (TERMINAL.includes((await sessionStatus())?.status)) break;
      if (await requestCount() >= 2) { reached = true; break; }
      await sleep(50);
    }
    if (!reached) {
      await submitted.handle.portal.stop();
      return { outcome: "NOT_RUN", detail: { reason: "REVOCATION_RACE_NOT_REACHED", session: await sessionStatus() } };
    }
    const accounts = await q("UPDATE finnor_os.application_accounts SET status='disabled' WHERE tenant_id=$1 AND application='x2_portal' AND status<>'disabled' RETURNING id", [parent.tenantId]);
    const [{ t0 }] = await q("SELECT clock_timestamp() t0");
    const revokedAtMs = t0.getTime();
    const requestsAtRevocation = await requestCount();
    ensure(accounts.length > 0, "NO_APPLICATION_ACCOUNT_WAS_REVOKED");
    let final = null;
    for (let i = 0; i < 120; i++) {
      final = await sessionStatus();
      if (TERMINAL.includes(final?.status)) break;
      await sleep(2500);
    }
    await sleep(10000);
    final = await sessionStatus();
    const journalPath = join(submitted.handle.portal.dir, "provider", "journal.ndjson");
    const journal = readFileSync(journalPath, "utf8").trim().split("\n").flatMap(line => JSON.parse(line).events ?? []);
    const portalAfter = journal.filter(event => Date.parse(event.at) > revokedAtMs);
    const newSessions = portalAfter.filter(event => event.type === "session.created");
    const rowsAfter = await q("SELECT id,status,possible_egress,observation_ref IS NOT NULL observed,created_at FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 AND created_at>$3 ORDER BY created_at", [parent.tenantId, sessionId, t0]);
    const ambiguous = await q("SELECT id,status,possible_egress,observation_ref IS NOT NULL observed FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 AND possible_egress ORDER BY created_at", [parent.tenantId, sessionId]);
    const [accepted] = await q("SELECT 1 FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED' LIMIT 1", [parent.tenantId, sessionId]);
    const [chargesAfter] = await q("SELECT count(*) FILTER (WHERE created_at>$3)::int after_revocation, count(*)::int total FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id, t0]).catch(() => [null]);
    const nativeAfter = await nativeState();
    await submitted.handle.portal.stop();
    ensure(TERMINAL.includes(final?.status), "REVOKED_SESSION_DID_NOT_STOP_" + final?.status);
    ensure(final.status !== "MODEL_READY" && !accepted, "REVOKED_ACQUISITION_COMPLETED");
    ensure(rowsAfter.length === 0, `PHYSICAL_REQUEST_CREATED_AFTER_REVOCATION count=${rowsAfter.length}`);
    ensure(newSessions.length === 0, `PORTAL_LOGIN_AFTER_REVOCATION count=${newSessions.length}`);
    ensure(!ambiguous.some(row => row.status === "VERIFIED" && !row.observed), "AMBIGUOUS_REQUEST_RELABELLED_WITHOUT_OBSERVATION");
    ensure(JSON.stringify(nativeAfter) === JSON.stringify(nativeBefore), "UNAFFECTED_WORK_OR_ORIGINAL_PROGRAMME_CHANGED");
    const checked = await invariants(before, sessionId, submitted.handle.portal.dir);
    return { detail: { sessionId, revokedAccounts: accounts.length, revokedAt: t0, requestsAtRevocation, final, rowsAfterRevocation: rowsAfter.length,
      portalEventsAfterRevocation: portalAfter.map(event => event.type), portalLoginsAfterRevocation: newSessions.length, ambiguous, chargesAfter,
      nativeBefore, nativeAfter, externalRevocationClaimed: false, before, ...checked } };
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
  if (revokeMode) return { outcome: "NOT_RUN", detail: { reason: "revoke mode ends its only acquisition by owner revocation; run the default mode for duplicate delivery" } };
  ensure(acquired, "NO_ACQUISITION");
  const before = await witness(parent);
  const again = await owner.operation("application-acquire", acquired.request);
  const after = await witness(parent);
  const sessionId = again.body?.sessionId ?? again.body?.id ?? null;
  ensure(after.sessions === before.sessions && after.charges.count === before.charges.count && after.reservations.count === before.reservations.count, "DUPLICATE_DELIVERY_CHANGED_STATE");
  return { outcome: sessionId === acquired.sessionId ? "PASS" : "FAIL", detail: { status: again.status, sessionId, expected: acquired.sessionId, body: again.body } };
});

/**
 * P0-11 / P0-11b. The original parent holds duty A pending owner approval and duty B executable and undispatched
 * (fixture shape gated-two-supported-and-unresolved). Everything after acceptance goes through the real owner paths:
 * the enqueued original continuation, the HTTP approval route and the owner program-resume operation.
 */
const waitUntil = async (label, ms, probe, every = 2000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await probe(); if (value) return value; if (Date.now() > end) throw Error("TIMEOUT_" + label); await sleep(every); }
};
const confirmAction = async actionId => {
  const [effect] = await q("SELECT semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2", [parent.tenantId, actionId]);
  const response = await owner.call(`/api/actions/${actionId}/confirm`, { ...(effect ? { expectedEffectHash: effect.semantic_hash } : {}), typedConfirmation: true });
  return { status: response.status, body: response.body, hashSent: Boolean(effect) };
};
const actionRow = async actionId => (await q("SELECT a.id::text,a.status,a.payload,a.authority_context,a.created_at,a.plan_revision_id::text,a.work_id::text,e.status effect_status FROM finnor_os.domain_actions a LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id WHERE a.tenant_id=$1 AND a.id=$2", [parent.tenantId, actionId]))[0] ?? null;
const programEvents = async () => q("SELECT e.kind,e.generation,e.created_at,e.body FROM finnor_os.p1_events e WHERE e.tenant_id=$1 AND e.request_id=$2 ORDER BY e.created_at,e.event_id", [parent.tenantId, parent.programId]);
const continuationJobs = async () => q("SELECT id::text,status,created_at,left(coalesce(last_error,''),240) error FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_x1_institution_continuation_v1' AND payload->>'programId'=$2 ORDER BY created_at,id", [parent.tenantId, parent.programId]);
const quiet = async () => (await continuationJobs()).every(job => !["queued", "running"].includes(job.status));
let p011 = null;
await runCase("P0-11", "Original continuation consumes the accepted model for the undispatched duty (or records a direct fallback) and returns to the original Work", async () => {
  if (!acquired) return { outcome: "NOT_RUN", detail: "no accepted model" };
  const [accepted] = await q("SELECT created_at,body->'detail'->'acceptanceRef' acceptance_ref FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED' LIMIT 1", [parent.tenantId, acquired.sessionId]);
  if (!accepted) return { outcome: "NOT_RUN", detail: "the session has no S4 acceptance event, so there is no model to consume" };
  if (!parent.gated) return { outcome: "NOT_RUN", detail: { reason: "ORIGINAL_PARENT_HAS_NO_EXECUTABLE_UNDISPATCHED_DUTY" } };
  const g = parent.gated, A = g.heldActionId, B = g.undispatchedActionId;
  const [headBefore] = await q("SELECT body->'bounds'->>'deadlineAt' deadline FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=(SELECT head_id FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2)", [parent.tenantId, parent.programId]);
  const budgetBefore = await witness(parent);
  const preparationCount = async () => (await q("SELECT count(*)::int n FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND phase='PREPARATION'", [parent.tenantId, parent.parentReservation.id]))[0].n;
  const preparationBefore = await preparationCount();
  // N2/N1: after acceptance the enqueued continuation must leave B undispatched while A still holds the Deal.
  await waitUntil("POST_ACCEPTANCE_CONTINUATION_SETTLED", 180000, async () => (await continuationJobs()).some(job => job.created_at > accepted.created_at && job.status !== "queued" && job.status !== "running") && await quiet());
  const afterAcceptance = { jobs: await continuationJobs(), held: await actionRow(A), undispatched: await actionRow(B) };
  ensure(afterAcceptance.held?.status === "pending", "HELD_DUTY_NOT_PENDING_AFTER_ACCEPTANCE_" + afterAcceptance.held?.status);
  ensure(afterAcceptance.undispatched === null, "UNDISPATCHED_DUTY_DISPATCHED_BEFORE_HELD_DUTY_RESOLVED");
  const steps = { afterAcceptance };
  steps.confirmHeld = await confirmAction(A);
  ensure(steps.confirmHeld.status === 200, `CONFIRM_HELD_ACTION_REFUSED_${steps.confirmHeld.status}:${JSON.stringify(steps.confirmHeld.body).slice(0, 240)}`);
  const settled = async id => { const row = await actionRow(id); return row?.status === "completed" && row.effect_status === "verified" ? row : null; };
  steps.heldSettled = await waitUntil("HELD_ACTION_COMPLETED_AND_VERIFIED", 240000, () => settled(A));
  const resume = async label => {
    const before = (await continuationJobs()).length;
    const response = await owner.operation("program-resume", { programId: parent.programId });
    ensure(response.status === 202, `PROGRAM_RESUME_${label}_REFUSED_${response.status}:${JSON.stringify(response.body).slice(0, 200)}`);
    await waitUntil("CONTINUATION_" + label, 240000, async () => (await continuationJobs()).length > before && await quiet());
    return { status: response.status, jobs: (await continuationJobs()).slice(before) };
  };
  steps.resumeAfterHeld = await resume("AFTER_HELD");
  steps.undispatchedDispatched = await waitUntil("UNDISPATCHED_DUTY_DISPATCHED", 120000, () => actionRow(B));
  const dispatched = steps.undispatchedDispatched;
  const events = await programEvents();
  const original = events.filter(row => /^P1_ORIGINAL_APPLICATION_/.test(row.kind));
  const materialized = original.find(row => row.kind === "P1_ORIGINAL_APPLICATION_MODEL_MATERIALIZED");
  const consumed = original.find(row => row.kind === "P1_ORIGINAL_APPLICATION_MODEL_CONSUMED");
  const fallback = original.find(row => row.kind === "P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK");
  const authority = dispatched.authority_context ?? {};
  const bound = Boolean(authority.applicationModelUseRef && authority.applicationModelAcceptanceRef && authority.applicationModelInputDigest);
  ensure(Date.parse(dispatched.created_at) > Date.parse(accepted.created_at), "UNDISPATCHED_DUTY_ACTION_PREDATES_ACCEPTANCE");
  ensure(dispatched.work_id === parent.workId, "ACTION_NOT_ON_ORIGINAL_WORK");
  const acceptanceId = accepted.acceptance_ref?.id;
  if (bound) {
    ensure(authority.applicationModelAcceptanceRef.id === acceptanceId, "ACTION_BOUND_TO_A_DIFFERENT_ACCEPTANCE");
    ensure(materialized && consumed && consumed.body.canonicalActionId === B && consumed.body.modelUseRef?.id === authority.applicationModelUseRef.id, "CONSUMED_EVENT_DOES_NOT_NAME_THE_ACTION");
  } else {
    ensure(fallback && fallback.body.acceptanceRef?.id === acceptanceId, "NEITHER_MODEL_USE_NOR_FALLBACK_FOR_THIS_ACCEPTANCE");
  }
  const traced = materialized ?? fallback;
  const chargeRefId = traced.body.chargeRef?.id ?? null;
  const preparationAfter = await preparationCount();
  ensure(preparationAfter === preparationBefore + 1, `PREPARATION_CHARGE_COUNT_ON_ORIGINAL_RESERVATION_${preparationBefore}_TO_${preparationAfter}`);
  const [charge] = await q("SELECT to_jsonb(c) row FROM finnor_os.s5_governed_resource_charges c WHERE c.tenant_id=$1 AND c.reservation_id=$2 AND c.phase='PREPARATION' AND to_jsonb(c)::text LIKE '%'||$3||'%'", [parent.tenantId, parent.parentReservation.id, chargeRefId ?? "\u0000"]);
  steps.confirmUndispatched = await confirmAction(B);
  ensure(steps.confirmUndispatched.status === 200, `CONFIRM_CONSUMING_ACTION_REFUSED_${steps.confirmUndispatched.status}:${JSON.stringify(steps.confirmUndispatched.body).slice(0, 240)}`);
  steps.undispatchedSettled = await waitUntil("UNDISPATCHED_ACTION_COMPLETED_AND_VERIFIED", 240000, () => settled(B));
  steps.resumeAfterUndispatched = await resume("AFTER_UNDISPATCHED");
  const finalHead = await waitUntil("BOTH_SUPPORTED_DUTIES_OBSERVED", 120000, async () => {
    const [head] = await q("SELECT jsonb_array_length(body->'observedPostconditions') observed, body->'bounds'->>'deadlineAt' deadline, body->>'status' head_status FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=(SELECT head_id FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2)", [parent.tenantId, parent.programId]);
    return head.observed >= 2 ? head : null;
  }, 3000);
  const [programme] = await q("SELECT status,failure FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.programId]);
  // N8: independent canonical read of the business row and comparison with values derived from the fixture inputs.
  const [workstream] = await q("SELECT id::text FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND deal_id=$2 AND external_id=$3", [parent.tenantId, parent.dealId, g.workstreamExternalId]);
  const [recipient] = await q("SELECT id::text FROM finnor_os.pe_deal_parties WHERE tenant_id=$1 AND deal_id=$2 AND external_id=$3", [parent.tenantId, parent.dealId, g.recipientExternalId]);
  const [peRow] = await q("SELECT to_jsonb(r) row FROM finnor_os.pe_requests r WHERE r.tenant_id=$1 AND r.id=$2", [parent.tenantId, B]);
  const expectedPayload = { dealId: parent.dealId, requestText: g.undispatchedRequestText, requiresAcceptedDeliverable: true, workstreamId: workstream?.id, requestedFromDealPartyId: recipient?.id };
  const mismatched = Object.entries(expectedPayload).filter(([key, value]) => dispatched.payload?.[key] !== value).map(([key]) => key);
  ensure(mismatched.length === 0, "ACTION_PAYLOAD_DIFFERS_FROM_FIXTURE_INPUTS:" + mismatched.join(","));
  ensure(Date.parse(dispatched.payload.dueAt) === Date.parse(parent.dutyDeadlineAt), "ACTION_DUE_DATE_DIFFERS_FROM_ORIGINAL_DEADLINE");
  ensure(peRow && JSON.stringify(peRow.row).includes(g.undispatchedRequestText), "INDEPENDENT_PE_REQUEST_ROW_MISSING_OR_DIFFERENT");
  ensure(Date.parse(finalHead.deadline) === Date.parse(headBefore.deadline) && Date.parse(finalHead.deadline) === Date.parse(parent.programmeDeadlineAt), "ORIGINAL_DEADLINE_CHANGED");
  const budgetAfter = await witness(parent);
  ensure(budgetAfter.reservations.count === budgetBefore.reservations.count && budgetAfter.original.envelopes === budgetBefore.original.envelopes && budgetAfter.episode === budgetBefore.episode, "NEW_PARENT_OR_ENVELOPE_CHANGED");
  const [envelope] = await q("SELECT (SELECT sum(v::numeric) FROM jsonb_array_elements_text(e->'quantities') v)::text limit_units, e->>'resourceId' resource_id FROM finnor_os.s5_reservations r, jsonb_array_elements(r.envelopes) e WHERE r.tenant_id=$1 AND r.reservation_id=$2 AND e->>'unit'='request'", [parent.tenantId, parent.parentReservation.id]);
  const [spent] = await q("SELECT coalesce(sum(units),0)::text used FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND resource_id=$3 AND unit='request'", [parent.tenantId, parent.parentReservation.id, envelope.resource_id]);
  ensure(BigInt(spent.used) <= BigInt(envelope.limit_units), `ORIGINAL_ENVELOPE_EXCEEDED used=${spent.used} limit=${envelope.limit_units}`);
  const checked = { original: { limit: envelope.limit_units, used: spent.used }, preparationCharges: { before: preparationBefore, after: preparationAfter } };
  p011 = { path: bound ? "MODEL_USED" : "DIRECT_FALLBACK", fallbackReason: fallback?.body.reason ?? null };
  return { detail: { path: p011.path, fallbackReason: p011.fallbackReason, acceptanceRef: accepted.acceptance_ref, steps, originalEvents: original.map(row => ({ kind: row.kind, at: row.created_at })),
    authorityBinding: { bound, modelUseRef: authority.applicationModelUseRef ?? null, acceptanceRef: authority.applicationModelAcceptanceRef ?? null, inputDigest: authority.applicationModelInputDigest ?? null },
    chargeRefInS5Row: Boolean(charge), chargeRefId, finalHead, programme, expectedPayload, observedPayload: dispatched.payload, peRowDigest: sha(peRow.row), budgetBefore, budgetAfter, invariants: checked } };
});
await runCase("P0-11b", "The learned model computed the native argument of the original duty (useful result)", async () => {
  if (!p011) return { outcome: "NOT_RUN", detail: { reason: "P0-11 did not complete" } };
  if (p011.path !== "MODEL_USED") return { outcome: "NOT_RUN", detail: { reason: "ORIGINAL_P1_RECORDED_DIRECT_FALLBACK_" + p011.fallbackReason, note: "the accepted model could not represent the complete frozen owner argument; the original completed through its own direct path" } };
  return { detail: { path: p011.path } };
});

await runCase("P1-02", "Cancel after MODEL_READY returns to the original (direct fallback) without a new allowance", async () => {
  if (revokeMode) return { outcome: "NOT_RUN", detail: { reason: "revoke mode has no MODEL_READY session" } };
  ensure(acquired, "NO_ACQUISITION");
  const [ready] = await q("SELECT status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, acquired.sessionId]);
  if (ready?.status !== "MODEL_READY") return { outcome: "NOT_RUN", detail: { reason: "session is not MODEL_READY (it settled as " + ready?.status + ")" } };
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
if (!revokeMode) notRun("P1-05", "Owner revocation during acquisition", "revoke mode run only (FINNOR_Z0_MODE=revoke); it needs its own acquisition on a fresh original parent");
for (const [id, title] of [["P2-01", "Mounted reload during acquisition"], ["P2-02", "Principal switch"], ["P2-03", "Token refresh and logout"], ["P2-04", "Offline during mounted acquisition"]])
  notRun(id, title, "mounted browser phase not implemented in this scenario revision");
notRun("P3-01", "Wire z0/run-native-e2e.mjs", "that driver requires separately delivered authority and oracle; not wired");

/**
 * Accounting read-back and meter receipt (failure model section 13). The authenticated API view and the database are
 * two independent readings of the same S5 charges; the receipt lists every cost with its provenance and every meter gap.
 */
await runCase("P0-20", "S5/S6/S7 original accounting read back through the API and the database; meter receipt emitted", async () => {
  const [root] = await q("SELECT id::text,status,reason,request->'root' root,deadline_at FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2 AND id=parent_id ORDER BY created_at LIMIT 1", [parent.tenantId, parent.workId]);
  if (!root) return { outcome: "NOT_RUN", detail: { reason: "no root application session exists on the original Work in this mode" } };
  const findKey = (value, key) => {
    if (!value || typeof value !== "object") return null;
    if (value[key] && typeof value[key] === "object") return value[key];
    for (const item of Object.values(value)) { const hit = findKey(item, key); if (hit) return hit; }
    return null;
  };
  const projection = await owner.operation("application-projection", { root: root.root, workId: parent.workId });
  const apiBudget = projection.status === 200 ? findKey(projection.body, "budget") : null;
  const [reservation] = await q("SELECT reservation_id,status,envelopes,revision FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const charges = await q("SELECT charge_key,phase,resource_id,unit,units::text units,body->'costs' costs,body->>'qualification' qualification FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY created_at,charge_key", [parent.tenantId, parent.parentReservation.id]);
  const totals = reservation.envelopes.map(envelope => {
    const limit = envelope.quantities.reduce((sum, value) => sum + BigInt(value), 0n);
    const used = charges.filter(row => row.resource_id === envelope.resourceId && row.unit === envelope.unit).reduce((sum, row) => sum + BigInt(row.units), 0n);
    return { resourceId: envelope.resourceId, unit: envelope.unit, limit: limit.toString(), used: used.toString(), remaining: (limit - used).toString(), overdrawn: used > limit };
  });
  const consumption = await q("SELECT status,count(*)::int n FROM finnor_os.s5_consumption_states WHERE tenant_id=$1 GROUP BY 1 ORDER BY 1", [parent.tenantId]);
  const reservations = await q("SELECT status,count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1 GROUP BY 1 ORDER BY 1", [parent.tenantId]);
  const s7 = await q("SELECT kind,count(*)::int n FROM finnor_os.s7_economic_records WHERE tenant_id=$1 GROUP BY 1 ORDER BY 1", [parent.tenantId]);
  const requests = await q("SELECT status,possible_egress,observation_ref IS NOT NULL observed,count(*)::int n FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id IN (SELECT id FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2) GROUP BY 1,2,3 ORDER BY 1,2,3", [parent.tenantId, parent.workId]);
  const attempts = await q("SELECT j.type,a.outcome,a.failure_kind,extract(epoch FROM (a.finished_at-a.started_at))::numeric(12,3)::text seconds FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id WHERE j.tenant_id=$1 AND (j.payload->>'sessionId'=$2 OR j.payload->>'programId'=$3) ORDER BY a.started_at", [parent.tenantId, root.id, parent.programId]);
  const unknownObligations = consumption.filter(row => row.status === "UNKNOWN_OUTCOME");
  const gaps = [];
  if (!apiBudget) gaps.push("API_BUDGET_PROJECTION_UNAVAILABLE");
  if (apiBudget?.monetaryCostStatus === "UNKNOWN" || apiBudget?.monetaryCost === null) gaps.push("MONEY_UNKNOWN_NO_BILLING_METER");
  if (charges.some(row => row.costs?.status === "UNMETERED")) gaps.push("S5_CHARGES_ARE_CONSERVATIVE_OCCUPATION_UNMETERED_NOT_BILLING");
  if (!s7.some(row => ["COST", "COMPUTE"].includes(row.kind))) gaps.push("NO_S7_COST_OR_COMPUTE_RECORD_FOR_THE_ORIGINAL_WORK");
  gaps.push("WORKER_CPU_MEMORY_AND_PROVIDER_COSTS_NOT_OBSERVED (only queue delivery wall-clock is measured)");
  const receipt = { schema: "finnor.project-z.z0-meter-receipt.v1", originalWorkId: parent.workId, programId: parent.programId, parentReservation: parent.parentReservation,
    sessionId: root.id, sessionStatus: root.status, apiBudget: apiBudget ? { ...apiBudget } : null, databaseAccounting: { reservation: { status: reservation.status, revision: reservation.revision }, totals, chargeCount: charges.length },
    charges: charges.map(row => ({ chargeKey: row.charge_key, phase: row.phase, resourceId: row.resource_id, unit: row.unit, units: row.units, costs: row.costs, qualification: row.qualification, provenance: "s5_governed_resource_charges" })),
    consumptionStates: consumption, reservationsByStatus: reservations, s7Records: s7, physicalInteractions: requests, deliveryAttempts: attempts.map(row => ({ ...row, provenance: "job_delivery_attempts (queue owner)" })),
    unknownS6Obligations: unknownObligations, meterGaps: gaps, money: "UNKNOWN", releaseSufficient: false };
  record("meter-receipt", receipt);
  ensure(apiBudget, "API_ACCOUNTING_PROJECTION_UNAVAILABLE_" + projection.status);
  ensure(apiBudget.newReservation === false && apiBudget.releaseGranted === false, "PROJECTION_REPORTS_NEW_RESERVATION_OR_RELEASE");
  ensure(JSON.stringify(apiBudget.originalReservationRef) === JSON.stringify(parent.parentReservation), "PROJECTION_NOT_THE_ORIGINAL_RESERVATION");
  for (const line of totals) {
    const api = apiBudget.resources?.find(item => item.resourceId === line.resourceId && item.unit === line.unit);
    ensure(api && api.limit === line.limit && api.used === line.used && api.remaining === line.remaining, `API_DB_ACCOUNTING_DIFFER_${line.resourceId}`);
    ensure(!line.overdrawn, "ORIGINAL_RESOURCE_OVERDRAWN_" + line.resourceId);
  }
  return { detail: { totals, gaps, charges: charges.length } };
});

const tally = results.reduce((acc, row) => ({ ...acc, [row.outcome]: (acc[row.outcome] ?? 0) + 1 }), {});
record("summary", { tally, results, tenantId: parent.tenantId, parents: [parent.programId, second?.programId ?? null] });
await sql.end();
await worker?.stop();
chmodSync(workerLog, 0o600);
console.log(JSON.stringify({ event: "Z0_SESSION_DONE", tally }));
process.exit(tally.FAIL ? 1 : 0);
