/**
 * Reusable native fixture library for the Z0 original-parent path.
 *
 * Both entry points run against the launcher-owned isolated stack (real pinned
 * Auth, migrated database, API on 3101) with the launcher profile `z0`
 * (x1 + x2). They use the launcher's private environment file and the same
 * owner code and authenticated HTTP routes as the product:
 *
 *   createOriginalInstitutionParent(env, options)
 *     owner-authenticated original Work -> owned source originals -> X1 mandate,
 *     source grants and compiler submission over HTTP -> the stock worker's
 *     real compiler/checker/S5 reservation -> `institution_responsibility_v1`
 *     p1_request with plan revision, episode and parent reservation. Rows are
 *     read back, never written, for those owners.
 *
 *   driveAcquisitionToModelReady(env, parent, options)
 *     disposable X2 fake portal + launcher-owned secret custody -> authenticated
 *     `application-acquire` with `institutionalOrigin` -> worker acquisition,
 *     independent check, S4 acceptance. Returns the actual session, model and
 *     check identities.
 *
 * Direct SQL is limited to (a) read-only observation and (b) the disposable
 * fixture inputs that no owner API creates: the `native:p4` compute capacity
 * row, one external organization, and the X2 test application_accounts and
 * auth_profiles rows that mirror the X2 product e2e. No X1/S5/P1/S4/S6 row is
 * written by hand.
 *
 * A worker must be running. Either the stack stock worker (launcher without
 * --no-worker) or one started by `startOwnedWorker` (launcher with
 * --no-worker, which writes FINNOR_WORKER_DATABASE_URL into the private file).
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NativeEnvironment = Record<string, string>;
export type Recorder = (name: string, value: unknown) => void | Promise<void>;

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "../../..");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const noRecord: Recorder = () => undefined;

export const API_ORIGIN = "http://127.0.0.1:3101";

export function readNativeEnvironment(state: string): NativeEnvironment {
  return JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"));
}

let bound: NativeEnvironment | null = null;
/** Owner libraries read process.env when their pool is created, so bind first. */
async function owners(env: NativeEnvironment) {
  if (!bound) {
    for (const key of ["DATABASE_URL", "FINNOR_ENVIRONMENT", "FINNOR_P4_PROFILE", "FINNOR_X2_PROFILE",
      "FINNOR_X2_SOURCE_ROOT", "FINNOR_X2_DISPOSABLE_SECRET_ROOT"]) if (env[key] !== undefined) process.env[key] = env[key];
    process.env.AUTH_DEV_BYPASS = "0";
    bound = env;
  }
  const db = await import("@finnor/db");
  const pe = await import("@finnor/private-equity");
  const dataPlatform = await import("@finnor/data-platform");
  const store = await import("../../../packages/private-equity/src/allocation-store");
  const contracts = await import("../../../packages/epistemic-runtime/src/allocation-contracts");
  return { db, pe, dataPlatform, store, contracts };
}

async function admin(env: NativeEnvironment) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
  await client.connect();
  return client;
}

export interface OwnerSession {
  tenantId: string; userId: string;
  token(): Promise<string>;
  /** Authenticated owner call. A null bearer sends the call anonymously. */
  call(path: string, body?: unknown, options?: { method?: string; bearer?: string | null }): Promise<{ status: number; body: any; bodySha256: string }>;
  operation(name: string, body: unknown, bearer?: string | null): Promise<{ status: number; body: any; bodySha256: string }>;
}

