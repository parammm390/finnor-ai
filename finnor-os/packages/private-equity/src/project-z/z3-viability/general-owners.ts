/** S4 binding implementation and mandatory shared-owner ABI. There is no
 * caller-supplied adapter, optional dispatch callback, effect or grant writer. */
import type { PoolClient } from "pg";
import type { ApplicationSnapshot, ExperimentRef } from "@finnor/shared-types";
import { parseControlDecision } from "@finnor/epistemic-runtime";
import * as s4 from "../../enterprise-control";
import type { PeMutationContext } from "../../types";
import { principal } from "../../evidence-execution/store";
import * as app from "../../application-semantics/store";
import { ApplicationSnapshotSchema, parseApplicationCheck, parseApplicationModel,
  sameX2Ref, x2Ref } from "../../application-semantics/contracts";
import { ApplicationExecuteSchema } from "../../application-semantics/native-contracts";
import { assertApplicationModelUse } from "../../application-semantics/checker";
import { currentFreshApplicationAuthority } from "../../application-semantics/fresh-authority";
import { chooseExactS4Branch } from "../../capital-program/r2-owners";
import { readApplicationObligation } from "../../application-semantics/obligations";
import type { InstitutionApplicationOrigin } from "../../../../orchestration/src/project-z/z0-convergence/institution-origin";
import { assertViabilityClaimTx, viabilitySession } from "./store";
import { hash, z3Fault, type ViabilityClaim } from "./contracts";
import { parseGeneralNativeModel, type GeneralNativeModel, type NativeFacts,
  type NativeObservation, type NativeObserver } from "./general-model";

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
  // ID or an independently created application parent.
  const rows = (await c.query<{ id: string; origin: InstitutionApplicationOrigin }>(
    `SELECT s.id::text,a.body origin FROM finnor_os.application_semantics_sessions s
     JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=s.tenant_id
       AND a.principal_id=s.principal_id AND a.artifact_id=s.parent->'institutionalOriginRef'->>'id'
     WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.work_id=$3 AND s.work_input_id=$4
       AND a.body->>'schema'='finnor.z0.institution-application-origin.v1'
       AND a.body->'selector'->>'programId'=$5
       AND a.body->'selector'->>'responsibilityIdentity'=$6
       AND s.id<>s.parent_id AND s.cancel_requested_at IS NULL
       AND s.status NOT IN('CANCELLED','FAILED') ORDER BY s.id LIMIT 2`,
    [ctx.auth.tenantId, principal(ctx), request.workId, request.workInputId,
      request.parentRequestId, observer.responsibilityIdentity])).rows;
  if (rows.length !== 1 || !rows[0]) z3Fault("Z3_NATIVE_UNIQUE_ORIGINAL_APPLICATION_OWNER_REQUIRED");
  const row = await app.applicationSession(ctx, rows[0].id, c, true);
  const originRef = row.parent.institutionalOriginRef;
  if (!originRef) z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_REQUIRED");
  const origin = await app.applicationArtifact<InstitutionApplicationOrigin>(ctx, originRef, c);
  if (origin.compilerEpisodeId !== request.originalParentId
    || !sameX2Ref(origin.originalReservationRef, request.reservationRef)
    || origin.workId !== request.workId || origin.workInputId !== request.workInputId
    || origin.selector.programId !== request.parentRequestId
    || origin.selector.responsibilityIdentity !== observer.responsibilityIdentity) {
    z3Fault("Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_CHANGED");
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

async function context(ctx: PeMutationContext, request: GeneralOwnerRequest, observer: NativeObserver, c: PoolClient) {
  if (observer.kind === "APPLICATION_SNAPSHOT") {
    const value = await applicationContext(ctx, request, observer, c);
    return { kind: observer.kind, revision: value.model.ref,
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
