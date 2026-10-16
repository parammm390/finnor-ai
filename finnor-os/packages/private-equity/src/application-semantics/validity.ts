/** P7 application dependency closure, using the existing bounded graph walker.
 * Historical effects and original resource occupation are never invalidated away. */
import { randomUUID } from "node:crypto";
import type { ApplicationActionModel, ApplicationSnapshot, ApplicationState, CheckedApplicationComposition,
  ExperimentRef, LearnedApplicationOperation } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import type { PoolClient } from "pg";
import { transitionWorkTx } from "@finnor/db";
import { principal, tx } from "../evidence-execution/store";
import { affectedClosure } from "../live-recompilation/contracts";
import type { HarnessNode } from "../program-synthesis/contracts";
import type { DescribedApplicationOperation, PrivateApplicationBinding } from "./ports";
import { applicationArtifact, applicationEvent, currentApplicationModel, currentApplicationWork,
  nativeApplicationProfile, retainApplicationArtifact, type NativeApplicationProfile, type ApplicationSessionRow } from "./store";
import { parseApplicationComposition, sameX2Ref, x2Digest, x2Fault, x2Ref } from "./contracts";
import { assertApplicationModelUse, evaluateApplicationGuard, parameterBindingCode } from "./checker";
import { assertApplicationAllocationCurrent, chargeApplicationParent } from "./allocation";
import { applicationRequest, assertApplicationClaim, type ApplicationRequestRow } from "./obligations";
import { assertFreshApplicationProfile } from "./fresh-authority";
import { deliverOwnerTransportBatch, enqueueOwnerDeliveryInTransaction } from "../../../governed-execution/src/owner-delivery-store";
import { ApplicationCurrentnessBodySchema, ApplicationUseLeaseSchema, applicationProfileBinding, applicationRequestBindingDigest,
  type ApplicationCapabilityRequest, type ApplicationCapabilityUseLease } from "../../../capability-evolution/src/application-port";
import type { ApplicationCapabilityInput, ApplicationConsumerPolicy } from "../../../capability-evolution/src/application-consumer";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";

export async function initializeApplicationValidities(ctx: PeMutationContext, row: ApplicationSessionRow,
  model: ApplicationActionModel, checkRef: ApplicationSessionRow["check_ref"], client?: PoolClient) {
  if (!checkRef) x2Fault("X2_P7_ORIGINAL_MODEL_CHECK_REQUIRED");
  const initialize = async (c: PoolClient) => {
    for (const operation of model.operations) await c.query(
      "INSERT INTO finnor_os.application_operation_validities(tenant_id,principal_id,model_id,operation_id,status,current_binding_ref,evidence_ref,revision)"
      + " VALUES($1,$2,$3,$4,'CURRENT',$5::jsonb,$6::jsonb,1) ON CONFLICT DO NOTHING",
      [ctx.auth.tenantId, principal(ctx), model.ref.id, operation.id, JSON.stringify(operation.privateBindingRef), JSON.stringify(checkRef)]);
    await applicationEvent(ctx, row, "P7_ORIGINAL_EVIDENCED_OPERATION_VALIDITIES", {
      modelRef: model.ref, checkRef, operationIds: model.operations.map((item) => item.id), externalUniversalProof: false,
    }, c);
  };
  if (client) await initialize(client);
  else await tx(ctx, initialize);
}

export function applicationCompositionClosure(composition: CheckedApplicationComposition, operationId: string) {
  const graph: HarnessNode[] = composition.steps.map((step, index) => ({
    id: step.id, op: "stop", dependsOn: index ? [composition.steps[index - 1]!.id] : [],
    inputPorts: [], outputPorts: [], semanticDigest: x2Digest(step), owner: "S4/S6",
    capabilityVersion: "application-operation-v1", truthClass: "CHECKED_MODEL_RELATIVE_NOT_EXTERNAL_OBSERVATION",
    preconditions: [], postconditions: [], deadlineAt: composition.deadlineAt, maxAttempts: 1,
    failure: "STOP_WITH_PREDICATE", cancellation: "FENCE_BEFORE_PUBLICATION", payload: step,
  }));
  const seeds = composition.steps.filter((step) => step.operationId === operationId).map((step) => step.id);
  if (!seeds.length) return { affectedNodes: [], keptNodes: graph };
  return affectedClosure(graph, seeds);
}

