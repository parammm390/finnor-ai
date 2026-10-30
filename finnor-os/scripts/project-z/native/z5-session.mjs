/**
 * Z5 native institution-linker scenario. Launcher profiles `x1,z5`, started with --no-worker so this
 * scenario owns the stock worker used to build the original X1 parents (stopped before the driver) and the
 * driver owns the only Z5 worker.
 *
 * Every stage records its own PASS/FAIL/NOT_RUN. A failed stage never stops later independent stages and is
 * never retried silently. Nothing is written to owner tables here except the disposable identities that the
 * launcher itself seeds the same way (second tenant/owner row, S3 evidence inputs through owner libraries);
 * owner rows for the Z5 chain come from authenticated HTTP, owner libraries and the real processes.
 */
import { createHash, createPrivateKey, randomUUID, sign as edSign } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readNativeEnvironment, signInOwner, startOwnedWorker, createOriginalInstitutionParent, API_ORIGIN } from "./x1-origin-fixture.mts";

const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("Z5_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../../../..");
const BACKEND = join(ROOT, "finnor-os");
const RUN = basename(state);
const env = readNativeEnvironment(state);
const privateRoot = join(state, "z5-private");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
const RIGHTS = "s5-owner-rights";
const sha = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SENSITIVE = /token|secret|password|authorization|apikey|credential|privatekey/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
};
let sequence = 0;
const record = (name, value) => {
  const path = join(evidence, `z5-${String(++sequence).padStart(3, "0")}-${name}.json`);
  writeFileSync(path, JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
};
const results = [];
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const detail = await body();
    results.push({ id, title, outcome: detail?.outcome ?? "PASS", started, detail: redact(detail?.detail ?? detail ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, error: String(error?.stack ?? error?.message ?? error).slice(0, 1500) });
  }
  record("case-" + id, results.at(-1));
  console.log(JSON.stringify({ case: id, outcome: results.at(-1).outcome, error: results.at(-1).error?.slice(0, 300) }));
  return results.at(-1).outcome;
}
const notRun = (id, title, reason) => { results.push({ id, title, outcome: "NOT_RUN", reason }); record("case-" + id, results.at(-1)); console.log(JSON.stringify({ case: id, outcome: "NOT_RUN", reason })); };
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };
const privateWrite = (path, content) => { writeFileSync(path, content, { mode: 0o600 }); chmodSync(path, 0o600); };

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const S = { parents: [], children: [] };
const stopAll = async () => {
  for (const child of S.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await S.ledger?.stop?.().catch(() => undefined);
  await S.worker?.stop?.("SIGKILL").catch(() => undefined);
  await sql.end().catch(() => undefined);
};

function listenerPids(port) {
  const inodes = new Set();
  for (const table of ["tcp", "tcp6"]) {
    for (const line of readFileSync("/proc/net/" + table, "utf8").trim().split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/), [, hexPort] = columns[1].split(":");
      if (columns[3] === "0A" && Number.parseInt(hexPort, 16) === port) inodes.add(columns[9]);
    }
  }
  const pids = [];
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m && inodes.has(m[1])) { pids.push(Number(pid)); break; }
      }
    } catch { /* process exited or foreign */ }
  }
  return pids;
}
const sourceHead = () => spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

record("environment", { run: RUN, root: ROOT, node: process.version, sourceHead: sourceHead(), s3Python: Boolean(process.env.FINNOR_S3_PYTHON),
  launcherFiles: ["transport-root.key", "consumer-root.key"].map(name => [name, existsSync(join(privateRoot, name))]),
  appEnvKeys: ["FINNOR_Z5_PROFILE", "FINNOR_ENVIRONMENT", "FINNOR_S6_OWNER_TRANSPORT_CONFIG", "FINNOR_S6_OWNER_TRANSPORT_ROOT",
    "FINNOR_Z5_S8_CONSUMER_CONFIG", "FINNOR_Z5_S8_CONSUMER_ROOT", "FINNOR_S3_MODEL_STORE", "FINNOR_S4_POLICY_STORE", "FINNOR_WORKER_DATABASE_URL"].map(key => [key, Boolean(env[key])]) });

