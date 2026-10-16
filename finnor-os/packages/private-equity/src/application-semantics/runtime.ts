/** Trusted native consumer. The learner can use only the closed learning port;
 * it never receives database, credentials, URLs, processes or a wire permit. */
import { randomUUID } from "node:crypto";
import type {
  ApplicationField, ApplicationScope, ApplicationSnapshot, ApplicationState,
  ApplicationTransitionEvidence, CheckedApplicationComposition, ExperimentRef, LearnedApplicationOperation,
  ScopedApplicationIdentity,
} from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { withS5PortfolioTransaction } from "../allocation-store";
import { enqueueOwnerDeliveryInTransaction } from "../../../governed-execution/src/owner-delivery-store";
import { ComputerBroker } from "../../../computer/src/broker";
import {
  ApplicationComputerProvider, ApplicationProviderFault, applicationByteDigest, applicationContentRef,
  applicationResourcePath, type ApplicationReadFence,
} from "../../../computer/src/application-provider";
import { ApplicationSourceSession } from "./source";
import type { ApplicationDiscovery, ApplicationLearningPort, DescribedApplicationOperation, NativeApplicationRequestIdentity } from "./ports";
import {
  applicationArtifact, applicationEvent, applicationSession, assertProfileTarget, currentApplicationModel,
  currentApplicationWork, nativeApplicationProfile, retainApplicationArtifact,
  type ApplicationSessionRow, type NativeApplicationProfile,
} from "./store";
import { assertApplicationAllocationCurrent, chargeApplicationParent, applicationParentCharges } from "./allocation";
import {
  applicationRequest, assertApplicationClaim, beforeApplicationWire, afterApplicationWire,
  prepareApplicationObligation, readApplicationObligation, retainApplicationRequest, settleApplicationObservation,
  type ApplicationRequestRow,
} from "./obligations";
import {
  ApplicationAcquireSchema, ApplicationExecuteSchema, type ApplicationPhase,
} from "./native-contracts";
import {
  applicationDatabaseDiagnostic, applicationFailureReason, applicationWireCorrelation, parseTransitionEvidence,
  sameApplicationScalar, sameX2Ref, x2Digest, x2Fault, x2Ref, X2_LIMITS,
} from "./contracts";
import {
  assertApplicationModelUse, checkApplicationModel, evaluateApplicationGuard, parameterBindingCode,
} from "./checker";
import { learnApplicationActions } from "./learner";
import { applicationGoalEstablished, assertApplicationComposition } from "./composition";
import { assertFreshApplicationProfile } from "./fresh-authority";
import {
  acquireApplicationCapability, applicationConsumerPolicy, recheckApplicationCapability, reconcileApplicationCapability,
} from "../../../capability-evolution/src/application-consumer";
import { applicationRef, ApplicationUseLeaseSchema } from "../../../capability-evolution/src/application-port";
import { currentApplicationCapabilityInput, deliverApplicationReferences } from "./validity";

type SourceEntry = { profile: NativeApplicationProfile; source: ApplicationSourceSession;
  descriptions: Map<string, DescribedApplicationOperation> };
type Descriptor = { description: DescribedApplicationOperation; sourceOperationId: string; entry: SourceEntry };
type RequestObservation = Awaited<ReturnType<ApplicationSourceSession["observeRequest"]>>;
type WireResult = Awaited<ReturnType<ApplicationSourceSession["dispatch"]>>;
const adverse = new Set(["REJECTED", "DENIED", "FAILED", "CANCELLED"]);
const pending = new Set(["PENDING", "ACCEPTED", "QUEUED", "PROCESSING", "AWAITING_APPROVAL"]);
const completed = new Set(["RECORDED", "COMPLETED", "SUBMITTED", "APPROVED"]);
const safeReason = (error: unknown) => error instanceof ApplicationProviderFault ? error.code
  : error instanceof Error && /^[A-Z][A-Z0-9_]{1,159}$/.test(error.message) ? error.message : "X2_NATIVE_PREDICATE_UNPASSED";
function preimage(ref: ExperimentRef, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "ref" in value
    && sameX2Ref((value as { ref: ExperimentRef }).ref, ref)) {
    const { ref: _ref, ...body } = value as Record<string, unknown>;
    if (x2Digest(body) === ref.contentDigest) return body;
  }
  if (x2Digest(value) !== ref.contentDigest) x2Fault("X2_TRUSTED_SOURCE_PREIMAGE_MISMATCH");
  return value;
}
function nativeOperationId(id: string, role: string) {
  return `${id.slice(0, 224)}.${x2Digest({ role }).slice(0, 16)}`;
}
function alias(description: DescribedApplicationOperation): DescribedApplicationOperation {
  return { ...description, id: nativeOperationId(description.id, description.role) };
}
function sameState(before: ApplicationSnapshot, after: ApplicationSnapshot) {
  return before.recordRevision === after.recordRevision && x2Digest(before.state) === x2Digest(after.state)
    && x2Digest(before.unavailableFields) === x2Digest(after.unavailableFields);
}
function requestScope(row: ApplicationRequestRow, before: ApplicationSnapshot, observation: RequestObservation): boolean {
  const body = observation.body;
  return !!body && observation.available && !!observation.sourceRef
    && body.applicationId === before.scope.application && body.accountId === before.scope.account
    && body.recordId === before.target.id && body.principalId === row.body.wire.context.principalId
    && x2Digest(body.request) === x2Digest(row.body.wire.identity)
    && body.applicationVersion === row.body.wire.context.applicationVersion
    && body.schemaRevision === row.body.wire.context.schemaRevision
    && body.semanticRevision === row.body.wire.context.semanticRevision
    && typeof body.acceptedAt === "string" && Number.isFinite(Date.parse(body.acceptedAt));
}
/** Separate from learner inference and from the mutation acknowledgment.
 * A bounded conditional refusal has no positive verification/release credit. */