export async function invalidateApplicationOperation(ctx: PeMutationContext, row: ApplicationSessionRow,
  operationId: string, observation: ApplicationSnapshot | null, reason: string, revoked = false) {
  if (!row.model_ref) x2Fault("X2_P7_RETAINED_MODEL_REQUIRED");
  const body = await applicationArtifact<Omit<ApplicationActionModel, "ref">>(ctx, row.model_ref);
  const operation = body.operations.find((item) => item.id === operationId);
  if (!operation) x2Fault("X2_P7_OPERATION_NOT_IN_MODEL");
  const observationRef = observation ? x2Ref("COMPUTER", "application-observation", observation) : null;
  if (observationRef) await retainApplicationArtifact(ctx, observationRef, observation, true);
  await tx(ctx, async (c, db) => {
    const evidence = await applicationEvent(ctx, row, "P7_OPERATION_FALSIFIED_OR_REVOKED", {
      modelRef: row.model_ref, operationId, observationRef, reason, priorEvidenceRetained: true,
      effectCancellationClaimed: false, resourcesReleased: false,
    }, c);
    await c.query(
      "INSERT INTO finnor_os.application_operation_validities(tenant_id,principal_id,model_id,operation_id,status,current_binding_ref,evidence_ref,revision,reason)"
      + " VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,1,$8) ON CONFLICT(tenant_id,principal_id,model_id,operation_id)"
      + " DO UPDATE SET status=excluded.status,evidence_ref=excluded.evidence_ref,revision=application_operation_validities.revision+1,"
      + " reason=excluded.reason,updated_at=clock_timestamp()",
      [ctx.auth.tenantId, principal(ctx), row.model_ref!.id, operationId, revoked ? "REVOKED" : "STALE",
        JSON.stringify(operation.privateBindingRef), JSON.stringify(evidence), reason]);
    const children = (await c.query<ApplicationSessionRow>(
      "SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND model_ref=$3::jsonb"
      + " AND composition_ref IS NOT NULL ORDER BY id FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), JSON.stringify(row.model_ref)])).rows;
    for (const child of children) {
      const stored = await applicationArtifact<Omit<CheckedApplicationComposition, "ref">>(ctx, child.composition_ref!, c);
      const composition = parseApplicationComposition({ ...stored, ref: child.composition_ref });
      const closure = applicationCompositionClosure(composition, operationId);
      if (!closure.affectedNodes.length) continue;
      if (!["COMPLETED", "MODEL_READY", "CANCELLED", "FAILED"].includes(child.status)) {
        if (!["BLOCKED", "STALE"].includes(child.status)) await c.query(
            "UPDATE finnor_os.application_semantics_sessions SET status='STALE',reason=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [ctx.auth.tenantId, child.id, reason]);
        const work = (await c.query<{ status: string }>(
          "SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [ctx.auth.tenantId, child.work_id])).rows[0];
        const latestInput = (await c.query<{ id: string }>(
          "SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE",
          [ctx.auth.tenantId, child.work_id])).rows[0];
        // Invalidation stops this intent, not a replacement instruction or
        // independently completed history. Possible effects remain waiting.
        if (work && !["completed", "cancelled", "failed"].includes(work.status) && latestInput?.id === child.work_input_id) {
          const possible = await c.query(
            "SELECT r.id FROM finnor_os.application_semantics_requests r JOIN finnor_os.application_semantics_sessions s"
            + " ON s.tenant_id=r.tenant_id AND s.id=r.session_id"
            + " WHERE r.tenant_id=$1 AND r.principal_id=$2 AND s.work_id=$3 AND s.work_input_id=$4"
            + " AND r.possible_egress AND r.status NOT IN ('VERIFIED','DENIED') LIMIT 1",
            [ctx.auth.tenantId, principal(ctx), child.work_id, child.work_input_id]);
          await transitionWorkTx(db, child.tenant_id, child.work_id, possible.rowCount ? "waiting" : "blocked",
            "application_operation_invalidated", { sessionId: child.id, workInputId: child.work_input_id,
              operationId, reason, triggerRef: evidence, originalObservationRequired: Boolean(possible.rowCount),
              resourcesReleased: false, newAllowance: false }, { expectedWorkInputId: child.work_input_id });
        }
      }
      await applicationEvent(ctx, child, "P7_MINIMAL_SOUND_COMPOSITION_CLOSURE", {
        triggerRef: evidence, operationId, compositionRef: child.composition_ref,
        affectedStepIds: closure.affectedNodes.map((node) => node.id), keptStepIds: closure.keptNodes.map((node) => node.id),
        unrelatedOperationIds: body.operations.filter((item) => item.id !== operationId).map((item) => item.id),
        priorEffectsAndCostsRetained: true, newAllowance: false,
      }, c);
    }
  });
}

export async function revalidateApplicationOperation(ctx: PeMutationContext, row: ApplicationSessionRow,
  operation: LearnedApplicationOperation, description: DescribedApplicationOperation, fresh: PrivateApplicationBinding) {
  if (!row.model_ref) x2Fault("X2_P7_RETAINED_MODEL_REQUIRED");
  const prior = await tx(ctx, async (c) => (await c.query<{ status: string; current_binding_ref: PrivateApplicationBinding["ref"] }>(
    "SELECT status,current_binding_ref FROM finnor_os.application_operation_validities"
    + " WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND operation_id=$4",
    [ctx.auth.tenantId, principal(ctx), row.model_ref!.id, operation.id])).rows[0], true);
  if (!prior || prior.status !== "CURRENT") x2Fault("X2_P7_CURRENT_OPERATION_VALIDITY_REQUIRED");
  const old = await applicationArtifact<Omit<PrivateApplicationBinding, "ref">>(ctx, operation.privateBindingRef);
  if (old.semanticDigest !== fresh.semanticDigest || operation.semanticRevision !== description.semanticRevision
    || operation.authorization.role !== description.role || old.profileId !== fresh.profileId
    || old.substrate !== fresh.substrate || old.method !== fresh.method
    || old.substrate === "API" && (old.pathTemplate !== fresh.pathTemplate
      || x2Digest(old.parameterPaths) !== x2Digest(fresh.parameterPaths))
    || !sameX2Ref(operation.observerContractRef, description.observerContractRef)) {
    await invalidateApplicationOperation(ctx, row, operation.id, null, "X2_MATERIAL_OPERATION_OR_OBSERVER_DRIFT");
    x2Fault("X2_MATERIAL_OPERATION_OR_OBSERVER_DRIFT");
  }
  // A current external version contract plus equal semantic/schema/parameter
  // and observer bindings, not an unchanged visual label, permits relocation.
  if (!sameX2Ref(prior.current_binding_ref, fresh.ref)) await tx(ctx, async (c) => {
    const evidence = await applicationEvent(ctx, row, "P7_LAWFUL_RENDERING_REVALIDATION", {
      operationId: operation.id, modelRef: row.model_ref, priorBindingRef: prior.current_binding_ref,
      currentBindingRef: fresh.ref, sourceRef: fresh.sourceRef, semanticDigest: fresh.semanticDigest,
      observerRef: description.observerContractRef, renderingDigest: fresh.renderingDigest,
      newExplorationAuthorityGranted: false,
    }, c);
    const updated = await c.query(
      "UPDATE finnor_os.application_operation_validities SET current_binding_ref=$5::jsonb,evidence_ref=$6::jsonb,"
      + " revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND operation_id=$4 AND status='CURRENT'",
      [ctx.auth.tenantId, principal(ctx), row.model_ref!.id, operation.id, JSON.stringify(fresh.ref), JSON.stringify(evidence)]);
    if (updated.rowCount !== 1) x2Fault("X2_P7_REVALIDATION_CONCURRENTLY_REVOKED");
  });
}

export async function deliverApplicationReferences(ctx: PeMutationContext, row: ApplicationSessionRow, owners: string[], recovery = false) {
  for (const semanticOwner of owners) {
    const pending = () => tx(ctx, async (c) => (await c.query<{ status: string }>(
      "SELECT status FROM finnor_os.s6_owner_delivery_states WHERE tenant_id=$1 AND principal_id=$2"
      + " AND semantic_owner=$3 AND status<>'ACCEPTED' ORDER BY updated_at,identity LIMIT 33",
      [ctx.auth.tenantId, principal(ctx), semanticOwner])).rows, true);
    for (let batch = 0; batch < 8; batch++) {
      const backlog = await pending();
      if (!backlog.length) break;
      if (backlog.some(item => ["REFUSED_ORIGIN", "REQUIRES_OPERATOR"].includes(item.status))) {
        x2Fault("X2_S8_NATIVE_REFERENCE_DELIVERY_UNPASSED");
      }
      // One conservative original charge funds the batch before network work.
      // Its own S5 reference is included in a small tail, not charged recursively.
      const limit = Math.min(32, backlog.length + (semanticOwner === "S5" ? 1 : 0));
      await chargeApplicationParent(ctx, {
        allocationRef: row.allocation_ref, consumptionRef: row.root_consumption_ref, requestRef: row.original_parent_ref,
        phase: recovery ? "RECOVERY" : "CHECKING", key: `s8-delivery:${semanticOwner}:${randomUUID()}`, units: limit * 2, recovery,
      });
      const report = await deliverOwnerTransportBatch({
        semanticOwner, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      }, { limit });
      if (report.failures.length) x2Fault("X2_S8_NATIVE_REFERENCE_DELIVERY_UNPASSED");
      if (!report.inspected) x2Fault("X2_S8_NATIVE_REFERENCE_DELIVERY_PENDING");
    }
    if ((await pending()).length) x2Fault("X2_S8_NATIVE_REFERENCE_DELIVERY_BOUND");
  }
}

/** Checked native S4 output. The S8 consumer resolves this actual retained and
 * delivered preimage; neither a candidate nor a local hash issues permission. */
export async function currentApplicationCapabilityInput(ctx: PeMutationContext, row: ApplicationSessionRow,
  input: {
    execution: Readonly<JobExecutionContext>; policy: ApplicationConsumerPolicy;
    profile: NativeApplicationProfile; operation: LearnedApplicationOperation; before: ApplicationSnapshot;
    parameters: ApplicationState; request: ApplicationRequestRow; recheckLease?: ApplicationCapabilityUseLease;
  }): Promise<ApplicationCapabilityInput> {
  const prior = input.recheckLease ? ApplicationUseLeaseSchema.parse(input.recheckLease) : null;
  if (!prior) await deliverApplicationReferences(ctx, row, ["S4", "S5", "S6", "COMPUTER"]);
  await assertApplicationClaim(ctx, row, input.execution);
  await currentApplicationWork(ctx, row);
  const allocation = await assertApplicationAllocationCurrent(ctx, row.allocation_ref);
  const { model, check } = await currentApplicationModel(ctx, row);
  assertApplicationModelUse(model, check);
  const profile = await nativeApplicationProfile(ctx, input.profile.profile.id);
  const authority = await assertFreshApplicationProfile(ctx, row, profile, input.operation);
  const canonicalRequest = await applicationRequest(ctx, input.request.id);
  if (profile.bindingDigest !== input.profile.bindingDigest || canonicalRequest.possible_egress
    || canonicalRequest.status !== "PREPARED" || canonicalRequest.parent_id !== row.parent_id
    || canonicalRequest.wire_digest !== input.request.wire_digest
    || canonicalRequest.body.operationId !== input.operation.id
    || canonicalRequest.body.wire.expectedVersion !== input.before.recordRevision
    || canonicalRequest.body.privateProfileBindingDigest !== profile.bindingDigest
    || x2Digest(model.operations.find(operation => operation.id === input.operation.id)) !== x2Digest(input.operation)
    || evaluateApplicationGuard(input.operation.precondition, input.before.state, input.parameters) !== true
    || parameterBindingCode(input.operation.parameters, input.parameters)
    || input.before.unavailableFields.length || input.before.observationQualification !== "LAWFUL_INDEPENDENT_READBACK"
    || input.before.scope.tenantId !== row.tenant_id || input.before.scope.principalId !== row.principal_id
    || !sameX2Ref(input.before.scope.grantRef, profile.profile.grantRef)
    || input.before.scope.role !== profile.profile.role || x2Digest(input.before.target) !== x2Digest(authority.target)
    || Date.parse(input.before.observedAt) > Date.now()
    || Date.now() - Date.parse(input.before.observedAt) > input.policy.maxCurrentnessMs) x2Fault("X2_S8_ACTUAL_CURRENT_INPUT_REQUIRED");
  const refs = await tx(ctx, async (c) => {
    const validity = (await c.query<{ status: string; current_binding_ref: ExperimentRef }>(
      "SELECT status,current_binding_ref FROM finnor_os.application_operation_validities"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND operation_id=$4 FOR SHARE",
      [row.tenant_id, row.principal_id, model.ref.id, input.operation.id])).rows[0];
    if (validity?.status !== "CURRENT" || !sameX2Ref(validity.current_binding_ref, canonicalRequest.binding_ref)) {
      x2Fault("X2_S8_CURRENT_NATIVE_OPERATION_REQUIRED");
    }
    const liabilities = (await c.query<{ ref: ExperimentRef }>(
      "SELECT o.body->'ref' ref FROM finnor_os.application_semantics_requests r JOIN finnor_os.s6_obligation_origins o"
      + " ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
      + " WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.parent_id=$3 AND r.status NOT IN ('VERIFIED','DENIED') LIMIT 65",
      [row.tenant_id, row.principal_id, row.parent_id])).rows.map(item => item.ref);
    if (liabilities.length > 64) x2Fault("X2_S8_ORIGINAL_LIABILITY_BOUND");
    return liabilities;
  });
  const authorityRef = x2Ref("S4", "application-fresh-authority", authority);
  const observationRef = x2Ref("COMPUTER", "application-observation", input.before);
  const request: ApplicationCapabilityRequest = {
    requestId: canonicalRequest.id, inputDigest: x2Digest({
      requestRef: canonicalRequest.request_ref, wireDigest: canonicalRequest.wire_digest,
      operationId: input.operation.id, parameters: input.parameters, before: observationRef, workInputDigest: row.work_input_digest,
    }),
    operationIds: [input.operation.id], applicationRevision: input.before.applicationRevision,
    target: input.before.target, compositionRef: row.composition_ref, allocationRef: row.allocation_ref,
    reservationRef: row.parent.resourceGrantRef, resourceEnvelopeDigest: x2Digest(allocation.certificate.check.envelopes),
    deadlineAt: row.parent.deadlineAt, reservedCost: 0, freshAuthorityRef: authorityRef,
    currentnessRef: row.original_parent_ref, // Excluded from request digest; replaced with the committed output below.
  };
  const evidenceRefs = [observationRef, authorityRef, canonicalRequest.request_ref];
  if (prior && (!sameX2Ref(prior.revisionRef, input.policy.revisionRef)
    || !sameX2Ref(prior.modelRef, model.ref) || !sameX2Ref(prior.checkRef, check.ref)
    || !sameX2Ref(prior.originalParentRef, row.original_parent_ref) || prior.originalParentDigest !== x2Digest(row.parent)
    || prior.dependencyDigest !== input.policy.dependencyDigest
    || x2Digest(prior.profile) !== x2Digest(applicationProfileBinding(profile.profile))
    || prior.requestBindingDigest !== applicationRequestBindingDigest(request)
    || prior.requestBindingDigest !== applicationRequestBindingDigest(prior.request)
    || Date.parse(prior.expiresAt) <= Date.now()
    || [...evidenceRefs, ...refs].some(ref => ![...prior.evidenceRefs, ...prior.liabilityRefs].some(old => sameX2Ref(old, ref))))) {
    x2Fault("X2_S8_RECHECK_ORIGINAL_BINDINGS_OR_EVIDENCE_REQUIRED");
  }
  const checkedAtMs = Date.now(), checkedAt = new Date(checkedAtMs).toISOString();
  const body = ApplicationCurrentnessBodySchema.parse({
    schema: "finnor.x2.application-s8-currentness.v1", tenantId: row.tenant_id, principalId: row.principal_id,
    rightsRef: row.parent.rightsRevision, modelRef: model.ref, checkRef: check.ref, originalParentRef: row.original_parent_ref,
    dependencyDigest: input.policy.dependencyDigest, profileBindingDigest: x2Digest(applicationProfileBinding(profile.profile)),
    requestBindingDigest: applicationRequestBindingDigest(request), applicationRevision: request.applicationRevision,
    checkedAt, expiresAt: new Date(Math.min(checkedAtMs + input.policy.maxCurrentnessMs,
      Date.parse(row.parent.deadlineAt), Date.parse(profile.profile.validUntil), Date.parse(input.policy.validUntil))).toISOString(),
    evidenceRefs, liabilityRefs: refs,
    current: true, externalUniversalProof: false, protectionDomain: "DISPOSABLE_TEST_AUTHORITY",
    qualification: "PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2", protectedAdmission: false, executionAuthorityGranted: false,
  });
  request.currentnessRef = x2Ref("S4", "application-s8-currentness", body);
  await tx(ctx, async (c) => {
    await assertApplicationClaim(ctx, row, input.execution, c);
    await currentApplicationWork(ctx, row, c);
    // Snapshot stays private in native custody. Delivery is authenticated and
    // attenuated to these existing owner rights, never a public artifact read.
    await retainApplicationArtifact(ctx, observationRef, input.before, true, c);
    await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: "COMPUTER", tenantId: row.tenant_id, principalId: row.principal_id },
      { kind: "REFERENCE", identity: observationRef.id,
        payload: { reference: { ...observationRef, content: input.before }, rightsRefs: [row.parent.rightsRevision] } });
    await retainApplicationArtifact(ctx, request.currentnessRef, body, false, c, [row.parent.rightsRevision]);
  });
  // The exact lease already committed these immutable originals. Recheck still
  // delivers a fresh S4 stamp, without unrelated metering in the physical fence.
  await deliverApplicationReferences(ctx, row, prior ? ["S4"] : ["S4", "COMPUTER"]);
  return { model, check, originalParent: row.parent, profile: profile.profile, request };
}
