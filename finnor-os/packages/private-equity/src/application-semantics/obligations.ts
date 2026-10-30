/** Application variant of the existing S6 origin/effect/action/receipt owner.
 * No acknowledgment, candidate predicate or projection settles an effect. */
import { randomUUID } from "node:crypto";
import { originOf } from "../../../orchestration/src/project-z/z0-convergence/institution-origin";
import { inheritedApplicationEffectState } from "../../../orchestration/src/project-z/z0-convergence/institution-allocation";
import { assertNativeApplicationEffectAdapterBoundary } from "@finnor/db";
import type { PoolClient } from "pg";
import type {
  ApplicationOperationObligation, ApplicationSnapshot, ApplicationState, BusinessEffectSet,
  ExperimentRef, ScopedApplicationIdentity,
} from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { withS5PortfolioTransaction } from "../allocation-store";
import { compileApplicationOperationIntent } from "../../../orchestration/src/compiler";
import { requireApplicationDevelopmentAdapter } from "../../../governed-execution/src/adapter-contract";
import type { PreparedApplicationWire } from "./ports";
import {
  applicationEvent, applicationSession, assertProfileTarget, currentApplicationWork,
  nativeApplicationProfile, retainApplicationArtifact,
  type ApplicationSessionRow, type NativeApplicationProfile,
} from "./store";
import { applicationConsumptionInTransaction, assertApplicationAllocationCurrent, chargeApplicationParent } from "./allocation";
import { applicationWireCorrelation, sameX2Ref, x2Digest, x2Fault, x2Ref } from "./contracts";
import type { ApplicationPhase } from "./native-contracts";

