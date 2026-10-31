/** Real native owner replay. No fixture DB, tenant, Auth, listeners or effects
 * are created here. Missing explicit authority is a non-success NOT_RUN. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, open, readlink, readdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2), option = name => args[args.indexOf(name)+1];
const outArg = args.includes("--evidence-dir") && option("--evidence-dir");
if (!outArg || !isAbsolute(outArg)) throw Error("Z2_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED");
const out = resolve(outArg), here = fileURLToPath(import.meta.url);
const started = performance.now(), cpuStart = process.cpuUsage();
await mkdir(out, { recursive: false, mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? "["+value.map(canonical).join(",")+"]" :
    "{"+Object.keys(value).sort().map(key => JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}";
const digest = value => hash(canonical(value));
const allowedOperation = /^(?:coalition-(?:submit|read)|interaction-(?:read|list|local|admit|terms|consent|start|run-read|observe|action|materialize|artifact|compare|cancel|resume)|economic-(?:reservation|programme)-read)$/;
// Finite validator for the checked-in schema vocabulary, without a downloaded
// validator or executable target hooks. Native request semantics stay native.
function targetShape(schema, value, root = schema, depth = 0) {
  const require = (yes, code) => { if (!yes) throw Error("Z2_TARGET_SCHEMA_"+code); };
  require(depth <= 64, "DEPTH_BOUND");
  if (schema.$ref) {
    require(/^#\/\$defs\/[A-Za-z0-9]+$/.test(schema.$ref), "LOCAL_REFERENCE");
    targetShape(root.$defs[schema.$ref.slice(8)], value, root, depth+1);
  }
  for (const part of schema.allOf ?? []) targetShape(part, value, root, depth+1);
  if (schema.oneOf) {
    let matches = 0;
    for (const part of schema.oneOf) {
      try { targetShape(part, value, root, depth+1); matches++; } catch {}
    }
    require(matches === 1, "ONE_OF");
  }
  if (Object.hasOwn(schema, "const")) require(canonical(value) === canonical(schema.const), "CONSTANT");
  if (schema.enum) require(schema.enum.includes(value), "ENUM");
  if (schema.not) {
    let matches = true;
    try { targetShape(schema.not, value, root, depth+1); } catch { matches = false; }
    require(!matches, "FORBIDDEN_VALUE");
  }
  if (schema.type) require(
    schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
    schema.type === "array" ? Array.isArray(value) :
    schema.type === "integer" ? Number.isSafeInteger(value) : typeof value === schema.type, "TYPE");
  if (typeof value === "string") {
    require(value.length >= (schema.minLength ?? 0), "STRING_LENGTH");
    if (schema.pattern) require(new RegExp(schema.pattern).test(value), "PATTERN");
    if (schema.format === "date-time") require(Number.isFinite(Date.parse(value)), "TIMESTAMP");
    if (schema.format === "uuid") require(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value), "UUID");
  }
  if (typeof value === "number") require(value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity), "NUMBER_BOUND");
  if (Array.isArray(value)) {
    require(value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 100000), "ARRAY_BOUND");
    if (schema.items) for (const item of value) targetShape(schema.items, item, root, depth+1);
  } else if (value !== null && typeof value === "object") {
    for (const name of schema.required ?? []) require(Object.hasOwn(value, name), "REQUIRED_FIELD");
    require(Object.keys(value).length >= (schema.minProperties ?? 0), "OBJECT_BOUND");
    for (const [name, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, name)) targetShape(schema.properties[name], item, root, depth+1);
      else {
        require(schema.additionalProperties !== false, "UNKNOWN_FIELD");
        if (schema.additionalProperties && typeof schema.additionalProperties === "object")
          targetShape(schema.additionalProperties, item, root, depth+1);
      }
    }
  }
}
const proof = { schema: "finnor.project-z.z2.guarded-native-replay.v1", status: "NOT_RUN",
  driverSha256: hash(await readFile(here)), startedAt: new Date().toISOString(), steps: [],
  authenticatedOwner: "NOT_RUN", mountedWork: "NOT_RUN", physicalRecovery: "NOT_RUN",
  servicesStarted: false, databaseOrAuthAccess: false,
  installedOwnerExecution: "NOT_RUN", protectedAdmission: false, equippedComparison: "NOT_RUN",
  financialQualification: "NOT_RUN", effectDispatch: "PROHIBITED", actualCompliance: "UNKNOWN" };
const save = async () => writeFile(resolve(out, "report.json"), JSON.stringify(proof, null, 2)+"\n", { mode: 0o600 });
const record = (id, observed) => {
  assert(proof.steps.length < 100000, "Z2_NATIVE_EVIDENCE_STEP_BOUND");
  const step = { id, observed, at: new Date().toISOString() };
  proof.steps.push(step);
  appendFileSync(resolve(out, "steps.ndjson"), JSON.stringify(step)+"\n", { mode: 0o600 });
};
const safeProjection = value => ({ protocolId: value?.protocolId, workId: value?.workId,
  runId: value?.runId, status: value?.status, current: value?.current, code: value?.code,
  counters: value?.counters, contentDigest: digest(value ?? null) });
let browser, db, replacement, workerIdentity, target, databaseUrl, build;
const clients = [];
const loopback = value => {
  const u = new URL(value);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  assert(!u.username && !u.password && u.protocol === "http:" && u.pathname === "/" && !u.search && !u.hash);
  return u.origin;
};
const waitUntil = async (id, read, ready, timeout = 240000) => {
  const deadline = Date.now()+timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(150);
  }
  throw Error("Z2_NATIVE_WAIT_EXPIRED:"+id);
};
async function processIdentity(pid, kind = "worker") {
  assert(Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid);
  const root = "/proc/"+pid, metadata = await stat(root);
  assert.equal(metadata.uid, process.getuid());
  const command = await readFile(root+"/cmdline");
  if (kind === "worker")
    assert(command.toString().split("\0").some(arg => arg.endsWith("apps/worker/src/index.ts")));
  const expectedCwd = kind === "worker" ? resolve(target.sourceRoot, "finnor-os") :
    kind === "api" ? resolve(target.sourceRoot, "finnor-os/apps/api") : target.sourceRoot;
  assert.equal(await readlink(root+"/cwd"), expectedCwd);
  assert.equal(hash(await readFile(await readlink(root+"/exe"))), build.node.sha256);
  const raw = await readFile(root+"/stat", "utf8"), fields = raw.slice(raw.lastIndexOf(")")+2).split(" ");
  return { pid, startTicks: fields[19], state: fields[0], cmdlineSha256: hash(command) };
}
async function ownedListener(pid, origin) {
  const port = Number(new URL(origin).port || "80"), inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"])
    for (const line of (await readFile(file, "utf8")).trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === port &&
        Number(fields[7]) === process.getuid()) inodes.add(fields[9]);
    }
  const links = await Promise.allSettled((await readdir("/proc/"+pid+"/fd"))
    .map(name => readlink("/proc/"+pid+"/fd/"+name)));
  assert(links.some(r => r.status === "fulfilled" && /^socket:\[\d+\]$/.test(r.value) &&
    inodes.has(r.value.slice(8, -1))), "Z2_EXACT_OWNED_LISTENER_REQUIRED");
  return { pid, port, listenerOwned: true };
}
async function sql(query, values = []) {
  assert(/^\s*SELECT\b/.test(query) && !/[;]/.test(query));
  await db.query("BEGIN READ ONLY");
  try {
    await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [target.tenantId, target.actors[0].principalId]);
    const result = await db.query(query, values);
    await db.query("COMMIT");
    return result.rows;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
async function snapshot(protocolId, reservationId) {
  const original = (await sql(`SELECT r.id,r.work_id,r.work_input_id,r.work_input_digest,r.episode_id,r.generation,
    r.status,r.candidate IS NOT NULL has_candidate,r.artifact IS NOT NULL has_artifact,
    e.deadline_at,e.attempts_used,e.search_steps_used,e.retained_bytes::text
    FROM finnor_os.y3_requests r JOIN finnor_os.y3_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id
    WHERE r.tenant_id=$1 AND r.id=$2`, [target.tenantId, protocolId]))[0];
  const deliveries = await sql(`SELECT a.id,a.job_id,a.claim_fence::text,a.outcome,a.finished_at
    FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id AND j.tenant_id=a.tenant_id
    WHERE j.tenant_id=$1 AND j.payload->>'protocolId'=$2 ORDER BY a.started_at,a.id LIMIT 257`,
    [target.tenantId, protocolId]);
  assert(deliveries.length < 257, "Z2_DELIVERY_OBSERVATION_BOUND");
  const jobs = await sql(`SELECT id,status,attempts,max_attempts,claim_fence::text,lease_expires_at
    FROM finnor_os.jobs WHERE tenant_id=$1 AND type='construct_interaction_protocol_v1'
    AND payload->>'protocolId'=$2 ORDER BY created_at,id LIMIT 5`, [target.tenantId, protocolId]);
  const reservation = await sql(`SELECT reservation_id,status,revision FROM finnor_os.s5_reservations
    WHERE tenant_id=$1 AND reservation_id=$2`, [target.tenantId, reservationId]);
  const aggregate = await sql(`SELECT resource_key,count(*)::int occupied FROM finnor_os.compute_resource_leases
    WHERE resource_key='native:y3-construction' AND released_at IS NULL AND expires_at>clock_timestamp() GROUP BY resource_key`);
  assert(jobs.length <= 4 && aggregate.every(r => r.occupied <= 1));
  return { original, deliveries, jobs, reservation, aggregate };
}
async function restartWorker(boundary, workId, nonce, requireStopped = false) {
  assert(target.authorization.ownedWorkerKillAndSameBuildRestart === true);
  const identity = await processIdentity(workerIdentity.pid);
  assert.equal(identity.startTicks, workerIdentity.startTicks);
  assert.equal(identity.cmdlineSha256, workerIdentity.cmdlineSha256);
  if (requireStopped) assert(["T", "t"].includes(identity.state));
  const others = await sql(`SELECT count(*)::int count FROM finnor_os.jobs j
    WHERE j.status IN('queued','running','failed','dead_letter') AND
    (j.tenant_id IS DISTINCT FROM $1 OR j.type<>'construct_interaction_protocol_v1' OR NOT EXISTS(
      SELECT 1 FROM finnor_os.y3_requests r WHERE r.tenant_id=j.tenant_id AND r.id::text=j.payload->>'protocolId'
      AND r.work_id=ANY($2::uuid[])))`, [target.tenantId, target.cases.map(c => c.request.workId)]);
  assert.equal(others[0].count, 0);
  process.kill(identity.pid, "SIGKILL");
  await waitUntil("physical-exit", async () => {
    try { const p = await processIdentity(identity.pid); return p.state === "Z" || p.startTicks !== identity.startTicks; }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }, Boolean, 10000);
  record("physical-worker-exit", { ...identity, signal: "SIGKILL", exitObserved: true });
  // Never release, shorten or steal the dead process's compute permit.
  const resourceWaitStarted = Date.now();
  await waitUntil("original-compute-permit-expiry", () => sql(`SELECT count(*)::int count
    FROM finnor_os.compute_resource_leases WHERE resource_key='native:y3-construction'
    AND released_at IS NULL AND expires_at>clock_timestamp()`), rows => rows[0].count === 0, 180000);
  record("original-resource-expiry-observed", { wallMs: Date.now()-resourceWaitStarted,
    noReservationReleaseOrDeadlineReset: true, visibility: "CANONICAL_WORKER_ROLE_WITHOUT_BYPASSRLS" });
  const env = { NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: dirname(process.execPath)+":/usr/bin:/bin",
    DATABASE_URL: databaseUrl.href, SECRETS_PROVIDER: "env", HOME: resolve(out, "worker-home"),
    WORKER_JOB_LEASE_SECONDS: "10", WORKER_CONCURRENCY: "1",
    FINNOR_ENVIRONMENT: "ordinary_disposable", FINNOR_Y3_PROFILE: "ordinary_disposable",
    FINNOR_Y1_PROFILE: "ordinary_disposable", FINNOR_Z2_DISPOSABLE_REPLAY_WORKER: "1",
    FINNOR_Z2_EXCLUSIVE_REPLAY_DATABASE: "1", FINNOR_Z2_REPLAY_TENANT_ID: target.tenantId,
    FINNOR_Z2_REPLAY_WORK_IDS: JSON.stringify(target.cases.map(c => c.request.workId)),
    FINNOR_Z2_ENABLE_PHYSICAL_RECOVERY: boundary === null ? "0" : "1", FINNOR_Z2_RECOVERY_WORK_ID: workId,
    FINNOR_Z2_RECOVERY_BOUNDARY: boundary ?? "", FINNOR_Z2_RECOVERY_NONCE: nonce };
  for (const [name, path] of Object.entries({
    FINNOR_Z2_ASSET_ROOT: "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions",
    FINNOR_Z2_OWNER_ASSET_ROOT: "finnor-os/packages/private-equity/src/project-z/z2-coalitions",
    FINNOR_Y3_ASSET_ROOT: "finnor-os/packages/private-equity/src/interaction-synthesis",
    FINNOR_Y3_OWNER_ASSET_ROOT: "finnor-os/packages/private-equity/src/interaction-synthesis",
  })) {
    env[name] = resolve(target.sourceRoot, path);
  }
  assert.equal(env.FINNOR_ENVIRONMENT, "ordinary_disposable");
  assert.equal(env.FINNOR_Y3_PROFILE, "ordinary_disposable");
  assert.notEqual(env.NODE_ENV, "production");
  const log = await open(resolve(out, "worker-"+proof.steps.length+".restricted.log"), "wx", 0o600);
  replacement = spawn(process.execPath, ["--import", "tsx", resolve(target.sourceRoot, "finnor-os/apps/worker/src/index.ts")],
    { cwd: resolve(target.sourceRoot, "finnor-os"), env, stdio: ["ignore", log.fd, log.fd] });
  const spawned = new Promise((done, reject) => { replacement.once("spawn", done); replacement.once("error", reject); });
  await Promise.all([spawned, log.close()]);
  workerIdentity = await processIdentity(replacement.pid);
  record("same-build-worker-restart", { ...workerIdentity, boundary, environmentNames: Object.keys(env).sort() });
}
async function call(actor, operation, body, expected = [200, 202]) {
  assert(allowedOperation.test(operation));
  const response = await actor.context.request.post(target.origin+"/api/centropy/company-brain/"+operation,
    { headers: { authorization: actor.authorization }, data: body, timeout: 65000 });
  const value = await response.json();
  record(operation, { actor: actor.index, httpStatus: response.status(), ...safeProjection(value) });
  assert(expected.includes(response.status()));
  return value;
}
async function originalOracle(problem, candidate) {
  return new Promise((accept, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", "-B", resolve(target.sourceRoot, "finnor-os/scripts/project-z/z2/original-oracle.py")],
      { env: { NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0, failed = null;
    const chunks = [], stop = reason => {
      failed ??= reason;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => stop("Z2_ORIGINAL_ORACLE_DEADLINE"), 120000);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 8388608) stop("Z2_ORIGINAL_ORACLE_OUTPUT_BOUND"); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 8388608) stop("Z2_ORIGINAL_ORACLE_OUTPUT_BOUND"); });
    child.on("error", () => { failed ??= "Z2_ORIGINAL_ORACLE_START"; });
    child.stdin.on("error", () => { failed ??= "Z2_ORIGINAL_ORACLE_INPUT"; });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(Error(failed ?? "Z2_ORIGINAL_ORACLE_EXIT")); return; }
      try { accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Error("Z2_ORIGINAL_ORACLE_JSON")); }
    });
    child.stdin.end(JSON.stringify({ problem, candidate }));
  });
}
async function remainingOriginalBudget(owner, item, request, parentId, original) {
  assert.equal(target.authorization.consumeOriginalRemainingConstructionBudget, true);
  const maximum = original.counters.maxAttempts;
  assert.equal(maximum, 4);
  // The parent is durably complete. Do not pause each same-Work descendant at
  // the parent's deliberately selected recovery boundary.
  await restartWorker(null, request.workId, hash(randomUUID()));
  let occupied = original.counters.attempts;
  const descendants = [];
  for (let i = 0; i < maximum && occupied < maximum; i++) {
    const input = { ...request, parentProtocolId: parentId, idempotencyKey: randomUUID() };
    const submitted = await call(owner, "coalition-submit", input);
    const duplicate = await call(owner, "coalition-submit", input);
    assert.equal(duplicate.protocolId, submitted.protocolId); assert.equal(duplicate.replayed, true);
    const checked = await waitUntil("same-original-budget-descendant", () => call(owner, "interaction-read",
      { protocolId: submitted.protocolId }), value => value.status === "CHECKED" && value.current && value.artifact);
    const completed = await waitUntil("same-original-budget-delivery-completed", () => snapshot(submitted.protocolId, item.reservation.ref.id),
      value => value.jobs.length === 1 && value.jobs.every(j => j.status === "completed") &&
        value.deliveries.every(d => d.finished_at));
    assert.equal(checked.workId, request.workId); assert.equal(checked.workInputId, original.workInputId);
    assert.equal(checked.counters.episodeId, original.counters.episodeId);
    assert.equal(checked.counters.deadlineAt, original.counters.deadlineAt);
    assert.equal(checked.counters.attempts, occupied+1);
    assert.equal(completed.original.work_id, request.workId);
    assert.equal(completed.original.work_input_id, original.artifact.envelope.work.inputId);
    assert.equal(completed.original.work_input_digest, original.artifact.envelope.work.inputDigest);
    assert.equal(completed.original.episode_id, original.counters.episodeId);
    assert.equal(new Date(completed.original.deadline_at).toISOString(), original.counters.deadlineAt);
    assert(checked.counters.searchStepsOccupied <= 400000 && Number(checked.counters.retainedBytes) <= 33554432);
    assert.equal(checked.fallbackId, parentId);
    assert.deepEqual(checked.artifact.problem, request.problem);
    assert.equal(checked.artifact.coalition.originalRequestDigest, digest(input));
    const comparison = await call(owner, "interaction-compare", { protocolId: checked.protocolId });
    assert.equal(comparison.eligible, true); assert.equal(comparison.fallbackId, parentId);
    assert.equal(comparison.fallbackKind, "CURRENT_CHECKED_DYNAMIC_INCUMBENT");
    const independent = await originalOracle(request.problem, checked.artifact.body);
    assert(independent.reports.every(r => !r.profitable));
    assert.equal(digest(independent.utilities), item.expectedOriginalUtilitiesDigest);
    descendants.push({ protocolId: checked.protocolId, episodeId: checked.counters.episodeId,
      attempts: checked.counters.attempts, fallbackId: parentId, oracleDigest: digest(independent),
      original: completed.original, jobs: completed.jobs, deliveries: completed.deliveries,
      originalReservationDigest: digest(completed.reservation),
      costs: checked.artifact.envelope.costs });
    occupied = checked.counters.attempts;
  }
  assert.equal(occupied, maximum);
  const refusal = await call(owner, "coalition-submit",
    { ...request, parentProtocolId: parentId, idempotencyKey: randomUUID() }, [422]);
  assert.equal(refusal.code, "Z2_ORIGINAL_EPISODE_EXHAUSTED");
  const parent = await call(owner, "interaction-read", { protocolId: parentId });
  assert(parent.current && parent.status === "CHECKED");
  assert.equal(parent.counters.episodeId, original.counters.episodeId);
  assert.equal(parent.counters.deadlineAt, original.counters.deadlineAt);
  assert.equal(parent.counters.attempts, maximum);
  record("remaining-original-budget-and-current-checked-parent", {
    originalWorkId: request.workId, parentId, descendants, finalOriginalCounters: parent.counters,
    exactRefusal: refusal.code, directSqlMutations: false, newEpisodeOrReservation: false,
    parentTermsAndConsentUseFollowsWithoutNewConstruction: true });
}
async function readWork(actor, workId) {
  const response = await actor.context.request.get(target.origin+"/api/centropy/works/"+workId,
    { headers: { authorization: actor.authorization }, timeout: 22000 });
  assert.equal(response.status(), 200);
  const value = await response.json();
  assert.equal(value.work.work.id, workId);
  record("canonical-work-read", { actor: actor.index, workId, responseDigest: digest(value) });
  return value.work;
}
async function mount(actor, input, protocolId) {
  const url = new URL("/centropy/world", target.origin);
  url.searchParams.set("root", JSON.stringify(input.root));
  url.searchParams.set("workId", input.workId);
  url.searchParams.set("object", JSON.stringify({ namespace: "core", owner: "@finnor/db", type: "work", id: input.workId }));
  await actor.page.goto(url.href);
  const panel = actor.page.locator('[data-interaction-work="'+input.workId+'"]');
  await panel.waitFor({ state: "visible", timeout: 30000 });
  if (protocolId) {
    await actor.page.getByLabel("Interaction", { exact: true }).selectOption(protocolId);
    await panel.locator('[aria-label="Coalition incentive contract"]').waitFor({ state: "visible" });
    assert((await panel.innerText()).includes("Actual compliance: UNKNOWN"));
  }
  return panel;
}
try {
  const offline = args.includes("--validate-target");
  if ((!offline && (!args.includes("--execute-native") || process.env.FINNOR_Z2_DISPOSABLE_E2E !== "1")) || !args.includes("--target")) {
    proof.blockers = ["EXPLICIT_EXISTING_OWNED_DISPOSABLE_TARGET_AND_EXECUTION_AUTHORITY_REQUIRED",
      "REAL_PARTICIPANT_AUTH_ORIGINAL_WORK_MODELS_RESERVATION_AND_OWNED_WORKER_IDENTITIES_REQUIRED"];
    process.exitCode = 78;
  } else {
    const targetPath = resolve(option("--target"));
    assert(isAbsolute(option("--target")));
    const bytes = await readFile(targetPath);
    target = JSON.parse(bytes);
    proof.validationOnly = target.validationOnly === true;
    proof.executionAuthority = false;
    assert(offline || !proof.validationOnly, "Z2_OFFLINE_FIXTURE_NOT_EXECUTABLE");
    const schemaBytes = await readFile(resolve(dirname(here), "native-replay-target.schema.json"));
    targetShape(JSON.parse(schemaBytes), target);
    assert.equal(target.schema, "finnor.project-z.z2.native-replay-target.v1");
    if (!proof.validationOnly) assert(target.authorization.explicitDisposableExecution === true &&
      target.authorization.noDatabaseInitialization === true && target.authorization.noGrantsOrProvisioning === true &&
      target.authorization.noExternalOrFinancialEffects === true && target.authorization.realAuthOnly === true &&
      target.authorization.exclusiveNativeReplayDatabase === true &&
      target.authorization.consumeOriginalRemainingConstructionBudget === true &&
      target.authorization.leaveOwnedWorkerStoppedAfterReplay === true);
    assert(Date.parse(target.authorization.expiresAt) > Date.now());
    assert(isAbsolute(target.buildReceiptPath));
    target.origin = loopback(target.origin); loopback(target.apiOrigin);
    assert.equal(target.frontendAuthIssuer, target.apiAuthIssuer);
    assert(/^https:\/\//.test(target.frontendAuthIssuer));
    assert(isAbsolute(target.sourceRoot) && target.actors.length >= 2 && target.actors.length <= 4 &&
      target.cases.length >= 4 && target.cases.length <= 256);
    target.sourceRoot = await realpath(target.sourceRoot);
    assert(new Set(target.actors.map(a => a.principalId)).size === target.actors.length);
    assert.deepEqual([...new Set(target.cases.map(c => c.recovery))].sort(), ["ARTIFACT", "CHECKPOINT", "CLAIM", "PARTIAL_CONSENT"]);
    for (const [path, expected] of Object.entries(target.sourceSha256)) {
      assert(!isAbsolute(path) && !relative(target.sourceRoot, resolve(target.sourceRoot, path)).startsWith(".."));
      assert(!path.split("/").some(name => name.startsWith(".env")) && !path.includes("JARVIS-CREDENTIALS-LEDGER.md"));
      assert(!path.startsWith("docs/centropy/evidence/"));
      const actual = await realpath(resolve(target.sourceRoot, path));
      assert(!relative(target.sourceRoot, actual).startsWith(".."));
      assert.equal(hash(await readFile(actual)), expected);
    }
    assert.equal(target.sourceSha256["finnor-os/scripts/project-z/z2/native-replay.mjs"], proof.driverSha256);
    for (const item of target.cases) {
      assert(/^[a-z0-9-]{1,64}$/.test(item.id));
      assert.equal(item.originalRequestDigest, digest(item.request));
      assert(/^[a-f0-9]{64}$/.test(item.expectedOriginalUtilitiesDigest));
      assert(item.actionByInformationKey && item.reservation.ref && item.reservation.expectedRevision > 0);
      assert(/^[a-f0-9]{64}$/.test(item.expectedInternalEffectDigest));
      assert(["NO_EFFECT", "RIGHT_TRANSITION"].includes(item.expectedInternalEffectKind) && Array.isArray(item.canonicalObservations));
      assert(!Object.hasOwn(item.request, "parentProtocolId"));
      assert(item.canonicalObservations.every(o => Number.isInteger(o.actorIndex) && o.actorIndex >= 0 &&
        o.actorIndex < target.actors.length && o.observation.classification === "SOURCED_FACT" && o.observation.source));
    }
    const environmentNames = [target.database.environmentName,
      ...target.actors.flatMap(a => [a.emailEnvironmentName, a.passwordEnvironmentName])];
    assert(environmentNames.every(name => /^[A-Z][A-Z0-9_]{0,127}$/.test(name)));
    assert.equal(new Set(environmentNames).size, environmentNames.length);
    assert.equal(new Set(target.cases.map(c => c.request.workId)).size, target.cases.length);
    assert.equal(new Set(target.cases.map(c => c.id)).size, target.cases.length);
    assert.equal(new Set(target.preexistingNegativeCases.map(n => n.kind)).size, 6);
    assert(target.preexistingNegativeCases.every(n => n.actorIndex < target.actors.length && allowedOperation.test(n.operation)));
    for (const negative of target.preexistingNegativeCases) {
      const readsUnverified = ["UNSUPPORTED", "INCOMPLETE"].includes(negative.kind) && negative.operation === "interaction-read";
      if (readsUnverified) {
        assert.equal(negative.expectedCodeOrStatus, negative.kind);
        assert(negative.httpStatuses.every(code => code === 200) && typeof negative.input.protocolId === "string");
      } else {
        assert(negative.httpStatuses.every(code => [403, 404, 409, 413, 422, 429].includes(code)));
        assert(["interaction-read", "interaction-local", "interaction-run-read", "interaction-artifact",
          "interaction-admit", "interaction-terms", "interaction-start", "interaction-action",
          "interaction-materialize", "interaction-resume"].includes(negative.operation) ||
          negative.kind === "RESOURCE_BOUND" && negative.operation === "coalition-submit");
      }
    }
    const buildBytes = await readFile(target.buildReceiptPath);
    assert.equal(hash(buildBytes), target.buildReceiptSha256);
    build = JSON.parse(buildBytes);
    assert.equal(build.schema, "finnor.project-z.z2.whole-owner-install.v1");
    assert.equal(build.engineeringStatus, "PASSED");
    assert.equal(build.sourceDigest, digest(target.sourceSha256));
    assert.equal(Object.keys(target.sourceSha256).length, build.sourceFileCount);
    assert.equal(target.sourceSha256["finnor-os/scripts/project-z/z2/native-replay-target.schema.json"], hash(schemaBytes));
    assert.equal(target.sourceRoot, await realpath(build.installedRoot));
    assert.equal(build.borrowedNodeModules, false); assert.equal(build.sourceFallbackUsed, false);
    assert.equal(build.parentGitDiscoveryBlocked, true);
    assert.equal(build.sourceBuildMetadataVerified, true);
    assert.equal(target.sourceSha256[".z2-source-build.json"], build.sourceBuildMetadataSha256);
    assert.equal(build.browser.proofStatus, "PASSED");
    assert.equal(hash(await readFile(process.execPath)), build.node.sha256);
    for (const directory of [target.sourceRoot, resolve(target.sourceRoot, "finnor-os"),
      resolve(target.sourceRoot, "finnor-os/apps/api")])
      assert((await readdir(directory)).every(name => !name.startsWith(".env")), "Z2_ENV_FILE_FREE_INSTALLED_TARGET_REQUIRED");
    const outputManifest = JSON.parse(await readFile(resolve(dirname(target.buildReceiptPath), "build-output-sha256.json"), "utf8"));
    assert.equal(digest(outputManifest), build.buildOutputsDigest);
    for (const [path, expected] of Object.entries(outputManifest)) {
      const actual = await realpath(resolve(dirname(target.buildReceiptPath), path));
      assert(!relative(target.sourceRoot, actual).startsWith(".."));
      assert.equal(hash(await readFile(actual)), expected);
    }
    let traceInventory;
    for (const [name, expectedDigest] of [
      ["installed-native-asset-sha256.json", build.nativeAssetsDigest],
      ["installed-browser-asset-sha256.json", build.browser.assetsDigest],
      ["installed-trace-closure-sha256.json", build.traceClosureDigest]]) {
      const inventory = JSON.parse(await readFile(resolve(dirname(target.buildReceiptPath), name), "utf8"));
      assert.equal(digest(inventory), expectedDigest);
      if (name === "installed-browser-asset-sha256.json") {
        assert(Object.keys(inventory).length > 0 && Object.keys(inventory).length === build.browser.assetFileCount);
        const browserRoot = await realpath(build.browser.assetRoot), executable = await realpath(build.browser.executablePath);
        assert(!relative(target.sourceRoot, browserRoot).startsWith("..") && !relative(browserRoot, executable).startsWith(".."));
        assert.equal(inventory[relative(target.sourceRoot, executable)], build.browser.executableSha256);
        const packagePath = await realpath(build.browser.playwrightPackagePath);
        assert(!relative(target.sourceRoot, packagePath).startsWith(".."));
        assert.equal(hash(await readFile(packagePath)), build.browser.playwrightPackageSha256);
      }
      if (name === "installed-trace-closure-sha256.json") traceInventory = inventory;
      for (const [path, expected] of Object.entries(inventory)) {
        const actual = await realpath(resolve(target.sourceRoot, path));
        assert(!relative(target.sourceRoot, actual).startsWith(".."));
        assert.equal(hash(await readFile(actual)), expected);
      }
    }
    for (const [path, expected] of Object.entries(build.traceDirectoryEntries)) {
      const directory = await realpath(resolve(target.sourceRoot, path)), pending = [directory], files = {};
      assert(!relative(target.sourceRoot, directory).startsWith("..") && (await stat(directory)).isDirectory());
      let visited = 0;
      while (pending.length) {
        const parent = pending.pop();
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          assert(++visited <= 100000 && !entry.isSymbolicLink(), "Z2_TRACED_DIRECTORY_CLOSED_BOUND");
          const actual = resolve(parent, entry.name);
          if (entry.isDirectory()) pending.push(actual);
          else {
            assert(entry.isFile());
            const key = relative(target.sourceRoot, actual);
            assert(Object.hasOwn(traceInventory, key), "Z2_UNDECLARED_TRACED_DIRECTORY_FILE");
            files[key] = traceInventory[key];
          }
        }
      }
      assert(Object.keys(files).length > 0 && Object.keys(files).length === expected.fileCount);
      assert.equal(digest(files), expected.filesDigest);
    }
    const systemLibraries = JSON.parse(await readFile(resolve(dirname(target.buildReceiptPath), "installed-system-library-sha256.json"), "utf8"));
    assert.equal(digest(systemLibraries), build.systemLibrariesDigest);
    assert(Object.keys(systemLibraries).length > 0 && Object.keys(systemLibraries).length === build.systemLibraryCount);
    for (const [path, expected] of Object.entries(systemLibraries)) {
      const actual = await realpath(path);
      assert(isAbsolute(path) && ["/usr/lib/", "/lib/", "/usr/local/lib/"].some(prefix => actual.startsWith(prefix)) &&
        /\.so(?:\.|$)/.test(actual), "Z2_DECLARED_SYSTEM_LIBRARY_REQUIRED");
      assert.equal(hash(await readFile(actual)), expected);
    }
    proof.targetSha256 = hash(bytes); proof.sourceDigest = build.sourceDigest; proof.buildReceiptSha256 = hash(buildBytes);
    await save();
    if (offline) {
      proof.status = "VALIDATED_TARGET_BYTES_NOT_EXECUTED";
      proof.servicesStarted = false; proof.databaseOrAuthAccess = false;
      proof.blockers = ["NATIVE_EXECUTION_HAS_NOT_BEEN_REQUESTED", "LIVE_AUTHORITY_AND_PROCESS_IDENTITY_NOT_VALIDATED_OFFLINE"];
    } else {
    assert(environmentNames.every(name => typeof process.env[name] === "string" && process.env[name].length > 0));
    proof.status = "RUNNING";
    await save();
    databaseUrl = new URL(process.env[target.database.environmentName] ?? "");
    const dbUrl = databaseUrl;
    assert(["127.0.0.1", "localhost", "[::1]"].includes(dbUrl.hostname));
    assert.equal(dbUrl.hostname, target.database.host);
    assert.equal(Number(dbUrl.port || "5432"), target.database.port);
    assert.equal(dbUrl.pathname.slice(1), target.database.name);
    assert.notEqual(dbUrl.pathname, "/postgres");
    const require = createRequire(resolve(target.sourceRoot, "finnor-os/package.json"));
    const pg = require("pg");
    db = new pg.Client({ connectionString: dbUrl.href, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    proof.databaseOrAuthAccess = true;
    await db.connect();
    const role = (await db.query(`SELECT current_database() name,r.rolsuper,r.rolbypassrls,
      pg_has_role(current_user,'finnor_worker','USAGE') worker_queue_authority FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
    assert.equal(role.name, target.database.name); assert(!role.rolsuper && !role.rolbypassrls && role.worker_queue_authority);
    record("existing-canonical-worker-database-authority", { databaseNameDigest: hash(role.name),
      nonSuperuser: true, nonBypassRls: true, existingWorkerQueueAuthority: true, grantsExecuted: false });
    const unrelated = await sql(`SELECT count(*)::int count FROM finnor_os.jobs j
      WHERE j.status IN('queued','running','failed','dead_letter') AND
      (j.tenant_id IS DISTINCT FROM $1 OR j.type<>'construct_interaction_protocol_v1' OR NOT EXISTS(
        SELECT 1 FROM finnor_os.y3_requests r WHERE r.tenant_id=j.tenant_id AND r.id::text=j.payload->>'protocolId'
        AND r.work_id=ANY($2::uuid[])))`, [target.tenantId, target.cases.map(c => c.request.workId)]);
    assert.equal(unrelated[0].count, 0);
    const fresh = await sql(`SELECT count(*)::int count FROM finnor_os.y3_requests
      WHERE tenant_id=$1 AND work_id=ANY($2::uuid[])`, [target.tenantId, target.cases.map(c => c.request.workId)]);
    assert.equal(fresh[0].count, 0, "Z2_FRESH_ORIGINAL_WORKS_WITHOUT_EXISTING_PROTOCOLS_REQUIRED");
    assert.equal(target.worker.coupledSupervisor, false);
    await mkdir(resolve(out, "worker-home"), { mode: 0o700 });
    workerIdentity = await processIdentity(target.worker.pid);
    assert.equal(workerIdentity.startTicks, target.worker.startTicks);
    assert.equal(workerIdentity.cmdlineSha256, target.worker.cmdlineSha256);
    record("initial-owned-worker-identity", workerIdentity);
    for (const kind of ["frontend", "api"]) {
      const identity = await processIdentity(target.processes[kind].pid, kind);
      assert.equal(identity.startTicks, target.processes[kind].startTicks);
      assert.equal(identity.cmdlineSha256, target.processes[kind].cmdlineSha256);
      record("owned-installed-"+kind+"-identity", identity);
      record("owned-installed-"+kind+"-listener", await ownedListener(identity.pid, kind === "api" ? target.apiOrigin : target.origin));
      const release = await fetch((kind === "api" ? target.apiOrigin : target.origin)+"/api/release",
        { redirect: "error", signal: AbortSignal.timeout(10000) });
      assert.equal(release.status, 200);
      assert.equal(release.headers.get("x-finnor-build-id"), build.buildIds[kind]);
      const metadata = await release.json();
      assert.equal(metadata.environment, "ordinary_disposable");
      record("installed-"+kind+"-release", { buildId: build.buildIds[kind], responseDigest: digest(metadata) });
    }
    const { chromium } = await import(pathToFileURL(require.resolve("playwright")).href);
    const browserHome = resolve(out, "browser-home"), browserTmp = resolve(browserHome, "tmp");
    await mkdir(browserTmp, { recursive: true, mode: 0o700 });
    const browserEnv = { HOME: browserHome, TMPDIR: browserTmp, PATH: dirname(process.execPath)+":/usr/bin:/bin",
      NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    browser = await chromium.launch({ headless: true, executablePath: build.browser.executablePath, env: browserEnv,
      args: ["--disable-background-networking", "--disable-component-update"] });
    record("explicit-installed-browser", { executableSha256: build.browser.executableSha256,
      browserAssetsDigest: build.browser.assetsDigest, playwrightVersion: build.browser.playwrightVersion,
      environmentNames: Object.keys(browserEnv).sort(), inheritedSecrets: false, transport: "PIPE_NO_LISTENER" });
    const allowed = new Set([target.origin, target.apiOrigin, new URL(target.frontendAuthIssuer).origin]);
    for (const [index, actor] of target.actors.entries()) {
      const context = await browser.newContext({ serviceWorkers: "block" }), page = await context.newPage();
      clients.push({ context, page, index });
      await context.addInitScript(() => {
        for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"])
          Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
      });
      await context.routeWebSocket("**/*", socket => socket.close());
      await context.route("**/*", route => allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort());
      await page.goto(target.origin+"/centropy/login");
      await page.getByLabel("Email", { exact: true }).fill(process.env[actor.emailEnvironmentName] ?? "");
      await page.getByLabel("Password", { exact: true }).fill(process.env[actor.passwordEnvironmentName] ?? "");
      const meWait = page.waitForResponse(r => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      const response = await meWait, me = await response.json();
      assert.equal(response.status(), 200); assert.equal(me.tenantId, target.tenantId);
      assert.equal(me.userId, actor.userId); assert.equal(me.employeeId ?? me.userId, actor.principalId);
      assert.equal(me.role, "owner"); // Existing native S5 requires real owner-role participants.
      const authorization = await response.request().headerValue("authorization");
      assert(authorization?.startsWith("Bearer "));
      const claims = JSON.parse(Buffer.from(authorization.slice(7).split(".")[1], "base64url"));
      assert.equal(claims.iss, target.frontendAuthIssuer);
      Object.assign(clients[index], { authorization });
      record("real-authenticated-participant", { actor: index, tenantId: me.tenantId, principalId: actor.principalId });
    }
    proof.authenticatedOwner = "PASSED";
    await save();
    for (const item of target.cases) {
      const input = item.request, owner = clients[0], nonce = hash(randomUUID());
      const caseActors = input.problem.participants.map(p => clients[target.actors.findIndex(a => a.principalId === p.principalId)]);
      assert.equal(digest(input), item.originalRequestDigest);
      assert(input.problem.participants.every(p => target.actors.some(a => a.principalId === p.principalId)));
      assert.equal(input.problem.participants[0].principalId, target.actors[0].principalId);
      assert.equal(item.expectedOriginalUtilitiesDigest.length, 64);
      await readWork(owner, input.workId);
      await restartWorker(item.recovery, input.workId, nonce);
      const panel = await mount(owner, input);
      await panel.getByText("Construct from original models and fixed meanings", { exact: true }).click();
      await panel.getByLabel("Require ex-ante correlated coalition checks").check();
      await panel.getByLabel("Original problem, fixed Y1 lowering and canonical source bindings JSON").fill(JSON.stringify(input));
      const submittedWait = owner.page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/company-brain/coalition-submit"));
      await panel.getByRole("button", { name: "Queue coalition-resilient synthesis", exact: true }).click();
      const submitted = await submittedWait; assert.equal(submitted.status(), 202);
      const actualRequest = submitted.request().postDataJSON(), { idempotencyKey: _actualKey, ...actualMeaning } = actualRequest,
        { idempotencyKey: _frozenKey, ...expectedMeaning } = input;
      assert.deepEqual(actualMeaning, expectedMeaning);
      assert.equal(typeof actualRequest.idempotencyKey, "string");
      record("mounted-original-submission", { requestDigest: digest(actualRequest),
        frozenRequestDigest: item.originalRequestDigest, mountedFreshIdempotencyRecorded: true,
        originalProblemDigest: digest(input.problem), originalWorkId: input.workId });
      const submittedBody = await submitted.json(), protocolId = submittedBody.protocolId;
      assert(protocolId);
      const baseline = await snapshot(protocolId, item.reservation.ref.id);
      assert(baseline.original && baseline.reservation.length === 1);
      assert.equal(baseline.reservation[0].revision, item.reservation.expectedRevision);
      if (item.recovery !== "PARTIAL_CONSENT") {
        const pause = await waitUntil("durable-recovery-boundary", () => sql(`SELECT body FROM finnor_os.y3_events
          WHERE tenant_id=$1 AND protocol_id=$2 AND kind='Z2_PHYSICAL_RECOVERY_BOUNDARY' AND body->>'boundary'=$3`,
        [target.tenantId, protocolId, item.recovery]), rows => rows.length === 1);
        record("durable-native-boundary", pause[0].body);
        await waitUntil("stopped-owned-worker", () => processIdentity(workerIdentity.pid), p => ["T", "t"].includes(p.state));
        await restartWorker(item.recovery, input.workId, nonce, true);
      }
      const result = await waitUntil("checked-native-artifact", () => call(owner, "interaction-read", { protocolId }),
        r => r.status === "CHECKED" && r.artifact && r.current);
      assert.equal(result.workId, input.workId); assert.equal(result.counters.episodeId, baseline.original.episode_id);
      assert.equal(result.counters.deadlineAt, new Date(baseline.original.deadline_at).toISOString());
      assert(result.counters.attempts <= 4 && result.counters.searchStepsOccupied <= 400000);
      assert.equal(result.artifact.coalition.problemDigest, digest(input.problem));
      assert.equal(result.artifact.coalition.originalRequestDigest, digest(actualRequest));
      assert.equal(result.artifact.coalition.check.status, "CHECKED_CANDIDATE");
      await waitUntil("fenced-native-delivery-completed", () => snapshot(protocolId, item.reservation.ref.id),
        s => s.jobs.length > 0 && s.jobs.every(j => j.status === "completed") && s.deliveries.every(d => d.finished_at));
      const expected = await originalOracle(input.problem, result.artifact.body);
      assert.equal(digest(expected.utilities), item.expectedOriginalUtilitiesDigest);
      assert.equal(expected.reports.length, input.problem.models.length*(2**input.problem.participants.length-1));
      assert(expected.reports.every(r => !r.profitable));
      record("independent-original-semantic-oracle", { exitCode: 0, reportDigest: digest(expected), coalitionsChecked: expected.reports.length });
      await call(owner, "interaction-admit", { protocolId });
      await remainingOriginalBudget(owner, item, actualRequest, protocolId, result);
      const terms = await call(owner, "interaction-terms", { protocolId, reservationRef: item.reservation.ref,
        expectedRevision: item.reservation.expectedRevision, idempotencyKey: randomUUID() });
      assert(terms.coalition && terms.executionAuthorityGranted === false);
      const works = [];
      for (const participant of input.problem.participants) {
        const actor = clients[target.actors.findIndex(a => a.principalId === participant.principalId)];
        await mount(actor, input, protocolId);
        const accept = { protocolId, termsRef: terms.ref, scope: "TERMS", subjectDigest: terms.ref.contentDigest,
          decision: "ACCEPT", idempotencyKey: randomUUID() };
        const accepted = await call(actor, "interaction-consent", accept);
        const replayed = await call(actor, "interaction-consent", accept);
        assert.equal(accepted.participantWork.workId, replayed.participantWork.workId);
        await readWork(actor, accepted.participantWork.workId);
        works.push(accepted.participantWork.workId);
        const local = await call(actor, "interaction-local", { protocolId });
        assert.equal(local.participant, participant.id); assert.equal(local.privateModelDataIncluded, false);
        assert.equal(local.participantWork.workId, accepted.participantWork.workId);
        assert(!JSON.stringify(local.terms).includes('"payoff"'));
        if (works.length === 1) {
          await call(owner, "interaction-start", { protocolId, termsRef: terms.ref, idempotencyKey: randomUUID() }, [409, 422]);
          if (item.recovery === "PARTIAL_CONSENT") {
            await restartWorker(item.recovery, input.workId, nonce);
            const recovered = await call(actor, "interaction-consent", accept);
            assert.equal(recovered.consent.consentId, accepted.consent.consentId);
            assert.equal(recovered.participantWork.workId, accepted.participantWork.workId);
            await readWork(actor, recovered.participantWork.workId);
          }
        }
        await actor.page.reload();
        await mount(actor, input, protocolId);
        const shot = await actor.page.locator('[aria-label="Coalition incentive contract"]').screenshot();
        await writeFile(resolve(out, item.id+"-participant-"+actor.index+".png"), shot, { mode: 0o600, flag: "wx" });
        record("mounted-work-reloaded", { workId: input.workId, participantWorkId: accepted.participantWork.workId, screenshotSha256: hash(shot) });
      }
      assert.equal(new Set(works).size, input.problem.participants.length);
      const run = await call(owner, "interaction-start", { protocolId, termsRef: terms.ref, idempotencyKey: randomUUID() });
      assert(run.runId);
      const observed = new Set();
      for (let step = 0; step < 256; step++) {
        const views = await Promise.all(caseActors.map(a => call(a, "interaction-run-read", { runId: run.runId })));
        if (views.every(v => v.local?.status === "TERMINAL")) break;
        let acted = false;
        for (const [index, view] of views.entries()) {
          const local = view.local;
          if (!local?.actions?.length) continue;
          const actionId = item.actionByInformationKey[local.informationKey];
          assert(local.actions.some(a => a.id === actionId));
          await call(caseActors[index], "interaction-action", { runId: run.runId, expectedRevision: local.revision,
            viewDigest: local.viewDigest, actionId, idempotencyKey: randomUUID() });
          acted = true; break;
        }
        if (!acted) for (const [index, view] of views.entries()) {
          const actor = caseActors[index], local = view.local;
          const next = item.canonicalObservations.find((o, i) => !observed.has(i) && o.actorIndex === actor.index &&
            (!o.whenStatus || o.whenStatus === local?.status) &&
            (local?.missingCanonicalObservationKeys?.includes(o.observation.key) || local?.status === "NEEDS_LAWFUL_OBSERVATION"));
          if (!next) continue;
          await call(actor, "interaction-observe", { ...next.observation, runId: run.runId,
            expectedRevision: local.revision, idempotencyKey: randomUUID() });
          observed.add(item.canonicalObservations.indexOf(next)); acted = true; break;
        }
        if (!acted) {
          const dates = views.filter(v => v.local?.status === "WAITING_ORIGINAL_DATE").map(v => Date.parse(v.local.notBefore));
          const nextDate = Math.min(...dates), deadline = Date.parse(result.counters.deadlineAt);
          if (Number.isFinite(nextDate) && nextDate > Date.now() && nextDate < deadline) {
            const before = Date.now();
            await waitUntil("original-date-within-original-deadline", async () => Date.now(), now => now >= nextDate,
              Math.min(180000, deadline-Date.now()));
            record("original-date-wait", { wallMs: Date.now()-before, originalDate: new Date(nextDate).toISOString(),
              originalDeadline: result.counters.deadlineAt, newBudget: false });
            step--; continue;
          }
        }
        assert(acted, "Z2_CANONICAL_OBSERVATION_OR_ORIGINAL_DATE_REQUIRED");
        if (step === 255) throw Error("Z2_ORIGINAL_HISTORY_BOUND");
      }
      const beforeWithdrawal = await call(owner, "interaction-run-read", { runId: run.runId });
      assert(beforeWithdrawal.current && beforeWithdrawal.intent);
      assert.equal(digest(beforeWithdrawal.intent.effect), item.expectedInternalEffectDigest);
      assert.equal(beforeWithdrawal.intent.effect.kind, item.expectedInternalEffectKind);
      await call(owner, "interaction-materialize", { runId: run.runId, intentRef: beforeWithdrawal.intent.ref,
        idempotencyKey: randomUUID() }, [409, 422]);
      for (const actor of caseActors) {
        const accept = { protocolId, termsRef: terms.ref, scope: "EFFECT",
          subjectDigest: beforeWithdrawal.intent.ref.contentDigest, decision: "ACCEPT", idempotencyKey: randomUUID() };
        const accepted = await call(actor, "interaction-consent", accept);
        const replay = await call(actor, "interaction-consent", accept);
        assert.equal(accepted.consent.consentId, replay.consent.consentId);
      }
      const lower = { runId: run.runId, intentRef: beforeWithdrawal.intent.ref, idempotencyKey: randomUUID() };
      const materialized = await call(owner, "interaction-materialize", lower);
      const duplicateLower = await call(owner, "interaction-materialize", lower);
      if (item.expectedInternalEffectKind === "NO_EFFECT") {
        assert.equal(materialized.status, "MODEL_TERMINAL_NO_EFFECT");
        assert.equal(materialized.programmeId, null); assert.equal(duplicateLower.programmeId, null);
        assert.equal(materialized.observedEconomicOutcome, false);
      } else {
        assert.equal(typeof materialized.programmeId, "string");
        assert.equal(duplicateLower.programmeId, materialized.programmeId);
        const prepared = await call(owner, "economic-programme-read", { programmeId: materialized.programmeId });
        assert.equal(prepared.programme.id, materialized.programmeId);
        assert.equal(prepared.programme.workId, input.workId);
        assert.equal(prepared.programme.steps.length, 1); assert.equal(prepared.obligations.length, 0);
        assert.equal(prepared.status, "PREPARED");
        const { kind: _kind, ...expectedStep } = beforeWithdrawal.intent.effect;
        const actualStep = prepared.programme.steps[0];
        assert.deepEqual({ operatorId: actualStep.operatorId, parameters: actualStep.parameters,
          before: actualStep.before, after: actualStep.after }, expectedStep);
        assert.equal(prepared.programme.theoryId, input.lowering.theoryId);
        assert.deepEqual(prepared.programme.ref, materialized.programmeRef);
        assert.deepEqual(prepared.programme.reservationRef, item.reservation.ref);
        assert.equal(prepared.reservationRevision, item.reservation.expectedRevision);
        assert.deepEqual(prepared.currentRightState, beforeWithdrawal.intent.effect.before);
      }
      record("original-terms-effect-consents-and-undispatched-owner-consumption", {
        runId: run.runId, termsRef: terms.ref, exactIntentRef: beforeWithdrawal.intent.ref,
        effectKind: item.expectedInternalEffectKind, programmeId: materialized.programmeId,
        duplicateLowerRetainedOriginalIdentity: true, internalTransition: "NOT_DISPATCHED",
        s6ActualObservation: "UNKNOWN", financialOutcome: "NOT_ESTABLISHED" });
      await call(owner, "interaction-consent", { protocolId, termsRef: terms.ref, scope: "TERMS",
        subjectDigest: terms.ref.contentDigest, decision: "WITHDRAW", idempotencyKey: randomUUID() });
      const withdrawn = await call(owner, "interaction-run-read", { runId: run.runId });
      assert.equal(withdrawn.current, false); assert.equal(withdrawn.status, "INVALIDATED_RESPONSIBILITY_RETAINED");
      await call(owner, "interaction-start", { protocolId, termsRef: terms.ref, idempotencyKey: randomUUID() }, [409, 422]);
      const after = await snapshot(protocolId, item.reservation.ref.id);
      assert.equal(after.original.work_input_id, baseline.original.work_input_id);
      assert.equal(after.original.work_input_digest, baseline.original.work_input_digest);
      assert.deepEqual(after.reservation, baseline.reservation);
      assert(after.original.attempts_used >= baseline.original.attempts_used && after.original.attempts_used <= 4);
      if (item.recovery !== "PARTIAL_CONSENT") {
        assert(after.deliveries.length >= 2);
        assert(BigInt(after.deliveries.at(-1).claim_fence) > BigInt(after.deliveries[0].claim_fence));
        assert(after.deliveries.slice(0, -1).every(d => d.finished_at));
      }
      record("original-budget-fences-and-responsibility", { before: baseline, after, effectDispatch: "NOT_AUTHORIZED_NOT_RUN",
        s6ActualCompliance: "UNKNOWN", s7Costs: result.artifact.envelope.costs });
      await save();
    }
    for (const negative of target.preexistingNegativeCases) {
      assert(["STALE_SOURCE", "REVOKED_RIGHTS", "CROSS_TENANT", "RESOURCE_BOUND", "UNSUPPORTED", "INCOMPLETE"].includes(negative.kind));
      const actor = clients[negative.actorIndex], value = await call(actor, negative.operation, negative.input, negative.httpStatuses);
      assert.equal(value.code ?? value.status, negative.expectedCodeOrStatus);
      if (["UNSUPPORTED", "INCOMPLETE"].includes(negative.kind) && negative.operation === "interaction-read") {
        const refusal = await call(actor, "interaction-admit", { protocolId: negative.input.protocolId }, [422]);
        assert(["Y3_CURRENT_CHECKED_PROTOCOL_REQUIRED", "Z2_CURRENT_INDEPENDENT_CERTIFICATE_REQUIRED"].includes(refusal.code));
        record("unverified-native-owner-use-refused", { protocolId: negative.input.protocolId, code: refusal.code });
      }
      record("native-negative-"+negative.kind, { responseDigest: digest(value), expected: negative.expectedCodeOrStatus,
        fixtureKindProvenance: "OPERATOR_SUPPLIED_PREEXISTING_TARGET_NOT_INDEPENDENT_CUSTODY" });
    }
    assert.equal(new Set(target.preexistingNegativeCases.map(n => n.kind)).size, 6);
    proof.status = "PASSED"; proof.mountedWork = "PASSED"; proof.physicalRecovery = "PASSED";
    proof.installedOwnerExecution = "PASSED";
    proof.nativeConsumerScope = "EXACT_TERMS_EFFECT_CONSENTS_UNDISPATCHED_NATIVE_MATERIALIZATION";
    proof.s6AmbiguousEffectRecovery = "NOT_RUN";
    proof.nativeEightObligationQualification = "INCOMPLETE";
    proof.scope = "AUTHENTICATED_NATIVE_NO_EFFECT_ENGINEERING_NOT_FULL_QUALIFICATION";
    }
  }
} catch (error) {
  proof.status = "FAILED";
  proof.failure = /^Z2_[A-Z0-9_:-]+$/.test(error.message ?? "") ? error.message : "Z2_NATIVE_REPLAY_ASSERTION_OR_RUNTIME_FAILURE";
  proof.failureCode = error.code ?? null;
  process.exitCode = 1;
} finally {
  for (const actor of clients) await actor.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await db?.end().catch(() => {});
  if (Number.isInteger(replacement?.pid) && replacement.exitCode === null && replacement.signalCode === null) {
    try {
      const current = await processIdentity(replacement.pid);
      if (current.startTicks === workerIdentity?.startTicks) {
        if (["T", "t"].includes(current.state)) process.kill(current.pid, "SIGCONT");
        replacement.kill("SIGTERM");
        await Promise.race([new Promise(done => replacement.once("exit", done)), delay(5000)]);
        if (replacement.exitCode === null && replacement.signalCode === null) replacement.kill("SIGKILL");
        if (replacement.exitCode === null && replacement.signalCode === null)
          await Promise.race([new Promise(done => replacement.once("exit", done)), delay(5000)]);
        assert(replacement.exitCode !== null || replacement.signalCode !== null, "Z2_OWNED_REPLACEMENT_EXIT_NOT_OBSERVED");
        record("replacement-worker-cleanup", { pid: replacement.pid, signal: replacement.signalCode,
          originalListenersUntouched: true, databaseAndResponsibilityRetained: true });
      }
    } catch (error) { if (error.code !== "ENOENT") {
      proof.cleanup = "UNRESOLVED_OWNED_REPLACEMENT"; proof.status = "FAILED"; process.exitCode = 1;
    } }
  }
  const cpu = process.cpuUsage(cpuStart);
  proof.costs = { wallMs: performance.now()-started, driverCpuMs: (cpu.user+cpu.system)/1000,
    driverPeakRssBytes: process.resourceUsage().maxRSS*1024, aggregatePeakMemoryBytes: null,
    moneyUsd: null, humanSeconds: null, status: "PARTIALLY_METERED",
    workerBrowserAndOracleAggregateCostsNotFullyAttributed: true };
  proof.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ status: proof.status, authenticatedOwner: proof.authenticatedOwner,
    physicalRecovery: proof.physicalRecovery, report: resolve(out, "report.json") }));
}
