/** Reusable authenticated, original-Work native journey.
 * Fixture setup declares generated, unqualified S3/S4/S5 hypotheses. Every W4
 * source, consent, response and accounting report uses actual authenticated HTTP;
 * compilation/consumption use the caller's real production queue/worker pump.
 * No supplied receipt, producer artifact, real buyer or real payment is accepted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonical, hash, type GrowthInput, type SourceRef, type NativeRef, type CommercialEvent,
  type MarketValidatedOperatingProgram } from "../../packages/private-equity/src/demand-to-business/contracts";
import { referencePreimageDigest } from "../../packages/governed-execution/src/protocol";
import { growthExecutionRecordKey, growthNativeChange } from "../../packages/private-equity/src/demand-to-business/consumer";
import { growthAccountingPayload } from "../../packages/private-equity/src/demand-to-business/participants";
import type { GrowthNativeExecution } from "../../packages/private-equity/src/demand-to-business/boundaries";
import { prepareCommercialMeasurementFixtures } from "./controlled-commercial-fixture.mjs";
import type { SharedAllocationFixture } from "../postz/integrated/allocation-fixture.mts";
import type { AllocationResource } from "@finnor/shared-types";
import type { ExperimentInputReference } from "./recipient.mts";

export const NATIVE_GROWTH_LIMITS = Object.freeze({ maximumMilliseconds: 1200000, maximumPumpTicks: 192,
  maximumActors: 8, maximumCompanies: 1, maximumAssignments: 1, maximumContacts: 1,
  maximumDeclaredMoneyMinor: "1", maximumNativeRequests: 4, fieldValidated: false });
type Operation = GrowthNativeExecution["operation"];
type MeasurementDeclaration = Awaited<ReturnType<typeof prepareCommercialMeasurementFixtures>>["declareMeasurements"];
type FitMeasurements = Awaited<ReturnType<MeasurementDeclaration>>;
export interface NativeGrowthJourneyContext {
  tenant: string; owner: string; companyId: string; work: { workId: string; workInputId: string };
  actors: { operator: string; buyer: string; observer: string; accountant: string; unrelated?: string; foreign?: string };
  native: { resource: (...args: any[]) => Promise<any>;
    clearing: (...args: any[]) => any; decision: (...args: any[]) => any };
  http: (group: string, operation: string, body: unknown, actor?: string) => Promise<{ status: number; body: any }>;
  ok: (group: string, operation: string, body: unknown, actor?: string) => Promise<any>;
  admin: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
  recipient: { bind: (obligation: any, account: string, key: string,
    declaration: { field: string; value: number; unit: string }) => Promise<any>;
    registerExperimentInputs: (references: readonly ExperimentInputReference[]) => Promise<void>;
    drainNativeReferences: (minimumPendingPerOwner?: number) => Promise<void> };
  pump: (maximumTicks?: number) => Promise<unknown>;
  artifact: (name: string, body: unknown) => Promise<unknown>;
  observeNativeFitOriginals?: (originals: Readonly<Record<string, unknown>>) => Promise<void>;
  checkBound?: () => void;
  namespace?: string;
  declaredMeasurements?: { units: FitMeasurements; money: FitMeasurements };
  buyerContact?: NativeRef;
  originalResources?: { cash: AllocationResource; execution: AllocationResource; human: AllocationResource };
  /** Integrated-only and fixed before prepare(); default keeps all four upfront originals. */
  integratedConditionalRefund?: boolean;
}

export async function prepareNativeGrowthMeasurements(
  c: Pick<NativeGrowthJourneyContext, "tenant" | "owner" | "companyId" | "admin" | "ok" | "artifact">,
  namespace: string, checkBound: () => void, sharedAllocation?: SharedAllocationFixture,
) {
  const root = { entityType: "external_organization" as const, entityId: c.companyId };
  const commercial = await prepareCommercialMeasurementFixtures({ tenant: c.tenant, principal: c.owner, root,
    namespace, admin: c.admin, ok: c.ok, artifact: c.artifact, checkBound, sharedAllocation });
  return (channel: "units" | "money") => {
    const name = namespace + "-" + channel;
    return commercial.declareMeasurements(name, {
      existing: { tenant: c.tenant, principal: c.owner, root }, metricKeyPrefix: name,
      exposureUnit: channel === "units" ? "commercial_unit" : "minor_USD",
      operation: "SERVICE_TRANSITION_V1", context: "controlled-commercial-record",
    });
  };
}

export async function declareNativeGrowthBuyer(
  c: Pick<NativeGrowthJourneyContext, "tenant" | "companyId" | "admin">, namespace: string,
): Promise<NativeRef> {
  const contact = (await c.admin.query(`INSERT INTO finnor_os.external_contacts
    (tenant_id,id,contact_key,name,external_organization_id) VALUES($1,$2,$3,'Synthetic W4 consenting participant',$4)
    RETURNING id,tenant_id,active,updated_at`,
  [c.tenant, randomUUID(), namespace + "-buyer", c.companyId])).rows[0];
  assert(contact);
  return { owner: "external_contact", id: contact.id, version: "w4-customer-identity-v1",
    contentDigest: hash({ id: contact.id, tenantId: contact.tenant_id, active: contact.active,
      updatedAt: new Date(contact.updated_at).toISOString() }) };
}