export interface ApplicationRequestRow {
  id: string; tenant_id: string; principal_id: string; session_id: string; parent_id: string;
  node_id: string; obligation_id: string; request_ref: ExperimentRef; binding_ref: ExperimentRef;
  wire_digest: string; body: {
    schema: string; wire: PreparedApplicationWire; profileId: string; privateProfileBindingDigest: string;
    privateProfileBinding?: Record<string, unknown>;
    operationId: string; sourceOperationId: string; phase: ApplicationPhase;
  };
  possible_egress: boolean; acknowledged: boolean; status: string; reason: string | null;
  observation_ref: ExperimentRef | null; response_ref: ExperimentRef | null;
}
function preimage<T extends { ref: ExperimentRef }>(value: T) {
  const { ref, ...body } = value;
  if (x2Digest(body) !== ref.contentDigest) x2Fault("X2_S6_ORIGINAL_PREIMAGE_INTEGRITY");
  return body;
}
export async function assertApplicationClaim(ctx: PeMutationContext, session: ApplicationSessionRow,
  execution: Readonly<JobExecutionContext>, c?: PoolClient, recovery = false) {
  const verify = async (client: PoolClient) => {
    const row = await applicationSession(ctx, session.id, client);
    const claimed = await client.query(
      "SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id"
      + " WHERE j.tenant_id=$1 AND j.id=$2 AND j.type='run_application_semantics_v1' AND j.protocol_version=1"
      + " AND j.status='running' AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()"
      + " AND a.id=$5 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL"
      + " AND j.payload->>'sessionId'=$6 AND (j.payload->>'generation')::integer=$7 FOR SHARE OF j,a",
      [session.tenant_id, execution.jobId, execution.claimToken, execution.claimFence, execution.deliveryAttemptId, row.id, row.generation]);
    if (claimed.rowCount !== 1 || execution.tenantId !== row.tenant_id || row.generation !== session.generation
      || row.claim_token !== execution.claimToken || String(row.claim_fence) !== String(execution.claimFence)
      || !recovery && (row.cancel_requested_at || row.deadline_at.getTime() <= Date.now())) x2Fault("X2_ACTUAL_CURRENT_DURABLE_JOB_CLAIM_REQUIRED");
    return row;
  };
  return c ? verify(c) : tx(ctx, verify);
}
export async function readApplicationObligation(ctx: PeMutationContext, ref: ExperimentRef, c?: PoolClient) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<{ body: ApplicationOperationObligation; effect: BusinessEffectSet; semantic_hash: string }>(
      "SELECT o.body,e.effect,e.semantic_hash FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id"
      + " WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.obligation_id=$3",
      [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
    if (!row || row.body.schema !== "finnor.s6.application-obligation.v1" || !sameX2Ref(row.body.ref, ref)
      || row.body.tenantId !== ctx.auth.tenantId || row.body.principalId !== principal(ctx)
      || row.effect.id !== row.body.effectRef.id || row.effect.semanticHash !== row.semantic_hash
      || row.semantic_hash !== row.body.effectRef.semanticHash || row.effect.source.domainActionId !== row.body.domainActionId
      || x2Digest(row.effect.delta.values.parameters) !== x2Digest(row.body.parameters)
      || x2Digest(row.effect.delta.values.target) !== x2Digest(row.body.target)) x2Fault("X2_S6_CANONICAL_OBLIGATION_EFFECT_BINDING");
    preimage(row.body);
    return row.body;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function prepareApplicationObligation(ctx: PeMutationContext, session: ApplicationSessionRow, input: {
  profile: NativeApplicationProfile; target: ScopedApplicationIdentity; parameters: ApplicationState;
  before: ApplicationSnapshot; operationRef: ExperimentRef; preparationRef: ExperimentRef;
  privateBindingRef: ExperimentRef; observerContractRef: ExperimentRef; nodeId: string; key: string;
}): Promise<ApplicationOperationObligation> {
  requireApplicationDevelopmentAdapter(input.profile.profile.protectionDomain);
  assertProfileTarget(input.profile, input.target);
  await currentApplicationWork(ctx, session);
  if (!session.profile_ids.includes(input.profile.profile.id) || x2Digest(input.before.target) !== x2Digest(input.target)
    || input.before.scope.principalId !== principal(ctx) || input.before.scope.tenantId !== ctx.auth.tenantId
    || input.before.scope.role !== input.profile.profile.role
    || !sameX2Ref(input.before.scope.grantRef, input.profile.profile.grantRef)
    || input.before.observationQualification !== "LAWFUL_INDEPENDENT_READBACK") x2Fault("X2_S6_LAWFUL_EXACT_PREDECESSOR_REQUIRED");
  const requestDigest = x2Digest({ sessionId: session.id, nodeId: input.nodeId, preparationRef: input.preparationRef,
    operationRef: input.operationRef, target: input.target, parameters: input.parameters, before: input.before });
  const consumptionNode = `${session.id}:${input.nodeId}`;
  return withS5PortfolioTransaction(ctx, async (c) => {
    const current = await applicationSession(ctx, session.id, c);
    await currentApplicationWork(ctx, current, c);
    const held = await assertApplicationAllocationCurrent(ctx, session.allocation_ref, c);
    if (!sameX2Ref(held.reservation.ref, session.reservation_ref)
      || !sameX2Ref(held.certificate.originalParentRef, session.original_parent_ref)) x2Fault("X2_S6_ORIGINAL_ALLOCATION_ANCESTRY");
    const prior = (await c.query<{ body: ApplicationOperationObligation; input_digest: string }>(
      "SELECT o.body,o.input_digest FROM finnor_os.s6_obligation_origins o JOIN finnor_os.s5_consumptions co ON co.tenant_id=o.tenant_id AND co.consumption_id=o.consumption_id"
      + " WHERE o.tenant_id=$1 AND o.principal_id=$2 AND co.reservation_id=$3 AND co.node_id=$4",
      [ctx.auth.tenantId, principal(ctx), held.reservation.ref.id, consumptionNode])).rows[0];
    if (prior) {
      if (prior.input_digest !== requestDigest) x2Fault("X2_S6_ORIGINAL_NODE_IDENTITY_CONFLICT");
      return readApplicationObligation(ctx, prior.body.ref, c);
    }
    const unresolved = await c.query(
      "SELECT r.id FROM finnor_os.application_semantics_requests r JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
      + " WHERE r.tenant_id=$1 AND r.possible_egress AND r.status NOT IN ('VERIFIED','DENIED')"
      + " AND (r.parent_id=$2 OR o.body->'target'=$3::jsonb) LIMIT 1",
      [ctx.auth.tenantId, session.parent_id, JSON.stringify(input.target)]);
    if (unresolved.rowCount) x2Fault("X2_S6_ORIGINAL_UNRESOLVED_EFFECT_MUST_BE_OBSERVED");
    const consumption = await applicationConsumptionInTransaction(ctx, c, {
      originalParentRef: session.original_parent_ref, certificateRef: session.allocation_ref,
      reservationRef: session.reservation_ref, preparationRef: input.preparationRef, operationRef: input.operationRef,
      nodeId: consumptionNode, idempotencyKey: input.key, requestDigest,
      predecessorObservationRef: input.before.sourceRef, envelope: held.reservation.envelopes,
    });
    const actionId = randomUUID(), effectId = randomUUID(), preparedAt = new Date().toISOString();
    const effect = compileApplicationOperationIntent({
      actionId, effectId, workId: session.work_id, compiledAt: preparedAt, target: input.target,
      parameters: input.parameters, before: input.before, originalParentRef: session.original_parent_ref,
      preparationRef: input.preparationRef, consumptionRef: consumption.ref, operationRef: input.operationRef,
      applicationAccountId: input.profile.applicationAccountId, authProfileId: input.profile.profile.id, authProfileRef: input.profile.authProfileRef,
    });
    const body: Omit<ApplicationOperationObligation, "ref"> = {
      schema: "finnor.s6.application-obligation.v1", tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      rightsRef: session.parent.rightsRevision, workId: session.work_id, originalParentRef: session.original_parent_ref,
      allocationRef: session.allocation_ref, reservationRef: session.reservation_ref, consumptionRef: consumption.ref,
      preparationRef: input.preparationRef, modelRef: session.model_ref, checkRef: session.check_ref,
      operationRef: input.operationRef, privateBindingRef: input.privateBindingRef, observerContractRef: input.observerContractRef,
      target: input.target, parameters: input.parameters, before: input.before,
      effectRef: { id: effect.id, semanticHash: effect.semanticHash, schemaVersion: 1 }, domainActionId: actionId,
      resourceEnvelope: held.reservation.envelopes, deadlineAt: session.parent.deadlineAt, preparedAt,
      protectionDomain: "DISPOSABLE_TEST_AUTHORITY", replay: "NEVER_AFTER_POSSIBLE_EGRESS",
      executionAuthorityGranted: false, protectedReceipt: null,
    };
    const obligation = { ...body, ref: x2Ref("S6", "application-obligation", body) };
    await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,work_id,action_type,payload,status,summary,initiated_by) VALUES($1,$2,$3,'execute_application_operation_v1',$4::jsonb,'draft',$5,$6)",
      [actionId, ctx.auth.tenantId, session.work_id, JSON.stringify(effect.delta.values), "Exact application operation; independent readback required", principal(ctx)]);
    await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status) VALUES($1,$2,$3,$4,$5,'operational_change',$6::jsonb,'compiled')",
      [effectId, ctx.auth.tenantId, actionId, effect.semanticHash, effect.scopeHash, JSON.stringify(effect)]);
    await c.query("UPDATE finnor_os.domain_actions SET business_effect_id=$1 WHERE tenant_id=$2 AND id=$3",
      [effectId, ctx.auth.tenantId, actionId]);
    await c.query("INSERT INTO finnor_os.s6_obligation_origins(tenant_id,principal_id,obligation_id,consumption_id,effect_id,domain_action_id,input_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
      [ctx.auth.tenantId, principal(ctx), obligation.ref.id, consumption.ref.id, effectId, actionId, requestDigest, JSON.stringify(obligation)]);
    if (originOf(session)) await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "BOUND");
    else {
      await c.query("UPDATE finnor_os.s5_consumption_states SET effect_ref=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND consumption_id=$3",
        [JSON.stringify({ owner: "S6", id: effectId, version: "business-effect-v1", contentDigest: effect.semanticHash }), ctx.auth.tenantId, consumption.ref.id]);
      await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp()"
        + " WHERE tenant_id=$1 AND reservation_id=$2 AND status='RESERVED'",
        [ctx.auth.tenantId, session.reservation_ref.id]);
    }
    await retainApplicationArtifact(ctx, obligation.ref, body, false, c, [body.rightsRef]);
    await retainApplicationArtifact(ctx, consumption.ref, preimage(consumption), false, c, [body.rightsRef]);
    return obligation;
  });
}
export async function applicationRequest(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<ApplicationRequestRow>(
      "SELECT * FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3" + (lock ? " FOR UPDATE" : ""),
      [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row || x2Digest(row.body.wire) !== row.wire_digest || !sameX2Ref(row.binding_ref, row.body.wire.bindingRef)) x2Fault("X2_S6_CANONICAL_WIRE_PREIMAGE");
    return row;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function retainApplicationRequest(ctx: PeMutationContext, session: ApplicationSessionRow,
  obligation: ApplicationOperationObligation, wire: PreparedApplicationWire, input: {
    profile: NativeApplicationProfile; nodeId: string; operationId: string; sourceOperationId: string; phase: ApplicationPhase;
  }) {
  const correlation = applicationWireCorrelation(obligation.ref, `x2:${session.id}:${input.nodeId}`);
  if (wire.identity.effectId !== obligation.effectRef.id || wire.identity.obligationId !== correlation.obligationId
    || wire.identity.idempotencyKey !== correlation.idempotencyKey
    || wire.identity.parentId !== session.parent_id || wire.identity.deadline !== session.parent.deadlineAt
    || !sameX2Ref(wire.bindingRef, obligation.privateBindingRef)
    || wire.expectedVersion !== obligation.before.recordRevision) x2Fault("X2_S6_EXACT_WIRE_IDENTITY_AND_VERSION");
  const body: ApplicationRequestRow["body"] = { schema: "finnor.s6.private-application-request.v2",
    wire: structuredClone(wire), profileId: input.profile.profile.id, privateProfileBindingDigest: input.profile.bindingDigest,
    privateProfileBinding: structuredClone(input.profile.privateProfileBinding),
    operationId: input.operationId, sourceOperationId: input.sourceOperationId, phase: input.phase };
  const publicBody = { schema: "finnor.s6.application-request.v1", sessionId: session.id,
    originalParentRef: session.original_parent_ref, obligationRef: obligation.ref,
    requestId: wire.identity.requestId, effectRef: obligation.effectRef, nodeId: input.nodeId,
    privateWireDigest: x2Digest(wire), privateBindingRef: wire.bindingRef, deadlineAt: session.parent.deadlineAt,
    wireIdentityEncoding: "NATIVE_OPAQUE_REFERENCE_V1",
    executionAuthorityGranted: false, protectedReceipt: null };
  const ref = x2Ref("S6", "application-request", publicBody);
  await withS5PortfolioTransaction(ctx, async (c) => {
    const previous = (await c.query<ApplicationRequestRow>(
      "SELECT * FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND node_id=$4",
      [ctx.auth.tenantId, principal(ctx), session.id, input.nodeId])).rows[0];
    if (previous) {
      if (previous.id !== wire.identity.requestId || previous.wire_digest !== x2Digest(wire)
        || previous.obligation_id !== obligation.ref.id) x2Fault("X2_S6_PREPARED_REQUEST_CANNOT_BE_REPLACED");
      return;
    }
    await c.query("INSERT INTO finnor_os.application_semantics_requests(id,tenant_id,principal_id,session_id,parent_id,node_id,obligation_id,request_ref,binding_ref,wire_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)",
      [wire.identity.requestId, ctx.auth.tenantId, principal(ctx), session.id, session.parent_id, input.nodeId,
        obligation.ref.id, JSON.stringify(ref), JSON.stringify(wire.bindingRef), x2Digest(wire), JSON.stringify(body)]);
    await retainApplicationArtifact(ctx, ref, publicBody, false, c, [session.parent.rightsRevision]);
  });
  return applicationRequest(ctx, wire.identity.requestId);
}
export async function beforeApplicationWire(ctx: PeMutationContext, session: ApplicationSessionRow,
  request: ApplicationRequestRow, execution: Readonly<JobExecutionContext>, wire: PreparedApplicationWire,
  assertModelCurrent: () => Promise<void>) {
  const fenceStarted = performance.now();
  const obligation = await readApplicationObligation(ctx, { owner: "S6", id: request.obligation_id,
    version: "application-operation-v1", contentDigest: request.obligation_id.split(":").at(-1)! });
  requireApplicationDevelopmentAdapter(obligation.protectionDomain);
  const profile = await nativeApplicationProfile(ctx, request.body.profileId);
  assertProfileTarget(profile, obligation.target);
  const correlation = applicationWireCorrelation(obligation.ref, `x2:${session.id}:${request.node_id}`);
  if (profile.bindingDigest !== request.body.privateProfileBindingDigest || x2Digest(wire) !== request.wire_digest
    || x2Digest(wire) !== x2Digest(request.body.wire) || wire.context.principalId !== profile.profile.actingPrincipal
    || wire.context.accountId !== profile.profile.account || wire.context.applicationId !== profile.profile.application
    || wire.identity.effectId !== obligation.effectRef.id || wire.identity.obligationId !== correlation.obligationId
    || wire.identity.idempotencyKey !== correlation.idempotencyKey || wire.identity.parentId !== session.parent_id) x2Fault("X2_S6_CURRENT_PROFILE_OR_WIRE_SUBSTITUTION");
  const modelStarted = performance.now();
  await assertModelCurrent();
  const modelFinished = performance.now();
  await withS5PortfolioTransaction(ctx, async (c) => {
    const current = await assertApplicationClaim(ctx, session, execution, c);
    await currentApplicationWork(ctx, current, c);
    await assertApplicationAllocationCurrent(ctx, obligation.allocationRef, c);
    const row = await applicationRequest(ctx, request.id, c, true);
    if (row.possible_egress || row.status !== "PREPARED" || current.cancel_requested_at) x2Fault("X2_S6_POSSIBLE_EFFECT_MAY_NOT_REPLAY");
    if (current.model_ref) {
      const validity = (await c.query<{ status: string; current_binding_ref: ExperimentRef }>(
        "SELECT status,current_binding_ref FROM finnor_os.application_operation_validities"
        + " WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND operation_id=$4 FOR SHARE",
        [session.tenant_id, session.principal_id, current.model_ref.id, request.body.operationId])).rows[0];
      if (validity?.status !== "CURRENT" || !sameX2Ref(validity.current_binding_ref, request.binding_ref)) {
        x2Fault("X2_S6_CURRENT_OPERATION_FENCED_AT_EGRESS");
      }
    }
    await assertNativeApplicationEffectAdapterBoundary(c, {
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), sessionId: session.id, requestId: request.id,
      effectId: obligation.effectRef.id, actionId: obligation.domainActionId, wireDigest: request.wire_digest,
      profileId: request.body.profileId, jobId: execution.jobId, claimToken: execution.claimToken,
      claimFence: execution.claimFence, generation: current.generation,
    });
    const native = (await c.query<{ status: string; semantic_hash: string }>(
      "SELECT status,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, obligation.effectRef.id])).rows[0];
    if (!native || native.status !== "compiled" || native.semantic_hash !== obligation.effectRef.semanticHash) x2Fault("X2_S6_NATIVE_EFFECT_POSITION_CHANGED");
    await chargeApplicationParent(ctx, { allocationRef: session.allocation_ref, consumptionRef: obligation.consumptionRef,
      requestRef: request.request_ref, phase: request.body.phase, key: `wire:${request.id}`, units: 1 }, c);
    await c.query("UPDATE finnor_os.application_semantics_requests SET possible_egress=true,status='POSSIBLE_EGRESS',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, request.id]);
    await c.query("UPDATE finnor_os.business_effects SET status='executing',authorized_at=clock_timestamp(),execution_started_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, obligation.effectRef.id]);
    await c.query("UPDATE finnor_os.domain_actions SET status='executing',execution_started_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, obligation.domainActionId]);
    if (originOf(session)) await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "POSSIBLE");
    else {
      await c.query("UPDATE finnor_os.s5_consumption_states SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2",
        [ctx.auth.tenantId, obligation.consumptionRef.id]);
      await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
        [ctx.auth.tenantId, session.reservation_ref.id]);
    }
    await applicationEvent(ctx, current, "ATTEMPT_BEFORE_POSSIBLE_WIRE", {
      requestRef: request.request_ref, obligationRef: obligation.ref, effectRef: obligation.effectRef,
      jobId: execution.jobId, claimFence: execution.claimFence, deliveryAttemptId: execution.deliveryAttemptId,
      originalDeadline: session.parent.deadlineAt, reconciliationRequiredBeforeAnySuccessor: true,
      wallMs: { preparation: modelStarted - fenceStarted, modelCurrentness: modelFinished - modelStarted,
        lockedFence: performance.now() - modelFinished },
    }, c);
  });
}
export async function afterApplicationWire(ctx: PeMutationContext, session: ApplicationSessionRow, request: ApplicationRequestRow,
  result: { status: number | null; responseDigest: string | null; possibleEgress: boolean }) {
  await withS5PortfolioTransaction(ctx, async (c) => {
    const current = await applicationRequest(ctx, request.id, c, true);
    await c.query("UPDATE finnor_os.application_semantics_requests SET acknowledged=acknowledged OR $3,status=CASE WHEN status IN ('VERIFIED','DENIED') THEN status ELSE 'UNKNOWN' END,reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, request.id, result.status !== null, result.status === null ? "RESPONSE_UNAVAILABLE_NOT_SETTLEMENT" : "ACKNOWLEDGMENT_NOT_SETTLEMENT"]);
    await applicationEvent(ctx, session, "PHYSICAL_RESPONSE_NOT_SETTLEMENT", { requestRef: current.request_ref, ...result,
      stickyPossibleEgress: current.possible_egress, businessCompletionEstablished: false }, c);
  });
}
export async function settleApplicationObservation(ctx: PeMutationContext, session: ApplicationSessionRow,
  request: ApplicationRequestRow, obligation: ApplicationOperationObligation, input: {
    disposition: "VERIFIED" | "DENIED" | "UNKNOWN"; observation: ApplicationSnapshot | null;
    requestObservationRef: ExperimentRef | null; responseRef: ExperimentRef | null; reason: string;
    execution: Readonly<JobExecutionContext>;
  }) {
  if (input.disposition !== "UNKNOWN" && (!input.observation
    || x2Digest(input.observation.target) !== x2Digest(obligation.target)
    || input.observation.scope.application !== obligation.before.scope.application
    || input.observation.scope.account !== obligation.before.scope.account
    || input.observation.observationQualification !== "LAWFUL_INDEPENDENT_READBACK")) x2Fault("X2_S6_INDEPENDENT_EXACT_SETTLEMENT_REQUIRED");
  return withS5PortfolioTransaction(ctx, async (c) => {
    await assertApplicationClaim(ctx, session, input.execution, c, true);
    const current = await applicationRequest(ctx, request.id, c, true);
    if (["VERIFIED", "DENIED"].includes(current.status)) {
      if (current.status !== input.disposition) x2Fault("X2_S6_CONTRADICTORY_SETTLEMENT");
      return current;
    }
    const evidence = await applicationEvent(ctx, session, "INDEPENDENT_APPLICATION_DISPOSITION", {
      requestRef: request.request_ref, obligationRef: obligation.ref, effectRef: obligation.effectRef,
      disposition: input.disposition, observation: input.observation, requestObservationRef: input.requestObservationRef,
      responseRef: input.responseRef, reason: input.reason, jobId: input.execution.jobId, claimFence: input.execution.claimFence,
      protectedReceipt: null, acknowledgmentSufficient: false, releaseGranted: false, money: null,
    }, c);
    await c.query("UPDATE finnor_os.application_semantics_requests SET status=$3,observation_ref=$4::jsonb,response_ref=$5::jsonb,reason=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, request.id, input.disposition, JSON.stringify(input.observation ? evidence : null), JSON.stringify(input.responseRef), input.reason]);
    const verified = input.disposition === "VERIFIED", denied = input.disposition === "DENIED";
    const verification = { state: verified ? "verified" : denied ? "unverified" : "reconciliation_required",
      basis: input.reason, evidenceRef: evidence, requestObservationRef: input.requestObservationRef,
      checkedAt: new Date().toISOString(), qualification: "INDEPENDENT_DISPOSABLE_APPLICATION_READBACK_NOT_PROTECTED",
      costs: { money: null, status: "UNMETERED", releaseSufficient: false }, protectedReceipt: null };
    await c.query("UPDATE finnor_os.business_effects SET status=$3,verification=$4::jsonb,observed_result=$5::jsonb,observed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND semantic_hash=$6",
      [ctx.auth.tenantId, obligation.effectRef.id, verified ? "verified" : denied ? "cancelled" : "reconciliation_required",
        JSON.stringify(verification), JSON.stringify(input.observation), obligation.effectRef.semanticHash]);
    await c.query("UPDATE finnor_os.domain_actions SET status=$3,execution_started_at=NULL WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, obligation.domainActionId, verified ? "completed" : denied ? "rejected" : "executing"]);
    const state = originOf(session) ? await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "OBSERVED") : (await c.query<{ revision: number }>(
      "UPDATE finnor_os.s5_consumption_states SET status=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2 RETURNING revision",
      [ctx.auth.tenantId, obligation.consumptionRef.id, verified || denied ? "RECONCILED" : "UNKNOWN_OUTCOME"])).rows[0]!;
    await c.query("INSERT INTO finnor_os.s5_history(tenant_id,subject_id,revision,operation,body) VALUES($1,$2,$3,'APPLICATION_S6_OBSERVATION',$4::jsonb)",
      [ctx.auth.tenantId, obligation.consumptionRef.id, state.revision, JSON.stringify({ obligationRef: obligation.ref,
        evidenceRef: evidence, verification, resourceEnvelopeRetained: true, releaseGranted: false })]);
    if (!originOf(session) && (verified || denied)) await c.query(
      "UPDATE finnor_os.s5_reservations s SET status='PARTIALLY_RECONCILED',revision=revision+1,updated_at=clock_timestamp()"
      + " WHERE s.tenant_id=$1 AND s.reservation_id=$2 AND s.status='UNKNOWN_OUTCOME'"
      + " AND NOT EXISTS(SELECT 1 FROM finnor_os.application_semantics_requests r WHERE r.tenant_id=s.tenant_id"
      + " AND r.parent_id=$3 AND r.possible_egress AND r.status NOT IN ('VERIFIED','DENIED'))",
      [ctx.auth.tenantId, session.reservation_ref.id, session.parent_id]);
    const priorReceipt = await c.query("SELECT id FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND domain_action_id=$2 FOR UPDATE",
      [ctx.auth.tenantId, obligation.domainActionId]);
    if (priorReceipt.rowCount === 0) await c.query("INSERT INTO finnor_os.decision_receipts(tenant_id,domain_action_id,work_id,objective,evidence,risk_tier,proposed_action,approval,actual_result,business_effect_id,intended_effect_hash,authorized_effect_hash,executed_effect_hash,verification,correlation_id,finalized_at) VALUES($1,$2,$3,$4,$5::jsonb,'high',$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$10,$10,$11::jsonb,$12,clock_timestamp())",
      [ctx.auth.tenantId, obligation.domainActionId, session.work_id, "Observe the exact native application operation",
        JSON.stringify([evidence, input.requestObservationRef].filter(Boolean)), JSON.stringify({ obligationRef: obligation.ref, target: obligation.target, parameters: obligation.parameters }),
        JSON.stringify({ required: true, basis: "CURRENT_NATIVE_PROFILE_AND_EXTERNAL_ACTING_PRINCIPAL", protectedAdmission: false }),
        JSON.stringify(input.observation), obligation.effectRef.id, obligation.effectRef.semanticHash, JSON.stringify(verification), request.id]);
    else await c.query("UPDATE finnor_os.decision_receipts SET actual_result=$3::jsonb,verification=$4::jsonb,evidence=$5::jsonb,finalized_at=clock_timestamp() WHERE tenant_id=$1 AND domain_action_id=$2",
      [ctx.auth.tenantId, obligation.domainActionId, JSON.stringify(input.observation), JSON.stringify(verification), JSON.stringify([evidence, input.requestObservationRef].filter(Boolean))]);
    return applicationRequest(ctx, request.id, c);
  });
}
