/** Actual S7 owner-resolved learning bridge; never invents action rewards. */
import type { PeMutationContext } from '../../private-equity/src/types';
import { readEnterpriseEconomicLearningAssessment } from '../../private-equity/src/enterprise-economic-consumers';
import { readOwnerTransportExecutionHandoff } from '../../governed-execution/src/owner-transport';
import { digest, fault, AllocationMethodSchema, type CapabilityRef, type AllocationMethod, type CapabilityRevisionBody } from './contracts';
export async function readCapabilityEconomicExperience(ctx: PeMutationContext, input: {
    recordRef: CapabilityRef;
    knowledgeCut: string;
    requireProtected: boolean;
}) {
    const cut = Date.parse(input.knowledgeCut);
    if (!Number.isFinite(cut) || cut > Date.now())
        fault('S8_EXPERIENCE_KNOWLEDGE_CUT_INVALID');
    const learning = await readEnterpriseEconomicLearningAssessment(ctx, { assessmentId: input.recordRef.id, protectedReadback: input.requireProtected });
    if (digest(learning.assessmentRef) !== digest(input.recordRef))
        fault('S8_OWNER_ASSESSMENT_REFERENCE_SUBSTITUTION');
    const history = learning.history;
    if (!history || !history.complete)
        fault('S8_OWNER_HISTORY_INCOMPLETE');
    const visible = history.records.filter(r => Date.parse(r.knowledgeAt) <= cut), future = history.records.filter(r => Date.parse(r.knowledgeAt) > cut);
    if (!visible.some(r => r.ref.id === input.recordRef.id))
        fault('S8_ASSESSMENT_NOT_KNOWN_AT_CUT');
    // Later knowledge stays separately explicit; retrospective corrections never
    // replace the training view of an earlier assessment or admission wave.
    return { schema: 'finnor.s8.owner-experience-cut.v1', tenantId: ctx.auth.tenantId, principalId: ctx.auth.employeeId ?? ctx.auth.userId, knowledgeCut: input.knowledgeCut, assessmentRef: input.recordRef, refs: visible.map(r => r.ref), records: visible, cutDigest: digest(visible), futureKnowledgeExcluded: future.map(r => r.ref), newAdverseNoticeRefs: future.filter(r => ['COST', 'CORRECTION', 'VALUATION', 'INVALIDATION'].includes(r.kind)).map(r => r.ref), qualification: learning.qualification, protectedReadback: learning.protectedReadback, actionRewards: [], causalActionCreditsGranted: false, estimatorPromotionGranted: false, executionAuthorityGranted: false };
}
/** Refresh native owner history, not merely an immutable old reference. */
export async function assertCapabilityEconomicExperienceCurrent(ctx: PeMutationContext, revision: CapabilityRevisionBody) {
    const ref = revision.experience.ownerAssessmentRef;
    if (!ref || !revision.experience.historyCutDigest || ref.owner !== 'S7' || !revision.experience.refs.some(r => digest(r) === digest(ref)))
        fault('S8_NATIVE_HISTORY_CURRENTNESS_BINDING_REQUIRED');
    const cut = await readCapabilityEconomicExperience(ctx, { recordRef: ref, knowledgeCut: revision.experience.knowledgeCut, requireProtected: true });
    if (cut.cutDigest !== revision.experience.historyCutDigest || digest(cut.refs) !== digest(revision.experience.refs) || cut.records.some(r => r.event.rightsRef !== revision.domain.rightsRef))
        fault('S8_NATIVE_HISTORY_CUT_OR_RIGHTS_CHANGED');
    if (cut.newAdverseNoticeRefs.length)
        fault('S8_NATIVE_EXPERIENCE_REASSESSMENT_REQUIRED');
    return { current: true, historyCutDigest: cut.cutDigest, qualification: 'AUTHORIZED_NATIVE_S7_HISTORY_REFRESH_NO_CAUSAL_OR_EXECUTION_AUTHORITY' };
}
export async function readCapabilityExecutionExperience(ctx: PeMutationContext, obligationId: string) {
    return readOwnerTransportExecutionHandoff({ semanticOwner: 'S8', tenantId: ctx.auth.tenantId, principalId: ctx.auth.employeeId ?? ctx.auth.userId }, obligationId);
}
/** Finite untrusted candidate producer. Every generated variant must be charged
 * and evaluated by lifecycle callers; no candidate enters admission directly. */
export function generateAllocationSearchVariants(input: {
    cutDigest: string;
    observedLimitations: Array<{
        kind: 'SEARCH_EXHAUSTED' | 'HIGH_COST' | 'FORGETTING' | 'UNKNOWN_OUTCOME';
        evidenceRef: CapabilityRef;
    }>;
    maximumPolicies: number;
    maximumNodes: number;
    maximumCandidates: number;
}) {
    if (!/^[a-f0-9]{64}$/.test(input.cutDigest) || !Number.isInteger(input.maximumCandidates) || input.maximumCandidates < 1 || input.maximumCandidates > 8 || !input.observedLimitations.length)
        fault('S8_SEARCH_EXPERIENCE_OR_BUDGET_REQUIRED');
    const candidates: Array<{
        payload: AllocationMethod;
        experienceCutDigest: string;
        limitationRefs: CapabilityRef[];
        intendedImprovement: string;
    }> = [];
    const priority = input.observedLimitations.some(v => v.kind === 'SEARCH_EXHAUSTED' || v.kind === 'HIGH_COST') ? ['BRANCH_BOUND_EXACT', 'ENUMERATE_EXACT'] as const : ['ENUMERATE_EXACT', 'BRANCH_BOUND_EXACT'] as const;
    for (const algorithm of priority)
        for (const order of ['CANONICAL', 'VALUE_IMPACT'] as const)
            for (const incumbent of ['FIRST_FEASIBLE', 'EMPTY_THEN_SEARCH'] as const) {
                if (candidates.length >= input.maximumCandidates)
                    break;
                const payload: AllocationMethod = AllocationMethodSchema.parse({ schema: 'finnor.s8.allocation-method.v1', algorithm, order, incumbent, maxPolicies: input.maximumPolicies, maximumNodes: input.maximumNodes });
                candidates.push({ payload, experienceCutDigest: input.cutDigest, limitationRefs: input.observedLimitations.map(v => v.evidenceRef), intendedImprovement: algorithm === 'BRANCH_BOUND_EXACT' ? 'Reusable optimistic original-objective bounds and impact ordering for budgeted coupled allocation' : 'Exact finite enumeration comparator; no improvement assumed' });
            }
    return { candidates, untrusted: true, admissionGranted: false, failedAndUnknownExperienceRetained: input.observedLimitations };
}