/** Real Auth password grant for the launcher's owner, with refresh-token renewal. */
export async function signInOwner(env: NativeEnvironment, credentials?: { email: string; password: string }): Promise<OwnerSession> {
  const grant = async (type: "password" | "refresh_token", body: Record<string, string>) => {
    const response = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=${type}`, { method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY!, "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000) });
    const session = await response.json().catch(() => ({})) as any;
    if (response.status !== 200 || typeof session.access_token !== "string") throw Error(`Z0_FIXTURE_AUTH_GRANT_${type.toUpperCase()}_${response.status}`);
    return session as { access_token: string; refresh_token: string; expires_in: number };
  };
  let session = await grant("password", { email: credentials?.email ?? env.TEST_OWNER_EMAIL!, password: credentials?.password ?? env.TEST_OWNER_PASSWORD! });
  let expiresAt = Date.now() + session.expires_in * 1000;
  const token = async () => {
    if (Date.now() > expiresAt - 60000) {
      session = await grant("refresh_token", { refresh_token: session.refresh_token });
      expiresAt = Date.now() + session.expires_in * 1000;
    }
    return session.access_token;
  };
  const call: OwnerSession["call"] = async (path, body, options = {}) => {
    const bearer = options.bearer === undefined ? await token() : options.bearer;
    const response = await fetch(API_ORIGIN + path, { method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = { unparsed: text.slice(0, 200) }; }
    return { status: response.status, body: parsed, bodySha256: sha(text) };
  };
  const me = await call("/api/me");
  if (me.status !== 200) throw Error("Z0_FIXTURE_OWNER_IDENTITY_UNAVAILABLE_" + me.status);
  const identity = me.body.data ?? me.body;
  return { tenantId: identity.tenantId ?? identity.tenant_id, userId: identity.userId ?? identity.user_id, token, call,
    operation: (name, body, bearer) => call("/api/company-brain/" + name, body, { bearer }) };
}

export interface OwnedWorker {
  child: ChildProcess; pid: number; log: string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  stop(signal?: NodeJS.Signals): Promise<{ code: number | null; signal: string | null }>;
}

/**
 * Start a scenario-owned production worker (apps/worker createWorker) as the
 * restricted `finnor_worker` role. Requires a launcher started with --no-worker.
 */
export async function startOwnedWorker(env: NativeEnvironment, options: { logPath: string; leaseSeconds?: number; extraEnv?: Record<string, string> }): Promise<OwnedWorker> {
  if (!env.FINNOR_WORKER_DATABASE_URL) throw Error("Z0_FIXTURE_SCENARIO_OWNED_WORKER_REQUIRES_NO_WORKER_LAUNCH");
  const { FINNOR_WORKER_DATABASE_URL, CENTROPY_E2E_DB_ADMIN_URL: _admin, ...rest } = env;
  const log = options.logPath;
  const sink = (await import("node:fs")).createWriteStream(log, { flags: "a", mode: 0o600 });
  const child = spawn(process.execPath, [...process.execArgv, join(here, "z0-worker.mts")], { cwd: backend,
    env: { ...rest, PATH: process.env.PATH ?? "", DATABASE_URL: FINNOR_WORKER_DATABASE_URL, AUTH_DEV_BYPASS: "0",
      WORKER_JOB_LEASE_SECONDS: String(options.leaseSeconds ?? 30), ...(options.extraEnv ?? {}) },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(sink, { end: false });
  child.stderr!.pipe(sink, { end: false });
  const exited = new Promise<{ code: number | null; signal: string | null }>(done =>
    child.once("exit", (code, signal) => { sink.end(); done({ code, signal }); }));
  await new Promise<void>((ready, failed) => {
    const timer = setTimeout(() => failed(Error("Z0_FIXTURE_WORKER_STARTUP_TIMEOUT")), 120000);
    let buffer = "";
    child.stdout!.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.includes("Z0_WORKER_READY")) { clearTimeout(timer); ready(); }
    });
    child.once("exit", code => { clearTimeout(timer); failed(Error("Z0_FIXTURE_WORKER_EARLY_EXIT_" + code)); });
  });
  return { child, pid: child.pid!, log, exited, stop: async (signal = "SIGTERM") => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return exited;
  } };
}

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (/^Z0_FIXTURE_TERMINAL/.test((error as Error).message)) throw error;
      last = error;
    }
    if (Date.now() > end) throw Error(`Z0_FIXTURE_TIMEOUT_${label}${last ? ":" + String((last as Error).message).slice(0, 200) : ""}`);
    await sleep(everyMs);
  }
}

export type ParentShape = "partial-unresolved" | "mixed-supported-and-unresolved" | "gated-two-supported-and-unresolved";

export interface OriginalInstitutionParent {
  schema: "finnor.project-z.native.z0-original-parent.v1";
  tag: string; shape: ParentShape;
  tenantId: string; ownerId: string; dealId: string; registrationId: string; institutionId: string;
  workId: string; workInputId: string; workInputDigest: string;
  compilerRequestId: string; programId: string; episodeId: string; planRevisionId: string; headId: string;
  parentReservation: unknown; parentDemandDigest: string; chargeScope: unknown;
  responsibilityIdentity: string; supportedIdentities: string[];
  originalDeadlineAt: string; wallDeadlineAt: string; dutyDeadlineAt: string; programmeDeadlineAt: string;
  deadlineAt: string; rightsRevision: string;
  resources: { compute: string; human: string }; grantIds: string[];
  nativeStatus: { compiler: string; programme: string; liveJobs: number };
  jobs: Array<{ id: string; type: string; status: string }>;
  /** Only the `gated-two-supported-and-unresolved` shape: duty A is dispatched and `pending` owner approval, duty B is
   * executable and undispatched, and `responsibilityIdentity` names B. */
  gated?: { heldIdentity: string; heldActionId: string; heldActionStatus: string; undispatchedActionId: string;
    undispatchedRequestText: string; heldRequestText: string; workstreamExternalId: string; recipientExternalId: string };
}

export interface ParentOptions {
  tag?: string; shape?: ParentShape; record?: Recorder; timeoutMs?: number; ruleWindowMs?: number;
}

/**
 * Build one original X1 institution parent for the launcher's owner. The
 * default shape has one duty whose trigger carries no workstream reference, so
 * X1 reports it as an unresolved duty: the native request is PARTIAL with no
 * business effect and no live P1 job, which is the quiescent state an
 * acquisition with `institutionalOrigin` requires. `mixed-supported-and-unresolved`
 * adds one supported create_deal_request duty (executed by the stock native
 * path) next to an unsupported operation; the selected duty is the unresolved one.
 * `gated-two-supported-and-unresolved` sets `requiresConfirmation=true` for the operation and adds two supported
 * create_deal_request duties on the same Deal plus the unresolved one: the first pass leaves duty A pending owner
 * approval (it holds the Deal), duty B executable and undispatched, and the programme quiescent PARTIAL (the unresolved
 * duty is a persisted intervention, so no poll is scheduled). The selected duty is B.
 */
export async function createOriginalInstitutionParent(env: NativeEnvironment, options: ParentOptions = {}): Promise<OriginalInstitutionParent> {
  const record = options.record ?? noRecord;
  const tag = options.tag ?? randomUUID().slice(0, 8);
  const shape = options.shape ?? "partial-unresolved";
  const { db, pe, dataPlatform, store, contracts } = await owners(env);
  const owner = await signInOwner(env);
  const { tenantId, userId } = owner;
  const ctxFor = (externalId?: string) => ({ auth: { tenantId, userId, employeeId: userId, role: "owner" as const },
    provenance: { sourceSystem: "existing-crm-owner", createdBy: userId, ...(externalId ? { externalId } : {}) } });
  const institutionId = `z0-original-${tag}`;
  const now = Date.now();
  const window = options.ruleWindowMs ?? 50 * 60000;
  const dutyDeadline = new Date(now + window).toISOString();
  const occurredAt = new Date(now - 120000).toISOString(), availableAt = new Date(now - 60000).toISOString();
  const registrationId = `DEAL-${tag}-${randomUUID()}`;
  const sql = await admin(env);
  try {
    await sql.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p4',2,2,0,60,'explicit disposable Z0 validation capacity; not protected funding') ON CONFLICT(resource_key) DO NOTHING");
    const organizationId = randomUUID();
    await sql.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Z0 original-parent counterparty','other')", [organizationId, tenantId, "z0-org-" + organizationId]);
    const deal = await pe.createDeal(ctxFor(registrationId), { targetOrganizationId: organizationId, name: `Z0 original ${tag}`,
      dealLeadEmployeeId: userId, signedLoiAt: new Date(now - 86400000), targetClosingAt: new Date(now + 86400000) });
    const dealId = String(deal.row.id);
    let workstreamExternalId: string | null = null, recipientExternalId: string | null = null;
    if (shape !== "partial-unresolved") {
      workstreamExternalId = "WS-" + randomUUID(); recipientExternalId = "PARTY-" + randomUUID();
      await pe.createWorkstream(ctxFor(workstreamExternalId), { dealId, kind: "financial_diligence", name: "Evidence schedule", owner: { partyType: "employee", partyId: userId } });
      await pe.addDealParty(ctxFor(recipientExternalId), { dealId, party: { partyType: "external_organization", partyId: organizationId }, role: "target_management" });
    }
    const intake = await db.receiveWork({ tenantId, userId, channel: "console", idempotencyKey: `z0-original-intake:${tag}:${randomUUID()}`,
      instruction: "Maintain the supplied standing evidence responsibility from authorized originals, with no external approval or settlement",
      activeContext: { entityType: "pe_deal", entityId: dealId }, authorityContext: { principalId: userId, scope: "DISPOSABLE_INTERNAL_REQUEST_CREATION_ONLY" } });
    const workId = intake.workId as string;
    await db.attachWorkEntity(tenantId, workId, { entityType: "pe_deal", entityId: dealId, source: "Z0:original-owner-registration" });
    await record("parent-01-original-work", { tenantId, ownerId: userId, dealId, workId, shape, dutyDeadline });

    const profile = await owner.call("/api/workforce/profiles", { key: `z0-native-${tag}`, name: "Disposable native responsibility query and check executor",
      capabilityGrants: [{ kind: "query", capability: "query:harness_program_v1" }, { kind: "check", capability: "check:objective_success" }],
      autonomyLimits: { maxActions: 1, maxQueries: 8, maxReplans: 6, maxPlannerCalls: 8, maxWallClockMs: 3600000 },
      planningHints: { qualification: "DISPOSABLE_ORDINARY_NO_PROTECTED_ADMISSION" } });
    if (profile.status !== 201) throw Error("Z0_FIXTURE_WORKFORCE_PROFILE_" + profile.status);
    const policy = await owner.call(`/api/policies/${tenantId}/create_deal_request`, { policy: { scope: "DISPOSABLE_INTERNAL_REQUEST_ONLY" }, requiresConfirmation: shape === "gated-two-supported-and-unresolved" }, { method: "PUT" });
    if (policy.status !== 200) throw Error("Z0_FIXTURE_NATIVE_POLICY_" + policy.status);
    await record("parent-02-workforce-and-policy", { profile: profile.status, policy: policy.status });

    const rights = String((await sql.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenantId])).rows[0].revision);
    const ref = (ownerName: string, id: string) => ({ owner: ownerName, id, version: "owner-fixture-v1", contentDigest: sha(id) });
    const resourceStart = new Date().toISOString();
    const resources = { compute: `z0-compute-${tag}`, human: `z0-human-${tag}` };
    for (const [resourceId, resourceClass, unit, amount] of [[resources.compute, "COMPUTE", "request", "520"], [resources.human, "HUMAN_ATTENTION", "seconds", "900"]]) {
      await store.putAllocationResource(ctxFor(), contracts.parseAllocationResource({ schema: "finnor.allocation-resource.v1", resourceId, resourceClass, tenantId,
        ownerRef: ref("BUSINESS_OWNER", userId), legalEntityRef: ref("S1", dealId), scopeRef: ref("BUSINESS_OWNER", institutionId),
        permittedRoots: [{ entityType: "pe_deal", entityId: dealId }], rightsRef: `authority:${tenantId}:${rights}`,
        unit, currency: null, kind: "CUMULATIVE_EXPENDITURE", horizon: { startAt: resourceStart, periodMs: 3600000, periods: 2 },
        sourceRef: ref("BUSINESS_OWNER", "capacity:" + resourceId), asOf: resourceStart, knowledgeAt: resourceStart,
        validUntil: new Date(now + 2 * 3600000).toISOString(), beliefPins: [],
        availability: [{ amount, basis: "REPORTED_AVAILABLE" }, { amount, basis: "REPORTED_AVAILABLE" }, { amount, basis: "REPORTED_AVAILABLE" }],
        existingUse: ["0", "0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }), null);
    }

    const triggerBase = { kind: "trigger", triggerKind: "evidence_request_needed", registrationId, occurredAt, availableAt,
      requestText: `Provide the original signed evidence schedule ${tag}`, requiresAcceptedDeliverable: true };
    const sources = [
      { id: "crm-original", sourceClass: "crm_deals", rows: [{ id: "deal-A", kind: "entity", entityType: "deal", registrationId, name: `Z0 original ${tag}` }] },
      { id: "ledger-original", sourceClass: "financial_ledger", rows: [{ id: "balance-A", kind: "quantity", registrationId, factKey: "facility_balance",
        value: "20.00", currency: "USD", unit: "units", period: "2026-10", basis: "outstanding", occurredAt, availableAt }] },
      { id: "work-original", sourceClass: "work_tracking", rows: [0, ...(shape === "gated-two-supported-and-unresolved" ? [1] : [])].map(index => ({ id: `request-${index}`, ...triggerBase,
        ...(shape === "gated-two-supported-and-unresolved" ? { requestText: `${triggerBase.requestText} (${index})` } : {}),
        ...(workstreamExternalId ? { workstreamExternalId, requestedFromExternalId: recipientExternalId } : {}) })) },
    ];
    const bindings: Array<{ sourceClass: string; documentId: string; versionId: string; sha256: string }> = [];
    for (const source of sources) {
      const bytes = Buffer.from(JSON.stringify(source.rows));
      const version = await db.withTenantTransaction(tenantId, { userId }, async (tx: any) => {
        const document = await dataPlatform.createDocument(tx, { tenantId, kind: "source_export", title: `${source.id}-${tag}`,
          provenance: { sourceSystem: "owner-export", externalId: `${source.id}-${tag}`, createdBy: userId } });
        return dataPlatform.appendDocumentVersion(tx, { tenantId, documentId: document.documentId, bytes, mediaType: "application/octet-stream", format: "unknown",
          origin: "manual_upload", actor: userId, sourceSystem: "owner-export", sourceRef: `${source.id}-${tag}`, providerVersionId: "r1" });
      });
      bindings.push({ sourceClass: source.sourceClass, documentId: version.document_id, versionId: version.id, sha256: sha(bytes) });
    }

    const expiresAt = new Date(now + 2 * 3600000).toISOString();
    const supported = { id: "standing-request", triggerKind: "evidence_request_needed", operation: "create_deal_request", principalId: userId, deadlineAt: dutyDeadline, materiality: "material" };
    const unresolvedRule = { ...supported, id: "standing-transaction-approval", operation: "approve_transaction" };
    const rules = shape !== "partial-unresolved" ? [supported, unresolvedRule] : [supported];
    const mandate = await owner.operation("institution-mandate", { workId, institutionId, rules, expiresAt });
    if (mandate.status !== 200) throw Error("Z0_FIXTURE_MANDATE_" + mandate.status + ":" + JSON.stringify(mandate.body).slice(0, 200));
    const grantIds: string[] = [];
    for (const binding of bindings) {
      const registered = await owner.operation("institution-register-source", { workId, documentId: binding.documentId, documentVersionId: binding.versionId,
        sourceClass: binding.sourceClass, protocol: "json_records", purpose: "standing evidence responsibility", expiresAt });
      if (registered.status !== 200) throw Error("Z0_FIXTURE_REGISTER_SOURCE_" + registered.status + ":" + JSON.stringify(registered.body).slice(0, 200));
      grantIds.push(registered.body.id);
    }
    const metadata = await owner.operation("institution-sources", { workId });
    if (metadata.status !== 200) throw Error("Z0_FIXTURE_SOURCES_" + metadata.status);
    const submitted = await owner.operation("institution-submit", { workId, workInputId: metadata.body.workInputId, grantIds, idempotencyKey: `z0-original:${tag}:${randomUUID()}` });
    if (submitted.status !== 202) throw Error("Z0_FIXTURE_SUBMIT_" + submitted.status + ":" + JSON.stringify(submitted.body).slice(0, 300));
    const compilerRequestId = submitted.body.requestId as string;
    await record("parent-03-owner-inputs-and-submission", { mandate: mandate.status, grantIds, submitted: { status: submitted.status, requestId: compilerRequestId },
      mandateRules: rules.map(rule => rule.id) });

    const terminal = new Set(["CHECK_REJECTED", "FAILED", "UNKNOWN", "INVALIDATED", "CANCELLED", "OBSERVED"]);
    const cut = await waitFor("ORIGINAL_PARENT_QUIESCENT", options.timeoutMs ?? 900000, async () => {
      const row = (await sql.query(`SELECT r.status compiler_status,r.failure compiler_failure,r.program_id,r.episode_id,r.work_input_id,r.work_input_digest,
          p.status p1_status,p.failure p1_failure,p.head_id,p.plan_revision_id,
          (SELECT count(*)::int FROM finnor_os.jobs j WHERE j.tenant_id=r.tenant_id AND j.status IN('queued','running','quarantined')
            AND (j.payload->>'requestId'=r.id::text OR j.payload->>'programId'=r.program_id::text)) live
        FROM finnor_os.x1_compiler_requests r LEFT JOIN finnor_os.p1_requests p ON p.tenant_id=r.tenant_id AND p.id=r.program_id
        WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, compilerRequestId])).rows[0];
      if (!row) return null;
      if (terminal.has(row.compiler_status)) throw Error(`Z0_FIXTURE_TERMINAL_COMPILER_${row.compiler_status}:${row.compiler_failure ?? ""}`);
      if (row.program_id && ["FAILED", "INVALIDATED", "CANCELLED"].includes(row.p1_status)) throw Error(`Z0_FIXTURE_TERMINAL_PROGRAMME_${row.p1_status}:${row.p1_failure ?? ""}`);
      if (["WAITING", "PARTIAL"].includes(row.compiler_status) && row.program_id && row.head_id && row.p1_status === "PARTIAL" && row.live === 0) {
        if (shape !== "gated-two-supported-and-unresolved") return row;
        const body = (await sql.query("SELECT body FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=$2", [tenantId, row.head_id])).rows[0]?.body;
        const ids = (body?.nodes ?? []).filter((node: any) => node.action).map((node: any) => node.action.expectedEntityId);
        const states = ids.length ? (await sql.query("SELECT status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId, ids])).rows : [];
        if (states.length === 1 && states[0].status === "pending") return row;
        if (states.length > 1 || states.some((state: any) => state.status !== "pending")) throw Error(`Z0_FIXTURE_TERMINAL_GATED_SHAPE_${states.map((state: any) => state.status).join(",")}`);
      }
      return null;
    });
    const episode = (await sql.query("SELECT id,original_deadline,wall_deadline,parent_reservation,parent_demand FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2", [tenantId, cut.episode_id])).rows[0];
    const head = (await sql.query("SELECT body FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=$2", [tenantId, cut.head_id])).rows[0].body;
    const request = (await sql.query("SELECT request FROM finnor_os.p1_requests WHERE tenant_id=$1 AND id=$2", [tenantId, cut.program_id])).rows[0].request;
    const unresolved = (head.nodes as any[]).filter(node => !node.action);
    const supportedNodes = (head.nodes as any[]).filter(node => node.action);
    const gatedShape = shape === "gated-two-supported-and-unresolved";
    let selected = unresolved[0], gated: OriginalInstitutionParent["gated"];
    if (gatedShape) {
      if (supportedNodes.length !== 2) throw Error(`Z0_FIXTURE_TERMINAL_SUPPORTED_DUTY_COUNT_${supportedNodes.length}`);
      const rows = (await sql.query("SELECT id::text,status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenantId, supportedNodes.map(node => node.action.expectedEntityId)])).rows;
      const held = supportedNodes.find(node => rows.some((row: any) => row.id === node.action.expectedEntityId));
      selected = supportedNodes.find(node => node !== held);
      if (rows.length !== 1 || !held || !selected) throw Error(`Z0_FIXTURE_TERMINAL_GATED_DISPATCH_COUNT_${rows.length}`);
      gated = { heldIdentity: held.stableIdentity, heldActionId: held.action.expectedEntityId, heldActionStatus: rows[0].status,
        undispatchedActionId: selected.action.expectedEntityId, heldRequestText: held.action.payload.requestText,
        undispatchedRequestText: selected.action.payload.requestText, workstreamExternalId: workstreamExternalId!, recipientExternalId: recipientExternalId! };
    } else if (unresolved.length !== 1) throw Error(`Z0_FIXTURE_TERMINAL_UNRESOLVED_DUTY_COUNT_${unresolved.length}`);
    const duty = request.institution.responsibilities.find((item: any) => item.obligation.stableIdentity === selected.stableIdentity);
    if (!duty) throw Error("Z0_FIXTURE_TERMINAL_CHECKED_DUTY_MISSING");
    const iso = (value: unknown) => new Date(value as string | Date).toISOString();
    const deadlines = [iso(episode.original_deadline), iso(episode.wall_deadline), iso(duty.obligation.originalDeadline), iso(head.bounds.deadlineAt)];
    const jobs = (await sql.query(`SELECT id,type,status FROM finnor_os.jobs WHERE tenant_id=$1 AND (payload->>'requestId'=$2 OR payload->>'programId'=$3) ORDER BY run_at,id`,
      [tenantId, compilerRequestId, cut.program_id])).rows;
    const parent: OriginalInstitutionParent = { schema: "finnor.project-z.native.z0-original-parent.v1", tag, shape,
      tenantId, ownerId: userId, dealId, registrationId, institutionId, workId, workInputId: cut.work_input_id, workInputDigest: cut.work_input_digest,
      compilerRequestId, programId: cut.program_id, episodeId: episode.id, planRevisionId: cut.plan_revision_id, headId: cut.head_id,
      parentReservation: episode.parent_reservation, parentDemandDigest: episode.parent_demand.demandDigest, chargeScope: episode.parent_demand.chargeScope,
      responsibilityIdentity: selected.stableIdentity, supportedIdentities: supportedNodes.map(node => node.stableIdentity),
      originalDeadlineAt: deadlines[0]!, wallDeadlineAt: deadlines[1]!, dutyDeadlineAt: deadlines[2]!, programmeDeadlineAt: deadlines[3]!,
      deadlineAt: deadlines.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)), rightsRevision: rights, resources, grantIds,
      nativeStatus: { compiler: cut.compiler_status, programme: cut.p1_status, liveJobs: cut.live }, jobs, ...(gated ? { gated } : {}) };
    await record("parent-04-quiescent-original-parent", parent);
    return parent;
  } finally { await sql.end(); }
}

