/** S4 binding implementation and mandatory shared-owner ABI. There is no
 * caller-supplied adapter, optional dispatch callback, effect or grant writer. */
import type { PoolClient } from "pg";
import type { ApplicationSnapshot, ExperimentRef } from "@finnor/shared-types";
import { parseControlDecision } from "@finnor/epistemic-runtime";
import * as s4 from "../../enterprise-control";
import type { PeMutationContext } from "../../types";
import { principal } from "../../evidence-execution/store";
import * as app from "../../application-semantics/store";
import { ApplicationSnapshotSchema, CheckedApplicationCompositionBodySchema, parseApplicationCheck,
  parseApplicationComposition, parseApplicationModel, sameX2Ref, x2Ref } from "../../application-semantics/contracts";
import { ApplicationExecuteSchema } from "../../application-semantics/native-contracts";
import { assertApplicationModelUse } from "../../application-semantics/checker";
import { currentFreshApplicationAuthority } from "../../application-semantics/fresh-authority";
import { chooseExactS4Branch } from "../../capital-program/r2-owners";
import { readApplicationObligation } from "../../application-semantics/obligations";
import type { InstitutionApplicationOrigin } from "../../../../orchestration/src/project-z/z0-convergence/institution-origin";
import { isGovernedChild, Z3_STEP_RECEIPT, type ApplicationSelectionRow } from "../../application-semantics/governed";
import { assertViabilityClaimTx, viabilitySession } from "./store";
import { hash, z3Fault, type ViabilityClaim } from "./contracts";
import { LATE_BOUND_MODEL_REVISION, parseGeneralNativeModel, type GeneralNativeModel, type NativeDomainField, type NativeDomainRegion,
  type NativeDomainValue, type NativeFacts, type NativeObservation, type NativeObserver } from "./general-model";

