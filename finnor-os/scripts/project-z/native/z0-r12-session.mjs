/**
 * R12 primary-diligence native scenario (retained artifact finnor.project-z.z0-r12.v1).
 *
 * Launcher profile `v2`, started with --no-worker so this scenario owns (and can SIGKILL) the production worker.
 * Failure model and case ids: scope-z/phase-evidence/z0/r12-primary-diligence-failure-model.md.
 *
 * Owner rows are created only through owner code (authenticated HTTP or the same exported owner functions the
 * product calls). Direct SQL is limited to read-only observation and to disposable fixture inputs that no owner API
 * creates: the `native:p4` capacity row, external organizations, and a second tenant plus a second same-tenant
 * principal used only for the cross-scope refusal probes. Every case records PASS/FAIL/NOT_RUN and none is retried.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeEnvironment, signInOwner, startOwnedWorker } from "./x1-origin-fixture.mts";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "../../..");
const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("R12_SCENARIO_NATIVE_ENVIRONMENT_REQUIRED");
const env = readNativeEnvironment(state);
// Owner libraries read process.env when their pool is created, so bind before the first import.
for (const key of ["DATABASE_URL", "FINNOR_ENVIRONMENT", "FINNOR_P4_PROFILE", "FINNOR_V2_PROFILE", "FINNOR_PRIMARY_CREDENTIAL_DIRECTORY"])
  if (env[key] !== undefined) process.env[key] = env[key];
process.env.AUTH_DEV_BYPASS = "0";
if (env.FINNOR_V2_PROFILE !== "ordinary_disposable" || !env.FINNOR_PRIMARY_CREDENTIAL_DIRECTORY || !env.FINNOR_WORKER_DATABASE_URL)
  throw Error("R12_SCENARIO_REQUIRES_V2_PROFILE_AND_NO_WORKER_LAUNCH");
const credentialDirectory = env.FINNOR_PRIMARY_CREDENTIAL_DIRECTORY;
mkdirSync(evidence, { recursive: true });

const canon = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canon).join(",") + "]"
    : "{" + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ":" + canon(value[key])).join(",") + "}";
const sha = value => createHash("sha256").update(typeof value === "string" ? value : canon(value)).digest("hex");
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SENSITIVE = /token|secret|password|authorization|apikey|credential/i;
const redact = value => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE.test(key) && typeof item === "string" ? "[REDACTED]" : redact(item)]));
  return value;
};
const files = [];
let sequence = 0;
const record = (name, value) => {
  const file = `r12-${String(++sequence).padStart(3, "0")}-${name}.json`;
  const text = JSON.stringify(redact(value), (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
  writeFileSync(join(evidence, file), text, { mode: 0o600 });
  files.push({ file, sha256: sha(text) });
};
const results = [];
const checkpoint = () => writeFileSync(join(evidence, "r12-results-checkpoint.json"), JSON.stringify(redact(results), null, 2) + "\n", { mode: 0o600 });
async function runCase(id, title, body) {
  const started = new Date().toISOString();
  try {
    const out = await body();
    results.push({ id, title, outcome: out?.outcome ?? "PASS", started, finished: new Date().toISOString(), detail: redact(out?.detail ?? out ?? null) });
  } catch (error) {
    results.push({ id, title, outcome: "FAIL", started, finished: new Date().toISOString(), error: String(error?.message ?? error).slice(0, 900) });
  }
  record("case-" + id, results.at(-1));
  checkpoint();
  console.log(JSON.stringify({ case: id, outcome: results.at(-1).outcome, error: results.at(-1).error }));
}
const notRun = (id, title, reason) => { results.push({ id, title, outcome: "NOT_RUN", reason }); record("case-" + id, results.at(-1)); checkpoint(); };
const ensure = (condition, predicate) => { if (!condition) throw Error(predicate); };
async function waitFor(label, timeoutMs, probe, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw Error("R12_TIMEOUT_" + label);
    await sleep(everyMs);
  }
}

const { default: pg } = await import("pg");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await sql.connect();
const q = async (text, params = []) => (await sql.query(text, params)).rows;

const db = await import("@finnor/db");
const pe = await import("@finnor/private-equity");
const memory = await import("@finnor/memory");
const shared = await import("@finnor/shared-types");
const allocation = await import("../../../packages/private-equity/src/allocation-store");
const pstore = await import("../../../packages/private-equity/src/primary-diligence/store");
const runtime = await import("../../../packages/orchestration/src/operational-query-runtime");
const planModule = await import("../../../packages/private-equity/src/primary-diligence/plan");
const readerModule = await import("../../../packages/private-equity/src/primary-diligence/operational-query");
const fastLane = await import("../../../packages/orchestration/src/fast-read-lane");
const registryModule = await import("../../../packages/orchestration/src/plugin-registry");

// ---- processes the scenario owns: worker (real registration function) and the separate controlled source ----
const privateRoot = join(state, "r12-private");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const workerLog = join(privateRoot, "worker.log");
let worker = null;
const startWorker = async leaseSeconds => { worker = await startOwnedWorker(env, { logPath: workerLog, leaseSeconds, extraEnv: { FINNOR_V2_PROFILE: "ordinary_disposable", FINNOR_PRIMARY_CREDENTIAL_DIRECTORY: credentialDirectory } }); return worker; };
const LEASE_SECONDS = 20;

const sourceProcess = spawn(process.execPath, [...process.execArgv, join(backend, "scripts/v2/controlled-source.mts"), credentialDirectory],
  { cwd: backend, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
let sourceLog = "";
sourceProcess.stdout.on("data", chunk => { if (sourceLog.length < 65536) sourceLog += chunk; });
sourceProcess.stderr.on("data", chunk => { if (sourceLog.length < 65536) sourceLog += chunk; });
const accepted = [];
sourceProcess.on("message", message => { if (message?.type === "accepted") accepted.push({ requestId: message.requestId, at: Date.now() }); });
const publicDescriptor = await new Promise((yes, no) => {
  const timer = setTimeout(() => no(Error("R12_CONTROLLED_SOURCE_START_DEADLINE")), 30000);
  sourceProcess.on("message", message => { if (message?.type === "ready") { clearTimeout(timer); yes(message); } });
  sourceProcess.once("exit", () => no(Error("R12_CONTROLLED_SOURCE_START_FAILED")));
});
async function rpc(message) {
  const id = randomUUID();
  return new Promise((yes, no) => {
    const timer = setTimeout(() => { sourceProcess.off("message", listen); no(Error("R12_CONTROLLED_SOURCE_RPC_DEADLINE")); }, 15000);
    const listen = reply => { if (reply?.id !== id) return; clearTimeout(timer); sourceProcess.off("message", listen); yes(reply); };
    sourceProcess.on("message", listen);
    sourceProcess.send({ ...message, id });
  });
}
const sourceCalls = async f => (await rpc({ type: "inspect" })).calls.filter(call => f.sourceProfiles.some(profile => profile.profileId === call.sourceProfileId));

// ---- authenticated owner and disposable fixture ----
await startWorker(LEASE_SECONDS);
const owner = await signInOwner(env);
const { tenantId, userId } = owner;
const ctx = { auth: { tenantId, userId, employeeId: userId, role: "owner" }, provenance: { sourceSystem: "R12:native-scenario", createdBy: userId } };
const me = await owner.call("/api/me");
record("environment", { profile: "v2", apiOrigin: "http://127.0.0.1:3101", tenantId, userId, meStatus: me.status, workerPid: worker.pid,
  workerLeaseSeconds: LEASE_SECONDS, sourceOrigin: publicDescriptor.origin, node: process.version });
for (const route of ["primary-plan", "primary-open-work", "primary-submit", "primary-read", "primary-consume", "primary-governance-put", "primary-reserve-budget", "primary-cancel", "primary-advance", "primary-governance-revoke"])
  await owner.operation(route, {}).catch(() => null);
await owner.call("/api/queries", { intent: "work_list", openOnly: true }).catch(() => null);

const call = async (operation, body, expected) => {
  const result = await owner.operation(operation, body);
  if (expected !== undefined && result.status !== expected) throw Error(`R12_HTTP_${operation}_${result.status}_EXPECTED_${expected}: ${JSON.stringify(result.body).slice(0, 500)}`);
  return result;
};
const periodStart = "2025-01-01T00:00:00.000Z", periodEnd = "2025-12-31T23:59:59.000Z", validFrom = "2026-01-01T00:00:00.000Z";
const baseExpires = new Date(Date.now() + 3 * 3600000).toISOString();
const fixtureRef = (ownerName, id) => pstore.reference(ownerName, id, 1, { fixture: id, qualification: "SYNTHETIC_DEVELOPMENT_NOT_LIVE" });
const FACILITY_VALUE = "5000000", FACILITY_ID = "additional-facility-1";

await q("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p4',2,2,0,60,'explicit disposable R12 validation capacity; not protected funding') ON CONFLICT DO NOTHING");
const company = randomUUID();
await q("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'R12 target','other')", [company, tenantId, "r12-org-" + company]);
const strategy = await pe.createStrategy(ctx, { name: "R12 strategy" });
await pe.transitionStrategy(ctx, { strategyId: String(strategy.row.id), expectedVersion: 1, targetState: "active" });
const opportunity = await pe.createOpportunity(ctx, { strategyId: String(strategy.row.id), targetOrganizationId: company, name: "R12 opportunity" });
const root = { entityType: "pe_opportunity", entityId: String(opportunity.row.id) };
const investmentCase = await pe.createOpportunityInvestmentCase(ctx, { opportunityId: root.entityId, title: "R12 exact primary underwriting" });
const caseId = String(investmentCase.row.id);
await pe.activateInvestmentCase(ctx, { investmentCaseId: caseId, expectedVersion: 1 });
const startSource = await memory.createEvidenceSource(tenantId, { sourceKey: "r12-starting-management", sourceType: "manual", title: "R12 incomplete management support" });
const startVersion = await memory.appendEvidenceVersion(tenantId, startSource.id, { content: "Management support only; facility population unavailable.", snapshot: { note: "no facility identity" }, asOf: new Date(periodEnd) });
const rawStart = (await q("SELECT version_number,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2", [tenantId, startVersion.versionId]))[0];
const startingRef = { owner: "S1", id: startVersion.versionId, revision: String(rawStart.version_number), contentDigest: rawStart.content_hash };
const resourceRefs = [];
for (const [name, unit, resourceClass] of [["cash", "microUSD", "CASH"], ["cpu", "cpu-microseconds", "COMPUTE"]]) {
  const er = (ownerName, id) => ({ owner: ownerName, id, version: "1", contentDigest: sha({ syntheticFixture: id }) });
  const result = await allocation.putAllocationResource(ctx, { schema: "finnor.allocation-resource.v1", resourceId: "r12-" + name + "-" + randomUUID().slice(0, 8), tenantId,
    ownerRef: er("BUSINESS_OWNER", userId), legalEntityRef: er("BUSINESS_OWNER", company), scopeRef: er("BUSINESS_OWNER", root.entityId), permittedRoots: [root],
    rightsRef: "r12-resource-rights", unit, currency: unit === "microUSD" ? "USD" : null, kind: "CUMULATIVE_EXPENDITURE", resourceClass,
    horizon: { periods: 1, periodMs: 3 * 3600000, startAt: new Date().toISOString() }, sourceRef: er("BUSINESS_OWNER", "explicit-disposable-capacity"),
    asOf: new Date().toISOString(), knowledgeAt: new Date().toISOString(), validUntil: baseExpires, beliefPins: [],
    availability: [{ amount: "100000000000", basis: "REPORTED_AVAILABLE" }, { amount: "100000000000", basis: "REPORTED_AVAILABLE" }],
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }, null);
  resourceRefs.push({ owner: result.ref.owner, id: result.ref.id, revision: result.ref.version, contentDigest: result.ref.contentDigest });
}
record("fixture", { company, root, caseId, startingRef, resourceRefs, directSqlFixtureRows: ["compute_resource_policies native:p4", "external_organizations target"] });

/** One Work with its own exact governance set, S5 fixed budget and source profiles. Owner API only. */
async function build(options = {}) {
  const expiresAt = options.expiryMs ? new Date(Date.now() + options.expiryMs).toISOString() : baseExpires;
  const authorityId = randomUUID(), semanticsId = randomUUID(), mandateId = randomUUID(), grantId = randomUUID(), consentId = randomUUID(), profileId = randomUUID();
  const channel = "synthetic-lender-primary", decision = fixtureRef("BUSINESS_OWNER", "registered-primary-decision:" + root.entityId), pricebook = fixtureRef("S5", "synthetic-fixed-primary-pricebook");
  const put = async body => (await call("primary-governance-put", { root, body, expectedRef: null }, 201)).body.ref;
  const authority = { schema: "finnor.primary-authority.v1", profileId: authorityId, revision: 1, issuingPrincipalId: userId, legalEntityIds: [company], jurisdictions: ["SYNTHETIC_US"],
    instrumentAndTransactionClasses: ["SYNTHETIC_COMPANY_FINANCIAL_RECORDS"], activities: ["ACCESS_RECORDS", "INTERPRET", "CONTACT", "DISCLOSE"].map(activity => ({ activity, actorIds: [userId], channelIds: [channel] })),
    professionalRequirements: [], approvedTemplateRefs: [fixtureRef("S6", "fixed-primary-request-v1")], negotiationBoundsRef: null, disclosureRules: ["EXACT_ASSERTION_SCOPE_ONLY"],
    confidentialityRules: ["AUTHORIZED_COMPANY_SCOPE_ONLY"], contactLimits: { maximumRequests: 64, minimumSpacingMs: 0, suppressedParticipantIds: [] }, exposureLimitMicroUsd: "2000000",
    reservationRequired: true, approvalRef: fixtureRef("BUSINESS_OWNER", "synthetic-ordinary-source-approval"), validFrom, expiresAt, escalationConditions: ["UNAUTHORIZED_OR_UNRESOLVED"],
    revocationConditions: ["OWNER_REVOKED"], legalReviewEvidenceRefs: [fixtureRef("BUSINESS_OWNER", "synthetic-record-purpose-only")], policyRevision: "synthetic-1", environment: "DEVELOPMENT" };
  const authorityRef = await put(authority);
  const meaning = { schema: "finnor.primary-reference-semantics.v1", profileId: semanticsId, revision: 1, issuerId: userId, acceptedBy: userId, authorityRef, legalEntityId: company,
    rules: [{ field: "outstanding", recordKinds: ["FACILITY"], treatment: "EXACT_RECORDED_VALUE", requiredWitnessFields: ["ledgerState"], excludedInterpretations: ["ENTERPRISE_TOTAL_DEBT"] }],
    grossNetTreatment: "SOURCE_SIGNED_GROSS_CREDIT_SEPARATE", recognitionRule: "PERFORMANCE_REQUIRED_OWNER_PROFILE", calendarRef: "SYNTHETIC_2025_CALENDAR", consolidationRef: "STANDALONE_TARGET_ONLY",
    professionalReviewRef: null, environment: "DEVELOPMENT", validFrom, expiresAt };
  const semanticsRef = await put(meaning);
  const members = ["lender-participant-1"], rights = (await pstore.rightsBinding(ctx, root)).rightsRef;
  const sourceProfile = { schema: "finnor.primary-source-profile.v1", profileId, revision: 1, issuer: "Synthetic independent lender", system: "Synthetic issuer primary ledger", legalEntityId: company,
    sourceClass: "EXTERNAL_AUTHORITATIVE_RECORD", sourceControl: "EXTERNAL_ISSUER", accountOrParticipantIds: members, products: ["company-primary-records"], purpose: "PRIVATE_EQUITY_PRIMARY_DILIGENCE", channelId: channel,
    channelResolutionEvidenceRef: fixtureRef("S1", "synthetic-issuer-resolved-channel"), endpoint: publicDescriptor.origin + "/primary", responsePublicKeyPem: publicDescriptor.publicKey, credentialRef: "source-" + profileId,
    authoritativeFields: ["outstanding", "ledgerState"], respondentId: null, respondentRole: null, respondentKnowledge: [], respondentAuthorityRef: null, intermediary: null,
    availableHistory: { start: periodStart, end: periodEnd, reasons: [] }, observationPredicates: ["SIGNED_LEDGER_CUTOFF"], adapterVersion: "primary-records-http-v1", recovery: "IDEMPOTENT_REQUEST_WITH_STATUS",
    price: { pricebookRef: pricebook, maximumRequestMicroUsd: "50000", statusReadMicroUsd: "0" }, rightsRef: rights, authorityEvidenceRefs: [fixtureRef("S1", "synthetic-issuer-data-authority")],
    environment: "DEVELOPMENT", admissionRef: null, validFrom, expiresAt };
  const sourceProfileRef = await put(sourceProfile);
  const consent = { schema: "finnor.primary-consent.v1", consentId, revision: 1, issuerId: userId, authorizedActorId: userId, legalEntityId: company, sourceProfileIds: [profileId], accountOrParticipantIds: members,
    products: ["company-primary-records"], purposes: ["PRIVATE_EQUITY_PRIMARY_DILIGENCE"], periodStart, periodEnd, validFrom, expiresAt, rightsRef: rights,
    permissionEvidenceRef: fixtureRef("S1", "synthetic-company-record-consent"), retention: { rawUntil: expiresAt, derivativesUntil: expiresAt, retainAfterRevocation: true },
    disclosureRules: ["EXACT_ASSERTION_SCOPE_ONLY"], environment: "DEVELOPMENT" };
  const consentRef = await put(consent);
  const semantics = { legalEntityId: company, perimeter: [company], accountOrParticipantIds: members, periodStart, periodEnd, cutoff: periodEnd, currency: "USD", units: "dollars", scale: { numerator: "1", denominator: "1" },
    signConvention: "AS_RECORDED", basisRef: semanticsRef, grossNetTreatment: meaning.grossNetTreatment, recognitionRule: meaning.recognitionRule, calendarRef: meaning.calendarRef,
    consolidationRef: meaning.consolidationRef, timeBasis: "CUTOFF" };
  const assertion = { assertionId: randomUUID(), revision: 1, subject: { entityType: "external_organization", entityId: company },
    exactPredicate: "Establish outstanding liabilities in the exact permitted lender population, including facilities absent from management support.", predicateKind: "POPULATION_TOTAL",
    field: "outstanding", economicRecordIds: [], amountOrState: { kind: "UNKNOWN", reason: "NOT_IN_STARTING_SUPPORT" }, semantics, startingSupportRefs: [], knownGaps: ["MISSING_PERMITTED_PRIMARY_EVIDENCE"],
    materiality: { decisionRef: decision, rationale: "Material to the exact Opportunity underwriting dependency, not an enterprise-total inference", threshold: { numerator: "1", denominator: "1" },
      dependencyRefs: [fixtureRef("BUSINESS_OWNER", "scoped-underwriting:" + caseId)] },
    acceptableSourceClasses: ["EXTERNAL_AUTHORITATIVE_RECORD"], observationPredicates: ["SIGNED_LEDGER_CUTOFF"],
    requiredCoverage: { populationId: "permitted-lender-facilities", populationRevision: "population-v1", members, requiredRecordKinds: ["FACILITY"], completePopulation: true, measurementDesignRef: null,
      minimumCoverage: { numerator: "1", denominator: "1" }, errorTolerance: { numerator: "0", denominator: "1" } } };
  const originalDeadline = options.deadlineMs ? new Date(Date.now() + options.deadlineMs).toISOString() : expiresAt;
  const mandate = { schema: "finnor.primary-mandate.v1", mandateId, revision: 1, issuingPrincipalId: userId, legalEntityId: company,
    objective: "Actually acquire missing evidence and independently establish only registered scoped claims", permittedPurpose: "PRIVATE_EQUITY_PRIMARY_DILIGENCE", decisionRef: decision,
    authorityProfileId: authorityId, sourceProfileIds: [profileId], assertionIds: [assertion.assertionId],
    stopping: { maxAcquisitions: options.limitRequests ?? 32, deadline: originalDeadline, waitUntil: new Date(Math.min(Date.parse(originalDeadline), Date.now() + 180000)).toISOString(),
      stopOnRequiredCoverage: true, contradictionRevalidationRequired: true }, priorityRule: "MATERIAL_COVERAGE_PER_RESERVED_COST_THEN_DELAY", validFrom, expiresAt, environment: "DEVELOPMENT" };
  const mandateRef = await put(mandate);
  const reservation = options.sharedReservation ?? (await call("primary-reserve-budget", { root, resourceRefs, maximumMicroUsd: "2000000", maximumCpuMicros: "100000000", idempotencyKey: randomUUID(), validUntil: expiresAt }, 201)).body;
  const grant = { schema: "finnor.primary-grant.v1", grantId, revision: 1, issuingPrincipalId: userId, mandateId, legalEntityId: company, maximumMicroUsd: "2000000", maximumRequests: options.limitRequests ?? 32,
    maximumNativeCpuMicros: "100000000", maximumMemoryBytes: "536870912", maximumHumanSeconds: 0, maximumStoredBytes: 4194304,
    pricebook: { ref: pricebook, cpuMicroUsdPerSecond: { numerator: "1000", denominator: "1" }, storageMicroUsdPerByte: { numerator: "0", denominator: "1" }, orchestrationMicroUsdPerSecond: { numerator: "1000", denominator: "1" }, humanMicroUsdPerSecond: { numerator: "0", denominator: "1" } },
    reservationRef: reservation.reservationRef, retainedObligationRefs: [], expiresAt, environment: "DEVELOPMENT" };
  const budgetGrantRef = await put(grant);
  const credential = randomBytes(24).toString("base64url");
  writeFileSync(join(credentialDirectory, sourceProfile.credentialRef), credential, { mode: 0o600 });
  const facility = { issuerRecordId: "issuer-" + FACILITY_ID, economicId: FACILITY_ID, revision: 1, kind: "FACILITY", legalEntityId: company, accountOrParticipantId: members[0], periodStart, periodEnd, currency: "USD", units: "dollars",
    basisDigest: semanticsRef.contentDigest, state: "POSTED", replacesEconomicId: null, reversesEconomicId: null, aliasOf: null, effectiveAt: periodEnd, observedAt: validFrom,
    fields: { outstanding: { kind: "EXACT", quantity: { numerator: FACILITY_VALUE, denominator: "1" } } },
    witnessFields: { ledgerState: "POSTED", performance: "NOT_ESTABLISHED", recognition: meaning.recognitionRule, cutoff: periodEnd, grossNetTreatment: meaning.grossNetTreatment, nonRevenueExclusions: "NOT_ESTABLISHED" }, relatedParty: "NO" };
  await rpc({ type: "configure", profiles: [{ public: sourceProfile, credential, records: [facility], recordKinds: ["FACILITY"], ...(options.source ?? {}) }] });
  const opened = (await call("primary-open-work", { root, instruction: assertion.exactPredicate, idempotencyKey: randomUUID() }, 201)).body;
  const intake = { schema: "finnor.primary-diligence.v1", root, workId: opened.workId, expectedWorkInputId: opened.workInputId, idempotencyKey: randomUUID(), assertions: [assertion],
    startingEvidenceRefs: [startingRef], mandateRef, authorityProfileRef: authorityRef, budgetGrantRef, sourceProfileRefs: [sourceProfileRef], consentRefs: [consentRef],
    referenceSemanticsRefs: [semanticsRef], predecessorRef: null, mode: "ordinary_disposable" };
  return { intake, assertion, sourceProfiles: [sourceProfile], sourceProfile, credential, consentRef, authorityRef, semanticsRef, budgetGrantRef, mandateRef, reservation, originalDeadline,
    workId: opened.workId, workInputId: opened.workInputId, expiresAt };
}