export interface AcquisitionOptions {
  record?: Recorder; privateRoot: string; timeoutMs?: number;
  /** Child allocation ceiling inside the original remaining (envelope 520 minus about 13 used by the compiler).
   * A full two-target, two-role exploration of the fake portal charges about 150 requests, so 128 exhausts it. */
  requestUnits?: number;
  /** Requested deadline cap in ms from now; the effective deadline never exceeds the original or the portal expiry. */
  deadlineCapMs?: number; idempotencyKey?: string;
  /** Refusal cases edit the otherwise valid owner request before it is sent. */
  mutate?: (request: Record<string, any>) => Record<string, any>;
  /** Send the request without any bearer (anonymous caller). */
  anonymous?: boolean;
}
export interface ModelReadyAcquisition {
  schema: "finnor.project-z.native.z0-acquisition.v1";
  parent: OriginalInstitutionParent; sessionId: string; status: string;
  portal: { origin: string; dir: string; expiresAt: string; applicationId: string; stop(): Promise<void> };
  profileIds: string[]; targets: unknown[]; request: Record<string, unknown>; deadlineAt: string;
  originalReservationRef: unknown; resourceDemand: unknown[];
  model: { ref: any; operations: number } | null; check: { ref: any; disposition: string } | null;
  acceptance: { eventId: string; acceptanceRef: any } | null;
  credentials: { applicationId: string; account: string; entity: string; recordIds: string[]; principalIds: Record<string, string> };
}

