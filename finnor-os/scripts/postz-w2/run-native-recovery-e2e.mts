/** Failure-first owning native campaign. Controlled principals are not genuine
 * human consent, an admitted financial rail, protected custody or field data. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "../../packages/db/migrate";
import { closePool, configureTenantVertical, transactionDb, withTenantTransaction } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import { parseAllocationResource } from "../../packages/epistemic-runtime/src/allocation-contracts";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { nativeWorkforceOriginalSchema } from "../../packages/orchestration/src/workforce-execution/contracts";
import { workforceActorSchema, type WorkforceTask } from "../../packages/workforce/src/execution-program/schema";
import { workforceDigest } from "../../packages/workforce/src/execution-program/exact";
import { authenticatedApiFixture } from "../frontier5/x1/authenticated-api-fixture.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url)), backend = join(root, "finnor-os");
const base = process.env.FINNOR_W2_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/native-recovery");
assert(base.startsWith("/"));
const evidence = join(base, "native-recovery-run-" + Date.now()), installation = process.env.FINNOR_W2_INSTALLATION;
await mkdir(evidence, { recursive: true, mode: 0o700 });
const contract = JSON.parse(await readFile(join(root,
  "scope-postz/w2-accountable-workforce/dynamic/native-recovery-contract.json"), "utf8"));
let outputBytes = 0;
const save = async (name: string, body: unknown) => {
  const text = JSON.stringify(body, null, 2) + "\n"; outputBytes += Buffer.byteLength(text);
  assert(outputBytes <= contract.maximumOutputBytes, "ORIGINAL_OUTPUT_BOUND");
  await writeFile(join(evidence, name), text, { mode: 0o600 });
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const frozenPaths = ["finnor-os/packages/authority/src/index.ts",
  "finnor-os/packages/governed-execution/src/workforce-local-attempt.ts",
  "finnor-os/packages/governed-execution/src/executor.ts",
  "finnor-os/packages/governed-execution/src/adapter-contract.ts",
  "finnor-os/packages/private-equity/src/workforce-allocation.ts",
  "finnor-os/packages/private-equity/src/workforce-compensation.ts",
  "finnor-os/packages/db/migrations-bundle.ts", "finnor-os/scripts/postz-w2/run-native-recovery-e2e.mts",
  "scope-postz/w2-accountable-workforce/dynamic/native-recovery-contract.json",
  ...["contracts", "store", "runtime", "worker", "dependencies", "native-authority", "participants", "protected-child", "index"].map(name =>
    `finnor-os/packages/orchestration/src/workforce-execution/${name}.ts`),
  ...["schema", "compiler", "checker", "lifecycle", "graph", "exact"].map(name =>
    `finnor-os/packages/workforce/src/execution-program/${name}.ts`)];
const sources = await Promise.all(frozenPaths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })));
await save("frozen-contract.json", contract);
await save("source-cut.json", { sources, head: execFileSync("git", ["rev-parse", "HEAD"],
  { cwd: root, encoding: "utf8" }).trim(), installation: installation ?? null });
const disk = statfsSync(root, { bigint: true });
assert(disk.bavail * disk.bsize >= 3n * 1024n ** 3n, "GLOBAL_3_GIB_FLOOR");
const traffic: any[] = [], results: any[] = [];
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined, worker: ChildProcess | undefined;
let fixtureTenantId: string | undefined, compensatedProgrammeId: string | undefined;
let service: Awaited<ReturnType<typeof authenticatedApiFixture>> | undefined, directory: string | undefined;
let workerLog = "", paused = false, expired = false, failure: string | null = null, manifest: any;
const resume = () => { if (paused) { worker?.kill("SIGCONT"); paused = false; } };
const wall = setTimeout(() => { expired = true; resume(); worker?.kill("SIGTERM"); }, contract.wallSeconds * 1000);
const waitFor = async <T,>(name: string, observe: () => Promise<T>, ready: (value: T) => boolean, ms = 45000) => {
  const end = Date.now() + ms; let last: T;
  do {
    assert(!expired, "ORIGINAL_NATIVE_RECOVERY_WALL");
    last = await observe(); if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < end);
  await save("timeout-" + name + ".json", last!); throw Error("FINITE_NATIVE_RECOVERY_OBSERVATION:" + name);
};
const freePort = () => new Promise<number>((yes, no) => {
  const socket = createServer(); socket.once("error", no);
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); assert(address && typeof address !== "string");
    socket.close(() => yes(address.port)); });
});
try {
  process.env.NODE_ENV = "test"; process.env.AUTH_DEV_BYPASS = "0";
  process.env.FINNOR_P4_PROFILE = "ordinary_disposable"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.RATE_LIMIT_PER_MINUTE = "10000"; process.env.RATE_LIMIT_IP_PER_MINUTE = "10000";
  directory = await mkdtemp("/tmp/finnor-w2-recovery-owned-");
  await save("owned-local-resources.json", { directory, creatorPid: process.pid,
    classification: "CONTROLLED_DISPOSABLE_POSTGRES_ONLY", realCredentials: false });
  const port = await freePort(), password = randomBytes(32).toString("hex");
  const appPassword = randomBytes(32).toString("hex"), workerPassword = randomBytes(32).toString("hex");
  database = new EmbeddedPostgres({ databaseDir: join(directory, "database"), user: "w2_fixture", password, port,
    persistent: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="], onLog: () => {} });
  await database.initialise(); await database.start(); await database.createDatabase("w2_native_recovery");
  const connection = (user: string, pass: string) => `postgres://${user}:${pass}@127.0.0.1:${port}/w2_native_recovery`;
  let nativeMigrate = migrate;
  if (installation) {
    assert(installation.startsWith("/"));
    manifest = JSON.parse(await readFile(join(installation, "finnor-os/w2-development-installation.json"), "utf8"));
    assert.equal(manifest.schema, "finnor.postz.w2.development-installation.v1");
    nativeMigrate = (await import(pathToFileURL(join(installation, manifest.entrypoints.migrations)).href)).migrate;
  }
  const migrations = await nativeMigrate(connection("w2_fixture", password));
  assert(migrations.includes("postz_w2_execution_completion.sql"));
  admin = new pg.Client({ connectionString: connection("w2_fixture", password) }); await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD " + admin.escapeLiteral(appPassword));
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD " + admin.escapeLiteral(workerPassword));
  const roles = (await admin.query(`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles
    WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname`)).rows;
  assert.equal(roles.length, 2); assert(roles.every(r => !r.rolsuper && !r.rolbypassrls));
  await save("migrations-and-restricted-roles.json", { migrations, roles });
  const tenant = randomUUID(), people = Array.from({ length: 4 }, () => randomUUID()), contact = randomUUID();
  fixtureTenantId = tenant;
  const principal = people[0]!, human = people[1]!, provider = people[2]!, checker = people[3]!;
  const actorIds = [principal, human, contact, checker], kinds = [
    "COMPUTATIONAL_CELL", "INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "COMPUTATIONAL_CELL"] as const;
  const works = Array.from({ length: 5 }, () => randomUUID()), now = Date.now();
  const iso = (delta: number) => new Date(now + delta).toISOString(), expires = iso(3600000);
  const ref = (owner: string, id: string) => ({ owner, id, version: "controlled-native-recovery-v1", contentDigest: sha(id) });
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Controlled native recovery, not field evidence')",
    [tenant, randomUUID()]);
  for (const [i, id] of people.entries()) {
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
      VALUES($1,$2,$3,$4,'active','Controlled principal, not genuine human qualification')`,
    [id, tenant, id + "@test.invalid", i === 1 || i === 2 ? "technician" : "owner"]);
    await admin.query("INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind) VALUES($1,$2,$3)",
      [tenant, id, i === 1 || i === 2 ? "HUMAN" : "SERVICE"]);
  }
  const standingRole = randomUUID();
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
    VALUES($1,$2,'w2-controlled-recovery-participant','Disposable explicit participant grants')`, [standingRole, tenant]);
  for (const id of [human, provider]) await admin.query(`INSERT INTO finnor_os.employee_role_assignments
    (tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`, [tenant, id, standingRole]);
  for (const capability of ["query:work", "action:workforce_assign_contract", "action:workforce_respond_contract"])
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,$3,'*','allow','low')`, [tenant, standingRole, capability]);
  await admin.query("INSERT INTO finnor_os.external_contacts(tenant_id,id,contact_key,name) VALUES($1,$2,$3,'Controlled existing provider')",
    [tenant, contact, "controlled-" + contact]);
  process.env.DATABASE_URL = connection("finnor_app", appPassword); await closePool();
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0,
    createdBy: principal, sourceSystem: "W2:controlled-native-recovery" });
  const auth = { tenantId: tenant, userId: principal, employeeId: principal, role: "owner" as const }, sourceIds: string[] = [];
  for (const [i, id] of people.entries()) {
    const skill = i === 1 ? "recipient-labor" : i === 2 ? "provider-work" : "counter-compute";
    const actor = workforceActorSchema.parse({ id: actorIds[i], tenantId: tenant, identityRef: ref("identity", actorIds[i]!),
      kind: kinds[i], status: "CURRENT",
      capabilities: [{ skill, scope: "analysis", evidenceRef: ref("S1", "qualification-" + i), certainty: "OBSERVED", validUntil: expires }],
      availability: { kind: "OBSERVED", ref: ref("S1", "schedule-" + i), validUntil: expires,
        slots: [{ startAt: iso(-60000), endAt: expires, capacity: "16", committed: "0" }], maxConcurrent: 16,
        humanLimits: i === 1 || i === 2 ? { kind: "OBSERVED", maxEffortSeconds: "100", alreadyCommittedSeconds: "0",
          fatigue: "WITHIN_LIMIT", ref: ref("S1", "controlled-limits-" + i) } : { kind: "NOT_HUMAN" } } });
    const snapshot = { schema: "finnor.workforce-actor-evidence.v1",
      canonical: { kind: i === 2 ? "EXTERNAL_CONTACT" : "USER", id: actorIds[i], principalId: id }, actor,
      qualification: "AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION" };
    const source = await withTenantTransaction(tenant, { userId: principal }, async (_db, c) => {
      const db = transactionDb(c), created = await createEvidenceSourceTx(db, tenant,
        { sourceKey: "w2-recovery-controlled:" + i, sourceType: "workforce_actor_evidence", title: "Controlled native owner fixture" });
      await appendEvidenceVersionTx(db, tenant, created.id, { content: JSON.stringify(snapshot), snapshot }); return created;
    });
    sourceIds.push(source.id);
  }
  service = await authenticatedApiFixture(root, principal, value => { if (traffic.length < 20000) traffic.push(value); },
    { additionalActors: [human, provider, checker], maximumActors: 4,
      ...(installation ? { installation, installationProfile: "POSTZ_W2" as const } : {}) });
  const tokens = new Map<string, string>([[principal, service.token]]);
  for (const identity of service.additionalIdentities) {
    const response: Response = await fetch(service.authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: identity.email, password: identity.password }) });
    assert.equal(response.status, 200); tokens.set(identity.actor, (await response.json()).access_token);
  }
  const api = async (path: string, body?: unknown, actor: string = principal): Promise<{ status: number; body: any }> => {
    assert(!expired, "ORIGINAL_NATIVE_RECOVERY_WALL");
    const response = await fetch(service!.origin + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + tokens.get(actor), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = { status: response.status, body: await response.json() };
    assert(response.status < 500, "NO_NATIVE_RECOVERY_HTTP_SERVER_FAILURE:" + JSON.stringify(result));
    return result;
  };
  const proposal = await api("workforce/participants", { contactId: contact, recipientPrincipalId: provider,
    purpose: "controlled-native-recovery", validUntil: expires, idempotencyKey: "existing-provider-binding" });
  assert.equal(proposal.status, 202, JSON.stringify(proposal.body));
  const confirmation = await api("workforce/participants/" + proposal.body.id, { action: "CONFIRM",
    proposalDigest: proposal.body.proposalDigest, expectedRevision: 0, idempotencyKey: "actual-provider-confirms" }, provider);
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
  await save("existing-provider-enrollment.json", { proposal, confirmation, genuineHumanQualified: false, contactSent: false });
  const rights = String((await admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision);
  const horizon = { startAt: iso(-60000), periodMs: 3600000, periods: 1 };
  const resource = async (cash: boolean) => putAllocationResource({ auth }, parseAllocationResource({
    schema: "finnor.allocation-resource.v1", resourceId: cash ? "w2-recovery-usd" : "w2-recovery-operations",
    resourceClass: cash ? "CASH" : "COMPUTE", tenantId: tenant, ownerRef: ref("BUSINESS_OWNER", principal),
    legalEntityRef: ref("S1", tenant), scopeRef: ref("BUSINESS_OWNER", principal),
    permittedRoots: (cash ? [works[2]!] : works).map(entityId => ({ entityType: "work", entityId })),
    rightsRef: `authority:${tenant}:${rights}`, unit: cash ? "USD" : "workforce-operation", currency: cash ? "USD" : null,
    kind: "CUMULATIVE_EXPENDITURE", horizon, sourceRef: ref("BUSINESS_OWNER", cash ? "controlled-wage-budget" : "controlled-operations"),
    asOf: iso(0), knowledgeAt: iso(0), validUntil: expires, beliefPins: [],
    availability: [0, 1].map(() => ({ amount: cash ? "10" : "100", basis: "REPORTED_AVAILABLE" })),
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
    qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }), null);
  const operation = await resource(false), cash = await resource(true);
  const envelope = (amount: string, money = false) => ({ resourceId: money ? cash.resourceId : operation.resourceId,
    unit: money ? cash.unit : operation.unit, kind: operation.kind, horizon, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["query:work"], dataScopes: ["work:self"], purposes: ["controlled-native-recovery"], effects: [],
    validFrom: iso(-60000), validUntil: expires, allowSubdelegation: true };
  const task = (id: string, who = 1, units = "6", money?: string): WorkforceTask => ({
    id, parentTaskId: null, dependsOn: [], returnTo: [], delegatorActorId: principal, criterionId: "criterion-" + id,
    requiredCapabilities: [{ skill: who === 1 ? "recipient-labor" : who === 2 ? "provider-work" : "counter-compute", scope: "analysis" }],
    allowedActorKinds: [kinds[who]!], assignmentMode: who === 2 ? "EXTERNAL_VOLUNTARY" : "INTERNAL_AUTHORIZED",
    ceiling, terms: { revision: 1, deliverable: "Original independently checked literal 42", compensation: { value: "0", unit: "USD" },
      subdelegation: true, expiresAt: expires }, dueAt: expires, slot: { startAt: iso(-60000), endAt: expires },
    effortSeconds: "1", demand: [envelope(units), ...(money ? [envelope(money, true)] : [])],
    context: { dataScopes: ["work:self"], purposes: ["controlled-native-recovery"], includesCredentials: false }, effectId: null });
  const criterion = (id: string, verifier = checker) => ({ id: "criterion-" + id, checkerActorId: verifier,
    evidenceCustodianActorId: principal, acceptance: { kind: "EXACT_JSON", expected: "42" } });
  const participant = { kind: "PARTICIPANT_INPUT", prompt: "Actual recipient supplies the original result; never infer human productivity." };
  const original = (tasks: ReturnType<typeof task>[], paid = false) => nativeWorkforceOriginalSchema.parse({
    schema: "finnor.workforce-original-outcome.v1", sourceClass: "CONTROLLED_ACTOR_RECORDS", actorSourceIds: sourceIds,
    resources: { resourceRefs: [operation.ref, ...(paid ? [cash.ref] : [])],
      schedules: [{ resourceId: operation.resourceId, quantities: ["10", "0"] },
        ...(paid ? [{ resourceId: cash.resourceId, quantities: ["10", "0"] }] : [])] },
    outcome: { deadline: expires, ceiling, resourceLimits: [envelope("10"), ...(paid ? [envelope("10", true)] : [])],
      criteria: tasks.map(t => criterion(t.id)), tasks },
    operations: tasks.map(t => ({ taskId: t.id, computation: participant })) });
  const args = installation ? ["--max-old-space-size=1536", join(installation, manifest.entrypoints.worker)] :
    ["--max-old-space-size=1536", "--import", join(backend, "node_modules/tsx/dist/loader.mjs"), join(backend, "scripts/postz-w2/physical-worker.mts")];
  worker = spawn(process.execPath, args, { cwd: installation ? join(installation, "finnor-os") : backend,
    env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: connection("finnor_worker", workerPassword),
      WORKER_JOB_LEASE_SECONDS: "3", FINNOR_WORKLOAD_CLASS: "", LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (bytes: Buffer) => { workerLog += bytes.toString();
    if (Buffer.byteLength(workerLog) > 2097152) { resume(); worker?.kill("SIGKILL"); failure = "NATIVE_RECOVERY_WORKER_LOG_LIMIT"; } };
  worker.stdout!.on("data", collect); worker.stderr!.on("data", collect);
  await waitFor("physical-worker-ready", async () => ({ log: workerLog, exit: worker!.exitCode, signal: worker!.signalCode }),
    value => { if (value.exit !== null || value.signal !== null) throw Error("ACTUAL_WORKER_STOPPED:" + value.log);
      return value.log.includes("W2_PHYSICAL_WORKER_READY"); }, 30000);
  const submit = async (index: number, value: ReturnType<typeof original>) => {
    await save("original-input-" + index + ".json", { workId: works[index], original: value });
    const response = await api("workforce/execution-programs/intake", { workId: works[index],
      idempotencyKey: "native-recovery-" + index, original: value });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    await waitFor("compiled-" + index, async () => (await admin!.query(
      "SELECT status,program,compile_result FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, response.body.id])).rows[0],
    q => { if (["BLOCKED", "FENCED"].includes(q.status)) throw Error("ORIGINAL_NATIVE_COMPILE_REFUSED:" + JSON.stringify(q));
      return q.program !== null; });
    return response.body.id as string;
  };
  const current = async (id: string) => { const value = await api("workforce/execution-programs/" + id);
    assert.equal(value.status, 200, JSON.stringify(value.body)); return value.body; };
  const act = async (id: string, taskId: string, actor: string, action: string, key: string, extra: Record<string, unknown> = {}) => {
    const q = await current(id), a = q.program.assignments.filter((a: any) => a.taskId === taskId && a.state.kind !== "CLOSED")
      .sort((a: any, b: any) => b.attempt - a.attempt)[0]; assert(a, "CURRENT_NATIVE_ASSIGNMENT:" + taskId);
    return api("workforce/execution-programs/" + id + "/actions", { action, idempotencyKey: key, expectedRevision: q.revision,
      assignmentId: a.id, termsDigest: a.termsDigest, termsRevision: a.terms.revision, ...extra }, actor);
  };
  const ok = (response: { status: number; body: any }) => assert.equal(response.status, 200, JSON.stringify(response.body));
  const uses = async (id: string) => (await admin!.query(`SELECT co.consumption_id,co.body,st.status,
    (SELECT h.body FROM finnor_os.s5_history h WHERE h.tenant_id=co.tenant_id AND h.subject_id=co.consumption_id
      AND h.operation='WORKFORCE_OBSERVATION' ORDER BY h.revision DESC LIMIT 1) observation
    FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2 ORDER BY co.consumption_id`, [tenant, id])).rows;
  const deny = async (actor: string, capability: string, type: string, id: string) => {
    const role = randomUUID();
    await admin!.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Controlled scoped denial')",
      [role, tenant, "w2-deny-" + role]);
    await admin!.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
      VALUES($1,$2,$3,$4::jsonb)`, [tenant, actor, role, JSON.stringify({ kind: "resources", resourceType: type, resourceIds: [id] })]);
    await admin!.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,$3,$4,'deny','high')`, [tenant, role, capability, type]);
    return { role, actor, capability, resourceType: type, resourceId: id, canonicalTables: true };
  };
  const runCase = async (index: number, observe: () => Promise<unknown>) => {
    const id = contract.cases[index].id, start = performance.now(); let observed: unknown, error: string | null = null;
    try { observed = await observe(); } catch (e) { error = e instanceof Error ? e.stack ?? e.message : String(e); }
    finally { resume(); }
    const result = { id, status: error ? "FAIL" : "PASS", elapsedMs: performance.now() - start, observed, error };
    results.push(result); await save(id + ".json", result); console.log(JSON.stringify({ id, status: result.status, error }));
  };
  await runCase(0, async () => {
    const id = await submit(0, original([task("parent")]));
    for (const action of ["ACCEPT", "START"]) ok(await act(id, "parent", human, action, "known-parent-" + action));
    const child = task("spent-child", 3, "4");
    const { parentTaskId: _parent, delegatorActorId: _delegator, criterionId: _criterion, ...childTask } = child;
    ok(await act(id, "parent", human, "SUBDELEGATE", "known-create-child", { refinement: {
      kind: "SUBDELEGATION", recipientActorId: checker, task: childTask,
      criterion: { ...criterion("spent-child", human), evidenceCustodianActorId: human },
      computation: { kind: "SUM_INTEGERS", values: ["0"] } } }));
    ok(await act(id, "spent-child", checker, "ACCEPT", "actual-machine-accepts-bad-method"));
    const wrong = await waitFor("actual-wrong-native-literal", () => current(id), q =>
      q.program.assignments.some((a: any) => a.taskId === "spent-child" && ["DELIVERED", "DISPUTED"].includes(a.state.kind)));
    const old = wrong.program.assignments.find((a: any) => a.taskId === "spent-child");
    const spent = (await uses(id)).filter(row => row.body.nodeId === old.id);
    assert.equal(spent.length, 1); assert.equal(spent[0]!.status, "RECONCILED");
    const intent = (await admin!.query(`SELECT body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2
      AND kind='S6_INTENDED' AND body->>'assignmentId'=$3`, [tenant, id, old.id])).rows;
    assert.equal(intent.length, 1); assert.equal(intent[0]!.body.egressAuthority, "NONE");
    assert(workerLog.includes("W2_S6_RESULT_COMMITTED"), "ACTUAL_ISOLATED_RESULT_COMMITTED");
    if (old.state.kind === "DELIVERED") ok(await act(id, "spent-child", human, "VERIFY", "independent-wrong-result-dispute"));
    ok(await act(id, "spent-child", checker, "RETURN", "actual-machine-returns-wrong-attempt"));
    await waitFor("idle-before-owned-pause", async () => (await admin!.query(
      "SELECT count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 AND status='running'", [tenant])).rows[0].n, n => n === 0);
    assert(worker!.kill("SIGSTOP")); paused = true;
    ok(await act(id, "parent", human, "RELEASE_LABOR", "actual-parent-releases-labor-not-money"));
    const replacementId = id + ":spent-child:2";
    ok(await act(id, "spent-child", principal, "REASSIGN", "replace-known-no-egress-attempt",
      { replacementActorId: principal, replacementAssignmentId: replacementId }));
    const replaced = await current(id);
    assert.equal(replaced.program.assignments.find((a: any) => a.id === old.id).state.kind, "CLOSED");
    assert.equal(replaced.program.assignments.find((a: any) => a.id === replacementId).state.kind, "OFFERED");
    for (const action of ["ACCEPT", "START", "DELIVER"]) ok(await act(id, "spent-child", principal, action,
      "fresh-replacement-" + action, action === "DELIVER" ? { value: "42" } : {}));
    ok(await act(id, "spent-child", human, "VERIFY", "independent-correct-replacement-verification"));
    resume();
    await waitFor("replacement-closed", () => current(id), q =>
      q.program.assignments.find((a: any) => a.id === replacementId).state.kind === "CLOSED");
    ok(await act(id, "parent", human, "DELIVER", "actual-parent-result", { value: "42" }));
    ok(await act(id, "parent", checker, "VERIFY", "independent-original-parent-verification"));
    const done = await waitFor("original-work-replacement-completion", () => current(id), q => q.status === "CLOSED");
    const finalUses = await uses(id);
    assert.deepEqual(finalUses.filter(row => row.body.nodeId === old.id), spent, "OLD_KNOWN_USE_RETAINED_EXACTLY");
    assert.equal(done.workId, works[0]); assert.equal(done.originalDeadline, expires);
    assert.equal((await api("works/" + works[0])).body.work.work.status, "completed");
    const history = (await admin!.query(`SELECT operation,body FROM finnor_os.s5_history
      WHERE tenant_id=$1 AND body->>'programmeId'=$2 ORDER BY operation,subject_id,revision`, [tenant, id])).rows;
    await save("known-original-ledger-and-retired-spend.json", { spent, finalUses, history, done,
      parentLaborReleasedBy: human, machineLaborClaimInvented: false, automaticReplacementExecution: false });
    return { originalRoot: works[0], oldAssignment: old.id, replacementId, knownOldUses: 1, samePhysicalWorkerPid: worker!.pid };
  });
  await runCase(1, async () => {
    const a = task("fenced-parent", 1, "4"), child = task("fenced-child", 2, "1"), b = task("unrelated", 1, "2");
    child.parentTaskId = a.id; child.delegatorActorId = human;
    const input = original([a, child, b]); const id = await submit(1, input);
    for (const action of ["ACCEPT", "START"]) ok(await act(id, a.id, human, action, "before-deny-" + action));
    const before = await current(id), assignment = before.program.assignments.find((v: any) => v.taskId === a.id);
    const injected = await deny(human, "action:workforce_respond_contract", "workforce_assignment", assignment.id);
    // Submit the previously read, exactly accepted contract directly. The act()
    // convenience helper reloads first, which would let a GET own the fence.
    const beforeUses = await uses(id), refused = await api("workforce/execution-programs/" + id + "/actions",
      { action: "DELIVER", idempotencyKey: "after-START-denied-use", expectedRevision: before.revision,
        assignmentId: assignment.id, termsDigest: assignment.termsDigest, termsRevision: assignment.terms.revision,
        value: "42" }, human);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(await uses(id), beforeUses, "NO_NEW_CONSUMPTION_AFTER_SCOPED_DENY");
    const beforeAnyReload = (await admin!.query(`SELECT status,
      (SELECT count(*)::int FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2
        AND kind='CURRENTNESS_REVALIDATION') observations FROM finnor_os.w2_programs
      WHERE tenant_id=$1 AND id=$2`, [tenant, id])).rows[0];
    assert.equal(beforeAnyReload.status, "FENCED", "DURABLE_FENCE_BEFORE_ANY_RELOAD");
    assert(beforeAnyReload.observations > 0, "DURABLE_CURRENTNESS_OWNER_BEFORE_ANY_RELOAD");
    const fenced = await current(id), expected = before.program.assignments.filter((v: any) =>
      [a.id, child.id].includes(v.taskId)).map((v: any) => v.id).sort();
    assert.equal(fenced.status, "FENCED");
    assert.deepEqual([...fenced.currentness.affectedAssignmentIds].sort(), expected);
    assert.equal(fenced.currentness.keptAssignmentIds.length, 1);
    const durable = (await admin!.query(`SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2
      AND kind='CURRENTNESS_REVALIDATION' ORDER BY event_id`, [tenant, id])).rows;
    assert(durable.some(row => JSON.stringify(row.body.p7.affectedAssignmentIds.slice().sort()) === JSON.stringify(expected)),
      "DURABLE_EXACT_CANONICAL_AUTHORITY_CLOSURE");
    for (const action of ["ACCEPT", "START", "DELIVER", "RELEASE_LABOR"]) ok(await act(id, b.id, human, action,
      "unrelated-" + action, action === "DELIVER" ? { value: "42" } : {}));
    ok(await act(id, b.id, checker, "VERIFY", "unrelated-independent-verification"));
    const continued = await waitFor("unrelated-closed-with-scoped-authority-deny", () => current(id),
      q => q.program.assignments.find((v: any) => v.taskId === b.id).state.kind === "CLOSED");
    assert.equal(continued.status, "FENCED");
    assert.deepEqual([...continued.currentness.affectedAssignmentIds].sort(), expected);
    return { injected, refused, beforeAnyReload, expected, durable, continued };
  });
  await runCase(2, async () => {
    const id = await submit(2, original([task("paid-parent", 1, "6", "6")], true));
    compensatedProgrammeId = id;
    ok(await act(id, "paid-parent", human, "ACCEPT", "actual-paid-parent-acceptance"));
    const child = task("paid-child", 2, "2", "2"); child.terms.compensation.value = "2";
    const { parentTaskId: _parent, delegatorActorId: _delegator, criterionId: _criterion, ...childTask } = child;
    ok(await act(id, "paid-parent", human, "SUBDELEGATE", "actual-parent-creates-paid-child", { refinement: {
      kind: "SUBDELEGATION", recipientActorId: contact, task: childTask, criterion: criterion("paid-child"), computation: participant } }));
    for (const action of ["ACCEPT", "START", "DELIVER", "RELEASE_LABOR"]) ok(await act(id, "paid-child", provider, action,
      "actual-paid-provider-" + action, action === "DELIVER" ? { value: "42" } :
        action === "RELEASE_LABOR" ? { value: { compensationSettled: true, receipt: "HOSTILE_CALLER_ASSERTION_NOT_FINANCIAL_EVIDENCE" } } : {}));
    const q = await current(id), accepted = q.compensation.records;
    assert.equal(accepted.length, 1);
    const obligation = accepted[0]; assert.equal(obligation.payeePrincipalId, provider);
    assert.equal(obligation.mapping.resourceId, cash.resourceId); assert.equal(obligation.mapping.resourceAmount, "2");
    assert.equal(obligation.mapping.amount.currency, "USD"); assert.equal(obligation.status, "OPEN");
    assert.equal(obligation.settlement.kind, "UNKNOWN"); assert.equal(q.compensation.externalSettlementEstablished, false);
    const native = (await admin!.query(`SELECT body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 AND event_id=$3`,
      [tenant, id, obligation.dispositionEventId])).rows[0].body;
    assert.equal(native.authenticatedPrincipal, provider); assert.equal(native.observation.decision, "ACCEPT");
    ok(await act(id, "paid-child", checker, "VERIFY", "independent-paid-child-verification"));
    const refused = await act(id, "paid-child", human, "CLOSE", "money-unknown-must-not-close");
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert(refused.body.detail.some((issue: any) => issue.code === "OPEN_OBLIGATION"), "CANONICAL_MONEY_OBLIGATION_BLOCKS_CLOSURE");
    const final = await current(id); assert.equal(final.compensation.records[0].status, "OPEN");
    await save("original-compensation-obligation-before-payment-boundary.json", { accepted, native, refused, final,
      originalWork: works[2], realPayment: false, laborReleaseWasNotPayment: true });
    assert(Array.isArray(final.compensation.paymentRequests), "CANONICAL_OUTBOUND_PAYMENT_PATH_NOT_A_CONSTANT_UNKNOWN_HELPER");
    const boundary = await waitFor("canonical-financial-protected-boundary", () => current(id), value =>
      value.compensation.paymentRequests.some((request: any) =>
        request.binding.obligationRef.contentDigest === obligation.ref.contentDigest &&
        request.boundaryObservations.some((entry: any) => entry.reachedBoundary === "S6_FINANCIAL_BROKER")));
    const payment = boundary.compensation.paymentRequests.find((request: any) =>
      request.binding.obligationRef.contentDigest === obligation.ref.contentDigest);
    assert.equal(payment.binding.originalRoot, works[2]);
    assert.deepEqual(payment.binding.originalReservation, obligation.originalReservation);
    assert.equal(payment.binding.payeePrincipalId, provider);
    assert.equal(payment.binding.termsDigest, obligation.termsDigest);
    assert.equal(payment.binding.financialTransferAuthorized, false);
    const disposition = payment.boundaryObservations.at(-1);
    assert.equal(disposition.admission, "UNADMITTED"); assert.equal(disposition.financialTransferAuthorized, false);
    assert.deepEqual(boundary.compensation.records[0], obligation, "PAYMENT_PREPARATION_MUST_NOT_REWRITE_ACCEPTANCE");
    assert.equal(boundary.compensation.externalSettlementEstablished, false);
    return { accepted, native, refused, payment, originalWork: works[2], originalReservationRetained: true,
      realPayment: false, laborReleaseWasNotPayment: true, monetaryOutcome: "UNKNOWN" };
  });
  await runCase(3, async () => {
    const id = await submit(3, original([task("protected-parent", 1, "4")]));
    ok(await act(id, "protected-parent", human, "ACCEPT", "protected-parent-acceptance"));
    const before = await current(id);
    const parent = before.program.assignments.find((value: any) => value.taskId === "protected-parent");
    const beforeUses = await uses(id);
    const historyCount = async () => (await admin!.query(`SELECT count(*)::int count FROM finnor_os.w2_events
      WHERE tenant_id=$1 AND program_id=$2 AND kind IN('TASK_CREATION','S6_INTENDED','FUNDING')`, [tenant, id])).rows[0].count;
    const beforeHistory = await historyCount();
    const protectedTask = task("protected-child", 2, "1");
    protectedTask.effectId = randomUUID();
    protectedTask.ceiling = { ...protectedTask.ceiling, effects: ["finnor-effect:controlled-unadmitted"] };
    const { parentTaskId: _p2, delegatorActorId: _d2, criterionId: _c2, ...childTask } = protectedTask;
    const requestProtected = () => act(id, "protected-parent", human, "SUBDELEGATE", "protected-child-refused-before-creation", { refinement: {
      kind: "SUBDELEGATION", recipientActorId: contact, task: childTask, criterion: criterion("protected-child"), computation: participant } });
    const refused = await requestProtected();
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "WORKFORCE_PROTECTED_DELEGATED_CHILD_ADAPTER_UNADMITTED");
    const after = await current(id);
    assert.equal(after.revision, before.revision, "REFUSAL_CHANGED_PROGRAMME");
    assert(!after.program.assignments.some((value: any) => value.taskId === "protected-child"), "REFUSED_CHILD_CREATED");
    assert.deepEqual(await uses(id), beforeUses, "REFUSAL_CONSUMED_RESOURCES");
    assert.equal(await historyCount(), beforeHistory, "REFUSAL_CREATED_CHILD_HISTORY");
    const bindings = (await admin!.query(`SELECT assignment_id,effect_key,effect_id,domain_action_id,consumption_id,refusal_digest,body
      FROM finnor_os.w2_protected_child_bindings WHERE tenant_id=$1 AND program_id=$2`, [tenant, id])).rows;
    assert.equal(bindings.length, 1, "EXACTLY_ONE_DURABLE_PROTECTED_CHILD_REFUSAL_BINDING");
    const binding = bindings[0];
    assert.equal(binding.assignment_id, parent.id);
    assert.equal(binding.effect_key, protectedTask.effectId);
    assert.equal(binding.effect_id, null, "NO_REAL_S6_ORIGIN_TO_BIND");
    assert.equal(binding.body.admission, "UNADMITTED");
    assert.equal(binding.body.protectedCustody, false);
    assert.equal(binding.body.executionAuthorityGranted, false);
    assert.equal(binding.body.originalRoot, works[3]);
    assert.equal(binding.body.s6Origin, null);
    assert.equal(binding.body.attemptHistory.length, 0);
    assert.equal(binding.body.parentChain.length, 1);
    assert.equal(binding.body.parentChain[0].assignmentId, parent.id);
    assert.equal(binding.body.refusalDigest, binding.refusal_digest);
    const retried = await requestProtected();
    assert.equal(retried.status, 409, JSON.stringify(retried.body));
    assert.equal(retried.body.error, "WORKFORCE_PROTECTED_DELEGATED_CHILD_ADAPTER_UNADMITTED");
    assert.notEqual(retried.body.detail.refusalDigest, refused.body.detail.refusalDigest,
      "RETRY_IS_AN_ACTUAL_NEW_CHECKED_CUT");
    const repeatedBindings = (await admin!.query(`SELECT refusal_digest,body
      FROM finnor_os.w2_protected_child_bindings WHERE tenant_id=$1 AND program_id=$2 ORDER BY created_at,refusal_digest`,
      [tenant, id])).rows;
    assert.equal(repeatedBindings.length, 2, "EACH_ACTUAL_PROTECTED_CHILD_REFUSAL_CUT_MUST_BE_DURABLE");
    for (const response of [refused, retried]) {
      const retained = repeatedBindings.find(value => value.refusal_digest === response.body.detail.refusalDigest);
      assert(retained, "EXACT_REFUSAL_CUT_RETAINED");
      assert.deepEqual(retained.body, response.body.detail);
      const { refusalDigest, ...preimage } = retained.body;
      assert.equal(refusalDigest, workforceDigest(preimage));
    }
    assert.equal((await current(id)).revision, before.revision, "RETRY_CHANGED_PROGRAMME");
    assert.deepEqual(await uses(id), beforeUses, "RETRY_CONSUMED_RESOURCES");
    assert.equal(await historyCount(), beforeHistory, "RETRY_CREATED_CHILD_HISTORY");
    // Refusal happened before child creation; the actual parent completes ordinarily.
    ok(await act(id, "protected-parent", human, "START", "protected-parent-start"));
    ok(await act(id, "protected-parent", human, "DELIVER", "protected-parent-delivery", { value: "42" }));
    ok(await act(id, "protected-parent", human, "RELEASE_LABOR", "protected-parent-labor-release"));
    ok(await act(id, "protected-parent", checker, "VERIFY", "protected-parent-independent-verification"));
    const closed = await waitFor("protected-parent-closes-after-refusal", () => current(id),
      (q: any) => q.program.assignments.find((value: any) => value.taskId === "protected-parent").state.kind === "CLOSED");
    assert.equal(closed.program.assignments.length, 1, "REFUSED_CHILD_NEVER_EXISTS");
    return { refused, retried, retainedRefusalCuts: repeatedBindings.length, childCreated: false, protectedAdmission: false,
      binding: { assignmentId: binding.assignment_id, effectKey: binding.effect_key, effectId: binding.effect_id,
        refusalDigest: binding.refusal_digest, admission: binding.body.admission, s6Origin: binding.body.s6Origin,
        parentChainLength: binding.body.parentChain.length },
      closedRevision: closed.revision };
  });
  await runCase(6, async () => {
    const id = compensatedProgrammeId; assert(id, "SAME_ORIGINAL_PAID_WORK_REQUIRED");
    const child = task("paid-compute-child", 0, "2", "2"); child.terms.compensation.value = "2";
    const { parentTaskId: _parent, delegatorActorId: _delegator, criterionId: _criterion, ...childTask } = child;
    const independentCriterion = { ...criterion("paid-compute-child"), evidenceCustodianActorId: human };
    assert.notEqual(independentCriterion.checkerActorId, principal, "PAID_PRODUCER_MUST_NOT_BE_ITS_CHECKER");
    assert.notEqual(independentCriterion.evidenceCustodianActorId, principal, "PAID_PRODUCER_MUST_NOT_HOLD_HIDDEN_CRITERION");
    ok(await act(id, "paid-parent", human, "SUBDELEGATE", "same-original-paid-compute-child", { refinement: {
      kind: "SUBDELEGATION", recipientActorId: principal, task: childTask, criterion: independentCriterion,
      computation: { kind: "SUM_INTEGERS", values: ["40", "2"] } } }));
    ok(await act(id, "paid-compute-child", principal, "ACCEPT", "actual-paid-machine-accepts-exact-terms"));
    const done = await waitFor("paid-local-computation-real-output", async () => {
      const value = await current(id);
      const jobs = (await admin!.query(`SELECT id,status,last_error,claim_fence FROM finnor_os.jobs
        WHERE tenant_id=$1 AND payload->>'programId'=$2 ORDER BY run_at,id`, [tenant, id])).rows;
      if (jobs.some(row => String(row.last_error).includes("WORKFORCE_S5_OUTSTANDING_COMPENSATION_FRONTIER_REQUIRED"))) {
        await save("paid-local-computation-actual-worker-frontier-error.json", { value, jobs });
        throw Error("PAID_LOCAL_COMPUTATION_MUST_NOT_SPEND_ITS_PROMISED_PAYCHECK:" + JSON.stringify(jobs));
      }
      return value;
    }, value => value.program.assignments.some((assignment: any) => assignment.taskId === "paid-compute-child" &&
      ["DELIVERED", "VERIFIED", "CLOSED"].includes(assignment.state.kind)));
    const assignment = done.program.assignments.find((value: any) => value.taskId === "paid-compute-child");
    const own = (await uses(id)).filter(row => row.body.nodeId === assignment.id);
    assert.equal(own.length, 1, "ONE_ACTUAL_NATIVE_MACHINE_USE");
    assert(own[0].body.envelope.find((entry: any) => entry.resourceId === cash.resourceId).quantities
      .every((value: string) => value === "0"), "PAYABLE_CASH_IS_NOT_LOCAL_COMPUTATION_SPENDING");
    const obligation = done.compensation.records.find((record: any) => record.assignmentId === assignment.id);
    assert(obligation); assert.equal(obligation.payeePrincipalId, principal);
    assert.equal(obligation.mapping.amount.value, "2"); assert.equal(obligation.status, "OPEN");
    assert.equal(obligation.workId, works[2]); assert.equal(done.originalDeadline, expires);
    const native = (await admin!.query(`SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2
      AND kind IN('S6_INTENDED','S6_OBSERVATION') AND body->>'assignmentId'=$3 ORDER BY created_at,event_id`,
    [tenant, id, assignment.id])).rows;
    assert.equal(native.length, 2); assert.equal(native.find(row => row.kind === "S6_OBSERVATION").body.value, "42");
    return { assignment, own, obligation, native, sameOriginalWork: works[2], realPayment: false };
  });
  await runCase(5, async () => {
    const observations: unknown[] = [], errors: string[] = [];
    const programmeCount = Number((await admin!.query(
      "SELECT count(*) count FROM finnor_os.w2_programs WHERE tenant_id=$1", [tenant])).rows[0].count);
    for (const confirmed of [false, true]) {
      const label = confirmed ? "confirmed" : "proposed", renewalContact = randomUUID();
      try {
        await admin!.query(`INSERT INTO finnor_os.external_contacts(tenant_id,id,contact_key,name)
          VALUES($1,$2,$3,'Disposable expiry fixture, not a registered workforce actor')`,
        [tenant, renewalContact, "controlled-renewal-" + renewalContact]);
        const deadline = new Date(Date.now() + 3000).toISOString();
        const initialInput = { contactId: renewalContact, recipientPrincipalId: provider,
          purpose: "controlled-renewal-" + label, validUntil: deadline, idempotencyKey: "original-" + label };
        const initial = await api("workforce/participants", initialInput);
        assert.equal(initial.status, 202, JSON.stringify(initial.body));
        if (confirmed) ok(await api("workforce/participants/" + initial.body.id, { action: "CONFIRM",
          proposalDigest: initial.body.proposalDigest, expectedRevision: 0,
          idempotencyKey: "original-recipient-" + label }, provider));
        const beforeEvents = (await admin!.query(`SELECT event_key,body,body::text canonical_body FROM finnor_os.w2_contact_binding_events
          WHERE tenant_id=$1 AND binding_id=$2 ORDER BY created_at,event_key`, [tenant, initial.body.id])).rows;
        assert.equal(beforeEvents.length, confirmed ? 2 : 1);
        await waitFor("natural-contact-validity-" + label, async () => Date.now(), at => at >= Date.parse(deadline));
        const oldPrivate = await api("workforce/participants", undefined, checker);
        assert.equal(oldPrivate.status, 200);
        assert(!oldPrivate.body.data.some((row: any) => row.id === initial.body.id), "OLD_BINDING_IS_PRIVATE_TO_ITS_PARTICIPANTS");
        const renewedInput = { ...initialInput, validUntil: expires, idempotencyKey: "fresh-" + label };
        const renewed = await api("workforce/participants", renewedInput, checker);
        assert.equal(renewed.status, 202, "EXPIRED_BINDING_MUST_NOT_BLOCK_FRESH_PROPOSAL:" + JSON.stringify(renewed));
        assert.notEqual(renewed.body.id, initial.body.id);
        assert.equal(renewed.body.status, "PROPOSED", "OLD_CONFIRMATION_CANNOT_BECOME_NEW_CONSENT");
        ok(await api("workforce/participants/" + renewed.body.id, { action: "CONFIRM",
          proposalDigest: renewed.body.proposalDigest, expectedRevision: 0,
          idempotencyKey: "fresh-exact-recipient-" + label }, provider));
        const replay = await api("workforce/participants", renewedInput, checker);
        assert.equal(replay.status, 202); assert.equal(replay.body.id, renewed.body.id);
        assert.equal(replay.body.status, "CONFIRMED"); assert.equal(replay.body.semanticReplay, true);
        const conflict = await api("workforce/participants", { ...renewedInput, idempotencyKey: "competing-" + label });
        assert.equal(conflict.status, 409, JSON.stringify(conflict));
        assert.equal(conflict.body.error, "WORKFORCE_ENROLLMENT_CURRENT_BINDING_EXISTS");
        assert.deepEqual(Object.keys(conflict.body), ["error"], "CONFLICT_MUST_NOT_DISCLOSE_PRIVATE_BINDING");
        const rows = (await admin!.query(`SELECT id,status,revision,proposal_digest,principal_id,recipient_principal_id
          FROM finnor_os.w2_contact_bindings WHERE tenant_id=$1 AND contact_id=$2 ORDER BY created_at,id`,
        [tenant, renewalContact])).rows;
        assert.equal(rows.length, 2); const old = rows.find(row => row.id === initial.body.id)!;
        assert.equal(old.status, "EXPIRED"); assert.equal(old.revision, confirmed ? 2 : 1);
        assert.equal(old.proposal_digest, initial.body.proposalDigest);
        assert.equal(old.principal_id, principal); assert.equal(old.recipient_principal_id, provider);
        assert.equal(rows.filter(row => ["PROPOSED", "CONFIRMED"].includes(row.status)).length, 1);
        const afterEvents = (await admin!.query(`SELECT event_key,body,body::text canonical_body FROM finnor_os.w2_contact_binding_events
          WHERE tenant_id=$1 AND binding_id=$2 ORDER BY created_at,event_key`, [tenant, initial.body.id])).rows;
        assert.equal(afterEvents.length, beforeEvents.length + 1);
        for (const previous of beforeEvents) assert.deepEqual(afterEvents.find(row => row.event_key === previous.event_key), previous,
          "ORIGINAL_PROPOSAL_AND_CONSENT_MUST_REMAIN_BYTE_EQUIVALENT");
        const expiration = afterEvents.find(row => row.body.action === "EXPIRE");
        assert(expiration, "EXPLICIT_CLOCK_EXPIRY_NOT_FABRICATED_HUMAN_REVOCATION");
        assert.equal(expiration.body.obligationsReleased, false);
        assert.equal(expiration.body.authorityGranted, false);
        observations.push({ label, deadline, initial, oldPrivate, renewed, replay, conflict, rows, beforeEvents, afterEvents });
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        observations.push({ label, error: message }); errors.push(message);
      }
    }
    await save("participant-expiry-both-native-boundaries.json", { observations, errors, realClock: true,
      extraRegisteredActors: 0, extraWorks: 0, genuineHumanQualified: false, contactSent: false });
    assert.deepEqual(errors, [], "BOTH_PROPOSED_AND_CONFIRMED_NATIVE_RENEWALS_MUST_PASS");
    assert.equal(Number((await admin!.query("SELECT count(*) count FROM finnor_os.w2_programs WHERE tenant_id=$1",
      [tenant])).rows[0].count), programmeCount, "ENROLLMENT_MUST_NOT_CREATE_NEW_WORK");
    return { observations, genuineHumanQualified: false, contactSent: false };
  });
  await runCase(4, async () => {
    const id = await submit(4, original([task("rights-boundary", 1, "4")]));
    for (const action of ["ACCEPT", "START"]) ok(await act(id, "rights-boundary", human, action, "rights-before-" + action));
    const q = (await admin!.query("SELECT budget FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, id])).rows[0];
    const held = (await admin!.query("SELECT * FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
      [tenant, q.budget.reservationRef.id])).rows[0]; assert.equal(held.status, "CONSUMPTION_PENDING");
    const before = await uses(id), injected = await deny(principal, "action:allocate_resource", "allocation_resource", operation.scopeRef.id);
    const refused = await act(id, "rights-boundary", human, "DELIVER", "held-reservation-is-not-current-allocation-right", { value: "42" });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "WORKFORCE_S5_CURRENT_ALLOCATION_AUTHORITY_DENIED");
    assert.deepEqual(await uses(id), before, "NO_NEW_USE_AFTER_CURRENT_ALLOCATION_RIGHT_REVOKED");
    const after = (await admin!.query("SELECT * FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
      [tenant, q.budget.reservationRef.id])).rows[0]; assert.deepEqual(after, held, "ORIGINAL_HELD_RESERVATION_RETAINED");
    return { injected, refused, originalReservation: q.budget.reservationRef, originalUseCount: before.length };
  });
  assert.equal(results.length, contract.cases.length); assert(results.every(value => value.status === "PASS"), "ALL_NATIVE_RECOVERY_OWNERS_MUST_PASS");
  assert(traffic.length < 20000, "COMPLETE_NATIVE_HTTP_TRACE");
  assert.deepEqual(traffic.filter(value => value.status >= 500), [], "NO_NATIVE_HTTP_SERVER_FAILURE");
  for (const source of sources) assert.equal(sha(await readFile(join(root, source.path))), source.sha256, "SOURCE_CHANGED:" + source.path);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error); console.error(failure);
} finally {
  clearTimeout(wall); resume();
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const child = worker, done = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timer);
  }
  try {
  if (admin) await save("final-owning-ledger-observation.json", {
    programmes: (await admin.query("SELECT id,work_id,status,revision,budget,program FROM finnor_os.w2_programs ORDER BY id LIMIT 4")).rows,
    jobs: (await admin.query("SELECT id,type,status,attempts,last_error,claim_fence FROM finnor_os.jobs ORDER BY run_at,id LIMIT 256")).rows,
    financial: (await admin.query("SELECT subject_id,operation,body FROM finnor_os.s5_history WHERE operation='WORKFORCE_COMPENSATION_ACCEPTANCE' ORDER BY subject_id LIMIT 32")).rows,
    nativeEvents: (await admin.query("SELECT program_id,event_id,kind,body,created_at::text FROM finnor_os.w2_events WHERE tenant_id=$1 ORDER BY program_id,created_at,event_id", [fixtureTenantId ?? null])).rows,
    s5Consumption: (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
      JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
      WHERE co.tenant_id=$1 ORDER BY co.consumption_id`, [fixtureTenantId ?? null])).rows,
    s5History: (await admin.query("SELECT subject_id,revision,operation,body FROM finnor_os.s5_history WHERE tenant_id=$1 ORDER BY subject_id,revision", [fixtureTenantId ?? null])).rows,
    evidencePreimages: (await admin.query(`SELECT s.id source_id,s.source_key,v.id,v.version_number,v.content_hash,v.content
      FROM finnor_os.evidence_sources s JOIN finnor_os.evidence_source_versions v
        ON v.tenant_id=s.tenant_id AND v.source_id=s.id WHERE s.tenant_id=$1 AND
        (s.source_key LIKE 'workforce:%' OR s.id IN(SELECT jsonb_array_elements_text(original->'actorSourceIds')::uuid
          FROM finnor_os.w2_programs WHERE tenant_id=$1))
      ORDER BY s.id,v.version_number`, [fixtureTenantId ?? null])).rows,
  });
  await save("actual-physical-worker.log.json", { log: workerLog });
  } catch (error) {
    failure = (failure ? failure + "\n" : "") + "REQUIRED_OWNING_LEDGER_CAPTURE_FAILED:" + String(error);
    console.error(failure);
  }
  await service?.close().catch(() => {}); await closePool().catch(() => {}); await admin?.end().catch(() => {});
  let allocatedBefore = 0;
  if (directory) allocatedBefore = Number(execFileSync("du", ["-sk", directory], { encoding: "utf8" }).split(/\s/)[0]) * 1024;
  await database?.stop().catch(() => {});
  if (directory && !(await readdir(directory)).length) await rmdir(directory);
  const free = statfsSync(root, { bigint: true });
  const ledger = process.env.FINNOR_W2_COORDINATION_LEDGER ?? join(evidence, "cleanup-ledger.log");
  assert(ledger.startsWith("/"), "ABSOLUTE_OWNED_COORDINATION_LEDGER_REQUIRED");
  await appendFile(ledger,
    `${new Date().toISOString()} W2 native-recovery-owned-PG-cleanup allocatedBytesBeforeStop=${allocatedBefore} freeBytes=${free.bavail * free.bsize}\n`);
  await save("traffic-without-credentials.json", traffic);
  await save("report.json", { schema: "finnor.postz.w2.native-recovery-e2e-report.v1", status: failure ? "FAIL" : "PASS",
    failure, results, contract, sourceHashes: sources, installedRuntime: Boolean(installation), recordedBytesBeforeReport: outputBytes,
    genuineHumanQualified: false, realPayment: false, protectedQualification: false, monetaryCost: "UNKNOWN", humanTime: "UNKNOWN" });
  console.log(JSON.stringify({ evidence, status: failure ? "FAIL" : "PASS", passed: results.filter(value => value.status === "PASS").length }));
}
process.exit(failure ? 1 : 0);
