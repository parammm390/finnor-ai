/** S8 canary owner joins and stopping. No assignment, funding or effect authority. */
import { z } from 'zod';
import { parseOutcomeEstimand, collectEconomicRefs } from '../../epistemic-runtime/src/economic-attribution';
import { resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import { digest, sameRef, fault, RefSchema, parseRevision, type CapabilityRevision, type CapabilityRef } from './contracts';
import type { CapabilityUseLease } from './lifecycle';
import type { PeMutationContext } from '../../private-equity/src/types';
const text = z.string().min(1).max(4096);
export const CanaryPlanSchema = z.object({ schema: z.literal('finnor.s8.native-canary-plan.v1'), estimandRef: RefSchema, protocolRef: RefSchema,
    fundingAllocationRef: RefSchema, fundingReservationRef: RefSchema, controllerId: text, reservedCostPerUse: z.number().finite().min(0),
    maxPendingUses: z.number().int().min(1).max(256), stopAt: z.string().datetime({ offset: true }),
    stopOnUncertainOutcome: z.literal(true), stopOnAdverseNotice: z.literal(true), maximumUsesPerCluster: z.literal(1) }).strict();
export type NativeCanaryPlan = z.infer<typeof CanaryPlanSchema>;
export const CanaryUseSchema = z.object({ assignmentGroupRef: RefSchema, assignmentRef: RefSchema, clusterId: text, policyRefs: z.array(RefSchema).min(1).max(20), mandateRef: RefSchema }).strict();
export type NativeCanaryUse = z.infer<typeof CanaryUseSchema>;
export const CanaryLeaseSchema = z.object({ plan: CanaryPlanSchema, binding: CanaryUseSchema }).strict();
type Scope = { tenantId: string; principalId: string; rightsRef: string; protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN' };
const context = (scope: Scope): PeMutationContext => ({ auth: { tenantId: scope.tenantId, userId: scope.principalId, employeeId: scope.principalId, role: 'owner' } });
async function accepted(scope: Scope, ref: CapabilityRef) {
    const read = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: scope.tenantId, principalId: scope.principalId }, ref, { purpose: 'CONSUMER', rightsRef: scope.rightsRef });
    if (read.protectionDomain !== scope.protectionDomain)
        fault('S8_CANARY_PROTECTION_DOMAIN_CHANGED');
    return read;
}
export async function verifyNativeCanaryPlan(scope: Scope, revision: CapabilityRevision, value: unknown) {
    const plan = CanaryPlanSchema.parse(value), ctx = context(scope);
    // Defer owner modules until after consumer schemas initialize. The native
    // S5 owner itself imports this consumer; eager imports create a loader cycle.
    const { readEnterpriseEconomicRecord, readEnterpriseEconomicHistory } = await import('../../private-equity/src/enterprise-economic-attribution');
    const { readEnterpriseEconomicAssignmentRecord } = await import('../../private-equity/src/enterprise-economic-assignments');
    const { readEnterpriseAllocation, validateEnterpriseAllocation } = await import('../../private-equity/src/enterprise-allocation');
    const { readEnterpriseContingentPolicy } = await import('../../private-equity/src/enterprise-control');
    if (revision.tenantId !== scope.tenantId || revision.principalId !== scope.principalId || revision.domain.rightsRef !== scope.rightsRef
        || plan.estimandRef.owner !== 'S7' || plan.protocolRef.owner !== 'S2' || plan.fundingAllocationRef.owner !== 'S5' || plan.fundingReservationRef.owner !== 'S5'
        || Date.parse(plan.stopAt) <= Date.now() || Date.parse(plan.stopAt) > Date.parse(revision.domain.validUntil))
        fault('S8_CANARY_PLAN_SCOPE_OR_EXPIRY');
    const source = await readEnterpriseEconomicRecord(ctx, { id: plan.estimandRef.id, protectedReadback: true });
    if (!('record' in source) || !source.protectedReadback || source.protectedReadback.protectionDomain !== scope.protectionDomain
        || !sameRef(source.record.ref, plan.estimandRef) || source.record.kind !== 'PREREGISTRATION' || source.record.payload.mode !== 'PROSPECTIVE'
        || source.record.event.rightsRef !== scope.rightsRef)
        fault('S8_NATIVE_CANARY_PREREGISTRATION_REQUIRED');
    const e = parseOutcomeEstimand(source.record.payload.estimand), controller = e.controllers.find(c => c.id === plan.controllerId);
    if (e.assignment.kind !== 'INDEPENDENT_CLUSTER_RANDOMIZATION' || !sameRef(e.assignment.protocolRef, plan.protocolRef)
        || !controller || !sameRef(controller.adaptationRuleRef, revision.ref) || controller.role !== 'FINNOR'
        || !sameRef(e.allocationRef, plan.fundingReservationRef) || Date.parse(plan.stopAt) > Date.parse(e.endpointAt))
        fault('S8_CANARY_PREREGISTRATION_BINDING');
    const cut = source.record.payload.sourceCut as any[];
    if (!Array.isArray(cut) || collectEconomicRefs(e).some(ref => !cut.some(v => sameRef(v.ref, ref) && v.status === 'RESOLVED_AUTHENTICATED'
        && v.signatureVerified === true && v.protectedReceiptRef && Date.parse(v.knowledgeAt) < Date.parse(e.assignmentAt))))
        fault('S8_CANARY_PREASSIGNMENT_SOURCE_CUT_REQUIRED');
    const mandate = (await accepted(scope, e.mandateRef)).reference.content;
    if (mandate.schema !== 'finnor.economic-mandate.v1' || mandate.tenantId !== scope.tenantId || mandate.principalId !== scope.principalId
        || mandate.rightsRef !== scope.rightsRef || mandate.economicProgrammeAssignment !== true || !Number.isFinite(Date.parse(mandate.validUntil))
        || Date.parse(mandate.validUntil) <= Date.now() || Date.parse(plan.stopAt) > Date.parse(mandate.validUntil))
        fault('S8_CANARY_ASSIGNMENT_MANDATE_EXPIRED_OR_EXCEEDED');
    const protocol = await readEnterpriseEconomicAssignmentRecord(ctx, plan.protocolRef), protectedProtocol = await accepted(scope, plan.protocolRef), p = protocol.content;
    if (!sameRef(protectedProtocol.reference.content, p) || p.schema !== 'finnor.s2.economic-assignment-protocol.v1'
        || p.rightsRef !== scope.rightsRef || !sameRef(p.clusterIds, e.clusters.map(c => c.id)) || !sameRef(p.controllerIds, e.controllers.map(c => c.id))
        || !sameRef(p.probabilities, e.assignment.probabilities) || !sameRef(p.mandateRef, e.mandateRef) || !sameRef(p.populationRef, e.populationRef)
        || p.assignmentNotBefore !== e.assignmentAt || p.outcomeAccessNotBefore !== e.outcomeAccessNotBefore
        || p.randomization !== 'INDEPENDENT_CRYPTO_CATEGORICAL_V1')
        fault('S8_NATIVE_CANARY_PROTOCOL_BINDING');
    const funding = await readEnterpriseAllocation(ctx, plan.fundingAllocationRef);
    // A funding allocation produced by this lifecycle would recursively recheck
    // itself. Require a separately issued native owner allocation instead.
    if (funding.certificate.compute.usage.backend.capabilityLease || funding.certificate.rightsRef !== scope.rightsRef
        || !funding.reservation || !sameRef(funding.reservation.ref, plan.fundingReservationRef)
        || Date.parse(plan.stopAt) > Date.parse(funding.certificate.validUntil))
        fault('S8_CANARY_SEPARATE_NATIVE_FUNDING_REQUIRED');
    const validation = await validateEnterpriseAllocation(ctx, plan.fundingAllocationRef);
    if (validation.status !== 'CURRENT')
        fault('S8_CANARY_NATIVE_FUNDING_STALE');
    await accepted(scope, plan.fundingAllocationRef); await accepted(scope, plan.fundingReservationRef);
    if (!controller.policyRefs.length || !controller.policyRefs.some(ref => sameRef(ref, controller.programmeRef))
        || controller.policyRefs.some(ref => !funding.problem.policies.some(policy => sameRef(policy.ref, ref))))
        fault('S8_CANARY_NATIVE_POLICY_BINDING');
    for (const ref of controller.policyRefs) { await readEnterpriseContingentPolicy(ctx, ref); await accepted(scope, ref); }
    const history = await readEnterpriseEconomicHistory(ctx, { estimandId: plan.estimandRef.id });
    if (!history.complete || !history.records.some(record => sameRef(record.ref, plan.estimandRef)))
        fault('S8_CANARY_NATIVE_HISTORY_INCOMPLETE');
    if (history.records.some(record => record.kind === 'PREREGISTRATION' && !sameRef(record.ref, plan.estimandRef)
        || ['COST', 'CORRECTION', 'VALUATION', 'INVALIDATION'].includes(record.kind)))
        fault('S8_CANARY_ADVERSE_NOTICE_STOP');
    return { plan, estimand: e, controller, funding, history, qualification: 'NATIVE_OWNER_BINDINGS_ONLY_NO_PHYSICAL_PERMISSION_OR_OWNER_LOSS_GUARANTEE' as const };
}
export async function verifyNativeCanaryUse(scope: Scope, revision: CapabilityRevision, planValue: unknown, bindingValue: unknown) {
    const current = await verifyNativeCanaryPlan(scope, revision, planValue), binding = CanaryUseSchema.parse(bindingValue), ctx = context(scope);
    const { readEnterpriseEconomicAssignmentRecord } = await import('../../private-equity/src/enterprise-economic-assignments');
    const group = await readEnterpriseEconomicAssignmentRecord(ctx, binding.assignmentGroupRef), protectedGroup = await accepted(scope, binding.assignmentGroupRef), g = group.content;
    const assignment = group.assignments?.find(a => a.clusterId === binding.clusterId);
    if (!sameRef(protectedGroup.reference.content, g) || g.schema !== 'finnor.s2.economic-assignment-group.v1'
        || !sameRef(g.estimandRef, current.plan.estimandRef) || !sameRef(g.protocolRef, current.plan.protocolRef)
        || !assignment || assignment.controllerId !== current.plan.controllerId || !sameRef(assignment.assignmentRef, binding.assignmentRef)
        || !sameRef(assignment.protocolRef, current.plan.protocolRef) || Date.parse(assignment.assignedAt) < Date.parse(current.estimand.assignmentAt)
        || Date.parse(assignment.assignedAt) >= Date.parse(current.estimand.outcomeAccessNotBefore) || Date.parse(assignment.assignedAt) > Date.now()
        || !sameRef(binding.mandateRef, current.funding.problem.mandate.ref)
        || binding.policyRefs.length !== current.controller.policyRefs.length || new Set(binding.policyRefs.map(ref => ref.id)).size !== binding.policyRefs.length
        || binding.policyRefs.some(ref => !current.controller.policyRefs.some(policy => sameRef(policy, ref))))
        fault('S8_CANARY_NATIVE_ASSIGNMENT_OR_INPUT_BINDING');
    const protectedDraw = await accepted(scope, binding.assignmentRef), draw = protectedDraw.reference.content;
    if (draw.schema !== 'finnor.s2.economic-assignment.v1' || draw.tenantId !== scope.tenantId || draw.principalId !== scope.principalId
        || !sameRef(draw.estimandRef, current.plan.estimandRef) || !sameRef(draw.protocolRef, current.plan.protocolRef)
        || draw.clusterId !== binding.clusterId || draw.controllerId !== current.plan.controllerId || draw.assignedAt !== assignment.assignedAt
        || draw.randomization !== 'INDEPENDENT_CRYPTO_CATEGORICAL_V1')
        fault('S8_CANARY_PROTECTED_DRAW_SUBSTITUTION');
    return { plan: current.plan, binding, planDigest: digest(current.plan), current: true as const, executionAuthorityGranted: false as const };
}
export async function verifyNativeCanaryLease(scope: Scope, lease: CapabilityUseLease) {
    const canary = CanaryLeaseSchema.parse(lease.canary), original = await accepted(scope, lease.revisionRef), activation = await accepted(scope, lease.activationRef);
    const revision = parseRevision({ ...original.reference.content, ref: lease.revisionRef }), body = activation.reference.content?.body;
    if (!body || !sameRef(body.revisionRef, lease.revisionRef) || !sameRef(body.canaryPlan, canary.plan) || body.mode !== lease.mode
        || body.validUntil !== lease.expiresAt || Date.parse(lease.expiresAt) > Date.parse(canary.plan.stopAt)
        || lease.inputDigest.length !== 64 || lease.reservedCost !== canary.plan.reservedCostPerUse || !sameRef(lease.payload, revision.payload)
        || !sameRef(lease.domain, revision.domain))
        fault('S8_CANARY_CONSUMER_ACTIVATION_SUBSTITUTION');
    return verifyNativeCanaryUse(scope, revision, canary.plan, canary.binding);
}
/** Reconciliation can retain old/revoked work; it never requires a fresh lease. */
export async function verifyNativeCanaryUncertainOutcome(scope: Scope, lease: CapabilityUseLease, evidenceRef: CapabilityRef, outcome: string) {
    const { readEnterpriseEconomicRecord } = await import('../../private-equity/src/enterprise-economic-attribution');
    const canary = CanaryLeaseSchema.parse(lease.canary), read = await readEnterpriseEconomicRecord(context(scope), { id: evidenceRef.id, protectedReadback: true });
    if (!('record' in read) || !read.protectedReadback || read.protectedReadback.protectionDomain !== scope.protectionDomain
        || !sameRef(read.record.ref, evidenceRef) || read.record.estimandId !== canary.plan.estimandRef.id || read.record.event.rightsRef !== scope.rightsRef
        || !['EXPOSURE', 'MEASUREMENT'].includes(read.record.kind))
        fault('S8_CANARY_NATIVE_OUTCOME_REFERENCE_REQUIRED');
    const record = read.record.payload.record as any;
    if (!record || record.useId !== lease.useId || record.inputDigest !== lease.inputDigest || record.outcome !== outcome
        || !sameRef(record.revisionRef, lease.revisionRef) || !sameRef(record.assignmentRef, canary.binding.assignmentRef)
        || record.clusterId !== canary.binding.clusterId)
        fault('S8_CANARY_OUTCOME_USE_LINEAGE_SUBSTITUTION');
    return { evidenceRef, outcome, liabilityBudgetReleased: false as const, executionAuthorityGranted: false as const };
}
/** Includes old revisions and retained uncertain outcomes. No budget release. */
export function assertNativeCanaryCapacity(plan: NativeCanaryPlan, uses: any[], binding?: NativeCanaryUse, existingUseId?: string) {
    const campaign = uses.filter(use => use.canary && sameRef(use.canary.plan.estimandRef, plan.estimandRef));
    if (campaign.some(use => use.outcome && use.outcome !== 'VERIFIED'))
        fault('S8_CANARY_UNCERTAIN_OUTCOME_STOP');
    const others = campaign.filter(use => use.useId !== existingUseId);
    if (others.filter(use => use.status === 'PINNED_PENDING' || use.effectLineage && use.ownerLossDispositionQualified !== true).length >= plan.maxPendingUses)
        fault('S8_CANARY_PENDING_EXPOSURE_STOP');
    if (binding && others.some(use => use.canary.binding.clusterId === binding.clusterId))
        fault('S8_CANARY_CLUSTER_ALREADY_USED');
}