/** Prepare the disposable X2 portal + secret custody + profiles and submit the acquisition request. */
export async function submitInstitutionAcquisition(env: NativeEnvironment, parent: OriginalInstitutionParent, options: AcquisitionOptions,
  owner?: OwnerSession): Promise<{ response: { status: number; body: any }; request: Record<string, unknown>; handle: Omit<ModelReadyAcquisition, "model" | "check" | "acceptance" | "sessionId" | "status" | "parent"> }> {
  const record = options.record ?? noRecord;
  const session = owner ?? await signInOwner(env);
  const sql = await admin(env);
  try {
    const portalModule = await import("../../x2/fixtures/admin.mjs");
    const portalStore = await import("../../x2/fixtures/store.mjs");
    const unique = randomUUID().slice(0, 8);
    const dir = join(options.privateRoot, `portal-${parent.tag}-${unique}`);
    mkdirSync(options.privateRoot, { recursive: true, mode: 0o700 });
    await portalModule.initialize(dir, "api");
    const credentials = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    const portal = spawn(process.execPath, [join(here, "../../x2/fixtures/server.mjs"), "--private-dir", dir, "--port", "0"],
      { env: { PATH: process.env.PATH ?? "", LANG: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] });
    const origin: string = await new Promise((yes, no) => {
      const timer = setTimeout(() => no(Error("Z0_FIXTURE_PORTAL_READINESS_TIMEOUT")), 15000);
      portal.once("error", error => { clearTimeout(timer); no(error); });
      portal.stdout!.once("data", bytes => { clearTimeout(timer); yes(JSON.parse(bytes.toString()).origin); });
    });
    if (!origin.startsWith("http://127.0.0.1:")) throw Error("Z0_FIXTURE_PORTAL_NOT_LOOPBACK");
    const state = (await portalStore.snapshot(dir)).state;
    const secretRoot = env.FINNOR_X2_DISPOSABLE_SECRET_ROOT!;
    const tenantSecrets = join(secretRoot, parent.tenantId);
    mkdirSync(tenantSecrets, { recursive: true, mode: 0o700 }); chmodSync(tenantSecrets, 0o700);
    const profileIds: string[] = [];
    const recordIds = [credentials.recordIds.discoveryOne, credentials.recordIds.discoveryTwo];
    for (const [role, grantName] of [["editor", "discovery"], ["approver", "approval"]] as const) {
      const name = `${role}-${parent.tag}-${unique}`, accountId = randomUUID(), profileId = randomUUID();
      writeFileSync(join(tenantSecrets, name + ".json"), JSON.stringify({ applicationHeaders: JSON.stringify(
        { authorization: "Bearer " + credentials.tokens[role], "x-portal-grant": credentials.grantIds[grantName] }) }), { mode: 0o600, flag: "wx" });
      await sql.query("INSERT INTO finnor_os.application_accounts(id,tenant_id,account_key,application,provider,display_name,provider_account_ref,capabilities) VALUES($1,$2,$3,'x2_portal','x2_native','Disposable portal role',$4,'[\"application-operation-v1\"]')",
        [accountId, parent.tenantId, "x2-" + name, credentials.accounts.primary]);
      await sql.query("INSERT INTO finnor_os.auth_profiles(id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,credential_provider,credential_ref,auth_method,connection_status,capabilities,restrictions) VALUES($1,$2,$3,'employee',$4,$5,'application_semantics','disposable-private-file',$6,'application_headers','active','[\"application-operation-v1\"]',$7::jsonb)",
        [profileId, parent.tenantId, "x2-" + name, parent.ownerId, accountId, `finnor/tenants/${parent.tenantId}/x2/${name}`,
          JSON.stringify({ allowedActorIds: [parent.ownerId], allowedPurposes: ["application_semantics"], applicationSemantics: {
            sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", protectionDomain: "DISPOSABLE_TEST_AUTHORITY", origin,
            application: credentials.applicationId, account: credentials.accounts.primary, actingPrincipal: credentials.principalIds[role], role,
            validUntil: state.expiresAt, entrypoint: "/portal/records/{recordId}", documentationPaths: ["/openapi.json"], contextPath: "/api/context",
            recordPathTemplate: "/api/accounts/{accountId}/records/{recordId}", requestPathTemplate: "/api/requests/{requestId}",
            allowedTargets: recordIds, allowedEntities: [credentials.entities.usd], discoverySurface: "API" } })]);
      profileIds.push(profileId);
    }
    const reservation = (await sql.query("SELECT envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
      [parent.tenantId, (parent.parentReservation as any).id])).rows[0];
    const requestEnvelope = (reservation?.envelopes as any[] | undefined)?.find(envelope => envelope.unit === "request");
    if (!requestEnvelope) throw Error("Z0_FIXTURE_ORIGINAL_RESERVATION_REQUEST_ENVELOPE_MISSING");
    const resourceDemand = [{ resourceId: requestEnvelope.resourceId, unit: "request", amount: String(options.requestUnits ?? 480) }];
    const capMs = options.deadlineCapMs ?? 25 * 60000;
    const deadlineAt = new Date(Math.min(Date.parse(parent.deadlineAt), Date.parse(state.expiresAt) - 60000, Date.now() + capMs)).toISOString();
    const built: Record<string, any> = { root: { entityType: "pe_deal", entityId: parent.dealId }, workId: parent.workId, profileIds,
      targets: recordIds.map(id => ({ kind: "identity", application: credentials.applicationId, account: credentials.accounts.primary, entity: credentials.entities.usd, id })),
      resourceDemand, deadlineAt, idempotencyKey: options.idempotencyKey ?? `z0-acquire:${parent.tag}:${randomUUID()}`,
      institutionalOrigin: { compilerRequestId: parent.compilerRequestId, programId: parent.programId, responsibilityIdentity: parent.responsibilityIdentity } };
    const request = options.mutate ? options.mutate(built) : built;
    await record("acquisition-01-portal-and-profiles", { origin, expiresAt: state.expiresAt, profileIds, resourceDemand, deadlineAt,
      secretFilesMode: "0600", secretValuesRecorded: false });
    const response = await session.operation("application-acquire", request, options.anonymous ? null : undefined);
    await record("acquisition-02-request-and-response", { request, status: response.status, body: response.body });
    return { response, request, handle: { portal: { origin, dir, expiresAt: state.expiresAt, applicationId: credentials.applicationId,
      stop: async () => { if (portal.exitCode === null) { portal.kill("SIGTERM"); await new Promise(done => portal.once("exit", done)); } } },
      profileIds, targets: request.targets as unknown[], request, deadlineAt: String(request.deadlineAt ?? deadlineAt), originalReservationRef: parent.parentReservation, resourceDemand,
      credentials: { applicationId: credentials.applicationId, account: credentials.accounts.primary, entity: credentials.entities.usd, recordIds, principalIds: credentials.principalIds } } };
  } finally { await sql.end(); }
}

