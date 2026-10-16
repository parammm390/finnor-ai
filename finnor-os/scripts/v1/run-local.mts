/** Finite E2E campaign. The frozen specification, not producer interpretation,
 * defines the expected original-record and physical boundary outcomes. */
import { strict as assert } from "node:assert";
import { randomBytes, randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, readFile, readdir, writeFile, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configureTenantVertical, closePool, getPool } from "@finnor/db";
import { createStrategy, transitionStrategy, createOpportunityInvestmentCase, activateInvestmentCase,
  createUnderwritingModel, createUnderwritingModelVersion, getUnderwritingRun, type PeMutationContext } from "@finnor/private-equity";
import { PrimaryUnderwritingScopeSchema, PrimaryReferenceSemanticsSchema, type BilateralIntake,
  type DiligenceAssertion, type PrimaryRecord, type VReference } from "@finnor/shared-types";
import type { UnderwritingInputSnapshot } from "@finnor/underwriting";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { canonical, hash, reference, rightsBinding, methodIdentity, ownerRecord } from "../../packages/private-equity/src/bilateral-opportunities/store";
import { disposablePlatform } from "../v2/platform.mts";
import { browserHttpFixture } from "../v2/browser-http-fixture.mts";
import { observeOwnedSqlFailures } from "./sql-diagnostics.mts";
import { withRelationshipDispatch } from "../../packages/authority/src/relationship-policy";
import { startWorkObjective } from "@finnor/orchestration";
import { prepareSignedLoiHandoff, exerciseSignedLoiHandoff, type SignedLoiFixture } from "./signed-loi-handoff-e2e.mts";

const repo = resolve(import.meta.dirname, "../../.."), scope = join(repo, "scope-v/v1-private-market-opportunity-creation");
const args = process.argv.slice(2), caseArgs = args.filter(a => a.startsWith("--cases=")),
  allocationArgs = args.filter(a => a.startsWith("--allocation=")),
  cumulativeArgs = args.filter(a => a.startsWith("--cumulative-allocation="));
if (args.some(a => !a.startsWith("--cases=") && !a.startsWith("--allocation=") && !a.startsWith("--cumulative-allocation=")) ||
  caseArgs.length > 1 || allocationArgs.length + cumulativeArgs.length > 1) throw Error("UNREGISTERED_V1_RUNNER_FLAG");
const filter = caseArgs[0]?.slice(8).split(","), allocationId = allocationArgs[0]?.slice(13),
  cumulativePath = cumulativeArgs[0]?.slice("--cumulative-allocation=".length);
if (cumulativePath && (resolve(cumulativePath) !== cumulativePath ||
 !cumulativePath.startsWith(join(repo,"scope-v/v1-v5-cumulative-closure")+"/") || !cumulativePath.endsWith(".json")))throw Error("EXACT_OWNED_CUMULATIVE_ALLOCATION_REQUIRED");
const implementedCases = new Set(["authenticated-boundary", "positive", "material-correction", "role", "identity-conflict",
  "wrong-buyer", "stale-interest", "generic-response", "wrong-terms", "unknown-fit", "contradicted-fit", "out-of-bounds",
  "already-active", "preexisting-process", "unresolved-origination", "incomplete-pipeline", "refusal", "cancel-before",
  "kill-after-acceptance", "suppression-no-policy"]);
if (filter && (new Set(filter).size !== filter.length || filter.some(id => !implementedCases.has(id))))
  throw Error("UNIMPLEMENTED_OR_DUPLICATE_V1_CASE");
if (allocationId !== undefined && !/^campaign-\d{3}$/.test(allocationId)) throw Error("UNREGISTERED_V1_ALLOCATION");
const manifest = JSON.parse(await readFile(join(scope, "verification-plan.json"), "utf8"));
const startedAt = new Date().toISOString(), originalAllocationPath = join(scope, "verification", "functional-allocation.json"),
  allocationPath = cumulativePath ?? (allocationId ? join(scope, "verification", allocationId, "allocation.json") : originalAllocationPath);
const allocation = JSON.parse(await readFile(allocationPath, "utf8"));
if(cumulativePath){
 assert.equal(allocation.schema,"finnor.v.cumulative-v1-allocation.v1");
 assert.equal(allocation.authority,"CURRENT_USER_ORIGINAL_V1_V5_LOCAL_ENGINEERING_REQUEST");
 assert.deepEqual(allocation.limits,manifest.limits,"CUMULATIVE_ALLOCATION_CANNOT_RELAX_ORIGINAL_LIMITS");
 assert.equal(allocation.originalAllocationSha256,createHash("sha256").update(await readFile(originalAllocationPath)).digest("hex"));
 assert.equal(allocation.originalProgrammeGrantsReset,false);
 for(const flag of ["liveContactAllowed","publicationAllowed","deploymentAllowed"])assert.equal(allocation[flag],false);
 // The original manifest's storage floor below applies to cumulative runs too.
}
if (allocationId) {
  assert.equal(allocation.id, allocationId, "EXPLICIT_ALLOCATION_ID_MISMATCH");
  assert.deepEqual(allocation.limits, manifest.limits, "EXPLICIT_ALLOCATION_LIMITS_CHANGED");
  assert.equal(allocation.previousAllocationSha256, hash(await readFile(originalAllocationPath)), "ORIGINAL_ALLOCATION_CHANGED");
  assert.equal(allocation.userAnswer, "Yes, continue locally", "EXPLICIT_ALLOCATION_AUTHORITY_MISSING");
  assert.equal(allocation.liveContactAllowed, false); assert.equal(allocation.publicationAllowed, false);
  assert.equal(allocation.deploymentAllowed, false); assert.equal(allocation.originalProgrammeGrantsReset, false);
}
const campaignDeadline = Date.parse(allocation.deadline);
assert(Number.isFinite(campaignDeadline) && Number.isFinite(Date.parse(allocation.startedAt)) &&
  Date.parse(allocation.startedAt) <= Date.now() && Date.now() < campaignDeadline &&
  campaignDeadline - Date.parse(allocation.startedAt) <= manifest.limits.functional_campaign_wall_seconds * 1000 + 1,
  "REGISTERED_ORIGINAL_DEADLINE_EXHAUSTED");
const requestedOutput = process.env.FINNOR_V1_EVIDENCE_DIR;
if (requestedOutput && (!cumulativePath || !allocation.outputRelative ||
  requestedOutput !== resolve(repo, allocation.outputRelative) ||
  !requestedOutput.startsWith(join(repo, "scope-v/v1-v5-cumulative-closure/evidence") + "/")))
  throw Error("EXACT_REGISTERED_CUMULATIVE_EVIDENCE_DIRECTORY_REQUIRED");
if (requestedOutput) {
  assert.deepEqual(filter, allocation.assignedCases, "CUMULATIVE_EVIDENCE_CASE_ASSIGNMENT_MISMATCH");
  const existing = await readdir(requestedOutput).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  });
  assert(existing.every(name => ["supervisor-source-freeze.json", "supervisor.log"].includes(name)),
    "CUMULATIVE_EVIDENCE_MUST_NOT_OVERWRITE_AN_EXISTING_RUN");
}
const output = requestedOutput ?? join(scope, "evidence", "run-" + startedAt.replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const disk = await statfs(repo);
assert(disk.bavail * disk.bsize >= manifest.limits.minimum_free_storage_bytes_before_expensive_step, "REGISTERED_STORAGE_FLOOR");
process.env.NODE_ENV = "test"; process.env.FINNOR_V1_PROFILE = "ordinary_disposable";
const children = new Set<ChildProcess>(), results: Array<Record<string, any>> = [], workerLogs: string[] = [];
let platform: Awaited<ReturnType<typeof disposablePlatform>> | undefined, http: Awaited<ReturnType<typeof browserHttpFixture>> | undefined;
let source: ChildProcess | undefined, checker: ChildProcess | undefined, primarySource: ChildProcess | undefined;
let descriptor: any, checkerDescriptor: any, primaryDescriptor: any;
let privateDirectory = "", candidateConfig = "", checkerSourceConfig = "";
let handoffFixture: SignedLoiFixture | undefined;
const candidateProfiles: any[] = [], checkerProfiles: any[] = [];
const tenant = randomUUID(), actor = randomUUID(), other = randomUUID(), buyer = randomUUID(), senderId = randomUUID();
const ctx: PeMutationContext = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: "owner" },
  provenance: { sourceSystem: "V1:registered-disposable-E2E", createdBy: actor } };
