/** Strongest-boundary development driver. Expected business truth belongs to
 * the separately frozen portal evaluator, never to the candidate's model. */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import {
  closePool, configureTenantVertical, receiveWork, attachWorkEntity,
  acquireComputeResourceLeases, releaseComputeResourceLeases, withTenantTransaction,
} from "@finnor/db";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { installedHttpFixture } from "./installed-http-fixture.mts";
import { inspectInstalledRuntime } from "./installed-runtime-custody.mts";
import { runMountedNativeIntegration } from "./mounted-native-integration.mts";
import { startAuthenticatedHttpFixture, type AuthenticatedHttpFixture, type AuthSessionHandle } from "./authenticated-http-fixture.mts";
import { configure, initialize, releaseHeldOut } from "./fixtures/admin.mjs";
import { snapshot } from "./fixtures/store.mjs";
import { bootstrapNativeS8Fixture, NATIVE_S8_FIXTURE_FLAGS, type NativeS8Fixture } from "./native-s8-fixture.mts";
import { inspectNativeDiscovery, nativeDiscoveryCaseCommitment } from "./inspect-native-discovery.mts";
import { NATIVE_REVIEW_CASES, nativeReadRelay, runNativeReviewGates } from "./native-review-gates.mts";
import { applicationArtifact, applicationSession, nativeApplicationProfile, retainApplicationArtifact,
  type ApplicationSessionRow } from "../../packages/private-equity/src/application-semantics/store";
import { x2Digest, x2Ref } from "../../packages/private-equity/src/application-semantics/contracts";
import { enqueueOwnerDeliveryInTransaction } from "../../packages/governed-execution/src/owner-delivery-store";
import type { ApplicationField, ApplicationTransitionEvidence, BeliefViewPin, ExperimentRef } from "@finnor/shared-types";
import type { ApplicationRequestRow } from "../../packages/private-equity/src/application-semantics/obligations";
import type { ApplicationCapabilityUseLease } from "../../packages/capability-evolution/src/application-port";
import type { PrivateApplicationBinding } from "../../packages/private-equity/src/application-semantics/ports";

const out = process.env.FINNOR_X2_EVIDENCE_DIR;
if (!out?.startsWith("/")) throw Error("NEW_ABSOLUTE_X2_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(out, { mode: 0o700 }); // Do not adopt or overwrite an earlier run.
const privateDir = join(out, "private");
await mkdir(privateDir, { mode: 0o700 });
const repo = resolve(import.meta.dirname, "../../..");
const installed = existsSync(join(repo, "../build-manifest.json"));
const nodeMode = installed ? "production" : "development";
const mounted = process.env.FINNOR_X2_TEST_MOUNTED === "1";
assert(!mounted || installed, "MOUNTED_PROOF_REQUIRES_EMITTED_INSTALLED_OWNERS");
const surface = process.env.FINNOR_X2_TEST_SURFACE ?? "api";
assert(["api", "ui", "hybrid"].includes(surface));
const configuredS8 = process.env.FINNOR_X2_TEST_S8 === "1";
const reviewGates = process.env.FINNOR_X2_TEST_REVIEW_GATES === "1";
assert(!reviewGates || surface === "api" && !configuredS8 && !mounted, "REVIEW_GATES_HAVE_THEIR_OWN_API_OWNER_CUT");
const computeContention = process.env.FINNOR_X2_TEST_COMPUTE_CONTENTION === "1";
const finalEgressRevocation = process.env.FINNOR_X2_TEST_FINAL_EGRESS_REVOCATION === "1";
const resourceBeliefChange = process.env.FINNOR_X2_TEST_RESOURCE_BELIEF_CHANGE === "1";
const referenceBacklog = process.env.FINNOR_X2_TEST_REFERENCE_BACKLOG === "1";
const terminalCancellation = process.env.FINNOR_X2_TEST_TERMINAL_CANCELLATION === "1";
const semanticDrift = process.env.FINNOR_X2_TEST_SEMANTIC_DRIFT === "1";
const renderingDrift = process.env.FINNOR_X2_TEST_RENDERING_DRIFT === "1";
const recoveryMode = process.env.FINNOR_X2_TEST_RECOVERY ?? "none";
assert(["none", "full", "opaque", "deadline", "cancel"].includes(recoveryMode));
assert(!(resourceBeliefChange && (configuredS8 || finalEgressRevocation)), "RESOURCE_BELIEF_VARIANT_HAS_ITS_OWN_NATIVE_OWNER_CUT");
assert(!referenceBacklog || configuredS8 && !finalEgressRevocation && !resourceBeliefChange, "REFERENCE_BACKLOG_REQUIRES_THE_CONFIGURED_POSITIVE");
assert(recoveryMode === "none" || !computeContention && !finalEgressRevocation && !resourceBeliefChange && !referenceBacklog,
  "PHYSICAL_RECOVERY_HAS_ITS_OWN_REGISTERED_FAULT_CUT");
assert(!["full", "opaque", "cancel"].includes(recoveryMode) || configuredS8, "ORIGINAL_S8_LEASE_RECOVERY_REQUIRES_CONFIGURED_OWNERS");
assert(recoveryMode !== "deadline" || !configuredS8, "EXPIRED_PARENT_CASE_RETAINS_CURRENT_APPLICATION_OBSERVATION_AUTHORITY");
assert(!terminalCancellation || recoveryMode === "none" && !computeContention && !finalEgressRevocation
  && !resourceBeliefChange && !referenceBacklog, "COMPLETED_HISTORY_REQUIRES_ITS_OWN_POSITIVE_CUT");
assert(!semanticDrift || recoveryMode === "none" && !computeContention && !finalEgressRevocation
  && !resourceBeliefChange && !referenceBacklog && !terminalCancellation,
  "SEMANTIC_DRIFT_REQUIRES_ITS_OWN_CURRENTNESS_CUT");
assert(!renderingDrift || surface !== "api" && !semanticDrift && recoveryMode === "none" && !computeContention
  && !finalEgressRevocation && !resourceBeliefChange && !referenceBacklog && !terminalCancellation,
  "RENDERING_RELOCATION_REQUIRES_ITS_OWN_UI_OR_HYBRID_CUT");
assert(!mounted || configuredS8 && recoveryMode === "none" && !semanticDrift && !renderingDrift && !computeContention
  && !finalEgressRevocation && !resourceBeliefChange && !referenceBacklog && !terminalCancellation,
  "MOUNTED_LIFECYCLE_OWNS_THE_CONFIGURED_POSITIVE_CUT");
assert(!reviewGates || recoveryMode === "none" && !semanticDrift && !renderingDrift && !computeContention
  && !finalEgressRevocation && !resourceBeliefChange && !referenceBacklog && !terminalCancellation,
  "REVIEW_GATES_REQUIRE_THEIR_OWN_OWNER_CUT");
const results: Array<Record<string, unknown>> = [];
const owned: ChildProcess[] = [];
const flushLogs: Array<() => Promise<void>> = [];
let logFailure: unknown;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const save = async (name: string, value: unknown) =>
  writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const record = async (id: string, work: () => Promise<unknown>) => {
  const startedAt = new Date().toISOString(), started = performance.now();
  try {
    const observed = await work();
    results.push({ id, status: "PASS", startedAt, wallMs: performance.now() - started, observed });
  }
  catch (error) {
    const e = error as Error & { code?: string; constraint?: string; cause?: { code?: string } };
    results.push({ id, status: "FAIL", startedAt, wallMs: performance.now() - started,
      predicate: e.message, code: e.code ?? e.cause?.code ?? null, constraint: e.constraint ?? null });
  }
  await save("results.json", { qualification: "ORDINARY_X2_DEVELOPMENT_NOT_PROTECTED", surface, results,
    billingUSD: null, humanWork: null, aggregateSimultaneousMemory: null });
  console.log(JSON.stringify({ id, status: results.at(-1)!.status }));
  return results.at(-1)!.status === "PASS";
};
const port = await new Promise<number>((yes, no) => {
  const server = createServer(); server.once("error", no);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); if (!address || typeof address === "string") return no(Error("OWNED_PORT_REQUIRED"));
    server.close(() => yes(address.port));
  });
});
const databasePassword = randomBytes(24).toString("hex");
const database = new EmbeddedPostgres({ databaseDir: join(privateDir, "db"), user: "x2_owner",
  password: databasePassword, port, persistent: true, onLog: () => undefined });
let admin: pg.Client | undefined, http: Awaited<ReturnType<typeof nativeHttpFixture>>
  | Awaited<ReturnType<typeof installedHttpFixture>> | undefined;
let identity: AuthenticatedHttpFixture | undefined;
let actorAccess: AuthSessionHandle | undefined, otherAccess: AuthSessionHandle | undefined;
let frontendOrigin = "";
let s8: NativeS8Fixture | undefined;
let readRelay: Awaited<ReturnType<typeof nativeReadRelay>> | undefined;
let driverFailed = false;
let beginningSource: Awaited<ReturnType<typeof import("../../packages/private-equity/src/application-semantics/store").applicationCodeIdentity>> | undefined;
let beginningDriver: Array<{ path: string; sha256: string }> | undefined;
let beginningOracle: Array<{ path: string; sha256: string }> | undefined;
let adminUrl = "", workerUrl = "", portalOrigin = "";
const tenant = randomUUID(), actor = randomUUID(), other = randomUUID(), company = randomUUID();
const root = { entityType: installed ? "pe_deal" as const : "external_organization" as const,
  entityId: installed ? randomUUID() : company };
const resourceSourceRoot = { entityType: "external_organization" as const, entityId: randomUUID() };
const ctx = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: "owner" as const },
  provenance: { sourceSystem: "FRONTIER5.X2:ordinary-development", createdBy: actor } };
const portalDir = join(privateDir, "portal");
const secretRoot = join(privateDir, "secrets");
const profiles: string[] = [];
let credentials: any, model: any, check: any, sessionId = "", deadlineAt = "";
let resourcePin: BeliefViewPin | null = null, resourceSource: ExperimentRef | null = null;
let sourceObservationId = "", sourceEvidence: { evidenceSourceId: string; evidenceVersionId: string } | null = null;
const backlogRefs: ExperimentRef[] = [];
async function portalHeaders(name: string, grantId: string): Promise<Record<string, string>> {
  if (surface === "api") return { authorization: "Bearer " + credentials.tokens[name], "x-portal-grant": grantId };
  const response = await fetch(portalOrigin + "/login", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ bearer: credentials.tokens[name], grantId }),
  });
  assert.equal(response.status, 303, "ORDINARY_PORTAL_SESSION_LOGIN_REQUIRED");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert(cookie && /^portal_session=[A-Za-z0-9_-]+$/.test(cookie), "ORDINARY_PRIVATE_SESSION_COOKIE_REQUIRED");
  // This public grant binding is compared privately; it does not override the
  // ordinary cookie session. A bearer header would take precedence and fail CSRF.
  return { cookie, "x-portal-grant": grantId };
}
const logChild = async (child: ChildProcess, name: string) => {
  owned.push(child);
  const path = join(privateDir, name);
  await writeFile(path, "", { mode: 0o600 });
  let pending = Promise.resolve();
  const append = (bytes: Buffer) => {
    pending = pending.then(() => appendFile(path, bytes)).catch(error => { logFailure ??= error; });
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  flushLogs.push(() => pending);
};
const driverIdentity = async () => Promise.all((await readdir(import.meta.dirname, { withFileTypes: true }))
  .filter(file => file.isFile() && /\.(mts|mjs|json)$/.test(file.name)).sort((a, b) => a.name.localeCompare(b.name))
  .map(async file => ({ path: "finnor-os/scripts/x2/" + file.name, sha256: sha(await readFile(join(import.meta.dirname, file.name))) })));
const oracleIdentity = async () => Promise.all((await readdir(join(import.meta.dirname, "fixtures")))
  .filter(name => /\.(mjs|json)$/.test(name)).sort()
  .map(async name => ({ path: "fixtures/" + name, sha256: sha(await readFile(join(import.meta.dirname, "fixtures", name))) })));
const createWork = async (instruction: string) => {
  const work = await receiveWork({ tenantId: tenant, userId: actor, instruction,
    channel: "console", idempotencyKey: "x2-e2e:" + randomUUID(), activeContext: root,
    authorityContext: { principalId: actor, producer: "X2_DISPOSABLE_OWNER" } });
  await attachWorkEntity(tenant, work.workId, { ...root, source: "FRONTIER5.X2:original-input" });
  return work.workId;
};
type WorkerSession = Pick<ApplicationSessionRow, "status" | "reason" | "generation" | "model_ref" | "check_ref" | "composition_ref">;
let workerOrdinal = 0;
const startWorker = async (id: string, mode?: "ONE_DELIVERY" | "RECOVER_ONLY", killed = false) => {
  const launch = ++workerOrdinal;
  const entry = installed ? join(repo, "finnor-os/x2-runtime/physical-worker.js") : join(import.meta.dirname, "physical-worker.mts");
  const arguments_ = [...(installed ? [] : ["--import=tsx"]), entry, tenant, actor, id, ...(mode ? [mode] : [])];
  const child = spawn(process.execPath, arguments_, { cwd: join(repo, "finnor-os"),
    env: { PATH: process.env.PATH, HOME: privateDir, LANG: "C", TZ: "UTC", NODE_ENV: nodeMode,
      DATABASE_URL: workerUrl, FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable",
      FINNOR_X2_DISPOSABLE_SECRET_ROOT: process.env.FINNOR_X2_DISPOSABLE_SECRET_ROOT,
      FINNOR_X2_SOURCE_ROOT: repo, FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
      ...(process.env.AGENT_BROWSER_CDP ? { AGENT_BROWSER_CDP: process.env.AGENT_BROWSER_CDP } : {}),
      ...s8?.environment() },
    stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); no(Error("OWNED_NATIVE_WORKER_DEADLINE")); }, 240000);
    child.once("error", (error) => { clearTimeout(timer); no(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); yes({ code, signal }); });
  });
  const completed = exit.then(async result => {
    const row = (await admin!.query<WorkerSession>("SELECT status,reason,generation,model_ref,check_ref,composition_ref FROM finnor_os.application_semantics_sessions WHERE id=$1", [id])).rows[0];
    assert(row, "NATIVE_CANONICAL_SESSION_MISSING_AFTER_DELIVERY");
    await save(`worker-${id}-${launch}.json`, { pid: child.pid, launch, mode: mode ?? "RUN",
      entry, argv: arguments_, nodeMode, execution: installed ? "EMITTED" : "SOURCE_TSX", exit: result, session: row,
      jobs: (await admin!.query("SELECT id,type,status,attempts,claim_fence,last_error,payload FROM finnor_os.jobs WHERE payload->>'sessionId'=$1 ORDER BY id", [id])).rows });
    if (killed) {
      assert.equal(result.signal, "SIGKILL", "ACTUAL_PHYSICAL_WORKER_SIGKILL_REQUIRED");
      assert.equal(result.code, null);
    } else assert.equal(result.code, 0, "ACTUAL_NATIVE_WORKER_EXIT_FAILED");
    return row;
  });
  void completed.catch(() => undefined);
  await logChild(child, `worker-${id}-${launch}.log`);
  return { child, completed };
};
const runWorker = async (id: string, oneDelivery = false) =>
  (await startWorker(id, oneDelivery ? "ONE_DELIVERY" : undefined)).completed;
