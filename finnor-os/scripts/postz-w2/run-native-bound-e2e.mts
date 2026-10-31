/** Separate native representation/participant campaign. All human/provider
 * records and responses are explicitly controlled; none is human qualification.
 * This never enlarges the original nine-Work / 100-unit interruption fixture. */
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
import { readCanonicalAuthoritySourceProofsTx, readWorkforceAuthoritySourcesTx } from "@finnor/authority";
import type { AuthorityRequest } from "@finnor/shared-types";
import { parseAllocationResource } from "../../packages/epistemic-runtime/src/allocation-contracts";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { nativeWorkforceOriginalSchema, type NativeWorkforceOriginal } from "../../packages/orchestration/src/workforce-execution/contracts";
import { workforceActorSchema } from "../../packages/workforce/src/execution-program/schema";
import { authenticatedApiFixture } from "../frontier5/x1/authenticated-api-fixture.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url)), backend = join(root, "finnor-os");
const base = process.env.FINNOR_W2_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/native-bound");
assert(base.startsWith("/"));
const evidence = join(base, "native-bound-run-" + Date.now()), installation = process.env.FINNOR_W2_INSTALLATION;
await mkdir(evidence, { recursive: true, mode: 0o700 });
const save = (name: string, body: unknown) => writeFile(join(evidence, name), JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const contract = { schema: "finnor.postz.w2.native-bound-campaign.v1", registeredActors: 128, liveAssignments: 512,
  maximumDepth: 8, authenticatedPrincipals: 4, originalWorks: 4, originalResourceUnits: "100",
  perWorkOriginalCeiling: "25", physicalWorkers: 1, wallSeconds: 1200, fullCompilationObservationSeconds: 600,
  initialOffers: 512, legitimateInternalMachineDispositions: 506, expectedInitialRevision: 1018,
  sourceClass: "CONTROLLED_ACTOR_RECORDS", genuineHumanQualified: false, protectedQualification: false,
  cases: ["whole-128-512-depth8-every-leaf", "four-controlled-actor-pairings", "129-actors-refuse-before-intake",
    "513-assignments-refuse-without-truncation", "depth-nine-refuse", "exact-external-enrollment-not-acceptance",
    "actual-nonowner-external-acceptance-delivery-independent-verification", "changed-source-smallest-p7-closure",
    "unaffected-authenticated-branch-progress-with-fenced-neighbor"] };
await save("frozen-contract.json", contract);
const disk = statfsSync(root, { bigint: true });
assert(disk.bavail * disk.bsize >= 3n * 1024n ** 3n, "GLOBAL_3_GIB_FLOOR");
const frozenPaths = ["finnor-os/packages/authority/src/index.ts", "finnor-os/apps/api/app/api/me/route.ts",
  "finnor-os/packages/governed-execution/src/workforce-local-attempt.ts",
  "finnor-os/packages/governed-execution/src/executor.ts",
  "finnor-os/packages/governed-execution/src/adapter-contract.ts",
  "finnor-os/packages/private-equity/src/workforce-compensation.ts",
  "finnor-os/packages/private-equity/src/workforce-allocation.ts", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/packages/db/migrations/postz_w2_execution_completion.sql",
  "finnor-os/packages/db/migrations/postz_w2_protected_child.sql", "finnor-os/scripts/postz-w2/run-native-bound-e2e.mts",
  ...["contracts", "store", "runtime", "worker", "dependencies", "native-authority", "participants", "protected-child", "index"].map(name =>
    `finnor-os/packages/orchestration/src/workforce-execution/${name}.ts`),
  ...["schema", "compiler", "checker", "lifecycle", "graph", "exact"].map(name =>
    `finnor-os/packages/workforce/src/execution-program/${name}.ts`)];
const sources = await Promise.all(frozenPaths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })));
await save("source-cut.json", { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sources, installedRuntime: Boolean(installation), protectedCustody: false });
const results: unknown[] = [], traffic: unknown[] = [];
const pass = (id: string, observed: unknown) => { results.push({ id, status: "PASS", observed }); console.log(JSON.stringify({ id, status: "PASS" })); };
let expired = false;
const wall = setTimeout(() => { expired = true; worker?.kill("SIGTERM"); }, contract.wallSeconds * 1000);
const waitFor = async <T,>(name: string, observe: () => Promise<T>, ready: (v: T) => boolean, ms = 45000) => {
  const end = Date.now() + ms; let last: T;
  do {
    assert(!expired, "ORIGINAL_CAMPAIGN_WALL_EXHAUSTED");
    last = await observe(); if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < end);
  await save("timeout-" + name + ".json", last!); throw Error("FINITE_NATIVE_BOUND_OBSERVATION:" + name);
};
const freePort = () => new Promise<number>((yes, no) => {
  const socket = createServer(); socket.once("error", no);
  socket.listen(0, "127.0.0.1", () => {
    const address = socket.address(); assert(address && typeof address !== "string");
    socket.close(() => yes(address.port));
  });
});
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined, worker: ChildProcess | undefined;
let service: Awaited<ReturnType<typeof authenticatedApiFixture>> | undefined, directory: string | undefined;
let failure: string | null = null, workerLog = "", manifest: any;
const sqlDiagnostics: string[] = [], sessionDiagnostics: unknown[] = [];
const redactSql = (value: string) => value.replace(/'(?:[^']|'')*'/g, "'<literal>'");
let sampling: ReturnType<typeof setInterval> | undefined, pendingSample: Promise<void> | undefined;
const sampleSessions = () => {
  if (!admin || pendingSample || sessionDiagnostics.length >= 2048) return;
  pendingSample = admin.query(`SELECT pid,usename,state,wait_event_type,wait_event,backend_xid,
    pg_blocking_pids(pid) blockers,clock_timestamp()-query_start query_age,
    clock_timestamp()-xact_start transaction_age,left(query,2000) statement
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid LIMIT 128`)
    .then(result => { sessionDiagnostics.push({ at: new Date().toISOString(), sessions: result.rows.map(row =>
      ({ ...row, statement: redactSql(row.statement ?? "") })) }); })
    .catch(error => { sessionDiagnostics.push({ at: new Date().toISOString(), diagnosticError: String(error) }); })
    .finally(() => { pendingSample = undefined; });
};
try {
  process.env.NODE_ENV = "test"; process.env.AUTH_DEV_BYPASS = "0";
  process.env.FINNOR_P4_PROFILE = "ordinary_disposable"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.RATE_LIMIT_PER_MINUTE = "10000"; process.env.RATE_LIMIT_IP_PER_MINUTE = "10000";
  directory = await mkdtemp("/tmp/finnor-w2-bound-owned-");
  const port = await freePort(), password = randomBytes(32).toString("hex");
  const appPassword = randomBytes(32).toString("hex"), workerPassword = randomBytes(32).toString("hex");
  database = new EmbeddedPostgres({ databaseDir: join(directory, "database"), user: "w2_fixture", password, port,
    persistent: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=",
      "-c", "log_min_error_statement=error", "-c", "log_error_verbosity=terse"],
    onLog: message => { if (sqlDiagnostics.length < 2048 && /ERROR:|STATEMENT:|DETAIL:|CONTEXT:/.test(message))
      sqlDiagnostics.push(redactSql(message)); } });
  await database.initialise(); await database.start(); await database.createDatabase("w2_native_bound");
  const connection = (user: string, pass: string) => `postgres://${user}:${pass}@127.0.0.1:${port}/w2_native_bound`;
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
  const tenant = randomUUID(), people = Array.from({ length: 128 }, () => randomUUID()), contact = randomUUID();
  const principal = people[0]!, human = people[2]!, provider = people[3]!, checker = people[127]!;
  const actorIds = people.map((id, i) => i === 3 ? contact : id);
  const works = Array.from({ length: 4 }, () => randomUUID()), now = Date.now();
  const iso = (delta: number) => new Date(now + delta).toISOString(), expires = iso(3600000);
  const ref = (owner: string, id: string) => ({ owner, id, version: "controlled-native-bound-v1", contentDigest: sha(id) });
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Controlled native bound, not field capacity')", [tenant, randomUUID()]);
  for (const [i, id] of people.entries()) {
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
      VALUES($1,$2,$3,$4,'active','Controlled canonical actor, not a genuine consenting human')`,
      [id, tenant, id + "@test.invalid", i === 2 || i === 3 ? "participant" : "owner"]);
    await admin.query(`INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind)
      VALUES($1,$2,$3)`, [tenant, id, [0, 2, 3].includes(i) ? "HUMAN" : "SERVICE"]);
  }
  const role = randomUUID();
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
    VALUES($1,$2,'w2-controlled-standing-participant','Explicit disposable standing participant grants')`, [role, tenant]);
  for (const id of [human, provider]) await admin.query(`INSERT INTO finnor_os.employee_role_assignments
    (tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`, [tenant, id, role]);
  for (const capability of ["query:work", "action:workforce_assign_contract", "action:workforce_respond_contract"])
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,$3,'*','allow','low')`, [tenant, role, capability]);
  await admin.query(`INSERT INTO finnor_os.external_contacts(tenant_id,id,contact_key,name)
    VALUES($1,$2,$3,'Controlled provider contact, no contact sent')`, [tenant, contact, "controlled-" + contact]);
  process.env.DATABASE_URL = connection("finnor_app", appPassword); await closePool();
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: principal, sourceSystem: "W2:controlled-native-bound" });
  const auth = { tenantId: tenant, userId: principal, employeeId: principal, role: "owner" as const };
  const sourceIds: string[] = [], snapshots: any[] = [];
  const kinds = people.map((_, i) => i === 3 ? "EXTERNAL_PROFESSIONAL" : [0, 2].includes(i) ? "INTERNAL_HUMAN" : "COMPUTATIONAL_CELL");
  for (const [i, id] of people.entries()) {
    const actor = workforceActorSchema.parse({ id: actorIds[i], tenantId: tenant, identityRef: ref("identity", actorIds[i]!),
      kind: kinds[i], status: "CURRENT",
      capabilities: [{ skill: "skill-" + i, scope: "analysis", evidenceRef: ref("S1", "qualification-" + i), certainty: "OBSERVED", validUntil: expires }],
      availability: { kind: "OBSERVED", ref: ref("S1", "schedule-" + i), validUntil: expires,
        slots: [{ startAt: iso(-60000), endAt: expires, capacity: "512", committed: "0" }], maxConcurrent: 512,
        humanLimits: [0, 2, 3].includes(i) ? { kind: "OBSERVED", maxEffortSeconds: "512", alreadyCommittedSeconds: "0",
          fatigue: "WITHIN_LIMIT", ref: ref("S1", "controlled-physical-limits-" + i) } : { kind: "NOT_HUMAN" } } });
    const snapshot = { schema: "finnor.workforce-actor-evidence.v1", canonical: { kind: i === 3 ? "EXTERNAL_CONTACT" : "USER", id: actorIds[i], principalId: id },
      actor, qualification: "AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION" };
    const source = await withTenantTransaction(tenant, { userId: principal }, async (_db, c) => {
      const db = transactionDb(c), created = await createEvidenceSourceTx(db, tenant,
        { sourceKey: "w2-bound-controlled:" + i, sourceType: "workforce_actor_evidence", title: "Explicitly controlled actor and capacity assertion" });
      await appendEvidenceVersionTx(db, tenant, created.id, { content: JSON.stringify(snapshot), snapshot }); return created;
    });
    sourceIds.push(source.id); snapshots.push(snapshot);
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
    const response = await fetch(service!.origin + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + tokens.get(actor), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const proposal = await api("workforce/participants", { contactId: contact, recipientPrincipalId: provider,
    purpose: "controlled-native-bound", validUntil: expires, idempotencyKey: "existing-contact-binding" });
  assert.equal(proposal.status, 202, JSON.stringify(proposal.body));
  const confirmed = await api("workforce/participants/" + proposal.body.id, { action: "CONFIRM",
    proposalDigest: proposal.body.proposalDigest, expectedRevision: 0, idempotencyKey: "actual-controlled-provider-confirms" }, provider);
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.w2_events WHERE kind='DISPOSITION'")).rows[0].n, 0);
  await save("exact-existing-provider-enrollment-not-assignment-acceptance.json", { proposal, confirmed,
    credentialsMintedByEnrollment: false, grantsMintedByEnrollment: false, genuineHumanQualified: false });
  pass("exact-external-enrollment-not-assignment-acceptance", { confirmed: true, assignmentDispositions: 0 });
  const rights = String((await admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision);
  const authorityEquivalence = await withTenantTransaction(tenant, { userId: principal }, async (_db, c) => {
    const requests: AuthorityRequest[] = ["query:work", "action:workforce_respond_contract",
      "action:workforce_assign_contract"].map(capability => ({ capability,
      operation: capability.startsWith("query:") ? "query" : "action",
      workId: works[0]!, resource: { type: "work", id: works[0]! }, risk: "low" }));
    const population = await readWorkforceAuthoritySourcesTx(auth,
      new Map(people.map(id => [id, requests])), c);
    const observed = [];
    for (const id of people) {
      const scalar = await readCanonicalAuthoritySourceProofsTx(
        { ...auth, userId: id, employeeId: id }, requests, c, true);
      const actual = population.get(id);
      assert(actual, "COMPLETE_CURRENT_AUTHORITY_POPULATION");
      assert.deepEqual(actual.proofs, scalar, "EXACT_CURRENT_AUTHORITY_POPULATION_EQUALS_SCALAR");
      assert.equal(String(actual.revision), rights);
      observed.push({ principalId: id, requests: requests.length, proofDigest: sha(JSON.stringify(scalar)) });
    }
    return { principals: observed.length, requests: observed.length * requests.length,
      exactScalarProofEquality: true, source: "SAME_CANONICAL_AUTHORITY_TABLES", observed };
  });
  await save("canonical-authority-population-equivalence.json", authorityEquivalence);
  const horizon = { startAt: iso(-60000), periodMs: 3600000, periods: 1 };
  const resource = await putAllocationResource({ auth }, parseAllocationResource({
    schema: "finnor.allocation-resource.v1", resourceId: "w2-bound-operations", resourceClass: "COMPUTE", tenantId: tenant,
    ownerRef: ref("BUSINESS_OWNER", principal), legalEntityRef: ref("S1", tenant), scopeRef: ref("BUSINESS_OWNER", principal),
    permittedRoots: works.map(entityId => ({ entityType: "work", entityId })), rightsRef: `authority:${tenant}:${rights}`,
    unit: "workforce-operation", currency: null, kind: "CUMULATIVE_EXPENDITURE", horizon, sourceRef: ref("BUSINESS_OWNER", "controlled-native-capacity"),
    asOf: iso(0), knowledgeAt: iso(0), validUntil: expires, beliefPins: [], availability: [{ amount: "100", basis: "REPORTED_AVAILABLE" },
      { amount: "100", basis: "REPORTED_AVAILABLE" }], existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
    qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }), null);
  const envelope = (amount: string) => ({ resourceId: resource.resourceId, unit: resource.unit, kind: resource.kind,
    horizon, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["query:work"], dataScopes: ["work:self"], purposes: ["controlled-native-bound"], effects: [],
    validFrom: iso(-60000), validUntil: expires, allowSubdelegation: true };
  const fraction = (n: number) => { let d = 1024; while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; } return d === 1 ? String(n) : `${n}/${d}`; };
  const target = (i: number) => i < 8 ? i % 2 === 0 ? 1 : 2 : i === 8 ? 4 : i === 9 ? 2 : i === 10 ? 3 : 4 + (i - 11) % 122;
  const original = (count: number, depth: number, providerOnly = false): NativeWorkforceOriginal => nativeWorkforceOriginalSchema.parse({
    schema: "finnor.workforce-original-outcome.v1", sourceClass: "CONTROLLED_ACTOR_RECORDS", actorSourceIds: sourceIds,
    resources: { resourceRefs: [resource.ref], schedules: [{ resourceId: resource.resourceId, quantities: ["25", "0"] }] },
    outcome: { deadline: expires, ceiling, resourceLimits: [envelope("25")],
      criteria: Array.from({ length: Math.min(count, 512) }, (_, i) => ({ id: "criterion-" + i, checkerActorId: checker,
        evidenceCustodianActorId: people[126], acceptance: { kind: "EXACT_JSON", expected: "42" } })),
      tasks: Array.from({ length: count }, (_, i) => {
        const who = providerOnly ? 3 : target(i), parent = i > 0 && i < depth ? i - 1 : null;
        return { id: "task-" + i, parentTaskId: parent === null ? null : "task-" + parent, dependsOn: [], returnTo: [],
          delegatorActorId: parent === null ? i === 8 ? people[1] : principal : actorIds[target(parent)],
          criterionId: "criterion-" + Math.min(i, 511), requiredCapabilities: [{ skill: "skill-" + who, scope: "analysis" }],
          allowedActorKinds: [kinds[who]], assignmentMode: who === 3 ? "EXTERNAL_VOLUNTARY" : "INTERNAL_AUTHORIZED",
          ceiling, terms: { revision: 1, deliverable: "Controlled native bound deliverable " + i, compensation: { value: "0", unit: "USD" },
            subdelegation: true, expiresAt: expires }, dueAt: expires, slot: { startAt: iso(-60000), endAt: expires },
          effortSeconds: "0.01", demand: [envelope(providerOnly ? "1" : fraction(i < depth ? depth - i : 1))],
          context: { dataScopes: ["work:self"], purposes: ["controlled-native-bound"], includesCredentials: false }, effectId: null };
      }) },
    operations: Array.from({ length: Math.min(count, 512) }, (_, i) => ({ taskId: "task-" + i,
      computation: { kind: "PARTICIPANT_INPUT", prompt: "Controlled actual recipient must supply the permitted result; no human response is inferred." } })) });
  const args = installation ? ["--max-old-space-size=1536", join(installation, manifest.entrypoints.worker)] :
    ["--max-old-space-size=1536", "--import", join(backend, "node_modules/tsx/dist/loader.mjs"), join(backend, "scripts/postz-w2/physical-worker.mts")];
  worker = spawn(process.execPath, args, { cwd: installation ? join(installation, "finnor-os") : backend,
    env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: connection("finnor_worker", workerPassword), WORKER_JOB_LEASE_SECONDS: "3",
      FINNOR_WORKLOAD_CLASS: "", LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (bytes: Buffer) => { workerLog += bytes.toString(); if (Buffer.byteLength(workerLog) > 2097152) { worker?.kill("SIGKILL"); failure = "NATIVE_BOUND_WORKER_LOG_LIMIT"; } };
  worker.stdout!.on("data", collect); worker.stderr!.on("data", collect);
  await waitFor("actual-physical-worker-ready", async () => ({ log: workerLog, exit: worker!.exitCode, signal: worker!.signalCode }),
    value => { if (value.exit !== null || value.signal !== null) throw Error("ACTUAL_WORKER_STOPPED:" + value.log); return value.log.includes("W2_PHYSICAL_WORKER_READY"); }, 30000);
  const submit = async (work: number, body: NativeWorkforceOriginal) => {
    const response = await api("workforce/execution-programs/intake", { workId: works[work], idempotencyKey: "native-bound-" + work, original: body });
    assert.equal(response.status, 202, JSON.stringify(response.body)); return response.body.id as string;
  };
  const fullInput = original(512, 8), full = await submit(0, fullInput);
  await save("whole-profile-original-input.json", { workId: works[0], original: fullInput });
  await waitFor("complete-512-native-compile", async () => (await admin!.query(
    "SELECT status,revision,compile_result FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, full])).rows[0],
  value => { if (["BLOCKED", "FENCED"].includes(value.status)) throw Error("FULL_NATIVE_PROFILE_REFUSED:" + JSON.stringify(value)); return value.revision === contract.expectedInitialRevision; }, 600000);
  const whole = await api("workforce/execution-programs/" + full);
  assert.equal(whole.status, 200, JSON.stringify(whole.body)); assert.equal(whole.body.currentCheck.valid, true);
  assert.equal(whole.body.program.assignments.length, 512);
  assert.equal(whole.body.program.assignments.filter((a: any) => a.state.kind === "ACCEPTED").length, 506);
  assert.equal(whole.body.program.assignments.filter((a: any) => a.state.kind === "OFFERED").length, 6);
  assert.deepEqual(whole.body.currentCheck.checked, { actors: 128, assignments: 512, tasks: 512, maximumDepth: 8, fundingRecords: 512, possibleEffects: 0 });
  assert.equal(whole.body.compileResult.metrics.actorsConsidered, 128); assert.equal(whole.body.compileResult.metrics.tasksConsidered, 512);
  const persisted = (await admin.query(`WITH RECURSIVE tree AS (
      SELECT assignment_id,body,1 depth FROM finnor_os.w2_assignment_heads WHERE tenant_id=$1 AND program_id=$2 AND body->>'parentAssignmentId' IS NULL
      UNION ALL SELECT h.assignment_id,h.body,t.depth+1 FROM finnor_os.w2_assignment_heads h JOIN tree t
        ON h.body->>'parentAssignmentId'=t.assignment_id WHERE h.tenant_id=$1 AND h.program_id=$2)
    SELECT count(*)::int assignments,max(depth)::int depth,
      count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM finnor_os.w2_assignment_heads h WHERE h.tenant_id=$1
        AND h.program_id=$2 AND h.body->>'parentAssignmentId'=tree.assignment_id))::int leaves FROM tree`, [tenant, full])).rows[0];
  assert.deepEqual(persisted, { assignments: 512, depth: 8, leaves: 505 });
  for (let i = 0; i < 512; i++) assert.equal(whole.body.program.assignments.find((a: any) => a.taskId === "task-" + i)?.actorId, actorIds[target(i)], "EVERY_NATIVE_TASK_BOUND:" + i);
  await save("whole-128-512-depth8-and-every-native-leaf.json", { readback: whole.body, persisted, literalExpectedLeaves: 505,
    observedRegisteredSources: sourceIds.length, allTaskIndicesChecked: 512, originalBudget: "25", originalEpisodeReset: false });
  pass("whole-128-512-depth8-every-leaf", { actors: 128, assignments: 512, depth: 8, leaves: 505, installedRuntime: Boolean(installation) });
  const pairings = [[0, "HUMAN_TO_AGENT"], [1, "AGENT_TO_HUMAN"], [8, "AGENT_TO_AGENT"], [9, "HUMAN_TO_HUMAN"]].map(([index, pairing]) => {
    const assignment = whole.body.program.assignments.find((a: any) => a.taskId === "task-" + index);
    const task = fullInput.outcome.tasks[Number(index)]!;
    assert.equal(assignment.delegatorActorId, task.delegatorActorId);
    return { pairing, taskId: assignment.taskId, delegatorActorId: assignment.delegatorActorId, actorId: assignment.actorId,
      recordsOnly: true, genuineHumanQualified: false };
  });
  await save("four-controlled-actor-pairings.json", pairings); pass("four-controlled-actor-pairings", { count: pairings.length, genuineHumanQualified: false });
  const excessActors = await api("workforce/execution-programs/intake", { workId: randomUUID(), idempotencyKey: "129-refused",
    original: { ...fullInput, actorSourceIds: [...sourceIds, randomUUID()] } });
  assert.equal(excessActors.status, 400); assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.w2_programs")).rows[0].n, 1);
  await save("129-actors-no-intake-or-truncation.json", excessActors); pass("129-actors-refuse-before-intake", { status: 400, originalProgrammes: 1 });
  for (const [work, count, depth, name] of [[1, 513, 1, "513-assignments"], [2, 9, 9, "depth-nine"]] as const) {
    const id = await submit(work, original(count, depth));
    const refused = await waitFor(name, async () => (await admin!.query("SELECT status,program,compile_result FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, id])).rows[0],
      value => value.status === "BLOCKED");
    assert.equal(refused.program, null); assert.equal(refused.compile_result.status, "LIMIT_EXCEEDED");
    assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.w2_assignment_heads WHERE tenant_id=$1 AND program_id=$2", [tenant, id])).rows[0].n, 0);
    await save(name + "-explicit-native-refusal.json", refused); pass(name + "-explicit-native-refusal", { status: refused.compile_result.status, assignments: 0 });
  }
  const providerProgram = await submit(3, original(1, 1, true));
  await waitFor("external-offer", async () => (await admin!.query("SELECT revision FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, providerProgram])).rows[0],
    value => value.revision === 1);
  const scoped = await api("workforce/execution-programs/" + providerProgram, undefined, provider);
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body)); assert.equal(scoped.body.view, "RECIPIENT_SCOPED");
  assert.equal(scoped.body.program, undefined); assert.equal(scoped.body.assignments.length, 1);
  const foreign = await api("workforce/execution-programs/" + providerProgram, undefined, human); assert.equal(foreign.status, 404);
  const act = async (id: string, task: string, actor: string, action: string, key: string, extra: Record<string, unknown> = {}) => {
    const current = await api("workforce/execution-programs/" + id); assert.equal(current.status, 200);
    const assignment = current.body.program.assignments.find((a: any) => a.taskId === task && a.state.kind !== "CLOSED");
    assert(assignment, "ACTUAL_CURRENT_ASSIGNMENT_REQUIRED");
    return api("workforce/execution-programs/" + id + "/actions", { action, idempotencyKey: key,
      expectedRevision: current.body.revision, assignmentId: assignment.id, termsDigest: assignment.termsDigest,
      termsRevision: assignment.terms.revision, ...extra }, actor);
  };
  const ownerConsent = await act(providerProgram, "task-0", principal, "ACCEPT", "owner-cannot-consent"); assert.equal(ownerConsent.status, 403);
  for (const action of ["ACCEPT", "START", "DELIVER", "RELEASE_LABOR"]) {
    const response = await act(providerProgram, "task-0", provider, action, "actual-provider-" + action, action === "DELIVER" ? { value: "42" } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const verified = await act(providerProgram, "task-0", checker, "VERIFY", "independent-provider-verification"); assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const providerDone = await waitFor("provider-original-work-closed", () => api("workforce/execution-programs/" + providerProgram), value => value.body.status === "CLOSED");
  const workDone = await api("works/" + works[3]); assert.equal(workDone.body.work.work.status, "completed");
  await save("actual-nonowner-external-recipient-and-independent-verification.json", { scoped, otherParticipantStatus: foreign.status,
    ownerConsentStatus: ownerConsent.status, verified, final: providerDone.body, originalWork: workDone.body, genuineHumanQualified: false });
  pass("actual-nonowner-external-acceptance-delivery-independent-verification", { canonicalRole: "participant", voluntaryRecipient: true,
    ownerConsentStatus: 403, foreignParticipantStatus: 404, originalWorkCompleted: true, genuineHumanQualified: false });
  const changedSnapshot = structuredClone(snapshots[125]); changedSnapshot.actor.capabilities = [];
  await withTenantTransaction(tenant, { userId: principal }, async (_db, c) =>
    appendEvidenceVersionTx(transactionDb(c), tenant, sourceIds[125]!, { content: JSON.stringify(changedSnapshot), snapshot: changedSnapshot }));
  const changed = await api("workforce/execution-programs/" + full); assert.equal(changed.status, 200);
  assert.equal(changed.body.status, "FENCED");
  const expectedAffected = whole.body.program.assignments.filter((a: any) => a.actorId === people[125]).map((a: any) => a.id).sort();
  assert(expectedAffected.length > 0 && expectedAffected.length < 12);
  assert.deepEqual([...changed.body.currentness.affectedAssignmentIds].sort(), expectedAffected);
  assert.equal(changed.body.currentness.keptAssignmentIds.length, 512 - expectedAffected.length);
  assert(changed.body.currentCheck.issues.some((i: any) => i.code === "CANONICAL_DEPENDENCY_CHANGED"));
  await save("actual-changed-source-smallest-p7-closure.json", { changed: changed.body, expectedAffected, originalPinsRewritten: false,
    unrelatedAssignmentsRetained: 512 - expectedAffected.length, possibleEffectsReleased: false });
  pass("changed-source-smallest-p7-closure", { affected: expectedAffected.length, kept: 512 - expectedAffected.length, all512Checked: true });
  sampling = setInterval(sampleSessions, 250); sampleSessions();
  for (const action of ["ACCEPT", "START", "DELIVER", "RELEASE_LABOR"]) {
    const response = await act(full, "task-9", human, action, "unaffected-human-" + action, action === "DELIVER" ? { value: "42" } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const unaffectedVerification = await act(full, "task-9", checker, "VERIFY", "independent-unaffected-verification");
  assert.equal(unaffectedVerification.status, 200, JSON.stringify(unaffectedVerification.body));
  const continued = await waitFor("unaffected-original-branch-closed", () => api("workforce/execution-programs/" + full),
    value => { assert.equal(value.status, 200, JSON.stringify(value.body));
      return value.body.program.assignments.find((a: any) => a.taskId === "task-9").state.kind === "CLOSED"; });
  assert.equal(continued.body.status, "FENCED"); assert.equal(continued.body.program.assignments.length, 512);
  assert.deepEqual([...continued.body.currentness.affectedAssignmentIds].sort(), expectedAffected);
  await save("unaffected-authenticated-progress-keeps-original-fenced-neighbor.json", continued.body);
  pass("unaffected-authenticated-branch-progress-with-fenced-neighbor", { originalRootRetained: true, assignments: 512,
    unaffectedBranchClosed: true, changedBranchStillFenced: true, genuineHumanQualified: false });
  assert(traffic.length < 20000, "COMPLETE_NATIVE_BOUND_HTTP_OBSERVATIONS_REQUIRED");
  assert.deepEqual(traffic.filter(value => (value as { status?: number }).status! >= 500), [], "NO_NATIVE_BOUND_HTTP_SERVER_FAILURES");
  const finalJobs = (await admin.query(`SELECT id,status,claim_fence,last_error FROM finnor_os.jobs
    WHERE tenant_id=$1 AND type='run_workforce_execution_v1' ORDER BY id LIMIT 257`, [tenant])).rows;
  await save("final-native-job-frontier.json", finalJobs);
  assert(finalJobs.length <= 256, "COMPLETE_NATIVE_BOUND_JOB_FRONTIER_REQUIRED");
  assert.deepEqual(finalJobs.filter(job => ["quarantined", "dead", "failed"].includes(job.status)), [],
    "NO_NATIVE_BOUND_QUARANTINED_OR_FAILED_JOBS");
  for (const source of sources) assert.equal(sha(await readFile(join(root, source.path))), source.sha256, "SOURCE_CHANGED:" + source.path);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  if (admin) await save("failure-native-jobs-and-programmes.json", {
    jobs: (await admin.query("SELECT id,type,status,attempts,last_error,claim_fence FROM finnor_os.jobs ORDER BY run_at,id LIMIT 256")).rows,
    programmes: (await admin.query("SELECT id,work_id,status,revision,compile_result FROM finnor_os.w2_programs ORDER BY id LIMIT 8")).rows,
    sessions: (await admin.query(`SELECT pid,usename,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,
      clock_timestamp()-query_start query_age,left(query,2000) statement FROM pg_stat_activity
      WHERE datname=current_database() ORDER BY pid LIMIT 128`)).rows.map(row => ({ ...row,
      statement: row.statement?.replace(/'(?:[^']|'')*'/g, "'<literal>'") })),
  }).catch(() => {});
  console.error(failure);
} finally {
  clearTimeout(wall);
  if (sampling) clearInterval(sampling);
  await pendingSample;
  await save("postgres-error-statements.json", sqlDiagnostics);
  await save("postgres-branch-sessions.json", sessionDiagnostics);
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const child = worker, done = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await done; clearTimeout(timer);
  }
  await save("actual-physical-worker.log.json", { log: workerLog });
  await service?.close().catch(() => {}); await closePool().catch(() => {}); await admin?.end().catch(() => {});
  let allocatedBefore = 0;
  if (directory) allocatedBefore = Number(execFileSync("du", ["-sk", directory], { encoding: "utf8" }).split(/\s/)[0]) * 1024;
  await database?.stop().catch(() => {});
  if (directory && !(await readdir(directory)).length) await rmdir(directory);
  const free = statfsSync(root, { bigint: true });
  const ledger = process.env.FINNOR_W2_COORDINATION_LEDGER ?? join(evidence, "cleanup-ledger.log");
  assert(ledger.startsWith("/"), "ABSOLUTE_OWNED_COORDINATION_LEDGER_REQUIRED");
  await appendFile(ledger, `${new Date().toISOString()} W2 native-bound-owned-PG-cleanup allocatedBytesBeforeStop=${allocatedBefore} freeGiB=${free.bavail * free.bsize / 1073741824n}\n`);
  await save("traffic-without-credentials.json", traffic);
  await save("report.json", { schema: "finnor.postz.w2.native-bound-e2e-report.v1", status: failure ? "FAIL" : "PASS",
    failure, results, contract, sourceHashes: sources, installedRuntime: Boolean(installation), genuineHumanQualified: false,
    protectedQualification: false, monetaryCost: "UNKNOWN", humanTime: "UNKNOWN", fieldActivation: false });
  console.log(JSON.stringify({ evidence, status: failure ? "FAIL" : "PASS", passed: results.length }));
}
process.exit(failure ? 1 : 0);
