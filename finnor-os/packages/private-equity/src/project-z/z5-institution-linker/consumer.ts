/** Ordinary S8 admission and real S4 declared-contract selection, not effects. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "../../types";
import { chargeInstitutionDemand } from "../../allocation-store";
import { canonical, digest, CONSUMER_VERSION, type Admission, type SessionRow } from "./contracts";
import { transaction, principal, checkedRequestTx, profileTx, artifactTx, eventTx, reference, assertDeliveryTx, boundScope } from "./store";
import { assertCurrentScope } from "../../../../epistemic-runtime/src/project-z/z5-institution-linker/ownership";
import { inspectOwners, assertOwnerCutTx } from "./owners";
import { loadedBuild } from "./source";
import { recordCostTx } from "./artifact";
import { requestOriginalS8Check, recheckOriginalS8Admission } from "./native-s8";

export async function checkedCurrent(ctx: PeMutationContext, id: string) {
  const retained = await transaction(ctx, async c => {
    const row = await checkedRequestTx(ctx, c, id), profile = await profileTx(ctx, c, row.profile_ref);
    return { row, profile, artifact: await artifactTx(ctx, c, row) };
  });
  const build = await loadedBuild(), cut = await inspectOwners(ctx, retained.row.request, retained.profile);
  const originalScope = boundScope(retained.row);
  assertCurrentScope(originalScope, { ...originalScope, tenant: ctx.auth.tenantId, principal: principal(ctx),
    work: retained.profile.workId, root: retained.profile.root, input: cut.workInputId, inputDigest: cut.workInputDigest,
    sourceDigest: build.sourceDigest, rightsRevision: cut.rightsRevision, liveDigest: cut.liveDigest,
    ownerCutDigest: digest(cut), unresolvedObligations: cut.originalObligationRefs });
  const certificate = retained.artifact.certificate;
  if (certificate.disposition !== "CHECKED_CANDIDATE" || !certificate.context || !certificate.replacement
    || !certificate.context.states.includes(cut.liveDigest)
    || retained.artifact.envelope.currentnessDependencies.liveDigest !== cut.liveDigest)
    throw Error("Z5_SUPPORTED_NONEMPTY_CURRENT_DECLARED_CONTRACT_REQUIRED");
  return { ...retained, build, cut };
}
export async function admitInstitutionComposition(ctx: PeMutationContext, id: string, physical?: Readonly<JobExecutionContext>,
  signal?: AbortSignal) {
  const retained = await checkedCurrent(ctx, id), { row, profile, artifact, build, cut } = retained;
  const checker = build.files.find(f => f.path.endsWith("/z5-institution-linker/checker.py"))!;
  if (row.admission) {
    verifyAdmission(row, row.admission);
    await recheckOriginalS8Admission(row, row.admission);
    return transaction(ctx, async c => {
      const current = await checkedRequestTx(ctx, c, row);
      if (physical) await assertDeliveryTx(ctx, c, current, physical);
      await assertOwnerCutTx(ctx, c, current.request, profile, cut);
      if (!current.admission) throw Error("Z5_EXACT_ADMITTED_ARTIFACT_REQUIRED");
      verifyAdmission(current, current.admission);
      return current.admission;
    });
  }
  const invocation = randomUUID();
  const native = await requestOriginalS8Check(row, physical ? { tenantId: physical.tenantId, protocolVersion: physical.protocolVersion,
    jobId: physical.jobId, claimToken: physical.claimToken, claimFence: physical.claimFence,
    deliveryAttemptId: physical.deliveryAttemptId } : null, signal), checked = native.assertion.check;
  if (native.assertion.checkerSha256 !== checker.sha256 || checked.claimDigest !== artifact.payload.check.claimDigest)
    throw Error("Z5_ORIGINAL_S8_CHECKER_SUBSTITUTION");
  return transaction(ctx, async c => {
    const current = await checkedRequestTx(ctx, c, row, true);
    if (physical) await assertDeliveryTx(ctx, c, current, physical);
    await assertOwnerCutTx(ctx, c, current.request, profile, cut);
    if (current.admission) {
      verifyAdmission(current, current.admission);
      return current.admission;
    }
    const body: Omit<Admission, "ref"> = {
      schema: "finnor.s8.institution-composition-admission.v1", tenantId: row.tenant_id, principalId: row.principal_id,
      requestId: row.id, artifactDigest: row.artifact_digest!, inputDigest: digest(row.input), checkerDigest: digest(checked),
      sourceDigest: build.sourceDigest, liveDigest: cut.liveDigest, rightsRevision: row.rights_revision,
      validUntil: row.request.originalDeadline, domain: "ORDINARY_DEVELOPMENT", protectedAdmission: false,
      nativeS8Reference: native.nativeReference, nativeS8PolicyDigest: native.policyDigest,
      executionAuthorityGranted: false, productionActivated: false,
    };
    const admission: Admission = { ...body, ref: reference("S8", "institution-composition-admission", body) };
    const costRef = await recordCostTx(ctx, c, current, invocation, "ACCEPT", { stageOwner: "S8",
      checkerOperations: checked.operations, claimDigest: checked.claimDigest, money: null, human: null });
    await c.query(`INSERT INTO finnor_os.z5_s8_admissions(tenant_id,principal_id,request_id,admission_id,body)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [row.tenant_id, row.principal_id, row.id, admission.ref.id, canonical(admission)]);
    await c.query("UPDATE finnor_os.z5_link_requests SET admission=$3::jsonb WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id, row.id, canonical(admission)]);
    await eventTx(ctx, c, current, "S8_DECLARED_CONTRACT_ADMITTED", admission.ref.id, { admissionRef: admission.ref,
      finiteScope: artifact.envelope.supportedDomain, costRef, protectedAdmission: false, productionActivated: false });
    return admission;
  });
}
function verifyAdmission(row: SessionRow, admission: Admission) {
  const { ref, ...body } = admission;
  if (digest(reference("S8", "institution-composition-admission", body)) !== digest(ref)
    || admission.requestId !== row.id || admission.tenantId !== row.tenant_id || admission.principalId !== row.principal_id
    || admission.artifactDigest !== row.artifact_digest || admission.inputDigest !== digest(row.input)
    || admission.sourceDigest !== row.source_digest || admission.liveDigest !== row.cut.liveDigest
    || admission.rightsRevision !== row.rights_revision || Date.parse(admission.validUntil) <= Date.now()
    || admission.protectedAdmission !== false || admission.productionActivated !== false || admission.executionAuthorityGranted !== false)
    throw Error("Z5_S8_ADMISSION_BINDING_OR_CURRENTNESS");
}
export async function useInstitutionComposition(ctx: PeMutationContext, id: string, artifactDigest: string,
  idempotencyKey: string, physicalInvocationId: string, physical?: Readonly<JobExecutionContext>) {
  const retained = await checkedCurrent(ctx, id), { row, profile, artifact, cut } = retained;
  if (row.artifact_digest !== artifactDigest || !row.admission) throw Error("Z5_EXACT_ADMITTED_ARTIFACT_REQUIRED");
  verifyAdmission(row, row.admission);
  await recheckOriginalS8Admission(row, row.admission);
  // Commit an original S5 physical lifecycle debit before currentness/selection.
  const funding = await chargeInstitutionDemand(ctx, row.request.parentReservation, {
    responsibilityIdentity: row.request.responsibilityIdentity, phase: "LIFECYCLE",
    ordinal: 1, units: 1, physicalInvocationId,
  });
  return transaction(ctx, async c => {
    const current = await checkedRequestTx(ctx, c, row, true);
    if (physical) await assertDeliveryTx(ctx, c, current, physical);
    await assertOwnerCutTx(ctx, c, current.request, profile, cut);
    if (!current.admission)
      throw Error("Z5_S4_USE_PUBLICATION_FENCED");
    verifyAdmission(current, current.admission);
    const replacement = artifact.certificate.replacement!;
    const useBody = { schema: "finnor.s4.institution-composition-use.v1", requestId: row.id, workId: row.work_id, idempotencyKey,
      workInputId: row.work_input_id, artifactDigest, admissionRef: current.admission.ref,
      policyRef: row.request.policyRef, allocationRef: row.request.allocationRef, originalPreparationRef: row.request.preparationRef,
      originalReservation: row.request.parentReservation, capitalReservationCarried: true,
      liveDigest: cut.liveDigest, replacement, consumerVersion: CONSUMER_VERSION,
      selectedContractRevisions: row.input.components.map(component => ({ id: component.id,
        revision: replacement.status === "BRIDGED" && replacement.component === component.id ? replacement.revision : component.revision })),
      unresolvedOldObligationRefs: row.cut.originalObligationRefs, remainingDeadline: row.request.originalDeadline,
      interpretation: "S4_INTEGRATION_REPLACEMENT_PLAN_FOR_EXACT_DECLARED_KERNEL_NOT_HOT_SWAP_OF_ARBITRARY_TS",
      oldComponentFallback: replacement.status === "RETAIN_OLD", effectAuthorityGranted: false, newAllowance: false };
    const ref = reference("S4", "institution-composition-use", useBody), body = { ...useBody, ref };
    const prior = (await c.query<{ body: typeof body; request_digest: string }>(
      `SELECT body,request_digest FROM finnor_os.z5_s4_uses WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND idempotency_key=$4 FOR SHARE`,
      [row.tenant_id, row.principal_id, row.id, idempotencyKey])).rows[0];
    const requestDigest = digest({ id, artifactDigest, idempotencyKey });
    const costRef = await recordCostTx(ctx, c, current, physicalInvocationId, "REPLACEMENT", {
      chargeRef: funding.charge.ref, selectedRevisions: useBody.selectedContractRevisions, liveBridge: replacement.bridge,
      oldLiabilitiesCarried: true, externalCalls: 0 });
    if (prior) {
      if (prior.request_digest !== requestDigest || digest(prior.body) !== digest(body)) throw Error("Z5_S4_USE_IDEMPOTENCY_CONFLICT");
      return prior.body;
    }
    await c.query(`INSERT INTO finnor_os.z5_s4_uses(tenant_id,principal_id,request_id,use_id,idempotency_key,request_digest,body)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [row.tenant_id, row.principal_id, row.id, ref.id, idempotencyKey, requestDigest, canonical(body)]);
    await c.query(`INSERT INTO finnor_os.z5_s4_heads(tenant_id,principal_id,work_id,policy_id,allocation_id,request_id,use_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(tenant_id,principal_id,work_id,policy_id,allocation_id)
      DO UPDATE SET request_id=excluded.request_id,use_id=excluded.use_id`,
    [row.tenant_id, row.principal_id, row.work_id, row.request.policyRef.id, row.request.allocationRef.id, row.id, ref.id]);
    await eventTx(ctx, c, current, "S4_CURRENT_DECLARED_CONTRACT_SELECTED", ref.id, { useRef: ref, costRef,
      actualOwner: "S4", consumedFor: "INTEGRATION_AND_REPLACEMENT_PLANNING", independentEffectObservationRequired: true });
    await c.query("UPDATE finnor_os.z5_link_requests SET status='USED' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
    return body;
  });
}
function compositionBinding(current: Awaited<ReturnType<typeof checkedCurrent>>, useRef: ExperimentRef) {
  const { row, artifact, cut } = current;
  return { requestId: row.id, workId: row.work_id, artifactDigest: row.artifact_digest, liveDigest: cut.liveDigest,
    useRef, certificateRef: artifact.ref, profileRef: row.profile_ref, admissionRef: row.admission!.nativeS8Reference,
    context: artifact.certificate.context, replacement: artifact.certificate.replacement,
    originalReservation: row.request.parentReservation, unresolvedOldObligationRefs: row.cut.originalObligationRefs,
    originalDeadline: row.request.originalDeadline, consumerVersion: CONSUMER_VERSION,
    protectedAdmission: false, executionAuthorityGranted: false };
}
async function assertCompositionSelectionTx(ctx: PeMutationContext, c: PoolClient, binding: unknown,
  current: Awaited<ReturnType<typeof checkedCurrent>>, write = false) {
  const actual = await checkedRequestTx(ctx, c, current.row, write);
  if (!actual.admission) throw Error("Z5_HANDOFF_REQUIRES_CURRENT_S8_DECLARED_CONTRACT");
  verifyAdmission(actual, actual.admission);
  await assertOwnerCutTx(ctx, c, actual.request, current.profile, current.cut);
  const head = (await c.query<{ ref: ExperimentRef }>(
    `SELECT u.body->'ref' ref FROM finnor_os.z5_s4_heads h JOIN finnor_os.z5_s4_uses u
     ON u.tenant_id=h.tenant_id AND u.principal_id=h.principal_id AND u.use_id=h.use_id
     WHERE h.tenant_id=$1 AND h.principal_id=$2 AND h.work_id=$3 AND h.policy_id=$4 AND h.allocation_id=$5
      AND h.request_id=$6 FOR SHARE OF h,u`,
  [actual.tenant_id, actual.principal_id, actual.work_id, actual.request.policyRef.id, actual.request.allocationRef.id, actual.id])).rows[0];
  if (!head || digest(binding) !== digest(compositionBinding({ ...current, row: actual }, head.ref)))
    throw Error("Z5_EXACT_ORIGINAL_S4_CONDITIONAL_CONTRACT_REQUIRED");
  return actual;
}
/** Invoked by the original S4 handoff producer. A stored selection alone is not
 * reported as actual handoff consumption; this reader checks every owner again. */