const kernel = await import("../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts");
const { canonical, digest } = kernel;
const s8digest = (await import("../../../packages/capability-evolution/src/contracts.ts")).digest;
const s8ByteDigest = (await import("../../../packages/capability-evolution/src/contracts.ts")).byteDigest;
const transportPath = join(privateRoot, "transport.json");
const transportKey = createPrivateKey(readFileSync(join(privateRoot, "transport-root.key")));
const consumerKey = createPrivateKey(readFileSync(join(privateRoot, "consumer-root.key")));
const edSignCanonical = (key, value) => edSign(null, Buffer.from(canonical(value)), key).toString("base64");

// ---------------------------------------------------------------- Z5N-01 owner
let owner = null;
await runCase("Z5N-01", "Real Auth password grant for the launcher owner; owner identity resolves", async () => {
  owner = await signInOwner(env);
  S.tenantId = owner.tenantId; S.ownerId = owner.userId;
  ensure(S.tenantId && S.ownerId, "OWNER_IDENTITY_MISSING");
  const [row] = await q("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2", [S.tenantId, S.ownerId]);
  ensure(row?.role === "owner" && row?.status === "active", "OWNER_ROW_NOT_ACTIVE_OWNER");
  return { detail: { tenantId: S.tenantId, ownerId: S.ownerId } };
});
if (!owner) { record("summary", { results }); await stopAll(); process.exit(1); }

// ---------------------------------------------------------------- Z5N-02 S6 ledger and transport policy
await runCase("Z5N-02", "Separate S6 ledger process and launcher-root-signed owner-transport policy", async () => {
  const { createEconomicLedger } = await import("../../s7/ledger-fixture.mts");
  S.valuator = randomUUID();
  S.ledger = await createEconomicLedger(S.tenantId, S.ownerId, S.valuator, { capabilityLifecycle: true, rightsRef: RIGHTS });
  const generated = JSON.parse(readFileSync(join(S.ledger.root, "transport.json"), "utf8"));
  const policy = generated.policy;
  privateWrite(transportPath, JSON.stringify({ policy, signature: edSignCanonical(transportKey, policy) }));
  // The ledger fixture rebinds process.env to its own file; the API, lifecycle and children use the launcher's.
  process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = transportPath;
  process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
  return { detail: { endpoint: S.ledger.endpoint(), routes: policy.routes.map(r => [r.semanticOwner, r.purpose]), policyDigest: digest(policy) } };
});

// ---------------------------------------------------------------- Z5N-03 second tenant owner
let other = null;
await runCase("Z5N-03", "Second real tenant and owner (Auth user, distinct tenant) for the denied-access step", async () => {
  const tenantId = randomUUID(), userId = randomUUID(), orgId = randomUUID(), tag = randomUUID().slice(0, 8);
  const email = `z5.other.${tag}@verification.invalid`, password = randomUUID() + randomUUID();
  await q("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Z5 second tenant')", [tenantId, "z5-second-" + tag]);
  await q("INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,effective_from,source_system,created_by) VALUES($1,'private_equity',1,now(),'z5:native','system:z5')", [tenantId]);
  await q("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Z5 second owner')", [userId, tenantId, email]);
  await q("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Z5 second target','other')", [orgId, tenantId, "z5-second-org-" + tag]);
  const created = await fetch(env.SUPABASE_URL + "/auth/v1/admin/users", { method: "POST",
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY, apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(20000) });
  ensure(created.status === 200, "SECOND_AUTH_USER_CREATION_" + created.status);
  other = { email, password, tenantId, userId };
  privateWrite(join(privateRoot, "other-owner.json"), JSON.stringify({ email, password }));
  const session = await signInOwner(env, { email, password });
  ensure(session.tenantId === tenantId && session.tenantId !== S.tenantId, "SECOND_TENANT_NOT_DISTINCT");
  return { detail: { tenantId, userId, distinctFromFirst: tenantId !== S.tenantId } };
});

