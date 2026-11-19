/** Guarded executable real native E2E. Current phase has NO DB/Auth authority.
 * Missing permission exits 2 before credentials, DB modules, network or workers.
 * A future explicit authority file identifies an EXISTING isolated target. */
import path from "node:path";
import { readFile, realpath, readdir, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { ROOT, save, hash, evidenceDirectory } from "./e2e-tools.mjs";
const output = await evidenceDirectory(process.argv[2]), proof = {
  schema: "finnor.z5.guarded-native-e2e.v1", state: "NOT_RUN", currentPhaseAuthority: "NO_DB_AUTH_OR_LISTENER_AUTHORITY",
  actions: [], physicalInterruptions: [], databaseInitialization: 0, tenantsCreated: 0, usersCreated: 0,
  bypasses: 0, migrationsApplied: 0, grantsApplied: 0, listenersStarted: 0, signersCreated: 0,
  externalMutations: 0, productionActivation: false, protectedAdmission: false,
};
const children = new Set();
let pool = null, browser = null;
async function refuse(reason) {
  proof.blocker = reason; proof.exit = 2;
  await save(path.join(output, "report.json"), proof); console.log(JSON.stringify(proof)); process.exit(2);
}
try {
proof.node = process.version; proof.sourceFiles = {};
for (const file of [new URL(import.meta.url), new URL("./native-worker.ts", import.meta.url),
  new URL("./source-identity.ts", import.meta.url), new URL("./e2e-tools.mjs", import.meta.url)])
  proof.sourceFiles[String(file)] = hash(await readFile(file));
if (process.env.FINNOR_Z5_DISPOSABLE_AUTHORITY !== "EXPLICIT" || !process.env.FINNOR_Z5_AUTHORITY_FILE)
  await refuse("EXPLICIT_CURRENT_DISPOSABLE_DATABASE_AUTH_PROCESS_AND_EXISTING_OWNER_AUTHORITY_NOT_GRANTED");
if (process.env.AUTH_DEV_BYPASS === "1" || process.env.NODE_ENV === "production"
  || process.env.FINNOR_Z5_PROFILE !== "ordinary_disposable" || process.env.FINNOR_ENVIRONMENT !== "ordinary_disposable")
  await refuse("NO_BYPASS_OR_PRODUCTION_TARGET_ALLOWED");
const authorityFile = process.env.FINNOR_Z5_AUTHORITY_FILE;
if (!path.isAbsolute(authorityFile)) await refuse("ABSOLUTE_EXPLICIT_AUTHORITY_FILE_REQUIRED");
const authorityBytes = await readFile(authorityFile), authority = JSON.parse(authorityBytes);
if (authority.schema !== "finnor.z5.explicit-existing-disposable-authority.v1" || path.resolve(authority.repository) !== ROOT
  || !Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.now() || authority.database?.existingOnly !== true
  || authority.exclusiveWorker !== true || authority.noLiveProviders !== true || authority.noRealFinancialEffects !== true
  || authority.sameSupabaseProjectVerified !== true || authority.existingOriginalS8Contracts !== true)
  await refuse("EXACT_EXISTING_DISPOSABLE_AUTHORITY_AND_ORIGINAL_OWNER_PREREQUISITES_REQUIRED");
const base = new URL(authority.frontendOrigin), db = new URL(process.env.DATABASE_URL ?? "invalid:");
if (!["127.0.0.1", "::1", "localhost"].includes(base.hostname) || base.username || base.password || base.pathname !== "/"
  || !["127.0.0.1", "::1", "localhost"].includes(db.hostname) || db.hostname !== authority.database.host
  || Number(db.port || 5432) !== authority.database.port || decodeURIComponent(db.pathname.slice(1)) !== authority.database.name)
  await refuse("TARGET_MUST_BE_THE_EXPLICIT_EXISTING_OWNED_LOOPBACK_STACK");
const { exactSourceHead } = await import("./source-identity.ts"), head = await exactSourceHead(ROOT);
if (head !== authority.sourceHead || !/^v22\./.test(process.version)) await refuse("EXACT_NODE22_CURRENT_SOURCE_REQUIRED");
for (const name of ["frontend", "api", "s8"]) {
  const processProof = authority.ownedProcesses?.[name];
  if (!Number.isSafeInteger(processProof?.pid) || processProof.pid <= 1 || processProof.sourceHead !== head
    || !Number.isSafeInteger(processProof.port) || processProof.port < 1 || processProof.port > 65535
    || name === "frontend" && processProof.port !== Number(base.port || 80))
    await refuse("EXACT_EXISTING_OWNED_STACK_PROCESS_IDENTITIES_REQUIRED");
  const status = await readFile("/proc/" + processProof.pid + "/status", "utf8"),
    cwd = await realpath("/proc/" + processProof.pid + "/cwd");
  if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== process.getuid()
    || !(cwd === ROOT || cwd.startsWith(ROOT + path.sep)))
    await refuse("BORROWED_OR_FOREIGN_LISTENERS_ARE_NOT_AUTHORIZED");
  const descriptors = await readdir("/proc/" + processProof.pid + "/fd");
  if (descriptors.length > 4096) await refuse("OWNED_PROCESS_DESCRIPTOR_BOUND");
  const inodes = new Set();
  for (const descriptor of descriptors) {
    try {
      const target = await readlink("/proc/" + processProof.pid + "/fd/" + descriptor);
      const socket = /^socket:\[(\d+)\]$/.exec(target);
      if (socket) inodes.add(socket[1]);
    } catch { /* A descriptor can close while observed. A listener must remain. */ }
  }
  let ownedListener = false;
  for (const table of ["tcp", "tcp6"]) {
    const lines = (await readFile("/proc/" + processProof.pid + "/net/" + table, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const columns = line.trim().split(/\s+/), [address, port] = columns[1].split(":");
      if (columns[3] === "0A" && Number.parseInt(port, 16) === processProof.port && inodes.has(columns[9])
        && ["0100007F", "00000000000000000000000001000000", "0000000000000000FFFF00000100007F"].includes(address))
        ownedListener = true;
    }
  }
  if (!ownedListener) await refuse("EXACT_OWNED_LOOPBACK_SOCKET_PID_REQUIRED");
}
proof.ownedProcesses = Object.fromEntries(["frontend", "api", "s8"].map(name =>
  [name, { pid: authority.ownedProcesses[name].pid, port: authority.ownedProcesses[name].port, exactOwnedLoopbackSocket: true }]));
const requiredNames = ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "Z5_OTHER_OWNER_EMAIL", "Z5_OTHER_OWNER_PASSWORD", "DATABASE_URL"];
if (requiredNames.some(name => !process.env[name])) await refuse("REAL_EXISTING_OWNER_AND_SECOND_TENANT_CREDENTIALS_REQUIRED_NO_FAKE_OWNER");
const request = authority.submit;
if (request?.workId !== authority.workId || !request.root || !request.parentReservation || !request.assignmentRef
  || request.obligationRefs?.length < 1 || !Number.isFinite(Date.parse(request.originalDeadline))
  || Date.parse(request.originalDeadline) - Date.now() < 12 * 60 * 1000)
  await refuse("EXISTING_EXACT_WORK_ORIGINAL_ALLOWANCE_AND_OLD_DELAYED_CALLBACK_OBLIGATION_REQUIRED");
const alternate = authority.alternateMountedWork;
if (!alternate?.workId || alternate.workId === request.workId || !alternate.root
  || alternate.root.entityType === request.root.entityType && alternate.root.entityId === request.root.entityId)
  await refuse("SECOND_EXISTING_ORIGINAL_WORK_AND_ROOT_REQUIRED_FOR_REAL_CONTEXT_SWITCH");
// Only now load the separately installed application-owned dependencies.
const require = createRequire(path.join(ROOT, "finnor-os/package.json"));
const { chromium } = require("playwright"), { getPool, withTenantTransaction } = await import("../../../packages/db/index.ts");
pool = getPool(); browser = await chromium.launch({ headless: true });
const context = await browser.newContext(), page = await context.newPage();
proof.authorityDigest = hash(authorityBytes); proof.sourceHead = head; proof.workId = request.workId;
proof.currentPhaseAuthority = "EXPLICIT_EXISTING_OWNED_DISPOSABLE_TARGET_ASSERTION_NOT_PROTECTED_AUTHORITY";
async function step(name, expected, operation) {
  const result = await operation();
  proof.actions.push({ name, expected, observed: result, at: new Date().toISOString() });
  await save(path.join(output, String(proof.actions.length).padStart(2, "0") + ".json"), proof.actions.at(-1));
  return result;
}
async function login(p, email, password) {
  await p.goto(new URL("/centropy/login", base).href);
  await p.getByLabel("Email").fill(email); await p.getByLabel("Password").fill(password);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await p.waitForURL(url => !url.pathname.includes("/login"), { timeout: 30000 });
  const me = await p.evaluate(async () => {
    const key = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
    const session = key ? JSON.parse(localStorage.getItem(key)) : null;
    if (!session?.access_token) throw Error("REAL_STORED_SUPABASE_SESSION_REQUIRED");
    const r = await fetch("/api/centropy/me", { headers: { authorization: "Bearer " + session.access_token } });
    return { status: r.status, body: await r.json() };
  });
  if (me.status !== 200 || me.body.role !== "owner") throw Error("GENUINE_NATIVE_OWNER_LOGIN_FAILED");
  return me.body;
}
async function post(operation, body, p = page) {
  return p.evaluate(async ({ operation, body }) => {
    // Reuse the mounted application's actual authenticated proxy surface.
    const auth = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
    const session = auth ? JSON.parse(localStorage.getItem(auth)) : null;
    if (!session?.access_token) throw Error("REAL_STORED_SUPABASE_SESSION_REQUIRED");
    const response = await fetch("/api/centropy/" + operation, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + session.access_token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { operation, body });
}
const scoped = id => ({ workId: request.workId, root: request.root, requestId: id });
async function read(id) {
  const r = await post("company-brain/institution-link-read", scoped(id));
  if (r.status !== 200 || r.body.workId !== request.workId) throw Error("ORIGINAL_REQUEST_READ_FAILED");
  return r.body;
}
async function until(check, timeoutMs = 240000) {
  const deadline = Math.min(Date.now() + timeoutMs, Date.parse(request.originalDeadline));
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 500)); }
  throw Error("BOUNDED_ORIGINAL_DEADLINE_REACHED");
}
async function worker(point) {
  const child = spawn(process.execPath, ["--import", "tsx", "--max-old-space-size=768",
    path.join(ROOT, "finnor-os/scripts/project-z/z5/native-worker.ts"), authorityFile], {
    cwd: path.join(ROOT, "finnor-os"), env: { ...process.env, FINNOR_Z5_EXCLUSIVE_WORKER: "1", FINNOR_Z5_INTERRUPT_AT: point },
    stdio: ["ignore", "pipe", "pipe"] });
  children.add(child); const result = { pid: child.pid, stderrDigest: null, exit: null };
  let error = ""; child.stderr.on("data", b => { error += b; if (error.length > 65536) child.kill("SIGTERM"); });
  child.stdout.resume();
  const closed = once(child, "close").then(([code, signal]) => {
    children.delete(child); result.exit = { code, signal }; result.stderrDigest = hash(error); return result;
  }, () => {
    children.delete(child); result.exit = { code: null, signal: "SPAWN_ERROR" }; result.stderrDigest = hash(error); return result;
  });
  return { child, closed, result };
}
  const identity = await login(page, process.env.TEST_OWNER_EMAIL, process.env.TEST_OWNER_PASSWORD);
  if (identity.tenantId !== authority.tenantId || (identity.employeeId ?? identity.userId) !== authority.principalId)
    throw Error("AUTHENTICATED_ORIGINAL_TENANT_PRINCIPAL_MISMATCH");
  const observe = (sql, values) => withTenantTransaction(authority.tenantId,
    { userId: authority.principalId, readOnly: true }, async (_db, client) => client.query(sql, values));
  const target = await pool.query("SELECT current_database() name, current_user role");
  if (target.rows[0]?.name !== authority.database.name || target.rows[0]?.role !== "finnor_app")
    throw Error("EXACT_UNPRIVILEGED_EXISTING_DATABASE_REQUIRED");
  await step("existing-owner-and-database", "Actual authenticated original identity and unprivileged existing disposable DB",
    async () => ({ tenantId: identity.tenantId, principalId: identity.employeeId ?? identity.userId,
      databaseMatches: true, role: "finnor_app", noInitialization: true }));
  const registration = await post("company-brain/institution-contract-register", authority.registerProfile);
  if (registration.status !== 200) throw Error("REAL_EXISTING_S8_COMPONENT_CONTRACT_REQUIRED");
  const submitted = await post("company-brain/institution-link-submit", request);
  if (submitted.status !== 202 || !submitted.body.requestId) throw Error("NATIVE_INTAKE_NOT_ACCEPTED");
  const id = submitted.body.requestId;
  const conflicting = await post("company-brain/institution-link-submit", { ...request,
    responsibilityIdentity: request.responsibilityIdentity === "z5-preimage-falsifier" ? "z5-other-preimage" : "z5-preimage-falsifier" });
  if (conflicting.status !== 409 || conflicting.body.code !== "Z5_ORIGINAL_IDEMPOTENCY_CONFLICT")
    throw Error("ORIGINAL_IDEMPOTENCY_PREIMAGE_NOT_FENCED");
  await step("original-Work-intake", "One exact original Work, native job and unchanged parent", async () => ({ requestId: id, workId: request.workId }));
  const historiesAtReplacement = new Map();
  for (const point of ["AFTER_CLAIM", "AFTER_CERTIFICATE", "AFTER_REPLACEMENT"]) {
    const owned = await worker(point);
    const paused = await until(async () => {
      if (owned.result.exit) throw Error("OWNED_NATIVE_WORKER_EXITED_BEFORE_PHYSICAL_BOUNDARY");
      const row = await read(id);
      const event = row.events.find(e => e.kind === "PHYSICAL_INTERRUPT_READY" && e.detail.point === point
        && e.detail.processId === owned.child.pid);
      return event ? { row, event } : null;
    });
    if (point === "AFTER_REPLACEMENT") for (const obligationRef of request.obligationRefs) {
      const original = await post("obligations/read-execution-handoff", { obligationRef });
      if (original.status !== 200) throw Error("ORIGINAL_INDEPENDENT_HISTORY_NOT_READABLE");
      historiesAtReplacement.set(obligationRef.id, new Set(original.body.handoff.history.map(row => row.event.eventId)));
    }
    if (!owned.child.kill("SIGKILL")) throw Error("OWNED_NATIVE_WORKER_NOT_KILLED");
    const exit = await owned.closed;
    if (exit.exit.signal !== "SIGKILL") throw Error("ACTUAL_PHYSICAL_NATIVE_SIGKILL_REQUIRED");
    const observation = { point, processId: owned.child.pid, actualExit: exit.exit,
      requestId: id, claimFence: paused.event.detail.claimFence, originalDeadline: paused.row.originalDeadline,
      originalReservation: paused.row.originalReservation, carriedObligationRefs: paused.row.obligations,
      attempts: paused.row.attempts.map(a => ({ deliveryId: a.delivery_id, fence: a.claim_fence, chargeRef: a.charge_ref })) };
    proof.physicalInterruptions.push(observation); await save(path.join(output, point + ".json"), observation);
    if (paused.row.originalDeadline !== request.originalDeadline || hash(JSON.stringify(paused.row.originalReservation)) !== hash(JSON.stringify(request.parentReservation))
      || paused.row.obligations.length !== request.obligationRefs.length) throw Error("RESTART_REPLACED_ORIGINAL_LIABILITY_OR_ALLOWANCE");
    // A real killed worker leaves its native capacity occupied until expiry.
    // Do not create extra queue deliveries by starting into that occupied slot,
    // shorten a lease, steal its token or reset any original grant.
    await until(async () => (await observe(`SELECT NOT EXISTS(
      SELECT 1 FROM finnor_os.compute_resource_leases WHERE resource_key='native:z5-institution-linker'
       AND tenant_key=$1 AND released_at IS NULL AND expires_at>clock_timestamp()) clear`, [authority.tenantId])).rows[0]?.clear === true);
  }
  const finalWorker = await worker("");
  const completed = await until(async () => {
    const row = await read(id);
    return row.status === "USED" && row.events.some(e => e.kind === "WORKER_ORIGINAL_RESULT_READY_FOR_QUEUE_ACK") ? row : null;
  });
  const queueAck = await until(async () => {
    const result = await observe(`SELECT j.status,a.outcome,a.finished_at FROM finnor_os.jobs j
      JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
      WHERE j.tenant_id=$1 AND j.payload->>'requestId'=$2 AND j.type='link_institution_components_v1'
       AND a.id=$3`, [authority.tenantId, id, completed.attempts.at(-1).delivery_id]);
    const actual = result.rows[0];
    return actual?.status === "completed" && actual.outcome === "completed" && actual.finished_at ? actual : null;
  });
  finalWorker.child.kill("SIGTERM");
  const finalStop = setTimeout(() => finalWorker.child.kill("SIGKILL"), 5000);
  try {
    await finalWorker.closed;
    if (finalWorker.result.exit.code !== 0) throw Error("FINAL_OWNED_NATIVE_WORKER_DID_NOT_DRAIN");
  } finally { clearTimeout(finalStop); }
  if (completed.artifact.certificate.replacement.status !== "BRIDGED" || !completed.admission
    || completed.attempts.length !== 4 || !completed.current || completed.protectedAdmission !== false)
    throw Error("CURRENT_INDEPENDENT_NATIVE_REPLACEMENT_OR_RECOVERY_NOT_PROVED");
  const plan = await post("policies/composition-plan", { policyRef: request.policyRef, allocationRef: request.allocationRef });
  if (plan.status !== 200) throw Error("ACTUAL_ORIGINAL_S4_PLANNING_CONSUMPTION_NOT_ESTABLISHED");
  const consumed = await read(id);
  if (!consumed.events.some(e => e.kind === "S4_ORIGINAL_COMPOSITION_PLAN_CONSUMED"))
    throw Error("STORED_SELECTION_ALONE_IS_NOT_ORIGINAL_S4_PLANNING_CONSUMPTION");
  await step("actual-owner-consumption", "Original S4 integration/replacement planning consumed exact S8-admitted conditional contract",
    async () => ({ artifactDigest: consumed.artifactDigest, admissionRef: consumed.admission.ref,
      originalS4PlanRef: plan.body.ref, originalObligationsRetained: true,
      actualQueueStatus: queueAck.status, actualDeliveryOutcome: queueAck.outcome,
      actualS7CostEvents: consumed.events.filter(e => e.detail?.costRef).map(e => e.detail.costRef) }));
  async function durableReadState() {
    const result = await observe(`SELECT r.status,r.generation,r.cancel_requested,r.deliveries,
      r.artifact_digest,r.admission->'ref' admission_ref,
      e.requests,e.deliveries episode_deliveries,e.retained_bytes,e.event_count,e.uses,
      (SELECT count(*) FROM finnor_os.z5_link_events x WHERE x.tenant_id=r.tenant_id AND x.request_id=r.id) events,
      (SELECT count(*) FROM finnor_os.z5_link_attempts x WHERE x.tenant_id=r.tenant_id AND x.request_id=r.id) attempts,
      (SELECT count(*) FROM finnor_os.z5_s4_uses x WHERE x.tenant_id=r.tenant_id AND x.request_id=r.id) composition_uses,
      (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.policy_id,h.allocation_id),'[]'::jsonb)
       FROM finnor_os.z5_s4_heads h WHERE h.tenant_id=r.tenant_id AND h.principal_id=r.principal_id
        AND h.work_id=r.work_id) composition_heads
      FROM finnor_os.z5_link_requests r JOIN finnor_os.z5_link_episodes e
       ON e.tenant_id=r.tenant_id AND e.principal_id=r.principal_id AND e.work_id=r.work_id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`,
    [authority.tenantId, authority.principalId, id]);
    if (result.rows.length !== 1) throw Error("ACTUAL_TENANT_SCOPED_READ_STATE_REQUIRED");
    return hash(JSON.stringify(result.rows[0]));
  }
  const beforeReads = await durableReadState();
  const firstRead = await read(id), secondRead = await read(id), afterReads = await durableReadState();
  if (beforeReads !== afterReads || firstRead.artifactDigest !== secondRead.artifactDigest
    || !firstRead.current || !secondRead.current) throw Error("READ_MUTATED_ORIGINAL_DURABLE_Z5_STATE");
  await step("nonmutating-original-reads", "Repeated real authenticated reads preserve Z5 request/episode/events/attempts",
    async () => ({ beforeDigest: beforeReads, afterDigest: afterReads, unchanged: true, actualOwnerRlsScope: true }));
  const noFifth = await post("company-brain/institution-link-submit", { ...request, idempotencyKey: "exhausted-native:" + id });
  if (noFifth.status !== 202 || noFifth.body.disposition !== "INCOMPLETE" || noFifth.body.requestId !== null
    || noFifth.body.newAllowance !== false || (await read(id)).attempts.length !== 4)
    throw Error("ORIGINAL_PHYSICAL_EXHAUSTION_RENEWED_ALLOWANCE");
  const mount = new URL(authority.mountedWorkUrl, base);
  if (mount.origin !== base.origin || !mount.pathname.startsWith("/centropy")) throw Error("EXACT_EXISTING_MOUNT_REQUIRED");
  await page.goto(mount.href);
  const panel = page.getByRole("region", { name: "Institution composition" });
  await panel.waitFor({ state: "visible" });
  if (await panel.getAttribute("data-work-id") !== request.workId) throw Error("WRONG_WORK_MOUNT");
  await page.reload(); await panel.waitFor({ state: "visible" });
  await until(async () => (await panel.textContent()).includes(consumed.artifactDigest), 30000);
  if (await panel.getAttribute("data-root-type") !== request.root.entityType
    || await panel.getAttribute("data-root-id") !== request.root.entityId) throw Error("WRONG_ORIGINAL_ROOT_MOUNT");
  await step("mounted-original-Work-reload", "Exact current artifact shown after authenticated reload",
    async () => ({ workId: await panel.getAttribute("data-work-id"), artifactPresent: (await panel.textContent()).includes(consumed.artifactDigest),
      mountedDigest: hash(await panel.textContent()) }));
  const alternateMount = new URL(alternate.url, base);
  if (alternateMount.origin !== base.origin || !alternateMount.pathname.startsWith("/centropy"))
    throw Error("EXACT_SECOND_EXISTING_MOUNT_REQUIRED");
  await page.goto(alternateMount.href); await panel.waitFor({ state: "visible" });
  if (await panel.getAttribute("data-work-id") !== alternate.workId
    || await panel.getAttribute("data-root-type") !== alternate.root.entityType
    || await panel.getAttribute("data-root-id") !== alternate.root.entityId
    || (await panel.textContent()).includes(consumed.artifactDigest))
    throw Error("PRIVATE_RESULT_SURVIVED_REAL_WORK_OR_ROOT_SWITCH");
  await page.goto(mount.href); await panel.waitFor({ state: "visible" });
  await until(async () => (await panel.textContent()).includes(consumed.artifactDigest), 30000);
  await step("real-original-Work-and-root-switch", "Genuine existing alternate root does not display the old private proof; returning reloads it",
    async () => ({ originalWorkId: request.workId, alternateWorkId: alternate.workId, oldPrivateProofAbsent: true }));
  const second = await browser.newContext(), other = await second.newPage();
  const otherIdentity = await login(other, process.env.Z5_OTHER_OWNER_EMAIL, process.env.Z5_OTHER_OWNER_PASSWORD);
  if (otherIdentity.tenantId === identity.tenantId) throw Error("GENUINE_SECOND_TENANT_REQUIRED");
  const denied = await post("company-brain/institution-link-read", scoped(id), other);
  if (![403, 404].includes(denied.status)) throw Error("CROSS_TENANT_PRIVATE_ARTIFACT_DISCLOSURE");
  await other.goto(mount.href);
  await until(async () => !(await other.locator("body").textContent()).includes(consumed.artifactDigest), 30000);
  // Real UI sign-out, not localStorage editing or a fake auth identity.
  await page.getByLabel("Account menu").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL(url => url.pathname.includes("/login"), { timeout: 30000 });
  if ((await page.locator("body").textContent()).includes(consumed.artifactDigest))
    throw Error("PRIVATE_RESULT_SURVIVED_REAL_SIGN_OUT");
  await login(page, process.env.TEST_OWNER_EMAIL, process.env.TEST_OWNER_PASSWORD);
  await page.goto(mount.href); await panel.waitFor({ state: "visible" });
  await step("genuine-tenant-and-session-scope-change", "Second real tenant cannot read original proof; real sign-out removes old mounted state",
    async () => ({ deniedStatus: denied.status, oldProofAbsentOnSignOut: true, newAuthenticatedReload: true }));
  await second.close();
  const stale = await until(async () => {
    const row = await read(id); return !row.current && row.status === "STALE" ? row : null;
  }, authority.callbackObservationTimeoutMs ?? 240000);
  for (const obligationRef of request.obligationRefs) {
    const original = await post("obligations/read-execution-handoff", { obligationRef });
    if (original.status !== 200 || !original.body.handoff?.observations?.some(row =>
      !historiesAtReplacement.get(obligationRef.id)?.has(row.event.eventId)))
      throw Error("REAL_INDEPENDENT_ORIGINAL_CALLBACK_NOT_OBSERVED");
  }
  const reuse = await post("company-brain/institution-link-use", { ...scoped(id), artifactDigest: stale.artifactDigest, idempotencyKey: "post-callback-refusal" });
  if (reuse.status < 400 || stale.obligations.length !== request.obligationRefs.length)
    throw Error("CALLBACK_INVALIDATION_DROPPED_LIABILITY_OR_ALLOWED_STALE_USE");
  await step("delayed-independent-callback-and-currentness", "Read original independent observation; stale reuse refused and old liabilities retained",
    async () => ({ status: stale.status, staleReuseStatus: reuse.status, obligationsRetained: true,
      independentObservation: "ORIGINAL_PROTECTED_S6_HANDOFF_NOT_ACKNOWLEDGMENT" }));
  const cancelled = await post("company-brain/institution-link-cancel", scoped(id));
  if (cancelled.status !== 200 || cancelled.body.exposureRetained !== true || cancelled.body.controlFenceCommitted !== true)
    throw Error("CANCEL_DROPPED_ORIGINAL_LIABILITY");
  const beforeCancelledConsumers = await durableReadState();
  const cancelledAdmission = await post("company-brain/institution-link-admit", scoped(id));
  const cancelledUse = await post("company-brain/institution-link-use", {
    ...scoped(id), artifactDigest: consumed.artifactDigest, idempotencyKey: "post-cancel-refusal" });
  const cancelledPlan = await post("policies/composition-plan", {
    policyRef: request.policyRef, allocationRef: request.allocationRef });
  const afterCancelledConsumers = await durableReadState(), cancelledState = await read(id);
  if (![cancelledAdmission, cancelledUse, cancelledPlan].every(result => result.status >= 400 && result.status < 500)
    || beforeCancelledConsumers !== afterCancelledConsumers || cancelledState.status !== "CANCELLED" || cancelledState.current)
    throw Error("CANCELLED_ORIGINAL_REQUEST_CONSUMED_OR_MUTATED");
  await step("cancelled-native-consumers-refused", "Original S8 admission, S4 use and S4 planning refuse the durable cancellation fence",
    async () => ({ admissionStatus: cancelledAdmission.status, useStatus: cancelledUse.status, planningStatus: cancelledPlan.status,
      beforeDigest: beforeCancelledConsumers, afterDigest: afterCancelledConsumers, unchanged: true,
      concurrentCancellationSchedule: "NOT_EXERCISED_BY_THIS_POST_COMMIT_NEGATIVE" }));
  const revoked = await post("company-brain/institution-contract-revoke", { workId: request.workId, root: request.root,
    profileRef: request.profileRef, reason: "EXPLICIT_DISPOSABLE_E2E_REVOKE" });
  const refused = await post("company-brain/institution-link-admit", scoped(id)), terminal = await read(id);
  if (revoked.status !== 200 || revoked.body.controlFenceCommitted !== true || refused.status < 400 || terminal.current || terminal.status !== "REVOKED"
    || terminal.obligations.length !== request.obligationRefs.length || terminal.attempts.length !== 4)
    throw Error("REVOKED_CANCELLED_ORIGINAL_SCOPE_REUSED_OR_RESET");
  await page.reload(); await panel.waitFor({ state: "visible" });
  if (!(await panel.textContent()).includes("REVOKED")) throw Error("REVOKED_STATE_NOT_VISIBLE_AFTER_REAL_RELOAD");
  await step("cancel-revoke-and-retained-failure", "No fresh grant, admission or lost original obligation after cancellation and revocation",
    async () => ({ status: terminal.status, current: terminal.current, attempts: terminal.attempts.length,
      oldObligationsRetained: true, originalIdempotencyConflict: conflicting.status, fifthDeliveryRefused: true,
      cancelAuditRecorded: cancelled.body.auditRecorded, revokeAuditRecorded: revoked.body.auditRecorded,
      cancelAuditGap: cancelled.body.auditGap, revokeAuditGap: revoked.body.auditGap }));
  proof.state = "PASSED_NATIVE_ENGINEERING_ONLY"; proof.exit = 0;
} catch (error) {
  proof.state = "FAILED"; proof.failure = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "NATIVE_EXISTING_TARGET_OR_DEPENDENCY_FAILURE";
  proof.exit = 1;
} finally {
  for (const child of children) {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await once(child, "close").catch(() => undefined); clearTimeout(force);
  }
  await browser?.close().catch(() => undefined); await pool?.end().catch(() => undefined);
  await save(path.join(output, "report.json"), proof); console.log(JSON.stringify(proof)); process.exitCode = proof.exit;
}
