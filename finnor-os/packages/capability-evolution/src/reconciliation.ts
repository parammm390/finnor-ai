/** Physical H0 reconciliation of original S8 uses; no value or effect authority. */
import { z } from 'zod';
import { RefSchema, digest, sameRef, fault, type CapabilityRef } from './contracts';
import { readOwnerTransportExecutionHandoff, resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import type { CapabilityUseLease } from './lifecycle';
import type { PeMutationContext } from '../../private-equity/src/types';
export const ExecutionLineageSchema = z.object({ allocationRef: RefSchema, obligationRef: RefSchema, settlementEventId: z.string().min(1).max(4096) }).strict();
const EffectRefSchema = z.object({ id: z.string().min(1).max(4096), semanticHash: z.string().regex(/^[a-f0-9]{64}$/), schemaVersion: z.literal(1) }).strict();
const OutcomeSchema = z.object({ schema: z.literal('finnor.s8.use-effect-outcome.v1'), useId: z.string().min(1).max(4096), revisionRef: RefSchema,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/), outcome: z.enum(['VERIFIED', 'UNKNOWN', 'FAILED', 'DECLINED', 'CENSORED']), allocationRef: RefSchema, obligationRef: RefSchema,
    settlementEventId: z.string().min(1).max(4096), effectRef: EffectRefSchema, horizon: z.literal('H0'), causalCreditGranted: z.literal(false), candidateExposure: z.boolean() }).strict();