/**
 * Run the authenticated institution-origin acquisition until the worker has
 * produced the independently checked model and S4 has accepted it for the
 * original programme. A worker must be running.
 */
export async function driveAcquisitionToModelReady(env: NativeEnvironment, parent: OriginalInstitutionParent, options: AcquisitionOptions): Promise<ModelReadyAcquisition> {
  const record = options.record ?? noRecord;
  const owner = await signInOwner(env);
  const submitted = await submitInstitutionAcquisition(env, parent, options, owner);
  if (submitted.response.status !== 202) {
    await submitted.handle.portal.stop();
    throw Error(`Z0_FIXTURE_TERMINAL_ACQUIRE_${submitted.response.status}:${String(submitted.response.body?.code ?? JSON.stringify(submitted.response.body)).slice(0, 200)}`);
  }
  const sessionId = submitted.response.body.sessionId as string;
  const sql = await admin(env);
  try {
    const terminal = new Set(["FAILED", "STALE", "BLOCKED", "CANCELLED", "UNKNOWN"]);
    const row = await waitFor("MODEL_READY", options.timeoutMs ?? 1200000, async () => {
      const current = (await sql.query("SELECT status,reason,generation,model_ref,check_ref FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId])).rows[0];
      if (!current) return null;
      if (terminal.has(current.status)) throw Error(`Z0_FIXTURE_TERMINAL_SESSION_${current.status}:${current.reason ?? ""}`);
      return current.status === "MODEL_READY" ? current : null;
    }, 1500);
    const projection = await owner.operation("application-projection", { root: submitted.request.root, workId: parent.workId });
    const projected = projection.body?.sessions?.find((item: any) => item.id === sessionId || item.sessionId === sessionId) ?? projection.body?.sessions?.[0] ?? null;
    const accepted = await waitFor("S4_ACCEPTANCE", 120000, async () => (await sql.query(
      "SELECT event_id,body FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED'",
      [parent.tenantId, sessionId])).rows[0], 1000);
    const result: ModelReadyAcquisition = { schema: "finnor.project-z.native.z0-acquisition.v1", parent, sessionId, status: row.status, ...submitted.handle,
      model: projected?.model ? { ref: projected.model.ref, operations: projected.model.operations?.length ?? 0 } : null,
      check: projected?.check ? { ref: projected.check.ref, disposition: projected.check.disposition } : null,
      acceptance: { eventId: accepted.event_id, acceptanceRef: accepted.body?.detail?.acceptanceRef ?? null } };
    await record("acquisition-03-model-ready-and-accepted", { sessionId, status: row.status, model: result.model, check: result.check, acceptance: result.acceptance,
      projectionStatus: projection.status, projectionSha256: projection.bodySha256 });
    return result;
  } finally { await sql.end(); }
}

export interface ForeignIdentity { tenantId: string; userId: string; email: string; password: string; sameTenantAsOwner: boolean }

/**
 * A second authenticated identity for refusal cases: a real Auth user created through the Auth admin API plus the
 * tenant directory rows the product's own tenant-user path writes (users row matched by email; a new tenant is
 * configured for the private-equity vertical exactly like the other owner e2e fixtures). `tenantId` omitted creates an
 * unrelated tenant; naming the owner's tenant creates a different principal inside it.
 */
export async function createForeignIdentity(env: NativeEnvironment, options: { tenantId?: string } = {}): Promise<ForeignIdentity> {
  const { db } = await owners(env);
  const sql = await admin(env);
  try {
    const tag = randomUUID().slice(0, 8), email = `z0-foreign-${tag}@z0.example.test`, password = "Z0!" + randomUUID();
    const created = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, { method: "POST",
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY!, authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(30000) });
    if (created.status >= 300) throw Error("Z0_FIXTURE_FOREIGN_AUTH_USER_" + created.status);
    const tenantId = options.tenantId ?? randomUUID(), userId = randomUUID();
    if (!options.tenantId) await sql.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Z0 unrelated firm')", [tenantId, randomUUID()]);
    await sql.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Z0 foreign principal')", [userId, tenantId, email]);
    if (!options.tenantId) await db.configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: userId, sourceSystem: "Z0:foreign" });
    return { tenantId, userId, email, password, sameTenantAsOwner: Boolean(options.tenantId) };
  } finally { await sql.end(); }
}