export function classifyNativeApplicationObservation(input: {
  request: ApplicationRequestRow; before: ApplicationSnapshot; after: ApplicationSnapshot | null;
  observedRequest: RequestObservation; response: WireResult | null; parameters: ApplicationState;
}): { disposition: "VERIFIED" | "DENIED" | "UNKNOWN"; transition: ApplicationTransitionEvidence["disposition"];
  reason: string; asynchronous: boolean } {
  const { request, before, after, observedRequest, response } = input;
  if (!after || x2Digest(after.target) !== x2Digest(before.target) || x2Digest(after.scope) !== x2Digest(before.scope)
    || after.applicationRevision !== before.applicationRevision || after.schemaDigest !== before.schemaDigest
    || after.observationQualification !== "LAWFUL_INDEPENDENT_READBACK") {
    return { disposition: "UNKNOWN", transition: "UNKNOWN", reason: "EXACT_INDEPENDENT_RECORD_SCOPE_OR_COVERAGE_UNAVAILABLE", asynchronous: false };
  }
  const body = observedRequest.body;
  const scoped = requestScope(request, before, observedRequest);
  if (scoped && body && adverse.has(String(body.status).toUpperCase()) && sameState(before, after)) {
    return { disposition: "DENIED", transition: "REJECTED", reason: "INDEPENDENT_EXACT_REJECTED_REQUEST_AND_UNCHANGED_RECORD", asynchronous: false };
  }
  const refusal = request.possible_egress && request.body.wire.expectedVersion === before.recordRevision
    && response?.responseRef && response.status && [400, 401, 403, 404, 405, 409, 412, 422].includes(response.status)
    && response.body && typeof response.body === "object" && !Array.isArray(response.body)
    && ["code", "error"].some((key) => typeof (response.body as Record<string, unknown>)[key] === "string"
      && /^[A-Z][A-Z0-9_]{1,159}$/.test(String((response.body as Record<string, unknown>)[key])));
  if (!scoped && refusal && sameState(before, after)) {
    return { disposition: "DENIED", transition: "REJECTED",
      reason: "ADMITTED_CONDITIONAL_NONACCEPTANCE_WITH_INDEPENDENT_UNCHANGED_EXACT_RECORD", asynchronous: false };
  }
  if (!scoped || !body || after.unavailableFields.length
    || !/^(0|[1-9][0-9]*)$/.test(after.recordRevision) || !/^(0|[1-9][0-9]*)$/.test(before.recordRevision)) {
    return { disposition: "UNKNOWN", transition: "UNKNOWN", reason: "EXACT_REQUEST_IDENTITY_OR_POSTCONDITION_UNAVAILABLE", asynchronous: false };
  }
  const status = String(body.status).toUpperCase();
  if (pending.has(status)) {
    return { disposition: "UNKNOWN", transition: "PENDING", reason: "ASYNC_ACCEPTANCE_NOT_COMPLETED", asynchronous: true };
  }
  const finish = body.completedAt === null && ["RECORDED", "APPROVED"].includes(status) ? body.acceptedAt : body.completedAt;
  if (!completed.has(status) || typeof finish !== "string" || !Number.isFinite(Date.parse(finish))
    || Date.parse(finish) < Date.parse(String(body.acceptedAt)) || Date.parse(finish) > Date.parse(after.observedAt)
    || BigInt(after.recordRevision) <= BigInt(before.recordRevision)) {
    return { disposition: "UNKNOWN", transition: "UNKNOWN", reason: "COMPLETION_OR_EXACT_REVISION_PROGRESSION_UNPROVED", asynchronous: false };
  }
  for (const value of Object.values(input.parameters)) if (value && typeof value === "object" && value.kind === "quantity") {
    const terms = body.reporting;
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
      return { disposition: "UNKNOWN", transition: "UNKNOWN", reason: "EXACT_REQUEST_QUANTITY_TERMS_UNAVAILABLE", asynchronous: false };
    }
    const raw = terms as Record<string, unknown>;
    const observed = raw.kind === "quantity" ? raw : { kind: "quantity", decimal: raw.amount,
      currency: raw.currency, entity: raw.entity, unit: raw.unit, time: raw.date, basis: raw.basis };
    if (x2Digest(observed) !== x2Digest(value)) {
      return { disposition: "UNKNOWN", transition: "UNKNOWN", reason: "EXACT_REQUEST_QUANTITY_TERMS_MISMATCH", asynchronous: false };
    }
  }
  return { disposition: "VERIFIED", transition: "OBSERVED", reason: "INDEPENDENT_EXACT_REQUEST_AND_RECORD_TRANSITION", asynchronous: false };
}

