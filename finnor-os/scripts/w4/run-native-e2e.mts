/** Owning-boundary acceptance driver. Not a unit suite or a field claim. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { mkdir, writeFile, appendFile, statfs, open } from "node:fs/promises";
import { resolve, dirname, basename, join, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createNativeGrowthJourney, NATIVE_GROWTH_LIMITS } from "./native-growth-journey.mjs";
import { growthRecipient } from "./recipient.mjs";
import { authenticatedApiFixture } from "../frontier5/x1/authenticated-api-fixture.mjs";
import { createUpstreamFixtureSupport } from "../s5/owner-fixture.mjs";
import { captureNumericalProcesses } from "./numerical-process-diagnostics.mjs";
import { POST as allocationPost } from "../../apps/api/app/api/allocations/[operation]/route";
import { POST as policyPost } from "../../apps/api/app/api/policies/[operation]/route";
import { POST as obligationPost } from "../../apps/api/app/api/obligations/[operation]/route";

const args = process.argv.slice(2), at = args.indexOf("--output");
assert(at >= 0 && args.length === 2 && isAbsolute(args[at + 1]!), "W4_NEW_ABSOLUTE_OUTPUT_REQUIRED");
const workspace = resolve(import.meta.dirname, "../.."), repo = dirname(workspace), output = resolve(args[at + 1]!);
assert.equal(process.cwd(), workspace, "W4_EXPLICIT_WORKSPACE_REQUIRED");
await mkdir(output, { recursive: false, mode: 0o700 });
const disk = await statfs(output); assert(Number(disk.bavail) * Number(disk.bsize) >= 4 * 1024 ** 3, "W4_FOUR_GIB_FREE_REQUIRED");
const startedAt = new Date().toISOString(), started = performance.now(), traffic: unknown[] = [], workers: unknown[] = [];
const checkBound = () => assert(performance.now() - started < NATIVE_GROWTH_LIMITS.maximumMilliseconds, "W4_ORIGINAL_NATIVE_WALL_BOUND");
const artifact = async (name: string, body: unknown) => {
  const file = resolve(output, name); assert(file.startsWith(output + "/")); await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
};
const privateDiagnostic = async (name: string, body: unknown) => {
  const directory = join(output, "private-diagnostics"), file = resolve(directory, name);
  assert(file.startsWith(directory + "/")); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(body, null, 2) + "\n"); await handle.sync() } finally { await handle.close() }
  const parent = await open(dirname(file), "r");
  try { await parent.sync() } finally { await parent.close() }
};
let fitOriginals: Readonly<Record<string, unknown>> | null = null, fitCaptures = 0, activeFitWindow: number | null = null;
let originalObservations = 0, originalIntakeWireBody: string | null = null;
const s1Failures: Record<string, unknown>[] = [];
let s1Dropped = 0, s1Invalid = 0, s1ForeignPid = 0;
const s1FailureChannel = channel("finnor.s1.belief-load-failure.v1");
const knownS1FailureCodes = new Set([
  "JSON_COMPLEXITY_LIMIT", "NON_CANONICAL_JSON", "REFERENCE_DIGEST_ENCODING_UNSUPPORTED",
  "NATIVE_OWNER_EVENT_SCOPE_INVALID", "NATIVE_OWNER_PREIMAGE_MISMATCH", "NATIVE_OWNER_REFERENCE_CONFLICT",
  "NATIVE_SNAPSHOT_PREIMAGE_UNAVAILABLE", "OWNER_ORIGIN_STORAGE_BINDING_INVALID",
  "OWNER_ORIGIN_EVENT_IDENTITY_INVALID", "OWNER_ORIGIN_EVENT_SCOPE_INVALID", "OWNER_ORIGIN_KEY_REVOKED_OR_UNAVAILABLE",
  "OWNER_ORIGIN_REFERENCE_BOUND", "OWNER_ORIGIN_REFERENCE_INVALID", "OWNER_ORIGIN_RIGHTS_INVALID",
  "OWNER_ORIGIN_SCOPE_INVALID", "OWNER_ORIGIN_SEAL_INVALID", "OWNER_ORIGIN_SIGNATURE_INVALID",
  "OWNER_ORIGIN_SIGNER_MISMATCH", "OWNER_ORIGIN_SIGNER_UNAVAILABLE",
  "OWNER_TRANSPORT_AMBIGUOUS_IDENTITY", "OWNER_TRANSPORT_BUDGET_INVALID", "OWNER_TRANSPORT_BYTE_BOUND",
  "OWNER_TRANSPORT_CONFIGURATION_EXPIRED", "OWNER_TRANSPORT_CONFIGURATION_SIGNATURE_INVALID",
  "OWNER_TRANSPORT_CREDENTIAL_NOT_ATTENUATED", "OWNER_TRANSPORT_DIGEST_INVALID", "OWNER_TRANSPORT_ENDPOINT_UNSUPPORTED",
  "OWNER_TRANSPORT_FIELD_SET_INVALID", "OWNER_TRANSPORT_IDENTITY_IMMUTABLE", "OWNER_TRANSPORT_KEY_TYPE_INVALID",
  "OWNER_TRANSPORT_LIST_INVALID", "OWNER_TRANSPORT_OBJECT_INVALID", "OWNER_TRANSPORT_ORIGIN_KEY_INVALID",
  "OWNER_TRANSPORT_POLICY_UNSUPPORTED", "OWNER_TRANSPORT_PRINCIPAL_UNAVAILABLE", "OWNER_TRANSPORT_PRIVATE_FILE_UNSAFE",
  "OWNER_TRANSPORT_PURPOSE_INVALID", "OWNER_TRANSPORT_RIGHTS_AMBIGUOUS", "OWNER_TRANSPORT_ROOT_UNAVAILABLE",
  "OWNER_TRANSPORT_SCOPE_INVALID", "OWNER_TRANSPORT_SIGNATURE_ENCODING_INVALID", "OWNER_TRANSPORT_SIGNER_UNBOUND",
  "OWNER_TRANSPORT_TEXT_INVALID", "OWNER_TRANSPORT_TIME_INVALID", "OWNER_TRANSPORT_UNRESOLVED_BACKLOG_LIMIT",
  "S1_VIEW_CUT_INVALID", "S1_VIEW_BYTE_ENVELOPE_EXCEEDED", "S1_CLAIM_LIMIT_INVALID",
  "S1_DECISION_CONTEXT_UNSUPPORTED", "S1_DECISION_REQUIREMENT_INVALID", "S1_DECIMAL_REPRESENTATION_UNSUPPORTED",
  "08006", "22P02", "23503", "23505", "23514", "40001", "40P01", "42501", "42601", "42703", "42P01", "53300", "57014", "57P01",
]);
const observeS1Failure = (raw: unknown) => {
  try {
    const keys = ["schema", "phase", "causeClass", "knownCode", "causeHash", "publisherPid"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { s1Invalid++; return }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, "value"))) { s1Invalid++; return }
    const value = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value])) as Record<string, unknown>;
    if (value.schema !== "finnor.s1.belief-load-failure.v1"
      || typeof value.phase !== "string" || !["BOUND_VIEW", "NATIVE_ENQUEUE"].includes(value.phase)
      || typeof value.causeClass !== "string"
      || !["LEDGER_FAULT", "DATABASE_ERROR", "PE_DOMAIN_ERROR", "TYPE_ERROR", "RANGE_ERROR", "SYNTAX_ERROR", "ERROR", "NON_ERROR"].includes(value.causeClass)
      || !(value.knownCode === null || typeof value.knownCode === "string" && knownS1FailureCodes.has(value.knownCode))
      || typeof value.causeHash !== "string" || !/^[a-f0-9]{64}$/.test(value.causeHash)
      || typeof value.publisherPid !== "number" || !Number.isSafeInteger(value.publisherPid)
      || value.publisherPid < 1 || value.publisherPid > 2147483647) { s1Invalid++; return }
    if (value.publisherPid !== process.pid) { s1ForeignPid++; return }
    if (s1Failures.length >= 64) { s1Dropped++; return }
    s1Failures.push({ at: new Date().toISOString(), activeFitWindow, schema: value.schema,
      phase: value.phase, causeClass: value.causeClass, knownCode: value.knownCode, causeHash: value.causeHash,
      publisherPid: value.publisherPid, observerPid: process.pid, sameProcess: true });
  } catch { s1Invalid++ }
};
await privateDiagnostic("diagnostic-contract.json", { schema: "finnor.w4.fresh-diagnostic-contract.v1",
  caseId: basename(output), kind: "FRESH_DIAGNOSTIC", continuationOf: null,
  predecessorForComparisonOnly: "w4-native-owner-005", structuralCaseCountCredit: 0,
  declaredAt: startedAt, originalLimits: NATIVE_GROWTH_LIMITS, credentialsRecorded: false,
  limitation: "Fresh diagnostic with genuine-current-authority fixture binding. No resurrection, field, causal, economic or profit qualification." });
await artifact("original-boundary.json", { frozenAt: startedAt, maximumMilliseconds: NATIVE_GROWTH_LIMITS.maximumMilliseconds,
  originalQuantity: 1, originalUnitPriceMinor: "1", currency: "USD", expectedRecognizedMinor: "1",
  expectedCollectedMinor: "1", expectedFieldValidated: false, expectedProfitQualified: false,
  required: ["actual HTTP bearer auth", "same original Work", "real restricted production worker claims",
    "canonical S5 compute/native occupation", "signed original S2 proposal", "real S6 conditional PATCH+GET",
    "independent accountant original", "immutable checked artifact", "real S7 measurement and compute records"],
  remainingGates: ["16 structural families by 8 fresh cases", "mounted browser", "separate installation", "external field W039"] });
const recovery = resolve(repo, "..");
Object.assign(process.env, { NODE_ENV: "test", CI: "1", LOG_LEVEL: "error", AUTH_DEV_BYPASS: "0",
  FINNOR_ENVIRONMENT: "staging", FINNOR_W4_PROFILE: "ordinary_disposable", FINNOR_P4_PROFILE: "ordinary_disposable",
  FINNOR_TEST_MANAGED_EXTENSIONS: "omit", RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
  FINNOR_S3_PYTHON: process.env.FINNOR_S3_PYTHON ?? join(recovery, "runtimes/w3-s3/bin/python"),
  FINNOR_S3_PROCESS_DIAGNOSTICS: "1",
  FINNOR_S5_PYTHON: process.env.FINNOR_S5_PYTHON ?? join(recovery, "runtimes/w3-s5/bin/python"),
  FINNOR_S3_MODEL_STORE: join(output, "ordinary-models"), FINNOR_S4_POLICY_STORE: join(output, "ordinary-policies"),
  WORKER_JOB_LEASE_SECONDS: "10", FINNOR_STEP_LEASE_SECONDS: "10" });
delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG; delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
delete process.env.FINNOR_W4_CONTROLLED_NOW;
const port = await new Promise<number>((yes, no) => { const s = createServer(); s.once("error", no);
  s.listen(0, "127.0.0.1", () => { const value = (s.address() as { port: number }).port; s.close(() => yes(value)) }) });
const pgDirectory = join(output, "disposable-postgres"), adminPassword = randomUUID(), appPassword = randomUUID(), workerPassword = randomUUID();
let postgresStartLog = "";
const postgres = new EmbeddedPostgres({ databaseDir: pgDirectory, user: "w4_admin", password: adminPassword,
  port, persistent: false, postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="],
  onLog: line => { postgresStartLog = (postgresStartLog + line).slice(-8192); } });
let admin: pg.Client | null = null, auth: Awaited<ReturnType<typeof authenticatedApiFixture>> | null = null;
let recipient: Awaited<ReturnType<typeof growthRecipient>> | null = null, activeWorker: ChildProcess | null = null;
let closePool: (() => Promise<void>) | undefined, result: unknown, failure: unknown;
let diagnosticTenant: string | null = null;
const numericalDiagnostics = captureNumericalProcesses(output);
s1FailureChannel.subscribe(observeS1Failure);
try {
  await postgres.initialise(); await appendFile(join(pgDirectory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  try { await postgres.start(); }
  catch (error) {
    await privateDiagnostic("postgres-start.json", { tail: postgresStartLog });
    throw Error("W4_DISPOSABLE_POSTGRES_START_FAILED", { cause: error });
  }
  await postgres.createDatabase("w4_growth");
  const { migrate } = await import("../../packages/db/migrate");
  const migrations = await migrate(`postgres://w4_admin:${adminPassword}@127.0.0.1:${port}/w4_growth`);
  assert(migrations.includes("0200_postz_w4_demand_to_business.sql"));
  assert(migrations.includes("postz_w2_zz_participant_legacy_authority.sql"));
  await artifact("actual-migrations-applied.json", { migrations, production: false });
  admin = new pg.Client({ connectionString: `postgres://w4_admin:${adminPassword}@127.0.0.1:${port}/w4_growth` });
  await admin.connect(); await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD '" + appPassword + "'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD '" + workerPassword + "'");
  const workerDatabaseUrl = `postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/w4_growth`;
  process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${port}/w4_growth`;
  const db = await import("@finnor/db"); closePool = db.closePool;
  const tenant = randomUUID(), owner = randomUUID(), companyId = randomUUID(), operator = randomUUID(), buyer = randomUUID();
  diagnosticTenant = tenant;
  const observer = randomUUID(), accountant = randomUUID(), unrelated = randomUUID(), foreign = randomUUID(), foreignTenant = randomUUID();
  const actors = [owner, operator, buyer, observer, accountant, unrelated, foreign];
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'W4 synthetic controlled business'),($3,$4,'W4 foreign')",
    [tenant, randomUUID(), foreignTenant, randomUUID()]);
  for (const actor of actors) await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status)
   VALUES($1,$2,$3,$4,'active')`, [actor, actor === foreign ? foreignTenant : tenant, actor + "@test.invalid",
    [operator, buyer, observer, accountant].includes(actor) ? "participant" : "owner"]);
  const participantGrants = (await admin.query(`SELECT count(*)::int n FROM finnor_os.employee_role_assignments
   WHERE tenant_id=$1 AND employee_id=ANY($2::uuid[]) AND active`, [tenant, [operator, buyer, observer, accountant]])).rows[0];
  assert.equal(participantGrants.n, 0, "W4_PURPOSE_PARTICIPANTS_HAVE_NO_EMPLOYEE_AUTHORITY");
  const canonicalParticipants = (await admin.query(`SELECT id,role,status FROM finnor_os.users
    WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [tenant, [operator, buyer, observer, accountant]])).rows;
  assert.equal(canonicalParticipants.length, 4);
  assert(canonicalParticipants.every(p => p.role === "participant" && p.status === "active"),
    "W4_INDEPENDENT_PARTICIPANTS_ARE_NOT_TENANT_OWNERS");
  await artifact("canonical-participant-authority.json", { employeeGrants: participantGrants.n, users: canonicalParticipants });
  await db.configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0,
    createdBy: owner, sourceSystem: "w4:controlled-original" });
  await admin.query(`INSERT INTO finnor_os.external_organizations(tenant_id,id,organization_key,name,kind)
   VALUES($1,$2,$3,'W4 unseen controlled company','other')`, [tenant, companyId, "w4-original-" + randomUUID()]);
  auth = await authenticatedApiFixture(repo, owner, row => traffic.push(row), { additionalActors: actors.slice(1), maximumActors: 8 });
  assert.equal(auth.compiledPid, undefined, "W4_DIAGNOSTIC_REQUIRES_IN_PROCESS_SOURCE_API");
  await privateDiagnostic("api-hosting.json", { schema: "finnor.w4.api-hosting-observation.v1",
    observerPid: process.pid, compiledApiPid: auth.compiledPid ?? null,
    requiredHostingProfile: "DIRECT_SOURCE_ROUTE_HANDLERS_NO_INSTALLATION",
    actualS1PublisherPid: "UNKNOWN_UNTIL_MATCHING_PUBLICATION", sameProcessEqualityEstablished: false });
  const tokens = new Map<string, string>([[owner, auth.token]]);
  for (const identity of auth.additionalIdentities) {
    const response: Response = await fetch(auth.authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: identity.email, password: identity.password }),
      signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); tokens.set(identity.actor, (await response.json()).access_token);
  }
  const http = async (group: string, operation: string, body: unknown, actor: string = owner) => {
    checkBound();
    const wireBody = JSON.stringify(body), isFit = group === "interventions" && operation === "fit";
    if (group === "demand-to-business" && operation === "intake") {
      assert(originalIntakeWireBody === null && typeof wireBody === "string", "W4_ONE_ORIGINAL_INTAKE_REQUEST");
      originalIntakeWireBody = wireBody;
    }
    if (isFit) {
      assert(typeof wireBody === "string" && Buffer.byteLength(wireBody, "utf8") <= 2 * 1024 ** 2, "W4_ORIGINAL_FIT_BODY_BOUND");
      assert(fitCaptures < 3, "W4_ORIGINAL_FIT_CAPTURE_BOUND");
      const number = fitCaptures + 1;
      await privateDiagnostic("fit-" + String(number).padStart(3, "0") + "-request.json", {
        schema: "finnor.w4.actual-pre-dispatch-fit.v1", caseId: basename(output), number,
        capturedAt: new Date().toISOString(), path: "/api/interventions/fit", actor,
        actualWireBodyUtf8: wireBody, wireBodyBytes: Buffer.byteLength(wireBody, "utf8"),
        wireBodySha256: createHash("sha256").update(wireBody, "utf8").digest("hex"),
        originalFacts: fitOriginals ?? { status: "UNKNOWN", reason: "NO_PRE_FIT_ORIGINALS_OBSERVATION" },
        originalWorkIntakeRequest: originalIntakeWireBody === null ? { status: "UNKNOWN" } : {
          status: "ACTUAL_PREPARED_INTAKE_REQUEST", wireBodyUtf8: originalIntakeWireBody,
          wireBodySha256: createHash("sha256").update(originalIntakeWireBody, "utf8").digest("hex") },
        headersRecorded: false, credentialsRecorded: false, resultKnownAtCapture: false,
      });
      fitCaptures = number;
      assert(recipient, "W4_CANONICAL_OWNER_AUTHORITY_BINDING_REQUIRED");
      await recipient.assertCurrentOwnerAuthority();
      checkBound(); activeFitWindow = number;
    }
    let pendingProbe: Promise<void> | null = null;
    const requestCpu = process.cpuUsage(), requestStarted = performance.now();
    const handoffProbe = group === "policies" && operation === "handoff" ? setTimeout(() => {
      pendingProbe = (async () => {
        const activity = await admin!.query(`SELECT pid,application_name,state,wait_event_type,wait_event,
          pg_blocking_pids(pid) blockers,left(query,1400) query,
          extract(epoch FROM clock_timestamp()-query_start) query_seconds
          FROM pg_stat_activity WHERE datname=current_database() ORDER BY pid LIMIT 128`);
        await privateDiagnostic("handoff-wait-" + String(Math.floor(requestStarted)) + ".json", {
          schema: "finnor.w4.pending-handoff-observation.v1", observedAt: new Date().toISOString(),
          elapsedMs: performance.now() - requestStarted, processCpu: process.cpuUsage(requestCpu),
          processRssBytes: process.memoryUsage().rss, activity: activity.rows, authorityGranted: false });
      })().catch(async error => {
        await privateDiagnostic("handoff-wait-unavailable-" + String(Math.floor(requestStarted)) + ".json", {
          errorType: error instanceof Error ? error.name : "Error" });
      });
    }, 15000) : null;
    try {
      const response = await fetch(auth!.origin + "/api/" + group + "/" + operation, { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + tokens.get(actor) },
        body: wireBody, signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() as any };
    } finally {
      if (handoffProbe) clearTimeout(handoffProbe);
      if (pendingProbe) await pendingProbe;
      if (isFit) activeFitWindow = null;
    }
  };
  const ok = async (group: string, operation: string, body: unknown, actor: string = owner) => {
    const answer = await http(group, operation, body, actor); assert.equal(answer.status, 200, JSON.stringify({ group, operation, ...answer }));
    return answer.body;
  };
  const work = await ok("demand-to-business", "intake", { companyId, idempotencyKey: "w4-original-occupation",
    instruction: "Run one bounded adjacent software business test. Preserve original Work, actual controlled commitments, support duties, costs and failures. No genuine market or profit qualification." });
  assert(work.workId && work.workInputId);
  const { employeeAuthoritySnapshot } = await import("@finnor/authority");
  recipient = await growthRecipient({ directory: join(output, "native-recipient"), tenantId: tenant, principalId: owner,
    companyId, accountIds: [operator], rightsRef: "s5-owner-rights",
    readCanonicalOwnerView: async () => {
      assert(process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG === undefined && process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT === undefined,
        "W4_INITIAL_RECIPIENT_CONFIGURATION_MUST_NOT_EXIST");
      return ok("company-brain", "belief-view", { root: { entityType: "external_organization", entityId: companyId } });
    },
    readCurrentOwnerAuthority: async () => {
      checkBound();
      const current = await employeeAuthoritySnapshot({ tenantId: tenant, userId: owner, employeeId: owner, role: "owner" });
      checkBound(); return { employeeId: current.employeeId, revision: current.revision };
    },
    ownerCall: (op, body) => http("obligations", op, body), artifact });
  const tick = async (maximum: number) => {
    checkBound(); const count = Math.min(16, maximum);
    const p = spawn(process.execPath, ["--max-old-space-size=1536", "--import=tsx", "scripts/w4/worker.mts", String(count)], {
      cwd: workspace, env: { ...process.env, DATABASE_URL: workerDatabaseUrl }, stdio: ["ignore", "pipe", "pipe"] });
    activeWorker = p; let log = "";
    p.stdout!.on("data", b => { log += b; if (log.length > 4 * 1024 * 1024) p.kill("SIGKILL") });
    p.stderr!.on("data", b => { log += b; if (log.length > 4 * 1024 * 1024) p.kill("SIGKILL") });
    const physical = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
      const timer = setTimeout(() => p.kill("SIGKILL"), 60000);
      p.once("error", e => { clearTimeout(timer); no(e) });
      p.once("close", (code, signal) => { clearTimeout(timer); yes({ code, signal }) });
    });
    activeWorker = null;
    const observations = log.split("\n").filter(l => l.startsWith('{"schema":"finnor.w4.worker-observation.v1",')).map(l => JSON.parse(l));
    const row = { pid: p.pid, ...physical, observations, log };
    workers.push(row); await artifact("workers/" + workers.length + ".json", row);
    assert.equal(physical.code, 0, log); assert.equal(physical.signal, null, log);
    assert(observations.length >= 1 && observations.length <= count, "W4_ACTUAL_WORKER_OBSERVATIONS_REQUIRED");
    for (const observed of observations) {
      assert.equal(observed.pid, p.pid); assert.equal(observed.role.current_user, "finnor_worker");
      assert.equal(observed.role.rolsuper, false); assert.equal(observed.role.rolbypassrls, false);
      assert.equal(observed.registration, "ACTUAL_PRODUCTION_CREATE_WORKER");
    }
    return observations.length;
  };
  const pump = async (maximum: number = NATIVE_GROWTH_LIMITS.maximumPumpTicks) => {
    assert(maximum >= 1 && maximum <= NATIVE_GROWTH_LIMITS.maximumPumpTicks);
    for (let n = 0;;) {
      checkBound();
      const pending = (await admin!.query(`SELECT count(*)::int n,min(run_at) due FROM finnor_os.jobs
       WHERE tenant_id=$1 AND status='queued' AND type IN
        ('compile_market_operating_program_v1','advance_market_operating_program_v1','run_workflow_step_v3')`, [tenant])).rows[0];
      if (!pending.n) return;
      assert(n < maximum, "W4_ORIGINAL_QUEUE_PUMP_BOUND");
      const delay = Math.max(0, new Date(pending.due).getTime() - Date.now());
      assert(delay <= 30000, "W4_CONTINUATION_ORIGINAL_TIME_BOUND");
      if (delay) await new Promise(yes => setTimeout(yes, delay + 25));
      n += await tick(maximum - n);
    }
  };
  // Only the S5 resource/clearing helpers are reused here. The W4 journey
  // produces its own logged, independently checked commercial measurements.
  const day = 86400000, begin = new Date(Date.now() - 128 * day).toISOString(), fixtures: Record<string, any> = {};
  const native = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: [],
    begin, day, fixtures, artifact, api: (_f: any, op: string, body: unknown, handler = allocationPost) =>
      http(handler === policyPost ? "policies" : handler === obligationPost ? "obligations"
        : handler === allocationPost ? "allocations" : "interventions", op, body) });
  const journey = createNativeGrowthJourney({ tenant, owner, companyId, work, actors: { operator, buyer, observer, accountant, unrelated, foreign },
    native, http, ok, admin, recipient, pump, artifact, checkBound, observeNativeFitOriginals: async originals => {
      assert(originalObservations < 3, "W4_ORIGINAL_FACTS_OBSERVATION_BOUND");
      originalObservations++;
      fitOriginals = structuredClone(originals);
      await privateDiagnostic("pre-fit-originals-" + String(originalObservations).padStart(3, "0") + ".json",
        { capturedAt: new Date().toISOString(), originals: fitOriginals });
    } });
  result = await journey.run();
  const canary = await ok("demand-to-business", "source", { workId: work.workId,
    purpose: journey.originalInput.permittedPurpose, protocolId: journey.evidenceProtocols.accountant,
    idempotencyKey: "w4-negative-wrong-buyer-invoice:" + work.workId,
    body: { schema: "finnor.growth-evidence.v1", scope: journey.scope, kind: "INVOICE",
      subjectId: "wrong-buyer-synthetic-negative-original", validFrom: new Date().toISOString(),
      validUntil: journey.originalInput.originalDeadlineAt, basis: [], nativeRefs: [],
      data: { buyerId: unrelated, offerId: journey.program.offers[0]!.id,
        termsDigest: journey.program.offers[0]!.termsDigest, amount: { currency: "USD", minor: "1" } },
      limitations: ["Explicit synthetic wrong-buyer privacy control, not an actual buyer B obligation, cash or revenue record."] },
  }, accountant);
  const participantReads: unknown[] = [], privateDenials: unknown[] = [];
  let buyerProtocolId = "";
  for (const actor of [buyer, operator, accountant, observer]) {
    const inbox = await ok("demand-to-business", "inbox", {}, actor);
    assert.equal(inbox.scope.principalId, actor); assert.equal(inbox.complete, true);
    const protocol = inbox.protocols.find((p: any) => p.requestId === journey.requestId && p.status === "CONSENTED");
    assert(protocol, "W4_ACTUAL_CURRENT_PARTICIPANT_PROTOCOL_REQUIRED");
    const progress = await ok("demand-to-business", "protocol-progress", { protocolId: protocol.id }, actor);
    assert.equal(progress.participantId, actor); assert.equal(progress.protocolId, protocol.id);
    assert.deepEqual(progress.scope, journey.scope); assert.equal(progress.complete, true);
    assert.equal(progress.physicalTruthEstablished, false); assert.equal(progress.fieldValidated, false);
    assert(!progress.evidence.some((e: any) => e.source.sourceId === canary.source.sourceId),
      "W4_OWN_SOURCE_AUTHORSHIP_IS_NOT_ANOTHER_BUYER_PROTOCOL");
    if (actor === accountant) {
      assert(progress.evidence.some((e: any) => e.kind === "INVOICE" && e.data.buyerId === buyer
        && e.data.offerId === journey.program.offers[0]!.id), "W4_ACTUAL_ASSIGNED_INVOICE_MUST_REMAIN_VISIBLE");
      assert(progress.evidence.some((e: any) => e.kind === "ACCOUNTING" && e.data.buyerId === buyer),
        "W4_ACTUAL_ASSIGNED_ACCOUNTING_MUST_REMAIN_VISIBLE");
    }
    assert(!JSON.stringify(progress).includes('"authorization"')); assert(!JSON.stringify(progress).includes('"signature"'));
    if (actor === observer) assert(progress.events.every((e: any) => ["TEST_CLOSED", "MARKET_CHANGE"].includes(e.body.kind)));
    if (actor === operator) assert(progress.events.every((e: any) =>
      ["RESPONSE", "DELIVERY", "DELIVERY_ACCEPTANCE", "SUPPORT"].includes(e.body.kind)));
    if (actor === buyer) buyerProtocolId = protocol.id;
    participantReads.push({ actor, role: protocol.role, progress });
    const denied = await http("demand-to-business", "read", { workId: work.workId }, actor);
    assert.equal(denied.status, 404, "W4_PARTICIPANT_MUST_NOT_GAIN_WORK_ACCESS");
    assert(!("requests" in denied.body) && !("scope" in denied.body));
    privateDenials.push({ operation: "read", actor, status: denied.status, code: denied.body.code });
  }
  assert(buyerProtocolId);
  for (const actor of [owner, unrelated, foreign]) {
    const denied = await http("demand-to-business", "protocol-progress", { protocolId: buyerProtocolId }, actor);
    assert.equal(denied.status, 404, "W4_DIFFERENT_ACTOR_PROTOCOL_PROGRESS_UNAVAILABLE");
    assert(!("events" in denied.body) && !("scope" in denied.body));
    privateDenials.push({ operation: "protocol-progress", actor, status: denied.status, code: denied.body.code });
  }
  await artifact("actual-purpose-bound-participant-reads.json", { participantReads, privateDenials, excludedWrongBuyerSource: canary.source,
    ownerWorkAccessGranted: false, production: false, fieldValidated: false });
  const after = (await admin.query("SELECT count(*)::int n FROM finnor_os.works WHERE tenant_id=$1", [tenant])).rows[0];
  const measurements = (await admin.query(`SELECT kind,count(*)::int n FROM finnor_os.s7_economic_records
   WHERE tenant_id=$1 GROUP BY kind`, [tenant])).rows;
  const physical = (await admin.query(`SELECT j.id,j.type,j.status,a.id attempt,a.claim_fence,a.finished_at
   FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
   WHERE j.tenant_id=$1 AND j.type IN('compile_market_operating_program_v1','advance_market_operating_program_v1')
   ORDER BY a.started_at`, [tenant])).rows;
  assert.equal(after.n, 1); assert(physical.length >= 2);
  await recipient.reloadRecords();
  const original = recipient.snapshot(), restart = await recipient.restart();
  assert.notEqual(restart.previousPid, restart.currentPid); assert.equal(restart.signal, "SIGKILL");
  assert.deepEqual(recipient.snapshot().records, original.records);
  const readback = await journey.read(); assert.equal(readback.request.nativeEffects.every((e: any) => e.state === "VERIFIED"), true);
  numericalDiagnostics.assertComplete();
  await artifact("native-owner-evidence.json", { status: "PASS_NATIVE_SMOKE", startedAt, generatedAt: new Date().toISOString(),
    result, migrations, measurements, physical, restart, workCount: after.n, actualRecipientRequests: recipient.requests,
    elapsedMs: performance.now() - started, dependencySource: "EXISTING_LOCAL_DEVELOPMENT_DEPENDENCIES_NOT_RECONSTRUCTION_EVIDENCE",
    remainingGates: ["16x8 fresh structural matrix", "mounted browser", "separate installation", "W039 external field gate"] });
  console.log(JSON.stringify({ status: "PASS_NATIVE_SMOKE", evidence: join(output, "native-owner-evidence.json") }));
} catch (error) {
  failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  await artifact("first-failure.json", { startedAt, failedAt: new Date().toISOString(), failure, elapsedMs: performance.now() - started,
    nativeSmokePassed: false, fieldValidated: false }); throw error;
} finally {
  numericalDiagnostics.close();
  s1FailureChannel.unsubscribe(observeS1Failure);
  let diagnosticFlushFailed = false;
  try { await privateDiagnostic("numerical-processes.json", numericalDiagnostics.summary()) }
  catch { diagnosticFlushFailed = true }
  try {
    await privateDiagnostic("s1-failures.json", { schema: "finnor.w4.private-s1-failure-observations.v1",
      caseId: basename(output), observerPid: process.pid, observations: s1Failures,
      dropped: s1Dropped, invalid: s1Invalid, foreignPid: s1ForeignPid,
      complete: s1Failures.some(row => row.activeFitWindow !== null)
        && s1Dropped === 0 && s1Invalid === 0 && s1ForeignPid === 0,
      publisherCoverage: s1Failures.length ? "OBSERVED_ONLY_FOR_RECORDED_IN_PROCESS_FAILURES" : "UNKNOWN",
      fitRequestsCaptured: fitCaptures,
      qualificationCredit: false, limitation: "In-process failure observations; activeFitWindow is a time window, not a causal identifier." });
  } catch { diagnosticFlushFailed = true }
  if (admin && diagnosticTenant) {
    try {
      await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await admin.query("SET LOCAL statement_timeout='4000ms'");
      const observations: Record<string, unknown> = {};
      for (const [name, sql] of Object.entries({
        experience: "SELECT event_id,body,recorded_at FROM finnor_os.s5_experience WHERE tenant_id=$1 ORDER BY recorded_at,event_id LIMIT 256",
        proposals: "SELECT content_digest,problem,certificate FROM finnor_os.s5_proposals WHERE tenant_id=$1 ORDER BY created_at,content_digest LIMIT 16",
        reservations: "SELECT reservation_id,allocation_digest,revision,status,envelopes,revocation_reason FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id LIMIT 64",
        consumptions: "SELECT consumption_id,reservation_id,policy_id,node_id,body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 ORDER BY consumption_id LIMIT 64",
      })) observations[name] = (await admin.query(sql, [diagnosticTenant])).rows;
      await admin.query("ROLLBACK");
      assert(Buffer.byteLength(JSON.stringify(observations)) <= 32 * 1024 ** 2, "W4_S5_DIAGNOSTIC_BYTE_BOUND");
      await privateDiagnostic("s5-owner-readback.json", { schema: "finnor.w4.private-s5-owner-readback.v1",
        tenantId: diagnosticTenant, observations, qualificationCredit: false });
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      await privateDiagnostic("s5-owner-readback-unavailable.json", {
        errorType: error instanceof Error ? error.name : "Error", code: (error as { code?: string }).code ?? null });
      diagnosticFlushFailed = true;
    }
  }
  const cleanupWorker = activeWorker as ChildProcess | null;
  if (cleanupWorker && cleanupWorker.exitCode === null && cleanupWorker.signalCode === null) {
    const p = cleanupWorker; await new Promise<void>(yes => { p.once("close", () => yes()); p.kill("SIGKILL") });
  }
  await artifact("http-and-physical-trace.json", { traffic, workers, outcomeEstablished: !!result && !failure, fieldValidated: false });
  if (recipient) await recipient.close();
  if (auth) await auth.close();
  if (closePool) await closePool();
  if (admin) await admin.end();
  await postgres.stop();
  if (diagnosticFlushFailed && !failure) throw Error("W4_PRIVATE_DIAGNOSTIC_FLUSH_FAILED");
}
