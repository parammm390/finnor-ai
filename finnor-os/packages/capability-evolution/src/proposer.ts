/** Native S8 producer; S7 owns the history and S5 owns current allocation. */
import type { PeMutationContext } from '../../private-equity/src/types';
import { readEnterpriseAllocation, validateEnterpriseAllocation } from '../../private-equity/src/enterprise-allocation';
import { readCapabilityEconomicExperience, generateAllocationSearchVariants } from './experience';
import { RevisionBodySchema, parseRevision, makeRef, digest, fault, type CapabilityRevisionBody, type CapabilityRef } from './contracts';
type Limitation = {
    kind: 'SEARCH_EXHAUSTED' | 'HIGH_COST' | 'FORGETTING' | 'UNKNOWN_OUTCOME';
    evidenceRef: CapabilityRef;
};
export async function prepareNativeCapabilityRevisions(ctx: PeMutationContext, input: {
    template: CapabilityRevisionBody;
    assessmentRef: CapabilityRef;
    limitations: Limitation[];
    maximumCandidates: number;
}) {
    const t = RevisionBodySchema.parse(input.template), principal = ctx.auth.employeeId ?? ctx.auth.userId;
    if (t.tenantId !== ctx.auth.tenantId || t.principalId !== principal || Date.parse(t.proposedAt) > Date.now())
        fault('S8_NATIVE_PROPOSER_IDENTITY');
    const history = await readCapabilityEconomicExperience(ctx, { recordRef: input.assessmentRef, knowledgeCut: t.experience.knowledgeCut, requireProtected: true });
    if (history.refs.length > 256 || !history.refs.length || history.records.some(record => record.event.rightsRef !== t.domain.rightsRef))
        fault('S8_NATIVE_HISTORY_RIGHTS_OR_RETENTION_BOUND');
    for (const limitation of input.limitations)
        if (!history.refs.some(ref => digest(ref) === digest(limitation.evidenceRef)))
            fault('S8_LIMITATION_OUTSIDE_OWNER_HISTORY');
    const ownerGroups = history.records.flatMap(record => ((record.payload.estimand as {
        clusters?: Array<{
            id: string;
        }>;
    } | undefined)?.clusters ?? []).map((cluster: any) => String(cluster.id)));
    const dependenceGroups = [...new Set([...t.experience.dependenceGroups, ...ownerGroups])];
    if (dependenceGroups.length > 4096)
        fault('S8_NATIVE_HISTORY_DEPENDENCE_BOUND');
    const proposals = generateAllocationSearchVariants({ cutDigest: history.cutDigest, observedLimitations: input.limitations, maximumPolicies: t.domain.maxPolicies, maximumNodes: t.envelope.maxNodes, maximumCandidates: input.maximumCandidates });
    const revisions = proposals.candidates.map(candidate => {
        const body = { ...t, payload: candidate.payload, experience: { ...t.experience, refs: history.refs, dependenceGroups, ownerAssessmentRef: input.assessmentRef, historyCutDigest: history.cutDigest }, intendedImprovement: candidate.intendedImprovement };
        return parseRevision({ ...body, ref: makeRef('capability-revision', body) });
    });
    return { revisions, history, limitations: proposals.failedAndUnknownExperienceRetained, qualification: 'COMPLETE_NATIVE_OWNER_KNOWLEDGE_CUT_NO_CAUSAL_ACTION_REWARDS', companyPopulationQualification: 'OWNER_CLUSTER_IDS_RETAINED_COMPANY_MAPPING_REQUIRES_INDEPENDENT_SOURCE_AUTHORITY', admissionGranted: false, executionAuthorityGranted: false };
}
export async function readNativeCapabilitySearchAllocation(ctx: PeMutationContext, allocationRef: CapabilityRef) {
    const validation = await validateEnterpriseAllocation(ctx, allocationRef);
    if (validation.status !== 'CURRENT' || !validation.conditionalClearance)
        fault('S8_NATIVE_ALLOCATION_NOT_CURRENT');
    const issued = await readEnterpriseAllocation(ctx, allocationRef);
    return { allocationRef: issued.certificate.ref, problemRef: issued.problem.ref, validation, reservationRef: issued.reservation?.ref ?? null, qualification: 'CURRENT_NATIVE_S5_ORDINARY_CLEARANCE_NO_PROTECTED_SEARCH_OR_EFFECT_AUTHORITY' };
}