export class NativeApplicationRuntime implements ApplicationLearningPort {
  readonly parent;
  private entries = new Map<string, SourceEntry>();
  private descriptors = new Map<string, Descriptor>();
  private lastDiscovery: ApplicationDiscovery | null = null;
  private declaredFields = new Map<string, ApplicationField>();
  private acquisitionObservations = new Map<string, ApplicationSnapshot>();
  private chargeOrdinal = 0;
  private phase: ApplicationPhase = "ACQUISITION";
  private recovery = false;
  constructor(readonly ctx: PeMutationContext, public session: ApplicationSessionRow,
    readonly execution: Readonly<JobExecutionContext>) {
    this.parent = structuredClone(session.parent);
  }
  adoptCanonicalSession(row: ApplicationSessionRow) {
    if (row.id !== this.session.id || row.generation !== this.session.generation
      || row.request_digest !== this.session.request_digest || row.parent_id !== this.session.parent_id
      || x2Digest(row.parent) !== x2Digest(this.parent) || row.claim_token !== this.execution.claimToken
      || String(row.claim_fence) !== String(this.execution.claimFence)) x2Fault("X2_RUNTIME_CANONICAL_SESSION_SUBSTITUTION");
    this.session = structuredClone(row);
  }
  setPhase(phase: ApplicationPhase, recovery = false) { this.phase = phase; this.recovery = recovery; }
  async assertCurrent() {
    const current = await assertApplicationClaim(this.ctx, this.session, this.execution, undefined, this.recovery);
    await currentApplicationWork(this.ctx, current, undefined, this.recovery);
    await assertApplicationAllocationCurrent(this.ctx, this.session.allocation_ref, undefined, this.recovery);
  }
  private targets() {
    if (this.session.id === this.session.parent_id) return ApplicationAcquireSchema.parse(this.session.request).targets;
    const request = ApplicationExecuteSchema.parse(this.session.request);
    const input = this.session.request;
    return [{ kind: "identity" as const, application: "", account: "", entity: "", id: "targetId" in input ? request.targetId : "" }];
  }
  private async retain(ref: ExperimentRef, value: unknown) {
    const body = preimage(ref, value);
    const schema = body && typeof body === "object" ? (body as Record<string, unknown>).schema : null;
    const privateBody = typeof schema === "string" && (schema.includes(".private-") || schema.includes("snapshot"));
    await retainApplicationArtifact(this.ctx, ref, body, privateBody);
  }
  private readFence(profile: NativeApplicationProfile): ApplicationReadFence {
    const waiting: string[] = [];
    return {
      beforeRead: async (read) => {
        const currentProfile = await nativeApplicationProfile(this.ctx, profile.profile.id);
        if (currentProfile.bindingDigest !== profile.bindingDigest) x2Fault("X2_CURRENT_READ_PROFILE_CHANGED");
        const current = await assertApplicationClaim(this.ctx, this.session, this.execution, undefined, this.recovery);
        await currentApplicationWork(this.ctx, current, undefined, this.recovery);
        const targetIds = this.targets().map((target) => target.id);
        const candidates: string[] = [];
        if (read.kind === "documentation") candidates.push(...profile.profile.documentationPaths);
        if (read.kind === "context" && profile.profile.contextPath) candidates.push(profile.profile.contextPath);
        if (read.kind === "entrypoint" || read.kind === "record") {
          const template = read.kind === "entrypoint" ? profile.profile.entrypoint : profile.profile.recordPathTemplate;
          for (const id of targetIds) candidates.push(applicationResourcePath(template, profile.profile, {
            kind: "identity", application: profile.profile.application, account: profile.profile.account, entity: "read-scope", id,
          }));
        }
        if (read.kind === "request" && read.identity && profile.profile.requestPathTemplate) {
          const request = await applicationRequest(this.ctx, read.identity.requestId);
          if (request.parent_id !== this.session.parent_id || !request.possible_egress
            || x2Digest(read.identity) !== x2Digest(request.body.wire.identity)) x2Fault("X2_READ_ORIGINAL_REQUEST_IDENTITY_REQUIRED");
          candidates.push(applicationResourcePath(profile.profile.requestPathTemplate, profile.profile, undefined, read.identity));
        }
        if (!candidates.some((path) => new URL(path, profile.profile.origin).href === read.url)) x2Fault("X2_EXACT_NATIVE_READ_RESOURCE_REQUIRED");
        const readId = randomUUID();
        await withS5PortfolioTransaction(this.ctx, async (c) => {
          const actual = await assertApplicationClaim(this.ctx, this.session, this.execution, c, this.recovery);
          await currentApplicationWork(this.ctx, actual, c, this.recovery);
          const admittedProfile = await nativeApplicationProfile(this.ctx, profile.profile.id);
          if (admittedProfile.bindingDigest !== profile.bindingDigest) x2Fault("X2_CURRENT_READ_PROFILE_CHANGED");
          const count = (await c.query<{ n: string }>("SELECT count(*)::text n FROM finnor_os.application_semantics_events"
            + " WHERE tenant_id=$1 AND principal_id=$2 AND kind='PHYSICAL_READ_STARTED' AND body->'originalParentRef'=$3::jsonb",
          [this.ctx.auth.tenantId, principal(this.ctx), JSON.stringify(this.session.original_parent_ref)])).rows[0]!;
          if (BigInt(count.n) >= BigInt(X2_LIMITS.maxObservations)) x2Fault("X2_ORIGINAL_AGGREGATE_OBSERVATION_BOUND");
          const meterBody = { schema: "finnor.x2.physical-read-attempt.v1", readId, kind: read.kind,
            resourceDigest: applicationByteDigest(read.url), profileId: profile.profile.id, identity: read.identity,
            sessionId: this.session.id, originalParentRef: this.session.original_parent_ref,
            jobId: this.execution.jobId, claimFence: this.execution.claimFence, phase: this.phase };
          const meterRef = x2Ref("COMPUTER", "application-read-attempt", meterBody);
          await retainApplicationArtifact(this.ctx, meterRef, meterBody, false, c);
          const chargeRef = await chargeApplicationParent(this.ctx, { allocationRef: this.session.allocation_ref,
            consumptionRef: this.session.root_consumption_ref, requestRef: meterRef, phase: this.phase,
            key: `physical-read:${readId}`, units: 1, recovery: this.recovery }, c);
          await applicationEvent(this.ctx, actual, "PHYSICAL_READ_STARTED", { ...meterBody, chargeRef,
            physicalCostUnknownUntilFinished: true, billing: null, aggregateSimultaneousMemory: null }, c);
        });
        waiting.push(readId);
      },
      afterRead: async (read) => {
        const readId = waiting.shift();
        if (!readId) x2Fault("X2_PHYSICAL_READ_START_IDENTITY_REQUIRED");
        await applicationEvent(this.ctx, this.session, "PHYSICAL_READ_FINISHED", { readId, ...read,
          profileId: profile.profile.id, meterCoverage: "ONE_PHYSICAL_REQUEST_BYTES_AND_WALL_NOT_BILLING",
          money: null, providerCredits: null, aggregateSimultaneousMemory: null });
      },
    };
  }
  private async newEntry(id: string): Promise<SourceEntry> {
    const profile = await nativeApplicationProfile(this.ctx, id);
    if (this.session.id !== this.session.parent_id) await assertFreshApplicationProfile(this.ctx, this.session, profile);
    const targetIds = this.targets().map((target) => target.id);
    if (targetIds.some((target) => !profile.profile.allowedTargets.includes(target))) x2Fault("X2_DISCOVERY_TARGET_OUTSIDE_ORIGINAL_GRANT");
    const broker = new ComputerBroker();
    broker.register(new ApplicationComputerProvider());
    const source = new ApplicationSourceSession({ ...profile.profile, allowedTargets: targetIds }, (ref, body) => this.retain(ref, body),
      { computerProvider: broker.applicationProvider(), readFence: this.readFence(profile) });
    if (this.session.model_ref && this.session.check_ref) {
      const { model } = await currentApplicationModel(this.ctx, this.session);
      source.setFieldContract(model.stateSchema);
    }
    return { profile, source, descriptions: new Map() };
  }
  private accumulatedFields(): ApplicationField[] {
    const declarations = [...(this.lastDiscovery?.fields ?? []),
      ...[...this.entries.values()].flatMap(entry => entry.source.fieldDeclarations())];
    for (const field of declarations) {
      const prior = this.declaredFields.get(field.path);
      if (prior && prior.kind !== field.kind) x2Fault("X2_ORIGINAL_FIELD_KIND_DRIFT");
      const values = [...new Map([...(prior?.observedValues ?? []), ...field.observedValues].map(value => [x2Digest(value), value])).values()];
      if (values.length > 32) x2Fault("X2_STATE_PARTITION_BOUND");
      this.declaredFields.set(field.path, { ...structuredClone(field), nullable: field.nullable || prior?.nullable === true,
        observedValues: values,
        observationRefs: [...new Map([...(prior?.observationRefs ?? []), ...field.observationRefs].map(ref => [x2Digest(ref), ref])).values()] });
    }
    if (this.declaredFields.size > 16) x2Fault("X2_STATE_FIELD_BOUND");
    return [...this.declaredFields.values()].map(field => structuredClone(field));
  }
  async discover(): Promise<ApplicationDiscovery> {
    await this.assertCurrent();
    this.accumulatedFields();
    for (const old of this.entries.values()) await old.source.close();
    this.entries.clear();
    this.descriptors.clear();
    this.acquisitionObservations.clear();
    let scope: ApplicationScope | null = null;
    const fields = new Map(), sources = new Map<string, ExperimentRef>(), signatures = new Map<string, ExperimentRef>();
    const substrates = new Set<string>();
    for (const id of this.session.profile_ids) {
      const entry = await this.newEntry(id);
      this.entries.set(id, entry);
      const discovered = await entry.source.discover();
      const originalTargets = this.targets();
      const target = this.session.id === this.session.parent_id ? originalTargets[0]! : {
        ...originalTargets[0]!, application: entry.profile.profile.application, account: entry.profile.profile.account,
        entity: entry.profile.allowedEntities.length === 1 ? entry.profile.allowedEntities[0]! : "",
      };
      assertProfileTarget(entry.profile, target);
      const observed = discovered.observations.find((snapshot) => x2Digest(snapshot.target) === x2Digest(target))
        ?? (await entry.source.observe(target)).snapshot;
      scope ??= observed.scope;
      if (scope.tenantId !== observed.scope.tenantId || scope.principalId !== observed.scope.principalId
        || scope.application !== observed.scope.application || scope.account !== observed.scope.account
        || scope.rightsRef !== observed.scope.rightsRef) x2Fault("X2_DISCOVERY_APPLICATION_ACCOUNT_OR_AUTHORITY_AMBIGUITY");
      for (const operation of discovered.operations) {
        entry.descriptions.set(operation.id, operation);
        const described = alias(operation);
        this.descriptors.set(described.id, { description: described, sourceOperationId: operation.id, entry });
      }
      for (const field of discovered.fields) fields.set(field.path, field);
      for (const ref of discovered.sourceRefs) sources.set(ref.id, ref);
      for (const ref of discovered.typeSignatureRefs) signatures.set(ref.id, ref);
      substrates.add(discovered.substrate);
    }
    if (!scope || this.descriptors.size > 16 || fields.size > 16) x2Fault("X2_NATIVE_DISCOVERY_BOUND_OR_EMPTY");
    const discovery: ApplicationDiscovery = { scope, operations: [...this.descriptors.values()].map((entry) => entry.description),
      fields: [...fields.values()], sourceRefs: [...sources.values()], typeSignatureRefs: [...signatures.values()],
      substrate: substrates.has("HYBRID") || substrates.size > 1 ? "HYBRID" : substrates.has("UI") ? "UI" : "API" };
    this.lastDiscovery = discovery;
    discovery.fields = this.accumulatedFields();
    const body = { schema: "finnor.x2.native-structural-discovery.v1", ...discovery,
      originalParentRef: this.session.original_parent_ref,
      unsupported: [...this.entries.values()].flatMap((entry) => entry.source.unsupported) };
    const ref = x2Ref("COMPUTER", "application-structural-discovery", body);
    await this.retain(ref, body);
    await applicationEvent(this.ctx, this.session, "ORIGINAL_STRUCTURAL_DISCOVERY", { ref });
    return discovery;
  }
  async observe(target: ScopedApplicationIdentity, profileId: string): Promise<ApplicationSnapshot> {
    await this.assertCurrent();
    const entry = this.entries.get(profileId);
    if (!entry) x2Fault("X2_NATIVE_DISCOVERY_PROFILE_REQUIRED");
    assertProfileTarget(entry.profile, target);
    const snapshot = (await entry.source.observe(target)).snapshot;
    if (this.session.id === this.session.parent_id) {
      this.acquisitionObservations.set(x2Digest([target, profileId]), structuredClone(snapshot));
    }
    return snapshot;
  }
  async parameterSamples(operation: DescribedApplicationOperation, observation: ApplicationSnapshot) {
    const descriptor = this.descriptors.get(operation.id);
    if (!descriptor || x2Digest(descriptor.description) !== x2Digest(operation)) x2Fault("X2_NATIVE_ORIGINAL_SIGNATURE_REQUIRED");
    const original = descriptor.entry.descriptions.get(descriptor.sourceOperationId)!;
    return descriptor.entry.source.parameterSamples(original, observation);
  }
  async originalEvidence(): Promise<ApplicationTransitionEvidence[]> {
    return tx(this.ctx, async (c) => {
      const rows = (await c.query<{ body: Omit<ApplicationTransitionEvidence, "ref">; ref: ExperimentRef }>(
        "SELECT a.body,e.body->'detail'->'ref' ref FROM finnor_os.application_semantics_events e JOIN finnor_os.application_semantics_artifacts a"
        + " ON a.tenant_id=e.tenant_id AND a.principal_id=e.principal_id AND a.artifact_id=e.body->'detail'->'ref'->>'id'"
        + " WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.session_id=$3 AND e.kind='ORIGINAL_TRANSITION_EVIDENCE' ORDER BY e.created_at,e.event_id LIMIT 257",
        [this.ctx.auth.tenantId, principal(this.ctx), this.session.id])).rows;
      if (rows.length > 256) x2Fault("X2_NATIVE_ORIGINAL_TRANSITION_BOUND");
      return rows.map(({ body, ref }) => parseTransitionEvidence({ ...body, ref }));
    }, true);
  }
  async retainClaim(ref: ExperimentRef, body: unknown) { await this.retain(ref, body); }
  async charge(input: { phase: "ACQUISITION" | "CHECKING" | "COMPOSITION"; units: number }): Promise<ExperimentRef> {
    this.phase = input.phase;
    return chargeApplicationParent(this.ctx, { allocationRef: this.session.allocation_ref,
      consumptionRef: this.session.root_consumption_ref, requestRef: this.session.original_parent_ref,
      phase: input.phase, key: `compute:${this.execution.deliveryAttemptId}:${++this.chargeOrdinal}`, units: input.units });
  }
  private async observeDisposition(entry: SourceEntry, request: ApplicationRequestRow,
    before: ApplicationSnapshot, result: WireResult | null, operation?: LearnedApplicationOperation) {
    const obligation = await readApplicationObligation(this.ctx, x2ObligationRef(request.obligation_id));
    let after: ApplicationSnapshot | null = null, observedRequest: RequestObservation = { body: null, sourceRef: null, available: false };
    let classified = classifyNativeApplicationObservation({ request, before, after, observedRequest, response: result, parameters: obligation.parameters });
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        observedRequest = await entry.source.observeRequest(request.body.wire.identity);
        after = (await entry.source.observe(before.target)).snapshot;
        classified = classifyNativeApplicationObservation({ request, before, after, observedRequest, response: result, parameters: obligation.parameters });
      } catch (error) {
        classified = { disposition: "UNKNOWN", transition: "UNKNOWN", reason: safeReason(error), asynchronous: false };
        break;
      }
      if (classified.transition !== "PENDING") break;
      if (Date.now() + 100 >= Date.parse(this.parent.deadlineAt)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (classified.disposition === "VERIFIED" && after && operation) {
      try { this.assertPredictedTransition(operation, before, after, obligation.parameters); }
      catch (error) {
        const { invalidateApplicationOperation } = await import("./validity");
        await invalidateApplicationOperation(this.ctx, this.session, operation.id, after, safeReason(error));
        classified = { disposition: "UNKNOWN", transition: "UNKNOWN", reason: safeReason(error), asynchronous: false };
      }
    }
    await settleApplicationObservation(this.ctx, this.session, request, obligation, {
      disposition: classified.disposition, observation: after, requestObservationRef: observedRequest.sourceRef,
      responseRef: result?.responseRef ?? null, reason: classified.reason, execution: this.execution,
    });
    return { after, observedRequest, classified, obligation };
  }
  async interact(input: { operation: DescribedApplicationOperation; target: ScopedApplicationIdentity;
    parameters: ApplicationState; purpose: "AUTHORIZED_EXPLORATION" }): Promise<ApplicationTransitionEvidence> {
    if (this.session.id !== this.session.parent_id || input.purpose !== "AUTHORIZED_EXPLORATION") x2Fault("X2_EXPLORATION_ORIGINAL_PARENT_REQUIRED");
    const descriptor = this.descriptors.get(input.operation.id);
    if (!descriptor || x2Digest(descriptor.description) !== x2Digest(input.operation)) x2Fault("X2_EXPLORATION_ORIGINAL_DESCRIPTOR_REQUIRED");
    const observationKey = x2Digest([input.target, input.operation.profileId]);
    const before = this.acquisitionObservations.get(observationKey) ?? await this.observe(input.target, input.operation.profileId);
    this.acquisitionObservations.delete(observationKey);
    const ordinal = await tx(this.ctx, async (c) => {
      const row = (await c.query<{ n: string }>(
        "SELECT count(*)::text n FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND parent_id=$3",
        [this.ctx.auth.tenantId, principal(this.ctx), this.session.parent_id])).rows[0]!;
      return Number(row.n);
    }, true);
    if (ordinal >= 64) x2Fault("X2_ORIGINAL_AGGREGATE_EXPLORATION_BOUND");
    const nodeId = `exploration:${ordinal + 1}`;
    const { request, result, observed } = await this.perform(descriptor, before, input.parameters, nodeId);
    return this.retainTransition(request, result, observed, input.operation.id, before, input.parameters);
  }
  private async retainTransition(request: ApplicationRequestRow, result: WireResult | null,
    observed: Awaited<ReturnType<NativeApplicationRuntime["observeDisposition"]>>,
    operationId: string, before: ApplicationSnapshot, parameters: ApplicationState) {
    const fallbackResponse = x2Ref("S6", "application-unavailable-response", { requestRef: request.request_ref, outcome: "UNAVAILABLE" });
    if (!result?.responseRef) await this.retain(fallbackResponse, { requestRef: request.request_ref, outcome: "UNAVAILABLE" });
    const body: Omit<ApplicationTransitionEvidence, "ref"> = {
      schema: "finnor.x2.transition-evidence.v1", originalParentRef: this.session.original_parent_ref,
      operationId, parameters, before, after: observed.after,
      disposition: observed.classified.transition, responseRef: result?.responseRef ?? fallbackResponse,
      effectRef: { owner: "S6", id: observed.obligation.effectRef.id, version: "business-effect-v1",
        contentDigest: observed.obligation.effectRef.semanticHash },
      obligationRef: observed.obligation.ref, chargeRefs: [observed.obligation.consumptionRef],
      failureCode: observed.classified.asynchronous ? "ASYNC_ACCEPTANCE"
        : observed.classified.disposition === "VERIFIED" ? null : observed.classified.reason,
      possibleEgress: request.possible_egress, prediction: null,
      independentOutcome: observed.classified.disposition === "VERIFIED" ? "ESTABLISHED"
        : observed.classified.disposition === "DENIED" ? "DENIED" : "UNAVAILABLE",
    };
    const ref = x2Ref("S6", "application-transition", body);
    const evidence = parseTransitionEvidence({ ...body, ref });
    const prior = (await this.originalEvidence()).filter(item => item.effectRef?.id === observed.obligation.effectRef.id).at(-1);
    if (prior && prior.disposition === evidence.disposition && prior.independentOutcome === evidence.independentOutcome
      && x2Digest(prior.after) === x2Digest(evidence.after)) return prior;
    if (prior && (x2Digest(prior.before) !== x2Digest(before) || x2Digest(prior.parameters) !== x2Digest(parameters)
      || prior.operationId !== operationId || prior.independentOutcome !== "UNAVAILABLE")) x2Fault("X2_S6_ORIGINAL_TRANSITION_CANNOT_BE_REPLACED");
    // Original evidence is private owner custody. A candidate cannot overwrite it.
    await tx(this.ctx, async (c) => {
      await retainApplicationArtifact(this.ctx, ref, body, true, c);
      if (this.session.id !== this.session.parent_id) await enqueueOwnerDeliveryInTransaction(c, {
        semanticOwner: "S6", tenantId: this.session.tenant_id, principalId: this.session.principal_id,
      }, { kind: "REFERENCE", identity: ref.id, payload: {
        reference: { ...ref, content: body }, rightsRefs: [this.session.parent.rightsRevision],
      } });
      await applicationEvent(this.ctx, this.session, "ORIGINAL_TRANSITION_EVIDENCE", { ref, requestId: request.id }, c);
    });
    return evidence;
  }
  private async reconcileOriginalCapability(request: ApplicationRequestRow, evidence: ApplicationTransitionEvidence) {
    const records = await tx(this.ctx, async (c) => (await c.query<{ kind: string; detail: {
      leaseRef?: ExperimentRef; evidenceRef?: ExperimentRef; reconciliationRef?: ExperimentRef;
    } }>("SELECT kind,body->'detail' detail FROM finnor_os.application_semantics_events"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
      + " AND kind IN ('S8_EXACT_APPLICATION_USE','S8_EXACT_APPLICATION_RECONCILIATION')"
      + " AND body->'detail'->'requestRef'=$4::jsonb ORDER BY created_at,event_id LIMIT 65",
    [this.session.tenant_id, this.session.principal_id, this.session.id, JSON.stringify(request.request_ref)])).rows, true);
    if (records.length > 64) x2Fault("X2_S8_ORIGINAL_RECONCILIATION_BOUND");
    const uses = records.filter(record => record.kind === "S8_EXACT_APPLICATION_USE");
    if (!uses.length) return; // Explicitly unconfigured development or acquisition.
    if (uses.length !== 1 || !uses[0]!.detail.leaseRef) x2Fault("X2_S8_ORIGINAL_USE_IDENTITY_REQUIRED");
    const lease = ApplicationUseLeaseSchema.parse(await applicationArtifact(this.ctx, uses[0]!.detail.leaseRef));
    if (lease.request.requestId !== request.id || !sameX2Ref(lease.originalParentRef, this.session.original_parent_ref)) {
      x2Fault("X2_S8_ORIGINAL_USE_IDENTITY_REQUIRED");
    }
    const prior = records.filter(record => record.kind === "S8_EXACT_APPLICATION_RECONCILIATION").at(-1);
    if (prior?.detail.evidenceRef && sameX2Ref(prior.detail.evidenceRef, evidence.ref)) return;
    await chargeApplicationParent(this.ctx, {
      allocationRef: this.session.allocation_ref, consumptionRef: this.session.root_consumption_ref,
      requestRef: request.request_ref, phase: "RECOVERY", key: `s8-reconcile:${lease.useId}:${evidence.ref.contentDigest}`,
      units: 16, recovery: true,
    });
    await deliverApplicationReferences(this.ctx, this.session, ["S6"], true);
    const outcome = evidence.disposition === "OBSERVED" ? "OBSERVED" : evidence.disposition === "REJECTED" ? "DECLINED" : "UNKNOWN";
    const reply = await reconcileApplicationCapability(this.parent, lease, evidence.ref, prior?.detail.evidenceRef ?? null, outcome);
    await applicationEvent(this.ctx, this.session, "S8_EXACT_APPLICATION_RECONCILIATION", {
      leaseRef: uses[0]!.detail.leaseRef, requestRef: request.request_ref, evidenceRef: evidence.ref,
      reconciliationRef: reply.ref, outcome, outcomeResolved: reply.outcomeResolved,
      liabilityBudgetReleased: false, economicCreditGranted: false, protectedAdmission: false,
    });
  }
  private async perform(descriptor: Descriptor, before: ApplicationSnapshot, parameters: ApplicationState, nodeId: string,
    operation?: LearnedApplicationOperation) {
    await this.assertCurrent();
    const count = await tx(this.ctx, async (c) => (await c.query<{ n: string }>(
      "SELECT count(*)::text n FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND parent_id=$3",
      [this.ctx.auth.tenantId, principal(this.ctx), this.session.parent_id])).rows[0]!.n, true);
    if (BigInt(count) >= BigInt(X2_LIMITS.maxExplorationInteractions)) x2Fault("X2_ORIGINAL_AGGREGATE_INTERACTION_BOUND");
    const preparationBody = { schema: "finnor.s4.application-operation-preparation.v1", sessionId: this.session.id,
      originalParentRef: this.session.original_parent_ref, modelRef: this.session.model_ref, checkRef: this.session.check_ref,
      compositionRef: this.session.composition_ref, operationId: descriptor.description.id, parameters, before, nodeId,
      deadlineAt: this.parent.deadlineAt, executionAuthorityGranted: false };
    const preparationRef = x2Ref("S4", "application-operation-preparation", preparationBody);
    const operationRef = x2Ref("S4", "application-operation-claim", operation ?? descriptor.description);
    await tx(this.ctx, async (c) => {
      await retainApplicationArtifact(this.ctx, preparationRef, preparationBody, false, c, [this.parent.rightsRevision]);
      await retainApplicationArtifact(this.ctx, operationRef, operation ?? descriptor.description, false, c, [this.parent.rightsRevision]);
    });
    const obligation = await prepareApplicationObligation(this.ctx, this.session, {
      profile: descriptor.entry.profile, target: before.target, parameters, before, preparationRef, operationRef,
      privateBindingRef: descriptor.description.privateBindingRef, observerContractRef: descriptor.description.observerContractRef,
      nodeId, key: `x2:${this.session.id}:${nodeId}`,
    });
    const identity: NativeApplicationRequestIdentity = { requestId: randomUUID(), effectId: obligation.effectRef.id,
      ...applicationWireCorrelation(obligation.ref, `x2:${this.session.id}:${nodeId}`),
      parentId: this.session.parent_id, deadline: this.parent.deadlineAt };
    const wire = await descriptor.entry.source.prepare(descriptor.sourceOperationId, before.target, parameters, identity);
    const prepared = await retainApplicationRequest(this.ctx, this.session, obligation, wire, {
      profile: descriptor.entry.profile, nodeId, operationId: descriptor.description.id, sourceOperationId: descriptor.sourceOperationId,
      phase: this.phase,
    });
    const capabilityPolicy = operation ? await applicationConsumerPolicy({
      tenantId: this.session.tenant_id, principalId: this.session.principal_id, rightsRef: this.session.parent.rightsRevision,
    }) : null;
    const capabilityInput = operation && capabilityPolicy ? await currentApplicationCapabilityInput(this.ctx, this.session, {
      execution: this.execution, policy: capabilityPolicy, profile: descriptor.entry.profile, operation, before,
      parameters, request: prepared,
    }) : null;
    if (capabilityInput) await chargeApplicationParent(this.ctx, {
      allocationRef: this.session.allocation_ref, consumptionRef: this.session.root_consumption_ref,
      requestRef: prepared.request_ref, phase: "CHECKING", key: `s8-use:${prepared.id}`, units: 32,
    });
    const capabilityLease = capabilityInput ? await acquireApplicationCapability(capabilityInput) : null;
    if (capabilityInput && !capabilityLease) x2Fault("X2_S8_CONFIGURED_POLICY_REMOVED");
    if (capabilityLease) {
      const ref = applicationRef("use", capabilityLease);
      await this.retain(ref, capabilityLease);
      await applicationEvent(this.ctx, this.session, "S8_EXACT_APPLICATION_USE", {
        leaseRef: ref, requestRef: prepared.request_ref, operationId: operation!.id,
        currentnessRef: capabilityLease.currentnessRef, protectedAdmission: false, executionAuthorityGranted: false,
      });
    } else if (operation) await applicationEvent(this.ctx, this.session, "S8_APPLICATION_UNCONFIGURED_DEVELOPMENT", {
      operationId: operation.id, requestRef: prepared.request_ref, admissionClaimed: false, protectedAdmission: false,
    });
    let result: WireResult | null = null;
    try {
      result = await descriptor.entry.source.dispatch(wire, {
        beforeWire: async (physical) => {
          try {
            await beforeApplicationWire(this.ctx, this.session, prepared, this.execution, physical, async () => {
              if (!capabilityLease || !capabilityPolicy) await this.assertCurrent();
              if (operation) {
                if (!capabilityLease || !capabilityPolicy) {
                  await assertFreshApplicationProfile(this.ctx, this.session, descriptor.entry.profile, operation);
                  const { model, check } = await currentApplicationModel(this.ctx, this.session);
                  assertApplicationModelUse(model, check);
                  if (x2Digest(model.operations.find((item) => item.id === operation.id)) !== x2Digest(operation)
                    || evaluateApplicationGuard(operation.precondition, before.state, parameters) !== true
                    || parameterBindingCode(operation.parameters, parameters)) x2Fault("X2_FINAL_CURRENT_FROZEN_OPERATION_GUARD_OR_PARAMETERS");
                }
                if (capabilityLease && capabilityPolicy) {
                  const started = performance.now();
                  const input = await currentApplicationCapabilityInput(this.ctx, this.session, {
                    execution: this.execution, policy: capabilityPolicy, profile: descriptor.entry.profile,
                    operation, before, parameters, request: prepared, recheckLease: capabilityLease,
                  });
                  const currentnessFinished = performance.now();
                  await chargeApplicationParent(this.ctx, {
                    allocationRef: this.session.allocation_ref, consumptionRef: this.session.root_consumption_ref,
                    requestRef: prepared.request_ref, phase: "CHECKING", key: `s8-recheck:${prepared.id}`, units: 32,
                  });
                  const fundingFinished = performance.now();
                  const rechecked = await recheckApplicationCapability(input, capabilityLease);
                  const recheckFinished = performance.now();
                  const { ref, ...body } = rechecked;
                  await this.retain(ref, body);
                  await applicationEvent(this.ctx, this.session, "S8_EXACT_APPLICATION_EGRESS_RECHECK", {
                    leaseRef: applicationRef("use", capabilityLease), recheckRef: ref,
                    requestRef: prepared.request_ref, operationId: operation.id,
                    wallMs: { nativeCurrentness: currentnessFinished - started,
                      funding: fundingFinished - currentnessFinished, s8Recheck: recheckFinished - fundingFinished },
                    protectedAdmission: false, executionAuthorityGranted: false,
                  });
                } else if (await applicationConsumerPolicy({
                  tenantId: this.session.tenant_id, principalId: this.session.principal_id,
                  rightsRef: this.session.parent.rightsRevision,
                })) x2Fault("X2_S8_POLICY_APPEARED_WITHOUT_BOUND_LEASE");
              }
            });
          } catch (error) {
            // Preserve the trusted owner's refusal before a provider wraps it.
            await applicationEvent(this.ctx, this.session, "NATIVE_BEFORE_WIRE_REFUSED", {
              requestRef: prepared.request_ref, obligationRef: obligation.ref,
              reason: applicationFailureReason(error), databaseDiagnostic: applicationDatabaseDiagnostic(error),
              jobId: this.execution.jobId, claimFence: this.execution.claimFence,
            });
            throw error;
          }
        },
        afterWire: async (response) => afterApplicationWire(this.ctx, this.session, prepared, response),
      });
    } catch (error) {
      const current = await applicationRequest(this.ctx, prepared.id);
      if (!current.possible_egress) throw error;
    }
    const request = await applicationRequest(this.ctx, prepared.id);
    const observed = await this.observeDisposition(descriptor.entry, request, before, result, operation);
    if (operation) {
      const evidence = await this.retainTransition(request, result, observed, operation.id, before, parameters);
      await this.reconcileOriginalCapability(request, evidence);
    }
    return { request, result, observed };
  }
  async acquire() {
    const request = ApplicationAcquireSchema.parse(this.session.request);
    const model = await learnApplicationActions(this, request.targets);
    await this.charge({ phase: "CHECKING", units: 1 });
    if (!this.lastDiscovery) x2Fault("X2_ORIGINAL_DISCOVERY_REQUIRED_FOR_CHECKER");
    const check = checkApplicationModel(model, {
      scope: this.lastDiscovery.scope, originalParentRef: this.parent.originalParentRef, checkerRef: this.parent.checkerRef,
      runtimeRef: this.parent.runtimeRef, grammarRef: this.parent.grammarRef, dependencyPins: this.parent.dependencyPins,
      descriptions: this.lastDiscovery.operations, declaredFields: this.accumulatedFields(),
      originalEvidence: await this.originalEvidence(),
    });
    const { ref: checkRef, ...checkBody } = check;
    await this.retain(checkRef, checkBody);
    await this.assertCurrent();
    await applicationEvent(this.ctx, this.session, "FROZEN_MODEL_AND_INDEPENDENT_CHECK", {
      modelRef: model.ref, checkRef, originalParentRef: this.parent.originalParentRef,
      protectedAdmission: false, externalUniversalProof: false,
      chargesDigest: x2Digest(await applicationParentCharges(this.ctx, this.session.allocation_ref)),
    });
    return { model, check };
  }
  async freshInitial() {
    const request = ApplicationExecuteSchema.parse(this.session.request);
    if (!this.lastDiscovery) await this.discover();
    const entry = this.entries.get(request.executionProfileId);
    if (!entry || entry.profile.allowedEntities.length !== 1) x2Fault("X2_CURRENT_FRESH_EXECUTION_PROFILE_REQUIRED");
    const target: ScopedApplicationIdentity = { kind: "identity", application: entry.profile.profile.application,
      account: entry.profile.profile.account, entity: entry.profile.allowedEntities[0]!, id: request.targetId };
    return this.observe(target, request.executionProfileId);
  }
  private async descriptorFor(operation: LearnedApplicationOperation): Promise<Descriptor> {
    const current = this.descriptors.get(operation.id);
    if (!current || current.description.role !== operation.authorization.role) x2Fault("X2_CURRENT_OPERATION_BINDING_UNAVAILABLE");
    const fresh = await current.entry.source.binding(current.sourceOperationId);
    await assertFreshApplicationProfile(this.ctx, this.session, current.entry.profile, operation);
    await (await import("./validity")).revalidateApplicationOperation(this.ctx, this.session, operation, current.description, fresh);
    return current;
  }
  async continueComposition(composition: CheckedApplicationComposition) {
    const { model, check } = await currentApplicationModel(this.ctx, this.session);
    assertApplicationModelUse(model, check);
    const initial = await this.freshInitial();
    if (x2Digest(initial.target) !== x2Digest(composition.target)) x2Fault("X2_COMPOSITION_FRESH_TARGET_REOBSERVATION_REQUIRED");
    const originalInitial = await this.originalCompositionObservation(composition);
    assertApplicationComposition({ composition, model, check, initial: originalInitial });
    let observed = originalInitial;
    for (const step of composition.steps) {
      await this.assertCurrent();
      const operation = model.operations.find((item) => item.id === step.operationId);
      if (!operation) x2Fault("X2_FROZEN_COMPOSITION_OPERATION_REQUIRED");
      const descriptor = await this.descriptorFor(operation);
      const existing = await tx(this.ctx, async (c) => (await c.query<ApplicationRequestRow>(
        "SELECT * FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND node_id=$4",
        [this.ctx.auth.tenantId, principal(this.ctx), this.session.id, step.id])).rows[0], true);
      if (existing) {
        if (!existing.possible_egress || existing.status !== "VERIFIED") x2Fault("X2_ORIGINAL_EFFECT_REQUIRES_OBSERVATION_NOT_REPLAY");
        const obligation = await readApplicationObligation(this.ctx, x2ObligationRef(existing.obligation_id));
        const parameters = this.bindStepParameters(step, obligation.before);
        if (!existing.observation_ref || x2Digest(obligation.parameters) !== x2Digest(parameters)
          || x2Digest(obligation.target) !== x2Digest(composition.target)
          || !sameState(observed, obligation.before)) x2Fault("X2_EXISTING_STEP_REQUEST_OR_PREDECESSOR_SUBSTITUTION");
        const event = await applicationArtifact<{ detail: { disposition: string; observation: ApplicationSnapshot;
          requestRef: ExperimentRef; obligationRef: ExperimentRef } }>(this.ctx, existing.observation_ref);
        if (event.detail.disposition !== "VERIFIED" || !sameX2Ref(event.detail.requestRef, existing.request_ref)
          || !sameX2Ref(event.detail.obligationRef, obligation.ref)
          || evaluateApplicationGuard(operation.precondition, obligation.before.state, parameters) !== true) x2Fault("X2_EXISTING_STEP_VERIFICATION_SUBSTITUTION");
        this.assertPredictedTransition(operation, obligation.before, event.detail.observation, parameters);
        const evidence = await this.retainTransition(existing, null, {
          after: event.detail.observation, observedRequest: { body: null, sourceRef: null, available: false }, obligation,
          classified: { disposition: "VERIFIED", transition: "OBSERVED", reason: "RETAINED_INDEPENDENT_NATIVE_SETTLEMENT", asynchronous: false },
        }, operation.id, obligation.before, parameters);
        await this.reconcileOriginalCapability(existing, evidence);
        observed = event.detail.observation;
        continue;
      }
      const current = await this.observe(composition.target, descriptor.description.profileId);
      if (!sameState(observed, current)) x2Fault("X2_CURRENT_PREDECESSOR_INTERFERENCE");
      const parameters = this.bindStepParameters(step, current);
      if (parameterBindingCode(operation.parameters, parameters)
        || evaluateApplicationGuard(operation.precondition, current.state, parameters) !== true) x2Fault("X2_CURRENT_SUCCESSOR_GUARD_UNESTABLISHED");
      const executed = await this.perform(descriptor, current, parameters, step.id, operation);
      if (executed.observed.classified.disposition !== "VERIFIED" || !executed.observed.after) x2Fault("X2_FRESH_EFFECT_RECONCILIATION_REQUIRED");
      this.assertPredictedTransition(operation, current, executed.observed.after, parameters);
      observed = executed.observed.after;
    }
    const final = await this.observe(composition.target, ApplicationExecuteSchema.parse(this.session.request).executionProfileId);
    if (!applicationGoalEstablished(composition.goal, final.state)) x2Fault("X2_INDEPENDENT_BUSINESS_GOAL_NOT_ESTABLISHED");
    const unsettled = await tx(this.ctx, async (c) => (await c.query(
      "SELECT id FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND status<>'VERIFIED' LIMIT 1",
      [this.ctx.auth.tenantId, principal(this.ctx), this.session.id])).rowCount, true);
    if (unsettled) x2Fault("X2_NATIVE_EFFECTS_NOT_INDEPENDENTLY_SETTLED");
    return final;
  }
  private bindStepParameters(step: CheckedApplicationComposition["steps"][number], observed: ApplicationSnapshot) {
    const parameters = { ...step.parameters };
    for (const [name, path] of Object.entries(step.parameterObservations)) {
      const value = observed.state[path];
      if (!value || typeof value !== "object" || value.kind !== "identity"
        || value.application !== observed.scope.application || value.account !== observed.scope.account
        || value.entity !== observed.target.entity) x2Fault("X2_FRESH_DEPENDENCY_IDENTITY_UNAVAILABLE");
      parameters[name] = value;
    }
    return parameters;
  }
  private assertPredictedTransition(operation: LearnedApplicationOperation, before: ApplicationSnapshot,
    after: ApplicationSnapshot, parameters: ApplicationState) {
    for (const assignment of operation.postcondition.assignments) {
      const value = assignment.value.kind === "literal" ? assignment.value.value
        : assignment.value.kind === "parameter" ? parameters[assignment.value.name] : before.state[assignment.value.field];
      if (value === undefined || !Object.hasOwn(after.state, assignment.field)
        || !sameApplicationScalar(value, after.state[assignment.field])) x2Fault("X2_OBSERVED_TRANSITION_FALSIFIES_OPERATION");
    }
    for (const field of operation.postcondition.unchanged) if (!Object.hasOwn(before.state, field)
      || !Object.hasOwn(after.state, field) || !sameApplicationScalar(before.state[field], after.state[field])) {
      x2Fault("X2_OBSERVED_INTERFERENCE_FALSIFIES_OPERATION");
    }
  }
  private async originalCompositionObservation(composition: CheckedApplicationComposition): Promise<ApplicationSnapshot> {
    return tx(this.ctx, async (c) => {
      const rows = (await c.query<{ body: ApplicationSnapshot }>(
        "SELECT body FROM finnor_os.application_semantics_artifacts WHERE tenant_id=$1 AND principal_id=$2"
        + " AND body->>'schema'='finnor.x2.application-snapshot.v1' AND body->'sourceRef'=$3::jsonb ORDER BY created_at LIMIT 257",
        [this.ctx.auth.tenantId, principal(this.ctx), JSON.stringify(composition.initialObservationRef)])).rows;
      if (!rows.length || rows.length > 256) x2Fault("X2_ORIGINAL_COMPOSITION_OBSERVATION_REQUIRED");
      const original = rows.find((row) => x2Digest(row.body.scope) === x2Digest(composition.scope)
        && x2Digest(row.body.target) === x2Digest(composition.target));
      if (!original) x2Fault("X2_ORIGINAL_COMPOSITION_OBSERVATION_SCOPE");
      return original.body;
    }, true);
  }
  async reconcilePossibleRequests() {
    this.setPhase("RECOVERY", true);
    const rows = await tx(this.ctx, async (c) => (await c.query<ApplicationRequestRow>(
      "SELECT * FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3"
      + " AND possible_egress AND status NOT IN ('VERIFIED','DENIED') ORDER BY created_at,id LIMIT 65",
      [this.ctx.auth.tenantId, principal(this.ctx), this.session.id])).rows, true);
    if (rows.length > 64) x2Fault("X2_RECOVERY_ORIGINAL_REQUEST_BOUND");
    for (const row of rows) {
      const checked = await applicationRequest(this.ctx, row.id);
      const profile = await nativeApplicationProfile(this.ctx, checked.body.profileId);
      const obligation = await readApplicationObligation(this.ctx, x2ObligationRef(checked.obligation_id));
      if (x2Digest(obligation.before.target) !== x2Digest(obligation.target)
        || !sameX2Ref(obligation.originalParentRef, this.session.original_parent_ref)) x2Fault("X2_RECOVERY_ORIGINAL_OBLIGATION_ANCESTRY");
      const broker = new ComputerBroker();
      broker.register(new ApplicationComputerProvider());
      const source = new ApplicationSourceSession({ ...profile.profile, allowedTargets: [obligation.target.id] },
        (ref, body) => this.retain(ref, body), { readFence: this.readFence(profile), computerProvider: broker.applicationProvider() });
      try {
        const { model } = this.session.model_ref && this.session.check_ref
          ? await currentApplicationModel(this.ctx, this.session) : { model: null };
        if (model) source.setFieldContract(model.stateSchema);
        const operation = model?.operations.find((item) => item.id === checked.body.operationId);
        const observed = await this.observeDisposition({ source, profile, descriptions: new Map() }, checked, obligation.before, null, operation);
        const evidence = await this.retainTransition(checked, null, observed, checked.body.operationId, obligation.before, obligation.parameters);
        if (this.session.id !== this.session.parent_id) await this.reconcileOriginalCapability(checked, evidence);
      }
      finally { await source.close(); }
    }
    return rows.length;
  }
  async close() {
    for (const entry of this.entries.values()) await entry.source.close();
    this.entries.clear();
  }
}
function x2ObligationRef(id: string): ExperimentRef {
  return { owner: "S6", id, version: "application-operation-v1", contentDigest: id.split(":").at(-1)! };
}
/** Actual S6 continuation callee. No independently supplied program body or URL. */
export async function continueNativeApplicationComposition(ctx: PeMutationContext, sessionId: string,
  composition: CheckedApplicationComposition, execution: Readonly<JobExecutionContext>, runtime?: NativeApplicationRuntime) {
  const row = await applicationSession(ctx, sessionId);
  if (!row.composition_ref || !sameX2Ref(row.composition_ref, composition.ref)) x2Fault("X2_CANONICAL_S4_COMPOSITION_REQUIRED");
  const retained = await applicationArtifact<Record<string, unknown>>(ctx, row.composition_ref);
  if (x2Digest(retained) !== composition.ref.contentDigest) x2Fault("X2_S6_RETAINED_COMPOSITION_PREIMAGE");
  const owned = runtime ?? new NativeApplicationRuntime(ctx, row, execution);
  owned.setPhase("EXECUTION");
  try { return await owned.continueComposition(composition); }
  finally { if (!runtime) await owned.close(); }
}
