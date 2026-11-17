/** Failure-first finite owning-path exercise. All principals are controlled
 * SERVICE records, not genuine human participants or protected qualification. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "../../packages/db/migrate";
import { closePool, configureTenantVertical, transactionDb, withTenantTransaction } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import { canExerciseAuthorityTx, canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import { parseAllocationResource } from "../../packages/epistemic-runtime/src/allocation-contracts";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { nativeWorkforceOriginalSchema, nativeWorkforceRefinementSchema } from "../../packages/orchestration/src/workforce-execution/contracts";
import { workforceActorSchema } from "../../packages/workforce/src/execution-program/schema";
import { authenticatedApiFixture } from "../frontier5/x1/authenticated-api-fixture.mts";
import { mountedResponseGate, holdMountedWorkforce, prepareMountedFrontend } from "./mounted-fixture.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url)), backend = join(root, "finnor-os");
const evidenceRoot = process.env.FINNOR_W2_EVIDENCE_ROOT ?? join(root, "scope-postz/w2-accountable-workforce/evidence");
if (!evidenceRoot.startsWith("/")) throw Error("ABSOLUTE_EVIDENCE_ROOT_REQUIRED");
const evidence = join(evidenceRoot, "native-run-" + Date.now());
const installation = process.env.FINNOR_W2_INSTALLATION;
const mounted = process.env.FINNOR_W2_MOUNTED === "1";
const participantOnly = process.env.FINNOR_W2_PARTICIPANT_EXPIRY_ONLY === "1";
assert(!participantOnly || mounted, "FOCUSED_PARTICIPANT_PROOF_REQUIRES_ACTUAL_BROWSER");
const frontendInstallation = process.env.FINNOR_W2_FRONTEND_INSTALLATION;
const frontendOrigin = process.env.FINNOR_W2_FRONTEND_ORIGIN ?? "http://127.0.0.1:49187";
const mountedGate = mountedResponseGate();
if (installation && !installation.startsWith("/")) throw Error("ABSOLUTE_INSTALLATION_REQUIRED");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) => writeFile(join(evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30000 }).trim();
const limits = JSON.parse(await readFile(join(root, "scope-postz/w2-accountable-workforce/verification-plan.json"), "utf8")).limits;
const disk = statfsSync(root, { bigint: true });
assert(disk.bavail * disk.bsize >= BigInt(limits.minimumFreeBytes), "FINITE_DISK_PREFLIGHT");
const sourcePaths = ["finnor-os/packages/orchestration/src/workforce-execution/contracts.ts",
  "finnor-os/packages/governed-execution/src/workforce-local-attempt.ts",
  "finnor-os/packages/governed-execution/src/executor.ts",
  "finnor-os/packages/governed-execution/src/adapter-contract.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/native-authority.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/protected-child.ts",
  "finnor-os/packages/db/migrations/postz_w2_protected_child.sql",
  "finnor-os/packages/private-equity/src/workforce-compensation.ts",
  "finnor-os/packages/authority/src/index.ts", "finnor-os/apps/api/app/api/me/route.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/store.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/runtime.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/worker.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/index.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/participants.ts",
  "finnor-os/packages/orchestration/src/workforce-execution/dependencies.ts",
  "finnor-os/apps/api/app/api/workforce/participants/route.ts",
  "finnor-os/apps/api/app/api/workforce/participants/[id]/route.ts",
  "finnor-os/apps/api/app/api/workforce/execution-programs/http.ts",
  "finnor-os/packages/capability-evolution/src/workforce-experience.ts",
  "finnor-os/packages/private-equity/src/workforce-allocation.ts",
  "finnor-os/packages/db/migrations/postz_w2_accountable_workforce.sql",
  "finnor-os/packages/db/migrations/postz_w2_dynamic_workforce.sql", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/packages/db/migrations/postz_w2_execution_completion.sql",
  "finnor-os/scripts/bundle-migrations.ts", "scope-postz/w2-accountable-workforce/verification-plan.json",
  "finnor-os/scripts/postz-w2/run-native-e2e.mts", "finnor-os/scripts/postz-w2/physical-worker.mts",
  "finnor-os/scripts/postz-w2/mounted-fixture.mts", "scripts/postz-w2/browser.mjs", "scripts/postz-w2/headed-browser.mjs",
  "scripts/postz-w2/run-headed-native.mjs", "src/app/centropy/workforce/page.tsx",
  "src/components/centropy/canvas/WorkforceExecutionPanel.tsx",
  "src/components/centropy/canvas/WorkforceParticipantWorkspace.tsx",
  "src/components/centropy/shell/CentropyHost.tsx", "src/components/centropy/shell/CentropyWorkspace.tsx",
  "src/lib/centropy/capability-manifest.generated.json",
  "src/components/centropy/lib/centropy-auth.tsx", "src/components/centropy/lib/use-private-request-scope.ts",
  ...["schema", "exact", "graph", "compiler", "checker", "lifecycle", "index"].map(name =>
    "finnor-os/packages/workforce/src/execution-program/" + name + ".ts")];
const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })));
await save("freeze.json", { schema: "finnor.postz.w2.native-run.v1", startedAt: new Date().toISOString(),
  source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: git("status", "--porcelain=v1", "-uall"), sources },
  limits, installation: installation ? { manifestSha256: sha(await readFile(join(installation, "finnor-os/w2-development-installation.json"))) } : null,
  profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RESTRICTED_RLS", genuineHumanQualified: false,
  protectedQualification: false, fieldActivation: false, comparator: "NOT_RUN" });
const results: Array<{ id: string; status: string; observed: unknown }> = [], traffic: unknown[] = [], workerEvents: any[] = [];
// Exact trace slot of the owned tamper probe's expected custody refusal; the
// final no-5xx oracle exempts only that recorded entry, never a class of them.
let tamperProbeTrace: { index: number; path: string; status: number } | null = null;
const pass = (id: string, observed: unknown) => { results.push({ id, status: "PASS", observed }); console.log(JSON.stringify({ id, status: "PASS" })); };
const waitFor = async <T,>(name: string, observe: () => Promise<T>, ready: (value: T) => boolean, milliseconds = 45000) => {
  const deadline = Date.now() + milliseconds; let last: T;
  do { last = await observe(); if (ready(last)) return last; await new Promise(resolve => setTimeout(resolve, 150)); } while (Date.now() < deadline);
  await save("timeout-" + name + ".json", last!); throw Error("FINITE_OBSERVATION_TIMEOUT:" + name);
};
const freePort = () => new Promise<number>((yes, no) => { const socket = createServer(); socket.once("error", no);
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); if (!address || typeof address === "string") return no(Error("PORT"));
    socket.close(() => yes(address.port)); }); });
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined;
let service: Awaited<ReturnType<typeof authenticatedApiFixture>> | undefined, worker: ChildProcess | undefined;
let mountedFrontend: Awaited<ReturnType<typeof prepareMountedFrontend>> | undefined;
let killProgram: string | null = null, workerNumber = 0, failure: string | null = null, mountedResult: unknown = null, nodeBinaryPrewarmed = false;
const wall = setTimeout(() => { worker?.kill("SIGKILL"); console.error("W2_NATIVE_WALL_BOUND"); process.exit(1); }, limits.wallSeconds * 1000);
try {
  process.env.NODE_ENV = "test"; process.env.AUTH_DEV_BYPASS = "0";
  process.env.FINNOR_P4_PROFILE = "ordinary_disposable"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.RATE_LIMIT_PER_MINUTE = "10000"; process.env.RATE_LIMIT_IP_PER_MINUTE = "10000";
  const directory = await mkdtemp(join(tmpdir(), "finnor-w2-owned-")), port = await freePort();
  const password = randomBytes(32).toString("hex"), appPassword = randomBytes(32).toString("hex"), workerPassword = randomBytes(32).toString("hex");
  database = new EmbeddedPostgres({ databaseDir: join(directory, "database"), user: "w2_fixture", password, port,
    persistent: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="],
    onLog: () => {} });
  await database.initialise(); await database.start(); await database.createDatabase("w2_native");
  const connection = (user: string, pass: string) => `postgres://${user}:${pass}@127.0.0.1:${port}/w2_native`;
  let nativeMigrate = migrate;
  let manifest: any = null;
  if (installation) {
    manifest = JSON.parse(await readFile(join(installation, "finnor-os/w2-development-installation.json"), "utf8"));
    assert.equal(manifest.schema, "finnor.postz.w2.development-installation.v1");
    const installed = await import(pathToFileURL(join(installation, manifest.entrypoints.migrations)).href);
    nativeMigrate = installed.migrate;
  }
  const migrations = await nativeMigrate(connection("w2_fixture", password));
  assert(migrations.includes("postz_w2_accountable_workforce.sql"));
  assert(migrations.includes("postz_w2_dynamic_workforce.sql"));
  assert(migrations.includes("postz_w2_execution_completion.sql"));
  admin = new pg.Client({ connectionString: connection("w2_fixture", password) }); await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD " + admin.escapeLiteral(appPassword));
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD " + admin.escapeLiteral(workerPassword));
  const roles = (await admin.query(`SELECT rolname,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles
    WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname`)).rows;
  for (const role of roles) { assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false); assert.equal(role.app_inherits_worker, false); }
  await save("migrations-and-restricted-roles.json", { migrations, roles }); pass("native-migrations-and-restricted-roles", { migrations: migrations.length, roles });
  const tenant = randomUUID(), otherTenant = randomUUID(), principal = randomUUID(), recipient = randomUUID(), unrelated = randomUUID(), outsider = randomUUID();
  const workIds = Array.from({ length: 9 }, () => randomUUID());
  await admin.query("SET app.test_vertical_mode='explicit'");
  for (const id of [tenant, otherTenant])
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'W2 controlled disposable institution')", [id, randomUUID()]);
  for (const [id, tenantId] of [[principal, tenant], [recipient, tenant], [unrelated, tenant], [outsider, otherTenant]]) {
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
      VALUES($1,$2,$3,$4,'active','Controlled service identity, not a human')`,
      [id, tenantId, id + "@test.invalid", id === recipient ? "participant" : "owner"]);
    await admin.query("INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind) VALUES($1,$2,'SERVICE')", [tenantId, id]);
  }
  // Explicit disposable standing authority, NOT an enrollment side effect or
  // an owner promotion. The generic retired-role evaluator must still refuse.
  const participantRole = randomUUID();
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
    VALUES($1,$2,'w2-controlled-existing-participant','Controlled existing workforce grants')`, [participantRole, tenant]);
  await admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)
    VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`, [tenant, recipient, participantRole]);
  for (const capability of ["query:work", "action:workforce_assign_contract", "action:workforce_respond_contract"])
    await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
      VALUES($1,$2,$3,'*','allow','low')`, [tenant, participantRole, capability]);
  process.env.DATABASE_URL = connection("finnor_app", appPassword); await closePool();
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: principal, sourceSystem: "W2:controlled-e2e" });
  await configureTenantVertical({ tenantId: otherTenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: outsider, sourceSystem: "W2:controlled-e2e" });
  const auth = { tenantId: tenant, userId: principal, employeeId: principal, role: "owner" as const };
  const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString(), expires = iso(3600000);
  const ref = (owner: string, id: string) => ({ owner, id, version: "controlled-source-v1", contentDigest: sha(id) });
  const sourceIds: string[] = [], actorSources = new Map<string, { id: string; snapshot: any }>();
  for (const [id, kind, skill] of [[principal, "COMPUTATIONAL_CELL", "root-analysis"],
    [recipient, "DETERMINISTIC_SERVICE", "compute"], [unrelated, "DETERMINISTIC_SERVICE", "backup-compute"]]) {
    const actor = workforceActorSchema.parse({ id, tenantId: tenant, identityRef: ref("identity", id!), kind, status: "CURRENT",
      capabilities: [{ skill, scope: "analysis", evidenceRef: ref("S1", "qualification:" + id), certainty: "OBSERVED", validUntil: expires }],
      availability: { kind: "OBSERVED", ref: ref("S1", "schedule:" + id), validUntil: expires,
        slots: [{ startAt: iso(-60000), endAt: expires, capacity: "1", committed: "0" }], maxConcurrent: 1, humanLimits: { kind: "NOT_HUMAN" } } });
    const snapshot = { schema: "finnor.workforce-actor-evidence.v1", canonical: { kind: "USER", id, principalId: id }, actor,
      qualification: "AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION" };
    const source = await withTenantTransaction(tenant, { userId: principal }, async (_db, client) => {
      const db = transactionDb(client), source = await createEvidenceSourceTx(db, tenant, {
        sourceKey: "w2-controlled-directory:" + id, sourceType: "workforce_actor_evidence", title: "Controlled service capability and availability" });
      await appendEvidenceVersionTx(db, tenant, source.id, { content: JSON.stringify(snapshot), snapshot }); return source;
    });
    sourceIds.push(source.id);
    actorSources.set(id!, { id: source.id, snapshot });
  }
  const rights = String((await admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision);
  const horizon = { startAt: iso(-60000), periodMs: 3600000, periods: 1 };
  const resource = await putAllocationResource({ auth }, parseAllocationResource({
    schema: "finnor.allocation-resource.v1", resourceId: "w2-operations", resourceClass: "COMPUTE", tenantId: tenant,
    ownerRef: ref("BUSINESS_OWNER", principal), legalEntityRef: ref("S1", tenant), scopeRef: ref("BUSINESS_OWNER", principal),
    permittedRoots: workIds.map(entityId => ({ entityType: "work", entityId })), rightsRef: `authority:${tenant}:${rights}`,
    unit: "workforce-operation", currency: null, kind: "CUMULATIVE_EXPENDITURE", horizon, sourceRef: ref("BUSINESS_OWNER", "observed-compute-capacity"),
    asOf: iso(0), knowledgeAt: iso(0), validUntil: expires, beliefPins: [],
    availability: [{ amount: "100", basis: "REPORTED_AVAILABLE" }, { amount: "100", basis: "REPORTED_AVAILABLE" }],
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
    qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }), null);
  const envelope = (amount: string) => ({ resourceId: resource.resourceId, unit: resource.unit, kind: resource.kind,
    horizon, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["query:work"], dataScopes: ["work:self"], purposes: ["controlled-analysis"], effects: [],
    validFrom: iso(-60000), validUntil: expires, allowSubdelegation: true };
  const original = (count: number, internal = false) => nativeWorkforceOriginalSchema.parse({
    schema: "finnor.workforce-original-outcome.v1", sourceClass: "CONTROLLED_ACTOR_RECORDS", actorSourceIds: sourceIds,
    resources: { resourceRefs: [resource.ref], schedules: [{ resourceId: resource.resourceId, quantities: ["12", "0"] }] },
    outcome: { deadline: expires, ceiling, resourceLimits: [envelope("12")],
      criteria: Array.from({ length: count }, (_, i) => ({ id: "criterion-" + i,
        checkerActorId: i === 2 ? recipient : principal, evidenceCustodianActorId: i === 2 ? recipient : principal,
        acceptance: { kind: "EXACT_JSON", expected: i === 1 ? ["a", "b"] : "42" } })),
      tasks: Array.from({ length: count }, (_, i) => ({ id: "task-" + i, parentTaskId: null,
        dependsOn: i === 1 ? ["task-0"] : [], returnTo: i === 1 ? ["task-0"] : [], delegatorActorId: principal,
        criterionId: "criterion-" + i, requiredCapabilities: [{ skill: i === 2 ? "root-analysis" : "compute", scope: "analysis" }],
        allowedActorKinds: [i === 2 ? "COMPUTATIONAL_CELL" : "DETERMINISTIC_SERVICE"],
        assignmentMode: internal ? "INTERNAL_AUTHORIZED" : "EXTERNAL_VOLUNTARY", ceiling,
        terms: { revision: 1, deliverable: i === 2 ? "PRIVATE_PARENT_DELIVERABLE" : i === 1 ? "Sort the supplied strings" : "Sum the supplied integers",
          compensation: { value: "0", unit: "USD" }, subdelegation: true, expiresAt: expires },
        dueAt: expires, slot: { startAt: count === 3 && i === 1 ? firstWindowBoundary : iso(-60000),
          endAt: count === 3 && i === 0 ? firstWindowBoundary : expires },
        effortSeconds: "1", demand: [envelope("1")], context: { dataScopes: ["work:self"], purposes: ["controlled-analysis"], includesCredentials: false }, effectId: null })) },
    operations: Array.from({ length: count }, (_, i) => ({ taskId: "task-" + i,
      computation: i === 1 ? { kind: "SORT_STRINGS", values: ["b", "a"] } : { kind: "SUM_INTEGERS", values: ["20", "22"] } })),
  });
  service = await authenticatedApiFixture(root, principal, entry => { if (traffic.length < 20000) traffic.push(entry); },
    { additionalActors: [recipient, unrelated, outsider], maximumActors: 4,
      ...(mounted ? { frontendOrigin, afterResponse: mountedGate.afterResponse } : {}),
      ...(installation ? { installation, installationProfile: "POSTZ_W2" as const } : {}) });
  if (mounted) mountedFrontend = await prepareMountedFrontend({ repo: root, evidence, privateDirectory: directory,
    frontendOrigin, frontendInstallation, service, startupWallMs: limits.finalBuildWallSeconds * 1000 });
  const tokens = new Map<string, string>([[principal, service.token]]);
  for (const identity of service.additionalIdentities) {
    const response: Response = await fetch(service.authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: identity.email, password: identity.password }) });
    assert.equal(response.status, 200); tokens.set(identity.actor, (await response.json()).access_token);
  }
  const api = async (path: string, body?: unknown, actor: string = principal) => {
    const response = await fetch(service!.origin + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + tokens.get(actor), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: { cacheControl: response.headers.get("cache-control"), vary: response.headers.get("vary") },
      body: await response.json() as any };
  };
  {
    await save("participant-retired-role-original.json", { recipient,
      existingRetiredRoles: ["dispatcher", "technician"], expectedStatus: 403,
      currentRole: "participant", grantsAdded: false });
    const denied = [];
    try {
      for (const retired of ["dispatcher", "technician"]) {
        await admin.query("UPDATE finnor_os.users SET role=$2 WHERE id=$1", [recipient, retired]);
        const response = await api("me", undefined, recipient);
        assert.equal(response.status, 403);
        denied.push({ role: retired, status: response.status });
      }
    } finally {
      await admin.query("UPDATE finnor_os.users SET role='participant' WHERE id=$1", [recipient]);
    }
    await save("participant-retired-role-result.json", { status: "PASS", denied, restoredRole: "participant" });
    const me = await api("me", undefined, recipient);
    assert.equal(me.status, 200, JSON.stringify(me.body)); assert.equal(me.body.role, "participant");
    const ownerOnlyCalls = [
      { path: "capabilities/runs", body: undefined }, { path: "capabilities/runs", body: {} },
      { path: "capabilities/runs/" + randomUUID(), body: undefined },
      { path: "capabilities/nango/connect", body: {} }, { path: "capabilities/nango/sources", body: undefined },
      { path: "capabilities/planner/activation", body: undefined }, { path: "capabilities/planner/activation", body: {} },
    ];
    const capabilityCounts = async () => ({
      runs: (await admin!.query("SELECT count(*)::int n FROM finnor_os.capability_runs WHERE tenant_id=$1", [tenant])).rows[0].n,
      bindings: (await admin!.query("SELECT count(*)::int n FROM finnor_os.capability_nango_bindings WHERE tenant_id=$1", [tenant])).rows[0].n,
    });
    const capabilitiesBefore = await capabilityCounts(), capabilityDenials = [];
    for (const input of ownerOnlyCalls) {
      const response = await api(input.path, input.body, recipient);
      assert.equal(response.status, 403, JSON.stringify(response.body));
      capabilityDenials.push({ path: input.path, method: input.body === undefined ? "GET" : "POST", status: response.status });
    }
    const capabilitiesAfter = await capabilityCounts(); assert.deepEqual(capabilitiesAfter, capabilitiesBefore);
    await save("participant-capability-owner-boundary.json", { participant: recipient, capabilityDenials,
      before: capabilitiesBefore, after: capabilitiesAfter, authorityExpanded: false });
    const authority = await withTenantTransaction(tenant, { userId: recipient }, async (_db, c) => {
      const ctx = { ...auth, userId: recipient, employeeId: recipient };
      const request = { operation: "query" as const, capability: "query:work", resource: { type: "work", id: workIds[0]! }, risk: "low" as const };
      await assert.rejects(() => canExerciseAuthorityTx(ctx, request, c), { message: "CURRENT_CANONICAL_AUTHORITY_UNAVAILABLE" });
      return { generic: "CURRENT_CANONICAL_AUTHORITY_UNAVAILABLE",
        workforce: await canExerciseWorkforceAuthorityTx(ctx, request, c),
        unrelatedProtected: await canExerciseWorkforceAuthorityTx(ctx,
          { ...request, operation: "action", capability: "action:allocate_resource" }, c) };
    });
    assert.deepEqual(authority, { generic: "CURRENT_CANONICAL_AUTHORITY_UNAVAILABLE", workforce: true, unrelatedProtected: false });
    await save("actual-nonowner-same-canonical-grants-without-owner-promotion.json",
      { me, authority, canonicalRole: "participant", ordinaryIdentity: true, enrollmentMintedGrant: false,
        genericRetiredRoleStillRefused: true, realHumanQualified: false });
    pass("actual-nonowner-identity-and-workforce-only-canonical-standing-authority", authority);
  }
  {
    const contact = randomUUID();
    await admin.query(`INSERT INTO finnor_os.external_contacts(tenant_id,id,contact_key,name)
      VALUES($1,$2,$3,'Explicitly controlled contact record, not a genuine participant')`,
    [tenant, contact, "w2-controlled-" + contact]);
    const proposal = await api("workforce/participants", { contactId: contact, recipientPrincipalId: recipient,
      purpose: "controlled-analysis", validUntil: expires, idempotencyKey: "controlled-existing-principal-enrollment" });
    assert.equal(proposal.status, 202, JSON.stringify(proposal.body));
    const action = { action: "CONFIRM", expectedRevision: 0, proposalDigest: proposal.body.proposalDigest,
      idempotencyKey: "actual-existing-recipient-confirms" };
    const ownerCannotConsent = await api("workforce/participants/" + proposal.body.id, action);
    assert.equal(ownerCannotConsent.status, 403);
    const unrelatedCannotConsent = await api("workforce/participants/" + proposal.body.id, action, unrelated);
    assert.equal(unrelatedCannotConsent.status, 404);
    const changedProposal = await api("workforce/participants/" + proposal.body.id,
      { ...action, proposalDigest: "0".repeat(64) }, recipient);
    assert.equal(changedProposal.status, 409);
    const confirmed = await api("workforce/participants/" + proposal.body.id, action, recipient);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body)); assert.equal(confirmed.body.status, "CONFIRMED");
    const replay = await api("workforce/participants/" + proposal.body.id, action, recipient);
    assert.equal(replay.status, 200); assert.equal(replay.body.semanticReplay, true);
    const foreign = await api("workforce/participants", undefined, outsider);
    assert.equal(foreign.status, 200); assert.equal(foreign.body.data.length, 0);
    const revoked = await api("workforce/participants/" + proposal.body.id,
      { ...action, action: "REVOKE", expectedRevision: confirmed.body.revision, idempotencyKey: "recipient-revokes-binding" }, recipient);
    assert.equal(revoked.status, 200); assert.equal(revoked.body.status, "REVOKED");
    await save("external-existing-contact-binding-and-actual-principal-consent.json", { proposal, ownerCannotConsent,
      unrelatedCannotConsent, changedProposal, confirmed, replay, foreign, revoked,
      sourceClass: "CONTROLLED_ACTOR_RECORDS", contactSent: false, credentialsCreated: false, grantsCreated: false,
      genuineHumanQualified: false, assignmentAcceptanceImplied: false });
    pass("existing-external-contact-exact-authenticated-enrollment-and-revocation",
      { wrongOwner: 403, wrongPrincipal: 404, wrongProposal: 409, actualRecipient: 200, replay: true, foreignRows: 0, revoked: true });
  }
  if (installation) {
    const target = join(installation, "finnor-os/packages/workforce/src/execution-program/checker.ts");
    const originalBytes = await readFile(target);
    let refused: Awaited<ReturnType<typeof api>>;
    try {
      await chmod(target, 0o644); await writeFile(target, Buffer.concat([originalBytes, Buffer.from("\n// owned byte-mismatch probe\n")]));
      await chmod(target, 0o444);
      const mark = traffic.length;
      refused = await api("workforce/execution-programs?workId=" + workIds[0]);
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      // The compiled API also emits private refusal diagnostics into the trace;
      // exempt exactly one recorded HTTP 503 entry, identified by path.
      const added = traffic.slice(mark).map((value, offset) => ({ value: value as { status?: number; path?: string },
        index: mark + offset })).filter(entry => entry.value.status === 503);
      assert.equal(added.length, 1, "EXACTLY_ONE_RECORDED_TAMPER_REFUSAL");
      assert.equal(added[0]!.value.path, "/api/workforce/execution-programs", "OWNED_TAMPER_PROBE_MUST_BE_THE_RECORDED_503");
      tamperProbeTrace = { index: added[0]!.index, path: added[0]!.value.path, status: 503 };
    } finally { await chmod(target, 0o644); await writeFile(target, originalBytes); await chmod(target, 0o444); }
    const restored = await api("workforce/execution-programs?workId=" + workIds[0]);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    await save("installed-source-custody-byte-change-and-restoration.json", { target: "finnor-os/packages/workforce/src/execution-program/checker.ts",
      originalSha256: sha(originalBytes), refusalStatus: refused!.status, restoredStatus: restored.status,
      sourceRestoredExactly: sha(await readFile(target)) === sha(originalBytes), originalManifestUnchanged: true });
    pass("installed-owner-byte-mismatch-refusal-and-exact-restoration", { refusal: 503, restored: 200 });
  }
  const startWorker = async () => {
    assert(!worker || worker.exitCode !== null || worker.signalCode !== null, "ONE_PHYSICAL_WORKER_AT_A_TIME");
    const number = ++workerNumber, log: string[] = [];
    const workerEntry = installation ? join(installation, manifest.entrypoints.worker) : join(backend, "scripts/postz-w2/physical-worker.mts");
    // Prewarm the OS file cache for the exact spawned entry and the node binary
    // once per run; the unchanged 30-second ready bound still applies. This
    // only removes host pager stalls from the timing, never an assertion.
    await readFile(workerEntry);
    if (!nodeBinaryPrewarmed) { nodeBinaryPrewarmed = true; await readFile(process.execPath).catch(() => Buffer.alloc(0)); }
    const args = installation ? ["--max-old-space-size=1536", join(installation, manifest.entrypoints.worker)] :
      ["--max-old-space-size=1536", "--import", join(backend, "node_modules/tsx/dist/loader.mjs"), join(backend, "scripts/postz-w2/physical-worker.mts")];
    worker = spawn(process.execPath, args, { cwd: installation ? join(installation, "finnor-os") : backend,
      env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: connection("finnor_worker", workerPassword), WORKER_JOB_LEASE_SECONDS: "3",
        FINNOR_WORKLOAD_CLASS: "", LOG_LEVEL: "info" }, stdio: ["ignore", "pipe", "pipe"] });
    const child = worker;
    let lines = "";
    child.stdout!.on("data", chunk => {
      lines += chunk.toString(); if (lines.length > 1048576) { child.kill("SIGKILL"); return; }
      while (lines.includes("\n")) {
        const at = lines.indexOf("\n"), line = lines.slice(0, at); lines = lines.slice(at + 1);
        if (log.join("").length < 1048576) log.push(line + "\n");
        try { const entry = JSON.parse(line); workerEvents.push({ ...entry, processNumber: number });
          if (entry.event === "W2_S6_INTENT_COMMITTED" && entry.programId === killProgram) child.kill("SIGKILL");
        } catch { /* Non-JSON logging is not an execution receipt. */ }
      }
    });
    child.stderr!.on("data", chunk => { if (log.join("").length < 1048576) log.push(chunk.toString()); });
    child.once("exit", () => { void writeFile(join(evidence, "worker-" + number + ".log"), log.join(""), { mode: 0o600 }); });
    try {
      await waitFor("worker-ready-" + number, async () => ({ ready: workerEvents.some(e => e.processNumber === number &&
        ["W2_PHYSICAL_WORKER_READY", "X1_PHYSICAL_WORKER_READY"].includes(e.event)), exit: child.exitCode, signal: child.signalCode, log: log.join("") }),
        value => { if (value.exit !== null || value.signal !== null) throw Error("PHYSICAL_WORKER_EARLY_EXIT:" + value.log); return value.ready; }, 30000);
    } catch (error) {
      // Diagnose a silent live spawn; the unchanged 30-second bound still fails.
      const ps = await new Promise<string>(resolve => execFile("ps", ["-o", "pid,ppid,stat,etime,wchan,command", "-p", String(child.pid)],
        (psError, stdout, stderr) => resolve(psError ? "PS_FAILED:" + String(psError) + ":" + stderr : stdout))).catch(String);
      await save("worker-" + number + "-hang-ps.json", { observedAt: new Date().toISOString(), pid: child.pid,
        exitCode: child.exitCode, signalCode: child.signalCode, logBytes: log.join("").length, ps });
      throw error;
    }
  };
  const stopWorker = async () => {
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
    const child = worker, exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000); child.kill("SIGTERM"); await exited; clearTimeout(timer);
  };
  const firstWindowBoundary = new Date(Date.now() + 120000).toISOString();
  const inputs = workIds.map((workId, i) => ({ workId, idempotencyKey: "native-original-" + i,
    original: original(i === 0 ? 3 : i === 5 ? 2 : 1, [3, 5, 6, 7].includes(i)) }));
  const nested = inputs[5]!.original;
  nested.outcome.tasks[0]!.requiredCapabilities = [{ skill: "root-analysis", scope: "analysis" }];
  nested.outcome.tasks[0]!.allowedActorKinds = ["COMPUTATIONAL_CELL"];
  nested.outcome.criteria[0]!.checkerActorId = recipient; nested.outcome.criteria[0]!.evidenceCustodianActorId = recipient;
  nested.outcome.tasks[0]!.demand = [envelope("2")];
  nested.outcome.tasks[1]!.parentTaskId = "task-0";
  const fractional = inputs[6]!.original;
  fractional.outcome.tasks[0]!.demand = [envelope("4/3")]; fractional.outcome.tasks[0]!.effortSeconds = "1/3";
  inputs[1]!.original.outcome.criteria[0]!.checkerActorId = unrelated;
  inputs[1]!.original.outcome.criteria[0]!.evidenceCustodianActorId = unrelated;
  const mountedOriginal = inputs[7]!.original;
  mountedOriginal.outcome.tasks[0]!.requiredCapabilities = [{ skill: "root-analysis", scope: "analysis" }];
  mountedOriginal.outcome.tasks[0]!.allowedActorKinds = ["COMPUTATIONAL_CELL"];
  mountedOriginal.outcome.tasks[0]!.terms.deliverable = "W2_PRIVATE_MOUNTED_TASK";
  mountedOriginal.outcome.criteria[0]!.checkerActorId = unrelated;
  mountedOriginal.outcome.criteria[0]!.evidenceCustodianActorId = unrelated;
  const dynamicOriginal = inputs[8]!.original;
  dynamicOriginal.resources.schedules = [{ resourceId: resource.resourceId, quantities: ["4", "0"] }];
  dynamicOriginal.outcome.resourceLimits = [envelope("4")];
  dynamicOriginal.outcome.tasks[0]!.demand = [envelope("3")];
  dynamicOriginal.outcome.tasks[0]!.terms.deliverable = "PRIVATE_DYNAMIC_PARENT_COMBINATION";
  dynamicOriginal.outcome.criteria[0]!.checkerActorId = unrelated;
  dynamicOriginal.outcome.criteria[0]!.evidenceCustodianActorId = unrelated;
  dynamicOriginal.outcome.criteria[0]!.acceptance = { kind: "EXACT_JSON", expected: ["42", "43"] };
  dynamicOriginal.operations[0]!.computation = { kind: "PARTICIPANT_INPUT", prompt: "Combine the actually returned requested results." };
  await save("inputs-and-literal-expectations.json", { tenant, principal, recipient, unrelated, outsider, sourceIds,
    resourceRef: resource.ref, inputs, expected: { first: ["42", ["a", "b"], "42"], originalReservations: 1,
      originalDeadline: expires, genuineHumanQualified: false, laterUnknownAttemptReplayCount: 0,
      works: 9, originalResourceCounter: "100", dynamicOriginalBudget: "4", realFutureWindow: firstWindowBoundary } });
  const first = await api("workforce/execution-programs/intake", inputs[0]);
  assert.equal(first.status, 202, JSON.stringify(first.body)); assert.equal(first.body.workId, workIds[0]);
  const competing = await api("workforce/execution-programs/intake", inputs[1]);
  assert.equal(competing.status, 202, JSON.stringify(competing.body));
  await startWorker();
  const readProgram = (id: string) => api("workforce/execution-programs/" + id);
  await waitFor("first-offers", () => readProgram(first.body.id), value => value.body.program?.assignments?.length === 3);
  await waitFor("competing-offers", () => readProgram(competing.body.id), value => value.body.program?.assignments?.length === 1);
  await stopWorker();
  const initial = await readProgram(first.body.id);
  assert.equal(initial.body.currentCheck.valid, true, JSON.stringify(initial.body.currentCheck));
  assert(initial.body.program.assignments.every((a: any) => a.state.kind === "OFFERED"));
  pass("ordinary-authenticated-work-claimed-compiler-and-independent-graph", { id: first.body.id, revision: initial.body.revision, assignments: 3 });
  const recipientRead = await api("workforce/execution-programs/" + first.body.id, undefined, recipient);
  assert.equal(recipientRead.status, 200, JSON.stringify(recipientRead.body)); assert.equal(recipientRead.body.view, "RECIPIENT_SCOPED");
  assert.equal(recipientRead.body.assignments.length, 2); assert.equal(recipientRead.body.program, undefined);
  assert(!JSON.stringify(recipientRead.body).includes("PRIVATE_PARENT_DELIVERABLE"));
  assert(recipientRead.headers.cacheControl?.includes("no-store")); assert(recipientRead.headers.vary?.includes("Authorization"));
  for (const actor of [unrelated, outsider]) assert.equal((await api("workforce/execution-programs/" + first.body.id, undefined, actor)).status, 404);
  pass("private-recipient-other-principal-and-other-tenant", { ownAssignments: 2, parentBodyAbsent: true, noStore: true, otherPrincipals: "OPAQUE_404" });
  if (participantOnly) {
    mountedResult = await holdMountedWorkforce({ repo: root, evidence, privateDirectory: directory,
      frontendOrigin, frontendInstallation, tenant, principal, alternate: unrelated, foreignTenant: otherTenant, foreign: outsider,
      participant: recipient, participantWorkId: workIds[0]!, preparedFrontend: mountedFrontend,
      workId: workIds[7]!, original: mountedOriginal, admin, service, gate: mountedGate, api, startWorker, participantOnly: true });
    pass("focused-mounted-participant-expiry-original-six-not-run", mountedResult);
  } else {
  const firstAssignment = initial.body.program.assignments.find((a: any) => a.taskId === "task-0");
  const request = (a: any, revision: number, key: string, action = "ACCEPT") => ({
    assignmentId: a.id, expectedRevision: revision, idempotencyKey: key, action, termsDigest: a.termsDigest, termsRevision: a.terms.revision });
  assert.equal((await api(`workforce/execution-programs/${first.body.id}/actions`,
    request(firstAssignment, initial.body.revision, "wrong-recipient"), unrelated)).status, 404);
  const changed = await api(`workforce/execution-programs/${first.body.id}/actions`,
    { ...request(firstAssignment, initial.body.revision, "wrong-terms"), termsDigest: "0".repeat(64) }, recipient);
  assert.equal(changed.status, 409); assert.equal(changed.body.error, "WORKFORCE_EXACT_CURRENT_TERMS_REQUIRED");
  const acceptedInput = request(firstAssignment, initial.body.revision, "actual-recipient-accept");
  const accepted = await api(`workforce/execution-programs/${first.body.id}/actions`, acceptedInput, recipient);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const duplicate = await api(`workforce/execution-programs/${first.body.id}/actions`, acceptedInput, recipient);
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body)); assert.equal(duplicate.body.semanticReplay, true);
  const competingRead = await readProgram(competing.body.id);
  const conflict = await api(`workforce/execution-programs/${competing.body.id}/actions`,
    request(competingRead.body.program.assignments[0], competingRead.body.revision, "overbook"), recipient);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, "WORKFORCE_SHARED_ACTOR_CAPACITY_CONFLICT");
  pass("exact-recipient-terms-idempotency-and-shared-work-capacity", { changedTerms: changed.body.error, conflict: conflict.body.error, duplicate: duplicate.body.semanticReplay });
  for (const taskId of ["task-1", "task-2"]) {
    const current = await readProgram(first.body.id), a = current.body.program.assignments.find((value: any) => value.taskId === taskId);
    const response = await api(`workforce/execution-programs/${first.body.id}/actions`, request(a, current.body.revision, "accept-" + taskId), taskId === "task-2" ? principal : recipient);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const beforeWindow = await readProgram(first.body.id);
  const scheduled = beforeWindow.body.program.assignments.find((a: any) => a.taskId === "task-1");
  assert(Date.now() < Date.parse(firstWindowBoundary), "FUTURE_WINDOW_EXERCISE_SETUP_EXCEEDED_BOUND");
  const tooEarly = await api(`workforce/execution-programs/${first.body.id}/actions`,
    request(scheduled, beforeWindow.body.revision, "future-start-refused", "START"), recipient);
  assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));
  await startWorker();
  const completed = await waitFor("verified-first-completion", () => readProgram(first.body.id), value => value.body.status === "CLOSED", 180000);
  assert(completed.body.program.assignments.every((a: any) => a.state.kind === "CLOSED"));
  const firstEvents = (await admin.query("SELECT kind,body,created_at FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 ORDER BY created_at,event_id", [tenant, first.body.id])).rows;
  assert.equal(firstEvents.filter(e => e.kind === "S6_INTENDED").length, 3);
  assert.equal(firstEvents.filter(e => e.kind === "S6_OBSERVATION").length, 3);
  assert.deepEqual(inputs[0]!.original.outcome.tasks.map(task => firstEvents.find(e => e.kind === "S6_OBSERVATION" &&
    e.body.assignmentId === completed.body.program.assignments.find((a: any) => a.taskId === task.id).id)?.body.value), ["42", ["a", "b"], "42"]);
  const scheduledIntent = firstEvents.find(e => e.kind === "S6_INTENDED" && e.body.assignmentId === scheduled.id);
  assert(scheduledIntent && new Date(scheduledIntent.created_at).getTime() >= Date.parse(firstWindowBoundary), "NO_DISPATCH_BEFORE_REAL_SLOT");
  await save("actual-calendar-window-and-scheduled-queue-wakeup.json", { firstWindowBoundary, refusedStart: tooEarly,
    scheduledIntent, completed: completed.body.status, originalDeadline: expires, clockOrAcceptedEpisodeReset: false });
  pass("actual-slot-start-refusal-and-scheduled-physical-wakeup", { earlyStartStatus: 409, firstWindowBoundary,
    actualIntentAt: scheduledIntent.created_at, originalDeadlineUnchanged: true });
  const workRead = await api("works/" + workIds[0]);
  assert.equal(workRead.status, 200); assert.equal(workRead.body.work.work.status, "completed");
  const consumptions = (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2`, [tenant, first.body.id])).rows;
  assert.equal(consumptions.length, 4); assert(consumptions.every(c => c.status === "RECONCILED"));
  const economic = (await admin.query(`SELECT body FROM finnor_os.s7_economic_records
    WHERE tenant_id=$1 AND body->'payload'->>'programmeId'=$2`, [tenant, first.body.id])).rows;
  assert.equal(economic.filter(row => ["COMPILE", "S6"].includes(row.body.payload.phase)).length, 4);
  assert.equal(economic.length, 9);
  await save("positive-original-owner-chain.json", { original: inputs[0], accepted: first, completed: completed.body, events: firstEvents, consumptions,
    economicRecords: economic, work: workRead.body, physicalRegistration: workerEvents.filter(e => e.event.endsWith("PHYSICAL_WORKER_READY")) });
  pass("s5-intent-isolated-s6-independent-criterion-s1-s7-work-completion", { values: ["42", ["a", "b"], "42"], consumptions: 4, originalPhysicalEconomicRecords: 4, additionalMeasuredPhaseRecords: 5, genuineHumanQualified: false });
  const meters = firstEvents.filter(event => event.kind === "NATIVE_PHASE_METER");
  for (const phase of ["MATCHING", "INDEPENDENT_GRAPH_CHECK", "INDEPENDENT_DELIVERY_VERIFICATION"]) {
    const actual = meters.filter(event => event.body.phase === phase);
    assert(actual.length >= 1);
    for (const value of actual) {
      assert.equal(typeof value.body.elapsedMs, "number"); assert(value.body.elapsedMs >= 0);
      assert.equal(typeof value.body.supervisorCpu.user, "number");
      assert.equal(value.body.monetaryCost.kind, "UNKNOWN");
      assert.equal(value.body.humanSupervision.kind, "UNKNOWN"); assert.equal(value.body.admission, "UNADMITTED");
      assert(economic.some(row => row.body.ref.id === value.body.economicRecordRef.id));
    }
  }
  await save("native-matching-checking-and-delivery-verification-meters.json", { meters,
    measuredScope: "ACTUAL_NATIVE_LOCAL_PROCESS_CPU_AND_ELAPSED_TIME", monetaryCost: "UNKNOWN_NOT_ZERO",
    humanTime: "UNKNOWN_NOT_ZERO", admittedMatchingFactors: false, economicImprovementEstablished: false });
  pass("native-actual-matching-checking-and-delivery-verification-metering",
    { nativePhaseMeters: meters.length, independentlyRetainedS7: economic.length, monetaryCost: "UNKNOWN_NOT_ZERO", admission: false });
  const experience = firstEvents.filter(e => e.kind === "S8_OUTCOME_OBSERVATION");
  assert(experience.length >= 3);
  for (const value of experience) {
    assert.equal(value.body.observation.admissionGranted, false);
    assert.equal(value.body.observation.trainingRightsGranted, false);
    assert.equal(value.body.observation.capabilityPromotionGranted, false);
    assert.equal(value.body.observation.result, "SATISFIED");
    const retainedSource: { content: string; content_hash: string } | undefined =
      (await admin.query(`SELECT content,content_hash FROM finnor_os.evidence_source_versions
      WHERE tenant_id=$1 AND id=$2`, [tenant, value.body.ref.id])).rows[0];
    assert(retainedSource);
    assert.equal(retainedSource.content_hash, value.body.ref.contentDigest);
    assert.equal(JSON.parse(retainedSource.content).originalWorkId, workIds[0]);
  }
  await save("s1-s8-nonadmitted-observed-task-experience.json", { experience,
    qualificationPromotion: false, trainingRights: false, personalityJudgment: null });
  pass("s1-s8-owner-resolved-task-experience-without-self-promotion", { retained: experience.length, admissionGranted: false });
  await stopWorker();
  let reviewHead = await readProgram(competing.body.id);
  const reviewAssignment = reviewHead.body.program.assignments[0];
  for (const action of ["ACCEPT", "START", "DELIVER"]) {
    const response = await api(`workforce/execution-programs/${competing.body.id}/actions`, {
      ...request(reviewAssignment, reviewHead.body.revision, "actual-controlled-participant-" + action, action),
      ...(action === "DELIVER" ? { value: "42" } : {}) }, recipient);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    reviewHead = await readProgram(competing.body.id);
  }
  const checkerRead = await api("workforce/execution-programs/" + competing.body.id, undefined, unrelated);
  assert.equal(checkerRead.status, 200, JSON.stringify(checkerRead.body));
  assert.equal(checkerRead.body.assignments.length, 0);
  assert.equal(checkerRead.body.program, undefined);
  assert.equal(checkerRead.body.reviews.length, 1);
  assert.equal(checkerRead.body.reviews[0].deliveryValue, "42");
  const notChecker = await api(`workforce/execution-programs/${competing.body.id}/actions`,
    request(reviewAssignment, reviewHead.body.revision, "wrong-checker", "VERIFY"));
  assert.equal(notChecker.status, 403, JSON.stringify(notChecker.body));
  const checkedByParticipant = await api(`workforce/execution-programs/${competing.body.id}/actions`,
    request(reviewAssignment, reviewHead.body.revision, "actual-independent-controlled-checker", "VERIFY"), unrelated);
  assert.equal(checkedByParticipant.status, 200, JSON.stringify(checkedByParticipant.body));
  await save("authenticated-minimal-independent-checker-channel.json", { scopedRead: checkerRead.body,
    nonCheckerStatus: notChecker.status, verification: checkedByParticipant.body,
    producer: "CONTROLLED_SERVICE_NOT_A_GENUINE_HUMAN", checker: "CONTROLLED_SERVICE_NOT_A_GENUINE_HUMAN" });
  pass("authenticated-checker-scoped-delivery-and-wrong-checker-refusal",
    { ownAssignments: 0, permittedReviews: 1, nonCheckerStatus: notChecker.status, genuineHumanQualified: false });
  const automatic = await api("workforce/execution-programs/intake", inputs[3]);
  assert.equal(automatic.status, 202, JSON.stringify(automatic.body));
  await startWorker();
  const automaticDone = await waitFor("standing-internal-completion", () => readProgram(automatic.body.id), value => value.body.status === "CLOSED");
  pass("standing-internal-machine-assignment-without-routine-user-coordination", { status: automaticDone.body.status, voluntaryHumanResponseSimulated: false });
  await stopWorker();
  const fallback = await api("workforce/execution-programs/intake", inputs[4]);
  assert.equal(fallback.status, 202, JSON.stringify(fallback.body));
  await startWorker();
  const fallbackOffered = await waitFor("fallback-offer", () => readProgram(fallback.body.id), value => value.body.program?.assignments?.length === 1);
  await stopWorker();
  const oldOffer = fallbackOffered.body.program.assignments[0];
  const revised = { ...oldOffer.terms, revision: oldOffer.terms.revision + 1, deliverable: "Exact revised deliverable, original independent criterion retained" };
  const widen = await api(`workforce/execution-programs/${fallback.body.id}/actions`, {
    ...request(oldOffer, fallbackOffered.body.revision, "terms-widening", "REVISE_TERMS"),
    revisedTerms: { ...revised, compensation: { value: "1", unit: "USD" } } });
  assert.equal(widen.status, 409); assert.equal(widen.body.error, "WORKFORCE_REVISED_TERMS_EXCEED_ORIGINAL_ENVELOPE");
  const revisedResponse = await api(`workforce/execution-programs/${fallback.body.id}/actions`, {
    ...request(oldOffer, fallbackOffered.body.revision, "terms-revision", "REVISE_TERMS"), revisedTerms: revised });
  assert.equal(revisedResponse.status, 200, JSON.stringify(revisedResponse.body));
  const obsolete = await api(`workforce/execution-programs/${fallback.body.id}/actions`,
    request(oldOffer, revisedResponse.body.revision, "obsolete-accept"), recipient);
  assert.equal(obsolete.status, 409); assert.equal(obsolete.body.error, "WORKFORCE_EXACT_CURRENT_TERMS_REQUIRED");
  const revisedHead = await readProgram(fallback.body.id), revisedOffer = revisedHead.body.program.assignments[0];
  const declined = await api(`workforce/execution-programs/${fallback.body.id}/actions`,
    request(revisedOffer, revisedHead.body.revision, "decline-revised", "DECLINE"), recipient);
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  const backup = actorSources.get(unrelated)!;
  const qualifiedBackup = structuredClone(backup.snapshot);
  qualifiedBackup.actor.capabilities.push({ ...qualifiedBackup.actor.capabilities[0], skill: "compute" });
  await withTenantTransaction(tenant, { userId: principal }, async (_db, client) =>
    appendEvidenceVersionTx(transactionDb(client), tenant, backup.id,
      { content: JSON.stringify(qualifiedBackup), snapshot: qualifiedBackup }));
  const replacementId = fallback.body.id + ":actual-backup";
  const fallbackOriginal = (await admin.query("SELECT work_id,budget,original FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2",
    [tenant, fallback.body.id])).rows[0];
  const replaced = await api(`workforce/execution-programs/${fallback.body.id}/actions`, {
    ...request(revisedOffer, declined.body.revision, "real-backup", "REASSIGN"),
    replacementActorId: unrelated, replacementAssignmentId: replacementId });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const nextHead = await readProgram(fallback.body.id), replacement = nextHead.body.program.assignments.find((a: any) => a.id === replacementId);
  assert.equal(replacement.state.kind, "OFFERED"); assert.equal(replacement.terms.revision, revised.revision);
  assert.notEqual(nextHead.body.status, "CLOSED", "Closing the refused attempt is not completion of the original deliverable");
  const backupAccepted = await api(`workforce/execution-programs/${fallback.body.id}/actions`,
    request(replacement, nextHead.body.revision, "actual-backup-accept"), unrelated);
  assert.equal(backupAccepted.status, 200, JSON.stringify(backupAccepted.body));
  await startWorker();
  const fallbackDone = await waitFor("actual-backup-completion", () => readProgram(fallback.body.id), value => value.body.status === "CLOSED");
  const fallbackFinal = (await admin.query("SELECT work_id,budget,original FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2",
    [tenant, fallback.body.id])).rows[0];
  assert.deepEqual(fallbackFinal, fallbackOriginal);
  const fallbackEvents = (await admin.query("SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2",
    [tenant, fallback.body.id])).rows;
  assert.equal(fallbackEvents.filter(e => e.kind === "S6_INTENDED").length, 1);
  assert.equal(fallbackEvents.find(e => e.kind === "S6_OBSERVATION")?.body.assignmentId, replacementId);
  await save("revised-terms-and-actual-original-root-fallback.json", { fallbackOriginal, fallbackFinal, widen,
    revisedResponse, obsolete, declined, replaced, backupAccepted, completed: fallbackDone.body, events: fallbackEvents });
  pass("exact-terms-revision-reoffer-and-actual-metered-fallback", { freshTerms: revised.revision,
    actualBackup: replacementId, originalRootBudgetDeadlineRetained: true, physicalBackupExecutions: 1 });
  const nestedResponse = await api("workforce/execution-programs/intake", inputs[5]);
  assert.equal(nestedResponse.status, 202, JSON.stringify(nestedResponse.body));
  const nestedDone = await waitFor("native-nested-closure", () => readProgram(nestedResponse.body.id), value => value.body.status === "CLOSED");
  const child = nestedDone.body.program.assignments.find((a: any) => a.taskId === "task-1");
  assert(child.parentAssignmentId); assert.equal(child.rootId, workIds[5]);
  const nestedUses = (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2`, [tenant, nestedResponse.body.id])).rows;
  assert.equal(nestedUses.length, 3); assert(nestedUses.every(use => use.status === "RECONCILED"));
  assert(nestedUses.every(use => use.body.envelope[0].quantities[0] === "1"), "Parent direct use must exclude the child's carved unit");
  await save("native-nested-subdelegation-and-reciprocal-return-edge.json", { original: inputs[5], completed: nestedDone.body, consumptions: nestedUses });
  pass("native-nested-attenuation-frontier-and-original-return-edge", { physicalConsumptions: 3, parentDirectUse: "1", childUse: "1" });
  const fractionResponse = await api("workforce/execution-programs/intake", inputs[6]);
  assert.equal(fractionResponse.status, 202, JSON.stringify(fractionResponse.body));
  const fractionDone = await waitFor("native-exact-rational-completion", () => readProgram(fractionResponse.body.id), value => value.body.status === "CLOSED");
  const fractionUse = (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2 AND co.body->>'nodeId'<>$2`, [tenant, fractionResponse.body.id])).rows;
  assert.equal(fractionUse.length, 1); assert.equal(fractionUse[0].body.envelope[0].quantities[0], "r3q:4/3");
  assert.equal(fractionDone.body.program.originalOutcome.tasks[0].effortSeconds, "1/3");
  await save("native-exact-rational-codec-crossing.json", { completed: fractionDone.body, consumption: fractionUse });
  pass("native-exact-rational-domain-and-s5-codecs", { domain: "4/3", ledger: "r3q:4/3", effort: "1/3", rounding: "NONE" });
  await stopWorker();
  {
    const created = await api("workforce/execution-programs/intake", inputs[8]);
    assert.equal(created.status, 202, JSON.stringify(created.body)); await startWorker();
    const offeredDynamic = await waitFor("dynamic-parent-offer", () => readProgram(created.body.id),
      value => value.body.program?.assignments?.length === 1);
    await stopWorker();
    const parent = offeredDynamic.body.program.assignments[0];
    assert.equal(parent.actorId, recipient, "THE_INDEPENDENT_CHECKER_CANNOT_BE_THE_PARENT_PRODUCER");
    const beforeDynamic = (await admin.query("SELECT work_id,budget,original FROM finnor_os.w2_programs WHERE id=$1", [created.body.id])).rows[0];
    const firstCertificate = (await admin.query(`SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND operation='WORKFORCE_CARVE'
      AND body->>'assignmentId'=$2`, [tenant, parent.id])).rows[0].body;
    const reservationCount = (await admin.query("SELECT count(*)::int count FROM finnor_os.s5_reservations WHERE tenant_id=$1", [tenant])).rows[0].count;
    const attemptedNewRoot = await api("workforce/execution-programs/intake", { ...inputs[8], idempotencyKey: "new-key-cannot-reset-root" });
    assert([200, 202, 409].includes(attemptedNewRoot.status), JSON.stringify(attemptedNewRoot.body));
    if (attemptedNewRoot.status !== 409) assert.equal(attemptedNewRoot.body.id, created.body.id);
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.w2_programs WHERE tenant_id=$1 AND work_id=$2",
      [tenant, workIds[8]])).rows[0].count, 1);
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.s5_reservations WHERE tenant_id=$1", [tenant])).rows[0].count, reservationCount);
    const actDynamic = async (assignmentId: string, actor: string, key: string, action: string, extra: Record<string, unknown> = {}) => {
      const head = await readProgram(created.body.id), a = head.body.program.assignments.find((a: any) => a.id === assignmentId);
      return api(`workforce/execution-programs/${created.body.id}/actions`, { ...request(a, head.body.revision, key, action), ...extra }, actor);
    };
    for (const action of ["ACCEPT", "START"]) {
      const response = await actDynamic(parent.id, recipient, "dynamic-parent-" + action, action);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    const proposal = (id: string, amount: string, actor: string, kind: "SUBDELEGATION" | "RECIPROCAL_REQUEST", expected: string, values = ["20", "22"]) => {
      const { parentTaskId: _parent, delegatorActorId: _delegator, criterionId: _criterion, ...spec } = structuredClone(dynamicOriginal.outcome.tasks[0]!);
      return nativeWorkforceRefinementSchema.parse({ kind, recipientActorId: actor,
        task: { ...spec, id, dependsOn: [], returnTo: [], demand: [envelope(amount)],
          allowedActorKinds: [actor === principal ? "COMPUTATIONAL_CELL" : "DETERMINISTIC_SERVICE"],
          requiredCapabilities: [{ skill: actor === principal ? "root-analysis" : "backup-compute", scope: "analysis" }],
          terms: { ...spec.terms, deliverable: "Return independently checked requested evidence " + id } },
        criterion: { id: "criterion-" + id, checkerActorId: recipient, evidenceCustodianActorId: recipient,
          acceptance: { kind: "EXACT_JSON", expected } },
        computation: { kind: "SUM_INTEGERS", values } });
    };
    const firstProposal = proposal("dynamic-child", "2", unrelated, "SUBDELEGATION", "42");
    const impersonation = await actDynamic(parent.id, principal, "root-cannot-impersonate-recipient", "SUBDELEGATE", { refinement: firstProposal });
    assert.equal(impersonation.status, 403, JSON.stringify(impersonation.body));
    const head = await readProgram(created.body.id);
    const creationRequest = { ...request(parent, head.body.revision, "actual-accepted-recipient-child", "SUBDELEGATE"), refinement: firstProposal };
    const added = await api(`workforce/execution-programs/${created.body.id}/actions`, creationRequest, recipient);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const creationReplay = await api(`workforce/execution-programs/${created.body.id}/actions`, creationRequest, recipient);
    assert.equal(creationReplay.status, 200, JSON.stringify(creationReplay.body)); assert.equal(creationReplay.body.semanticReplay, true);
    const childId = `${created.body.id}:dynamic-child:1`, reciprocalId = `${created.body.id}:dynamic-return:1`;
    const childView = await api("workforce/execution-programs/" + created.body.id, undefined, unrelated);
    assert.equal(childView.status, 200, JSON.stringify(childView.body));
    assert(childView.headers.cacheControl?.includes("no-store"));
    assert(!JSON.stringify(childView.body).includes("PRIVATE_DYNAMIC_PARENT_COMBINATION"));
    assert.equal(childView.body.assignments.find((v: any) => v.assignment.id === childId).assignment.state.kind, "OFFERED");
    const premature = await actDynamic(parent.id, recipient, "premature-original-delivery", "DELIVER", { value: ["42", "43"] });
    assert.equal(premature.status, 409, JSON.stringify(premature.body));
    for (const action of ["ACCEPT", "START"]) {
      const response = await actDynamic(childId, unrelated, "dynamic-child-" + action, action);
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    const reciprocalProposal = proposal("dynamic-return", "1", principal, "RECIPROCAL_REQUEST", "42");
    const reciprocal = await actDynamic(childId, unrelated, "actual-reciprocal-request", "SUBDELEGATE", { refinement: reciprocalProposal });
    assert.equal(reciprocal.status, 200, JSON.stringify(reciprocal.body));
    const acceptReturn = await actDynamic(reciprocalId, principal, "actual-return-recipient-accept", "ACCEPT");
    assert.equal(acceptReturn.status, 200, JSON.stringify(acceptReturn.body));
    await startWorker();
    const returned = await waitFor("dynamic-reciprocal-physical-return", () => readProgram(created.body.id), value =>
      value.body.program?.assignments?.filter((a: any) => a.id !== parent.id).every((a: any) => a.state.kind === "CLOSED"));
    await stopWorker();
    assert.equal(returned.body.program.assignments.find((a: any) => a.id === parent.id).state.kind, "IN_PROGRESS");
    const returnedToActualRequester = await api("workforce/execution-programs/" + created.body.id, undefined, unrelated);
    assert.equal(returnedToActualRequester.status, 200, JSON.stringify(returnedToActualRequester.body));
    assert.equal(returnedToActualRequester.body.requestedWork.find((value: any) => value.assignmentId === reciprocalId)?.result?.value, "42");
    assert(!JSON.stringify(returnedToActualRequester.body).includes("PRIVATE_DYNAMIC_PARENT_COMBINATION"));
    const refinementBefore = (await admin.query("SELECT count(*)::int count FROM finnor_os.w2_events WHERE program_id=$1 AND kind='TASK_CREATION'", [created.body.id])).rows[0].count;
    const oversized = await actDynamic(parent.id, recipient, "cannot-copy-spent-child-budget", "SUBDELEGATE",
      { refinement: proposal("over-carved-child", "2", unrelated, "SUBDELEGATION", "43", ["20", "23"]) });
    assert.equal(oversized.status, 409, JSON.stringify(oversized.body));
    assert.equal((await admin.query("SELECT count(*)::int count FROM finnor_os.w2_events WHERE program_id=$1 AND kind='TASK_CREATION'", [created.body.id])).rows[0].count, refinementBefore);
    const sibling = await actDynamic(parent.id, recipient, "refine-after-known-physical-spend", "SUBDELEGATE",
      { refinement: proposal("dynamic-sibling", "1", unrelated, "SUBDELEGATION", "43", ["20", "23"]) });
    assert.equal(sibling.status, 200, JSON.stringify(sibling.body));
    const siblingId = `${created.body.id}:dynamic-sibling:1`;
    const siblingAcceptance = await actDynamic(siblingId, unrelated, "actual-sibling-recipient-accept", "ACCEPT");
    assert.equal(siblingAcceptance.status, 200, JSON.stringify(siblingAcceptance.body));
    await startWorker();
    await waitFor("dynamic-sibling-physical-return", () => readProgram(created.body.id), value =>
      value.body.program?.assignments?.find((a: any) => a.id === siblingId)?.state.kind === "CLOSED");
    await stopWorker();
    const actualReturnedWork = await api("workforce/execution-programs/" + created.body.id, undefined, recipient);
    assert.equal(actualReturnedWork.status, 200, JSON.stringify(actualReturnedWork.body));
    const parentValue = [childId, siblingId].map(id => actualReturnedWork.body.requestedWork.find((value: any) => value.assignmentId === id)?.result?.value);
    assert.deepEqual(parentValue, ["42", "43"]);
    const delivery = await actDynamic(parent.id, recipient, "actual-returned-evidence-combination", "DELIVER", { value: parentValue });
    assert.equal(delivery.status, 200, JSON.stringify(delivery.body));
    const parentReview = await api("workforce/execution-programs/" + created.body.id, undefined, unrelated);
    assert.equal(parentReview.status, 200, JSON.stringify(parentReview.body));
    assert(parentReview.body.reviews.some((review: any) => review.assignmentId === parent.id));
    const verified = await actDynamic(parent.id, unrelated, "actual-original-independent-check", "VERIFY");
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); await startWorker();
    const done = await waitFor("whole-dynamic-original-work-complete", () => readProgram(created.body.id), value => value.body.status === "CLOSED");
    const afterDynamic = (await admin.query("SELECT work_id,budget,original FROM finnor_os.w2_programs WHERE id=$1", [created.body.id])).rows[0];
    assert.deepEqual(afterDynamic, beforeDynamic);
    assert.equal(done.body.program.originalOutcome.tasks.length, 1); assert.equal(done.body.program.taskCreations.length, 3);
    assert.equal(done.body.program.assignments.length, 4); assert(done.body.program.assignments.every((a: any) => a.state.kind === "CLOSED"));
    const retainedCertificate = (await admin.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='WORKFORCE_CARVE'",
      [tenant, firstCertificate.ref.id])).rows[0].body;
    assert.deepEqual(retainedCertificate, firstCertificate);
    const frontiers = (await admin.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='WORKFORCE_CARVE_FRONTIER' ORDER BY revision",
      [tenant, beforeDynamic.budget.reservationRef.id])).rows;
    assert.equal(frontiers.length, 4);
    const dynamicUses = (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
      WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2`, [tenant, created.body.id])).rows;
    assert.equal(dynamicUses.length, 4); assert(dynamicUses.every(use => use.status === "RECONCILED"));
    const dynamicEvents = (await admin.query("SELECT kind,body,created_at FROM finnor_os.w2_events WHERE program_id=$1 ORDER BY created_at,event_id", [created.body.id])).rows;
    assert.equal(dynamicEvents.filter(e => e.kind === "S6_INTENDED").length, 3);
    for (const id of [childId, reciprocalId, siblingId]) assert.equal(dynamicEvents.filter(e => e.kind === "S6_INTENDED" && e.body.assignmentId === id).length, 1);
    const auxiliaryExperience = dynamicEvents.filter(e => e.kind === "S8_OUTCOME_OBSERVATION" && e.body.observation.assignmentId !== parent.id);
    assert(auxiliaryExperience.length >= 3); assert(auxiliaryExperience.every(e => e.body.observation.taskCreationRef &&
      e.body.observation.parentAssignmentId && e.body.observation.admissionGranted === false));
    const completedDynamicWork = await api("works/" + workIds[8]); assert.equal(completedDynamicWork.body.work.work.status, "completed");
    await save("lawful-dynamic-subdelegation-reciprocal-return-and-spent-frontier.json", { original: inputs[8], beforeDynamic, afterDynamic,
      attemptedNewRoot, impersonation, added, creationReplay, childView: childView.body, premature, reciprocal, oversized,
      sibling, returnedToActualRequester: returnedToActualRequester.body, actualReturnedWork: actualReturnedWork.body,
      delivery, verified, completed: done.body, firstCertificate, retainedCertificate, frontiers,
      consumptions: dynamicUses, events: dynamicEvents, genuineHumanQualified: false, controlledServiceManualCombination: true });
    pass("lawful-dynamic-child-reciprocal-physical-return-and-whole-original-completion",
      { originalTasks: 1, newTasks: 3, originalResourceEnvelope: "4", immutableCarveCertificate: true, frontierFrames: 4,
        physicalChildExecutions: 3, genuineHumanQualified: false });
    pass("dynamic-private-fresh-acceptance-idempotency-and-known-spend-conservation",
      { impersonation: 403, earlyDelivery: 409, overCarve: 409, semanticReplay: true, independentOriginalChecker: true, originalRootCount: 1 });
    await stopWorker();
  }
  const interrupted = await api("workforce/execution-programs/intake", inputs[2]);
  assert.equal(interrupted.status, 202, JSON.stringify(interrupted.body));
  await startWorker();
  const offered = await waitFor("interruption-offer", () => readProgram(interrupted.body.id), value => value.body.program?.assignments?.length === 1);
  await stopWorker();
  const before = (await admin.query("SELECT work_id,budget,original FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, interrupted.body.id])).rows[0];
  const interruptedActorId = String(offered.body.program.assignments[0].actorId);
  assert([recipient, unrelated].some(actor => actor === interruptedActorId), "ORIGINAL_ELIGIBLE_COMPUTE_RECIPIENT_REQUIRED");
  await save("interruption-original-offer-and-actual-recipient.json", { offered: offered.body,
    authenticatedRecipient: interruptedActorId, offeredTermsUnchanged: true });
  const acceptance = await api(`workforce/execution-programs/${interrupted.body.id}/actions`,
    request(offered.body.program.assignments[0], offered.body.revision, "interrupted-accept"), interruptedActorId);
  assert.equal(acceptance.status, 200, JSON.stringify(acceptance.body));
  killProgram = interrupted.body.id; await startWorker();
  await waitFor("actual-sigkill", async () => ({ signal: worker!.signalCode, events: workerEvents.filter(e => e.programId === killProgram) }),
    value => value.signal === "SIGKILL");
  killProgram = null;
  const uncertainBefore = (await admin.query("SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2", [tenant, interrupted.body.id])).rows;
  assert.equal(uncertainBefore.filter(e => e.kind === "S6_INTENDED").length, 1);
  assert.equal(uncertainBefore.filter(e => e.kind === "S6_OBSERVATION").length, 0, "The physical kill must precede observation commit");
  await startWorker();
  await waitFor("actual-queue-quarantine", async () => (await admin!.query(`SELECT id,status,claim_fence,claim_token IS NULL token_cleared
    FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'programId'=$2 ORDER BY run_at,id`, [tenant, interrupted.body.id])).rows,
    value => value.some(job => job.status === "quarantined"));
  const recoveryHead = await readProgram(interrupted.body.id);
  const recovery = await api(`workforce/execution-programs/${interrupted.body.id}/reconcile`,
    { idempotencyKey: "actual-physical-reconciliation", expectedRevision: recoveryHead.body.revision });
  assert.equal(recovery.status, 202, JSON.stringify(recovery.body));
  await waitFor("read-only-reconciliation", async () => (await admin!.query(`SELECT kind,body FROM finnor_os.w2_events
    WHERE tenant_id=$1 AND program_id=$2`, [tenant, interrupted.body.id])).rows, value => value.some(e => e.kind === "READ_ONLY_RECOVERY"));
  const after = (await admin.query("SELECT work_id,budget,original,program,status FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2", [tenant, interrupted.body.id])).rows[0];
  assert.deepEqual(after.budget, before.budget); assert.equal(after.work_id, before.work_id); assert.deepEqual(after.original, before.original);
  const recoveryEvents = (await admin.query("SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2", [tenant, interrupted.body.id])).rows;
  assert.equal(recoveryEvents.filter(e => e.kind === "S6_INTENDED").length, 1);
  assert.equal(recoveryEvents.filter(e => e.kind === "S6_OBSERVATION").length, 0);
  const retained = (await admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2`, [tenant, interrupted.body.id])).rows;
  assert.equal(retained.length, 2); assert(retained.some(r => r.status === "UNKNOWN_OUTCOME"));
  const unknownExperience = recoveryEvents.filter(e => e.kind === "S8_OUTCOME_OBSERVATION");
  assert(unknownExperience.some(e => e.body.observation.result === "UNKNOWN" &&
    e.body.observation.uncertainty.includes("UNRESOLVED_ORIGINAL_RESOURCE_USE")));
  await save("physical-interruption-and-original-read-only-recovery.json", { before, after, retained, recovery, recoveryEvents, workerEvents });
  pass("physical-sigkill-real-lease-quarantine-and-no-attempt-replay", { originalReservationRetained: true, originalDeadlineRetained: true,
    originalS6Intents: 1, repeatedAttempts: 0, retainedUse: "UNKNOWN_OUTCOME" });
  await stopWorker();
  const unknownHead = await readProgram(interrupted.body.id), unknownAssignment = unknownHead.body.program.assignments[0];
  const { parentTaskId: _unknownParent, delegatorActorId: _unknownDelegator, criterionId: _unknownCriterion, ...unknownTask } =
    structuredClone(inputs[2]!.original.outcome.tasks[0]!);
  const unknownRefinement = nativeWorkforceRefinementSchema.parse({ kind: "SUBDELEGATION",
    recipientActorId: interruptedActorId === recipient ? unrelated : recipient,
    task: { ...unknownTask, id: "unknown-use-is-not-spare-budget", dependsOn: [], returnTo: [],
      demand: [envelope("1")], terms: { ...unknownTask.terms, deliverable: "This cannot be funded by unresolved original use" } },
    criterion: { id: "unknown-use-is-not-spare-budget-criterion", checkerActorId: principal, evidenceCustodianActorId: principal,
      acceptance: { kind: "EXACT_JSON", expected: "42" } }, computation: { kind: "SUM_INTEGERS", values: ["20", "22"] } });
  const unknownChild = await api(`workforce/execution-programs/${interrupted.body.id}/actions`,
    { ...request(unknownAssignment, unknownHead.body.revision, "unresolved-use-cannot-fund-new-child", "SUBDELEGATE"),
      refinement: unknownRefinement }, interruptedActorId);
  assert.equal(unknownChild.status, 409, JSON.stringify(unknownChild.body));
  assert.equal(unknownChild.body.error, "WORKFORCE_S5_REFINEMENT_RETAINS_SPENT_AND_UNKNOWN");
  const unknownCreations = (await admin.query("SELECT count(*)::int count FROM finnor_os.w2_events WHERE program_id=$1 AND kind='TASK_CREATION'",
    [interrupted.body.id])).rows[0].count;
  assert.equal(unknownCreations, 0);
  const unknownCarveFrames = (await admin.query("SELECT count(*)::int count FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='WORKFORCE_CARVE_FRONTIER'",
    [tenant, before.budget.reservationRef.id])).rows[0].count;
  assert.equal(unknownCarveFrames, 1);
  await save("physical-unknown-use-cannot-finance-dynamic-refinement.json", { unknownHead: unknownHead.body,
    response: unknownChild, taskCreations: unknownCreations, originalFrontierFrames: unknownCarveFrames, originalS6Intents: 1,
    actualOriginalResourceUse: "UNKNOWN_NOT_ZERO", originalEpisodeReset: false });
  pass("actual-unknown-original-use-cannot-finance-dynamic-child",
    { status: 409, ownerRefusal: unknownChild.body.error, newChildren: 0, frontierFrames: 1, physicalRetry: false });
  await stopWorker();
  const revokeOutstandingRecipient = async () => {
    // Use the actual compiler-selected recipient. An already qualified backup
    // may legitimately win a later match; its identity is not a fixture oracle.
    const revoked = await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2 RETURNING id,status",
      [tenant, interruptedActorId]);
    const fenced = await readProgram(interrupted.body.id);
    assert.equal(fenced.body.status, "FENCED", JSON.stringify(fenced.body));
    const noLongerVisible = await api("workforce/execution-programs/" + interrupted.body.id, undefined, interruptedActorId);
    assert([401, 403, 404].includes(noLongerVisible.status));
    pass("canonical-recipient-revocation-fences-current-use-and-read",
      { revoked: revoked.rows, status: fenced.body.status, recipientReadStatus: noLongerVisible.status });
    await save("revocation-and-retained-responsibility.json",
      { revoked: revoked.rows, ownerRead: fenced.body, recipientStatus: noLongerVisible.status });
  };
  if (mounted) {
    mountedResult = await holdMountedWorkforce({ repo: root, evidence, privateDirectory: directory,
      frontendOrigin, frontendInstallation, tenant, principal, alternate: unrelated, foreignTenant: otherTenant, foreign: outsider,
      participant: recipient, participantWorkId: workIds[0]!,
      preparedFrontend: mountedFrontend,
      workId: workIds[7]!, original: mountedOriginal, admin, service, gate: mountedGate, api, startWorker,
      onPositive: revokeOutstandingRecipient });
    pass("actual-mounted-compile-completion-and-private-scope-withdrawal", mountedResult);
  } else await revokeOutstandingRecipient();
  }
  assert(traffic.length < 20000, "COMPLETE_NATIVE_HTTP_OBSERVATIONS_REQUIRED");
  assert.deepEqual(traffic.filter((value, index) => (value as { status?: number }).status! >= 500 &&
    !(tamperProbeTrace && index === tamperProbeTrace.index && (value as { status?: number }).status === 503 &&
      (value as { path?: string }).path === tamperProbeTrace.path)), [], "NO_NATIVE_HTTP_SERVER_FAILURES_OR_RETRIED_DEADLOCKS");
  for (const source of sources) assert.equal(sha(await readFile(join(root, source.path))), source.sha256, "SOURCE_CHANGED_DURING_NATIVE_RUN:" + source.path);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await save("failure-live-process-observations.json", { observedAt: new Date().toISOString(), controllerPid: process.pid,
    nodeVersion: process.version, controllerMemory: process.memoryUsage(), workerPid: worker?.pid ?? null,
    workerExitCode: worker?.exitCode ?? null, workerSignal: worker?.signalCode ?? null }).catch(() => {});
  if (admin) await save("failure-live-sql-waits.json", (await admin.query(`SELECT pid,application_name,state,
    backend_start,xact_start,query_start,wait_event_type,wait_event,pg_blocking_pids(pid) blocking_pids,
    md5(query) query_digest FROM pg_stat_activity WHERE datname=current_database() ORDER BY pid LIMIT 64`)).rows).catch(() => {});
  if (admin) await save("failure-native-jobs.json", (await admin.query(`SELECT id,type,status,attempts,last_error,payload,
    claim_fence,lease_expires_at FROM finnor_os.jobs ORDER BY run_at,id LIMIT 1000`)).rows).catch(() => {});
  if (admin) await save("failure-native-programmes.json", (await admin.query(`SELECT id,work_id,status,program,budget,original
    FROM finnor_os.w2_programs ORDER BY id LIMIT 128`)).rows).catch(() => {});
  console.error(failure); process.exitCode = 1;
} finally {
  clearTimeout(wall);
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const child = worker, exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exit; clearTimeout(timer);
  }
  const cleanup: Array<{ name: string; status: "PASS" | "FAIL"; errorType?: string; code?: string }> = [];
  for (const [name, close] of [
    ["mounted-frontend", () => mountedFrontend?.stop()], ["authenticated-service", () => service?.close()],
    ["application-pool", () => closePool()], ["database-admin", () => admin?.end()], ["owned-postgres", () => database?.stop()],
  ] as const) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error("W2_OWNED_CLEANUP_BOUND"), { code: "W2_OWNED_CLEANUP_BOUND" })), 10000);
      })]);
      cleanup.push({ name, status: "PASS" });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      cleanup.push({ name, status: "FAIL", errorType: error instanceof Error ? error.name : "Unknown",
        ...(/^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? { code } : {}) });
      failure ??= "W2_OWNED_CLEANUP_FAILED:" + name;
    } finally { if (timer) clearTimeout(timer); }
  }
  await save("cleanup.json", { status: cleanup.some(row => row.status === "FAIL") ? "FAIL" : "PASS", steps: cleanup });
  await save("traffic-without-credentials.json", traffic);
  await save("report.json", { schema: "finnor.postz.w2.native-e2e-report.v1", finishedAt: new Date().toISOString(),
    status: failure ? "FAIL" : "PASS", results, failure, cleanup, sourceHashes: sources, actualOrdinaryAuthentication: true,
    actualRestrictedRoles: true, protectedQualification: false, genuineHumanQualified: false, fieldActivation: false,
    mountedReadback: mountedResult ?? "NOT_RUN_IN_THIS_DRIVER", installedRuntime: Boolean(installation), retainedUnknownResourceUse: true });
  console.log(JSON.stringify({ evidence, status: failure ? "FAIL" : "PASS", passed: results.length }));
  process.exit(failure ? 1 : 0);
}