export interface StandaloneApplicationWork { workId: string; resourceId: string; units: string; tenantId: string }

/**
 * An ordinary Work (no X1 mandate, no compiler episode) on the parent's deal with its OWN compute resource, created
 * through the same owner code the parent fixture uses. It lets the Z0 refusals be shown to be specific to X1 Works and
 * lets a lawful standalone X2 acquisition run beside the original parent. The resource is not the original reservation.
 */
export async function createStandaloneApplicationWork(env: NativeEnvironment, parent: OriginalInstitutionParent, options: { units?: string } = {}): Promise<StandaloneApplicationWork> {
  const { db, store, contracts } = await owners(env);
  const { tenantId, ownerId: userId, dealId } = parent;
  const ctx = { auth: { tenantId, userId, employeeId: userId, role: "owner" as const }, provenance: { sourceSystem: "existing-crm-owner", createdBy: userId } };
  const units = options.units ?? "520", tag = randomUUID().slice(0, 8);
  const intake = await db.receiveWork({ tenantId, userId, channel: "console", idempotencyKey: `z0-standalone-intake:${tag}:${randomUUID()}`,
    instruction: "Ordinary application-learning Work with no institutional mandate",
    activeContext: { entityType: "pe_deal", entityId: dealId }, authorityContext: { principalId: userId, scope: "DISPOSABLE_STANDALONE_APPLICATION_LEARNING_ONLY" } });
  const workId = intake.workId as string;
  await db.attachWorkEntity(tenantId, workId, { entityType: "pe_deal", entityId: dealId, source: "Z0:standalone-owner-registration" });
  const sql = await admin(env);
  try {
    const rights = String((await sql.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenantId])).rows[0].revision);
    const ref = (ownerName: string, id: string) => ({ owner: ownerName, id, version: "owner-fixture-v1", contentDigest: sha(id) });
    const resourceId = `z0-standalone-compute-${tag}`, start = new Date().toISOString(), until = new Date(Date.now() + 2 * 3600000).toISOString();
    await store.putAllocationResource(ctx, contracts.parseAllocationResource({ schema: "finnor.allocation-resource.v1", resourceId, resourceClass: "COMPUTE", tenantId,
      ownerRef: ref("BUSINESS_OWNER", userId), legalEntityRef: ref("S1", dealId), scopeRef: ref("BUSINESS_OWNER", "z0-standalone-" + tag),
      permittedRoots: [{ entityType: "pe_deal", entityId: dealId }], rightsRef: `authority:${tenantId}:${rights}`,
      unit: "request", currency: null, kind: "CUMULATIVE_EXPENDITURE", horizon: { startAt: start, periodMs: 3600000, periods: 2 },
      sourceRef: ref("BUSINESS_OWNER", "capacity:" + resourceId), asOf: start, knowledgeAt: start, validUntil: until, beliefPins: [],
      availability: [{ amount: units, basis: "REPORTED_AVAILABLE" }, { amount: units, basis: "REPORTED_AVAILABLE" }, { amount: units, basis: "REPORTED_AVAILABLE" }],
      existingUse: ["0", "0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }), null);
    return { workId, resourceId, units, tenantId };
  } finally { await sql.end(); }
}