export const GENERAL_S4_BINDING = "finnor.s4.z3-original-operation-binding.v2" as const;
export interface GeneralOwnerRequest {
  workId: string; workInputId: string; originalParentId: string; parentRequestId: string;
  reservationRef: ExperimentRef; model: GeneralNativeModel;
}
export interface GeneralOwnerEvidence {
  schema: typeof GENERAL_S4_BINDING;
  mapDigest: string; digest: string;
  revisions: Array<{ observerId: string; revision: ExperimentRef; contextDigest: string }>;
  operations: Array<{ edgeIndex: number; operationDigest: string }>;
  capacity: number;
  settlements: Array<{ alias: string; obligationId: string; receiptRef: ExperimentRef }>;
}
export interface GeneralOwnerInvocation {
  sessionId: string; claim: ViabilityClaim; cursorDigest: string;
}
export interface GeneralOwnerObservation extends NativeObservation {
  receiptRef: ExperimentRef;
}
interface GeneralS4Owners {
  Z3_GENERAL_OPERATION_BINDING: typeof GENERAL_S4_BINDING;
  resolveEnterpriseViabilityBindingsTx(ctx: PeMutationContext, request: GeneralOwnerRequest,
    c: PoolClient): Promise<GeneralOwnerEvidence>;
  observeEnterpriseViabilityStateTx(ctx: PeMutationContext, request: GeneralOwnerRequest, observerId: string,
    invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralOwnerObservation>;
  dispatchEnterpriseViabilityOperationTx(ctx: PeMutationContext, request: GeneralOwnerRequest, edgeIndex: number,
    invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralOwnerObservation>;
  composeEnterpriseApplicationOperations(ctx: PeMutationContext,
    input: { sessionId: string; initial: ApplicationSnapshot; requiredFirstOperationId: string }, c: PoolClient):
    ReturnType<typeof s4.composeEnterpriseApplicationOperations>;
}

/** The named exports must be installed in the actual S4 module. Merely passing
 * an object with a version/boolean into a request cannot install this binding. */
export function generalS4Owners(): GeneralS4Owners {
  const owner = s4 as unknown as Record<string, unknown>;
  if (owner.Z3_GENERAL_OPERATION_BINDING !== GENERAL_S4_BINDING
    || ["resolveEnterpriseViabilityBindingsTx", "observeEnterpriseViabilityStateTx",
      "dispatchEnterpriseViabilityOperationTx", "composeEnterpriseApplicationOperations"]
      .some(name => typeof owner[name] !== "function")) z3Fault("Z3_S4_GENERAL_OPERATION_OWNER_NOT_INSTALLED");
  return s4 as unknown as GeneralS4Owners;
}

async function originalRequest(ctx: PeMutationContext, request: GeneralOwnerRequest, c: PoolClient) {
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) z3Fault("Z3_NATIVE_CURRENT_OWNER_REQUIRED");
  const row = (await c.query<{ instruction_text: string }>(
    `SELECT i.instruction_text FROM finnor_os.works w
     JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
     JOIN finnor_os.p1_requests p ON p.tenant_id=w.tenant_id AND p.work_id=w.id AND p.work_input_id=i.id
     WHERE w.tenant_id=$1 AND w.created_by=$2 AND w.id=$3 AND i.id=$4 AND p.id=$5
       AND p.principal_id=$2 AND w.status NOT IN('completed','cancelled','failed')
       AND p.status IN('WAITING','RUNNING','QUEUED','PARTIAL')
       AND i.id=(SELECT n.id FROM finnor_os.work_inputs n WHERE n.tenant_id=w.tenant_id
         AND n.work_id=w.id ORDER BY n.created_at DESC,n.id DESC LIMIT 1) FOR SHARE OF w,p`,
    [ctx.auth.tenantId, principal(ctx), request.workId, request.workInputId, request.parentRequestId])).rows[0];
  if (!row) z3Fault("Z3_NATIVE_ORIGINAL_OWNER_CONTEXT_CHANGED");
  let original: unknown;
  try { original = JSON.parse(row.instruction_text); } catch { z3Fault("Z3_ORIGINAL_NATIVE_MANDATE_REQUIRED"); }
  const actual = parseGeneralNativeModel(original);
  if (actual.mapDigest !== request.model.mapDigest || hash(actual.arena) !== hash(request.model.arena)) {
    z3Fault("Z3_NATIVE_ORIGINAL_MAPPING_CHANGED");
  }
}

async function applicationContext(ctx: PeMutationContext, request: GeneralOwnerRequest,
  observer: Extract<NativeObserver, { kind: "APPLICATION_SNAPSHOT" }>, c: PoolClient) {
  // Resolve the actual original P1 responsibility, never a convenient session
  // ID or an independently created application parent. A late-bound observer
  // names no identity: it is the single child continuing the original request.
  const lateBound = observer.lateBinding === "ACCEPTED_ORIGIN_MODEL";
  const rows = (await c.query<{ id: string; origin: InstitutionApplicationOrigin }>(
    `SELECT s.id::text,a.body origin FROM finnor_os.application_semantics_sessions s
     JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=s.tenant_id
       AND a.principal_id=s.principal_id AND a.artifact_id=s.parent->'institutionalOriginRef'->>'id'
     WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.work_id=$3 AND s.work_input_id=$4
       AND a.body->>'schema'='finnor.z0.institution-application-origin.v1'
       AND a.body->'selector'->>'programId'=$5
       AND ($6::text IS NULL OR a.body->'selector'->>'responsibilityIdentity'=$6)
       AND s.id<>s.parent_id AND s.cancel_requested_at IS NULL
       AND s.status NOT IN('CANCELLED','FAILED') ORDER BY s.id LIMIT 2`,
    [ctx.auth.tenantId, principal(ctx), request.workId, request.workInputId,
      request.parentRequestId, lateBound ? null : observer.responsibilityIdentity ?? null])).rows;
  if (rows.length !== 1 || !rows[0]) z3Fault("Z3_NATIVE_UNIQUE_ORIGINAL_APPLICATION_OWNER_REQUIRED");
  const row = await app.applicationSession(ctx, rows[0].id, c, true);
  const originRef = row.parent.institutionalOriginRef;
  if (!originRef) z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_REQUIRED");
  const origin = await app.applicationArtifact<InstitutionApplicationOrigin>(ctx, originRef, c);
  if (origin.compilerEpisodeId !== request.originalParentId
    || !sameX2Ref(origin.originalReservationRef, request.reservationRef)
    || origin.workId !== request.workId || origin.workInputId !== request.workInputId
    || origin.selector.programId !== request.parentRequestId
    || !lateBound && origin.selector.responsibilityIdentity !== observer.responsibilityIdentity) {
    z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_CHANGED");
  }
  if (lateBound) {
    if (!row.model_ref || !row.check_ref) z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_CHANGED");
    const parent = await app.applicationSession(ctx, row.parent_id, c);
    const accepted = (await c.query<{ model: ExperimentRef; check: ExperimentRef; identity: string }>(
      `SELECT body->'detail'->'modelRef' model,body->'detail'->'checkRef' "check",
         body->'detail'->>'responsibilityIdentity' identity
       FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3
         AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED' LIMIT 2`,
      [ctx.auth.tenantId, principal(ctx), parent.id])).rows;
    if (parent.status !== "MODEL_READY" || accepted.length !== 1 || !accepted[0]
      || !sameX2Ref(accepted[0].model, row.model_ref) || !sameX2Ref(accepted[0].check, row.check_ref)
      || accepted[0].identity !== origin.selector.responsibilityIdentity
      || !sameX2Ref(parent.original_parent_ref, row.original_parent_ref)) {
      z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_CHANGED");
    }
  }
  await app.currentApplicationWork(ctx, row, c);
  if (!row.model_ref || !row.check_ref) z3Fault("Z3_NATIVE_CURRENT_TYPED_APPLICATION_MODEL_REQUIRED");
  const model = parseApplicationModel({ ...await app.applicationArtifact<object>(ctx, row.model_ref, c), ref: row.model_ref });
  const check = parseApplicationCheck({ ...await app.applicationArtifact<object>(ctx, row.check_ref, c), ref: row.check_ref });
  assertApplicationModelUse(model, check);
  const authority = await currentFreshApplicationAuthority(ctx, row, c);
  const profiles = await Promise.all(row.profile_ids.map(id => app.nativeApplicationProfile(ctx, id)));
  for (const binding of authority.bindings) {
    const current = profiles.find(p => p.profile.id === binding.profileId);
    if (!current || current.bindingDigest !== binding.privateProfileBindingDigest
      || current.profile.role !== binding.role || current.applicationAccountId !== binding.applicationAccountId
      || !sameX2Ref(current.profile.grantRef, binding.currentGrantRef)) z3Fault("Z3_NATIVE_CURRENT_APPLICATION_PROFILE_CHANGED");
    app.assertProfileTarget(current, authority.target);
  }
  const execute = ApplicationExecuteSchema.parse(row.request);
  const observations = (await c.query<{ ref: ExperimentRef; body: unknown; created_at: Date }>(
    `SELECT jsonb_build_object('owner',semantic_owner,'id',artifact_id,'version',version,
       'contentDigest',content_digest) ref,body,created_at FROM finnor_os.application_semantics_artifacts
     WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='COMPUTER'
       AND body->>'schema'='finnor.x2.application-snapshot.v1'
       AND body->>'observationQualification'='LAWFUL_INDEPENDENT_READBACK'
       AND body->'target'=$3::jsonb AND created_at>=$4 ORDER BY created_at DESC,artifact_id LIMIT 2`,
    [ctx.auth.tenantId, principal(ctx), JSON.stringify(authority.target), row.created_at])).rows;
  if (!observations[0] || observations[1]?.created_at.getTime() === observations[0].created_at.getTime()) {
    z3Fault("Z3_NATIVE_CURRENT_ORIGINAL_READBACK_MISSING_OR_AMBIGUOUS");
  }
  const snapshot = ApplicationSnapshotSchema.parse(await app.applicationArtifact(ctx, observations[0].ref, c));
  const readbackAuthority = authority.bindings.find(binding => binding.role === snapshot.scope.role
    && sameX2Ref(binding.currentGrantRef, snapshot.scope.grantRef));
  if (!sameX2Ref(x2Ref("COMPUTER", "application-observation", snapshot), observations[0].ref)
    || !readbackAuthority
    || snapshot.scope.tenantId !== ctx.auth.tenantId || snapshot.scope.principalId !== principal(ctx)
    || snapshot.scope.rightsRef !== row.parent.rightsRevision || snapshot.target.id !== execute.targetId
    || snapshot.scope.application !== authority.target.application || snapshot.scope.account !== authority.target.account
    || Date.parse(snapshot.observedAt) < row.created_at.getTime() || Date.parse(snapshot.observedAt) > Date.now()) {
    z3Fault("Z3_NATIVE_ACTUAL_ORIGINAL_READBACK_SCOPE_CHANGED");
  }
  return { row, model, check, authority, execute, snapshot, snapshotRef: observations[0].ref };
}

const applicationRevision = (observer: Extract<NativeObserver, { kind: "APPLICATION_SNAPSHOT" }>, model: ExperimentRef) =>
  observer.lateBinding === "ACCEPTED_ORIGIN_MODEL" ? LATE_BOUND_MODEL_REVISION : model;

async function context(ctx: PeMutationContext, request: GeneralOwnerRequest, observer: NativeObserver, c: PoolClient) {
  if (observer.kind === "APPLICATION_SNAPSHOT") {
    const value = await applicationContext(ctx, request, observer, c);
    return { kind: observer.kind, revision: applicationRevision(observer, value.model.ref),
      digest: hash({ model: value.model.ref, check: value.check.ref, authority: value.authority,
        originalParent: value.row.original_parent_ref }), application: value } as const;
  }
  if (observer.kind === "EXACT_POLICY") {
    const policy = await s4.readEnterpriseExactControlPolicy(ctx, observer.policyRef);
    return { kind: observer.kind, revision: policy.ref,
      digest: hash({ policy: policy.ref, original: policy.original, source: policy.sourceIdentity }), exact: policy } as const;
  }
  const current = await s4.readEnterpriseControlDecisionContext(ctx, observer.policyRef);
  const instrument = current.policy.problem.observations.find(i => i.id === observer.instrumentId);
  if (!instrument || observer.availablePeriod < instrument.delayPeriods
    || observer.availablePeriod > current.policy.mandate.horizon.periods) z3Fault("Z3_NATIVE_ORIGINAL_CONTROL_INSTRUMENT_CHANGED");
  return { kind: observer.kind, revision: current.policy.ref,
    digest: hash({ policy: current.policy.ref, model: current.model.ref, instrument,
      kernel: current.kernel.ref, protocols: current.protocols.map(p => ({ id: p.id, contentDigest: p.contentDigest })) }),
    control: current, instrument } as const;
}

export async function resolveGeneralS4BindingsTx(ctx: PeMutationContext, request: GeneralOwnerRequest,
  c: PoolClient): Promise<GeneralOwnerEvidence> {
  await originalRequest(ctx, request, c);
  const contexts = new Map<string, Awaited<ReturnType<typeof context>>>();
  for (const observer of request.model.original.observers) contexts.set(observer.id, await context(ctx, request, observer, c));
  const revisions = [...contexts].map(([observerId, value]) => ({
    observerId, revision: value.revision, contextDigest: value.digest,
  }));
  const predicates = [...request.model.original.observations.map(r => r.predicate),
    ...request.model.original.environment.map(r => r.predicate),
    ...request.model.original.assumptions.flatMap(r => r.clauses), ...request.model.original.goals.flatMap(r => r.clauses)];
  for (const p of predicates) {
    const owner = contexts.get(p.observerId)!;
    if (!sameX2Ref(p.revision, owner.revision)) z3Fault("Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED");
    const fields = new Set(["$view", "$maximum", "$remaining", "$capacity", "$unknownDigest",
      ...request.model.arena.resources.obligationIds.map(id => `$unknown:${id}`)]);
    if (owner.kind === "CONTROL_OBSERVATION") ["token", "availablePeriod"].forEach(field => fields.add(field));
    if (owner.kind === "EXACT_POLICY") ["resultKind", "variantId", "status", "actionId", "nodeId"].forEach(field => fields.add(field));
    if (owner.kind === "APPLICATION_SNAPSHOT") {
      ["resultKind", "disposition", "operationId"].forEach(field => fields.add(field));
      for (const field of owner.application.model.stateSchema) {
        if (field.kind === "quantity") for (const key of ["kind", "decimal", "currency", "entity", "unit", "time", "basis"]) fields.add(`state.${field.path}.${key}`);
        else if (field.kind === "identity") for (const key of ["kind", "application", "account", "entity", "id"]) fields.add(`state.${field.path}.${key}`);
        else fields.add(`state.${field.path}`);
      }
    }
    if (Object.keys(p.values).some(field => !fields.has(field))) z3Fault("Z3_NATIVE_UNOBSERVABLE_OR_ORACULAR_PREDICATE_FIELD");
  }
  const operations = request.model.original.controller.map(binding => {
    const value = contexts.get(binding.operation.observerId)!;
    const operation = binding.operation;
    if (operation.kind === "APPLICATION_COMPOSE") {
      if (value.kind !== "APPLICATION_SNAPSHOT") z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
      const actual = value.application.model.operations.find(o => o.id === operation.operationId);
      if (!actual || actual.semanticRevision !== operation.semanticRevision
        || !value.application.check.acceptedOperationIds.includes(actual.id)
        || !value.application.authority.bindings.some(b => b.operationIds.includes(actual.id)
          && b.role === actual.authorization.role && sameX2Ref(b.originalGrantRef, actual.authorization.grantRef))) {
        z3Fault("Z3_NATIVE_ADMITTED_TYPED_OPERATION_REQUIRED");
      }
      return { edgeIndex: binding.edgeIndex, operationDigest: hash({ operation: actual,
        model: value.application.model.ref, check: value.application.check.ref, authority: value.digest }) };
    }
    if (operation.kind === "EXACT_CONTROL_CHOOSE") {
      if (value.kind !== "EXACT_POLICY") z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
      const choice = chooseExactS4Branch(value.exact, parseControlDecision(operation.decision));
      if (choice.actionId !== operation.actionId) z3Fault("Z3_NATIVE_ORIGINAL_EXACT_BRANCH_BINDING_CHANGED");
      return { edgeIndex: binding.edgeIndex, operationDigest: hash({ policy: value.revision, operation, choice }) };
    }
    if (value.kind !== "CONTROL_OBSERVATION") z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
    return { edgeIndex: binding.edgeIndex, operationDigest: hash({ operation, instrument: value.instrument, context: value.digest }) };
  });
  const capacityContext = request.model.original.resources.capacityObserverId;
  const capacityOwner = capacityContext === null ? null : contexts.get(capacityContext);
  if (capacityOwner && capacityOwner.kind !== "APPLICATION_SNAPSHOT") z3Fault("Z3_NATIVE_UNKNOWN_CAPACITY_OWNER_REQUIRED");
  const capacity = capacityOwner?.kind === "APPLICATION_SNAPSHOT"
    ? capacityOwner.application.model.envelope.supportedDomain.maxUnresolvedEffects : 0;
  if (capacity !== request.model.arena.resources.capacity) z3Fault("Z3_NATIVE_ORIGINAL_UNKNOWN_CAPACITY_CHANGED");
  // The current S5 owner explicitly retains occupation and grants no release
  // after its S6 reconciliation. A public renewal label is not that missing
  // typed original-resource renewal receipt.
  if (request.model.original.resources.renewals.length) z3Fault("Z3_S5_ORIGINAL_RENEWAL_RECEIPT_REPRESENTATION_REQUIRED");
  const settlements: GeneralOwnerEvidence["settlements"] = [];
  const settlementBindings: Array<{ alias: string; obligationRef: ExperimentRef }> = [];
  for (const binding of request.model.original.resources.settlements) for (const member of binding.obligations) {
    const obligation = await readApplicationObligation(ctx, member.obligationRef, c);
    if (obligation.ref.id !== member.obligationId || ![...contexts.values()].some(value =>
      value.kind === "APPLICATION_SNAPSHOT"
      && sameX2Ref(value.application.row.original_parent_ref, obligation.originalParentRef))) {
      z3Fault("Z3_NATIVE_S6_ORIGINAL_PARENT_CHANGED");
    }
    settlementBindings.push({ alias: binding.alias, obligationRef: obligation.ref });
    const effect = (await c.query<{ status: string; verification: { evidenceRef?: ExperimentRef } | null; semantic_hash: string }>(
      "SELECT status,verification,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [ctx.auth.tenantId, obligation.effectRef.id])).rows[0];
    if (!effect || effect.semantic_hash !== obligation.effectRef.semanticHash) z3Fault("Z3_NATIVE_ORIGINAL_S6_SETTLEMENT_REQUIRED");
    // A pending/UNKNOWN obligation is a valid binding but is NOT a settlement.
    if (!["verified", "cancelled"].includes(effect.status) || !effect.verification?.evidenceRef) continue;
    const receiptRef = effect.verification.evidenceRef;
    const event = await app.applicationArtifact<{ schema: string; sessionId: string;
      originalParentRef: ExperimentRef; kind: string; detail: { obligationRef: ExperimentRef;
        effectRef: unknown; disposition: string; observation: ApplicationSnapshot | null } }>(ctx, receiptRef, c);
    if (event.schema !== "finnor.x2.native-event.v1" || event.kind !== "INDEPENDENT_APPLICATION_DISPOSITION"
      || !["VERIFIED", "DENIED"].includes(event.detail.disposition) || !event.detail.observation
      || (event.detail.disposition === "VERIFIED") !== (effect.status === "verified")
      || event.detail.observation.observationQualification !== "LAWFUL_INDEPENDENT_READBACK"
      || !sameX2Ref(event.detail.obligationRef, obligation.ref) || hash(event.detail.effectRef) !== hash(obligation.effectRef)
      || !sameX2Ref(event.originalParentRef, obligation.originalParentRef)) {
      z3Fault("Z3_NATIVE_ORIGINAL_S6_SETTLEMENT_REQUIRED");
    }
    const session = await app.applicationSession(ctx, event.sessionId, c);
    if (session.work_id !== request.workId || session.work_input_id !== request.workInputId
      || !sameX2Ref(session.original_parent_ref, event.originalParentRef)) z3Fault("Z3_NATIVE_S6_ORIGINAL_PARENT_CHANGED");
    settlements.push({ alias: binding.alias, obligationId: member.obligationId, receiptRef });
  }
  // The evidence digest excludes transient observed state, current counters
  // and settlement availability. Those are observed and checked at each step.
  const body = { schema: GENERAL_S4_BINDING, mapDigest: request.model.mapDigest, revisions, operations, capacity };
  return { ...body, settlements, digest: hash({ ...body, settlementBindings }) };
}

async function invocationCurrent(ctx: PeMutationContext, request: GeneralOwnerRequest,
  invocation: GeneralOwnerInvocation, c: PoolClient) {
  await originalRequest(ctx, request, c);
  const row = await assertViabilityClaimTx(ctx, await viabilitySession(ctx, invocation.sessionId, c), invocation.claim, c);
  if (row.work_id !== request.workId || row.work_input_id !== request.workInputId
    || row.original_parent_id !== request.originalParentId) z3Fault("Z3_NATIVE_OPERATION_ORIGINAL_CLAIM_CHANGED");
}
function flattenState(state: ApplicationSnapshot["state"]): NativeFacts {
  const facts: NativeFacts = {};
  for (const [field, value] of Object.entries(state)) {
    if (value === null || typeof value !== "object") facts[`state.${field}`] = value;
    else for (const [key, leaf] of Object.entries(value)) if (typeof leaf === "string") facts[`state.${field}.${key}`] = leaf;
  }
  return facts;
}
async function retainObservation(ctx: PeMutationContext, request: GeneralOwnerRequest, invocation: GeneralOwnerInvocation,
  observation: NativeObservation, c: PoolClient): Promise<GeneralOwnerObservation> {
  const body = { schema: "finnor.s4.z3-original-observation.v2", tenantId: ctx.auth.tenantId,
    principalId: principal(ctx), workId: request.workId, workInputId: request.workInputId,
    originalParentId: request.originalParentId, mapDigest: request.model.mapDigest,
    sessionId: invocation.sessionId, cursorDigest: invocation.cursorDigest,
    deliveryAttemptId: invocation.claim.physical.deliveryAttemptId, claimFence: invocation.claim.sessionFence, observation };
  const receiptRef = x2Ref("S4", "z3-original-observation", body);
  await app.retainApplicationArtifact(ctx, receiptRef, body, true, c);
  return { ...observation, receiptRef };
}
/** The executable path is a separately versioned S4 export; a missing or
 * different binding is a named refusal, never a fall back to the review path. */
export function generalS4ExecutableOwners() {
  const owner = s4 as unknown as Record<string, unknown>;
  if (owner.Z3_EXECUTABLE_OPERATION_BINDING !== GENERAL_S4_EXECUTABLE_BINDING
    || typeof owner.readEnterpriseViabilityExecutableSelectionTx !== "function"
    || typeof owner.selectEnterpriseViabilityExecutableOperationTx !== "function") {
    z3Fault("Z3_S4_EXECUTABLE_OPERATION_OWNER_NOT_INSTALLED");
  }
  return s4 as unknown as {
    readEnterpriseViabilityExecutableSelectionTx: typeof executableSelectionStateTx;
    selectEnterpriseViabilityExecutableOperationTx: typeof selectGeneralExecutableOperationTx;
  };
}
export async function readGeneralS4ObservationTx(ctx: PeMutationContext, request: GeneralOwnerRequest,
  receiptRef: ExperimentRef, sessionId: string, c: PoolClient): Promise<GeneralOwnerObservation> {
  const body = await app.applicationArtifact<{ schema: string; tenantId: string; principalId: string; workId: string;
    workInputId: string; originalParentId: string; mapDigest: string; sessionId: string; observation: NativeObservation }>(ctx, receiptRef, c);
  if (receiptRef.owner !== "S4" || body.schema !== "finnor.s4.z3-original-observation.v2"
    || body.tenantId !== ctx.auth.tenantId || body.principalId !== principal(ctx) || body.workId !== request.workId
    || body.workInputId !== request.workInputId || body.originalParentId !== request.originalParentId
    || body.mapDigest !== request.model.mapDigest || body.sessionId !== sessionId) z3Fault("Z3_NATIVE_OWNER_RECEIPT_ORIGINAL_BINDING_CHANGED");
  return { ...body.observation, receiptRef };
}

export async function observeGeneralS4StateTx(ctx: PeMutationContext, request: GeneralOwnerRequest, observerId: string,
  invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralOwnerObservation> {
  await invocationCurrent(ctx, request, invocation, c);
  const observer = request.model.original.observers.find(o => o.id === observerId);
  if (!observer) z3Fault("Z3_NATIVE_ACTUAL_OWNER_OBSERVATION_REQUIRED");
  const value = await context(ctx, request, observer, c);
  let observation: NativeObservation;
  if (value.kind === "CONTROL_OBSERVATION" && observer.kind === value.kind) {
    const actual = await s4.observeEnterpriseControl(ctx, { policyRef: observer.policyRef,
      instrumentId: observer.instrumentId, availablePeriod: observer.availablePeriod });
    observation = { observerId, revision: value.revision, sourceRef: actual.ref,
      facts: { $view: "CONTEXT", token: actual.token, availablePeriod: observer.availablePeriod }, qualification: actual.qualification };
  } else if (value.kind === "APPLICATION_SNAPSHOT") {
    observation = { observerId, revision: value.revision, sourceRef: value.application.snapshotRef,
      facts: { ...flattenState(value.application.snapshot.state), $view: "CONTEXT", resultKind: "CURRENT_RETAINED_READBACK" },
      qualification: "LATEST_LAWFUL_OWNER_READBACK_NOT_PREDICTED_STATE_OR_NEW_EXTERNAL_READ" };
  } else if (value.kind === "EXACT_POLICY") {
    observation = { observerId, revision: value.revision, sourceRef: value.revision,
      facts: { $view: "CONTEXT", resultKind: "CURRENT_EXACT_POLICY", variantId: value.exact.variant.id },
      qualification: "CURRENT_EXACT_ORIGINAL_POLICY_NOT_EXECUTION_ADMISSION" };
  } else z3Fault("Z3_NATIVE_TYPED_OBSERVATION_OWNER_MISMATCH");
  await invocationCurrent(ctx, request, invocation, c);
  return retainObservation(ctx, request, invocation, observation, c);
}

export async function dispatchGeneralS4OperationTx(ctx: PeMutationContext, request: GeneralOwnerRequest, edgeIndex: number,
  invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralOwnerObservation> {
  await invocationCurrent(ctx, request, invocation, c);
  // Resolve every admitted binding again, including current profiles, predicates
  // and receipts. A selected action cannot hide a now-invalid alternative.
  await resolveGeneralS4BindingsTx(ctx, request, c);
  const binding = request.model.original.controller.find(row => row.edgeIndex === edgeIndex);
  if (!binding) z3Fault("Z3_NATIVE_TOTAL_C_EDGE_BINDING_REQUIRED");
  const operation = binding.operation;
  if (operation.kind === "CONTROL_OBSERVE") {
    const actual = await observeGeneralS4StateTx(ctx, request, operation.observerId, invocation, c);
    const { receiptRef: _receipt, ...original } = actual;
    void _receipt;
    return retainObservation(ctx, request, invocation, { ...original,
      facts: { ...original.facts, $view: "OPERATION_RETURNED" } }, c);
  }
  const observer = request.model.original.observers.find(o => o.id === operation.observerId)!;
  const value = await context(ctx, request, observer, c);
  let observation: NativeObservation;
  if (operation.kind === "EXACT_CONTROL_CHOOSE" && observer.kind === "EXACT_POLICY") {
    const choice = await s4.chooseEnterpriseExactControlBranch(ctx, { policyRef: observer.policyRef, decision: operation.decision });
    if (choice.actionId !== operation.actionId) z3Fault("Z3_NATIVE_ORIGINAL_EXACT_BRANCH_BINDING_CHANGED");
    observation = { observerId: observer.id, revision: value.revision, sourceRef: choice.ref,
      facts: { $view: "OPERATION_RETURNED", resultKind: "EXACT_BRANCH_REVIEW", status: choice.status, actionId: choice.actionId, nodeId: choice.nodeId },
      qualification: "ACTUAL_S4_EXACT_BRANCH_REVIEW_NO_EXECUTION" };
  } else if (operation.kind === "APPLICATION_COMPOSE" && value.kind === "APPLICATION_SNAPSHOT") {
    const selected = await generalS4Owners().composeEnterpriseApplicationOperations(ctx,
      { sessionId: value.application.row.id, initial: value.application.snapshot,
        requiredFirstOperationId: operation.operationId }, c);
    const first = selected.steps[0];
    if (selected.disposition === "COMPOSED_WITH_REQUIRED_OBSERVATIONS"
      && (!first || first.operationId !== operation.operationId)) z3Fault("Z3_NATIVE_CURRENT_TYPED_COMPOSITION_STEP_REQUIRED");
    observation = { observerId: observer.id, revision: value.revision, sourceRef: selected.ref,
      facts: { ...flattenState(value.application.snapshot.state), $view: "OPERATION_RETURNED", resultKind: "TYPED_COMPOSITION_REVIEW",
        disposition: selected.disposition, operationId: first?.operationId ?? null },
      qualification: "ACTUAL_S4_TYPED_COMPOSITION_NOT_PREDICTED_EFFECT_OR_AUTHORITY" };
  } else z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
  await invocationCurrent(ctx, request, invocation, c);
  return retainObservation(ctx, request, invocation, observation, c);
}

/** Independently versioned executable selection. v2 above stays a non-effect
 * review. A governed origin child exists only because the owner explicitly
 * requested execution of an accepted institution model; its presence is the
 * opt-in. This S4 writer reads the application owner's own canonical
 * composition and retains exactly one once-only selection of its first
 * unexecuted step. It never executes, never holds an application claim and
 * grants nothing: the application owner consumes the selection under its own
 * durable claim, and Z3 later reads the retained owner receipt. */
export const GENERAL_S4_EXECUTABLE_BINDING = "finnor.s4.z3-original-executable-operation-binding.v1" as const;
export type GeneralExecutableSelectionState =
  | { state: "NOT_GOVERNED" }
  | { state: "NONE" }
  | { state: "LIVE"; selectionId: string; status: "SELECTED" | "CONSUMING" }
  | { state: "RETAINED"; selectionId: string }
  | { state: "FAILED"; selectionId: string; status: "REFUSED" | "STALE"; reason: string | null };
export type GeneralExecutableSelection =
  | { status: "AWAITING_APPLICATION_OWNER"; selectionId: string; stepId: string; operationId: string;
    selectionStatus: "SELECTED" | "CONSUMING"; executionAuthorityGranted: false }
  | { status: "RESULT"; selectionId: string; observation: GeneralOwnerObservation };

async function executableTarget(ctx: PeMutationContext, request: GeneralOwnerRequest, edgeIndex: number, c: PoolClient) {
  const binding = request.model.original.controller.find(row => row.edgeIndex === edgeIndex);
  if (!binding) z3Fault("Z3_NATIVE_TOTAL_C_EDGE_BINDING_REQUIRED");
  const operation = binding.operation;
  if (operation.kind !== "APPLICATION_COMPOSE") return null;
  const observer = request.model.original.observers.find(o => o.id === operation.observerId);
  if (!observer || observer.kind !== "APPLICATION_SNAPSHOT") z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
  const value = await applicationContext(ctx, request, observer, c);
  if (!isGovernedChild(value.row)) return null;
  return { operation, observer, value };
}
type ExecutableTarget = NonNullable<Awaited<ReturnType<typeof executableTarget>>>;

async function selectionForEdge(ctx: PeMutationContext, target: ExecutableTarget, edgeIndex: number,
  invocation: GeneralOwnerInvocation, c: PoolClient) {
  const row = target.value.row;
  return (await c.query<ApplicationSelectionRow>(
    `SELECT * FROM finnor_os.z3_application_selections WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3
     AND z3_session_id=$4 AND z3_cursor_digest=$5 AND z3_edge_index=$6 ORDER BY created_at,id LIMIT 1 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), row.id, invocation.sessionId, invocation.cursorDigest, edgeIndex])).rows[0] ?? null;
}

/** Read-only classification of the selection for exactly this cursor and edge. */
export async function executableSelectionStateTx(ctx: PeMutationContext, request: GeneralOwnerRequest, edgeIndex: number,
  invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralExecutableSelectionState> {
  await invocationCurrent(ctx, request, invocation, c);
  const target = await executableTarget(ctx, request, edgeIndex, c);
  if (!target) return { state: "NOT_GOVERNED" };
  const selection = await selectionForEdge(ctx, target, edgeIndex, invocation, c);
  if (!selection) return { state: "NONE" };
  if (selection.status === "RESULT_RETAINED") return { state: "RETAINED", selectionId: selection.id };
  if (selection.status === "REFUSED" || selection.status === "STALE") {
    return { state: "FAILED", selectionId: selection.id, status: selection.status, reason: selection.reason };
  }
  return { state: "LIVE", selectionId: selection.id, status: selection.status };
}

export async function selectGeneralExecutableOperationTx(ctx: PeMutationContext, request: GeneralOwnerRequest,
  edgeIndex: number, invocation: GeneralOwnerInvocation, c: PoolClient): Promise<GeneralExecutableSelection> {
  await invocationCurrent(ctx, request, invocation, c);
  await resolveGeneralS4BindingsTx(ctx, request, c);
  const target = await executableTarget(ctx, request, edgeIndex, c);
  if (!target) z3Fault("Z3_S4_EXECUTABLE_GOVERNED_APPLICATION_CHILD_REQUIRED");
  const { operation, value } = target;
  const { row, model, check, authority, execute } = value;
  const existing = await selectionForEdge(ctx, target, edgeIndex, invocation, c);
  if (existing) return executableOutcome(ctx, request, invocation, target, existing, c);
  if (!row.composition_ref) z3Fault("Z3_S4_EXECUTABLE_CANONICAL_APPLICATION_COMPOSITION_REQUIRED");
  if (row.status !== "PLANNING") z3Fault("Z3_S4_EXECUTABLE_CHILD_NOT_PARKED_FOR_SELECTION");
  const composition = parseApplicationComposition({
    ...await app.applicationArtifact<object>(ctx, row.composition_ref, c), ref: row.composition_ref });
  if (!sameX2Ref(composition.modelRef, model.ref) || !sameX2Ref(composition.checkRef, check.ref)) {
    z3Fault("Z3_S4_EXECUTABLE_CURRENT_MODEL_CHECK_REQUIRED");
  }
  if (composition.scope.tenantId !== ctx.auth.tenantId || composition.scope.principalId !== principal(ctx)
    || hash(composition.target) !== hash(authority.target) || composition.target.id !== execute.targetId
    || !sameX2Ref(composition.originalParentRef, row.original_parent_ref)) {
    z3Fault("Z3_S4_EXECUTABLE_ORIGINAL_SCOPE_OR_TARGET_CHANGED");
  }
  if (row.deadline_at.getTime() <= Date.now() || row.cancel_requested_at) z3Fault("Z3_S4_EXECUTABLE_ORIGINAL_DEADLINE_OR_CANCELLED");
  const requests = (await c.query<{ node_id: string; status: string; possible_egress: boolean }>(
    `SELECT node_id,status,possible_egress FROM finnor_os.application_semantics_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), row.id])).rows;
  let next: number | null = null;
  for (const [index, step] of composition.steps.entries()) {
    const prior = requests.find(r => r.node_id === step.id);
    if (!prior) { next = index; break; }
    if (!prior.possible_egress || prior.status !== "VERIFIED") z3Fault("Z3_S6_PENDING_UNKNOWN_BLOCKS_EXECUTABLE_SELECTION");
  }
  if (next === null) z3Fault("Z3_S4_EXECUTABLE_CANONICAL_COMPOSITION_EXHAUSTED");
  const step = composition.steps[next]!;
  if (step.operationId !== operation.operationId) z3Fault("Z3_S4_EXECUTABLE_WRONG_NEXT_CANONICAL_OPERATION");
  const actual = model.operations.find(o => o.id === step.operationId);
  if (!actual || actual.semanticRevision !== operation.semanticRevision) z3Fault("Z3_S4_EXECUTABLE_SEMANTIC_REVISION_CHANGED");
  const grant = authority.bindings.find(b => b.operationIds.includes(actual.id) && b.role === actual.authorization.role
    && sameX2Ref(b.originalGrantRef, actual.authorization.grantRef));
  if (!grant) z3Fault("Z3_S4_EXECUTABLE_ORIGINAL_GRANT_REQUIRED");
  const z3 = await viabilitySession(ctx, invocation.sessionId, c);
  const inserted = (await c.query<ApplicationSelectionRow>(
    `INSERT INTO finnor_os.z3_application_selections(tenant_id,id,principal_id,session_id,parent_session_id,work_id,work_input_id,
       composition_ref,composition_digest,step_id,step_index,operation_id,semantic_revision,original_grant_ref,
       z3_session_id,z3_edge_index,z3_cursor_digest,z3_map_digest,z3_job_id,z3_claim_token_digest,z3_claim_fence,
       z3_delivery_attempt_id,z3_session_generation,deadline_at)
     VALUES($1,gen_random_uuid(),$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT DO NOTHING RETURNING *`,
    [ctx.auth.tenantId, principal(ctx), row.id, row.parent_id, row.work_id, row.work_input_id,
      JSON.stringify(row.composition_ref), row.composition_ref.contentDigest, step.id, next, step.operationId,
      actual.semanticRevision, JSON.stringify(grant.originalGrantRef), invocation.sessionId, edgeIndex, invocation.cursorDigest,
      request.model.mapDigest, invocation.claim.physical.jobId, hash(invocation.claim.physical.claimToken),
      invocation.claim.sessionFence, invocation.claim.physical.deliveryAttemptId, z3.generation, row.deadline_at])).rows[0];
  if (!inserted) z3Fault("Z3_S4_EXECUTABLE_STEP_ALREADY_SELECTED_BY_ANOTHER_EDGE");
  await app.applicationEvent(ctx, row, "Z3_STEP_SELECTED", { selectionId: inserted.id, stepId: step.id,
    operationId: step.operationId, z3SessionId: invocation.sessionId, edgeIndex, cursorDigest: invocation.cursorDigest,
    originalDeadline: row.parent.deadlineAt, executionAuthorityGranted: false, newAllowance: false }, c);
  await app.enqueueApplicationSelection(ctx, row, inserted.id, c);
  return { status: "AWAITING_APPLICATION_OWNER", selectionId: inserted.id, stepId: step.id,
    operationId: step.operationId, selectionStatus: "SELECTED", executionAuthorityGranted: false };
}

async function executableOutcome(ctx: PeMutationContext, request: GeneralOwnerRequest, invocation: GeneralOwnerInvocation,
  target: ExecutableTarget, selection: ApplicationSelectionRow, c: PoolClient): Promise<GeneralExecutableSelection> {
  if (selection.status === "SELECTED" || selection.status === "CONSUMING") {
    return { status: "AWAITING_APPLICATION_OWNER", selectionId: selection.id, stepId: selection.step_id,
      operationId: selection.operation_id, selectionStatus: selection.status, executionAuthorityGranted: false };
  }
  if (selection.status !== "RESULT_RETAINED" || !selection.receipt_ref) z3Fault("Z3_S4_EXECUTABLE_SELECTION_REFUSED_OR_STALE");
  const receipt = await app.applicationArtifact<{ schema: string; tenantId: string; principalId: string; workId: string;
    workInputId: string; originalParentRef: ExperimentRef; sessionId: string; selectionId: string; stepId: string;
    operationId: string; semanticRevision: string; compositionRef: ExperimentRef; afterState: ApplicationSnapshot["state"];
    afterObservationRef: ExperimentRef; disposition: string;
    z3: { sessionId: string; edgeIndex: number; cursorDigest: string; mapDigest: string } }>(ctx, selection.receipt_ref, c);
  const row = target.value.row;
  if (selection.receipt_ref.owner !== "S4" || receipt.schema !== Z3_STEP_RECEIPT
    || selection.receipt_ref.contentDigest !== selection.receipt_digest
    || receipt.tenantId !== ctx.auth.tenantId || receipt.principalId !== principal(ctx)
    || receipt.workId !== request.workId || receipt.workInputId !== request.workInputId
    || !sameX2Ref(receipt.originalParentRef, row.original_parent_ref) || receipt.sessionId !== row.id
    || receipt.selectionId !== selection.id || receipt.stepId !== selection.step_id
    || receipt.operationId !== selection.operation_id || receipt.semanticRevision !== selection.semantic_revision
    || !sameX2Ref(receipt.compositionRef, selection.composition_ref) || receipt.disposition !== "VERIFIED"
    || receipt.z3.sessionId !== invocation.sessionId || receipt.z3.cursorDigest !== invocation.cursorDigest
    || receipt.z3.edgeIndex !== selection.z3_edge_index || receipt.z3.mapDigest !== request.model.mapDigest) {
    z3Fault("Z3_NATIVE_OWNER_RECEIPT_ORIGINAL_BINDING_CHANGED");
  }
  await invocationCurrent(ctx, request, invocation, c);
  const observation: NativeObservation = { observerId: target.observer.id, revision: applicationRevision(target.observer, target.value.model.ref),
    sourceRef: selection.receipt_ref,
    facts: { ...flattenState(receipt.afterState), $view: "OPERATION_RETURNED", resultKind: "EXECUTED_APPLICATION_STEP_READBACK",
      disposition: null, operationId: receipt.operationId },
    qualification: "ACTUAL_APPLICATION_OWNER_STEP_INDEPENDENT_READBACK_NOT_ACCEPTANCE_OR_RELEASE" };
  return { status: "RESULT", selectionId: selection.id, observation: await retainObservation(ctx, request, invocation, observation, c) };
}

/** Independently versioned typed result domains of the actual S4 owners above.
 * Named values come from the pinned owner contracts and revisions. Values that
 * are only learned from observation (S2 tokens, observed application values,
 * node digests) are never exhaustive, so those fields are `open` (OTHER). A
 * leaf an owner may omit in some result view or as an unavailable field is
 * `missing` (MISSING). S5/S6 counters other than the per-obligation UNKNOWN
 * flags are not owner result fields and are absent, so a predicate over them
 * is refused by the coverage check instead of being treated as total. */
export const GENERAL_OWNER_RESULT_DOMAINS = "finnor.s4.z3-owner-result-domains.v1" as const;
type DomainApplicationModel = ReturnType<typeof parseApplicationModel>;
type DomainExactPolicy = Awaited<ReturnType<typeof s4.readEnterpriseExactControlPolicy>>;
type DomainControlInstrument =
  Awaited<ReturnType<typeof s4.readEnterpriseControlDecisionContext>>["policy"]["problem"]["observations"][number];
export type GeneralOwnerDomainSource =
  | { kind: "CONTROL_OBSERVATION"; observer: Extract<NativeObserver, { kind: "CONTROL_OBSERVATION" }>;
    instrument: DomainControlInstrument }
  | { kind: "EXACT_POLICY"; observer: Extract<NativeObserver, { kind: "EXACT_POLICY" }>; policy: DomainExactPolicy }
  | { kind: "APPLICATION_SNAPSHOT"; observer: Extract<NativeObserver, { kind: "APPLICATION_SNAPSHOT" }>;
    model: DomainApplicationModel };
export interface GeneralOwnerResultDomains {
  schema: typeof GENERAL_OWNER_RESULT_DOMAINS; mapDigest: string; digest: string;
  revisions: Array<{ observerId: string; revision: ExperimentRef }>;
  fields: NativeDomainField[]; regions: NativeDomainRegion[];
}
function domainValues(values: readonly unknown[]): NativeDomainValue[] {
  const unique = new Map<string, NativeDomainValue>();
  for (const value of values) {
    if (value === null || typeof value === "string" || typeof value === "boolean"
      || typeof value === "number" && Number.isSafeInteger(value)) unique.set(hash(value), value);
  }
  return [...unique.values()];
}
const QUANTITY_LEAVES = ["decimal", "currency", "entity", "unit", "time", "basis"] as const;
const IDENTITY_LEAVES = ["application", "account", "entity", "id"] as const;
export function deriveGeneralOwnerResultDomains(model: Pick<GeneralNativeModel, "original" | "arena">,
  sources: readonly GeneralOwnerDomainSource[]): NativeDomainField[] {
  const observers = model.original.observers;
  if (sources.length !== observers.length || observers.some(observer =>
    sources.filter(source => source.kind === observer.kind && hash(source.observer) === hash(observer)).length !== 1)) {
    z3Fault("Z3_NATIVE_TYPED_PROJECTION_DOMAIN_REQUIRED");
  }
  const fields: NativeDomainField[] = [];
  const add = (observerId: string, field: string, values: readonly unknown[], open: boolean, missing: boolean) =>
    fields.push({ observerId, field, values: domainValues(values), open, missing });
  for (const source of sources) {
    const id = source.observer.id;
    add(id, "$view", ["CONTEXT", "OPERATION_RETURNED"], false, false);
    for (const obligationId of model.arena.resources.obligationIds) add(id, `$unknown:${obligationId}`, [true, false], false, false);
    if (source.kind === "CONTROL_OBSERVATION") {
      // S2 tokens and bins are supplied and unverified; a realized token outside them is OTHER.
      add(id, "token", source.instrument.exact?.tokens ?? source.instrument.bins.map(bin => bin.category), true, false);
      add(id, "availablePeriod", [source.observer.availablePeriod], false, false);
    } else if (source.kind === "EXACT_POLICY") {
      add(id, "resultKind", ["CURRENT_EXACT_POLICY", "EXACT_BRANCH_REVIEW"], false, false);
      add(id, "variantId", [source.policy.variant.id], false, true);
      add(id, "status", ["POLICY_AVAILABLE", "MODEL_UNSUPPORTED"], false, true);
      add(id, "actionId", [...source.policy.decisions.map(decision => decision.actionId), null], false, true);
      add(id, "nodeId", [null], true, true);
    } else {
      add(id, "resultKind", ["CURRENT_RETAINED_READBACK", "TYPED_COMPOSITION_REVIEW"], false, false);
      add(id, "disposition", CheckedApplicationCompositionBodySchema.shape.disposition.options, false, true);
      add(id, "operationId", [...source.model.operations.map(operation => operation.id), null], true, true);
      for (const field of source.model.stateSchema) {
        const nullable = field.nullable ? [null] : [];
        if (field.kind === "boolean") add(id, `state.${field.path}`, [true, false, ...nullable], false, true);
        else if (field.kind === "text" || field.kind === "enum") {
          add(id, `state.${field.path}`, [...field.observedValues.filter(value => typeof value === "string"), ...nullable], true, true);
        } else {
          add(id, `state.${field.path}.kind`, [field.kind], false, true);
          for (const leaf of field.kind === "quantity" ? QUANTITY_LEAVES : IDENTITY_LEAVES) {
            add(id, `state.${field.path}.${leaf}`, field.observedValues.map(value =>
              value !== null && typeof value === "object" ? (value as unknown as Record<string, unknown>)[leaf] : undefined)
              .filter(value => typeof value === "string"), true, true);
          }
        }
      }
    }
  }
  return fields;
}
/** Reads the current owner revisions under the same checks as the v2 binding;
 * the returned domains grant no authority and write nothing. */
export async function resolveGeneralOwnerResultDomainsTx(ctx: PeMutationContext, request: GeneralOwnerRequest,
  c: PoolClient): Promise<GeneralOwnerResultDomains> {
  const evidence = await resolveGeneralS4BindingsTx(ctx, request, c);
  const sources: GeneralOwnerDomainSource[] = [];
  const revisions: GeneralOwnerResultDomains["revisions"] = [];
  for (const observer of request.model.original.observers) {
    const value = await context(ctx, request, observer, c);
    revisions.push({ observerId: observer.id, revision: value.revision });
    if (value.kind === "CONTROL_OBSERVATION" && observer.kind === "CONTROL_OBSERVATION") {
      sources.push({ kind: value.kind, observer, instrument: value.instrument });
    } else if (value.kind === "EXACT_POLICY" && observer.kind === "EXACT_POLICY") {
      sources.push({ kind: value.kind, observer, policy: value.exact });
    } else if (value.kind === "APPLICATION_SNAPSHOT" && observer.kind === "APPLICATION_SNAPSHOT") {
      sources.push({ kind: value.kind, observer, model: value.application.model });
    } else z3Fault("Z3_NATIVE_TYPED_OBSERVATION_OWNER_MISMATCH");
  }
  if (hash(revisions) !== hash(evidence.revisions.map(({ observerId, revision }) => ({ observerId, revision })))) {
    z3Fault("Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED");
  }
  const fields = deriveGeneralOwnerResultDomains(request.model, sources);
  const body = { schema: GENERAL_OWNER_RESULT_DOMAINS, mapDigest: request.model.mapDigest, revisions, fields };
  return { ...body, regions: [{ fields }], digest: hash({ ...body, bindingDigest: evidence.digest }) };
}