try {
  process.env.FINNOR_ENVIRONMENT = "staging";
  process.env.FINNOR_X2_PROFILE = "ordinary_disposable";
  process.env.NODE_ENV = nodeMode;
  if (installed) assert.equal(process.env.AUTH_DEV_BYPASS, undefined, "INSTALLED_AUTH_BYPASS_MUST_BE_ABSENT");
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.FINNOR_X2_SOURCE_ROOT = repo;
  const { applicationCodeIdentity } = await import("../../packages/private-equity/src/application-semantics/store");
  const sourceCut = await applicationCodeIdentity();
  if (installed) await save("installed-beginning.json", await inspectInstalledRuntime(repo));
  beginningSource = sourceCut;
  beginningDriver = await driverIdentity();
  const oraclePins = await oracleIdentity();
  beginningOracle = oraclePins;
  await save("freeze.json", { startedAt: new Date().toISOString(), sourceCut, driverPins: beginningDriver,
    oraclePins, surface, configuredS8, reviewGates, computeContention, finalEgressRevocation, resourceBeliefChange, referenceBacklog,
    terminalCancellation, semanticDrift, renderingDrift, recoveryMode, installed, mounted, nodeMode,
    oracleCustody: "SEPARATE_DRIVER_PRIVATE_DIRECTORY_NOT_OS_SANDBOX", protectedAdmission: false });
  const migrated = await record("fresh-upgrade-replay-and-runtime-role-isolation", async () => {
    await database.initialise();
    await appendFile(join(privateDir, "db/postgresql.conf"),
      "\ntrack_commit_timestamp=on\nmax_wal_size='256MB'\nmin_wal_size='80MB'\ncheckpoint_timeout='30s'\n");
    await database.start(); await database.createDatabase("x2_native");
    // The generated password is task-local, never retained in public evidence.
    adminUrl = `postgres://x2_owner:${databasePassword}@127.0.0.1:${port}/x2_native`;
    const files = await Promise.all((await readdir(join(repo, "finnor-os/packages/db/migrations")))
      .filter((name) => name.endsWith(".sql")).sort().map(async (name) => ({
        name, sql: await readFile(join(repo, "finnor-os/packages/db/migrations", name), "utf8"),
      })));
    const baseline = await migrate(adminUrl, files.filter((file) => file.name < "0191"));
    const upgrade = await migrate(adminUrl);
    assert.deepEqual(upgrade, ["0191_frontier5_x2_application_semantics.sql", "0192_frontier5_x2_request_custody.sql",
      "0193_frontier5_x2_authority_custody.sql"]);
    assert.deepEqual(await migrate(adminUrl), []);
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    const appPassword = randomBytes(24).toString("hex"), workerPassword = randomBytes(24).toString("hex");
    await admin.query(`ALTER ROLE finnor_app LOGIN PASSWORD '${appPassword}'`);
    await admin.query(`ALTER ROLE finnor_worker LOGIN PASSWORD '${workerPassword}'`);
    process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${port}/x2_native`;
    workerUrl = `postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/x2_native`;
    await closePool();
    const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('finnor_app','finnor_worker') ORDER BY rolname")).rows;
    assert(roles.every((row) => !row.rolsuper && !row.rolbypassrls));
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL }); await app.connect();
    try {
      assert.equal((await app.query("SELECT * FROM finnor_os.jobs")).rowCount, 0);
      assert.equal((await app.query("SELECT * FROM finnor_os.application_semantics_artifacts")).rowCount, 0);
    } finally { await app.end(); }
    return { baseline, upgrade, replay: "NO_PENDING_MIGRATIONS", roles,
      schema: (await admin.query("SELECT tablename,policyname FROM pg_policies WHERE tablename LIKE 'application_%' ORDER BY tablename,policyname")).rows };
  });
  if (!migrated) throw Error("NATIVE_MIGRATION_PREREQUISITE_FAILED");
  await admin!.query("SET app.test_vertical_mode='explicit'");
  await admin!.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X2 disposable native')", [tenant, randomUUID()]);
  await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active'),($4,$2,$5,'owner','active')",
    [actor, tenant, actor + "@test.invalid", other, other + "@test.invalid"]);
  await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x2-native-company','X2 development company','other')", [company, tenant]);
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: actor,
    sourceSystem: "FRONTIER5.X2:ordinary-development" });
  await mkdir(secretRoot, { mode: 0o700 }); await mkdir(join(secretRoot, tenant), { mode: 0o700 });
  process.env.FINNOR_X2_DISPOSABLE_SECRET_ROOT = secretRoot;
  if (installed) {
    const { createDeal } = await import("../../packages/private-equity/src/repository");
    const deal = await createDeal(ctx, { id: root.entityId, targetOrganizationId: company,
      name: "X2 disposable installed Deal", dealLeadEmployeeId: actor, signedLoiAt: new Date(),
      targetClosingAt: new Date(Date.now() + 86400000) });
    assert.equal(deal.row.id, root.entityId);
    await save("installed-deal-root.json", { root, deal: deal.row });
    const frontendPort = await new Promise<number>((yes, no) => {
      const server = createServer(); server.once("error", no);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return no(Error("OWNED_FRONTEND_PORT_REQUIRED"));
        server.close(() => yes(address.port));
      });
    });
    frontendOrigin = "http://127.0.0.1:" + frontendPort;
    identity = await startAuthenticatedHttpFixture({ frontendOrigin, identities: [
      { userId: actor, email: actor + "@test.invalid", password: randomBytes(24).toString("hex") },
      { userId: other, email: other + "@test.invalid", password: randomBytes(24).toString("hex") },
    ] });
    actorAccess = await identity.private.passwordSignIn(actor); otherAccess = await identity.private.passwordSignIn(other);
    const installedApi = await installedHttpFixture({ runtimeRoot: repo, privateDir: join(privateDir, "installed-api"),
      tenantId: tenant, actorId: actor, databaseUrl: process.env.DATABASE_URL!, disposableSecretRoot: secretRoot,
      ownerEnvironment: () => s8?.environment() ?? {},
      auth: { origin: identity.origin, serviceRoleKey: identity.publicAnonKey, observations: () => identity!.observations(),
        token: async principal => {
          let current = principal === "actor" ? actorAccess! : otherAccess!;
          if (current.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
            current = await identity!.private.refresh(current);
            if (principal === "actor") actorAccess = current; else otherAccess = current;
          }
          return identity!.private.accessToken(current);
        } },
    });
    http = installedApi;
    identity.private.allowApiOrigin(installedApi.origin);
    await save("installed-auth-runtime.json", { fixture: "SIGNED_DISPOSABLE_GOTRUE_COMPATIBLE_NOT_HOSTED_SUPABASE",
      authBypassPresent: false, authOrigin: identity.origin, apiOrigin: installedApi.origin, frontendOrigin,
      nodeMode, api: "ACTUAL_BUILT_NEXT_API", worker: "ACTUAL_EMITTED_REGISTRY" });
  } else http = await nativeHttpFixture(admin!, tenant, actor, other);
  await initialize(portalDir, surface);
  credentials = JSON.parse(await readFile(join(portalDir, "credentials.json"), "utf8"));
  const portal = spawn(process.execPath, [join(import.meta.dirname, "fixtures/server.mjs"), "--private-dir", portalDir, "--port", "0"],
    { env: { PATH: process.env.PATH, LANG: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] });
  await logChild(portal, "portal.log");
  portalOrigin = await new Promise<string>((yes, no) => {
    const timer = setTimeout(() => no(Error("OWNED_ORACLE_READINESS_TIMEOUT")), 10000);
    portal.once("error", (error) => { clearTimeout(timer); no(error); });
    portal.stdout!.once("data", (bytes) => { clearTimeout(timer); yes(JSON.parse(bytes.toString()).origin); });
  });
  assert(portalOrigin?.startsWith("http://127.0.0.1:"));
  if (reviewGates) { readRelay = await nativeReadRelay(portalOrigin); portalOrigin = readRelay.origin; }
  const initialState = (await snapshot(portalDir)).state;
  deadlineAt = new Date(Date.now() + (recoveryMode === "deadline" ? 300000 : 900000)).toISOString();
  assert(Date.parse(deadlineAt) < Date.parse(initialState.expiresAt));
  for (const [role, name, grantName] of [["editor", "editor", "discovery"], ["approver", "approver", "approval"]]) {
    const accountId = randomUUID(), profileId = randomUUID();
    const config = { sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", protectionDomain: "DISPOSABLE_TEST_AUTHORITY",
      origin: portalOrigin, application: credentials.applicationId, account: credentials.accounts.primary,
      actingPrincipal: credentials.principalIds[name!], role, validUntil: initialState.expiresAt,
      entrypoint: "/portal/records/{recordId}", documentationPaths: surface === "ui" ? [] : ["/openapi.json"],
      contextPath: surface === "ui" ? null : "/api/context",
      recordPathTemplate: surface === "ui" ? "/portal/records/{recordId}" : "/api/accounts/{accountId}/records/{recordId}",
      requestPathTemplate: surface === "ui" ? "/portal/requests/{requestId}" : "/api/requests/{requestId}",
      allowedTargets: [credentials.recordIds.discoveryOne, credentials.recordIds.discoveryTwo],
      allowedEntities: [credentials.entities.usd], discoverySurface: surface.toUpperCase() };
    await writeFile(join(secretRoot, tenant, name + ".json"), JSON.stringify({
      applicationHeaders: JSON.stringify(await portalHeaders(name!, credentials.grantIds[grantName!])),
    }), { mode: 0o600, flag: "wx" });
    await admin!.query("INSERT INTO finnor_os.application_accounts(id,tenant_id,account_key,application,provider,display_name,provider_account_ref,capabilities) VALUES($1,$2,$3,'x2_portal','x2_native','Disposable portal role',$4,'[\"application-operation-v1\"]')",
      [accountId, tenant, "x2-" + name, credentials.accounts.primary]);
    await admin!.query("INSERT INTO finnor_os.auth_profiles(id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,credential_provider,credential_ref,auth_method,connection_status,capabilities,restrictions) VALUES($1,$2,$3,'employee',$4,$5,'application_semantics','disposable-private-file',$6,'application_headers','active','[\"application-operation-v1\"]',$7::jsonb)",
      [profileId, tenant, "x2-" + name, actor, accountId, `finnor/tenants/${tenant}/x2/${name}`,
        JSON.stringify({ allowedActorIds: [actor], allowedPurposes: ["application_semantics"], applicationSemantics: config })]);
    profiles.push(profileId);
  }
  if (resourceBeliefChange) {
    const initialCut = await record("canonical-S5-resource-belief-initial-owner-cut", async () => {
      const memory = await import("@finnor/memory");
      const owners = await import("../../packages/private-equity/src/digital-twin");
      await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'x2-resource-owner','Disposable resource reporting owner','other')",
        [resourceSourceRoot.entityId, tenant]);
      const source = await memory.createEvidenceSource(tenant, {
        sourceKey: "x2-resource-source", sourceType: "manual", title: "Disposable owner resource report",
      });
      const version = await memory.appendEvidenceVersion(tenant, source.id, {
        content: "The disposable owner reports 2048 request units.", snapshot: { reportedRequestUnits: "2048" },
        asOf: new Date("2026-01-01T00:00:00Z"),
      });
      sourceEvidence = { evidenceSourceId: source.id, evidenceVersionId: version.versionId };
      const series = await owners.createMetricSeries(ctx, {
        subjectType: "external_organization", subjectId: resourceSourceRoot.entityId, metricKey: "disposable-request-capacity",
        name: "Disposable request capacity", unit: "request", frequency: "annual",
      });
      const observation = await owners.recordMetricObservation(ctx, {
        metricSeriesId: String(series.row.id), periodStart: new Date("2026-01-01T00:00:00Z"),
        periodEnd: new Date("2026-12-31T00:00:00Z"), value: { type: "number", value: "2048" }, evidence: sourceEvidence,
      });
      sourceObservationId = String(observation.row.id);
      const view = await http!.call("belief-view", { root: resourceSourceRoot });
      assert.equal(view.status, 200, JSON.stringify(view));
      assert.equal(view.body.coverage.canonicalStatus, "COMPLETE");
      resourcePin = view.body.pin;
      const pin = await http!.call("belief-pin", resourcePin);
      assert.equal(pin.status, 200); assert.equal(pin.body.status, "CURRENT", JSON.stringify(pin));
      resourceSource = { owner: "S1", id: view.body.id, version: "s1-belief-view-v1", contentDigest: view.body.contentDigest };
      await save("private/resource-belief-initial-cut.json", { view, pin, observation });
      return { pin: resourcePin, source: resourceSource, canonicalObservationId: sourceObservationId };
    });
    if (!initialCut) throw Error("NATIVE_RESOURCE_BELIEF_INITIAL_CUT_PREREQUISITE_FAILED");
  }
  const ownerRef = { owner: "BUSINESS_OWNER" as const, id: actor, version: "development-v1", contentDigest: sha(actor) };
  const resource = await putAllocationResource(ctx, {
    schema: "finnor.allocation-resource.v1", resourceId: "x2-requests", tenantId: tenant,
    ownerRef, legalEntityRef: { ...ownerRef, owner: "S1", id: company }, scopeRef: { ...ownerRef, id: company },
    permittedRoots: [root], rightsRef: "S1:employee:" + actor + ":revision:1", unit: "request", currency: null,
    kind: "CUMULATIVE_EXPENDITURE", resourceClass: "COMPUTE",
    horizon: { startAt: new Date().toISOString(), periodMs: 3600000, periods: 1 },
    sourceRef: resourceSource ?? ownerRef, asOf: new Date().toISOString(), knowledgeAt: new Date().toISOString(),
    validUntil: initialState.expiresAt, beliefPins: resourcePin ? [resourcePin] : [], availability: [
      { amount: reviewGates ? "8192" : "2048", basis: "REPORTED_AVAILABLE" },
      { amount: reviewGates ? "8192" : "2048", basis: "REPORTED_AVAILABLE" },
    ],
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED",
  }, null);
  const acquisitionWork = await createWork("Acquire bounded authorized application semantics from two disposable records, then independently check the model.");
  const request = { root, workId: acquisitionWork, profileIds: profiles,
    targets: [credentials.recordIds.discoveryOne, credentials.recordIds.discoveryTwo].map((id) => ({
      kind: "identity", application: credentials.applicationId, account: credentials.accounts.primary, entity: credentials.entities.usd, id,
    })), resourceDemand: [{ resourceId: resource.resourceId, unit: "request", amount: "2048" }],
    deadlineAt, idempotencyKey: "x2-acquire-" + randomUUID() };
  await record("canonical-S5-terminal-resource-floor", async () => {
    const terminalResource = await putAllocationResource(ctx, {
      schema: "finnor.allocation-resource.v1", resourceId: "x2-terminal-floor", tenantId: tenant,
      ownerRef, legalEntityRef: { ...ownerRef, owner: "S1", id: company }, scopeRef: { ...ownerRef, id: company },
      permittedRoots: [root], rightsRef: "S1:employee:" + actor + ":revision:1", unit: "request", currency: null,
      kind: "CUMULATIVE_EXPENDITURE", resourceClass: "COMPUTE",
      horizon: { startAt: new Date().toISOString(), periodMs: 3600000, periods: 1 },
      sourceRef: ownerRef, asOf: new Date().toISOString(), knowledgeAt: new Date().toISOString(),
      validUntil: initialState.expiresAt, beliefPins: [],
      availability: [{ amount: "2048", basis: "REPORTED_AVAILABLE" }, { amount: "0", basis: "REPORTED_AVAILABLE" }],
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
      qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED",
    }, null);
    const workId = await createWork("Refuse a request above its canonical terminal resource cap.");
    const response = await http!.call("application-acquire", { ...request, workId,
      resourceDemand: [{ resourceId: terminalResource.resourceId, unit: "request", amount: "2048" }],
      idempotencyKey: "x2-terminal-floor-" + randomUUID() });
    await save("terminal-floor-response.json", response);
    // A pre-fix accepted case is cancelled through its actual owner before any
    // worker can consume it. No raw deletion or candidate mutation is used.
    if (response.status === 202) assert.equal((await http!.call("application-cancel", { root, workId })).status, 200);
    assert.equal(response.status, 409, "CANONICAL_TERMINAL_CAP_MUST_REFUSE_ACQUISITION");
    assert.equal(response.body.code, "X2_S5_SHARED_RESOURCE_EXHAUSTED");
    return { response, owner: "S5", terminalAvailability: "0", mutations: 0 };
  });
  const accepted = await record("authenticated-original-registration-and-idempotency", async () => {
    if (resourcePin) {
      const pin = await http!.call("belief-pin", resourcePin);
      await save("private/resource-belief-before-registration.json", pin);
      assert.equal(pin.status, 200); assert.equal(pin.body.status, "CURRENT", JSON.stringify(pin));
    }
    for (const identity of ["anonymous", "invalid", "other"] as const) {
      const denied = await http!.call("application-acquire", request, identity);
      assert.equal(denied.status, identity === "other" ? 404 : 401, "EXACT_AUTHENTICATION_OR_PROFILE_DENIAL_REQUIRED");
      if (identity === "other") assert.equal(denied.body.code, "PERMITTED_CONTEXT_UNAVAILABLE");
    }
    assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os.application_semantics_sessions WHERE work_id=$1", [acquisitionWork])).rows[0].n, 0);
    const first = await http!.call("application-acquire", request);
    assert.equal(first.status, 202, JSON.stringify(first));
    const replay = await http!.call("application-acquire", request);
    assert.equal(replay.status, 202); assert.equal(replay.body.sessionId, first.body.sessionId);
    sessionId = first.body.sessionId;
    assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os.s5_reservations r"
      + " JOIN finnor_os.application_semantics_sessions s ON r.allocation_digest=s.allocation_ref->>'contentDigest'"
      + " WHERE s.id=$1", [sessionId])).rows[0].n, 1);
    return { first, replay, auth: http!.observed, originalDeadline: deadlineAt };
  });
  if (!accepted) throw Error("NATIVE_AUTHENTICATED_REGISTRATION_PREREQUISITE_FAILED");
  if (computeContention) {
    const deferred = await record("canonical-compute-contention-durable-pre-dispatch-deferral", async () => {
      const original = await applicationSession(ctx, sessionId);
      const blocker = await acquireComputeResourceLeases({
        resourceKeys: ["native:x2"], requiredResourceKeys: ["native:x2"],
        tenantId: tenant, workloadClass: "INTERACTIVE", ownerId: "x2-independent-capacity-blocker",
      });
      assert.equal(blocker.length, 1, "ACTUAL_NATIVE_X2_SLOT_NOT_HELD");
      try {
        const row = await runWorker(sessionId, true);
        const job = (await admin!.query("SELECT status,attempts,run_at,last_error,capacity_defer_count,capacity_defer_reason FROM finnor_os.jobs"
          + " WHERE payload->>'sessionId'=$1 ORDER BY id DESC LIMIT 1", [sessionId])).rows[0];
        const delivery = (await admin!.query("SELECT a.outcome,a.failure_kind,a.failure_detail FROM finnor_os.job_delivery_attempts a"
          + " JOIN finnor_os.jobs j ON j.id=a.job_id WHERE j.payload->>'sessionId'=$1 ORDER BY a.started_at DESC LIMIT 1", [sessionId])).rows[0];
        const retained = await applicationSession(ctx, sessionId);
        const requests = (await admin!.query("SELECT count(*)::int n FROM finnor_os.application_semantics_requests WHERE session_id=$1", [sessionId])).rows[0].n;
        await save("compute-deferral.json", { row, job, delivery, requests, originalParent: retained.original_parent_ref,
          originalDeadline: retained.parent.deadlineAt, resourceReservation: retained.reservation_ref });
        assert.equal(row.status, "QUEUED", "PRE_DISPATCH_COMPUTE_CONTENTION_BECAME_TERMINAL");
        assert.equal(job.status, "queued", "CAPACITY_WAIT_MUST_RETAIN_DURABLE_JOB");
        assert.equal(job.capacity_defer_count, 1, "ACTUAL_CAPACITY_DEFERRAL_REQUIRED");
        assert.equal(job.capacity_defer_reason, "native:x2");
        assert.equal(delivery?.outcome, "capacity_deferred", "ACTUAL_PRE_DISPATCH_DELIVERY_AUDIT_REQUIRED");
        assert.equal(requests, 0, "CAPACITY_CONTENTION_MUST_NOT_SUBMIT");
        assert.equal(x2Digest(retained.parent), x2Digest(original.parent));
        assert.equal(x2Digest(retained.reservation_ref), x2Digest(original.reservation_ref));
        assert(job.run_at.getTime() < Date.parse(deadlineAt), "DEFERRAL_MUST_REMAIN_INSIDE_ORIGINAL_DEADLINE");
        return { job, delivery, requests, unchangedParent: retained.original_parent_ref, originalDeadline: retained.parent.deadlineAt };
      } finally { await releaseComputeResourceLeases(blocker, "INDEPENDENT_CONTENTION_SCENARIO_FINISHED"); }
    });
    if (!deferred) throw Error("NATIVE_COMPUTE_DEFERRAL_PREREQUISITE_FAILED");
    const nextRun = (await admin!.query("SELECT run_at FROM finnor_os.jobs WHERE payload->>'sessionId'=$1 ORDER BY id DESC LIMIT 1", [sessionId])).rows[0].run_at;
    const wait = Math.max(0, nextRun.getTime() - Date.now());
    assert(wait <= 30000, "BOUNDED_CANONICAL_CAPACITY_DEFERRAL_REQUIRED");
    await new Promise(yes => setTimeout(yes, wait + 50));
  }
  const acquired = await record("physical-acquisition-and-independent-frozen-model", async () => {
    const row = await runWorker(sessionId);
    assert.equal(row.status, "MODEL_READY", JSON.stringify(row));
    const projected = await http!.call("application-projection", { root, workId: acquisitionWork });
    assert.equal(projected.status, 200, JSON.stringify(projected));
    model = projected.body.sessions[0].model; check = projected.body.sessions[0].check;
    assert.equal(check.disposition, "ACCEPTED_EVIDENCED_DOMAIN");
    assert.equal(check.falseValid, 0); assert.equal(check.falseInvalid, 0);
    assert.equal(check.counterexamples.length, 0); assert.equal(check.acceptedOperationIds.length, 4);
    assert.equal(model.operations.length, 4);
    const validity = (await admin!.query("SELECT operation_id,status FROM finnor_os.application_operation_validities WHERE model_id=$1 ORDER BY operation_id", [model.ref.id])).rows;
    assert.equal(validity.length, 4); assert(validity.every((value) => value.status === "CURRENT"));
    await save("private/acquired-model.json", { model, check, validity });
    await save("model-freeze.json", { modelRef: model.ref, checkRef: check.ref,
      frozenBeforeObjectiveRelease: true, frozenAt: new Date().toISOString(), originalDeadline: deadlineAt });
    return { modelRef: model.ref, checkRef: check.ref, operationIds: validity.map((value) => value.operation_id), validity,
      originalTransitions: (await admin!.query("SELECT count(*)::int n FROM finnor_os.application_semantics_events WHERE session_id=$1 AND kind='ORIGINAL_TRANSITION_EVIDENCE'", [sessionId])).rows[0].n };
  });
  if (!acquired) throw Error("NATIVE_ACQUISITION_PREREQUISITE_FAILED");
  await record("ordinary-role-original-request-deletion-refusal", async () => {
    const original = (await admin!.query("SELECT id FROM finnor_os.application_semantics_requests WHERE session_id=$1 AND possible_egress ORDER BY created_at LIMIT 1", [sessionId])).rows[0];
    assert(original, "ACTUAL_POSSIBLE_EGRESS_REQUEST_REQUIRED");
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    let denial: string | null = null, deleted = 0;
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenant, actor]);
      try {
        deleted = (await app.query("DELETE FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND id=$2 RETURNING id",
          [tenant, original.id])).rowCount ?? 0;
      } catch (error) { denial = (error as { code?: string }).code ?? "UNKNOWN"; }
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    await save("request-deletion-refusal.json", { requestId: original.id, denial, deleted, alwaysRolledBack: true });
    assert.equal(deleted, 0, "ORIGINAL_POSSIBLE_REQUEST_WAS_DELETABLE");
    assert(["42501", "P0001"].includes(denial!), "DATABASE_OWNING_DELETE_REFUSAL_REQUIRED");
    return { requestId: original.id, denial, deleted, retainedOriginal: true };
  });
  if (configuredS8) {
    const admitted = await record("native-S8-independent-discovery-and-signed-development-lifecycle", async () => {
      const parent = await applicationSession(ctx, sessionId);
      const originalProfiles = await Promise.all(profiles.map(async id => (await nativeApplicationProfile(ctx, id)).profile));
      s8 = await bootstrapNativeS8Fixture({ privateDir: join(privateDir, "s8"), repoRoot: repo,
        native: { context: ctx, acquisitionSessionId: sessionId, currentRightsRef: parent.parent.rightsRevision },
        model, check, originalParent: parent.parent, originalProfiles });
      const proposal = await s8.propose();
      const evidence = await s8.readDiscoveryEvidence();
      const nativeRequests = (await admin!.query<ApplicationRequestRow>("SELECT * FROM finnor_os.application_semantics_requests WHERE session_id=$1 ORDER BY created_at,id", [sessionId])).rows;
      const fields = (await admin!.query<{ body: { fields: ApplicationField[] } }>(
        "SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND principal_id=$2"
        + " AND body->>'schema'='finnor.x2.native-structural-discovery.v1' ORDER BY created_at LIMIT 1", [tenant, actor])).rows[0]?.body.fields;
      assert(fields?.length, "ORIGINAL_DISCOVERED_TYPED_FIELDS_REQUIRED");
      const journalPath = join(portalDir, "discovery-inspection-input.json");
      await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
        "snapshot", "--private-dir", portalDir, "--output", journalPath]);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      // Register every original case before grading; neither candidate checks
      // nor a passed-subset selection determine this fixed population.
      const caseCommitments = evidence.map(value => nativeDiscoveryCaseCommitment(value.ref,
        nativeRequests.find(row => row.body.wire.identity.effectId === value.effectRef?.id)?.request_ref ?? null, journal.digest));
      const oracleRef = x2Ref("ORACLE", "application-independent-discovery-oracle", {
        schema: "finnor.x2.native-discovery-oracle-cut.v1", oraclePins,
        specificationDigest: sha(await readFile(join(repo, "scope-frontier5/x2-software-semantics-compiler/native-discovery-inspection-contract.md"))),
        inspectorDigest: sha(await readFile(join(import.meta.dirname, "inspect-native-discovery.mts"))),
        journalDigest: journal.digest, caseCommitments,
      });
      const registered = await s8.register({
        schema: "finnor.s8.application-evaluation-protocol.v1", tenantId: tenant, principalId: actor,
        revisionRef: s8.candidate.ref, evaluatorId: s8.principals.evaluator, registeredAt: new Date().toISOString(),
        dependencyDigest: s8.dependencyDigest, originalEvidenceRefs: evidence.map(value => value.ref),
        oracleRef, caseCommitments, ...NATIVE_S8_FIXTURE_FLAGS,
      });
      const independent = inspectNativeDiscovery({ model, fields, evidence, requests: nativeRequests, profiles: originalProfiles, journal });
      await save("private/independent-discovery-grade.json", independent);
      assert.equal(independent.verdict, "SUPPORTED_DEVELOPMENT", JSON.stringify(independent.checks.filter(value => !value.passed)));
      assert.deepEqual(independent.cases.map(value => value.commitment), caseCommitments);
      const resultRef = x2Ref("ORACLE", "application-independent-discovery-result", independent);
      const evaluation = await s8.evaluate({
        schema: "finnor.s8.application-evaluation.v1", tenantId: tenant, principalId: actor,
        revisionRef: s8.candidate.ref, protocolRef: registered.commitment.ref, evaluatorId: s8.principals.evaluator,
        completedAt: new Date().toISOString(), dependencyDigest: s8.dependencyDigest,
        originalEvidenceRefs: evidence.map(value => value.ref), oracleRef, caseCommitments,
        resultsDigest: x2Digest(independent), evidenceRefs: [resultRef],
        disposition: independent.verdict, falseValid: independent.falseValid, falseInvalid: independent.falseInvalid,
        authorityViolations: independent.authorityViolations, duplicateEffects: independent.duplicateEffects,
        falseCompletions: independent.falseCompletions,
        costs: { search: null, training: null, evaluation: null, human: null, computeData: null,
          integration: null, maintenance: null, recovery: null, deployment: null, costRefs: [], currency: "USD", basis: "UNKNOWN" },
        economicCreditGranted: false, ...NATIVE_S8_FIXTURE_FLAGS,
      });
      const admission = await s8.admit({ schema: "finnor.s8.application-admission.v1", revisionRef: s8.candidate.ref,
        evaluationRef: evaluation.commitment.ref, dependencyDigest: s8.dependencyDigest, ...NATIVE_S8_FIXTURE_FLAGS });
      const activation = await s8.activate({ schema: "finnor.s8.application-activation.v1", revisionRef: s8.candidate.ref,
        admissionRef: admission.commitment.ref, dependencyDigest: s8.dependencyDigest, expectedGeneration: 0,
        predecessorRef: null, mode: "DEVELOPMENT", validUntil: deadlineAt, maxCost: 100, maxUses: 64,
        evidenceRefs: [evaluation.commitment.ref], ...NATIVE_S8_FIXTURE_FLAGS });
      const wrongRole = await s8.commandAs("proposer", "APPLICATION_REGISTER", registered.signed);
      assert.equal(wrongRole.status, 403);
      assert.equal((wrongRole.body as { code: string }).code, "S8_OPERATION_NOT_AUTHORIZED");
      await save("native-s8-lifecycle.json", { proposal, registered, evaluation, admission, activation, wrongRole,
        externalProof: "ORIGINAL_NATIVE_VERSUS_INDEPENDENT_INTEGRITY_CHECKED_PROVIDER_JOURNAL",
        protectedAdmission: false });
      return { proposal: proposal.ref, protocol: registered.commitment.ref, evaluation: evaluation.commitment.ref,
        admission: admission.commitment.ref, activation: activation.commitment.ref, generation: activation.generation,
        independentCases: independent.cases.length, independentChecks: independent.checks.length,
        distinctPrincipals: s8.principals, protectedAdmission: false, actualCosts: "UNKNOWN" };
    });
    if (!admitted) throw Error("NATIVE_CONFIGURED_S8_PREREQUISITE_FAILED");
  }
  if (reviewGates) {
    assert(readRelay);
    await runNativeReviewGates({ ctx, sql: admin!, adminUrl, sessionId, profiles, model, check, relay: readRelay,
      call: body => http!.call("application-acquire", body), startWorker, record });
  } else {
  await releaseHeldOut(portalDir);
  let freshSessionId = "";
  let freshProjection: unknown;
  let freshWorkId = "";
  let freshExactQuantity = "";
  const freshCase = semanticDrift ? "canonical-P7-semantic-drift-and-Work-invalidation"
    : finalEgressRevocation ? "canonical-S6-locked-prepared-profile-revocation"
    : resourceBeliefChange ? "canonical-S5-pinned-belief-dependency-currentness"
    : recoveryMode === "deadline" ? "canonical-S6-expired-parent-original-observation"
    : recoveryMode === "cancel" ? "canonical-cancelled-Work-retains-original-observation"
    : "fresh-Work-model-composition-and-independent-business-outcome";
  const completed = await record(freshCase, async () => {
    const objective = JSON.parse(await readFile(join(portalDir, "held-out-objective.json"), "utf8"));
    if (renderingDrift) {
      const before = await snapshot(portalDir);
      assert.equal(before.state.config.renderingRevision, 1);
      await configure(portalDir, { renderingRevision: 2 });
      const after = await snapshot(portalDir);
      assert.equal(after.state.config.renderingRevision, 2);
      assert.equal(after.state.config.semanticRevision, before.state.config.semanticRevision);
      assert.equal(after.state.config.schemaRevision, before.state.config.schemaRevision);
      assert.deepEqual(after.state.records, before.state.records, "RENDERING_REVISION_MUST_NOT_CHANGE_BUSINESS_STATE");
      await save("private/independent-rendering-revision.json", { before, after, objectiveNotAltered: true });
    }
    for (const [index, name, grantKey] of [[0, "editor", "submittingGrantId"], [1, "approver", "approvingGrantId"]] as const) {
      const old = (await admin!.query("SELECT restrictions FROM finnor_os.auth_profiles WHERE id=$1", [profiles[index]])).rows[0].restrictions;
      old.applicationSemantics.allowedTargets = [objective.recordId];
      old.applicationSemantics.allowedEntities = [objective.reporting.entity];
      await admin!.query("UPDATE finnor_os.auth_profiles SET restrictions=$2::jsonb,connection_revision=connection_revision+1,updated_at=clock_timestamp() WHERE id=$1", [profiles[index], JSON.stringify(old)]);
      await writeFile(join(secretRoot, tenant, name + ".json"), JSON.stringify({
        applicationHeaders: JSON.stringify(await portalHeaders(name, objective[grantKey])),
      }), { mode: 0o600 });
    }
    const quantity = { kind: "quantity", decimal: objective.reporting.amount, currency: objective.reporting.currency,
      entity: objective.reporting.entity, unit: objective.reporting.unit, time: objective.reporting.date, basis: objective.reporting.basis };
    const quantityParameterNames = new Set<string>();
    for (const operation of model.operations) for (const parameter of operation.parameters) {
      if (parameter.kind === "quantity") quantityParameterNames.add(parameter.name);
    }
    assert.equal(quantityParameterNames.size, 1, "FROZEN_MODEL_UNAMBIGUOUS_QUANTITY_SIGNATURE_REQUIRED");
    const parameters = { [[...quantityParameterNames][0]!]: quantity };
    const workId = await createWork("Use the frozen model on the freshly authorized reporting configuration and obtain distinct test approval.");
    freshWorkId = workId;
    freshExactQuantity = objective.reporting.amount;
    let execution: { status: number; body: any };
    if (mounted) {
      assert(root.entityType === "pe_deal" && identity && http && "origin" in http);
      const observed = await runMountedNativeIntegration({
        runtimeRoot: repo, evidenceDirectory: out, privateDirectory: privateDir, frontendOrigin,
        apiOrigin: http.origin, auth: identity, sql: admin!, tenantId: tenant, actorId: actor, otherId: other,
        root: { entityType: "pe_deal", entityId: root.entityId },
        acquisitionWorkId: acquisitionWork, acquisitionSessionId: sessionId, freshWorkId: workId,
        executionProfileId: profiles[0]!, targetId: objective.recordId,
        goal: { phase: "APPROVED", reporting: quantity }, parameters,
        businessExpectation: { recordId: objective.recordId, reporting: objective.reporting, phase: "APPROVED",
          submissionCount: 1, approvalDistinctFromSubmission: true },
        settleFresh: async (id, signal) => {
          freshSessionId = id;
          await s8!.writeConsumerConfig({
            profiles: await Promise.all(profiles.map(async profileId => (await nativeApplicationProfile(ctx, profileId)).profile)),
            freshSessionId: id,
          });
          const worker = await startWorker(id);
          const abort = () => { worker.child.kill("SIGTERM"); };
          signal.addEventListener("abort", abort, { once: true });
          try {
            if (signal.aborted) abort();
            const row = await worker.completed;
            assert.equal(row.status, "COMPLETED", JSON.stringify(row));
          } finally { signal.removeEventListener("abort", abort); }
        },
        assertBusiness: async (checkpoint, signal) => {
          const path = join(portalDir, "mounted-grade-" + randomUUID() + ".json");
          await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
            "grade", "--private-dir", portalDir, "--objective", join(portalDir, "held-out-objective.json"),
            "--output", path], { signal });
          const grade = JSON.parse(await readFile(path, "utf8"));
          assert.equal(grade.verdict, "PASS", JSON.stringify(grade));
          await save("mounted-business-" + randomUUID() + ".json", { checkpoint, grade, originalDeadline: deadlineAt,
            newAllowance: false, source: "UNCHANGED_INDEPENDENT_EXTERNAL_EVALUATOR" });
          return path;
        },
      });
      await save("mounted-native-result.json", observed);
      await record("actual-maintained-mounted-Work-lifecycle", async () => observed);
      execution = observed.execution; // The actual browser-observed HTTP response.
      actorAccess = await identity.private.passwordSignIn(actor);
    } else execution = await http!.call("application-execute", { root, workId, sessionId,
        executionProfileId: profiles[0], targetId: objective.recordId,
        goal: { phase: "APPROVED", reporting: quantity }, parameters,
        idempotencyKey: "x2-execute-" + randomUUID() });
    assert.equal(execution.status, 202, JSON.stringify(execution));
    freshSessionId = execution.body.sessionId;
    if (resourceBeliefChange) {
      assert(resourcePin && sourceEvidence && sourceObservationId);
      const before = await snapshot(portalDir);
      const original = await applicationSession(ctx, freshSessionId);
      const head = (await admin!.query("SELECT revision FROM finnor_os.s5_resource_heads WHERE tenant_id=$1 AND resource_id=$2",
        [tenant, resource.resourceId])).rows[0];
      const mutationAt = (await admin!.query("SELECT clock_timestamp() at")).rows[0].at;
      const priorPin = await http!.call("belief-pin", resourcePin);
      assert.equal(priorPin.status, 200); assert.equal(priorPin.body.status, "CURRENT", JSON.stringify(priorPin));
      const owners = await import("../../packages/private-equity/src/digital-twin");
      const restated = await owners.restateMetricObservation(ctx, {
        priorObservationId: sourceObservationId, expectedVersion: 1,
        replacement: { value: { type: "number", value: "0" }, evidence: sourceEvidence },
      });
      const pin = await http!.call("belief-pin", resourcePin);
      assert.equal(pin.status, 200); assert.equal(pin.body.status, "INVALIDATED", JSON.stringify(pin));
      const currentHead = (await admin!.query("SELECT revision FROM finnor_os.s5_resource_heads WHERE tenant_id=$1 AND resource_id=$2",
        [tenant, resource.resourceId])).rows[0];
      assert.deepEqual(currentHead, head, "CANONICAL_RESOURCE_HEAD_MUST_REMAIN_UNCHANGED");
      const row = await runWorker(freshSessionId);
      const after = await snapshot(portalDir);
      const requests = (await admin!.query("SELECT id,status,possible_egress FROM finnor_os.application_semantics_requests WHERE session_id=$1",
        [freshSessionId])).rows;
      const charges = (await admin!.query("SELECT charge_key,units,phase FROM finnor_os.s5_governed_resource_charges"
        + " WHERE tenant_id=$1 AND reservation_id=$2 AND created_at>=$3 ORDER BY created_at",
        [tenant, original.reservation_ref.id, mutationAt])).rows;
      await save("private/resource-belief-revocation-outcome.json", {
        restated, pin, head, currentHead, mutationAt, row, requests, charges, before, after,
        originalAllocation: original.allocation_ref, originalReservation: original.reservation_ref, originalDeadline: deadlineAt,
      });
      assert.equal(row.status, "STALE", "INVALIDATED_BELIEF_MUST_FENCE_FORWARD_SPENDING");
      assert.equal(row.reason, "X2_S5_CURRENT_RESOURCE_SOURCE");
      assert.equal(charges.length, 0, "NO_FORWARD_CHARGE_AFTER_RESOURCE_BELIEF_INVALIDATION");
      assert.equal(requests.length, 0, "NO_FORWARD_REQUEST_AFTER_RESOURCE_BELIEF_INVALIDATION");
      assert.deepEqual(after.state.records[objective.recordId], before.state.records[objective.recordId]);
      const retained = await applicationSession(ctx, freshSessionId);
      assert.deepEqual(retained.allocation_ref, original.allocation_ref);
      assert.deepEqual(retained.reservation_ref, original.reservation_ref);
      assert.equal(retained.parent.deadlineAt, deadlineAt);
      return { pin, unchangedResourceHead: currentHead, requests: 0, charges: 0, originalDeadline: deadlineAt, newAllowance: false };
    }
    if (s8 && !mounted) await s8.writeConsumerConfig({
      profiles: await Promise.all(profiles.map(async id => (await nativeApplicationProfile(ctx, id)).profile)),
      freshSessionId: execution.body.sessionId,
    });
    if (semanticDrift) {
      const original = await snapshot(portalDir);
      await configure(portalDir, { semanticRevision: original.state.config.semanticRevision + 1 });
      const changed = await snapshot(portalDir);
      assert.equal(changed.state.config.renderingRevision, original.state.config.renderingRevision);
      const row = await runWorker(freshSessionId);
      const work = (await admin!.query("SELECT status FROM finnor_os.works WHERE id=$1", [workId])).rows[0];
      const requests = (await admin!.query("SELECT status,possible_egress FROM finnor_os.application_semantics_requests WHERE session_id=$1", [freshSessionId])).rows;
      const events = (await admin!.query("SELECT kind,body FROM finnor_os.application_semantics_events"
        + " WHERE session_id=$1 AND kind IN ('P7_OPERATION_FALSIFIED_OR_REVOKED','P7_MINIMAL_SOUND_COMPOSITION_CLOSURE')"
        + " ORDER BY created_at,event_id", [freshSessionId])).rows;
      const final = await snapshot(portalDir);
      await save("private/semantic-drift-Work-outcome.json", { original, changed, row, work, requests, events, final });
      assert(row.composition_ref, "SEMANTIC_DRIFT_MUST_REACH_RETAINED_COMPOSITION");
      assert(events.some(event => event.kind === "P7_OPERATION_FALSIFIED_OR_REVOKED"), "ACTUAL_P7_INVALIDATION_REQUIRED");
      assert.equal(row.status, "STALE");
      assert.equal(row.reason, "X2_MATERIAL_OPERATION_OR_OBSERVER_DRIFT");
      assert.equal(work.status, "blocked", "P7_INVALIDATION_MUST_REACH_CANONICAL_WORK");
      assert.equal(requests.length, 0, "MATERIAL_DRIFT_MUST_FENCE_ALL_NEW_REQUESTS");
      assert.deepEqual(final.state.records[objective.recordId], original.state.records[objective.recordId]);
      // Arrange a legal stopped sibling, not a receipt or external outcome.
      // Its actual checked composition and immutable original input are reused.
      const blockedId = randomUUID();
      await withTenantTransaction(tenant, { userId: actor }, async (_db, c) => {
        await c.query("INSERT INTO finnor_os.application_semantics_sessions SELECT"
          + " (jsonb_populate_record(NULL::finnor_os.application_semantics_sessions,to_jsonb(s)"
          + " || jsonb_build_object('id',$2::uuid,'idempotency_key',$3::text,'status','BLOCKED',"
          + " 'reason','X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED','claim_token',NULL,'claim_fence',NULL))).*"
          + " FROM finnor_os.application_semantics_sessions s WHERE s.tenant_id=$4 AND s.id=$1",
        [freshSessionId, blockedId, "x2-stopped-sibling-" + randomUUID(), tenant]);
      });
      const { invalidateApplicationOperation } = await import("../../packages/private-equity/src/application-semantics/validity");
      const current = await applicationSession(ctx, freshSessionId);
      const composition = await applicationArtifact<{ steps: Array<{ operationId: string }> }>(ctx, current.composition_ref!);
      await invalidateApplicationOperation(ctx, current, composition.steps[0]!.operationId, null,
        "X2_MATERIAL_OPERATION_OR_OBSERVER_DRIFT");
      const blocked = await applicationSession(ctx, blockedId);
      const repeatedWork = (await admin!.query("SELECT status FROM finnor_os.works WHERE id=$1", [workId])).rows[0];
      await save("private/stopped-sibling-invalidation.json", { blockedId, status: blocked.status,
        repeatedWork, originalDeadline: blocked.parent.deadlineAt, newAllowance: false });
      assert.equal(blocked.status, "BLOCKED", "P7_MUST_PRESERVE_STOPPED_NATIVE_HISTORY");
      assert.equal(repeatedWork.status, "blocked");
      return { nativeStatus: row.status, workStatus: work.status, requests: 0,
        compositionRef: row.composition_ref, blockedSiblingPreserved: true, originalDeadline: deadlineAt, newAllowance: false };
    }
    if (referenceBacklog) {
      const current = await applicationSession(ctx, freshSessionId);
      await withTenantTransaction(tenant, { userId: actor }, async (_db, c) => {
        for (let ordinal = 0; ordinal < 96; ordinal++) {
          const body = { schema: "finnor.x2.development-transport-record.v1", tenantId: tenant, principalId: actor,
            workId, ordinal, purpose: "ORDINARY_REFERENCE_TRANSPORT_BACKLOG", executionAuthorityGranted: false };
          const ref = x2Ref("S4", "application-development-transport", body);
          await retainApplicationArtifact(ctx, ref, body, false, c, [current.parent.rightsRevision]);
          backlogRefs.push(ref);
        }
      });
      const pending = (await admin!.query("SELECT identity,status,attempts FROM finnor_os.s6_owner_delivery_states"
        + " WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S4' AND identity=ANY($3::text[]) ORDER BY identity",
        [tenant, actor, backlogRefs.map(ref => ref.id)])).rows;
      await save("private/native-reference-backlog-input.json", { refs: backlogRefs, pending,
        originalParent: current.original_parent_ref, allocation: current.allocation_ref, deadlineAt });
      assert.equal(pending.length, 96);
      assert(pending.every(row => row.status === "PENDING" && row.attempts === 0));
    }
    if (finalEgressRevocation) {
      assert(s8, "ACTUAL_S8_RECHECK_REQUIRED_BEFORE_FINAL_LOCK_RACE");
      const revoker = new pg.Client({ connectionString: adminUrl });
      await revoker.connect();
      let committed = false;
      try {
        const before = await snapshot(portalDir);
        const original = (await admin!.query("SELECT restrictions,connection_revision FROM finnor_os.auth_profiles WHERE id=$1", [profiles[0]])).rows[0];
        const restrictions = structuredClone(original.restrictions);
        restrictions.applicationSemantics.allowedTargets = ["x2-revoked-target-" + randomUUID()];
        await revoker.query("BEGIN");
        const blocker = (await revoker.query("SELECT pg_backend_pid() pid")).rows[0].pid;
        await revoker.query("UPDATE finnor_os.auth_profiles SET restrictions=$2::jsonb,connection_revision=connection_revision+1,updated_at=clock_timestamp() WHERE id=$1",
          [profiles[0], JSON.stringify(restrictions)]);
        const worker = runWorker(execution.body.sessionId);
        worker.catch(() => undefined);
        let wait: unknown;
        const started = performance.now();
        while (performance.now() - started < 60000) {
          const blocked = (await admin!.query(
            "SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity"
            + " WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%application_semantics_requests%'"
            + " AND query LIKE '%auth_profiles%' AND query LIKE '%business_effects%'", [blocker])).rows[0];
          if (blocked) { wait = blocked; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await save("private/final-egress-revocation-wait.json", { wait: wait ?? null, blocker,
          profileId: profiles[0], originalRevision: original.connection_revision, stagedRestrictions: restrictions });
        assert(wait, "ACTUAL_FINAL_S6_ROW_LOCK_NOT_REACHED");
        const rechecks = (await admin!.query("SELECT event_id FROM finnor_os.application_semantics_events WHERE session_id=$1 AND kind='S8_EXACT_APPLICATION_EGRESS_RECHECK'",
          [execution.body.sessionId])).rows;
        assert.equal(rechecks.length, 1, "REAL_S8_RECHECK_MUST_PRECEDE_FINAL_NATIVE_LOCK");
        await revoker.query("COMMIT"); committed = true;
        const row = await worker;
        const after = await snapshot(portalDir);
        const requests = (await admin!.query("SELECT id,status,possible_egress,body FROM finnor_os.application_semantics_requests WHERE session_id=$1",
          [execution.body.sessionId])).rows;
        await save("private/final-egress-revocation-outcome.json", { before, after, row, requests, originalDeadline: deadlineAt });
        assert.equal(requests.length, 1);
        assert(requests.every(request => !request.possible_egress), "REVOKED_PREPARED_GRANT_REACHED_PHYSICAL_EGRESS");
        assert.deepEqual(after.state.records[objective.recordId], before.state.records[objective.recordId], "INDEPENDENT_APPLICATION_MUTATED_AFTER_NATIVE_REVOCATION");
        assert(["FAILED", "STALE"].includes(row.status));
        assert.equal((await applicationSession(ctx, execution.body.sessionId)).parent.deadlineAt, deadlineAt);
        return { nativeStatus: row.status, possibleEgress: false, actualS8Recheck: true,
          finalNativeRowLockReached: true, originalDeadline: deadlineAt, newAllowance: false };
      } finally {
        if (!committed) await revoker.query("ROLLBACK");
        await revoker.end();
      }
    }
    let row: WorkerSession;
    if (recoveryMode !== "none") {
      const original = await applicationSession(ctx, freshSessionId);
      let lostRequest: ApplicationRequestRow | undefined;
      let lostJob: any, computeLease: any, quarantine: any;
      const killed = await record("canonical-physical-worker-SIGKILL-after-exact-acceptance", async () => {
        await configure(portalDir, { responseFault: "hold-next-submit", ackDelayMs: 10000, asyncDelayMs: 10000 });
        const physical = await startWorker(freshSessionId, undefined, true);
        const started = performance.now();
        while (performance.now() - started < 120000) {
          lostRequest = (await admin!.query<ApplicationRequestRow>("SELECT * FROM finnor_os.application_semantics_requests"
            + " WHERE session_id=$1 AND node_id='step-3' AND possible_egress AND NOT acknowledged AND observation_ref IS NULL",
            [freshSessionId])).rows[0];
          if (lostRequest) break;
          if (physical.child.exitCode !== null || physical.child.signalCode !== null) throw Error("PHYSICAL_WORKER_EXITED_BEFORE_SUBMISSION_FAULT");
          await new Promise(yes => setTimeout(yes, 20));
        }
        assert(lostRequest, "FRESH_ORIGINAL_POSSIBLE_SUBMISSION_REQUIRED");
        const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
          "wait", "--private-dir", portalDir, "--event", "submission.accepted",
          "--request-id", lostRequest.body.wire.identity.requestId, "--timeout-ms", "3000"]);
        const acceptance = JSON.parse(stdout);
        assert.equal(acceptance.observed, true, "INDEPENDENT_EXACT_SUBMISSION_ACCEPTANCE_REQUIRED");
        const journalPath = join(portalDir, "physical-kill-journal.json");
        await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
          "snapshot", "--private-dir", portalDir, "--output", journalPath]);
        const journal = JSON.parse(await readFile(journalPath, "utf8"));
        const accepted = journal.events.find((event: any) => event.type === "submission.accepted"
          && event.requestId === lostRequest!.body.wire.identity.requestId);
        assert(accepted && accepted.recordId === objective.recordId, "INDEPENDENT_FRESH_ACCEPTANCE_TUPLE_REQUIRED");
        assert.equal(accepted.effectId, lostRequest.body.wire.identity.effectId);
        assert.equal(accepted.obligationId, lostRequest.body.wire.identity.obligationId);
        assert.equal(accepted.parentId, lostRequest.body.wire.identity.parentId);
        assert(journal.events.some((event: any) => event.type === "fault.response-boundary"
          && event.requestId === accepted.requestId && event.fault === "hold-next-submit"), "ACTUAL_HELD_RESPONSE_BOUNDARY_REQUIRED");
        assert(!journal.events.some((event: any) => event.type === "submission.completed"
          && event.requestId === accepted.requestId), "PHYSICAL_KILL_MUST_PRECEDE_DURABLE_SUBMISSION_COMPLETION");
        lostJob = (await admin!.query("SELECT j.*,a.id delivery_attempt_id,a.worker_id,a.outcome,a.finished_at"
          + " FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.claim_token=j.claim_token"
          + " WHERE j.payload->>'sessionId'=$1 AND j.status='running' AND a.finished_at IS NULL", [freshSessionId])).rows[0];
        assert(lostJob, "ACTUAL_ORIGINAL_PHYSICAL_CLAIM_REQUIRED");
        assert.equal(lostJob.lease_owner, lostJob.worker_id);
        assert(lostJob.worker_id.endsWith(":" + physical.child.pid), "FAULT_MUST_KILL_ACTUAL_QUEUE_OWNER_NOT_WRAPPER");
        const pending = (await admin!.query<ApplicationRequestRow>("SELECT * FROM finnor_os.application_semantics_requests WHERE id=$1", [lostRequest.id])).rows[0]!;
        assert(pending.possible_egress && !pending.acknowledged && !pending.observation_ref, "ACK_OR_SETTLEMENT_PRECEDED_PHYSICAL_KILL");
        assert.equal(pending.status, "POSSIBLE_EGRESS", "PHYSICAL_KILL_MUST_PRECEDE_PROVIDER_TIMEOUT");
        assert.equal(pending.response_ref, null);
        const acceptedToKillMs = Date.now() - Date.parse(accepted.at);
        assert(acceptedToKillMs >= 0 && acceptedToKillMs < 5000, "PHYSICAL_KILL_MUST_REACH_ORIGINAL_HELD_RESPONSE_WINDOW");
        assert(physical.child.kill("SIGKILL"), "ACTUAL_OWNED_PHYSICAL_WORKER_KILL_FAILED");
        await physical.completed;
        computeLease = (await admin!.query("SELECT resource_key,owner_id,fence,expires_at,released_at FROM finnor_os.compute_resource_leases"
          + " WHERE resource_key='native:x2' AND owner_id=$1", ["x2:" + lostJob.delivery_attempt_id])).rows[0];
        assert(computeLease && !computeLease.released_at, "CRASH_MUST_RETAIN_ACTUAL_COMPUTE_LEASE_UNTIL_EXPIRY");
        await save("private/physical-SIGKILL-original-cut.json", { pid: physical.child.pid, acceptance, acceptedToKillMs,
          independentJournalDigest: journal.digest, independentJournalPath: journalPath,
          request: pending, job: lostJob, computeLease, parent: original.parent,
          allocation: original.allocation_ref, reservation: original.reservation_ref });
        return { actualPid: physical.child.pid, signal: "SIGKILL", originalRequest: pending.request_ref,
          effectId: pending.body.wire.identity.effectId, obligationId: pending.obligation_id,
          exactIndependentAcceptance: acceptance, acceptedToKillMs, originalJobId: lostJob.id, originalDeadline: deadlineAt };
      });
      if (!killed) throw Error("NATIVE_PHYSICAL_FAULT_PREREQUISITE_FAILED");
      const expired = await record("canonical-natural-lease-expiry-and-original-quarantine", async () => {
        const started = performance.now();
        const expiresAt = Math.max(lostJob.lease_expires_at.getTime(), computeLease.expires_at.getTime());
        assert(expiresAt - Date.now() <= 330000, "PERSISTED_ORIGINAL_LEASE_WAIT_MUST_BE_BOUNDED");
        while (Date.now() <= expiresAt) await new Promise(yes => setTimeout(yes, Math.min(1000, expiresAt - Date.now() + 10)));
        const cut = (await admin!.query("SELECT clock_timestamp() at,j.status,j.attempts,j.claim_fence,j.lease_expires_at,"
          + " l.expires_at compute_expires_at,l.released_at compute_released_at FROM finnor_os.jobs j"
          + " JOIN finnor_os.compute_resource_leases l ON l.owner_id=$2 AND l.resource_key='native:x2' WHERE j.id=$1",
          [lostJob.id, computeLease.owner_id])).rows[0];
        assert.equal(cut.status, "running", "ORIGINAL_RECONCILABLE_JOB_MUST_NOT_AUTO_REPLAY");
        assert(cut.at.getTime() > cut.lease_expires_at.getTime() && cut.at.getTime() > cut.compute_expires_at.getTime());
        assert.equal(cut.compute_released_at, null, "DRIVER_MUST_NOT_CLEAR_ORIGINAL_CRASH_LEASE");
        const { stdout } = await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
          "wait", "--private-dir", portalDir, "--event", "submission.completed",
          "--request-id", lostRequest!.body.wire.identity.requestId, "--timeout-ms", "3000"]);
        const completion = JSON.parse(stdout);
        assert.equal(completion.observed, true, "INDEPENDENT_ORIGINAL_DURABLE_COMPLETION_REQUIRED");
        await (await startWorker(freshSessionId, "RECOVER_ONLY")).completed;
        quarantine = (await admin!.query("SELECT j.status,j.attempts,j.claim_fence,a.outcome,a.failure_kind"
          + " FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.id=$2 WHERE j.id=$1",
          [lostJob.id, lostJob.delivery_attempt_id])).rows[0];
        await save("private/original-job-quarantine.json", { cut, quarantine, completion, waitMs: performance.now() - started });
        assert.equal(quarantine.status, "quarantined");
        assert.equal(quarantine.outcome, "reconciliation_required");
        assert.equal(quarantine.failure_kind, "lease_expired");
        assert.equal(quarantine.attempts, lostJob.attempts);
        assert.equal(quarantine.claim_fence, lostJob.claim_fence);
        return { cut, quarantine, completion, waitMs: performance.now() - started, timestampEdits: false, automaticReplay: false };
      });
      if (!expired) throw Error("NATIVE_ORIGINAL_LEASE_QUARANTINE_PREREQUISITE_FAILED");
      if (recoveryMode === "opaque") await configure(portalDir, { completion: "opaque" });
      if (s8) await s8.restart("S6_AND_S8");
      const resume = recoveryMode === "cancel" ? await http!.call("application-cancel", { root, workId })
        : await http!.call("application-resume", { root, workId, sessionId: freshSessionId });
      assert.equal(resume.status, recoveryMode === "cancel" ? 200 : 202, JSON.stringify(resume));
      const recoveryStartedAt = (await admin!.query("SELECT clock_timestamp() at")).rows[0].at;
      row = await runWorker(freshSessionId);
      const retained = await applicationSession(ctx, freshSessionId);
      assert.deepEqual(retained.parent, original.parent, "RECOVERY_MUST_NOT_RENEW_ORIGINAL_PARENT");
      assert.deepEqual(retained.allocation_ref, original.allocation_ref);
      assert.deepEqual(retained.reservation_ref, original.reservation_ref);
      const requestRows = () => admin!.query("SELECT r.id,r.status,r.obligation_id,r.request_ref,r.possible_egress,r.acknowledged,"
        + "o.effect_id,e.status effect_status,e.verification FROM finnor_os.application_semantics_requests r"
        + " JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
        + " JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id"
        + " WHERE r.session_id=$1 ORDER BY r.created_at,r.id", [freshSessionId]);
      if (recoveryMode === "opaque") {
        const unknown = await record("canonical-opaque-original-effect-UNKNOWN", async () => {
          const requests = (await requestRows()).rows;
          const projection = await http!.call("application-projection", { root, workId });
          const history = await s8!.commandAs("reader", "READ", { offset: 0, limit: 64 });
          assert.equal(history.status, 200);
          const uses = (history.body as { applications: { uses: Array<{ lease: ApplicationCapabilityUseLease; reconciled: boolean }> } }).applications.uses;
          const use = uses.find(value => value.lease.request.operationIds.includes(lostRequest!.body.operationId));
          await save("private/opaque-original-recovery.json", { row, requests, projection, history });
          assert.equal(row.status, "UNKNOWN", "PRIVILEGED_JOURNAL_MUST_NOT_SETTLE_OPAQUE_RUNTIME");
          assert.equal(requests.length, 3, "OPAQUE_RECOVERY_MUST_NOT_APPROVE_OR_RESUBMIT");
          const originalRequest = requests.find(value => value.id === lostRequest!.id);
          assert(originalRequest && originalRequest.status === "UNKNOWN" && originalRequest.effect_status === "reconciliation_required");
          assert(use && !use.reconciled, "OPAQUE_S8_ORIGINAL_USE_MUST_REMAIN_UNRESOLVED");
          assert.equal(projection.status, 200); assert.equal(projection.body.sessions[0].resourceReleaseGranted, false);
          const independent = await snapshot(portalDir);
          assert.equal(independent.state.records[objective.recordId].submissions.length, 1);
          assert.equal(independent.state.records[objective.recordId].approval, null);
          return { status: row.status, requests: 3, originalRequest: originalRequest.request_ref,
            originalEffect: originalRequest.effect_id, originalObligation: originalRequest.obligation_id,
            s8OriginalUseUnresolved: true, resourceReleaseGranted: false, newAllowance: false };
        });
        if (!unknown) throw Error("NATIVE_OPAQUE_RECOVERY_PREREQUISITE_FAILED");
        await configure(portalDir, { completion: "full" });
        assert.equal((await http!.call("application-resume", { root, workId, sessionId: freshSessionId })).status, 202);
        row = await runWorker(freshSessionId);
      }
      if (["deadline", "cancel"].includes(recoveryMode)) {
        const requests = (await requestRows()).rows;
        const work = (await admin!.query("SELECT status FROM finnor_os.works WHERE id=$1", [workId])).rows[0];
        const after = await snapshot(portalDir);
        const charges = (await admin!.query("SELECT charge_key,phase,units FROM finnor_os.s5_governed_resource_charges"
          + " WHERE tenant_id=$1 AND reservation_id=$2 AND created_at>=$3 ORDER BY created_at",
          [tenant, original.reservation_ref.id, recoveryStartedAt])).rows;
        await save("private/stopped-original-observation.json", { row, work, requests, charges, after,
          originalParent: retained.parent, quarantine, newAllowance: false });
        assert.equal(requests.length, 3, "STOPPED_RECOVERY_MUST_NOT_APPROVE_OR_RESUBMIT");
        const settled = requests.find(value => value.id === lostRequest!.id);
        assert(settled && settled.status === "VERIFIED" && settled.effect_status === "verified",
          "LATE_OR_STOPPED_ORIGINAL_SUBMISSION_MUST_BE_OBSERVED_WITHOUT_FORWARD_AUTHORITY");
        assert.equal(after.state.records[objective.recordId].phase, "SUBMITTED");
        assert(charges.every(value => value.phase === "RECOVERY"), "STOPPED_OR_EXPIRED_RECOVERY_MUST_NOT_CHARGE_FORWARD_USE");
        assert.notEqual(row.status, "COMPLETED");
        if (recoveryMode === "cancel") assert.equal(work.status, "cancelled", "AUTHENTICATED_CANCEL_MUST_REACH_CANONICAL_WORK");
        else assert(Date.now() > Date.parse(retained.parent.deadlineAt), "ORIGINAL_BUSINESS_DEADLINE_MUST_ACTUALLY_EXPIRE");
        return { row, work, originalRequest: settled.request_ref, originalEffect: settled.effect_id,
          originalObligation: settled.obligation_id, noForwardAction: true, originalDeadline: retained.parent.deadlineAt,
          resourceReleaseGranted: false, newAllowance: false };
      }
      const originals = (await requestRows()).rows;
      assert(originals.some(value => value.id === lostRequest!.id && value.obligation_id === lostRequest!.obligation_id
        && value.effect_id === lostRequest!.body.wire.identity.effectId), "ORIGINAL_POSSIBLE_EFFECT_IDENTITY_MUST_SURVIVE_RECOVERY");
      await save("private/full-original-recovery.json", { row, originals, quarantine,
        originalParent: retained.parent, originalAllocation: retained.allocation_ref, originalReservation: retained.reservation_ref });
    } else row = mounted ? await applicationSession(ctx, freshSessionId) : await runWorker(execution.body.sessionId);
    assert.equal(row.status, "COMPLETED", JSON.stringify(row));
    const gradePath = join(portalDir, "native-grade.json");
    await promisify(execFile)(process.execPath, [join(import.meta.dirname, "fixtures/evaluate.mjs"),
      "grade", "--private-dir", portalDir, "--objective", join(portalDir, "held-out-objective.json"), "--output", gradePath]);
    const external = JSON.parse(await readFile(gradePath, "utf8"));
    assert.equal(external.verdict, "PASS", JSON.stringify(external));
    const joins = (await admin!.query("SELECT r.id,r.status,r.possible_egress,r.obligation_id,o.effect_id,e.status effect_status,d.status action_status,dr.id receipt_id FROM finnor_os.application_semantics_requests r JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id LEFT JOIN finnor_os.decision_receipts dr ON dr.tenant_id=d.tenant_id AND dr.domain_action_id=d.id WHERE r.session_id=$1 ORDER BY r.created_at", [execution.body.sessionId])).rows;
    assert.equal(joins.length, 4); assert(joins.every((value) => value.status === "VERIFIED" && value.effect_status === "verified" && value.action_status === "completed" && value.receipt_id));
    const projection = await http!.call("application-projection", { root, workId });
    assert.equal(projection.status, 200); assert.equal(projection.body.sessions[0].status, "COMPLETED");
    freshProjection = projection.body;
    await save("private/fresh-work-projection.json", projection.body);
    if (s8) {
      await s8.drainNativeRefs();
      const events = (await admin!.query("SELECT kind,body FROM finnor_os.application_semantics_events WHERE session_id=$1 AND kind LIKE 'S8_%' ORDER BY created_at,event_id", [execution.body.sessionId])).rows;
      const uses = events.filter(value => value.kind === "S8_EXACT_APPLICATION_USE");
      const reconciliations = events.filter(value => value.kind === "S8_EXACT_APPLICATION_RECONCILIATION");
      assert.equal(uses.length, 4);
      assert.equal(events.filter(value => value.kind === "S8_EXACT_APPLICATION_EGRESS_RECHECK").length, 4);
      assert.equal(reconciliations.length, recoveryMode === "opaque" ? 5 : 4);
      const observed = reconciliations.filter(value => value.body.detail.outcome === "OBSERVED");
      assert.equal(observed.length, 4);
      assert.deepEqual(observed.map(value => x2Digest(value.body.detail.leaseRef)).sort(),
        uses.map(value => x2Digest(value.body.detail.leaseRef)).sort(), "EXACT_ORIGINAL_USES_MUST_BE_OBSERVED");
      assert(reconciliations.every(value => !value.body.detail.liabilityBudgetReleased && !value.body.detail.economicCreditGranted));
      if (recoveryMode === "opaque") {
        const unknown = reconciliations.filter(value => value.body.detail.outcome === "UNKNOWN");
        assert.equal(unknown.length, 1); assert.equal(unknown[0]!.body.detail.outcomeResolved, false);
        const original = reconciliations.filter(value =>
          x2Digest(value.body.detail.leaseRef) === x2Digest(unknown[0]!.body.detail.leaseRef));
        assert.deepEqual(original.map(value => value.body.detail.outcome), ["UNKNOWN", "OBSERVED"]);
        assert.deepEqual(original[0]!.body.detail.requestRef, original[1]!.body.detail.requestRef);
        assert.notDeepEqual(original[0]!.body.detail.evidenceRef, original[1]!.body.detail.evidenceRef);
        assert.equal(original[1]!.body.detail.outcomeResolved, true);
      }
      await save("native-s8-use-and-recheck.json", events);
    }
    return { execution, external, joins, canonicalStatus: projection.body.sessions[0].status,
      originalDeadline: projection.body.sessions[0].deadlineAt, newAllowance: false };
  });
  if (!completed) throw Error("NATIVE_HELD_OUT_BOUNDARY_PREREQUISITE_FAILED");
  if (renderingDrift) await record("canonical-P7-current-rendering-binding-lineage", async () => {
    const requests = (await admin!.query<ApplicationRequestRow>(
      "SELECT * FROM finnor_os.application_semantics_requests WHERE session_id=$1 ORDER BY created_at,id", [freshSessionId])).rows;
    const events = (await admin!.query("SELECT body FROM finnor_os.application_semantics_events WHERE session_id=$1"
      + " AND kind='P7_LAWFUL_RENDERING_REVALIDATION' ORDER BY created_at,event_id", [freshSessionId])).rows;
    let relocated = 0;
    for (const request of requests) {
      const binding = await applicationArtifact<Omit<PrivateApplicationBinding, "ref">>(ctx, request.binding_ref);
      if (binding.substrate !== "UI") continue;
      const operation = model.operations.find((value: { id: string }) => value.id === request.body.operationId);
      assert(operation, "ORIGINAL_LOGICAL_OPERATION_REQUIRED");
      assert.equal(request.body.wire.context.renderingRevision, 2);
      assert.deepEqual(request.body.wire.bindingRef, request.binding_ref, "WIRE_MUST_USE_CURRENT_STORED_BINDING");
      assert.notEqual(binding.renderingDigest, operation.renderingDigest, "CHANGED_UI_RENDERING_MUST_RELOCATE");
      assert.notDeepEqual(request.binding_ref, operation.privateBindingRef, "OLD_MODEL_BINDING_MUST_NOT_BE_REUSED");
      assert(events.some(event => event.body.detail.operationId === operation.id
        && x2Digest(event.body.detail.currentBindingRef) === x2Digest(request.binding_ref)),
      "ACTUAL_P7_REVALIDATION_MUST_BIND_ORIGINAL_S6_REQUEST");
      relocated++;
    }
    assert.equal(relocated, surface === "ui" ? 4 : 2);
    await save("private/current-rendering-bindings.json", { requests, events, relocated, originalDeadline: deadlineAt });
    return { relocated, renderingRevision: 2, originalDeadline: deadlineAt, newAllowance: false };
  });
  if (!semanticDrift && !finalEgressRevocation && !resourceBeliefChange && !["deadline", "cancel"].includes(recoveryMode)) {
  if (referenceBacklog) await record("native-S8-bounded-original-reference-delivery", async () => {
    const rows = (await admin!.query("SELECT s.identity,s.status,s.attempts,o.envelope FROM finnor_os.s6_owner_delivery_states s"
      + " JOIN finnor_os.s6_owner_delivery_origins o USING(tenant_id,principal_id,semantic_owner,kind,identity)"
      + " WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.semantic_owner='S4' AND s.identity=ANY($3::text[]) ORDER BY s.identity",
      [tenant, actor, backlogRefs.map(ref => ref.id)])).rows;
    const unresolved = (await admin!.query("SELECT identity,status,last_error FROM finnor_os.s6_owner_delivery_states"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S4' AND status<>'ACCEPTED'",
      [tenant, actor])).rows;
    await save("private/native-reference-backlog-outcome.json", { rows, unresolved, originalDeadline: deadlineAt });
    assert.equal(rows.length, 96);
    for (const row of rows) {
      assert.equal(row.status, "ACCEPTED");
      assert.equal(row.attempts, 1);
      const ref = backlogRefs.find(ref => ref.id === row.identity)!;
      assert.equal(row.envelope.payload.reference.contentDigest, ref.contentDigest);
    }
    assert.equal(unresolved.length, 0);
    return { independentlyReadOriginals: rows.length, accepted: 96, duplicateAttempts: 0,
      originalDeadline: deadlineAt, newAllowance: false };
  });
  await record("maintained-client-authenticated-fresh-Work-projection", async () => {
    const path = join(privateDir, "maintained-client-projection-input.json");
    await save("private/maintained-client-projection-input.json", { projection: freshProjection,
      expected: { tenantId: tenant, principalId: actor, root, workId: freshWorkId,
        authorityEpoch: (await applicationSession(ctx, freshSessionId)).parent.rightsRevision },
      exactQuantity: freshExactQuantity });
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(repo, "finnor-os/node_modules/tsx/dist/cli.mjs"), "--tsconfig", join(repo, "tsconfig.json"),
      join(import.meta.dirname, "verify-maintained-projection.mts"), path,
    ], { cwd: repo });
    const observed = JSON.parse(stdout.trim());
    assert.equal(observed.status, "PASS");
    await save("maintained-client-projection.json", observed);
    return observed;
  });
  if (s8) await record("native-S8-exact-original-reconciliation-evidence-refusal", async () => {
    const history = await s8!.commandAs("reader", "READ", { offset: 0, limit: 64 });
    assert.equal(history.status, 200);
    const uses = (history.body as { applications: { uses: Array<{
      lease: ApplicationCapabilityUseLease; lastEvidenceRef: ExperimentRef | null;
    }> } }).applications.uses;
    assert.equal(uses.length, 4, "FOUR_REAL_NATIVE_USE_LEASES_REQUIRED");
    const use = uses[0]!;
    const originals = (await admin!.query<{ body: Omit<ApplicationTransitionEvidence, "ref"> }>(
      "SELECT a.body FROM finnor_os.application_semantics_events e JOIN finnor_os.application_semantics_artifacts a"
      + " ON a.tenant_id=e.tenant_id AND a.principal_id=e.principal_id AND a.artifact_id=e.body->'detail'->'ref'->>'id'"
      + " WHERE e.session_id=$1 AND e.kind='ORIGINAL_TRANSITION_EVIDENCE' ORDER BY e.created_at,e.event_id", [freshSessionId])).rows;
    const original = originals.find(item => item.body.operationId === use.lease.request.operationIds[0])!.body;
    assert(original.effectRef && original.obligationRef);
    const parameters = structuredClone(original.parameters);
    const parameter = Object.values(parameters).find(value => value && typeof value === "object" && value.kind === "quantity");
    assert(parameter && typeof parameter === "object" && parameter.kind === "quantity", "REAL_PARAMETERIZED_QUANTITY_USE_REQUIRED");
    parameter.decimal = "9007199254740993.02";
    const mutant = { ...original, parameters };
    const evidenceRef = x2Ref("S6", "application-transition", mutant);
    const current = await applicationSession(ctx, freshSessionId);
    await withTenantTransaction(tenant, { userId: actor }, async (_db, c) => {
      await retainApplicationArtifact(ctx, evidenceRef, mutant, true, c);
      await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: "S6", tenantId: tenant, principalId: actor }, {
        kind: "REFERENCE", identity: evidenceRef.id,
        payload: { reference: { ...evidenceRef, content: mutant }, rightsRefs: [current.parent.rightsRevision] },
      });
    });
    await s8!.drainNativeRefs();
    const input = { useId: use.lease.useId, revisionRef: use.lease.revisionRef,
      evidenceRef, priorEvidenceRef: use.lastEvidenceRef, outcome: "OBSERVED" };
    const response = await s8!.commandAs("consumer", "APPLICATION_RECONCILE", input);
    await save("private/native-s8-wrong-original-reconciliation.json", {
      input, original, mutant, response,
      preservedParentOperationTargetScope: true, preservedExactEffectAndObligation: true, changedExactParameters: true,
    });
    assert.equal(response.status, 409, "WRONG_ORIGINAL_EFFECT_WAS_RECONCILED");
    assert.equal((response.body as { code: string }).code, "S8_APPLICATION_RECONCILIATION_EVIDENCE");
    return { evidenceRef, response, owner: "S8", originalEffect: original.effectRef, wrongParameters: parameters };
  });
  if (terminalCancellation) await record("canonical-completed-X2-history-preserved-on-cancel", async () => {
    const history = async () => ({
      session: await applicationSession(ctx, freshSessionId),
      work: (await admin!.query("SELECT status,final_outcome FROM finnor_os.works WHERE id=$1", [freshWorkId])).rows[0],
      requests: (await admin!.query("SELECT id,status,obligation_id,request_ref,observation_ref FROM finnor_os.application_semantics_requests"
        + " WHERE session_id=$1 ORDER BY created_at,id", [freshSessionId])).rows,
      jobs: (await admin!.query("SELECT id,payload FROM finnor_os.jobs WHERE payload->>'sessionId'=$1 ORDER BY id", [freshSessionId])).rows,
    });
    const before = await history();
    assert.equal(before.work.status, "completed"); assert.equal(before.session.status, "COMPLETED");
    const first = await http!.call("application-cancel", { root, workId: freshWorkId });
    assert.equal(first.status, 200);
    const cancelled = await history();
    const repeated = await http!.call("application-cancel", { root, workId: freshWorkId });
    assert.equal(repeated.status, 200);
    const retried = await history();
    await runWorker(freshSessionId);
    const delivered = await history();
    await save("private/completed-cancellation-history.json", { before, first, cancelled, repeated, retried, delivered });
    assert.equal(delivered.session.status, "COMPLETED", "CANCELLATION_MUST_NOT_REWRITE_COMPLETED_NATIVE_HISTORY");
    assert.equal(delivered.work.status, "completed"); assert.deepEqual(delivered.work.final_outcome, before.work.final_outcome);
    assert.equal(delivered.requests.length, 4); assert(delivered.requests.every(row => row.status === "VERIFIED"));
    assert.deepEqual(delivered.requests, before.requests);
    assert.equal(retried.session.generation, cancelled.session.generation);
    assert.deepEqual(retried.jobs, cancelled.jobs);
    assert.equal(first.body.externalRollbackClaimed, false); assert.equal(first.body.resourceReleaseGranted, false);
    return { canonicalHistory: "COMPLETED", verifiedRequests: 4, repeatCreatesGeneration: false,
      externalRollbackClaimed: false, resourceReleaseGranted: false };
  });
  }
  }
  if (installed && !reviewGates) await record("installed-runtime-restart-and-byte-custody", async () => {
    assert(http && "restart" in http, "ACTUAL_BUILT_API_RESTART_OWNER_REQUIRED");
    const original = await applicationSession(ctx, sessionId);
    await http.restart();
    const projection = await http.call("application-projection", { root, workId: acquisitionWork });
    assert.equal(projection.status, 200);
    assert(projection.body.sessions.some((value: { sessionId?: string; id?: string }) =>
      (value.sessionId ?? value.id) === sessionId), "RESTART_MUST_READ_ORIGINAL_CANONICAL_SESSION");
    const retained = await applicationSession(ctx, sessionId);
    assert.deepEqual(retained.parent, original.parent);
    assert.deepEqual(retained.original_parent_ref, original.original_parent_ref);
    assert.deepEqual(retained.reservation_ref, original.reservation_ref);
    const continuity = { originalSessionId: sessionId, originalDeadline: retained.parent.deadlineAt,
      originalParent: retained.original_parent_ref, originalReservation: retained.reservation_ref,
      apiRestart: "ACTUAL_BUILT_NEXT_PROCESS", endingAssetInspection: "SEPARATE_REQUIRED_ENDING_CUSTODY_CASE", newAllowance: false };
    await save("installed-post-restart.json", continuity);
    return continuity;
  });
} catch (error) {
  driverFailed = true;
  await save("driver-disposition.json", { status: "BLOCKED_OR_FAILED", predicate: (error as Error).message });
} finally {
  for (const child of owned) if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((yes) => { child.once("close", () => yes()); child.kill("SIGTERM"); });
  }
  await s8?.close();
  if (readRelay) {
    await save("native-read-relay.json", { trace: readRelay.trace, responseSubstitution: false });
    await readRelay.close();
  }
  if (admin) {
    await save("private/native-sessions.json", (await admin.query("SELECT * FROM finnor_os.application_semantics_sessions ORDER BY created_at,id")).rows);
    await save("private/native-events.json", (await admin.query("SELECT * FROM finnor_os.application_semantics_events ORDER BY created_at,event_id")).rows);
    await save("private/native-charges.json", (await admin.query("SELECT * FROM finnor_os.s5_governed_resource_charges ORDER BY created_at,charge_key")).rows);
    await save("private/native-requests.json", (await admin.query("SELECT * FROM finnor_os.application_semantics_requests ORDER BY created_at,id")).rows);
    await save("private/native-artifacts.json", (await admin.query("SELECT * FROM finnor_os.application_semantics_artifacts ORDER BY created_at,artifact_id")).rows);
    await save("private/independent-final-state.json", await snapshot(portalDir).catch(() => null));
  }
  await http?.close();
  if (identity) await save("private/installed-auth-observations.json", { summary: identity.summary(), observations: identity.observations() });
  await identity?.close(); await closePool(); await admin?.end();
  await database.stop().catch(async () => {
    driverFailed = true;
    await save("cleanup-disposition.json", { status: "OWNED_DATABASE_STOP_UNPASSED" });
  });
  await Promise.all(flushLogs.map(flush => flush()));
  if (logFailure) {
    driverFailed = true;
    await save("log-disposition.json", { status: "OWNED_PROCESS_LOG_RETENTION_UNPASSED" });
  }
  const { applicationCodeIdentity } = await import("../../packages/private-equity/src/application-semantics/store");
  const endingSource = await applicationCodeIdentity();
  await save("ending-source.json", endingSource);
  await record("unchanged-source-and-runtime-custody", async () => {
    assert(beginningSource && x2Digest(beginningSource) === x2Digest(endingSource), "SOURCE_OR_RUNTIME_CHANGED_DURING_NATIVE_PROOF");
    const endingDriver = await driverIdentity();
    assert(beginningDriver && x2Digest(beginningDriver) === x2Digest(endingDriver), "DRIVER_CHANGED_DURING_NATIVE_PROOF");
    const endingOracle = await oracleIdentity();
    await save("ending-oracle.json", endingOracle);
    assert(beginningOracle && x2Digest(beginningOracle) === x2Digest(endingOracle), "ORACLE_CHANGED_DURING_NATIVE_PROOF");
    return { beginningDigest: x2Digest(beginningSource), endingDigest: x2Digest(endingSource),
      driverDigest: x2Digest(endingDriver), oracleDigest: x2Digest(endingOracle) };
  });
  if (installed) await record("installed-ending-asset-custody", async () => {
    const actual = await inspectInstalledRuntime(repo);
    await save("installed-ending.json", actual);
    return actual;
  });
  await save("unexecuted-families.json", { status: "NOT_RUN", families: [
    "API_UI_HYBRID_COMPLETE_PROFILE", "CANDIDATE_MUTATIONS",
    ...(recoveryMode === "none" ? ["PHYSICAL_SIGKILL_BEFORE_ACK"] : []),
    ...(recoveryMode !== "opaque" ? ["OPAQUE_SAME_EFFECT_RECOVERY"] : []),
    "RENDERING_AND_SEMANTIC_DRIFT", "CURRENT_GRANT_AND_CANCELLATION",
    "SIBLING_CONCURRENCY_AND_BUDGET", ...(!mounted ? ["MOUNTED_LIFECYCLE"] : []),
    ...(!installed ? ["EMITTED_INSTALLED_RUNTIME"] : []), "MATCHED_FULL_COST_DIAGNOSTIC",
  ], noInferenceFromPositiveRun: true });
  const required = ["fresh-upgrade-replay-and-runtime-role-isolation", "canonical-S5-terminal-resource-floor",
    "authenticated-original-registration-and-idempotency", "physical-acquisition-and-independent-frozen-model",
    "ordinary-role-original-request-deletion-refusal", "unchanged-source-and-runtime-custody",
    ...(installed ? [...(!reviewGates ? ["installed-runtime-restart-and-byte-custody"] : []), "installed-ending-asset-custody"] : []),
    ...(mounted ? ["actual-maintained-mounted-Work-lifecycle"] : []),
    ...(reviewGates ? [...NATIVE_REVIEW_CASES] : semanticDrift ? ["canonical-P7-semantic-drift-and-Work-invalidation"]
      : finalEgressRevocation ? ["canonical-S6-locked-prepared-profile-revocation"]
      : resourceBeliefChange ? ["canonical-S5-resource-belief-initial-owner-cut", "canonical-S5-pinned-belief-dependency-currentness"]
      : recoveryMode === "deadline" ? ["canonical-S6-expired-parent-original-observation"]
      : recoveryMode === "cancel" ? ["canonical-cancelled-Work-retains-original-observation"]
      : ["fresh-Work-model-composition-and-independent-business-outcome", "maintained-client-authenticated-fresh-Work-projection"]),
    ...(recoveryMode !== "none" ? ["canonical-physical-worker-SIGKILL-after-exact-acceptance", "canonical-natural-lease-expiry-and-original-quarantine"] : []),
    ...(recoveryMode === "opaque" ? ["canonical-opaque-original-effect-UNKNOWN"] : []),
    ...(computeContention ? ["canonical-compute-contention-durable-pre-dispatch-deferral"] : []),
    ...(referenceBacklog ? ["native-S8-bounded-original-reference-delivery"] : []),
    ...(terminalCancellation ? ["canonical-completed-X2-history-preserved-on-cancel"] : []),
    ...(renderingDrift ? ["canonical-P7-current-rendering-binding-lineage"] : []),
    ...(configuredS8 ? ["native-S8-independent-discovery-and-signed-development-lifecycle",
      ...(!semanticDrift && !finalEgressRevocation && recoveryMode !== "cancel" ? ["native-S8-exact-original-reconciliation-evidence-refusal"] : [])] : [])];
  const exitCode = !driverFailed && required.every(id => results.some(value => value.id === id && value.status === "PASS"))
    && results.every(value => value.status === "PASS") ? 0 : 1;
  await save("driver-exit.json", { exitCode, required, driverFailed });
  process.exit(exitCode);
}