const TERMINAL = new Set(["COMPLETE", "BLOCKED", "STOPPED", "FAILED"]);
async function submit(f) {
  const result = (await call("primary-submit", f.intake, 202)).body;
  f.programmeId = result.programmeId;
  return result;
}
async function awaitProgramme(f, timeoutMs = 240000) {
  let last = null;
  await waitFor("programme_terminal:" + f.programmeId, timeoutMs, async () => {
    const read = await call("primary-read", { programmeId: f.programmeId });
    last = read.body;
    return read.status === 200 && TERMINAL.has(read.body.status);
  }, 2000);
  return last;
}
async function plan(f, expected = 201) {
  const result = await call("primary-plan", f.intake, expected);
  return result;
}
const loopOf = async workId => (await q("SELECT id::text,state,revision,step_count,query_count,deadline_at FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId]))[0] ?? null;
const executionsOf = async workId => await q("SELECT intent,status,result_summary,failure,started_at FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND intent='primary_diligence_v1' ORDER BY started_at", [tenantId, workId]);
const planRevisions = async workId => Number((await q("SELECT count(*)::int n FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId]))[0].n);
const consumersOf = async findingId => await q("SELECT consumer_type,consumer_id::text FROM finnor_os.v2_consumer_dependencies WHERE tenant_id=$1 AND finding_id=$2", [tenantId, findingId]);
const latestInput = async workId => (await q("SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, workId]))[0]?.id;
const reservationDigest = async () => (await q("SELECT count(*)::int n, md5(coalesce(string_agg(reservation_id||status,'|' ORDER BY reservation_id),'')) d FROM finnor_os.s5_reservations WHERE tenant_id=$1", [tenantId]))[0];

/** The reader exactly as the native objective controller calls it (principal and latest Work input from the loop). */
async function probe(workId, options = {}) {
  const t = options.tenantId ?? tenantId, u = options.userId ?? userId;
  const workInputId = options.workInputId ?? await latestInput(workId);
  return runtime.executeTenantOperationalQuery(t, { intent: "primary_diligence_v1", workId }, { userId: u, employeeId: u, workId, workInputId, executionKey: "r12-probe:" + randomUUID() });
}
async function makeModel(f, finding) {
  const scope = shared.PrimaryUnderwritingScopeSchema.parse({ predicateKind: f.assertion.predicateKind, field: f.assertion.field, economicRecordIds: f.assertion.economicRecordIds, semantics: f.assertion.semantics,
    requiredCoverage: f.assertion.requiredCoverage, acceptableSourceClasses: f.assertion.acceptableSourceClasses });
  scope.predicateKind = "RECORD_VALUE"; scope.economicRecordIds = [FACILITY_ID];
  const base = { valueType: "decimal", unit: "money", currency: "USD", shape: "scalar" };
  const model = await pe.createUnderwritingModel(ctx, { investmentCaseId: caseId, modelKey: "r12-" + randomUUID(), name: "Exact primary scope, not enterprise-total debt" });
  const version = await pe.createUnderwritingModelVersion(ctx, { modelId: String(model.id), definition: { schemaVersion: "underwriting-model-ir.v1", modelKey: String(model.modelKey ?? model.model_key), modelVersion: "1",
    financialConventionVersion: "finnor-pe-lbo/1.0.0", minimumEngineVersion: "finnor-underwriting-engine/1.0.0", periodDefinition: { frequency: "annual", forecastStart: "2026-01-01", count: 1 },
    nodes: [{ id: "facility", kind: "input", ...base, dependencies: [], required: true, allowedTruthClasses: ["OBSERVED_FACT"], source: { kind: "explicit" }, primaryEvidenceScope: scope },
      { id: "scoped_output", kind: "output", ...base, dependencies: ["facility"], sourceNodeId: "facility" }], circularBlocks: [] } });
  return String(version.id);
}
async function consume(f, finding, overrides = {}) {
  f.modelVersionId ??= await makeModel(f, finding);
  const body = { investmentCaseId: caseId, modelVersionId: f.modelVersionId, worldAt: f.worldAt ??= new Date().toISOString(), idempotencyKey: f.consumeKey ??= randomUUID(), workId: f.workId,
    bindings: { facility: { findingId: finding.artifactId, economicId: FACILITY_ID } }, ...overrides };
  return call("primary-consume", body);
}
const secrets = []; // strings that must never appear in any reader output
const privateStrings = f => [FACILITY_VALUE, FACILITY_ID, "establishedValueOrInterval", f.credential];
const leaks = (value, strings) => strings.filter(text => JSON.stringify(value).includes(text));
const finishFlow = async (f, options = {}) => {
  if (options.plan) f.plan = (await plan(f)).body;
  await submit(f);
  f.read = await awaitProgramme(f);
  return f;
};

// ============================ cases ============================
let main = null, mainRun = null, mainFinding = null, mainDigest = null, mainProbes = [];

await runCase("R12-01", "AFTER side: typed intent registered in the planner registry; direct HTTP typed query refused as native-only", async () => {
  const registry = registryModule.createDefaultPluginRegistry();
  const capabilities = registryModule.planningCapabilitiesForVertical(registry, "private_equity").map(c => c.capability);
  ensure(capabilities.includes("query:primary_diligence_v1"), "CAPABILITY_ABSENT_AFTER_CHANGE");
  const workId = (await call("primary-open-work", { root, instruction: "R12 unplanned Work", idempotencyKey: randomUUID() }, 201)).body.workId;
  const direct = await owner.call("/api/queries", { intent: "primary_diligence_v1", workId });
  const anonymous = await owner.call("/api/queries", { intent: "primary_diligence_v1", workId }, { bearer: null });
  ensure(direct.status >= 400 && direct.status < 500 && JSON.stringify(direct.body).includes("NATIVE_ORIGINAL_WORK_OWNER_REQUIRED"), "DIRECT_QUERY_NOT_REFUSED_AS_NATIVE_ONLY_" + direct.status);
  ensure(anonymous.status === 401, "ANONYMOUS_QUERY_NOT_401_" + anonymous.status);
  const none = Number((await q("SELECT count(*)::int n FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId]))[0].n);
  ensure(none === 0, "REFUSED_QUERY_CREATED_EXECUTION_ROW");
  return { detail: { capabilityListed: true, directStatus: direct.status, directBody: direct.body, anonymousStatus: anonymous.status, executionRows: none, before: "see the base-tree run wr12-before artifact" } };
});

await runCase("R12-02", "Unplanned/unstarted Work: typed result is partial, never ok, no programme digest", async () => {
  const f = await build();
  const before = await probe(f.workId);
  ensure(before.status === "partial" && before.data.nativeOwnerConsumed === false && before.data.current === false && before.data.programmeId === null && before.data.definitionDigest === null, "UNSTARTED_NOT_PARTIAL:" + JSON.stringify(before.data));
  ensure(await planRevisions(f.workId) === 0 && !(await loopOf(f.workId)), "UNPLANNED_WORK_HAS_PLAN_OR_LOOP");
  ensure(Number((await q("SELECT count(*)::int n FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND work_id=$2", [tenantId, f.workId]))[0].n) === 0, "PROGRAMME_PREEXISTS");
  main = f;
  return { detail: { workId: f.workId, status: before.status, data: before.data } };
});
const unplannedWork = main.workId;

// ---- main chain on a fresh Work (R12-03, 04, 05, 17, 18, 19, 25, 29, 30, 09) ----
await runCase("R12-03", "Full chain: plan -> submit -> worker -> independent checker -> consume -> wake -> objective success", async () => {
  const f = await build();
  main = f;
  const planned = await plan(f);
  const waiting = await loopOf(f.workId);
  ensure(waiting?.state === "waiting" && Number(waiting.step_count) === 0, "LOOP_NOT_WAITING_BEFORE_SUBMIT:" + JSON.stringify(waiting));
  const replayPlan = await plan(f);
  ensure(replayPlan.body.replayed === true && await planRevisions(f.workId) === 1, "PLAN_REPLAY_NOT_IDEMPOTENT");
  const submitted = await submit(f);
  const replay = (await call("primary-submit", f.intake, 202)).body;
  ensure(replay.replayed === true && replay.programmeId === submitted.programmeId, "SUBMIT_REPLAY_NOT_IDEMPOTENT");
  const jobs = await q("SELECT id::text,status,claim_fence,retry_safety FROM finnor_os.jobs WHERE tenant_id=$1 AND type='advance_primary_diligence_v1' AND payload->>'programmeId'=$2", [tenantId, submitted.programmeId]);
  ensure(jobs.length === 1, "DUPLICATE_SUBMIT_CREATED_JOB_ROWS_" + jobs.length);
  f.read = await awaitProgramme(f);
  ensure(f.read.status === "COMPLETE", "PROGRAMME_NOT_COMPLETE:" + f.read.status + ":" + f.read.reason);
  const finding = f.read.findings[0];
  ensure(finding.conclusion === "SUPPORTED" && finding.establishedValueOrInterval.kind === "EXACT" && finding.establishedValueOrInterval.quantity.numerator === FACILITY_VALUE && finding.establishedValueOrInterval.quantity.denominator === "1", "FINDING_VALUE_MISMATCH");
  ensure(JSON.stringify(finding.observedPopulationAndCoverage.selectedEconomicIds) === JSON.stringify([FACILITY_ID]), "SELECTED_RECORD_MISMATCH");
  const calls = await sourceCalls(f);
  const posts = calls.filter(c => c.operation === "ACQUIRE");
  ensure(posts.length === 1, "SOURCE_ACQUIRE_COUNT_" + posts.length);
  const checks = await q("SELECT count(*)::int n FROM finnor_os.v2_claim_checks WHERE tenant_id=$1 AND programme_id=$2", [tenantId, submitted.programmeId]);
  ensure(checks[0].n >= 1, "NO_INDEPENDENT_CHECK_ROW");
  // R12-04: the loop is still waiting and has observed nothing before the owner consumed the finding.
  const stillWaiting = await loopOf(f.workId);
  const earlyExecutions = await executionsOf(f.workId);
  ensure(stillWaiting.state === "waiting" && earlyExecutions.length === 0, "LOOP_ADVANCED_BEFORE_CONSUMPTION:" + JSON.stringify({ stillWaiting, earlyExecutions: earlyExecutions.length }));
  main.beforeConsumeLoop = stillWaiting;
  // R12-25: COMPLETE programme with a current finding but no consumer row must not read as consumed.
  const unconsumed = await probe(f.workId);
  ensure(unconsumed.data.current === true && unconsumed.data.nativeOwnerConsumed === false && unconsumed.status === "partial" && unconsumed.data.underwritingRunId === null, "READER_CONSUMED_WITHOUT_OWNER_ROW:" + JSON.stringify(unconsumed.data));
  ensure((await consumersOf(finding.artifactId)).length === 0, "CONSUMER_ROW_PREEXISTS");
  mainProbes.push(unconsumed);
  const consumed = await consume(f, finding);
  ensure(consumed.status === 200 && consumed.body.id, "CONSUME_NOT_200:" + consumed.status + JSON.stringify(consumed.body).slice(0, 300));
  mainRun = consumed.body; mainFinding = finding;
  ensure(consumed.body.objectiveWake?.woken === true, "WAKE_NOT_FIRED:" + JSON.stringify(consumed.body.objectiveWake));
  const done = await waitFor("objective_completed", 180000, async () => (await loopOf(f.workId))?.state === "completed", 2000).then(() => loopOf(f.workId));
  const executions = await executionsOf(f.workId);
  ensure(executions.some(e => e.status === "succeeded" && e.result_summary?.nativeOwnerConsumed === true && e.result_summary?.current === true), "NO_SUCCEEDED_NATIVE_QUERY_EXECUTION");
  const rows = await consumersOf(finding.artifactId);
  ensure(rows.length === 1 && rows[0].consumer_id === consumed.body.id && rows[0].consumer_type === "underwriting_run", "CONSUMER_ROW_MISMATCH");
  const run = (await q("SELECT work_id::text,status FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2", [tenantId, consumed.body.id]))[0];
  ensure(run?.work_id === f.workId, "RUN_WORK_MISMATCH");
  const after = await probe(f.workId);
  ensure(after.status === "ok" && after.data.nativeOwnerConsumed === true && after.data.current === true && after.data.status === "COMPLETE" && after.data.underwritingRunId === consumed.body.id, "READER_NOT_OK_AFTER_CONSUMPTION:" + JSON.stringify(after.data));
  mainDigest = sha(f.intake);
  mainProbes.push(after);
  const charges = await q("SELECT count(*)::int n, coalesce(sum(actual_micro_usd::numeric),0)::text micro_usd, coalesce(sum(actual_cpu_micros::numeric),0)::text cpu_micros FROM finnor_os.s5_primary_charges WHERE tenant_id=$1 AND programme_id=$2", [tenantId, submitted.programmeId]);
  return { detail: { workId: f.workId, planRevision: planned.body.workRevisionRef, loopBefore: waiting, loopAfter: done, programmeId: submitted.programmeId, jobs, sourceCalls: calls.map(c => c.operation),
    finding: { conclusion: finding.conclusion, value: finding.establishedValueOrInterval, selected: finding.observedPopulationAndCoverage.selectedEconomicIds, digest: finding.contentDigest },
    runId: consumed.body.id, objectiveWake: consumed.body.objectiveWake, consumerRows: rows, executions: executions.map(e => ({ status: e.status, summary: e.result_summary })), readerAfter: after.data, readerStatusAfter: after.status,
    costReceipts: f.read.costReceipts, chargesFromDb: charges[0], independentExpected: { value: FACILITY_VALUE, selectedRecord: FACILITY_ID, provenance: "O-INPUT: scenario-authored controlled-source record" } } };
});
if (!mainRun) {
  record("summary", { results, note: "main chain failed; dependent cases not run" });
}

await runCase("R12-04", "Success reached by the owner wake: loop waited at zero iterations until consume; completed only afterwards", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const before = main.beforeConsumeLoop, now = await loopOf(main.workId);
  ensure(before.state === "waiting" && Number(before.step_count) === 0 && now.state === "completed", "LOOP_HISTORY_MISMATCH");
  const stepRows = await q("SELECT step_number,created_at FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number", [tenantId, now.id]).catch(() => []);
  const consumedAt = (await q("SELECT created_at FROM finnor_os.v2_consumer_dependencies WHERE tenant_id=$1 AND consumer_id=$2", [tenantId, mainRun.id]))[0].created_at;
  ensure(stepRows.every(row => new Date(row.created_at) >= new Date(consumedAt)), "OBJECTIVE_STEP_BEFORE_CONSUMER_ROW");
  return { detail: { loopBefore: before, loopAfter: now, consumerRowAt: consumedAt, steps: stepRows.length } };
});

await runCase("R12-05", "No private finding values, record ids or credentials in any reader output or persisted summary", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const strings = privateStrings(main);
  const executions = await executionsOf(main.workId);
  const surfaces = { probes: mainProbes.map(p => p), summaries: executions.map(e => e.result_summary) };
  const found = leaks(surfaces, strings);
  ensure(found.length === 0, "PRIVATE_STRING_LEAKED:" + found.map(s => s.length > 12 ? s.slice(0, 4) + "..." : s).join(","));
  return { detail: { searched: strings.map(s => s === main.credential ? "[source credential]" : s), surfaces: Object.keys(surfaces), probes: mainProbes.length, summaries: executions.length } };
});

await runCase("R12-29", "definitionDigest equals the independently computed digest of the accepted intake and the owner row", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const row = (await q("SELECT intake_digest FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND id=$2", [tenantId, main.programmeId]))[0];
  const reply = mainProbes.at(-1).data.definitionDigest;
  ensure(reply === row.intake_digest, "READER_DIGEST_NOT_OWNER_ROW");
  ensure(reply === mainDigest, "READER_DIGEST_NOT_INDEPENDENT_INTAKE_DIGEST:" + reply + "!=" + mainDigest);
  const criterion = (await q("SELECT goal_spec FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2", [tenantId, main.workId]))[0].goal_spec.criteria
    .find(c => c.criterion?.assertion?.path?.join(".") === "data.definitionDigest");
  ensure(criterion.criterion.assertion.expected === mainDigest, "PLAN_CRITERION_DIGEST_MISMATCH");
  return { detail: { independent: mainDigest, owner: row.intake_digest, reader: reply, provenance: "O-INPUT: sha256 of the scenario's own canonical form of the submitted intake" } };
});

await runCase("R12-17", "Duplicate primary-consume with the same key replays: one run, one consumer row, no double use", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const again = await consume(main, mainFinding);
  ensure(again.status === 200 && again.body.id === mainRun.id, "REPLAY_DID_NOT_RETURN_SAME_RUN:" + again.status + JSON.stringify(again.body).slice(0, 200));
  const runs = Number((await q("SELECT count(*)::int n FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND work_id=$2", [tenantId, main.workId]))[0].n);
  const rows = await consumersOf(mainFinding.artifactId);
  ensure(runs === 1 && rows.length === 1, `DOUBLE_USE runs=${runs} consumers=${rows.length}`);
  return { detail: { replayStatus: again.status, runId: again.body.id, runs, consumerRows: rows.length, objectiveWake: again.body.objectiveWake } };
});

await runCase("R12-18", "Same idempotency key with changed world time is refused and changes nothing", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const changed = await consume(main, mainFinding, { worldAt: new Date(Date.parse(main.worldAt) + 86400000).toISOString() });
  ensure(changed.status >= 400 && changed.status < 500, "CHANGED_REPLAY_NOT_REFUSED_" + changed.status + JSON.stringify(changed.body).slice(0, 200));
  const runs = Number((await q("SELECT count(*)::int n FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND work_id=$2", [tenantId, main.workId]))[0].n);
  const rows = await consumersOf(mainFinding.artifactId);
  ensure(runs === 1 && rows.length === 1, "CHANGED_REPLAY_CREATED_ROWS");
  return { detail: { status: changed.status, body: changed.body, runs, consumerRows: rows.length } };
});

await runCase("R12-19", "Duplicate submit/job delivery: one programme, one job, one physical request", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const jobs = await q("SELECT id::text,status,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND type='advance_primary_diligence_v1' AND payload->>'programmeId'=$2", [tenantId, main.programmeId]);
  const programmes = Number((await q("SELECT count(*)::int n FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND work_id=$2", [tenantId, main.workId]))[0].n);
  const posts = (await sourceCalls(main)).filter(c => c.operation === "ACQUIRE");
  ensure(jobs.length === 1 && programmes === 1 && posts.length === 1, `DUPLICATE jobs=${jobs.length} programmes=${programmes} posts=${posts.length}`);
  return { outcome: "PASS", detail: { jobs, programmes, acquirePosts: posts.length, note: "duplicate submit replay proven in R12-03; a second physical delivery of the same job row is not forced here (claim fence is exercised by R12-20)" } };
});

await runCase("R12-09", "Malformed/extra envelope fields and forged reader fields are refused before any reader runs", async () => {
  const workId = unplannedWork;
  const bad = [
    { intent: "primary_diligence_v1", workId, extra: 1 }, { intent: "primary_diligence_v1" }, { intent: "primary_diligence_v1", workId: "not-a-uuid" },
    { intent: "PRIMARY_DILIGENCE_V1", workId }, { intent: "primary_diligence_v1", workId, root }, { intent: "primary_diligence_v1", workId: [workId] },
    { intent: "primary_diligence_v1", workId, data: { current: true, nativeOwnerConsumed: true } },
  ];
  const outcomes = bad.map(input => ({ input: canon(input).slice(0, 160), result: fastLane.validateOperationalQueryRequest(input).success }));
  ensure(outcomes.every(o => o.result === false), "MALFORMED_ENVELOPE_ACCEPTED:" + JSON.stringify(outcomes));
  ensure(fastLane.validateOperationalQueryRequest({ intent: "primary_diligence_v1", workId }).success === true, "EXACT_ENVELOPE_REFUSED");
  const readerRefusals = [];
  for (const input of bad.slice(0, 3)) {
    const refused = await readerModule.executePrimaryDiligenceQuery(tenantId, input, { userId, employeeId: userId, workId, workInputId: await latestInput(workId) }).then(() => false, () => true);
    readerRefusals.push(refused);
  }
  ensure(readerRefusals.every(Boolean), "READER_ACCEPTED_NON_STRICT_REQUEST");
  const http = [];
  for (const input of bad) { const r = await owner.call("/api/queries", input); http.push(r.status); }
  ensure(http.every(s => s >= 400 && s < 500), "HTTP_MALFORMED_NOT_4XX:" + http.join(","));
  const rows = Number((await q("SELECT count(*)::int n FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId]))[0].n);
  ensure(rows === 0 || rows === (await executionsOf(workId)).length, "REFUSED_REQUEST_CREATED_EXECUTION");
  return { detail: { outcomes, readerRefusals, httpStatuses: http, executionRows: rows } };
});

// ---- identity and scope (R12-06, 07, 08, 10) ----
const otherTenant = randomUUID(), otherTenantUser = randomUUID(), otherPrincipal = randomUUID();
await q("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'R12 other tenant')", [otherTenant, randomUUID()]);
await q("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','R12 other tenant owner'),($4,$5,$6,'owner','active','R12 other principal')",
  [otherTenantUser, otherTenant, otherTenantUser + "@test.invalid", otherPrincipal, tenantId, otherPrincipal + "@test.invalid"]);
await db.configureTenantVertical({ tenantId: otherTenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: otherTenantUser, sourceSystem: "R12:disposable-fixture" });

await runCase("R12-06", "Wrong Work (same owner, different Work with no programme) never reports another Work's digest", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const reply = await probe(unplannedWork);
  ensure(reply.status === "partial" && reply.data.definitionDigest === null && reply.data.programmeId === null && reply.data.nativeOwnerConsumed === false, "WRONG_WORK_LEAK:" + JSON.stringify(reply.data));
  ensure(!JSON.stringify(reply).includes(mainDigest), "OTHER_WORK_DIGEST_PRESENT");
  const swapped = await runtime.executeTenantOperationalQuery(tenantId, { intent: "primary_diligence_v1", workId: unplannedWork },
    { userId, employeeId: userId, workId: main.workId, workInputId: await latestInput(main.workId) }).then(() => "ACCEPTED", error => String(error.message).slice(0, 120));
  ensure(swapped !== "ACCEPTED", "CONTEXT_WORK_MISMATCH_ACCEPTED");
  return { detail: { wrongWork: unplannedWork, status: reply.status, data: reply.data, mismatchedContext: swapped } };
});

await runCase("R12-07", "Other tenant cannot read the first tenant's Work", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const input = await latestInput(main.workId);
  const outcome = await probe(main.workId, { tenantId: otherTenant, userId: otherTenantUser, workInputId: input }).then(r => ({ status: r.status, data: r.data }), error => ({ refused: String(error.message).slice(0, 160) }));
  ensure(outcome.refused || (outcome.data.programmeId === null && outcome.data.definitionDigest === null && outcome.data.nativeOwnerConsumed === false), "CROSS_TENANT_DATA:" + JSON.stringify(outcome));
  ensure(!JSON.stringify(outcome).includes(mainDigest), "CROSS_TENANT_DIGEST_PRESENT");
  const foreignRows = Number((await q("SELECT count(*)::int n FROM finnor_os.work_query_executions WHERE tenant_id=$1", [otherTenant]))[0].n);
  return { detail: { outcome, executionRowsInOtherTenant: foreignRows, limitation: "second tenant is a disposable fixture without an Auth identity: the probe is in-process with that tenant's owner context; HTTP-as-other-tenant is NOT_RUN" } };
});

await runCase("R12-08", "Other principal in the same tenant: reader and plan refuse", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const input = await latestInput(main.workId);
  const read = await probe(main.workId, { userId: otherPrincipal, workInputId: input }).then(r => ({ status: r.status, data: r.data }), error => ({ refused: String(error.message).slice(0, 160) }));
  ensure(read.refused || (read.data.programmeId === null && read.data.definitionDigest === null && read.data.nativeOwnerConsumed === false), "OTHER_PRINCIPAL_DATA:" + JSON.stringify(read));
  const otherCtx = { auth: { tenantId, userId: otherPrincipal, employeeId: otherPrincipal, role: "owner" }, provenance: { sourceSystem: "R12:other-principal", createdBy: otherPrincipal } };
  const before = await planRevisions(main.workId);
  const planned = await planModule.selectPrimaryPlan(otherCtx, main.intake).then(() => "ACCEPTED", error => String(error.message).slice(0, 160));
  ensure(planned !== "ACCEPTED" && await planRevisions(main.workId) === before, "OTHER_PRINCIPAL_PLAN_ACCEPTED");
  return { detail: { read, planRefusal: planned, limitation: "second principal has no Auth identity: in-process owner context; HTTP-as-other-principal is NOT_RUN" } };
});

await runCase("R12-30", "Reader output is derived from owner rows: forged request data is ignored/refused", async () => {
  const forged = await owner.call("/api/queries", { intent: "primary_diligence_v1", workId: unplannedWork, data: { current: true, nativeOwnerConsumed: true, status: "COMPLETE" } });
  ensure(forged.status >= 400 && forged.status < 500, "FORGED_PAYLOAD_ACCEPTED_" + forged.status);
  const reply = await probe(unplannedWork);
  ensure(reply.data.current === false && reply.data.nativeOwnerConsumed === false, "READER_TRUSTED_PAYLOAD");
  return { detail: { forgedStatus: forged.status, reader: reply.data } };
});

// ---- drift after success ----
await runCase("R12-13", "Governance revoked AFTER use: reader goes non-current although the consumer row remains", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const revoked = await call("primary-governance-revoke", { root, ref: main.consentRef, reason: "R12_CONSENT_REVOKED_AFTER_USE" }, 200);
  const reply = await probe(main.workId);
  const rows = await consumersOf(mainFinding.artifactId);
  const head = (await q("SELECT state FROM finnor_os.primary_governance_heads WHERE tenant_id=$1 AND id=$2", [tenantId, main.consentRef.id]))[0];
  ensure(rows.length === 1 && head.state === "REVOKED", "ORACLE_PRECONDITION_FAILED");
  ensure(reply.status === "partial" && reply.data.current === false && reply.data.nativeOwnerConsumed === false, "READER_STILL_CURRENT_AFTER_REVOCATION:" + JSON.stringify(reply.data));
  ensure(leaks(reply, privateStrings(main)).length === 0, "REVOKED_READER_LEAKED");
  return { detail: { revoked: revoked.body, consumerRowsStillPresent: rows.length, governanceHead: head.state, reader: reply.data } };
});

await runCase("R12-16", "After revocation a fresh evaluation of the objective success condition is false (reader status is not ok)", async () => {
  ensure(mainRun, "MAIN_CHAIN_UNAVAILABLE");
  const reply = await probe(main.workId);
  const loop = await loopOf(main.workId);
  ensure(reply.status !== "ok" && reply.data.current === false && reply.data.nativeOwnerConsumed === false, "OBJECTIVE_CONDITION_STILL_TRUE");
  return { detail: { readerStatus: reply.status, data: reply.data, loopStateAtCompletion: loop.state, note: "the retained completed loop records the success observed at its time; a re-evaluation now yields non-success" } };
});

// ---- Work input superseded (R12-11) and cancellation (R12-14), wake negatives (R12-24a), not-consumed other Work (R12-26) ----
let stale = null;
await runCase("R12-11", "Newer Work input supersedes: reader non-current; stale plan input refused (R12-23a)", async () => {
  const f = await build();
  stale = f;
  await plan(f);
  await finishFlow(f);
  ensure(f.read.status === "COMPLETE", "PROGRAMME_NOT_COMPLETE:" + f.read.status);
  const consumed = await consume(f, f.read.findings[0]);
  ensure(consumed.status === 200, "CONSUME_FAILED_" + consumed.status);
  await waitFor("objective_completed", 180000, async () => (await loopOf(f.workId))?.state === "completed", 2000);
  const okBefore = await probe(f.workId);
  ensure(okBefore.status === "ok", "PRECONDITION_NOT_OK");
  const changed = await db.receiveWork({ tenantId, userId, workId: f.workId, instruction: "Additional independent Work input changes the frozen obligation", channel: "console", idempotencyKey: randomUUID(),
    activeContext: { focusedEntityType: root.entityType, focusedEntityId: root.entityId, entityRefs: [root] } });
  ensure(changed.workId === f.workId && changed.workInputId !== f.workInputId, "NEW_INPUT_NOT_CREATED");
  const after = await probe(f.workId);
  ensure(after.status === "partial" && after.data.current === false && after.data.nativeOwnerConsumed === false && after.data.status === "STALE", "READER_CURRENT_AFTER_NEW_INPUT:" + JSON.stringify(after.data));
  const oldInput = await probe(f.workId, { workInputId: f.workInputId });
  ensure(oldInput.status !== "ok", "OLD_INPUT_STILL_OK");
  const before = await planRevisions(f.workId);
  const stalePlan = await plan(f, undefined);
  ensure(stalePlan.status >= 400 && stalePlan.status < 500 && await planRevisions(f.workId) === before, "STALE_INPUT_PLAN_ACCEPTED_" + stalePlan.status);
  const unknown = await owner.operation("primary-plan", { ...f.intake, extra: true });
  ensure(unknown.status === 400, "EXTRA_FIELD_PLAN_NOT_400_" + unknown.status);
  return { detail: { newInput: changed.workInputId, oldInput: f.workInputId, readerAfter: after.data, oldInputStatus: oldInput.status, stalePlanStatus: stalePlan.status, stalePlanBody: stalePlan.body, extraFieldStatus: unknown.status, planRevisionsUnchanged: before } };
});

let wakeWork = null;
await runCase("R12-24", "Wake refuses without durable owner consumption: loop stays waiting for an unconsumed COMPLETE programme", async () => {
  const f = await build();
  wakeWork = f;
  await plan(f);
  await finishFlow(f);
  ensure(f.read.status === "COMPLETE", "PROGRAMME_NOT_COMPLETE:" + f.read.status);
  const wake = await planModule.wakePrimaryObjective(ctx, f.workId);
  const loop = await loopOf(f.workId);
  ensure(wake.woken === false && wake.reason === "NOT_CONSUMED" && loop.state === "waiting" && Number(loop.step_count) === 0, "WAKE_WITHOUT_CONSUMPTION:" + JSON.stringify({ wake, loop }));
  const noPlan = await planModule.wakePrimaryObjective(ctx, unplannedWork);
  ensure(noPlan.woken === false, "WAKE_WITHOUT_PLAN");
  const wrongWork = await planModule.wakePrimaryObjective(ctx, main.workId);
  const otherLoop = await loopOf(f.workId);
  ensure(otherLoop.state === "waiting", "OTHER_WORK_WAKE_MOVED_LOOP");
  return { detail: { wake, loop, noPlanWake: noPlan, completedWorkWake: wrongWork } };
});

await runCase("R12-26", "A COMPLETE programme of another Work that is not consumed stays not-consumed while the first is consumed", async () => {
  ensure(wakeWork?.read?.findings?.length, "SECOND_WORK_UNAVAILABLE");
  const reply = await probe(wakeWork.workId);
  ensure(reply.status === "partial" && reply.data.current === true && reply.data.nativeOwnerConsumed === false && reply.data.underwritingRunId === null, "READER_CONSUMED_FOR_OTHER_WORKS_FINDING:" + JSON.stringify(reply.data));
  ensure((await consumersOf(wakeWork.read.findings[0].artifactId)).length === 0 && mainRun, "ORACLE_PRECONDITION_FAILED");
  return { detail: { second: reply.data, firstRunId: mainRun.id } };
});

await runCase("R12-14", "Programme cancellation after consumption: reader non-current (second positive wake first)", async () => {
  const f = wakeWork;
  ensure(f?.read?.findings?.length, "SECOND_WORK_UNAVAILABLE");
  const consumed = await consume(f, f.read.findings[0]);
  ensure(consumed.status === 200 && consumed.body.objectiveWake?.woken === true, "CONSUME_OR_WAKE_FAILED:" + consumed.status + JSON.stringify(consumed.body).slice(0, 200));
  await waitFor("objective_completed", 180000, async () => (await loopOf(f.workId))?.state === "completed", 2000);
  const okReply = await probe(f.workId);
  ensure(okReply.status === "ok", "PRECONDITION_NOT_OK");
  const cancel = await call("primary-cancel", { programmeId: f.programmeId }, 202);
  const reply = await probe(f.workId);
  const row = (await q("SELECT cancellation_requested_at,status FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND id=$2", [tenantId, f.programmeId]))[0];
  ensure(row.cancellation_requested_at, "CANCEL_NOT_RECORDED");
  ensure(reply.status === "partial" && reply.data.current === false && reply.data.nativeOwnerConsumed === false, "READER_CURRENT_AFTER_CANCEL:" + JSON.stringify(reply.data));
  return { detail: { cancel: cancel.body, programmeAfter: row, reader: reply.data } };
});

// ---- revoked after claim (R12-12) ----
await runCase("R12-12", "Consent revoked after the worker claim and physical source acceptance: no finding, no consumption", async () => {
  const f = await build({ source: { delayMs: 4000 } });
  const mark = accepted.length;
  await submit(f);
  await waitFor("source_accept", 90000, async () => accepted.length > mark, 300);
  const revoked = await call("primary-governance-revoke", { root, ref: f.consentRef, reason: "R12_REVOKED_AFTER_CLAIM" }, 200);
  await sleep(30000);
  const programme = (await q("SELECT status,reason FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND id=$2", [tenantId, f.programmeId]))[0];
  const findings = Number((await q("SELECT count(*)::int n FROM finnor_os.v2_findings WHERE tenant_id=$1 AND programme_id=$2", [tenantId, f.programmeId]))[0].n);
  const raw = Number((await q("SELECT count(*)::int n FROM finnor_os.s1_primary_observations WHERE tenant_id=$1 AND programme_id=$2", [tenantId, f.programmeId]))[0].n);
  const job = (await q("SELECT status,last_error FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'programmeId'=$2", [tenantId, f.programmeId]))[0];
  const reply = await probe(f.workId);
  ensure(findings === 0 && raw === 0 && programme.status !== "COMPLETE", `FINDING_AFTER_REVOCATION findings=${findings} raw=${raw} status=${programme.status}`);
  ensure(reply.status === "partial" && reply.data.nativeOwnerConsumed === false && reply.data.current === false, "READER_CURRENT_AFTER_CLAIM_REVOCATION");
  return { detail: { revoked: revoked.body, programme, findings, rawObservations: raw, job: { status: job?.status, error: String(job?.last_error ?? "").slice(0, 160) }, reader: reply.data, calls: (await sourceCalls(f)).map(c => c.operation) } };
});

// ---- revoked before consume with a plan (R12-24b) ----
await runCase("R12-24b", "Consent revoked before use: consume refused, loop stays waiting, objective cannot succeed", async () => {
  const f = await build();
  await plan(f);
  await finishFlow(f);
  ensure(f.read.status === "COMPLETE", "PROGRAMME_NOT_COMPLETE:" + f.read.status);
  await call("primary-governance-revoke", { root, ref: f.consentRef, reason: "R12_REVOKED_BEFORE_USE" }, 200);
  const refused = await consume(f, f.read.findings[0]);
  ensure(refused.status === 422 && refused.body.predicate === "SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED", "REVOKED_CONSUME_NOT_REFUSED:" + refused.status + JSON.stringify(refused.body).slice(0, 200));
  const rows = await q("SELECT count(*)::int n FROM finnor_os.v2_consumer_dependencies d JOIN finnor_os.v2_findings f ON f.tenant_id=d.tenant_id AND f.id=d.finding_id WHERE d.tenant_id=$1 AND f.programme_id=$2", [tenantId, f.programmeId]);
  await sleep(8000);
  const loop = await loopOf(f.workId);
  ensure(rows[0].n === 0 && loop.state === "waiting", `UNEXPECTED rows=${rows[0].n} loop=${loop.state}`);
  const reply = await probe(f.workId);
  ensure(reply.status !== "ok" && reply.data.nativeOwnerConsumed === false, "READER_OK_AFTER_REFUSED_CONSUME");
  return { detail: { refused: refused.body, consumerRows: rows[0].n, loop, reader: reply.data } };
});

// ---- deadline exhausted (R12-21) ----
await runCase("R12-21", "Original deadline exhausted before dispatch: zero source calls, plan refused, never ok", async () => {
  const f = await build({ deadlineMs: 12000 });
  const wait = Date.parse(f.originalDeadline) - Date.now();
  if (wait > 0) await sleep(wait + 1500);
  const before = await planRevisions(f.workId);
  const stalePlan = await plan(f, undefined);
  ensure(stalePlan.status >= 400 && stalePlan.status < 500 && await planRevisions(f.workId) === before, "EXPIRED_DEADLINE_PLAN_ACCEPTED_" + stalePlan.status);
  await submit(f);
  const read = await awaitProgramme(f, 120000);
  const calls = await sourceCalls(f);
  const reply = await probe(f.workId);
  ensure(calls.length === 0, "SOURCE_CALLED_AFTER_DEADLINE_" + calls.length);
  ensure(read.status !== "COMPLETE" && reply.status === "partial" && reply.data.nativeOwnerConsumed === false, "OK_AFTER_DEADLINE");
  return { detail: { deadline: f.originalDeadline, planStatus: stalePlan.status, planBody: stalePlan.body, programmeStatus: read.status, reason: read.reason, sourceCalls: calls.length, reader: reply.data } };
});

// ---- reservation exhausted (R12-22) ----
await runCase("R12-22", "Original shared grant exhausted: blocked state visible, no new funding, reader not ok", async () => {
  const first = await build({ limitRequests: 1 });
  await finishFlow(first);
  ensure(first.read.status === "COMPLETE", "FIRST_NOT_COMPLETE:" + first.read.status);
  const opened = (await call("primary-open-work", { root, instruction: "Second Work under the exact original one-request grant", idempotencyKey: randomUUID() }, 201)).body;
  const second = { ...first, workId: opened.workId, workInputId: opened.workInputId, intake: { ...first.intake, workId: opened.workId, expectedWorkInputId: opened.workInputId, idempotencyKey: randomUUID() }, programmeId: null, read: null };
  const reservations = await reservationDigest();
  await submit(second);
  second.read = await awaitProgramme(second, 120000);
  const afterReservations = await reservationDigest();
  const reply = await probe(second.workId);
  const calls = (await sourceCalls(first)).filter(c => c.operation === "ACQUIRE");
  ensure(second.read.status === "BLOCKED" && second.read.reason === "ORIGINAL_SHARED_PRIMARY_GRANT_EXHAUSTED", "NOT_BLOCKED:" + second.read.status + ":" + second.read.reason);
  ensure(reservations.n === afterReservations.n && reservations.d === afterReservations.d, "NEW_FUNDING_CREATED");
  ensure(calls.length === 1 && reply.status === "partial" && reply.data.nativeOwnerConsumed === false, "SECOND_WORK_READ_OR_SOURCE_CALLED");
  return { detail: { secondStatus: second.read.status, reason: second.read.reason, reservationsBefore: reservations, reservationsAfter: afterReservations, acquirePosts: calls.length, reader: reply.data } };
});

// ---- governance expiry after use (finding freshness, R12-15a) ----
await runCase("R12-15", "Governance/finding freshness expiry after use makes the reader non-current", async () => {
  const f = await build({ expiryMs: 200000 });
  await finishFlow(f);
  ensure(f.read.status === "COMPLETE", "NOT_COMPLETE:" + f.read.status);
  const consumed = await consume(f, f.read.findings[0]);
  ensure(consumed.status === 200, "CONSUME_FAILED_" + consumed.status);
  const during = await probe(f.workId);
  ensure(during.status === "ok", "NOT_OK_BEFORE_EXPIRY:" + JSON.stringify(during.data));
  const wait = Date.parse(f.expiresAt) - Date.now();
  if (wait > 0) await sleep(wait + 2000);
  const after = await probe(f.workId);
  ensure(after.status === "partial" && after.data.current === false && after.data.nativeOwnerConsumed === false, "READER_CURRENT_AFTER_EXPIRY:" + JSON.stringify(after.data));
  return { detail: { expiresAt: f.expiresAt, before: during.data.current, after: after.data, scope: "governance expiry (which bounds finding freshness); method/checker identity change is NOT_RUN" } };
});
notRun("R12-15b", "Method or checker identity change after use", "Changing the checker source or lock digest would require editing owner code mid-run; not forced. Owner predicate FINDING_METHOD_OR_CHECKER_CHANGED is exercised by the V2 local oracle only.");

// ---- physical SIGKILL (R12-20) with objective plan ----
await runCase("R12-20", "Physical worker SIGKILL after source acceptance: quarantine, original-grant advance, STATUS then READ_RESULT, consume, objective success", async () => {
  const f = await build({ source: { delayMs: 3000 } });
  await plan(f);
  const mark = accepted.length;
  await submit(f);
  await waitFor("source_accept", 90000, async () => accepted.length > mark, 200);
  const killed = await (async () => { const w = worker; w.child.kill("SIGKILL"); return w.exited; })();
  ensure(killed.signal === "SIGKILL", "WORKER_NOT_SIGKILLED:" + JSON.stringify(killed));
  const reservationBefore = (await q("SELECT reservation_id,status,md5(envelopes::text) env FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [tenantId, f.reservation.reservationRef.id]))[0];
  await startWorker(LEASE_SECONDS);
  const quarantined = await waitFor("quarantined", 150000, async () => {
    const row = (await q("SELECT status,last_error,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'programmeId'=$2", [tenantId, f.programmeId]))[0];
    return row?.status === "quarantined" ? row : null;
  }, 2000);
  ensure(/automatic replay is prohibited/.test(quarantined.last_error), "QUARANTINE_REASON_MISMATCH");
  const before = (await call("primary-read", { programmeId: f.programmeId }, 200)).body;
  ensure(before.costReceipts.some(r => r.status === "UNKNOWN"), "UNKNOWN_NOT_RETAINED");
  const loopWhileDown = await loopOf(f.workId);
  ensure(loopWhileDown.state === "waiting", "LOOP_MOVED_WITHOUT_OWNER_CONSUMPTION");
  await call("primary-advance", { ...before.advanceBindings, programmeRef: before.ref, expectedRevision: Number(before.ref.revision), triggerRef: before.nextObligationRefs[0] ?? before.ref }, 202);
  f.read = await awaitProgramme(f);
  ensure(f.read.status === "COMPLETE", "NOT_COMPLETE_AFTER_RECOVERY:" + f.read.status + ":" + f.read.reason);
  const calls = await sourceCalls(f);
  ensure(JSON.stringify(calls.map(c => c.operation)) === JSON.stringify(["ACQUIRE", "STATUS", "READ_RESULT"]), "CALL_SEQUENCE:" + calls.map(c => c.operation).join(","));
  ensure(calls.every(c => c.requestId === calls[0].requestId), "REQUEST_ID_CHANGED");
  const reservationAfter = (await q("SELECT reservation_id,status,md5(envelopes::text) env FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [tenantId, f.reservation.reservationRef.id]))[0];
  ensure(reservationAfter.reservation_id === reservationBefore.reservation_id && reservationAfter.status !== "RELEASED", "ORIGINAL_RESERVATION_CHANGED");
  ensure(f.read.advanceBindings.budgetGrantRef.id === f.budgetGrantRef.id && f.read.findings[0].establishedValueOrInterval.quantity.numerator === FACILITY_VALUE, "GRANT_OR_VALUE_CHANGED");
  const mandateRow = (await q("SELECT body->'stopping'->>'deadline' deadline FROM finnor_os.primary_governance_versions WHERE tenant_id=$1 AND id=$2", [tenantId, f.mandateRef.id]))[0];
  ensure(mandateRow.deadline === f.originalDeadline, "ORIGINAL_DEADLINE_CHANGED");
  const consumed = await consume(f, f.read.findings[0]);
  ensure(consumed.status === 200 && consumed.body.objectiveWake?.woken === true, "CONSUME_OR_WAKE_FAILED:" + consumed.status);
  await waitFor("objective_completed", 180000, async () => (await loopOf(f.workId))?.state === "completed", 2000);
  const reply = await probe(f.workId);
  ensure(reply.status === "ok", "READER_NOT_OK_AFTER_RECOVERY:" + JSON.stringify(reply.data));
  return { detail: { killed, quarantined: { status: quarantined.status, fence: quarantined.claim_fence }, unknownReceiptsRetained: before.costReceipts.filter(r => r.status === "UNKNOWN").length, sourceCalls: calls.map(c => ({ op: c.operation, requestId: c.requestId })),
    reservationBefore, reservationAfter, originalDeadline: f.originalDeadline, deadlineAfter: mandateRow.deadline, runId: consumed.body.id, reader: reply.data } };
});

// ---- summary artifact ----
const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
const finalCosts = (await q("SELECT count(*)::int n, coalesce(sum(actual_micro_usd::numeric),0)::text micro_usd, coalesce(sum(actual_cpu_micros::numeric),0)::text cpu_micros FROM finnor_os.s5_primary_charges WHERE tenant_id=$1", [tenantId]))[0];
const workerFinalLog = readFileSync(workerLog, "utf8").replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]").replace(/postgres(?:ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@").slice(-6000);
const artifact = {
  schema: "finnor.project-z.z0-r12.v1", family: "primary-diligence", job: "advance_primary_diligence_v1", intent: "primary_diligence_v1",
  startedFrom: { tenantId, userId }, finishedAt: new Date().toISOString(), counts,
  inputs: { facilityValue: FACILITY_VALUE, facilityRecord: FACILITY_ID, profile: "v2", worker: "scenario-owned production worker (restricted finnor_worker role)", source: "scripts/v2/controlled-source.mts (separate process)", leaseSeconds: LEASE_SECONDS },
  qualification: { engineering: "LOCAL_ENGINEERING_ONLY", S8: "NOT_RUN", protectedAdmission: false, production: false, live: false },
  cases: results.map(r => ({ id: r.id, title: r.title, outcome: r.outcome, error: r.error ?? null, reason: r.reason ?? null })),
  costs: finalCosts, evidenceFiles: files, workerLogTailRedacted: workerFinalLog,
  rerun: "scripts/project-z/run-native-scenario.mjs --profiles=v2 --no-worker --scenario=finnor-os/scripts/project-z/native/z0-r12-session.mjs (see native-run.sh)",
  exitCodes: { scenario: results.some(r => r.outcome === "FAIL") ? 1 : 0 },
};
record("artifact-summary", artifact);
writeFileSync(join(evidence, "finnor.project-z.z0-r12.v1.json"), JSON.stringify(redact(artifact), null, 2) + "\n", { mode: 0o600 });
await worker?.stop().catch(() => null);
sourceProcess.kill("SIGTERM");
await sql.end().catch(() => null);
process.exit(results.some(r => r.outcome === "FAIL") ? 1 : 0);