export async function verifyCapabilityEffectReconciliation(input: { tenantId: string; principalId: string; rightsRef: string;
    protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN'; lease: CapabilityUseLease; evidenceRef: CapabilityRef; executionLineage: unknown }) {
    const lineage = ExecutionLineageSchema.parse(input.executionLineage), lease = input.lease;
    const ctx: PeMutationContext = { auth: { tenantId: input.tenantId, userId: input.principalId, employeeId: input.principalId, role: 'owner' } };
    const { readEnterpriseAllocation, readEnterpriseAllocationSettlement } = await import('../../private-equity/src/enterprise-allocation');
    const { readEnterpriseDurableObligation } = await import('../../private-equity/src/enterprise-obligations');
    const { readEnterpriseEconomicRecord, readEnterpriseEconomicHistory } = await import('../../private-equity/src/enterprise-economic-attribution');
    if (lineage.allocationRef.owner !== 'S5' || lineage.obligationRef.owner !== 'S6' || input.evidenceRef.owner !== 'S7' || lease.domain.rightsRef !== input.rightsRef)
        fault('S8_EFFECT_RECONCILIATION_OWNER_OR_RIGHTS');
    const issued = await readEnterpriseAllocation(ctx, lineage.allocationRef), original = issued.certificate.compute.usage.backend.capabilityLease;
    if (!original || !sameRef(original, lease) || digest(issued.problem) !== lease.inputDigest || issued.certificate.tenantId !== input.tenantId
        || issued.certificate.principalId !== input.principalId || issued.certificate.rightsRef !== input.rightsRef || !issued.reservation
        || lease.mode !== 'SHADOW' && issued.certificate.compute.actualRoute !== 'S8_ADMITTED_ALLOCATION_METHOD')
        fault('S8_EFFECT_NATIVE_ALLOCATION_USE_SUBSTITUTION');
    const allocation = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: input.tenantId, principalId: input.principalId }, lineage.allocationRef, { purpose: 'CONSUMER', rightsRef: input.rightsRef });
    if (allocation.protectionDomain !== input.protectionDomain)
        fault('S8_EFFECT_PROTECTION_DOMAIN_CHANGED');
    const obligation = await readEnterpriseDurableObligation(ctx, lineage.obligationRef);
    if (!sameRef(obligation.allocationRef, lineage.allocationRef) || !sameRef(obligation.reservationRef, issued.reservation.ref) || obligation.rightsRef !== input.rightsRef
        || !issued.certificate.policyBindings.some(p => sameRef(p.policyRef, obligation.policyRef)))
        fault('S8_EFFECT_NATIVE_OBLIGATION_SUBSTITUTION');
    const settlement = await readEnterpriseAllocationSettlement(ctx, { allocationRef: lineage.allocationRef, consumptionRef: obligation.consumptionRef, settlementEventId: lineage.settlementEventId });
    if (!sameRef(settlement.obligationRef, obligation.ref) || !sameRef(settlement.consumption.policyRef, obligation.policyRef)
        || !sameRef(settlement.consumption.decisionRef, obligation.decisionRef) || settlement.consumption.nodeId !== obligation.nodeId
        || !sameRef(settlement.consumption.envelope, obligation.resourceEnvelope))
        fault('S8_EFFECT_NATIVE_SETTLEMENT_SUBSTITUTION');
    const answer = await readOwnerTransportExecutionHandoff({ semanticOwner: 'S8', tenantId: input.tenantId, principalId: input.principalId }, obligation.ref.id), handoff = answer.handoff;
    const observed = handoff.settlements.find((row: any) => row.event.eventId === lineage.settlementEventId);
    if (!sameRef(handoff.obligation, obligation) || !observed || !sameRef(observed.event, settlement.event) || !sameRef(observed.receipt, settlement.receipt)
        || observed.event.detail.status !== 'VERIFIED')
        fault('S8_EFFECT_PROTECTED_HANDOFF_SUBSTITUTION');
    const read = await readEnterpriseEconomicRecord(ctx, { id: input.evidenceRef.id, protectedReadback: true });
    if (!('record' in read) || !read.protectedReadback || read.protectedReadback.protectionDomain !== input.protectionDomain
        || !sameRef(read.record.ref, input.evidenceRef) || !['EXPOSURE', 'MEASUREMENT'].includes(read.record.kind) || read.record.event.rightsRef !== input.rightsRef
        || !read.record.estimandId || Date.parse(read.record.knowledgeAt) < Date.parse(settlement.receipt.appendAt))
        fault('S8_EFFECT_NATIVE_S7_OUTCOME_REQUIRED');
    const record = OutcomeSchema.parse(read.record.payload.record);
    const candidateExposure = lease.mode !== 'SHADOW';
    if (record.outcome !== 'VERIFIED' || record.useId !== lease.useId || !sameRef(record.revisionRef, lease.revisionRef) || record.inputDigest !== lease.inputDigest
        || !sameRef(record.allocationRef, lineage.allocationRef) || !sameRef(record.obligationRef, obligation.ref)
        || record.settlementEventId !== lineage.settlementEventId || !sameRef(record.effectRef, obligation.effectRef) || record.candidateExposure !== candidateExposure
        || lease.canary && read.record.estimandId !== lease.canary.plan.estimandRef.id)
        fault('S8_EFFECT_S7_USE_OR_EXPOSURE_SUBSTITUTION');
    const refs = read.record.payload.sourceRefs as any[], sources = read.record.payload.sourceQualification as any[];
    if (!Array.isArray(refs) || !Array.isArray(sources) || [lineage.allocationRef, obligation.ref].some(ref => !refs.some(r => sameRef(r, ref))
        || !sources.some(s => sameRef(s.ref, ref) && s.status === 'RESOLVED_AUTHENTICATED' && s.signatureVerified === true)))
        fault('S8_EFFECT_S7_AUTHENTICATED_SOURCES_REQUIRED');
    const history = await readEnterpriseEconomicHistory(ctx, { estimandId: read.record.estimandId });
    if (!history.complete || !history.records.some(r => sameRef(r.ref, input.evidenceRef)))
        fault('S8_EFFECT_S7_HISTORY_INCOMPLETE');
    if (history.records.some(r => r.kind === 'INVALIDATION'))
        fault('S8_EFFECT_S7_EVIDENCE_INVALIDATED');
    return { schema: 'finnor.s8.qualified-use-effect-lineage.v1', useId: lease.useId, revisionRef: lease.revisionRef, inputDigest: lease.inputDigest,
        allocationRef: lineage.allocationRef, consumptionRef: obligation.consumptionRef, obligationRef: obligation.ref, effectRef: obligation.effectRef,
        evidenceRef: input.evidenceRef, settlementEventId: lineage.settlementEventId, settlementReceipt: settlement.receipt,
        exposure: candidateExposure ? 'CANDIDATE_DECISION_METHOD' : 'SHADOW_INCUMBENT_DECISION_METHOD', candidateExposure,
        horizon: 'H0', causalCreditGranted: false, economicCreditGranted: false, executionAuthorityGranted: false, liabilityBudgetReleased: false, ownerLossDispositionQualified: false,
        costs: settlement.costs, qualification: 'NATIVE_S5_S6_S7_ORIGINAL_USE_AND_PROTECTED_PHYSICAL_SETTLEMENT_ONLY_NO_CAUSAL_VALUE_OR_PROMOTION' };
}
/** A later adverse report preserves the original physical proof and liabilities. */
export async function verifyCapabilityAdverseOutcome(input: { tenantId: string; principalId: string; rightsRef: string; protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN'; lease: CapabilityUseLease; evidenceRef: CapabilityRef; outcome: string; priorLineage: any }) {
    const { readEnterpriseEconomicRecord } = await import('../../private-equity/src/enterprise-economic-attribution');
    const ctx: PeMutationContext = { auth: { tenantId: input.tenantId, userId: input.principalId, employeeId: input.principalId, role: 'owner' } };
    const read = await readEnterpriseEconomicRecord(ctx, { id: input.evidenceRef.id, protectedReadback: true });
    if (!('record' in read) || !read.protectedReadback || read.protectedReadback.protectionDomain !== input.protectionDomain || !sameRef(read.record.ref, input.evidenceRef)
        || !['EXPOSURE', 'MEASUREMENT'].includes(read.record.kind) || read.record.event.rightsRef !== input.rightsRef)
        fault('S8_EFFECT_NATIVE_S7_OUTCOME_REQUIRED');
    const record = OutcomeSchema.parse(read.record.payload.record), prior = input.priorLineage;
    if (record.outcome !== input.outcome || record.outcome === 'VERIFIED' || record.useId !== input.lease.useId || !sameRef(record.revisionRef, input.lease.revisionRef)
        || record.inputDigest !== input.lease.inputDigest || !sameRef(record.allocationRef, prior.allocationRef) || !sameRef(record.obligationRef, prior.obligationRef)
        || !sameRef(record.effectRef, prior.effectRef) || record.settlementEventId !== prior.settlementEventId || record.candidateExposure !== prior.candidateExposure
        || input.lease.canary && read.record.estimandId !== input.lease.canary.plan.estimandRef.id)
        fault('S8_EFFECT_S7_USE_OR_EXPOSURE_SUBSTITUTION');
    return { evidenceRef: input.evidenceRef, outcome: input.outcome, priorPhysicalEvidenceRetained: true, liabilityBudgetReleased: false, causalCreditGranted: false, economicCreditGranted: false };
}