const expiresAt = new Date(campaignDeadline).toISOString(), validFrom = new Date(Date.now() - 1000).toISOString();
const fixtureRef = (owner: string, id: string) => reference(owner, id, 1, { fixture: id, qualification: "SYNTHETIC_NOT_LIVE" });
let root: BilateralIntake["root"], strategyId: string, policyRef: VReference, resourceRefs: VReference[];
const writePrivate = (name: string, value: unknown) => writeFile(join(privateDirectory, name),
  typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
const save = () => writeFile(join(output, "results.json"), JSON.stringify({
  schema: "finnor.v1.boundary-evidence.v1", startedAt, finishedAt: new Date().toISOString(),
  status: results.some(r => r.status === "FAIL") ? "FAIL" : "PARTIAL_DEVELOPMENT",
  campaignDeadline: new Date(campaignDeadline).toISOString(), cases: results, workerLogs,
  allocation: { id: cumulativePath?"new-cumulative-source-cut":allocationId ?? "original", path: allocationPath, originalAllocationUnchanged: true,
    apiPoolLimit:process.env.FINNOR_V1_ONE_CLIENT_PROOF==="1"?1:"LOCAL_DEFAULT" },
  boundaries: "Authenticated real API/user lookup -> canonical Work -> real queue and registered separate worker -> actual loopback SMTP -> signed direct synthetic participant -> separately credentialed original-record checker -> canonical Opportunity/artifact",
  custody: "SEPARATE_FIXTURE_PROCESSES_AND_NONPRIVILEGED_ROLES_NOT_HOSTILE_OS_ISOLATION_OR_PROTECTED_DOMAIN_CUSTODY",
  qualification: { S8: "NOT_ADMITTED", live: "NOT_AUTHORIZED", field: "NOT_RUN", B_R: "NOT_ESTABLISHED", H2: "NOT_RUN" },
  rerun: "cd finnor-os && node --import=tsx scripts/v1/run-local.mts" +
    (cumulativePath?" --cumulative-allocation="+cumulativePath:allocationId ? " --allocation=" + allocationId : "") + (filter ? " --cases=" + filter.join(",") : ""),
}, null, 2) + "\n");
function current(deadline = campaignDeadline) { if (Date.now() >= Math.min(deadline, campaignDeadline)) throw Error("REGISTERED_ORIGINAL_DEADLINE_EXHAUSTED"); }
async function rpc(child: ChildProcess, message: Record<string, unknown>) {
  const id = randomUUID();
  return new Promise<any>((yes, no) => {
    const timer = setTimeout(() => { child.off("message", receive); no(Error("INDEPENDENT_SOURCE_ADMIN_DEADLINE")); }, 10000);
    const receive = (m: any) => { if (m.id !== id) return; clearTimeout(timer); child.off("message", receive);
      if (m.failure) no(Error(m.failure)); else yes(m); };
    child.on("message", receive); child.send({ ...message, id });
  });
}
async function call(op: string, value: unknown, expected = 200) {
  current(); const result = await http!.call(op, value);
  // Only authored synthetic business inputs. Auth and private configurations
  // are never included in this repeatable boundary trace.
  await appendFile(join(output, "api.jsonl"), JSON.stringify({ at: new Date().toISOString(), operation: op, input: value, result }) + "\n");
  assert.equal(result.status, expected, JSON.stringify({ operation: op, ...result })); return result.body;
}
async function governance(body: unknown) { return (await call("bilateral-governance-put", { root, body, expectedRef: null }, 201)).ref as VReference; }
async function primaryGovernance(body: unknown, primaryRoot = root) {
  return (await call("primary-governance-put", { root: primaryRoot, body, expectedRef: null }, 201)).ref as VReference;
}
async function startChild(file: string, env: Record<string, string | undefined>, argv: string[] = [], ipc = false) {
  const child = spawn(process.execPath, ["--import=tsx", file, ...argv], { cwd: join(repo, "finnor-os"), env,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
  children.add(child); child.once("exit", () => children.delete(child)); return child;
}
async function worker(deadline: number, afterStart?: (child: ChildProcess) => Promise<void | NodeJS.Signals>) {
  current(deadline);
  const spawnedAt = new Date().toISOString();
  const child = await startChild(join(import.meta.dirname, "physical-worker.mts"), {
    PATH: process.env.PATH, NODE_ENV: "test", FINNOR_V1_PROFILE: "ordinary_disposable", FINNOR_V2_PROFILE: "ordinary_disposable",
    NODE_OPTIONS: "--max-old-space-size=256",
    DATABASE_URL: platform!.workerUrl, FINNOR_V1_SMTP_PORT: String(descriptor.smtpPort),
    FINNOR_PRIMARY_CREDENTIAL_DIRECTORY: privateDirectory,
    FINNOR_V1_SOURCE_CONFIG: candidateConfig, FINNOR_V1_CHECKER_CLIENT_CONFIG: process.env.FINNOR_V1_CHECKER_CLIENT_CONFIG,
    FINNOR_LEGACY_CREDENTIAL_TENANT_IDS: tenant, GMAIL_USER: "representative@bilateral-fixture.invalid",
    GMAIL_APP_PASSWORD: "disposable-local-no-provider-authority", COMMUNICATIONS_BINDING: "gmail", AWS_EC2_METADATA_DISABLED: "true",
  });
  let log = ""; const collect = (bytes: Buffer) => { if (log.length < 131072) log += bytes.toString(); };
  child.stdout!.on("data", collect); child.stderr!.on("data", collect);
  let parentCut: { at: string; killIssued: boolean } | null = null;
  const ended = once(child, "exit"), timer = setTimeout(() => {
    parentCut = { at: new Date().toISOString(), killIssued: child.kill("SIGKILL") };
  }, Math.max(1, deadline - Date.now()));
  try {
    const expectedSignal = await afterStart?.(child); const [code, signal] = await ended;
    const name = "worker-" + child.pid + ".log"; workerLogs.push(name);
    const observation = JSON.stringify({ boundary: "V1_PARENT_WORKER_OBSERVATION", spawnedAt,
      exitedAt: new Date().toISOString(), originalCaseDeadline: new Date(deadline).toISOString(), parentCut,
      startupExcludedFromCaseDeadlineOrNativeMeter: false });
    const redacted = (observation + "\n" + log).replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]").replace(/postgres(?:ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");
    await writeFile(join(output, name), redacted);
    if (expectedSignal) { assert.equal(code, null); assert.equal(signal, expectedSignal); }
    else assert.equal(code, 0, `ACTUAL_WORKER_EXIT_${code}_${signal}: ${redacted.slice(-3000)}`);
    current(deadline);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
async function test(id: string, expected: string, fn: (deadline: number) => Promise<unknown>) {
  if (filter && !filter.includes(id)) return;
  const start = Date.now(), deadline = Math.min(campaignDeadline, start + manifest.limits.per_scenario_wall_seconds * 1000);
  try { const observed = await fn(deadline); current(deadline); results.push({ id, status: "PASS", expected, observed,
    startedAt: new Date(start).toISOString(), deadline: new Date(deadline).toISOString(), elapsedMs: Date.now() - start }); }
  catch (error) {
    const retained: Record<string, unknown> = {};
    for (const table of ["v1_programmes", "v1_candidates", "v1_terms", "s1_bilateral_observations", "v1_claim_checks",
      "v1_artifacts", "v1_events", "s6_contact_intents", "s6_standing_contact_authorizations", "s6_relationship_events",
      "work_programme_occupations", "works", "work_inputs", "jobs", "job_delivery_attempts", "external_operations",
      "provider_operation_attempts", "business_effects", "domain_actions", "communication_deliveries", "s5_programme_charges", "s5_reservations"]) {
      const rows = (await platform!.admin.query(`SELECT * FROM finnor_os.${table} LIMIT 257`)).rows;
      retained[table] = { rows: rows.slice(0, 256), coverage: rows.length > 256 ? "TRUNCATED_DIAGNOSTIC_ONLY" : "ALL_OWNED_ROWS" };
    }
    await writeFile(join(output, "failure-" + id + "-owners.json"), JSON.stringify({ retained,
      original: await rpc(source!, { type: "inspect" }) }, null, 2) + "\n");
    results.push({ id, status: "FAIL", expected, failure: { message: (error as Error).message, stack: (error as Error).stack },
      startedAt: new Date(start).toISOString(), deadline: new Date(deadline).toISOString(), elapsedMs: Date.now() - start });
  }
  console.log(JSON.stringify({ id, status: results.at(-1)!.status, failure: results.at(-1)!.failure?.message })); await save();
}
async function gapAssertion(company: string): Promise<DiligenceAssertion> {
  const authorityId = randomUUID(), semanticsId = randomUUID(), channel = "synthetic-v1-primary";
  const authorityRef = await primaryGovernance({
    schema: "finnor.primary-authority.v1", profileId: authorityId, revision: 1, issuingPrincipalId: actor,
    legalEntityIds: [company], jurisdictions: ["SYNTHETIC_US"], instrumentAndTransactionClasses: ["SYNTHETIC_FINANCIAL_RECORDS"],
    activities: ["ACCESS_RECORDS", "INTERPRET", "CONTACT", "DISCLOSE"].map(activity => ({ activity, actorIds: [actor], channelIds: [channel] })),
    professionalRequirements: [], approvedTemplateRefs: [fixtureRef("S6", "synthetic-primary-request")], negotiationBoundsRef: null,
    disclosureRules: ["EXACT_ASSERTION_SCOPE_ONLY"], confidentialityRules: ["AUTHORIZED_COMPANY_ONLY"],
    contactLimits: { maximumRequests: 16, minimumSpacingMs: 0, suppressedParticipantIds: [] }, exposureLimitMicroUsd: "2000000",
    reservationRequired: true, approvalRef: fixtureRef("BUSINESS_OWNER", "synthetic-primary-approval"), validFrom, expiresAt,
    escalationConditions: ["UNSUPPORTED_SCOPE"], revocationConditions: ["OWNER_REVOKED"],
    legalReviewEvidenceRefs: [fixtureRef("BUSINESS_OWNER", "synthetic-record-purpose")], policyRevision: "synthetic-1", environment: "DEVELOPMENT",
  });
  const basisRef = await primaryGovernance({
    schema: "finnor.primary-reference-semantics.v1", profileId: semanticsId, revision: 1, issuerId: actor, acceptedBy: actor,
    authorityRef, legalEntityId: company,
    rules: [{ field: "outstanding", recordKinds: ["FACILITY"], treatment: "EXACT_RECORDED_VALUE",
      requiredWitnessFields: ["ledgerState"], excludedInterpretations: ["ENTERPRISE_TOTAL_DEBT"] }],
    grossNetTreatment: "EXACT_SIGNED_FACILITY", recognitionRule: "EXACT_RECORDED_VALUE", calendarRef: "SYNTHETIC_2025",
    consolidationRef: "STANDALONE_TARGET", professionalReviewRef: null, environment: "DEVELOPMENT", validFrom, expiresAt,
  });
  return {
    assertionId: randomUUID(), revision: 1, subject: { entityType: "external_organization", entityId: company },
    exactPredicate: "Establish liabilities in the exact permitted lender facility population, not enterprise-total debt.",
    predicateKind: "POPULATION_TOTAL", field: "outstanding", economicRecordIds: [],
    amountOrState: { kind: "UNKNOWN", reason: "FULL_DILIGENCE_PENDING" },
    semantics: { legalEntityId: company, perimeter: [company], accountOrParticipantIds: ["lender-participant-1"],
      periodStart: "2025-01-01T00:00:00.000Z", periodEnd: "2025-12-31T23:59:59.000Z", cutoff: "2025-12-31T23:59:59.000Z",
      currency: "USD", units: "dollars", scale: { numerator: "1", denominator: "1" }, signConvention: "AS_RECORDED",
      basisRef, grossNetTreatment: "EXACT_SIGNED_FACILITY", recognitionRule: "EXACT_RECORDED_VALUE", calendarRef: "SYNTHETIC_2025",
      consolidationRef: "STANDALONE_TARGET", timeBasis: "CUTOFF" },
    startingSupportRefs: [], knownGaps: ["PRIMARY_RECORDS_NOT_YET_ACQUIRED"],
    materiality: { decisionRef: fixtureRef("BUSINESS_OWNER", "synthetic-underwriting-decision"),
      rationale: "Material unresolved facility exposure", threshold: { numerator: "1", denominator: "1" },
      dependencyRefs: [fixtureRef("BUSINESS_OWNER", "scoped-underwriting:" + company)] },
    acceptableSourceClasses: ["EXTERNAL_AUTHORITATIVE_RECORD"], observationPredicates: ["SIGNED_LEDGER_CUTOFF"],
    requiredCoverage: { populationId: "permitted-lender-facilities", populationRevision: "population-v1",
      members: ["lender-participant-1"], requiredRecordKinds: ["FACILITY"], completePopulation: true,
      measurementDesignRef: null, minimumCoverage: { numerator: "1", denominator: "1" }, errorTolerance: { numerator: "0", denominator: "1" } },
  };
}
async function build(mode: string, deadline: number, options: { gap?: boolean; acknowledgmentDelayMs?: number; grantContacts?: number } = {}) {
  const company = randomUUID(), person = randomUUID();
  await platform!.admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
    VALUES($1,$2,$3,'Synthetic V1 Target','other')`, [company, tenant, "v1-" + company]);
  await platform!.admin.query(`INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,external_organization_id,name,title,business_email)
    VALUES($1,$2,$3,$4,'Synthetic Owner','Fixture owner',$5)`, [person, tenant, "v1-" + person, company, person + "@bilateral-fixture.invalid"]);
  const gaps = options.gap ? [await gapAssertion(company)] : [];
  const bounds = { minimumPurchaseMinorUnits: "1000000", maximumPurchaseMinorUnits: "3000000", minimumControlBps: 5100,
    maximumControlBps: 8000, maximumManagementParticipationBps: 1000, maximumDeferredBps: 2500, maximumDeferredDays: 365,
    earliestClosingAt: new Date(Date.now() + 86400000).toISOString(), latestClosingAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    allowProposedManagementContinuity: true };
  const sourceProfile = { schema: "finnor.bilateral-source-profile.v1", profileId: randomUUID(), revision: 1, issuingPrincipalId: actor,
    environment: "DEVELOPMENT", validFrom, expiresAt, issuer: "Synthetic independent registry", system: "Separately administered source and participant",
    endpoint: descriptor.origin + "/originals", responsePublicKeyPem: descriptor.publicKeyPem,
    channel: "AUTHENTICATED_DIRECT_RECORD_AND_PARTICIPANT_HTTP",
    sourceClasses: ["INDEPENDENT_COMPANY_REGISTRY", "AUTHORITATIVE_FIRM_PIPELINE", "DIRECT_PARTICIPANT"],
    authorityEvidenceRefs: [fixtureRef("S1", "synthetic-source-authority")], permittedFields: ["identity", "role", "objectives", "annualRevenueMinor", "origination", "pipeline"],
    rightsRef: (await rightsBinding(ctx, root)).rightsRef, retentionUntil: expiresAt, maximumReadMicroUsd: "0",
    transportReadback: { contract: "DEVELOPMENT_SMTP_ACCEPTANCE_V1", provider: "gmail",
      meaning: "TRANSPORT_ACCEPTANCE_NOT_INTEREST_OR_RECIPIENT_DELIVERY", validUntil: expiresAt, maximumContactMicroUsd: "100",
      maximumObservationAgeMs: 240000, mutationIdempotency: "NONE", absenceAllowsRetry: false },
    pricebookRef: fixtureRef("S5", "synthetic-contact-tariff"), adapterVersion: "bilateral-direct-records-v1",
    recovery: "REPEATABLE_READ_NO_CONTACT_EFFECT", admissionRef: null };
  const sourceProfileRef = await governance(sourceProfile), sourceToken = randomBytes(24).toString("base64url"),
    independentToken = randomBytes(24).toString("base64url");
  await writePrivate(sourceProfile.profileId + "-candidate", sourceToken); await writePrivate(sourceProfile.profileId + "-checker", independentToken);
  candidateProfiles.push({ profileId: sourceProfile.profileId, profileDigest: sourceProfileRef.contentDigest,
    tokenPath: join(privateDirectory, sourceProfile.profileId + "-candidate"), tokenDigest: hash(sourceToken) });
  checkerProfiles.push({ profileId: sourceProfile.profileId, profileDigest: sourceProfileRef.contentDigest,
    tokenPath: join(privateDirectory, sourceProfile.profileId + "-checker"), tokenDigest: hash(independentToken) });
  await writePrivate("candidate-source.json", { schema: "finnor.bilateral-interface-credentials.v1",
    credentialDomain: "CANDIDATE_DIRECT_RECORD_READ_ONLY", profiles: candidateProfiles });
  await writePrivate("checker-source.json", { schema: "finnor.bilateral-interface-credentials.v1",
    credentialDomain: "INDEPENDENT_ORIGINALS_READ_ONLY", profiles: checkerProfiles });
  await rpc(source!, { type: "configure", config: { tenantId: tenant, principalId: actor, buyerId: buyer, companyId: company, personId: person,
    senderId, sender: "representative@bilateral-fixture.invalid", recipient: person + "@bilateral-fixture.invalid", legalName: "Synthetic V1 Target",
    expiresAt, profileDigest: sourceProfileRef.contentDigest, candidateToken: sourceToken, checkerToken: independentToken, mode,
    acknowledgmentDelayMs: options.acknowledgmentDelayMs ?? 0 } });
  const domainProfileRef = await governance({ schema: "finnor.bilateral-domain.v1", profileId: randomUUID(), revision: 1, issuingPrincipalId: actor,
    environment: "DEVELOPMENT", validFrom, expiresAt, grammar: "PRIVATE_MAJORITY_NONBINDING_V1",
    deduplicationRule: "CANONICAL_COMPANY_BUYER_ALL_ACTIVE_FIRM_PIPELINE_V1", supportedActivities: ["BILATERAL_RESEARCH_AND_CONTACT"],
    checker: { endpoint: checkerDescriptor.origin + "/check", publicKeyPem: checkerDescriptor.publicKeyPem, identity: checkerDescriptor.identity,
      specificationDigest: checkerDescriptor.specificationDigest, credentialDomain: "SEPARATE_ORIGINAL_RECORD_READ_ONLY_CHECKER" },
    professionalProfileRefs: [], admissionRef: null });
  const authorityProfileRef = await governance({ schema: "finnor.bilateral-authority.v1", profileId: randomUUID(), revision: 1,
    issuingPrincipalId: actor, environment: "DEVELOPMENT", validFrom, expiresAt, legalEntityIds: [buyer], jurisdictions: ["SYNTHETIC_US"],
    transactionClass: "PRIVATE_MAJORITY_NONBINDING_V1",
    activities: ["RESEARCH", "CONTACT", "DISCLOSE", "PROPOSE_NONBINDING", "NEGOTIATE_WITHIN_BOUNDS"].map(activity => ({ activity, actorIds: [actor], channel: "email" })),
    professionalRequirements: [], approvedTemplate: "TRUTHFUL_NONBINDING_BILATERAL_V1",
    firmDisplayName: "Synthetic Buyer Firm", representativeDisplayName: "Synthetic Representative",
    automationDisclosure: "This preliminary outreach is prepared and sent by the disclosed automated FINNOR programme.",
    confidentialityRules: ["EXACT_APPROVED_NONCONFIDENTIAL_TERMS_ONLY"], permittedAssertionFields: sourceProfile.permittedFields, attachments: "FORBIDDEN",
    negotiationBounds: bounds, communicationIdentityId: senderId, relationshipPolicyRef: policyRef,
    standingApproval: "EXACT_EFFECTS_WITHIN_ORIGINAL_ENVELOPE", maximumDisclosureBytes: 16384,
    legalReviewEvidenceRefs: [fixtureRef("BUSINESS_OWNER", "development-not-legal-admission")], escalationActorId: actor,
    escalationConditions: ["OUTSIDE_ORIGINAL_ENVELOPE"], revocationConditions: ["OWNER_REVOKED"], policyRevision: "synthetic-1" });
  const mandateId = randomUUID(), originalDeadline = new Date(deadline).toISOString();
  const mandateRef = await governance({ schema: "finnor.bilateral-mandate.v1", profileId: mandateId, revision: 1,
    issuingPrincipalId: actor, environment: "DEVELOPMENT", validFrom, expiresAt, buyerEntityId: buyer, strategyId,
    objective: "Establish independently confirmed majority-sale interest with a proposed continuity condition, not underwriting or legal effectiveness.",
    selectionRule: "MANDATE_FIT_AND_REQUIRED_INFORMATION_PER_COST_THEN_KNOWN_DELAY", currency: "USD", bounds,
    preliminaryPredicates: [{ id: "minimum-revenue", field: "annualRevenueMinor", operator: "GTE", expected: "1000000", maximumAgeMs: 3600000 }],
    permittedFullDiligenceGapIds: gaps.map(g => g.assertionId), programmeGrammar: "PRIVATE_MAJORITY_NONBINDING_V1",
    authorityProfileRef, relationshipPolicyRef: policyRef, sourceProfileRef, domainProfileRef, maximumCompanies: 1,
    maximumRevisionsPerCompany: 4, confirmationMaximumAgeMs: 240000, deadline: originalDeadline, responseWaitMs: 60000 });
  const reservation = await call("bilateral-reserve-budget", { root, resourceRefs, maximumMicroUsd: "2000000",
    maximumCpuMicros: "100000000", idempotencyKey: randomUUID(), validUntil: originalDeadline }, 201);
  const budgetGrantRef = await governance({ schema: "finnor.bilateral-grant.v1", grantId: randomUUID(), revision: 1,
    issuingPrincipalId: actor, mandateId, legalEntityId: buyer, maximumMicroUsd: "2000000", maximumRequests: 64,
    maximumNativeCpuMicros: "100000000", maximumMemoryBytes: "536870912", maximumHumanSeconds: 0, maximumStoredBytes: 4194304,
    maximumContacts: options.grantContacts ?? 8, originalProgrammeDeadline: originalDeadline,
    pricebook: { ref: sourceProfile.pricebookRef, cpuMicroUsdPerSecond: { numerator: "1000", denominator: "1" },
      storageMicroUsdPerByte: { numerator: "0", denominator: "1" }, orchestrationMicroUsdPerSecond: { numerator: "1000", denominator: "1" },
      humanMicroUsdPerSecond: { numerator: "0", denominator: "1" } },
    reservationRef: reservation.reservationRef, retainedObligationRefs: [], expiresAt, environment: "DEVELOPMENT" });
  const instruction = handoffFixture
    ? "Execute the finite development mandate from bilateral interest through exact primary diligence, independently attested LOI, committed financing and verified closing; preserve continuing obligations."
    : "Create the registered development-only bilateral opportunity.";
  const opened = await call("bilateral-open-work", { root, instruction,
    idempotencyKey: randomUUID() }, 201);
  if (handoffFixture) {
    const input = (await platform!.admin.query("SELECT instruction_id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND id=$2",
      [tenant, opened.workInputId])).rows[0];
    await startWorkObjective(instruction, ctx.auth, { workId: opened.workId, workInputId: opened.workInputId,
      instructionId: input.instruction_id, channel: "console", maxSteps: 12, maxQueries: 12, maxActions: 6,
      deadlineAt: new Date(deadline), deferInitialIteration: true,
      successCondition: { version: 1, statement: instruction, mode: "all", source: "explicit", criteria: [{
        kind: "canonical_query", request: { intent: "closing_readiness", dealId: handoffFixture.dealId },
        assertion: { path: ["verifiedClosing", "status"], operator: "eq", expected: "CLOSED" },
      }] } });
  }
  const intake: BilateralIntake = { schema: "finnor.bilateral-programme.v1", root, workId: opened.workId,
    expectedWorkInputId: opened.workInputId, idempotencyKey: randomUUID(), mandateRef, authorityProfileRef,
    domainProfileRef, budgetGrantRef, sourceProfileRef, relationshipPolicyRef: policyRef, eligibleCompanyIds: [company],
    universeDefinition: "Exactly the one separately administered synthetic company and its independently resolved owner.",
    underwritingGapAssertions: gaps, mode: "ordinary_disposable" };
  return { intake, company, person, gaps, reservation, sourceProfile };
}
async function finish(f: Awaited<ReturnType<typeof build>>, deadline: number) {
  const accepted = await call("bilateral-submit", f.intake, 202);
  assert.equal((await call("bilateral-submit", f.intake, 202)).programmeId, accepted.programmeId);
  let state: any;
  for (let tick = 0; tick < 32; tick++) {
    current(deadline); await worker(deadline);
    state = await call("bilateral-read", { programmeId: accepted.programmeId });
    if (["COMPLETE", "STOPPED", "FAILED", "BLOCKED"].includes(state.status)) break;
    await new Promise(yes => setTimeout(yes, 1100));
  }
  await writeFile(join(output, "programme-" + accepted.programmeId + ".json"), JSON.stringify(state, null, 2) + "\n");
  return { accepted, state, original: await rpc(source!, { type: "inspect" }) };
}
async function consumeV2(f: Awaited<ReturnType<typeof build>>, predecessor: any, deadline: number) {
  current(deadline);
  if (!primarySource) {
    primarySource = await startChild(join(repo, "finnor-os/scripts/v2/controlled-source.mts"),
      { PATH: process.env.PATH, NODE_ENV: "test" }, [privateDirectory], true);
    primaryDescriptor = await new Promise<any>((yes, no) => {
      const timer = setTimeout(() => no(Error("SEPARATE_PRIMARY_SOURCE_START_DEADLINE")), 10000);
      primarySource!.on("message", (m: any) => { if (m.type === "ready") { clearTimeout(timer); yes(m); } });
      primarySource!.once("exit", () => no(Error("SEPARATE_PRIMARY_SOURCE_START_FAILED")));
    });
  }
  const a = f.gaps[0]!, primaryRoot = predecessor.root, company = f.company;
  const semantics = PrimaryReferenceSemanticsSchema.parse(await ownerRecord(ctx, a.semantics.basisRef));
  const authorityRef = semantics.authorityRef, sourceId = randomUUID(), channel = "synthetic-v1-primary";
  const rights = (await rightsBinding(ctx, primaryRoot)).rightsRef, pricebook = fixtureRef("S5", "synthetic-primary-tariff");
  const sourceProfile = {
    schema: "finnor.primary-source-profile.v1", profileId: sourceId, revision: 1, issuer: "Synthetic independent lender",
    system: "Separate actual primary-record fixture", legalEntityId: company, sourceClass: "EXTERNAL_AUTHORITATIVE_RECORD", sourceControl: "EXTERNAL_ISSUER",
    accountOrParticipantIds: a.semantics.accountOrParticipantIds, products: ["company-primary-records"],
    purpose: "PRIVATE_EQUITY_PRIMARY_DILIGENCE", channelId: channel, channelResolutionEvidenceRef: fixtureRef("S1", "synthetic-primary-channel"),
    endpoint: primaryDescriptor.origin + "/primary", responsePublicKeyPem: primaryDescriptor.publicKey, credentialRef: "primary-" + sourceId,
    authoritativeFields: ["outstanding", "ledgerState"], respondentId: null, respondentRole: null, respondentKnowledge: [],
    respondentAuthorityRef: null, intermediary: null, availableHistory: { start: a.semantics.periodStart, end: a.semantics.periodEnd, reasons: [] },
    observationPredicates: a.observationPredicates, adapterVersion: "primary-records-http-v1", recovery: "IDEMPOTENT_REQUEST_WITH_STATUS",
    price: { pricebookRef: pricebook, maximumRequestMicroUsd: "50000", statusReadMicroUsd: "0" }, rightsRef: rights,
    authorityEvidenceRefs: [fixtureRef("S1", "synthetic-lender-authority")], environment: "DEVELOPMENT", admissionRef: null, validFrom, expiresAt,
  };
  const sourceRef = await primaryGovernance(sourceProfile, primaryRoot), consentId = randomUUID(), mandateId = randomUUID();
  const consentRef = await primaryGovernance({
    schema: "finnor.primary-consent.v1", consentId, revision: 1, issuerId: actor, authorizedActorId: actor, legalEntityId: company,
    sourceProfileIds: [sourceId], accountOrParticipantIds: a.semantics.accountOrParticipantIds, products: ["company-primary-records"],
    purposes: ["PRIVATE_EQUITY_PRIMARY_DILIGENCE"], periodStart: a.semantics.periodStart, periodEnd: a.semantics.periodEnd,
    validFrom, expiresAt, rightsRef: rights, permissionEvidenceRef: fixtureRef("S1", "synthetic-target-consent"),
    retention: { rawUntil: expiresAt, derivativesUntil: expiresAt, retainAfterRevocation: true },
    disclosureRules: ["EXACT_ASSERTION_SCOPE_ONLY"], environment: "DEVELOPMENT",
  }, primaryRoot);
  const originalDeadline = new Date(deadline).toISOString();
  const mandateRef = await primaryGovernance({
    schema: "finnor.primary-mandate.v1", mandateId, revision: 1, issuingPrincipalId: actor, legalEntityId: company,
    objective: "Acquire and independently establish the exact unchanged material V1 gap, not enterprise-total debt.",
    permittedPurpose: "PRIVATE_EQUITY_PRIMARY_DILIGENCE", decisionRef: a.materiality.decisionRef,
    authorityProfileId: authorityRef.id, sourceProfileIds: [sourceId], assertionIds: f.gaps.map(g => g.assertionId),
    stopping: { maxAcquisitions: 8, deadline: originalDeadline, waitUntil: originalDeadline, stopOnRequiredCoverage: true, contradictionRevalidationRequired: true },
    priorityRule: "MATERIAL_COVERAGE_PER_RESERVED_COST_THEN_DELAY", validFrom, expiresAt, environment: "DEVELOPMENT",
  }, primaryRoot);
  const primaryResources: VReference[] = [];
  for (const [name, unit, resourceClass] of [["cash", "microUSD", "CASH"], ["cpu", "cpu-microseconds", "COMPUTE"]] as const) {
    const er = (owner: string, id: string) => ({ owner, id, version: "1", contentDigest: hash({ syntheticFixture: id }) });
    const r = await putAllocationResource(ctx, { schema: "finnor.allocation-resource.v1", resourceId: "synthetic-primary-" + company + "-" + name,
      tenantId: tenant, ownerRef: er("BUSINESS_OWNER", actor), legalEntityRef: er("BUSINESS_OWNER", company),
      scopeRef: er("BUSINESS_OWNER", primaryRoot.entityId), permittedRoots: [primaryRoot], rightsRef: "synthetic-v2-exact-resource-rights",
      unit, currency: unit === "microUSD" ? "USD" : null, kind: "CUMULATIVE_EXPENDITURE", resourceClass,
      horizon: { periods: 1, periodMs: 3600000, startAt: startedAt }, sourceRef: er("BUSINESS_OWNER", "explicit-disposable-primary-capacity"),
      asOf: startedAt, knowledgeAt: startedAt, validUntil: expiresAt, beliefPins: [],
      availability: [{ amount: "1000000000", basis: "REPORTED_AVAILABLE" }, { amount: "1000000000", basis: "REPORTED_AVAILABLE" }],
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }, null);
    primaryResources.push({ owner: r.ref.owner, id: r.ref.id, revision: r.ref.version, contentDigest: r.ref.contentDigest });
  }
  const reserved = await call("primary-reserve-budget", { root: primaryRoot, resourceRefs: primaryResources,
    maximumMicroUsd: "2000000", maximumCpuMicros: "100000000", idempotencyKey: randomUUID(), validUntil: originalDeadline }, 201);
  const budgetGrantRef = await primaryGovernance({
    schema: "finnor.primary-grant.v1", grantId: randomUUID(), revision: 1, issuingPrincipalId: actor, mandateId, legalEntityId: company,
    maximumMicroUsd: "2000000", maximumRequests: 8, maximumNativeCpuMicros: "100000000", maximumMemoryBytes: "536870912",
    maximumHumanSeconds: 0, maximumStoredBytes: 4194304, pricebook: { ref: pricebook, cpuMicroUsdPerSecond: { numerator: "1000", denominator: "1" },
      storageMicroUsdPerByte: { numerator: "0", denominator: "1" }, orchestrationMicroUsdPerSecond: { numerator: "1000", denominator: "1" },
      humanMicroUsdPerSecond: { numerator: "0", denominator: "1" } }, reservationRef: reserved.reservationRef,
    retainedObligationRefs: [], expiresAt, environment: "DEVELOPMENT",
  }, primaryRoot);
  const record: PrimaryRecord = {
    issuerRecordId: "issuer-additional-facility-1", economicId: "additional-facility-1", revision: 1, kind: "FACILITY",
    legalEntityId: company, accountOrParticipantId: a.semantics.accountOrParticipantIds[0]!, periodStart: a.semantics.periodStart,
    periodEnd: a.semantics.periodEnd, currency: "USD", units: "dollars", basisDigest: a.semantics.basisRef.contentDigest,
    state: "POSTED", replacesEconomicId: null, reversesEconomicId: null, aliasOf: null, effectiveAt: a.semantics.cutoff, observedAt: validFrom,
    fields: { outstanding: { kind: "EXACT", quantity: { numerator: "5000000", denominator: "1" } } },
    witnessFields: { ledgerState: "POSTED" }, relatedParty: "NO",
  };
  const credential = randomBytes(24).toString("base64url"); await writePrivate(sourceProfile.credentialRef, credential);
  await rpc(primarySource, { type: "configure", profiles: [{ public: sourceProfile, credential, records: [record], recordKinds: ["FACILITY"] }] });
  const intake = { schema: "finnor.primary-diligence.v1", root: primaryRoot, workId: f.intake.workId,
    expectedWorkInputId: f.intake.expectedWorkInputId, idempotencyKey: randomUUID(), assertions: f.gaps,
    startingEvidenceRefs: [], mandateRef, authorityProfileRef: authorityRef, budgetGrantRef, sourceProfileRefs: [sourceRef],
    consentRefs: [consentRef], referenceSemanticsRefs: [a.semantics.basisRef], predecessorRef: predecessor.predecessorRef, mode: "ordinary_disposable" };
  const altered = structuredClone(intake); altered.idempotencyKey = randomUUID();
  altered.assertions[0]!.exactPredicate = "A changed gap must not silently replace the immutable V1 gap.";
  const refused = await http!.call("primary-submit", altered); assert.equal(refused.status, 422);
  assert.match(String(refused.body.predicate ?? refused.body.error), /V1|GAP|PRIMARY/);
  const accepted = await call("primary-submit", intake, 202); let read: any;
  for (let tick = 0; tick < 8; tick++) {
    await worker(deadline); read = await call("primary-read", { programmeId: accepted.programmeId });
    if (read.findings?.length) break;
    await new Promise(yes => setTimeout(yes, 1100));
  }
  assert.equal(read.findings?.length, 1, JSON.stringify(read));
  const finding = read.findings[0]; assert.notEqual(finding.conclusion, "UNRESOLVED");
  assert.equal(finding.establishedValueOrInterval.quantity.numerator, "5000000");
  const investment = await createOpportunityInvestmentCase(ctx, { opportunityId: primaryRoot.entityId, title: "V1 exact pre-LOI consumer" });
  const investmentCaseId = String(investment.row.id); await activateInvestmentCase(ctx, { investmentCaseId, expectedVersion: 1 });
  const scope = PrimaryUnderwritingScopeSchema.parse({ predicateKind: a.predicateKind, field: a.field, economicRecordIds: a.economicRecordIds,
    semantics: a.semantics, requiredCoverage: a.requiredCoverage, acceptableSourceClasses: a.acceptableSourceClasses });
  const model = await createUnderwritingModel(ctx, { investmentCaseId, modelKey: "v1-primary-" + randomUUID(), name: "Exact V1 unresolved facility scope" });
  const shape = { valueType: "decimal", unit: "money", currency: "USD", shape: "scalar" } as const;
  const version = await createUnderwritingModelVersion(ctx, { modelId: String(model.id), definition: {
    schemaVersion: "underwriting-model-ir.v1", modelKey: String(model.modelKey ?? model.model_key), modelVersion: "1",
    financialConventionVersion: "finnor-pe-lbo/1.0.0", minimumEngineVersion: "finnor-underwriting-engine/1.0.0",
    periodDefinition: { frequency: "annual", forecastStart: "2026-01-01", count: 1 }, nodes: [
      { id: "facility", kind: "input", ...shape, dependencies: [], required: true, allowedTruthClasses: ["OBSERVED_FACT"],
        source: { kind: "explicit" }, primaryEvidenceScope: scope },
      { id: "scoped_output", kind: "output", ...shape, dependencies: ["facility"], sourceNodeId: "facility" },
    ], circularBlocks: [],
  } });
  const consumed = await call("primary-consume", { investmentCaseId, modelVersionId: String(version.id),
    worldAt: new Date().toISOString(), idempotencyKey: randomUUID(), workId: f.intake.workId, bindings: { facility: { findingId: finding.artifactId } } });
  const runId = String(consumed.runId ?? consumed.id), run = await getUnderwritingRun(ctx, runId);
  const snapshot = run.inputSnapshot as UnderwritingInputSnapshot;
  const observedInput = snapshot.values.facility; assert(observedInput, "ACTUAL_PRIMARY_UNDERWRITING_INPUT_MISSING");
  assert.equal(observedInput.value, "5000000"); assert.equal(observedInput.status, "KNOWN");
  assert.equal(observedInput.truthClass, "OBSERVED_FACT");
  const occupation = (await platform!.admin.query("SELECT owner,status FROM finnor_os.work_programme_occupations WHERE work_id=$1", [f.intake.workId])).rows;
  assert.equal(occupation.find(o => o.owner === "V1_HANDOFF")?.status, "COMPLETE");
  return { intake, rejectedAlteredGap: refused, accepted, finding, consumed, investmentCaseId, run, occupation, original: await rpc(primarySource, { type: "inspect" }) };
}
let lastPositive: { fixture: Awaited<ReturnType<typeof build>>; result: Awaited<ReturnType<typeof finish>>; consumer: any } | undefined;
try {
  platform = await disposablePlatform({ preserveDirectory: Boolean(cumulativePath) });
  if (cumulativePath) await writeFile(join(output, "owned-cluster.json"),
    JSON.stringify({ directory: platform.directory, preservedAfterStop: true }) + "\n");
  observeOwnedSqlFailures();
  process.env.FINNOR_V1_PROFILE = "ordinary_disposable";
  await platform.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Synthetic V1 Firm')", [tenant, randomUUID()]);
  await platform.admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
    VALUES($1,$3,$4,'owner','active','Synthetic owner'),($2,$3,$5,'owner','active','Other synthetic owner')`,
  [actor, other, tenant, actor + "@test.invalid", other + "@test.invalid"]);
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: actor, sourceSystem: "V1:owned-E2E" });
  await platform.admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
    VALUES($1,$2,'synthetic-v1-buyer','Synthetic Buyer Firm','other')`, [buyer, tenant]);
  await platform.admin.query(`INSERT INTO finnor_os.tenant_integrations(tenant_id,capability,binding,mode,config,credential_provider,credential_ref)
    VALUES($1,'communications','gmail','sandbox','{"fixtureOnly":true}','legacy-env','legacy-env:gmail')`, [tenant]);
  await platform.admin.query(`INSERT INTO finnor_os.communication_identities(id,tenant_id,identity_key,provider,channel,address,status,capabilities,credential_provider,credential_ref)
    VALUES($1,$2,'synthetic-v1-sender','gmail','email','representative@bilateral-fixture.invalid','active','["send"]','legacy-env','legacy-env:gmail')`, [senderId, tenant]);
  await platform.admin.query(`INSERT INTO finnor_os.communication_identity_bindings(tenant_id,communication_identity_id,principal_type,principal_id,purpose,priority,status)
    VALUES($1,$2,'employee',$3,'default',100,'active')`, [tenant, senderId, actor]);
  const strategy = await createStrategy(ctx, { name: "Synthetic V1 Sourcing Strategy" }); strategyId = String(strategy.row.id);
  await transitionStrategy(ctx, { strategyId, expectedVersion: 1, targetState: "active" }); root = { entityType: "pe_strategy", entityId: strategyId };
  http = await browserHttpFixture(platform.admin, tenant, actor, other);
  privateDirectory = join(platform.directory, "v1-private"); await mkdir(privateDirectory, { mode: 0o700 });
  candidateConfig = join(privateDirectory, "candidate-source.json"); checkerSourceConfig = join(privateDirectory, "checker-source.json");
  source = await startChild(join(import.meta.dirname, "controlled-source.mts"), { PATH: process.env.PATH, NODE_ENV: "test" }, [privateDirectory], true);
  descriptor = await new Promise<any>((yes, no) => {
    const timer = setTimeout(() => no(Error("INDEPENDENT_SOURCE_START_DEADLINE")), 10000);
    source!.on("message", (m: any) => { if (m.type === "ready") { clearTimeout(timer); yes(m); } }); source!.once("exit", () => no(Error("INDEPENDENT_SOURCE_START_FAILED")));
  });
  if (cumulativePath && allocation.verifySignedLoiHandoff === true) {
    handoffFixture = await prepareSignedLoiHandoff({ admin: platform.admin, tenant, actor, buyer,
      publicKeyPem: descriptor.publicKeyPem, validUntil: expiresAt });
    await rpc(source, { type: "configure-loi", config: { tenant, actorId: handoffFixture.signer,
      token: handoffFixture.token, profiles: handoffFixture.profiles, validUntil: expiresAt } });
  }
  const databasePort = new URL(platform.url).port, key = generateKeyPairSync("ed25519"), requestToken = randomBytes(24).toString("base64url");
  const checkerPassword = randomBytes(24).toString("base64url"), writerPassword = randomBytes(24).toString("base64url");
  await platform.admin.query(`ALTER ROLE finnor_v1_checker LOGIN PASSWORD '${checkerPassword}'`);
  await platform.admin.query(`ALTER ROLE finnor_v1_receipt_writer LOGIN PASSWORD '${writerPassword}'`);
  await writePrivate("checker-database", `postgres://finnor_v1_checker:${checkerPassword}@127.0.0.1:${databasePort}/v2_e2e`);
  await writePrivate("receipt-database", `postgres://finnor_v1_receipt_writer:${writerPassword}@127.0.0.1:${databasePort}/v2_e2e`);
  await writePrivate("checker-signer", key.privateKey.export({ type: "pkcs8", format: "pem" }).toString()); await writePrivate("checker-token", requestToken);
  await writePrivate("checker-config.json", { schema: "finnor.bilateral-original-checker-config.v1",
    databaseUrlPath: join(privateDirectory, "checker-database"), receiptDatabaseUrlPath: join(privateDirectory, "receipt-database"),
    sourceConfigurationPath: checkerSourceConfig, signerPath: join(privateDirectory, "checker-signer"), requestTokenPath: join(privateDirectory, "checker-token"), port: 0 });
  checker = await startChild(join(repo, "finnor-os/packages/private-equity/src/bilateral-opportunities/checker-service.mts"),
    { PATH: process.env.PATH, NODE_ENV: "test", FINNOR_V1_PROFILE: "ordinary_disposable",
      FINNOR_V1_INDEPENDENT_CHECKER_CONFIG: join(privateDirectory, "checker-config.json") });
  checkerDescriptor = await new Promise<any>((yes, no) => {
    let text = "", errors = "";
    const timer = setTimeout(() => no(Error("INDEPENDENT_CHECKER_START_DEADLINE:" + errors.slice(-1000))), 10000);
    checker!.stderr!.on("data", b => { if (errors.length < 4096) errors += b.toString(); });
    checker!.stdout!.on("data", b => { text += b.toString(); for (const line of text.split("\n")) {
      try { const m = JSON.parse(line); if (m.status === "READY") { clearTimeout(timer); yes({ ...m, origin: "http://127.0.0.1:" + m.port }); } } catch { /* incomplete JSON line */ }
    } });
    checker!.once("exit", () => no(Error("INDEPENDENT_CHECKER_START_FAILED:" + errors.slice(-1000))));
  });
  await writePrivate("checker-client.json", { schema: "finnor.bilateral-checker-client.v1", endpoint: checkerDescriptor.origin + "/check",
    publicKeyDigest: hash(checkerDescriptor.publicKeyPem), tokenPath: join(privateDirectory, "checker-token"), tokenDigest: hash(requestToken) });
  process.env.FINNOR_V1_SOURCE_CONFIG = candidateConfig; process.env.FINNOR_V1_CHECKER_CLIENT_CONFIG = join(privateDirectory, "checker-client.json");
  if(process.env.FINNOR_V1_ONE_CLIENT_PROOF==="1"){await closePool();const pool=getPool();pool.options.max=1;assert.equal(pool.totalCount,0);}
  policyRef = await governance({ schema: "finnor.relationship-policy.v1", profileId: randomUUID(), revision: 1, issuingPrincipalId: actor,
    environment: "DEVELOPMENT", validFrom, expiresAt, firmEntityId: buyer, channel: "email", companyMaximumContacts: 8, personMaximumContacts: 8,
    minimumSpacingMs: 0, totalMaximumContacts: 256, visibility: "ENTIRE_AUTHORIZED_TENANT_RELATIONSHIP_DOMAIN",
    suppression: "REFUSAL_OPT_OUT_WITHDRAWAL_IMMEDIATE_ALL_WORKS_AGENTS_MAILBOXES" });
  resourceRefs = [];
  for (const [name, unit, resourceClass] of [["cash", "microUSD", "CASH"], ["cpu", "cpu-microseconds", "COMPUTE"]] as const) {
    const er = (owner: string, id: string) => ({ owner, id, version: "1", contentDigest: hash({ syntheticFixture: id }) });
    const r = await putAllocationResource(ctx, { schema: "finnor.allocation-resource.v1", resourceId: "synthetic-v1-" + name, tenantId: tenant,
      ownerRef: er("BUSINESS_OWNER", actor), legalEntityRef: er("BUSINESS_OWNER", buyer), scopeRef: er("BUSINESS_OWNER", strategyId),
      permittedRoots: [root], rightsRef: "synthetic-explicit-owner-resource-rights", unit, currency: unit === "microUSD" ? "USD" : null,
      kind: "CUMULATIVE_EXPENDITURE", resourceClass, horizon: { periods: 1, periodMs: 3600000, startAt: startedAt },
      sourceRef: er("BUSINESS_OWNER", "explicit-disposable-capacity"), asOf: startedAt, knowledgeAt: startedAt, validUntil: expiresAt, beliefPins: [],
      availability: [{ amount: "1000000000", basis: "REPORTED_AVAILABLE" }, { amount: "1000000000", basis: "REPORTED_AVAILABLE" }],
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }, null);
    resourceRefs.push({ owner: r.ref.owner, id: r.ref.id, revision: r.ref.version, contentDigest: r.ref.contentDigest });
  }
  const identity = await methodIdentity(ctx), dirty = execFileSync("git",
    ["-C", repo, "ls-files", "-m", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude)scope-v/**"],
    { encoding: "utf8" }).split("\0").filter(Boolean);
  await writeFile(join(output, "pre-run-freeze.json"), JSON.stringify({ schema: "finnor.v1.run-freeze.v1", startedAt,
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    identity, node: process.version, manifestDigest: hash(await readFile(join(scope, "verification-plan.json"))),
    allocation: { id: allocationId ?? "original", path: allocationPath, digest: hash(await readFile(allocationPath)), deadline: allocation.deadline },
    dirtyFiles: await Promise.all(dirty.map(async p => ({ path: p, digest: hash(await readFile(join(repo, p))) }))),
    runnerFiles: await Promise.all((await readdir(import.meta.dirname)).filter(n => n.endsWith(".mts")).sort().map(async name =>
      ({ path: "finnor-os/scripts/v1/" + name, digest: hash(await readFile(join(import.meta.dirname, name))) }))),
    checker: checkerDescriptor, source: descriptor, assignedCases: filter ?? "REGISTERED_IMPLEMENTED_CASES",
    workerRuntime: { nodeOptions: "--max-old-space-size=256", subtractStartupMemory: false,
      originalMaximumMemoryBytes: "536870912" },
    authority: "LOCAL_DISPOSABLE_ONLY", cleanInstall: false, protectedAdmission: false,
  }, null, 2) + "\n");
  await test("authenticated-boundary", "Actual auth/user lookup and separate ordinary SQL roles; no candidate receipt INSERT", async () => {
    assert.equal((await http!.call("bilateral-context", { root }, "anonymous")).status, 401);
    assert.equal((await http!.call("bilateral-context", { root }, "invalid")).status, 401);
    const roles = (await platform!.admin.query(`SELECT rolname,rolsuper,rolbypassrls,
      has_table_privilege(rolname,'finnor_os.v1_claim_checks','INSERT') receipt_write
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
    [["finnor_app", "finnor_worker", "finnor_v1_checker", "finnor_v1_receipt_writer"]])).rows;
    assert(roles.every(r => !r.rolsuper && !r.rolbypassrls));
    assert(roles.filter(r => r.rolname !== "finnor_v1_receipt_writer").every(r => !r.receipt_write));
    return { roles, observedAuthentication: http!.observed.userRequests };
  });
  await test("positive", "Actual adaptive outreach/counterproposal/explicit confirmation, six original conjuncts, one immutable canonical identity", async deadline => {
    const f = await build("positive", deadline, { gap: true }), result = await finish(f, deadline), state = result.state;
    assert.equal(state.status, "COMPLETE", JSON.stringify(state));
    assert.equal(state.artifacts.length, 1);
    const a = state.artifacts[0], captures = result.original.accepted.filter((m: any) => m.programmeId === result.accepted.programmeId);
    assert.equal(captures.length, 2); assert(captures[0].subject.startsWith("Bilateral approach ")); assert(captures[1].subject.startsWith("Bilateral confirm "));
    assert.equal(a.terms.controlShareBps, 6500); assert.equal(a.terms.managementParticipationBps, 500);
    assert.equal(a.terms.managementContinuity, "PROPOSED_12_MONTH_CONTINUITY_SUBJECT_TO_DEFINITIVE_AGREEMENT");
    assert.equal(a.originationClass, "CREATED_BILATERAL"); assert.equal(a.causalIncrementalCreation, "NOT_ESTABLISHED"); assert.equal(a.admissionRef, null);
    assert.deepEqual(a.remainingUnderwritingGaps, f.gaps);
    const rows = (await platform!.admin.query(`SELECT o.id,o.state,o.buyer_entity_id,
      (SELECT count(*)::int FROM finnor_os.v1_artifacts WHERE opportunity_id=o.id) artifact_count,
      (SELECT status FROM finnor_os.works WHERE id=$2) work_status
      FROM finnor_os.pe_opportunities o WHERE id=$1`, [a.opportunityId, f.intake.workId])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].state, "qualified"); assert.equal(rows[0].buyer_entity_id, buyer);
    assert.equal(rows[0].artifact_count, 1); assert.notEqual(rows[0].work_status, "completed");
    const handoff = await call("bilateral-handoff", { artifactRef: state.principalArtifactRef });
    assert.equal(handoff.opportunityId, a.opportunityId); assert.equal(handoff.workId, f.intake.workId); assert.deepEqual(handoff.assertions, f.gaps);
    const consumer = await consumeV2(f, handoff, deadline);
    const signedLoiHandoff = handoffFixture ? await exerciseSignedLoiHandoff({
      admin: platform!.admin, tenant, actor, buyer, company: f.company, origin: descriptor.origin,
      fixture: handoffFixture, programmeId: result.accepted.programmeId, artifact: a,
      artifactRef: state.principalArtifactRef, workId: f.intake.workId, workInputId: f.intake.expectedWorkInputId,
      investmentCaseId: consumer.investmentCaseId,
      call,
    }) : null;
    lastPositive = { fixture: f, result, consumer };
    return { intake: f.intake, programme: result.accepted, canonical: rows, artifact: a, handoff, actualV2Consumer: consumer, signedLoiHandoff,
      original: result.original.originals.find((o: any) => o.programmeId === result.accepted.programmeId),
      physicalMessages: captures, independentlyIssuedChecks: (await platform!.admin.query("SELECT body FROM finnor_os.v1_claim_checks WHERE programme_id=$1",
        [result.accepted.programmeId])).rows };
  });
  await test("material-correction", "Real S1/P7 correction fences the exact retained V1 -> V2 -> underwriting descendants", async deadline => {
    let proof = lastPositive;
    if (!proof) {
      const fixture = await build("positive", deadline, { gap: true }), result = await finish(fixture, deadline);
      const handoff = await call("bilateral-handoff", { artifactRef: result.state.principalArtifactRef });
      proof = { fixture, result, consumer: await consumeV2(fixture, handoff, deadline) };
    }
    assert.equal((await http!.call("bilateral-handoff", { artifactRef: proof.result.state.principalArtifactRef })).status, 200);
    await platform!.admin.query("BEGIN");
    try {
      await platform!.admin.query("UPDATE finnor_os.external_organizations SET name='Corrected synthetic identity' WHERE id=$1", [proof.fixture.company]);
      await platform!.admin.query("SELECT finnor_os.p4_touch_source($1,$2)", [tenant, "canonical:external_organization:" + proof.fixture.company]);
      await platform!.admin.query("COMMIT");
    } catch (error) { await platform!.admin.query("ROLLBACK"); throw error; }
    const refused = await http!.call("bilateral-handoff", { artifactRef: proof.result.state.principalArtifactRef });
    assert([404, 422].includes(refused.status));
    const primary = await call("primary-read", { programmeId: proof.consumer.accepted.programmeId });
    assert.equal(primary.status, "BLOCKED"); assert.equal(primary.findings.length, 0);
    await assert.rejects(() => getUnderwritingRun(ctx, proof.consumer.run.id));
    const rows = (await platform!.admin.query(`SELECT d.owner,d.status FROM finnor_os.work_programme_occupations d
      WHERE work_id=$1`, [proof.fixture.intake.workId])).rows;
    const retained = (await platform!.admin.query(`SELECT (SELECT count(*)::int FROM finnor_os.v1_artifacts WHERE programme_id=$1) v1,
      (SELECT count(*)::int FROM finnor_os.v2_findings WHERE programme_id=$2) v2`, [proof.result.accepted.programmeId, proof.consumer.accepted.programmeId])).rows[0];
    assert.equal(retained.v1, 1); assert.equal(retained.v2, 1);
    return { correctedCompany: proof.fixture.company, refused, primary, retained, rows };
  });
  const controls: Array<[string, string, string, string]> = [
    ["role", "role", "DISQUALIFIED", "Independent original role, not a broker's unproved representation"],
    ["identity-conflict", "identity-conflict", "DISQUALIFIED", "Independent conflicted identity cannot qualify"],
    ["wrong-buyer", "wrong-buyer", "NO_ARTIFACT", "Actual received authenticated event for another buyer is refused"],
    ["stale-interest", "stale-interest", "CHECK_REJECTED", "Original old interest fails independent freshness"],
    ["generic-response", "generic-response", "CHECK_REJECTED", "Authenticated networking reply is not exact transaction interest"],
    ["wrong-terms", "wrong-terms", "CHECK_REJECTED", "Original confirmation for another exact terms digest is not current interest"],
    ["unknown-fit", "unknown-fit", "CHECK_REJECTED", "Real inquiry runs, but missing preliminary evidence remains unknown"],
    ["contradicted-fit", "contradicted-fit", "CHECK_REJECTED", "Original contradicted preliminary fit never becomes supported"],
    ["out-of-bounds", "out-of-bounds", "ESCALATION_REQUIRED", "Counterproposal outside original bounds produces the exact owner packet, not another message"],
    ["already-active", "already-active", "ALREADY_ACTIVE", "Covered authoritative active pipeline stops before contact without creation credit"],
    ["preexisting-process", "preexisting-process", "QUALIFIED", "Known process may qualify, but never as CREATED_BILATERAL"],
    ["unresolved-origination", "unresolved-origination", "NO_ARTIFACT", "Unresolved original provenance cannot receive creation credit"],
    ["incomplete-pipeline", "incomplete-pipeline", "NO_ARTIFACT", "Actual incomplete pipeline census never proves absence"],
    ["refusal", "refusal", "DECLINED", "Original refusal is retained and suppresses all subsequent contact"],
  ];
  for (const [id, mode, disposition, expected] of controls) await test(id, expected, async deadline => {
    const f = await build(mode, deadline, { gap: mode === "preexisting-process" }), result = await finish(f, deadline);
    const state = result.state, original = result.original.originals.find((o: any) => o.programmeId === result.accepted.programmeId);
    const captures = result.original.accepted.filter((m: any) => m.programmeId === result.accepted.programmeId);
    const checks = (await platform!.admin.query("SELECT body FROM finnor_os.v1_claim_checks WHERE programme_id=$1", [result.accepted.programmeId])).rows.map(r => r.body);
    const events = (await platform!.admin.query("SELECT semantic_owner,kind,body FROM finnor_os.v1_events WHERE programme_id=$1 ORDER BY created_at",
      [result.accepted.programmeId])).rows;
    assert(original, "INTENDED_ORIGINAL_SOURCE_BOUNDARY_NOT_REACHED");
    if (disposition === "QUALIFIED") {
      assert.equal(state.artifacts.length, 1); assert.equal(state.artifacts[0].originationClass, "NEW_TO_FIRM_PREEXISTING_PROCESS");
      assert.equal(state.artifacts[0].causalIncrementalCreation, "NOT_ESTABLISHED");
    } else {
      assert.equal(state.artifacts.length, 0);
      assert.equal((await platform!.admin.query("SELECT count(*)::int n FROM finnor_os.pe_opportunities WHERE target_organization_id=$1", [f.company])).rows[0].n, 0);
    }
    if (disposition !== "NO_ARTIFACT") assert.equal(state.candidates[0]?.disposition, disposition, JSON.stringify(state));
    if (["role", "identity-conflict", "already-active", "incomplete-pipeline"].includes(mode)) assert.equal(captures.length, 0);
    else assert(captures.length >= 1, "INTENDED_PHYSICAL_CONTACT_AND_PARTICIPANT_BOUNDARY_NOT_REACHED");
    if (disposition === "CHECK_REJECTED") {
      assert.equal(checks.length, 1); assert.equal(checks[0].result, "REJECT");
      assert(original.events.some((r: any) => r.body.kind === "INTEREST"));
      assert(result.original.calls.some((r: any) => r.programmeId === result.accepted.programmeId && r.operation === "CHECK_ORIGINALS" && r.independent));
    }
    if (mode === "out-of-bounds") {
      assert.equal(captures.length, 1); assert.equal(state.status, "BLOCKED"); assert(state.requiredApprovalRefs.length);
      assert(state.approvalPackets.some((p: any) => p.kind === "EXACT_NEW_TERMS_AUTHORITY_REQUIRED" && p.body.requestedTerms.controlShareBps === 9500));
    }
    if (mode === "unknown-fit" || mode === "contradicted-fit") assert(captures[0].subject.startsWith("Bilateral inquire "));
    if (mode === "refusal") {
      assert.equal(captures.length, 1);
      assert((await platform!.admin.query("SELECT id FROM finnor_os.s6_relationship_events WHERE subject_keys @> $1::text[]", [["company:" + f.company]])).rowCount);
    }
    return { intake: f.intake, accepted: result.accepted, state, original, physicalMessages: captures, independentlyIssuedChecks: checks, ownerEvents: events };
  });
  await test("cancel-before", "Actual cancellation retires queued progression before any physical message", async deadline => {
    const f = await build("positive", deadline), accepted = await call("bilateral-submit", f.intake, 202);
    await call("bilateral-cancel", { programmeId: accepted.programmeId }, 202);
    let read: any;
    for (let tick = 0; tick < 32; tick++) {
      await worker(deadline); read = await call("bilateral-read", { programmeId: accepted.programmeId });
      if (read.status === "STOPPED") break;
      await new Promise(yes => setTimeout(yes, 1100));
    }
    const original = await rpc(source!, { type: "inspect" });
    assert.equal(read.status, "STOPPED"); assert.equal(read.artifacts.length, 0);
    assert.equal(original.accepted.filter((m: any) => m.programmeId === accepted.programmeId).length, 0);
    return { accepted, read, physicalMessages: [] };
  });
  await test("kill-after-acceptance", "SIGKILL the actual worker after physical SMTP acceptance, recover original responsibility without duplicate", async deadline => {
    const f = await build("positive", deadline, { acknowledgmentDelayMs: 5000 }), accepted = await call("bilateral-submit", f.intake, 202);
    let killed = false;
    for (let tick = 0; tick < 32 && !killed; tick++) {
      await worker(deadline, child => new Promise<void | NodeJS.Signals>((yes, no) => {
        const cleanup = () => { clearTimeout(timer); source!.off("message", receive); child.off("exit", early); };
        const early = () => { cleanup(); yes(); };
        const receive = (m: any) => { if (m.type !== "accepted" || m.programmeId !== accepted.programmeId) return;
          cleanup(); if (!child.kill("SIGKILL")) no(Error("OWNED_WORKER_PHYSICAL_SIGKILL_FAILED"));
          else { killed = true; yes("SIGKILL"); } };
        const timer = setTimeout(() => { cleanup(); no(Error("TARGET_PHYSICAL_ACCEPTANCE_NOT_OBSERVED")); }, 20000);
        source!.on("message", receive); child.once("exit", early);
      }));
      if (!killed) await new Promise(yes => setTimeout(yes, 1100));
    }
    assert(killed, "TARGET_PHYSICAL_ACCEPTANCE_NOT_OBSERVED");
    const interrupted = (await platform!.admin.query(`SELECT i.*,a.status action_status FROM finnor_os.s6_contact_intents i
      JOIN finnor_os.domain_actions a ON a.tenant_id=i.tenant_id AND a.id=i.action_id WHERE programme_id=$1`, [accepted.programmeId])).rows;
    assert.equal(interrupted.length, 1); assert(["POSSIBLE_EGRESS", "UNKNOWN"].includes(interrupted[0].status));
    const originals = await rpc(source!, { type: "inspect" }); assert.equal(originals.accepted.filter((m: any) => m.programmeId === accepted.programmeId).length, 1);
    const lease = (await platform!.admin.query("SELECT max(lease_expires_at) at FROM finnor_os.jobs WHERE status='running'")).rows[0]?.at;
    if (lease) await new Promise(yes => setTimeout(yes, Math.max(0, new Date(lease).getTime() - Date.now() + 200)));
    let read: any;
    for (let tick = 0; tick < 24; tick++) {
      await worker(deadline); read = await call("bilateral-read", { programmeId: accepted.programmeId });
      if (["COMPLETE", "FAILED", "STOPPED", "BLOCKED"].includes(read.status)) break;
      await new Promise(yes => setTimeout(yes, 1100));
    }
    const after = await rpc(source!, { type: "inspect" }), captures = after.accepted.filter((m: any) => m.programmeId === accepted.programmeId);
    assert.equal(read.status, "COMPLETE", JSON.stringify(read)); assert.equal(read.artifacts.length, 1);
    assert.equal(captures.length, 2); assert.equal(new Set(captures.map((m: any) => m.actionId)).size, 2);
    assert.equal(captures.filter((m: any) => m.actionId === interrupted[0].action_id).length, 1);
    return { intake: f.intake, accepted, interrupted, actualLeaseExpiry: lease, state: read, physicalMessages: captures,
      ownerAttempts: (await platform!.admin.query("SELECT * FROM finnor_os.provider_operation_attempts")).rows };
  });
  await test("suppression-no-policy", "Retained refusal fences the actual S6 provider-entry gate after policy revocation and on an unconfigured channel", async deadline => {
    const f = await build("refusal", deadline), result = await finish(f, deadline);
    assert.equal(result.state.candidates[0]?.disposition, "DECLINED");
    const before = result.original.accepted.filter((m: any) => m.programmeId === result.accepted.programmeId);
    assert.equal(before.length, 1);
    await call("bilateral-governance-revoke", { root, ref: policyRef, reason: "Synthetic owner revokes the channel policy; retained refusal must survive." });
    const attempts: Array<{ channel: string; providerEntered: boolean }> = [];
    for (const channel of ["email", "sms"]) {
      let providerEntered = false;
      await assert.rejects(() => withRelationshipDispatch({
        tenantId: tenant, actorId: actor, actionId: randomUUID(), companyId: f.company, personId: f.person,
        channel, endpoint: f.person + "@bilateral-fixture.invalid",
        validate: async () => { throw Error("SUPPRESSION_MUST_REJECT_BEFORE_UNRELATED_AUTHORIZATION"); },
        dispatch: async () => { providerEntered = true; throw Error("SUPPRESSED_PROVIDER_ENTRY"); },
      }), /S6_FIRM_WIDE_CONTACT_SUPPRESSED/);
      assert.equal(providerEntered, false); attempts.push({ channel, providerEntered });
    }
    const after = await rpc(source!, { type: "inspect" });
    assert.equal(after.accepted.filter((m: any) => m.programmeId === result.accepted.programmeId).length, 1);
    return { accepted: result.accepted, physicalMessages: before, attempts,
      scope: "PRODUCTION_S6_PROVIDER_ENTRY_FENCE_NOT_FULL_ORDINARY_AUTHORIZATION_OR_RACE_PROOF" };
  });
} catch (error) {
  results.push({ id: "setup-or-campaign", status: "FAIL", failure: { message: (error as Error).message, stack: (error as Error).stack } });
  console.error((error as Error).message);
} finally {
  await save();
  for (const child of children) child.kill("SIGTERM");
  for (const child of [...children]) {
    if (child.exitCode === null && child.signalCode === null) await Promise.race([once(child, "exit"), new Promise(yes => setTimeout(yes, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await http?.close(); await closePool(); await platform?.close();
}
const failed = results.some(r => r.status === "FAIL");
console.log(JSON.stringify({ output, status: failed ? "FAIL" : "PARTIAL_DEVELOPMENT" }));
process.exit(failed ? 1 : 0);