export function createNativeGrowthJourney(c: NativeGrowthJourneyContext) {
  const namespace = c.namespace ?? "w4-" + randomUUID();
  assert(/^[a-z][a-z0-9-]{1,75}$/.test(namespace), "W4_NATIVE_NAMESPACE");
  const started = performance.now(), purpose = "Controlled W4 commercial operation";
  const { operator, buyer, observer, accountant } = c.actors;
  assert.equal(new Set([c.owner, operator, buyer, observer, accountant]).size, 5, "W4_ACTUAL_DUTIES_INDEPENDENT");
  const scope = { tenantId: c.tenant, principalId: c.owner, companyId: c.companyId,
    workId: c.work.workId, businessAssignmentId: namespace };
  const integratedConditionalRefund = c.integratedConditionalRefund ?? false;
  assert.equal(typeof integratedConditionalRefund, "boolean", "W4_CONDITIONAL_REFUND_MODE");
  const root = { entityType: "external_organization" as const, entityId: c.companyId };
  const money = (minor: string) => ({ currency: "USD", minor });
  const now = () => new Date().toISOString();
  const bound = () => {
    c.checkBound?.(); assert(performance.now() - started < NATIVE_GROWTH_LIMITS.maximumMilliseconds, "W4_NATIVE_ORIGINAL_TIME_BOUND");
  };
  const ok = async (group: string, operation: string, body: unknown, actor = c.owner) => {
    bound(); return c.ok(group, operation, body, actor);
  };
  const pump = async () => {
    // Authority reads can enqueue fresh signed owner records. Service that
    // outbox between native rounds before it reaches the per-owner limit.
    bound();
    await c.recipient.drainNativeReferences(64);
    bound();
    const result = await c.pump(NATIVE_GROWTH_LIMITS.maximumPumpTicks);
    bound();
    await c.recipient.drainNativeReferences(64);
    bound();
    return result;
  };
  const source = async (body: unknown, key: string, actor = c.owner, protocolId: string | null = null): Promise<SourceRef> =>
    (await ok("demand-to-business", "source", { workId: scope.workId, idempotencyKey: namespace + ":" + key,
      purpose, protocolId, body }, actor)).source;
  const nativeRef = (r: SourceRef): NativeRef => ({ owner: "S1", id: r.versionId,
    version: "evidence-source-version-v1", contentDigest: r.contentDigest });
  let prepared: Promise<any> | undefined, input: GrowthInput, parentAllocation: NativeRef, requestId: string;
  let deadline: string, closesAt: string, mandate: SourceRef, accountingPolicy: SourceRef, validFrom: string;
  let program: MarketValidatedOperatingProgram, artifactDigest: string;
  const obligations: Record<string, any> = {}, evidenceProtocols: Record<string, string> = {};
  const eventProtocols: Record<string, string> = {}, recorded: Record<string, SourceRef> = {};
  const executions: Partial<Record<Operation, GrowthNativeExecution>> = {};
  let prepareRequestedRefund: ((requested: SourceRef) => Promise<void>) | undefined;
  const invite = async (role: string, actor: string, kinds: string[], evidenceKinds: string[], key: string,
    assigned = false, expiry = deadline) => {
    const p = await ok("demand-to-business", "invite", { scope, requestId: assigned ? requestId : null,
      participantId: actor, buyerId: role === "BUYER" || assigned ? buyer : null,
      offerId: assigned ? program.offers[0]!.id : null, termsDigest: assigned ? program.offers[0]!.termsDigest : null,
      role, permittedKinds: kinds, evidenceKinds, purpose, expiresAt: expiry });
    const inbox = await ok("demand-to-business", "inbox", {}, actor);
    const invited = inbox.protocols.find((protocol: any) => protocol.id === p.protocolId);
    assert.equal(inbox.scope.principalId, actor); assert.equal(inbox.complete, true);
    assert.equal(invited?.status, "INVITED", "W4_ACTUAL_SELF_INVITATION_MUST_BE_VISIBLE_BEFORE_CONSENT");
    const privateDenials = [];
    for (const other of new Set([c.owner, c.actors.unrelated, c.actors.foreign])) {
      if (!other || other === actor) continue;
      bound();
      const denied = await c.http("demand-to-business", "consent", { protocolId: p.protocolId, revoke: false }, other);
      assert.equal(denied.status, 404, "W4_ANOTHER_IDENTITY_CANNOT_SELF_CONSENT");
      assert(!("scope" in denied.body) && !("protocolId" in denied.body));
      privateDenials.push({ actor: other, status: denied.status, code: denied.body.code });
    }
    await c.artifact(namespace + "/protocol-" + key + "-invited.json",
      { role, actor, protocolId: p.protocolId, status: invited.status, privateDenials });
    await ok("demand-to-business", "consent", { protocolId: p.protocolId, revoke: false }, actor);
    const consenting = await ok("demand-to-business", "inbox", {}, actor);
    assert.equal(consenting.protocols.find((protocol: any) => protocol.id === p.protocolId)?.status, "CONSENTED");
    const workDenied = await c.http("demand-to-business", "read", { workId: scope.workId }, actor);
    assert.equal(workDenied.status, 404, "W4_SELF_CONSENT_MUST_NOT_GRANT_GENERIC_WORK_ACCESS");
    await c.artifact(namespace + "/protocol-" + key + ".json", { role, actor, protocolId: p.protocolId, kinds, evidenceKinds });
    return p.protocolId as string;
  };
  const evidenceBody = (kind: string, subjectId: string, data: Record<string, unknown>,
    basis: SourceRef[] = [], nativeRefs: NativeRef[] = []) => ({
      schema: "finnor.growth-evidence.v1", scope, kind, subjectId, validFrom, validUntil: deadline, data, basis, nativeRefs,
      limitations: ["Authenticated original in a controlled disposable software journey.",
        "Synthetic participant and generated measurement population; not field demand, physical delivery or real cash.",
        "No causal identification, protected business admission or realized-profit qualification."],
  });
  const evidence = (kind: string, subjectId: string, data: Record<string, unknown>, actor: string,
    protocolId: string, key: string, basis?: SourceRef[], nativeRefs?: NativeRef[]) =>
    source(evidenceBody(kind, subjectId, data, basis, nativeRefs), key, actor, protocolId);
  const report = async (body: CommercialEvent, actor: string, protocolId: string, key: string) => {
    const result = await ok("demand-to-business", "report", { protocolId, idempotencyKey: namespace + ":" + key, event: body }, actor);
    recorded[key] = result.source; return result.source as SourceRef;
  };
  const prepare = () => prepared ??= (async () => {
    validFrom = new Date(Date.now() - 1000).toISOString();
    deadline = new Date(Date.now() + 4 * 3600000).toISOString();
    // Declare the original test window once, before fitting. It must cover the
    // registered native run, whose own wall bound still stops late execution.
    closesAt = new Date(Date.now() + NATIVE_GROWTH_LIMITS.maximumMilliseconds).toISOString();
    // Exercise canonical participant consent and original S1 authorship before
    // paying the real S3 fitting cost. These remain the actual later originals.
    evidenceProtocols.operator = await invite("OPERATOR", operator, ["EVIDENCE"], ["CAPABILITY"], "operator-evidence");
    evidenceProtocols.buyer = await invite("BUYER", buyer, ["EVIDENCE"], ["CONSENT", "DEMAND"], "buyer-evidence");
    evidenceProtocols.observer = await invite("INDEPENDENT_OBSERVER", observer, ["EVIDENCE"],
      ["POPULATION", "TEST_PROTOCOL"], "observer-evidence");
    evidenceProtocols.accountant = await invite("ACCOUNTANT", accountant, ["EVIDENCE"],
      ["ACCOUNTING_POLICY", "INVOICE", "ACCOUNTING"], "accountant-evidence");
    const policyData = { accountingCalendar: "UTC-daily", taxTreatment: "Retain actual after-tax expenses and unknowns",
      recognition: "DELIVERED_AND_INDEPENDENTLY_ACCEPTED_ACCRUAL" as const };
    accountingPolicy = await evidence("ACCOUNTING_POLICY", namespace, policyData, accountant,
      evidenceProtocols.accountant, "original-accounting-policy");
    const dimensions = [{ id: "cash", unit: "USD", capacity: 100, totalLimit: 100 },
      { id: "execution", unit: "request", capacity: 512, totalLimit: 512, resourceClass: "COMPUTE" },
      { id: "human", unit: "seconds", capacity: 900, totalLimit: 900, resourceClass: "HUMAN_ATTENTION" }];
    const originalNativeExpiry = new Date(Date.now() + 20 * 60000).toISOString();
    const intake = c.work as unknown as Record<string, unknown>;
    const nativeMandates: Record<string, unknown> = {};
    const observeOriginals = () => c.observeNativeFitOriginals?.({ schema: "finnor.w4.observed-pre-fit-originals.v1",
      scope, actualIntakeIdentityAndStatus: Object.fromEntries(
        ["workId", "workInputId", "instructionId", "created", "duplicate", "status"]
          .filter(key => Object.hasOwn(intake, key)).map(key => [key, intake[key]])),
      intakeFinalOutcomeOmitted: Object.hasOwn(intake, "finalOutcome"),
      originalFacts: Object.fromEntries(["workId", "workInputId", "question", "questionId", "criterion", "criterionId",
        "budgetObligationRef", "originalDeadlineAt"].map(key => [key, Object.hasOwn(intake, key)
        ? { status: "OBSERVED_IN_ACTUAL_INTAKE_RESPONSE", value: intake[key] }
        : { status: "UNKNOWN", reason: "NOT_PRESENT_AS_THIS_FIELD_IN_ACTUAL_INTAKE_RESPONSE_AT_PRE_FIT" }])),
      knownJourneyDates: { validFrom, growthDeadlineAt: deadline, testClosesAt: closesAt, originalNativeExpiry },
      declaredResourceDimensions: dimensions, declaredOriginalLimits: NATIVE_GROWTH_LIMITS,
      nativeOwnerMandates: Object.fromEntries(["units", "amounts"].map(key => [key, Object.hasOwn(nativeMandates, key)
        ? { status: "OBSERVED_IN_COMPLETED_OWNER_FIXTURE", value: nativeMandates[key] }
        : { status: "UNKNOWN", reason: "OWNER_FIXTURE_NOT_YET_COMPLETED_AT_PRE_FIT" }])) });
    await observeOriginals();
    const declareMeasurements = c.declaredMeasurements ? null : await prepareNativeGrowthMeasurements(c, namespace, bound);
    const fitUnits = c.declaredMeasurements?.units ?? await declareMeasurements!("units");
    const units = await fitUnits(dimensions, originalNativeExpiry);
    nativeMandates.units = units.mandate; await observeOriginals();
    const fitMoney = c.declaredMeasurements?.money ?? await declareMeasurements!("money");
    const amounts = await fitMoney(dimensions, originalNativeExpiry);
    nativeMandates.amounts = amounts.mandate; await observeOriginals();
    // Adding distinct money series legitimately changes the root's S1 cut.
    // Refit the quantity model against that final actual cut, never relabel it.
    const refit = await ok("interventions", "fit", { request: units.model.request });
    assert.equal(refit.status, "FITTED", JSON.stringify(refit)); units.model = refit.model;
    amounts.mandate = units.mandate;
    const policies: Record<string, any> = {};
    for (const operation of ["OFFER", "DELIVER", "COLLECT", "REFUND"] as Operation[]) {
      const f = ["OFFER", "DELIVER"].includes(operation) ? units : amounts;
      const zeros = Object.fromEntries(dimensions.map(d => [d.id, 0]));
      const action = (id: string, kind: string) => ({ id, kind, cost: 0, costUnit: "USD",
        resources: kind === "INTERVENE" ? { cash: 1, execution: 120, human: 100 } : zeros,
        occupancy: zeros, occupationPeriods: 1, tailLiability: 0, earliestPeriod: 0, lastPeriod: 0,
        atMostOnce: kind === "INTERVENE", exposures: kind === "INTERVENE" ? { price: [1] } : {},
        protocolRef: null, informationDelayPeriods: 1, humanSeconds: 0 });
      const original = { mandate: units.mandate, problem: { schema: "finnor.control-problem.v1",
        id: namespace + "-" + operation, episodeId: units.mandate.episodeId, modelRef: f.model.ref,
        context: "controlled-commercial-record", regime: "operating", baselineExposures: { price: [0] },
        actions: [action("do-" + operation, "INTERVENE"), action("wait", "WAIT"), action("stop", "STOP")],
        observations: [], obligations: [], validUntil: units.mandate.validUntil }, protocols: [],
        scenarios: { pathsPerMechanism: 4, seed: 20261002 } };
      const result = await ok("policies", "synthesize", original);
      assert.equal(result.status, "POLICY_AVAILABLE", JSON.stringify(result)); assert(result.policy);
      assert.equal(result.policy.nodes.find((n: any) => n.id === result.policy.rootNodeId)?.actionId, "do-" + operation);
      policies[operation] = result.policy; units.policies.push(result.policy); units.labels[result.policy.ref.id] = operation;
      await c.artifact(namespace + "/original-policy-" + operation + ".json", { original, result });
    }
    const resourceIds = c.originalResources ? { cash: c.originalResources.cash.resourceId,
      execution: c.originalResources.execution.resourceId, human: c.originalResources.human.resourceId } : {};
    if (c.originalResources) units.resources.push(...Object.values(c.originalResources));
    else {
      await c.native.resource(units, "cash", "USD", "STOCK", ["100", "100"]);
      await c.native.resource(units, "execution", "request", "CUMULATIVE_EXPENDITURE", ["512", "512"]);
      await c.native.resource(units, "human", "seconds", "CUMULATIVE_EXPENDITURE", ["900", "900"]);
    }
    const originalClearing = c.native.clearing(units,
      Object.fromEntries(Object.keys(policies).map(op => [op, ["100"]])), [], [], units.policies, resourceIds);
    const clearing = await ok("allocations", "clear", originalClearing);
    assert.equal(clearing.status, "FEASIBLE", JSON.stringify(clearing)); parentAllocation = clearing.certificate.ref;
    const mandateBody = { schema: "finnor.growth-mandate.v1", scope, authorizedByPrincipalId: c.owner, purpose,
      permittedCapabilityIds: ["registered-transform"], maximumContacts: 1, maximumMoney: money("100"),
      maximumHumanSeconds: 900, validFrom, expiresAt: deadline, revoked: false };
    mandate = await source(mandateBody, "original-mandate");
    const handoffs: Record<string, any> = {};
    for (const [op, policy] of Object.entries(policies)) {
      if (integratedConditionalRefund && op === "REFUND") continue;
      bound(); await c.recipient.drainNativeReferences(); bound();
      handoffs[op] = await ok("policies", "handoff", {
        policyRef: policy.ref, allocationRef: parentAllocation, decision: c.native.decision(units, parentAllocation) });
    }
    for (const [op, handoff] of Object.entries(handoffs)) {
      obligations[op] = await ok("demand-to-business", "prepare-native", { workId: scope.workId, mandateSource: mandate,
        preparationRef: handoff.preparationRef, allocationRef: parentAllocation, consumptionRef: handoff.consumptionRef });
      assert.equal(obligations[op].workLineage.workId, scope.workId);
      assert.equal(obligations[op].workLineage.workInputId, c.work.workInputId);
    }
    if (integratedConditionalRefund) {
      assert(!Object.hasOwn(handoffs, "REFUND") && !Object.hasOwn(obligations, "REFUND"),
        "W4_CONDITIONAL_REFUND_NOT_PREPARED");
      const originalRefund = Object.freeze({ policyRef: policies.REFUND.ref, allocationRef: parentAllocation,
        mandateSource: mandate });
      await c.artifact(namespace + "/conditional-refund-original.json", {
        scope, originalRefund, originalNativeExpiry, originalDeadlineAt: deadline,
        condition: "ACTUAL_AUTHENTICATED_BUYER_REFUND_REQUEST", nativePrepared: false });
      let refundPreparation: Promise<void> | undefined;
      prepareRequestedRefund = (requested) => {
        assert(recorded["refund-request"] && hash(requested) === hash(recorded["refund-request"]),
          "W4_ACTUAL_BUYER_REFUND_REQUEST_REQUIRED");
        return refundPreparation ??= (async () => {
          bound(); await c.recipient.drainNativeReferences(); bound();
          const handoff = await ok("policies", "handoff", { policyRef: originalRefund.policyRef,
            allocationRef: originalRefund.allocationRef, decision: c.native.decision(units, originalRefund.allocationRef) });
          const obligation = await ok("demand-to-business", "prepare-native", { workId: scope.workId,
            mandateSource: originalRefund.mandateSource, preparationRef: handoff.preparationRef,
            allocationRef: originalRefund.allocationRef, consumptionRef: handoff.consumptionRef });
          assert.equal(obligation.workLineage.workId, scope.workId);
          assert.equal(obligation.workLineage.workInputId, c.work.workInputId);
          handoffs.REFUND = handoff; obligations.REFUND = obligation;
          await c.artifact(namespace + "/conditional-refund-prepared.json", {
            requested, originalRefund, handoff, obligation });
        })();
      };
    }
    const customerRef = c.buyerContact ?? await declareNativeGrowthBuyer(c, namespace);
    const consentData = { buyerId: buyer, customerRef, affiliation: "SYNTHETIC",
      consentValidUntil: deadline, permittedPurpose: purpose };
    const consentSource = await evidence("CONSENT", buyer, consentData, buyer, evidenceProtocols.buyer, "original-consent");
    const populationBody = evidenceBody("POPULATION", namespace, { buyerIds: [buyer],
      affiliations: [{ buyerId: buyer, affiliation: "SYNTHETIC" }] });
    const populationSource = await source(populationBody, "original-population", observer, evidenceProtocols.observer);
    const populationRef = nativeRef(populationSource), mandateRef = nativeRef(mandate);
    const experimentInputs: ExperimentInputReference[] = [
      { ...mandateRef, owner: "S1", content: canonical(mandateBody), digestEncoding: "NATIVE_UTF8_SHA256_V1" },
      { ...populationRef, owner: "S1", content: canonical(populationBody), digestEncoding: "NATIVE_UTF8_SHA256_V1" },
    ];
    const supplied = (id: string, declaration: object) => {
      const content = { qualification: "SYNTHETIC_UNCALIBRATED_INPUT", declaration };
      const ref = { owner: "SUPPLIED" as const, id: namespace + "-" + id, version: "w4-controlled-declaration-v1",
        contentDigest: referencePreimageDigest({ content }) };
      experimentInputs.push({ ...ref, content });
      return ref;
    };
    const endpoint = { id: "registered-response", unit: "category", categories: ["none", "commit"] };
    const instrumentRef = supplied("binary-instrument", endpoint);
    const utility = { lossUnit: "registered-loss", actionIds: ["stop", "continue"], lossByHypothesis: [["0", "1"], ["1", "0"]] };
    const decision = { horizonEnd: closesAt, ...utility };
    const hypotheses = [
      { prior: "0.5", meaning: "Synthetic no-demand hypothesis, not learned market probability" },
      { prior: "0.5", meaning: "Synthetic viable-demand hypothesis, still requires delivery and accounting" },
    ];
    const method = { instrumentError: "IN_LIKELIHOOD", missingness: "NONE",
      dependence: "CONDITIONAL_IID", interference: "NONE", reactivity: "NONE", nuisance: "FIXED_SUPPLIED" };
    const measurementUnit = "consenting-participant";
    const inquiry = { schema: "finnor.s2.design-request.v1", inquiryId: namespace, episodeId: namespace,
      mandateRef, decisionContext: { ref: supplied("decision", decision), utilityRef: supplied("utility", utility), ...decision },
      hypotheses: [
        { ref: supplied("no-demand", hypotheses[0]!), ...hypotheses[0] },
        { ref: supplied("viable", hypotheses[1]!), ...hypotheses[1] },
      ],
      requiredClaimRefs: [], validUntil: closesAt, maxBeliefAgeMs: 3600000,
      constraints: { maxSamples: 1, maxElapsedMs: 20 * 60000, maxExposureUnits: "1", maxPrivacyUnits: "0",
        moneyLimit: { value: "0", unit: "USD" }, permittedPopulationRefs: [populationRef], permittedInstrumentRefs: [instrumentRef] },
      candidates: [{ id: namespace + "-controlled-design", instrumentRef,
        endpoint,
        populationRef, measurementUnit, assignment: { kind: "OBSERVATIONAL", unit: measurementUnit, probability: "1" },
        timing: { startAt: now(), endAt: closesAt, minimumIntervalMs: 0 },
        process: { methodRef: supplied("response-method", method), ...method },
        likelihood: { status: "SUPPLIED_CONDITIONAL", probabilities: [["0.8", "0.2"], ["0.2", "0.8"]],
          calibrationRef: null, assumptions: ["Synthetic supplied likelihood only; not genuine field identification or market probability."] },
        samples: 1, stopping: { method: "FIXED_SAMPLE", alpha: "0.05", beta: "0.05", minimumPower: "0" },
        costEstimate: { money: { value: "0", unit: "USD" }, elapsedMs: 100, humanSeconds: 0, dataBytes: 1024,
          integrationUnits: 0, computeMs: null }, exposure: { unitsPerSample: "1", privacyUnitsPerSample: "0",
          riskAssumptions: ["Controlled disposable software participant only."] } }] };
    await c.recipient.registerExperimentInputs(experimentInputs);
    const design = await ok("experiments", "design", { root, request: inquiry });
    const protocol = design.designs[0]?.protocol; assert(protocol, JSON.stringify(design));
    assert.equal((await ok("experiments", "validate", { protocol })).status, "CURRENT");
    const s2ProtocolRef = { owner: "S2", id: protocol.id, version: protocol.version, contentDigest: protocol.contentDigest };
    const capabilityData = { id: "registered-transform", name: "Source-backed controlled original record transformation",
      outcomeIds: ["processed-record"], prerequisites: [], validUntil: deadline, capacityUnits: 1, committedUnits: 0,
      supportCapacityUnits: 1, committedSupportUnits: 0, unitCost: money("0"), unitSupportCost: money("0"),
      deliveryLeadHours: 1, supportHours: 1, permittedClaims: ["One independently accepted controlled software record transformation"],
      operatorId: operator, operationRef: obligations.DELIVER.ref };
    const capabilitySource = await evidence("CAPABILITY", "registered-transform", capabilityData, operator,
      evidenceProtocols.operator, "original-capability");
    const demandData = { id: namespace + "-problem", description: "An unseen controlled adjacent record needs a supported transformation",
      outcomeIds: ["processed-record"], buyerIds: [buyer], existingAlternatives: ["Manual transformation"],
      selectionBias: ["Synthetic controlled participant; no generalization to actual buyers"], validUntil: deadline };
    const demandSource = await evidence("DEMAND", namespace, demandData, buyer, evidenceProtocols.buyer, "original-demand");
    const testData = { independentObservationOwnerId: observer, design: "OBSERVATIONAL" as const,
      causalStatus: "UNIDENTIFIED" as const, s2ProtocolRef, s3ModelRef: null, maxContacts: 1, maxMoney: money("100"),
      maxHumanSeconds: 900, closesAt, minimumCommitments: 1, minimumRepetitions: 1, stopOnIncrementalLoss: true as const,
      nonresponse: "RETAIN_IN_ORIGINAL_DENOMINATOR" as const, offeredExposure: "ASSIGNED_ONCE_BEFORE_CONTACT" as const,
      allowedChanges: ["NO_NEW_EXPOSURE"] as "NO_NEW_EXPOSURE"[] };
    const protocolSource = await evidence("TEST_PROTOCOL", namespace, testData, observer,
      evidenceProtocols.observer, "original-test-protocol", [populationSource], [s2ProtocolRef]);
    input = { schema: "finnor.growth-outcome.v1", scope, originalMeaning: "Test an adjacent supported software operation, not forecast or fabricate market success",
      mandateSource: mandate, validFrom, originalDeadlineAt: deadline, marketRevision: namespace + "-original",
      currency: "USD", parentPolicy: policies.OFFER.ref, parentAllocation, budgetObligation: obligations.OFFER.ref,
      question: "Can this exact controlled participant commit to, receive, accept and account for one supported transformation?",
      permittedPurpose: purpose, permittedCapabilityIds: ["registered-transform"],
      capabilities: [{ ...capabilityData, source: capabilitySource }], demands: [{ ...demandData, source: demandSource }],
      population: [{ ...consentData, affiliation: "SYNTHETIC", consentSource }],
      test: { ...testData, populationSource, protocolSource }, terms: { revision: namespace,
        minimumContributionMinor: "1", maximumUnitPrice: money("1"), maximumUnitsPerBuyer: 1,
        refunds: "Refund undelivered or rejected value on the original protected identity",
        warranty: "Retain one-hour controlled support responsibility", exclusions: ["No actual buyer contact, payment or regulated operation"],
        disclosure: "Synthetic engineering journey, no genuine field-demand or financial result",
        accountingPolicySource: accountingPolicy, ...policyData }, reservedDecisions: [] };
    await c.artifact(namespace + "/original-inputs.json", { input, inquiry, protocol, originalClearing, clearing, handoffs,
      identities: { tenant: c.tenant, principal: c.owner, companyId: c.companyId, work: c.work },
      independentW4Grant: true, w3GrantReused: false, fieldValidated: false });
    return { scope, input, obligations, parentAllocation, deadline, closesAt };
  })();
  const read = async () => {
    const answer = await ok("demand-to-business", "read", { workId: scope.workId });
    return { answer, request: answer.requests.find((r: any) => r.requestId === requestId) };
  };
  const compile = async () => {
    await prepare();
    const outcomeSource = await source(input, "original-outcome");
    const submitted = await ok("demand-to-business", "submit", {
      workId: scope.workId, workInputId: c.work.workInputId, idempotencyKey: namespace + ":submit",
      outcomeSource, budgetObligationRef: obligations.OFFER.ref, s7EstimandId: null });
    requestId = submitted.requestId; await pump();
    const state = (await read()).request; assert(state?.program, JSON.stringify(state));
    assert.equal(state.check.disposition, "CHECKED_DEVELOPMENT"); assert.equal(state.program.offers.length, 1);
    assert.equal(state.program.assignedExposure.length, 1); assert.equal(state.program.offers[0].unitPrice.minor, "1");
    program = state.program; artifactDigest = state.artifactDigest;
    eventProtocols.response = await invite("BUYER", buyer, ["RESPONSE"], [], "buyer-response", true, closesAt);
    eventProtocols.buyer = await invite("BUYER", buyer, ["DELIVERY_ACCEPTANCE", "SUPPORT", "REFUND"], [], "buyer-continuing", true);
    eventProtocols.operator = await invite("OPERATOR", operator, ["DELIVERY"], [], "operator-delivery", true);
    eventProtocols.accountant = await invite("ACCOUNTANT", accountant, ["COLLECTION", "RECOGNITION", "REFUND", "COST"],
      [], "accountant-ledger", true);
    eventProtocols.observer = await invite("INDEPENDENT_OBSERVER", observer, ["TEST_CLOSED", "MARKET_CHANGE"],
      [], "observer-continuing", true);
    return state;
  };
  const common = () => ({ scope, buyerId: buyer, offerId: program.offers[0]!.id,
    termsDigest: program.offers[0]!.termsDigest, at: now() });
  const native = async (operation: Operation, basis: SourceRef[] = []) => {
    const terms = common(), body = { schema: "finnor.growth-native-execution.v1" as const, ...terms,
      operation, applicationAccountId: operator, quantity: ["OFFER", "DELIVER"].includes(operation) ? 1 : null,
      amount: ["COLLECT", "REFUND"].includes(operation) ? money("1") : null, basis,
      obligationRef: obligations[operation].ref, parentAllocation };
    const { at: ignored, ...withoutAt } = body;
    assert(!executions[operation], "W4_NATIVE_OPERATION_ALREADY_BOUND");
    const binding = await c.recipient.bind(obligations[operation], operator, growthExecutionRecordKey(body), growthNativeChange(body));
    const original: GrowthNativeExecution = { ...withoutAt, execution: binding };
    executions[operation] = original; await source(original, "native-" + operation);
    await pump();
    const state = (await read()).request, observed = state.nativeEffects.find((f: any) => f.kind === operation);
    if (observed?.state !== "VERIFIED") {
      const validation = await c.http("allocations", "validate", { allocationRef: parentAllocation })
        .catch((error: unknown) => ({ observed: false, errorType: error instanceof Error ? error.name : "Unknown" }));
      await c.artifact(namespace + "/native-" + operation + "-allocation-failure.json", {
        operation, effectState: observed?.state ?? null, validation,
      });
    }
    assert.equal(observed?.state, "VERIFIED", JSON.stringify(state));
    assert.equal(observed.originalIdentityReadback, true);
    return { source: original, state, observed };
  };
  const offer = () => native("OFFER", [input.demands[0]!.source, input.population[0]!.consentSource]);
  const accept = async () => {
    const r = await report({ ...common(), kind: "RESPONSE", response: "ACCEPTED", quantity: 1 },
      buyer, eventProtocols.response!, "buyer-acceptance"); await pump();
    const state = (await read()).request; assert.equal(state.projection.counts.accepted, 1, JSON.stringify(state));
    return { source: r, state };
  };
  const deliver = async () => {
    await native("DELIVER", [recorded["buyer-acceptance"]!]);
    const delivered = await report({ ...common(), kind: "DELIVERY", quantity: 1, effectRef: obligations.DELIVER.ref },
      operator, eventProtocols.operator!, "delivery");
    const accepted = await report({ ...common(), kind: "DELIVERY_ACCEPTANCE", deliveredSourceIds: [delivered.sourceId],
      quantity: 1, accepted: true }, buyer, eventProtocols.buyer!, "delivery-acceptance"); await pump();
    const state = (await read()).request; assert.equal(state.projection.counts.delivered, 1, JSON.stringify(state));
    return { delivered, accepted, state };
  };
  const accounting = async (event: CommercialEvent, key: string) => {
    const original = await evidence("ACCOUNTING", namespace + "-" + key, growthAccountingPayload(event),
      accountant, evidenceProtocols.accountant!, "accounting-" + key);
    return { ...event, accountingRef: nativeRef(original) } as CommercialEvent;
  };
  const collect = async () => {
    const terms = common();
    const invoice = await evidence("INVOICE", namespace, { buyerId: buyer, offerId: terms.offerId,
      termsDigest: terms.termsDigest, amount: money("1") }, accountant, evidenceProtocols.accountant!, "invoice");
    await native("COLLECT", [invoice]);
    const event = await accounting({ ...common(), kind: "COLLECTION", amount: money("1"), invoiceRef: nativeRef(invoice),
      accountingRef: nativeRef(invoice), effectRef: obligations.COLLECT.ref }, "collection");
    const r = await report(event, accountant, eventProtocols.accountant!, "collection"); await pump();
    const state = (await read()).request; assert.equal(state.projection.accounting.collectedMinor, "1", JSON.stringify(state));
    return { source: r, state };
  };
  const recognize = async () => {
    const placeholder = nativeRef(accountingPolicy);
    const event = await accounting({ ...common(), kind: "RECOGNITION", amount: money("1"), accountingRef: placeholder,
      accountingPolicySource: accountingPolicy, acceptedSourceIds: [recorded["delivery-acceptance"]!.sourceId] }, "recognition");
    const r = await report(event, accountant, eventProtocols.accountant!, "recognition"); await pump();
    const state = (await read()).request; assert.equal(state.projection.accounting.recognizedMinor, "1", JSON.stringify(state));
    assert.equal(state.projection.s7ProfitQualified, false); assert.equal(state.projection.fieldValidated, false);
    return { source: r, state };
  };
  const refund = async () => {
    const requested = await report({ ...common(), kind: "REFUND", amount: money("1"), status: "REQUESTED",
      requestSourceId: null, accountingRef: null, effectRef: null }, buyer, eventProtocols.buyer!, "refund-request");
    await pump();
    if (prepareRequestedRefund) await prepareRequestedRefund(requested);
    await native("REFUND", [requested]);
    const event = await accounting({ ...common(), kind: "REFUND", amount: money("1"), status: "SETTLED",
      requestSourceId: requested.sourceId, accountingRef: nativeRef(accountingPolicy), effectRef: obligations.REFUND.ref }, "refund");
    const r = await report(event, accountant, eventProtocols.accountant!, "refund"); await pump();
    const state = (await read()).request; assert.equal(state.projection.accounting.refundedMinor, "1", JSON.stringify(state));
    return { source: r, state };
  };
  const run = async () => {
    await compile(); await offer(); await accept(); await deliver(); await collect(); await recognize();
    const final = (await read()).request;
    await c.artifact(namespace + "/native-owner-result.json", { scope, requestId, artifactDigest, final,
      preservedOriginalWork: true, limits: NATIVE_GROWTH_LIMITS, fieldValidated: false,
      qualification: "ACTUAL_AUTHENTICATED_QUEUE_S5_S6_S7_CONTROLLED_SOFTWARE_JOURNEY_NOT_FIELD_OR_PROFIT" });
    return { scope, requestId, artifactDigest, final, obligations, input };
  };
  return { prepare, compile, offer, accept, deliver, collect, recognize, refund, read, run,
    scope, limits: NATIVE_GROWTH_LIMITS, evidenceProtocols, eventProtocols, recorded, executions,
    get requestId() { return requestId }, get originalInput() { return input }, get program() { return program } };
}