// ---------------------------------------------------------------- Z5N-04 original Work parents (scenario-owned stock worker)
S.workerLog = join(privateRoot, "worker.log");
await runCase("Z5N-04", "Two original X1 parents (first Work and an alternate Work with a distinct root) via owner code and the stock worker", async () => {
  S.worker = await startOwnedWorker(env, { logPath: S.workerLog, leaseSeconds: 30 });
  for (const route of ["institution-mandate", "institution-register-source", "institution-sources", "institution-submit"]) await owner.operation(route, {}).catch(() => null);
  for (const tag of ["z5a" + randomUUID().slice(0, 5), "z5b" + randomUUID().slice(0, 5)]) {
    S.parents.push(await createOriginalInstitutionParent(env, { record, tag, ruleWindowMs: 58 * 60000 }));
  }
  const [a, b] = S.parents;
  ensure(a.workId !== b.workId && a.dealId !== b.dealId, "ALTERNATE_WORK_NOT_DISTINCT");
  return { detail: S.parents.map(p => ({ workId: p.workId, dealId: p.dealId, programId: p.programId, parentReservation: p.parentReservation,
    responsibilityIdentity: p.responsibilityIdentity, originalDeadlineAt: p.originalDeadlineAt, rightsRevision: p.rightsRevision, status: p.nativeStatus })) };
});
await runCase("Z5N-05", "Scenario-owned stock worker is stopped (the driver owns the only Z5 worker)", async () => {
  if (S.worker) await S.worker.stop("SIGTERM");
  S.worker = null;
  const live = spawnSync("pgrep", ["-af", "z0-worker|apps/worker"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
    .filter(line => !/pgrep/.test(line));
  ensure(live.length === 0, "STOCK_WORKER_STILL_RUNNING");
  return { detail: { remaining: live.length } };
});

const parent = () => S.parents[0];
const rootOf = p => ({ entityType: "pe_deal", entityId: p.dealId });

// ---------------------------------------------------------------- Z5N-06 Work/root consistency
await runCase("Z5N-06", "Original Work and its business root are mutually consistent for the Z5 request", async () => {
  ensure(parent(), "NO_PARENT");
  const [input] = await q("SELECT id::text, context_snapshot FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [S.tenantId, parent().workId]);
  const snapshot = input?.context_snapshot ?? {};
  const businessRoot = snapshot.businessRoot ?? snapshot.focusedEntity;
  ensure(businessRoot && businessRoot.entityId === parent().dealId, "WORK_INPUT_ROOT_IS_NOT_THE_DEAL:" + JSON.stringify(businessRoot));
  S.root = businessRoot;
  S.alternateRoot = ((await q("SELECT context_snapshot FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [S.tenantId, S.parents[1].workId]))[0]?.context_snapshot ?? {});
  S.alternateRoot = S.alternateRoot.businessRoot ?? S.alternateRoot.focusedEntity;
  return { detail: { root: S.root, alternateRoot: S.alternateRoot } };
});

// ---------------------------------------------------------------- Z5N-07 S3 -> S4 -> S5 handoff
await runCase("Z5N-07", "Real S3 fit, S4 policy, S5 clearing and handoff over HTTP for the first Work", async () => {
  ensure(parent(), "NO_PARENT");
  const python = process.env.FINNOR_S3_PYTHON;
  ensure(python && python.startsWith("/"), "PINNED_S3_PYTHON_REQUIRED");
  const generated = spawnSync(python, [join(BACKEND, "scripts/s3/reference.py")], { input: JSON.stringify({ operation: "equivalent" }), encoding: "utf8",
    timeout: 60000, env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" } });
  ensure(generated.status === 0, "S3_REFERENCE_FAILED:" + String(generated.stderr).slice(0, 200));
  const { createUpstreamFixtureSupport } = await import("../../s5/owner-fixture.mts");
  const calls = [];
  const api = async (_fixture, operation, body) => {
    const family = operation === "fit" ? "interventions" : ["synthesize", "handoff", "validate"].includes(operation) ? "policies" : "allocations";
    const response = await owner.call(`/api/${family}/${operation}`, body);
    calls.push({ family, operation, status: response.status });
    return response;
  };
  const ok = r => { ensure(r.status === 200, "OWNER_REQUEST_FAILED:" + JSON.stringify(r.body).slice(0, 400)); return r.body; };
  const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  const support = createUpstreamFixtureSupport({ admin: () => sql, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures: {}, api,
    artifact: async (name, value) => record("upstream-" + name.replace(/[^A-Za-z0-9]+/g, "-"), value) });
  let [organization] = await q("SELECT id FROM finnor_os.external_organizations WHERE tenant_id=$1 AND active ORDER BY created_at LIMIT 1", [S.tenantId]);
  ensure(organization, "NO_ACTIVE_EXTERNAL_ORGANIZATION");
  const f = await support.fixture("z5-" + randomUUID().slice(0, 8), 2, [{ id: "cash", unit: "USD", capacity: 100, totalLimit: 100 }],
    { existing: { tenant: S.tenantId, principal: S.ownerId, root: { entityType: "external_organization", entityId: organization.id } },
      expiresAt: parent().originalDeadlineAt, exposureUnit: "USD:minor:RECORDED_MINOR" });
  const policy = await support.policy(f, "z5", { cash: 25 });
  await support.resource(f, "cash", "USD", "STOCK", ["100", "100", "100"]);
  const cleared = ok(await api(f, "clear", support.clearing(f, { z5: ["100"] }, [], [], [policy])));
  ensure(cleared.status === "FEASIBLE", "CLEARING_NOT_FEASIBLE:" + cleared.status);
  const handoff = ok(await api(f, "handoff", { policyRef: policy.ref, allocationRef: cleared.certificate.ref, decision: support.decision(f, cleared.certificate.ref) }));
  S.upstream = { f, policy, cleared, handoff, calls, organizationId: organization.id };
  return { detail: { mandateRef: f.mandate.ref, policyRef: policy.ref, allocationRef: cleared.certificate.ref, preparationRef: handoff.preparationRef,
    consumptionRef: handoff.consumptionRef, rightsRef: f.mandate.rightsRef, validUntil: f.mandate.validUntil, calls } };
});

// ---------------------------------------------------------------- Z5N-08 S6 obligation with Work lineage
const ownerCtx = () => ({ auth: { tenantId: S.tenantId, userId: S.ownerId, employeeId: S.ownerId, role: "owner" } });
await runCase("Z5N-08", "S6 durable obligation bound to the original Work lineage", async () => {
  ensure(S.upstream, "NO_UPSTREAM_CHAIN");
  const obligations = await import("../../../packages/private-equity/src/enterprise-obligations.ts");
  const { preparationRef, allocationRef, consumptionRef } = S.upstream.handoff;
  const prepared = await obligations.prepareEnterpriseDurableObligation(ownerCtx(), { preparationRef, allocationRef, consumptionRef }, { workId: parent().workId });
  S.obligation = prepared;
  return { detail: { obligationRef: prepared.ref, workLineage: prepared.workLineage, reservationRef: prepared.reservationRef } };
});

// ---------------------------------------------------------------- Z5N-09 S8 lifecycle (real process), pins and consumer config
const requestDeadline = () => parent().originalDeadlineAt;
await runCase("Z5N-09", "Real S8 lifecycle process with the S4/S6/Z5 source closure pinned", async () => {
  const { requiredCapabilitySourcePaths } = await import("../../../packages/capability-evolution/src/source-closure.ts");
  const { currentBuild } = await import("../../../packages/private-equity/src/project-z/z5-institution-linker/source.ts");
  const build = await currentBuild();
  const paths = new Set(requiredCapabilitySourcePaths);
  for (const file of build.files) paths.add(join(ROOT, file.path));
  const pins = [];
  for (const path of paths) pins.push({ path, sha256: s8ByteDigest(readFileSync(path)) });
  const sizes = { closure: requiredCapabilitySourcePaths.length, z5: build.files.length, union: pins.length };
  record("s8-pin-sizes", sizes);
  const { createCapabilityLifecycle } = await import("../../s8/lifecycle-fixture.mts");
  const lc = await createCapabilityLifecycle({ tenant: S.tenantId, principal: S.ownerId, evaluator: randomUUID(), promoter: randomUUID(), rightsRef: RIGHTS, sourcePins: pins });
  S.lc = lc;
  const child = spawn(process.execPath, ["--import=tsx", "packages/capability-evolution/src/server.mts"], { cwd: BACKEND, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DATABASE_URL: env.DATABASE_URL,
      FINNOR_S3_MODEL_STORE: env.FINNOR_S3_MODEL_STORE, FINNOR_S4_POLICY_STORE: env.FINNOR_S4_POLICY_STORE, FINNOR_S3_PYTHON: env.FINNOR_S3_PYTHON,
      FINNOR_S8_LIFECYCLE_CONFIG: lc.configPath, FINNOR_S8_RELEASE_ROOT: lc.pub("release"),
      FINNOR_S6_OWNER_TRANSPORT_CONFIG: transportPath, FINNOR_S6_OWNER_TRANSPORT_ROOT: env.FINNOR_S6_OWNER_TRANSPORT_ROOT,
      FINNOR_Z5_PROFILE: "ordinary_disposable", FINNOR_ENVIRONMENT: "ordinary_disposable", AUTH_DEV_BYPASS: "0", FINNOR_S8_PORT: "0" } });
  S.children.push(child); S.s8 = child;
  let logs = "";
  const port = await new Promise((ready, failed) => {
    const timer = setTimeout(() => failed(Error("S8_BOOT_TIMEOUT:" + logs.slice(-600))), 60000);
    child.stdout.on("data", chunk => {
      logs += chunk;
      for (const line of logs.split("\n")) { try { const s = JSON.parse(line); if (s.status === "READY") { clearTimeout(timer); ready(s.port); } } catch { /* partial */ } }
    });
    child.stderr.on("data", chunk => { logs += chunk; });
    child.once("exit", code => { clearTimeout(timer); failed(Error("S8_BOOT_EXIT_" + code + ":" + logs.slice(-800))); });
  });
  S.s8Port = port;
  return { detail: { sizes, port, pid: child.pid } };
});

await runCase("Z5N-10", "Signed Z5 consumer policy for the real S8 lifecycle (launcher consumer root)", async () => {
  ensure(S.lc && S.s8Port, "NO_S8_LIFECYCLE");
  const tokenPath = join(privateRoot, "s8-consumer.token");
  privateWrite(tokenPath, S.lc.tokens.consumer);
  const body = { schema: "finnor.s8.z5-composition-consumer-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", tenantId: S.tenantId, principalId: S.ownerId,
    rightsRef: RIGHTS, endpoint: "http://127.0.0.1:" + S.s8Port, tokenPath, tokenHash: s8ByteDigest(S.lc.tokens.consumer),
    lifecyclePolicyDigest: s8digest(S.lc.policy), validAfter: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.parse(requestDeadline()) + 60000).toISOString(), timeoutMs: 40000 };
  privateWrite(join(privateRoot, "s8-consumer.json"), JSON.stringify({ body, signature: edSignCanonical(consumerKey, body) }));
  return { detail: { endpoint: body.endpoint, lifecyclePolicyDigest: body.lifecyclePolicyDigest, validUntil: body.validUntil } };
});

// ---------------------------------------------------------------- Z5N-11 S8 profile + admissions, registered through the product route
await runCase("Z5N-11", "S8 fixed-component profile and per-component admissions published; institution-contract-register accepts them", async () => {
  ensure(S.upstream && S.obligation, "NO_UPSTREAM_OR_OBLIGATION");
  const frozen = JSON.parse(readFileSync(join(ROOT, "scope-z/phase-evidence/z5/frozen/F30-01.json"), "utf8")).input;
  const contract = structuredClone(frozen);
  contract.domain = "ORDINARY_DEVELOPMENT";
  for (const c of [...contract.components, ...contract.replacementCandidates]) {
    c.correspondence = { ...c.correspondence, admission: "NATIVE_S8_CURRENT_DECLARED_CONTRACT", implementationDigest: digest(c.transitions) };
  }
  const { authorize } = await import("../../../packages/private-equity/src/owner-context.ts");
  const rightsRevision = String((await authorize(ownerCtx(), S.root, [{ type: "work", id: parent().workId }])).revision);
  const [facts] = await q(`SELECT r.status, r.envelopes, r.reservation_id FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_reservations r
    ON r.tenant_id=co.tenant_id AND r.reservation_id=co.reservation_id WHERE co.tenant_id=$1 AND co.consumption_id=$2`, [S.tenantId, S.upstream.handoff.consumptionRef.id]);
  ensure(facts, "S5_RESERVATION_FACTS_UNAVAILABLE");
  const allocations = await import("../../../packages/private-equity/src/enterprise-allocation.ts");
  const { issued } = await allocations.readValidatedNumericEnterpriseAllocation(ownerCtx(), S.upstream.handoff.allocationRef);
  S.obligationRefs = [S.obligation.ref];
  const unknownFlag = "1";
  const profileFacts = { policy: S.upstream.policy.ref.contentDigest, reservation: issued.reservation.ref.id, obligations: digest(S.obligationRefs),
    envelopes: digest(facts.envelopes), rights: rightsRevision };
  const validUntil = parent().originalDeadlineAt;
  const profile = { schema: "finnor.s8.fixed-institution-components.v1", domain: "ORDINARY_DEVELOPMENT", tenantId: S.tenantId, principalId: S.ownerId,
    workId: parent().workId, root: S.root, validUntil, rightsRevision, contract, componentAdmissionRefs: [],
    sourceDependencies: [{ key: "z5:native:fixed-profile", revision: 0, nodeIds: [], digest: null }],
    nativeLocals: [
      { component: "S4", owner: "S4_PREPARATION", states: { PREPARED: "done" } },
      { component: "S5", owner: "S5_RESERVATION", states: { [facts.status]: "held" } },
      { component: "S6", owner: "S6_EFFECT", states: { NO_OBLIGATION: "ready", UNKNOWN: "waiting", OBSERVED_VERIFIED: "done" } },
      { component: "Terms", owner: "S4_PREPARATION", states: { PREPARED: "open" } }],
    nativeCells: [
      { cell: "terms", meaning: "POLICY_DIGEST", values: { [profileFacts.policy]: "v1" } },
      { cell: "proposal", meaning: "OBLIGATION_DIGEST", values: { [profileFacts.obligations]: "v1" } },
      { cell: "occupation", meaning: "RESOURCE_ENVELOPE_DIGEST", values: { [profileFacts.envelopes]: "1" } },
      { cell: "pending", meaning: "UNKNOWN_FLAG", values: { 0: "0", [unknownFlag]: "1" } },
      { cell: "reservation", meaning: "RESERVATION_ID", values: { [profileFacts.reservation]: "original-reservation" } },
      { cell: "grant", meaning: "RIGHTS_REVISION", values: { [rightsRevision]: "original-grant" } }],
    protectedAdmission: false, executionAuthorityGranted: false };
  const publish = async (id, content) => {
    const reference = { owner: "S8", id, version: "z5-native-v1", contentDigest: digest(content), content };
    await S.ledger.publish(reference);
    const { content: _content, ...descriptor } = reference;
    return descriptor;
  };
  const components = [...contract.components, ...contract.replacementCandidates];
  for (const [index, component] of components.entries()) {
    profile.componentAdmissionRefs.push(await publish("z5-admission-" + index + "-" + randomUUID().slice(0, 8), {
      schema: "finnor.s8.fixed-component-admission.v1", domain: "ORDINARY_DEVELOPMENT", tenantId: S.tenantId, principalId: S.ownerId,
      status: "ADMITTED", componentDigest: digest(component), correspondenceScope: "EXACT_LISTED_KERNEL_ONLY", validUntil,
      protectedAdmission: false, executionAuthorityGranted: false }));
  }
  const profileRef = await publish("z5-profile-" + randomUUID().slice(0, 8), profile);
  S.profileRef = profileRef; S.profile = profile;
  const registered = await owner.operation("institution-contract-register", { root: S.root, workId: parent().workId, sourceRef: profileRef }).catch(() => null);
  const direct = await owner.call("/api/centropy/company-brain/institution-contract-register", { root: S.root, workId: parent().workId, sourceRef: profileRef });
  ensure(direct.status === 200, "PROFILE_REGISTER_" + direct.status + ":" + JSON.stringify(direct.body).slice(0, 500));
  return { detail: { profileRef, facts: profileFacts, register: direct.body, firstAttempt: registered?.status } };
});

// ---------------------------------------------------------------- Z5N-12 economic assignment (S7) and delayed callback (S6)
notRun("Z5N-12", "S2/S7 economic assignment whose estimand names the S4/S5 mandate (assignmentRef for the original request)",
  "Not yet attempted in this scenario revision; the S7 estimand must resolve the S5 mandate reference through the S6 ledger.");
notRun("Z5N-13", "Old-revision S6 provider obligation with an independent delayed callback after the replacement",
  "Not yet attempted; requires the governed-dispatch fake provider and S6 broker (lost response, then reconcile) bound to the original Work lineage.");

// ---------------------------------------------------------------- Z5N-14 driver
const driverIds = ["login", "pool", "contract", "submit", "worker", "use", "plan", "reads", "incomplete", "panel", "second-tenant", "sign-out", "callback", "cancel", "revoke"];
if (!S.profileRef || !S.obligation || !S.upstream) {
  notRun("Z5N-14", "Guarded native E2E driver (" + driverIds.join(", ") + ")", "Prerequisite stages did not pass; see the earlier cases.");
} else if (!S.assignmentRef) {
  notRun("Z5N-14", "Guarded native E2E driver", "No economic assignmentRef (Z5N-12 NOT_RUN): the driver refuses without it. Prerequisite stages through Z5N-11 are recorded above.");
}

record("summary", { run: RUN, results: results.map(r => ({ id: r.id, outcome: r.outcome })) });
await stopAll();
const failed = results.some(r => r.outcome === "FAIL");
process.exit(failed ? 1 : 0);