export async function currentCompositionForHandoff(ctx: PeMutationContext, policyRef: ExperimentRef, allocationRef?: ExperimentRef) {
  if (!allocationRef || process.env.FINNOR_Z5_PROFILE !== "ordinary_disposable") return null;
  const selection = await transaction(ctx, async c => {
    const rows = (await c.query<{ request_id: string; use_id: string }>(
      `SELECT request_id,use_id FROM finnor_os.z5_s4_heads
       WHERE tenant_id=$1 AND principal_id=$2 AND policy_id=$3 AND allocation_id=$4 LIMIT 2 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), policyRef.id, allocationRef.id])).rows;
    if (rows.length > 1) throw Error("Z5_S4_COMPOSITION_HEAD_AMBIGUOUS");
    return rows[0] ?? null;
  });
  if (!selection) return null;
  const current = await checkedCurrent(ctx, selection.request_id);
  if (!current.row.admission) throw Error("Z5_HANDOFF_REQUIRES_CURRENT_S8_DECLARED_CONTRACT");
  verifyAdmission(current.row, current.row.admission);
  await recheckOriginalS8Admission(current.row, current.row.admission);
  return transaction(ctx, async c => {
    const row = await checkedRequestTx(ctx, c, current.row, true);
    if (!row.admission) throw Error("Z5_HANDOFF_REQUIRES_CURRENT_S8_DECLARED_CONTRACT");
    verifyAdmission(row, row.admission);
    await assertOwnerCutTx(ctx, c, row.request, current.profile, current.cut);
    const use = (await c.query<{ body: { ref: ExperimentRef; artifactDigest: string; liveDigest: string } }>(
      `SELECT u.body FROM finnor_os.z5_s4_heads h JOIN finnor_os.z5_s4_uses u
       ON u.tenant_id=h.tenant_id AND u.principal_id=h.principal_id AND u.use_id=h.use_id
       WHERE h.tenant_id=$1 AND h.principal_id=$2 AND h.work_id=$3 AND h.policy_id=$4 AND h.allocation_id=$5
        AND h.request_id=$6 AND h.use_id=$7 FOR SHARE OF h,u`,
      [row.tenant_id, row.principal_id, row.work_id, policyRef.id, allocationRef.id, row.id, selection.use_id])).rows[0]?.body;
    if (!use || use.artifactDigest !== row.artifact_digest || use.liveDigest !== current.cut.liveDigest)
      throw Error("Z5_HANDOFF_ACTUAL_LIVE_SELECTION_CHANGED");
    await eventTx(ctx, c, row, "S4_ORIGINAL_HANDOFF_CONTRACT_RESOLVED", "handoff-resolved:" + selection.use_id,
      { useRef: use.ref, originalPolicyRef: policyRef, originalAllocationRef: allocationRef,
        actualConsumer: "prepareEnterpriseContingentHandoff", originalResourcesAndOldObligationsCarried: true });
    return compositionBinding({ ...current, row }, use.ref);
  });
}
export async function assertCompositionHandoffCurrent(ctx: PeMutationContext, binding: unknown, policyRef: ExperimentRef,
  allocationRef: ExperimentRef | null) {
  if (binding === undefined || binding === null) return;
  if (!allocationRef) throw Error("Z5_HANDOFF_ALLOCATION_REQUIRED");
  const b = binding as { requestId?: unknown; artifactDigest?: unknown; liveDigest?: unknown };
  if (typeof b.requestId !== "string") throw Error("Z5_HANDOFF_COMPOSITION_BINDING_INVALID");
  const current = await checkedCurrent(ctx, b.requestId);
  if (b.artifactDigest !== current.row.artifact_digest || b.liveDigest !== current.cut.liveDigest
    || digest(current.row.request.policyRef) !== digest(policyRef) || digest(current.row.request.allocationRef) !== digest(allocationRef)
    || !current.row.admission) throw Error("Z5_HANDOFF_COMPOSITION_BINDING_STALE");
  verifyAdmission(current.row, current.row.admission);
  await recheckOriginalS8Admission(current.row, current.row.admission);
  const row = await transaction(ctx, c => assertCompositionSelectionTx(ctx, c, binding, current));
  return { ...current, row };
}
export async function beginCompositionPlanning(ctx: PeMutationContext, binding: { requestId: string }) {
  const retained = await checkedCurrent(ctx, binding.requestId);
  const current = await assertCompositionHandoffCurrent(ctx, binding, retained.row.request.policyRef, retained.row.request.allocationRef);
  if (!current) throw Error("Z5_HANDOFF_COMPOSITION_BINDING_INVALID");
  const { row } = current;
  const invocation = randomUUID(), funding = await chargeInstitutionDemand(ctx, row.request.parentReservation, {
    responsibilityIdentity: row.request.responsibilityIdentity, phase: "LIFECYCLE", ordinal: 1, units: 1, physicalInvocationId: invocation });
  return transaction(ctx, async c => {
    const actual = await assertCompositionSelectionTx(ctx, c, binding, current);
    return recordCostTx(ctx, c, actual, invocation, "CLAIM", { stageOwner: "ORIGINAL_S4_PLANNING",
      chargeRef: funding.charge.ref, state: "IMMUTABLE_PLAN_PERSISTENCE_PENDING_UNKNOWN_IF_INTERRUPTED", money: null, human: null });
  });
}
export async function recordCompositionHandoffConsumed(ctx: PeMutationContext, binding: unknown, preparationRef: ExperimentRef) {
  if (binding === undefined || binding === null) return;
  const b = binding as { requestId?: unknown };
  if (typeof b.requestId !== "string") throw Error("Z5_HANDOFF_COMPOSITION_BINDING_INVALID");
  const preparation = await (await import("../../enterprise-control")).readEnterpriseContingentHandoffPreparation(ctx, preparationRef);
  if (digest((preparation as typeof preparation & { compositionContract?: unknown }).compositionContract ?? null) !== digest(binding))
    throw Error("Z5_ORIGINAL_HANDOFF_DID_NOT_PERSIST_CONTRACT");
  const current = await assertCompositionHandoffCurrent(ctx, binding, preparation.handoff.policyRef, preparation.handoff.allocationRef);
  if (!current) throw Error("Z5_HANDOFF_COMPOSITION_BINDING_INVALID");
  return transaction(ctx, async c => {
    const row = await assertCompositionSelectionTx(ctx, c, binding, current, true);
    return eventTx(ctx, c, row, "S4_ORIGINAL_HANDOFF_CONTRACT_CONSUMED", "handoff:" + preparationRef.id,
      { preparationRef, binding, actualOriginalConsumer: "prepareEnterpriseContingentHandoff",
        protectedAdmission: false, executionAuthorityGranted: false });
  });
}
/** Original S4's planning reader calls this after its own immutable artifact is
 * persisted. This works while an old S6 effect is UNKNOWN; it is not a new
 * control choice, handoff, dispatch or compensation. */
export async function recordCompositionPlanConsumed(ctx: PeMutationContext, binding: unknown, planRef: ExperimentRef) {
  const b = binding as { requestId?: unknown };
  if (typeof b?.requestId !== "string") throw Error("Z5_ORIGINAL_S4_PLAN_BINDING_REQUIRED");
  const originalS4 = await import("../../enterprise-control");
  const reader = Reflect.get(originalS4, "readEnterpriseInstitutionCompositionPlanByRef");
  if (typeof reader !== "function") throw Error("Z5_ORIGINAL_S4_PLAN_READER_INTEGRATION_REQUIRED");
  const plan = await reader(ctx, planRef) as { compositionContract: unknown; policyRef: ExperimentRef; allocationRef: ExperimentRef };
  if (digest(plan.compositionContract) !== digest(binding)) throw Error("Z5_ORIGINAL_S4_PLAN_DID_NOT_CONSUME_EXACT_CONTRACT");
  const current = await assertCompositionHandoffCurrent(ctx, binding, plan.policyRef, plan.allocationRef);
  if (!current) throw Error("Z5_HANDOFF_COMPOSITION_BINDING_INVALID");
  return transaction(ctx, async c => {
    const row = await assertCompositionSelectionTx(ctx, c, binding, current, true);
    return eventTx(ctx, c, row, "S4_ORIGINAL_COMPOSITION_PLAN_CONSUMED", "plan:" + planRef.id, {
      planRef, binding, actualOriginalConsumer: "prepareEnterpriseInstitutionCompositionPlan",
      oldUnknownObligationsCarried: true, newControlChoice: false, effectAuthorityGranted: false });
  });
}
