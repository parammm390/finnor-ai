// Real mounted submit -> physical queue -> independent original-arena check ->
// concrete S4 prefix -> expiry/recovery -> retained finite memory. Never seeds,
// migrates, creates Auth/grants, starts listeners or dispatches effects.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const output = arg("--output"), authorization = arg("--authorization");
if (!output || !isAbsolute(output)) throw Error("Absolute immutable --output required");
await mkdir(output, { recursive: false, mode: 0o700 });
const canonical = value => value instanceof Date ? JSON.stringify(value.toISOString())
  : value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const bytesDigest = value => createHash("sha256").update(value).digest("hex");
const report = { schema: "finnor.z3.native-correction-e2e.v2", status: "NOT_RUN", cases: [], failures: [],
  sourceNative: "NOT_RUN", installedNative: "NOT_RUN", protectedAdmission: "NOT_RUN",
  operationalQualification: "NOT_RUN", financialQualification: "NOT_RUN", money: null,
  unknownCostsAreNotZero: true };
let browser, database, worker;
async function stopWorker(signal = "SIGTERM") {
  if (!worker) return;
  const owned = worker; worker = undefined;
  const escalation = setTimeout(() => owned.child.kill("SIGKILL"), 10000);
  let observed;
  try {
    if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill(signal);
    observed = await owned.closed;
  } finally { clearTimeout(escalation); }
  report.cases.push({ kind: "OWNED_WORKER_CLOSED", pid: owned.child.pid, ...observed });
  return observed;
}
async function main() {
  if (!authorization || !isAbsolute(authorization)) {
    report.failures.push("EXPLICIT_EXISTING_DB_AUTH_OWNED_WORKER_AUTHORIZATION_NOT_DELIVERED");
    process.exitCode = 78; return;
  }
  const permission = JSON.parse(await readFile(authorization, "utf8"));
  if (permission.schema !== "finnor.z3.existing-disposable-authorization.v2"
    || permission.coordinatorAuthorized !== true || permission.provisioningAllowed !== false
    || permission.effectsAllowed !== false || permission.workerTerminationAllowed !== true
    || permission.workerSuspensionAllowed !== true
    || permission.crossTenantObservationAllowed !== true || !permission.foreignOwner
    || permission.requestHistoryExhaustionAllowed !== true
    || permission.authProjectDisposable !== true || permission.frontendApiAuthProjectSame !== true
    || permission.foreignOwner.tenantId === permission.tenantId
    || permission.foreignOwner.principalId === permission.principalId
    || permission.listenersAlreadyOwned !== true || permission.readOnlyDatabaseObservationAllowed !== true
    || permission.allZ3JobsOwned !== true || !Array.isArray(permission.cases) || permission.cases.length !== 3
    || new Set(permission.cases.map(c => c.workId)).size !== 3
    || ![permission.repository, permission.workerEntry, permission.producerBundle, permission.checkerSource].every(p => p && isAbsolute(p))
    || resolve(permission.workerEntry) !== join(resolve(permission.repository), "finnor-os/scripts/project-z/z3/worker-entry.mts")
    || !/^[a-f0-9]{64}$/.test(permission.runtimeDigest)) throw Error("EXACT_CURRENT_SOURCE_COORDINATOR_AUTHORIZATION_REQUIRED");
  const dbValue = process.env.FINNOR_Z3_DISPOSABLE_DATABASE_URL;
  if (!dbValue || process.env.AUTH_DEV_BYPASS || process.env.NODE_ENV === "production"
    || process.env.FINNOR_ENVIRONMENT !== "staging" || !process.env.TEST_OWNER_EMAIL || !process.env.TEST_OWNER_PASSWORD
    || !process.env.TEST_FOREIGN_OWNER_EMAIL || !process.env.TEST_FOREIGN_OWNER_PASSWORD) {
    throw Error("REAL_DISPOSABLE_AUTH_DATABASE_NO_BYPASS_REQUIRED");
  }
  const dbUrl = new URL(dbValue), target = new URL(permission.frontend);
  if (!["postgres:", "postgresql:"].includes(dbUrl.protocol)
    || ![dbUrl, target].every(u => ["127.0.0.1", "localhost"].includes(u.hostname))
    || target.protocol !== "http:" || target.username || target.password || target.pathname !== "/"
    || dbUrl.port !== String(permission.databasePort) || dbUrl.pathname !== "/" + permission.databaseName) {
    throw Error("EXPLICIT_EXISTING_OWNED_LOOPBACK_TARGET_REQUIRED");
  }
  const checkerBytes = await readFile(permission.checkerSource), producerBytes = await readFile(permission.producerBundle);
  const adapterBytes = await readFile(join(dirname(permission.checkerSource), "nonconflicting-checker.py"));
  if (bytesDigest(checkerBytes) !== "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e"
    || bytesDigest(producerBytes) !== "0925012e866e2195bae5ae2173c5863fe8b9294ac7ce6966d0100e98e0ec4793"
    || bytesDigest(adapterBytes) !== "a7e1a84fdd1b8116e97b97d98afa9fd7913ae41282390ab3f3176da8696ba2b9"
    || bytesDigest(await readFile("/usr/bin/python3.12")) !== "e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f") {
    throw Error("APPROVED_INDEPENDENT_CHECKER_OR_PRODUCER_REQUIRED");
  }
  const checkerProgram = [
    "import base64 as _z3_b64, types as _z3_types",
    "_original_checker = _z3_types.ModuleType('finnor_z3_original_checker')",
    `exec(compile(_z3_b64.b64decode("${checkerBytes.toString("base64")}"), "<approved-original-checker>", "exec"), _original_checker.__dict__)`,
    adapterBytes.toString("utf8"),
  ].join("\n");
  const require = createRequire(join(permission.repository, "package.json"));
  const backendRequire = createRequire(join(permission.repository, "finnor-os/package.json"));
  database = new (backendRequire("pg").Client)({ connectionString: dbValue, connectionTimeoutMillis: 10000,
    statement_timeout: 10000, application_name: "z3-authorized-readonly-e2e" });
  await database.connect();
  const role = (await database.query("SELECT r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user")).rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) throw Error("NON_BYPASS_APP_DATABASE_ROLE_REQUIRED");
  browser = await require("@playwright/test").chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: target.origin });
  const page = await context.newPage();
  await page.goto("/centropy/login");
  await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL);
  await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "What needs to move forward?" }).waitFor();
  const meResponse = await context.request.get("/api/centropy/me"), me = await meResponse.json();
  if (meResponse.status() !== 200 || me.role !== "owner" || me.userId !== permission.principalId
    || me.tenantId !== permission.tenantId || me.employeeId && me.employeeId !== me.userId) throw Error("EXACT_REAL_NATIVE_OWNER_REQUIRED");
  const post = async (operation, body, expected = 202) => {
    const response = await context.request.post("/api/centropy/company-brain/" + operation, { data: body });
    if (response.status() !== expected) throw Error("NATIVE_HTTP_STATUS_" + response.status());
    return response.json();
  };
  const read = sessionId => post("viability-read", { sessionId, root: null }, 200);
  const snapshot = async (workId, sessionId) => {
    await database.query("BEGIN READ ONLY");
    try {
      await database.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [me.tenantId, me.userId]);
      const session = (await database.query(`SELECT * FROM finnor_os.z3_viability_sessions
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND work_id=$4`, [me.tenantId, me.userId, sessionId, workId])).rows[0];
      const input = (await database.query(`SELECT i.id::text,i.instruction_text FROM finnor_os.work_inputs i
        WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [me.tenantId, workId])).rows[0];
      const parents = (await database.query(`SELECT r.id,r.head_id,h.body,h.digest,e.attempts_used,e.steps_used,e.max_attempts,e.max_steps
        FROM finnor_os.p1_requests r JOIN finnor_os.p1_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id
        LEFT JOIN finnor_os.p1_programs h ON h.tenant_id=r.tenant_id AND h.id=r.head_id
        WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.work_input_id=$4
          AND r.request->>'kind'='institution_responsibility_v1' AND r.status IN('WAITING','RUNNING','QUEUED','PARTIAL')`,
        [me.tenantId, me.userId, workId, input?.id])).rows;
      const jobs = (await database.query(`SELECT j.id,j.status,j.claim_fence,a.id delivery_id,a.outcome,
        a.claim_fence delivery_fence,a.finished_at,j.lease_expires_at
        FROM finnor_os.jobs j LEFT JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id
        WHERE j.tenant_id=$1 AND j.payload->>'sessionId'=$2 AND j.type IN('run_z3_viability_synthesis_v1','run_z3_viability_recovery_v1')
        ORDER BY j.created_at,a.started_at`, [me.tenantId, sessionId])).rows;
      const prefixes = (await database.query(`SELECT body FROM finnor_os.z3_viability_events
        WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id`,
        [me.tenantId, me.userId, sessionId])).rows.map(r => r.body);
      const workObservations = (await database.query(`SELECT payload FROM finnor_os.work_events
        WHERE tenant_id=$1 AND work_id=$2 AND event_type='viability_native_prefix_observed' ORDER BY seq`,
        [me.tenantId, workId])).rows.map(r => r.payload);
      const charges = session ? (await database.query(`SELECT body FROM finnor_os.s5_governed_resource_charges
        WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 AND phase='CONTROL' ORDER BY created_at,charge_key`,
        [me.tenantId, me.userId, session.reservation_ref.id])).rows.map(r => r.body) : [];
      const effects = (await database.query(`SELECT id::text,status FROM finnor_os.business_effects
        WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated') ORDER BY id`, [me.tenantId])).rows;
      const requestsCount = Number((await database.query(`SELECT count(*)::int n FROM finnor_os.z3_viability_requests r
        JOIN finnor_os.z3_viability_sessions s ON s.tenant_id=r.tenant_id AND s.id=r.session_id
        WHERE r.tenant_id=$1 AND r.principal_id=$2 AND s.work_id=$3`,
        [me.tenantId, me.userId, workId])).rows[0]?.n);
      await database.query("COMMIT");
      if (!session || !input || parents.length !== 1) throw Error("EXACT_DURABLE_ORIGINAL_NATIVE_LINEAGE_REQUIRED");
      return { session, input, parent: parents[0], jobs, prefixes, workObservations, charges, effects, requestsCount };
    } catch (error) { await database.query("ROLLBACK"); throw error; }
  };
  const start = point => {
    // No tsx CLI proxy: this PID is the actual source-loaded Node worker.
    const child = spawn(process.execPath, ["--max-old-space-size=1536", "--import",
      join(permission.repository, "finnor-os/node_modules/tsx/dist/loader.mjs"), permission.workerEntry], {
      cwd: join(permission.repository, "finnor-os"), stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "development", SECRETS_PROVIDER: "env",
        FINNOR_ENVIRONMENT: "staging", DATABASE_URL: dbValue, FINNOR_Z3_DISPOSABLE_DATABASE_URL: dbValue,
        FINNOR_Z3_DISPOSABLE_RECOVERY: "1", FINNOR_Z3_FAULT_POINT: point ?? "",
        FINNOR_Z3_AUTHORIZED_SOURCE: permission.runtimeDigest,
        FINNOR_Z3_PRODUCER_BUNDLE: permission.producerBundle, FINNOR_Z3_CHECKER_SOURCE: permission.checkerSource },
    });
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    const closed = new Promise(resolve => child.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnFailed })));
    worker = { child, closed }; return worker;
  };
  const finite = async (operation, condition, cap = 90000) => {
    const end = Date.now() + cap;
    do { const result = await operation(); if (condition(result)) return result; await page.waitForTimeout(250); } while (Date.now() < end);
    throw Error("FINITE_NATIVE_OBSERVATION_DEADLINE");
  };
  const independentCheck = async state => {
    const original = JSON.parse(state.input.instruction_text).arena;
    if (digest(original) !== state.session.arena_digest || state.session.work_input_id !== state.input.id
      || state.session.binding.codeDigest !== permission.runtimeDigest) throw Error("ORIGINAL_INPUT_OR_SOURCE_BINDING_CHANGED");
    const child = spawn("/usr/bin/python3.12", ["-I", "-c", checkerProgram, "--batch"],
      { stdio: ["pipe", "pipe", "ignore"], env: { LANG: "C.UTF-8" } });
    const observed = new Promise((resolve, reject) => {
      const chunks = []; let total = 0, failure = false;
      const timer = setTimeout(() => { failure = true; child.kill("SIGKILL"); },
        Math.max(1, Math.min(300000, Date.parse(state.session.binding.deadlineAt) - Date.now())));
      child.once("error", () => { failure = true; child.kill("SIGKILL"); });
      child.stdin.on("error", () => { failure = true; child.kill("SIGKILL"); });
      child.stdout.on("data", b => { total += b.length; if (total > 1048576) { failure = true; child.kill("SIGKILL"); } else chunks.push(b); });
      child.once("close", (code, signal) => { clearTimeout(timer); if (failure || code !== 0 || signal) reject(Error("INDEPENDENT_ORIGINAL_CHECK_PROCESS_FAILED"));
        else { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Error("INDEPENDENT_CHECK_PROTOCOL")); } } });
    });
    child.stdin.end(JSON.stringify({ arena: original, binding: state.session.binding, candidate: state.session.candidate }) + "\n");
    const check = await observed;
    if (check.status !== "VIABLE" || check.safety !== true || check.liveness !== true || check.nonconflicting !== true
      || check.originalAssumptionsSatisfiable !== true) throw Error("INDEPENDENT_ORIGINAL_EXPECTED_VALUE_FAILED");
    return { digest: digest(check), status: check.status };
  };
  function verifyCursor(state) {
    const arena = state.session.arena, strategy = state.session.candidate.strategy;
    let vertex = arena.initial[0], memory = strategy.initial[0], operations = 0;
    const goals = { READINESS: 0, RECONCILE: 0 };
    for (const prefix of state.prefixes) {
      for (const transition of prefix.transitions) {
        const index = arena.states.findIndex(s => s.id === vertex), edge = strategy.actions[memory][index];
        if (transition.from.stateId !== vertex || transition.from.memory !== memory || transition.controllerEdge !== edge) throw Error("NATIVE_CONTROLLER_EDGE_NOT_ORIGINAL");
        memory = strategy.updates[memory][index]; vertex = arena.edges[edge].to;
        const operation = arena.edges[edge].action;
        const expected = operation === "READINESS"
          ? state.parent.body && ["WAITING", "PARTIAL"].includes(state.parent.body.status) ? "READY" : "NOT_READY"
          : state.effects.length ? "UNKNOWN_RETAINED" : "CLEAR";
        if (transition.environment.stateId !== vertex || transition.environment.memory !== memory || transition.outcome !== expected) throw Error("NATIVE_ENVIRONMENT_NOT_INDEPENDENTLY_OBSERVED");
        const actual = arena.edges.findIndex(e => e.from === vertex && e.action === expected);
        if (actual !== transition.environmentEdge) throw Error("NATIVE_OBSERVATION_EDGE_NOT_ORIGINAL");
        const environmentIndex = arena.states.findIndex(s => s.id === vertex);
        memory = strategy.updates[memory][environmentIndex]; vertex = arena.edges[actual].to; operations++; goals[operation]++;
        if (transition.to.stateId !== vertex || transition.to.memory !== memory) throw Error("NATIVE_MEMORY_RESET_OR_UPDATE_CHANGED");
      }
      if (prefix.cursor.stateId !== vertex || prefix.cursor.memory !== memory || prefix.cursor.operations !== operations
        || digest(prefix.cursor.goalVisits) !== digest(goals) || digest(prefix.cursor) !== prefix.cursorDigest
        || !state.workObservations.some(w => digest(w) === digest(prefix))) throw Error("CANONICAL_WORK_OR_DURABLE_CURSOR_NOT_OBSERVED");
    }
    if (goals.READINESS < 2 || goals.RECONCILE < 2 || operations < 8) throw Error("TWO_NATIVE_RECURRING_PREFIXES_REQUIRED");
    return { vertex, memory, operations, goals };
  }
  for (const [index, point] of ["CLAIM", "STRATEGY", "OBSERVATION"].entries()) {
    const input = permission.cases[index];
    if (!/^[a-f0-9-]{36}$/i.test(input.workId) || !input.mountedWorkPath?.startsWith("/centropy")) throw Error("REAL_MOUNTED_ORIGINAL_WORK_REQUIRED");
    await page.goto(input.mountedWorkPath);
    const panel = page.locator(`[data-viability-work="${input.workId}"]`);
    const submission = page.waitForResponse(r => r.url().endsWith("/company-brain/viability-submit") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Check original Work strategy", exact: true }).click();
    const submitted = await submission, submitBody = submitted.request().postDataJSON(), intake = await submitted.json();
    if (submitted.status() !== 202 || submitBody.workId !== input.workId
      || Object.keys(submitBody).sort().join(",") !== "idempotencyKey,workId") throw Error("MOUNTED_ORIGINAL_WORK_SUBMIT_CONTRACT_FAILED");
    const before = await snapshot(input.workId, intake.sessionId);
    report.cases.push({ kind: "ORIGINAL_CASE_STARTED", point, workId: input.workId, sessionId: intake.sessionId,
      originalDeadlineAt: before.session.binding.deadlineAt, attemptsBefore: before.parent.attempts_used,
      stepsBefore: before.parent.steps_used, effectsRetainedDigest: digest(before.effects) });
    if (Date.parse(before.session.binding.deadlineAt) - Date.now() < 180000
      || before.parent.max_attempts - before.parent.attempts_used < 3
      || before.parent.max_steps - before.parent.steps_used < 11) throw Error("ORIGINAL_REMAINING_ALLOWANCE_INSUFFICIENT_FOR_FINITE_PROOF_NO_RENEWAL");
    const immutable = digest([before.session.work_id, before.session.work_input_id, before.session.original_parent_id,
      before.session.arena_digest, before.session.binding_digest, before.session.reservation_ref, before.session.deadline_at, before.session.obligation_refs]);
    const interrupted = start(point);
    const boundary = await Promise.race([new Promise(resolve => interrupted.child.on("message", m => {
      if (m?.kind === "Z3_DURABLE_BOUNDARY" && m.point === point && m.sessionId === intake.sessionId
        && m.pid === interrupted.child.pid) resolve(m);
    })), interrupted.closed.then(() => { throw Error("WORKER_CLOSED_BEFORE_BOUNDARY"); }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(Error("DURABLE_BOUNDARY_DEADLINE")), 90000); t.unref(); })]);
    let leaseExpiryRefusal = null;
    if (point === "CLAIM") {
      const preExpiry = await snapshot(input.workId, intake.sessionId);
      const refusal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("LIVE_EXPIRED_WORKER_REFUSAL_NOT_OBSERVED")), 90000);
        interrupted.child.on("message", m => {
          if (m?.kind === "Z3_DELIVERY_REFUSAL_OBSERVED" && m.pid === interrupted.child.pid
            && m.sessionId === intake.sessionId) { clearTimeout(timer); resolve(m); }
        });
      });
      void refusal.catch(() => undefined);
      if (!interrupted.child.kill("SIGSTOP")) throw Error("OWNED_WORKER_SUSPEND_FAILED");
      await finite(() => read(intake.sessionId), v => v.pendingJobs === 0);
      if (!interrupted.child.kill("SIGCONT")) throw Error("OWNED_WORKER_RESUME_FAILED");
      leaseExpiryRefusal = await refusal;
      if (!["Z3_DELIVERY_LEASE_EXPIRED", "Z3_ACTUAL_DURABLE_DELIVERY_EXPIRED_OR_CHANGED"]
        .includes(leaseExpiryRefusal.reason)) throw Error("LIVE_EXPIRED_WORKER_DID_NOT_REFUSE_PHYSICAL_LEASE");
      const refused = await snapshot(input.workId, intake.sessionId);
      if (digest(preExpiry.session) !== digest(refused.session) || refused.prefixes.length
        || refused.session.s4_consumed) throw Error("EXPIRED_WORKER_WROTE_WITHOUT_SUCCESSOR");
    }
    const killed = await stopWorker("SIGKILL");
    if (killed.signal !== "SIGKILL") throw Error("PHYSICAL_WORKER_KILL_NOT_OBSERVED");
    await finite(() => read(intake.sessionId), v => v.pendingJobs === 0);
    const expired = await snapshot(input.workId, intake.sessionId);
    if (expired.prefixes.length || expired.session.s4_consumed || expired.session.status === "VIABLE") throw Error("EXPIRED_DELIVERY_PUBLISHED_WITHOUT_SUCCESSOR");
    start();
    await post("viability-recover", { sessionId: intake.sessionId, root: null, idempotencyKey: "recovery:" + randomUUID() });
    await finite(() => read(intake.sessionId), v => v.pendingJobs === 0 && v.status === "VIABLE" && v.s4Consumed);
    const firstPrefix = await snapshot(input.workId, intake.sessionId);
    await page.reload();
    const continuation = page.waitForResponse(r => r.url().endsWith("/company-brain/viability-recover") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Continue bounded readiness", exact: true }).click();
    const continued = await continuation, continuationBody = continued.request().postDataJSON();
    if (continued.status() !== 202) throw Error("MOUNTED_BOUNDED_CONTINUATION_FAILED");
    await finite(() => read(intake.sessionId), v => v.pendingJobs === 0 && v.nativeActions > firstPrefix.prefixes.at(-1).cursor.operations);
    const after = await snapshot(input.workId, intake.sessionId), checked = await independentCheck(after), cursor = verifyCursor(after);
    if (immutable !== digest([after.session.work_id, after.session.work_input_id, after.session.original_parent_id,
      after.session.arena_digest, after.session.binding_digest, after.session.reservation_ref, after.session.deadline_at, after.session.obligation_refs])
      || digest(before.effects) !== digest(after.effects) || after.parent.attempts_used - before.parent.attempts_used !== 3
      || after.parent.steps_used - before.parent.steps_used !== 11 || after.charges.length - before.charges.length !== 3
      || Number(after.session.active_claim_fence) <= boundary.claimFence
      || after.jobs.filter(j => j.delivery_id).some(j => Number(j.claim_fence) !== 1 || Number(j.delivery_fence) !== 1)
      || !after.jobs.filter(j => j.delivery_id).every(j => after.charges.some(c => c.physicalInvocationId === j.delivery_id))) throw Error("ORIGINAL_BUDGET_PHYSICAL_FENCE_OR_RESPONSIBILITY_CHANGED");
    await post("viability-recover", continuationBody);
    const replay = await snapshot(input.workId, intake.sessionId);
    if (replay.parent.attempts_used !== after.parent.attempts_used || replay.charges.length !== after.charges.length) throw Error("SEMANTIC_REPLAY_RECHARGED");
    const lostKey = await post("viability-submit", { workId: input.workId, idempotencyKey: "lost-key:" + randomUUID() });
    const sameSession = await snapshot(input.workId, lostKey.sessionId);
    if (!lostKey.semanticReplay || lostKey.sessionId !== intake.sessionId
      || sameSession.parent.attempts_used !== after.parent.attempts_used
      || sameSession.charges.length !== after.charges.length
      || digest(sameSession.prefixes) !== digest(after.prefixes)) throw Error("NEW_RETRY_KEY_FORKED_OR_RESET_ORIGINAL_CURSOR");
    const mismatches = { originalParentId: randomUUID(),
      deadlineAt: new Date(Date.parse(after.session.binding.deadlineAt) + 1).toISOString(),
      ...Object.fromEntries(["sourceRevision", "mandateDigest", "observationDigest", "resourceDigest"].map(key =>
        [key, (after.session.binding[key][0] === "0" ? "1" : "0") + after.session.binding[key].slice(1)])) };
    for (const [key, value] of Object.entries(mismatches)) {
      const refused = await post("viability-submit", { workId: input.workId,
        idempotencyKey: "mismatch:" + randomUUID(), [key]: value }, 422);
      if (refused.predicate !== "Z3_CALLER_EXPECTATION_NOT_ORIGINAL") throw Error("CALLER_DEPENDENCY_BECAME_AUTHORITY");
    }
    await page.reload();
    await panel.getByText(/Native prefix:/).waitFor();
    if (point === "OBSERVATION") {
      let refused = false;
      for (let alias = 0; alias <= 256; alias++) {
        const response = await context.request.post("/api/centropy/company-brain/viability-submit", { data: {
          workId: input.workId, idempotencyKey: "bounded-alias:" + randomUUID() } });
        const value = await response.json();
        if (response.status() === 422 && value.predicate === "Z3_REQUEST_HISTORY_BOUND") { refused = true; break; }
        if (response.status() !== 202 || !value.semanticReplay || value.sessionId !== intake.sessionId) {
          throw Error("BOUNDED_ALIAS_FORKED_NATIVE_COMPUTATION");
        }
      }
      const bounded = await snapshot(input.workId, intake.sessionId);
      await post("viability-recover", continuationBody);
      if (!refused || bounded.requestsCount !== 256 || bounded.parent.attempts_used !== after.parent.attempts_used
        || bounded.charges.length !== after.charges.length || digest(bounded.prefixes) !== digest(after.prefixes)) {
        throw Error("REQUEST_HISTORY_BOUND_OR_REPLAY_CONSERVATION_FAILED");
      }
      report.cases.push({ kind: "ORIGINAL_WORK_REQUEST_HISTORY_BOUND", retainedRows: 256, refusal: "Z3_REQUEST_HISTORY_BOUND",
        existingKeyStillReplays: true, newPhysicalCharge: false });
    }
    report.cases.push({ point, workId: input.workId, sessionId: intake.sessionId, immutableIdentityDigest: immutable,
      physicalRecovery: killed, leaseExpiryRefusal, sourceDigest: permission.runtimeDigest, independentCheck: checked, cursor,
      mountedSubmit: true, mountedContinuation: true, mountedReload: true, unchangedEffectsDigest: digest(after.effects),
      p1AttemptsSpent: 3, p1StepsSpent: 11, s5PhysicalControlUnitsSpent: 3,
      lostRetryKeyPreservedOriginalSession: true,
      callerDependencyExpectationsRefused: Object.keys(mismatches) });
    await stopWorker();
  }
  const foreignContext = await browser.newContext({ baseURL: target.origin });
  try {
    const foreignPage = await foreignContext.newPage();
    await foreignPage.goto("/centropy/login");
    await foreignPage.getByLabel("Email").fill(process.env.TEST_FOREIGN_OWNER_EMAIL);
    await foreignPage.getByLabel("Password").fill(process.env.TEST_FOREIGN_OWNER_PASSWORD);
    await foreignPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await foreignPage.getByRole("heading", { name: "What needs to move forward?" }).waitFor();
    const response = await foreignContext.request.get("/api/centropy/me"), foreign = await response.json();
    if (response.status() !== 200 || foreign.role !== "owner"
      || foreign.tenantId !== permission.foreignOwner.tenantId
      || foreign.userId !== permission.foreignOwner.principalId) throw Error("EXACT_EXISTING_FOREIGN_AUTH_SCOPE_REQUIRED");
    for (const item of report.cases.filter(c => c.sessionId && c.mountedReload)) {
      const denied = await foreignContext.request.post("/api/centropy/company-brain/viability-read",
        { data: { sessionId: item.sessionId, root: null } });
      const deniedBody = await denied.json();
      const deniedWork = await foreignContext.request.get("/api/centropy/works/" + item.workId);
      if (denied.status() !== 404 || deniedBody.code !== "PE_ENTITY_NOT_FOUND"
        || deniedWork.status() !== 404 || Object.keys(deniedBody).some(k => !["code", "error"].includes(k))) {
        throw Error("EXISTING_CROSS_TENANT_ORIGINAL_INFORMATION_LEAK");
      }
    }
    report.cases.push({ kind: "EXISTING_REAL_CROSS_TENANT_OWNER_REFUSAL", originalSessions: 3, httpStatus: 404,
      ownerOrTenantCreated: false, credentialsRecorded: false });
  } finally { await foreignContext.close(); }
  report.sourceNative = "PASSED"; report.status = "PASS";
  report.runtimeDigest = permission.runtimeDigest;
  report.authorizationDigest = bytesDigest(await readFile(authorization));
}
try { await main(); }
catch (error) {
  report.status = "FAIL";
  report.failures.push(error instanceof Error && /^[A-Z][A-Z0-9_:]{0,199}$/.test(error.message) ? error.message : "NATIVE_PROOF_FAILED_DETAILS_RETAINED_IN_LOCAL_OWNER_TARGET");
  process.exitCode = 1;
} finally {
  for (const [name, cleanup] of [["WORKER", () => stopWorker()], ["DATABASE", () => database?.end()],
    ["BROWSER", () => browser?.close()]]) {
    try { await cleanup(); }
    catch { report.status = "FAIL"; report.failures.push("OWNED_" + name + "_CLEANUP_FAILED"); process.exitCode = 1; }
  }
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, sourceNative: report.sourceNative, installedNative: report.installedNative, failures: report.failures }));
}
