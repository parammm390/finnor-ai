/** Independent-authority evaluation reasoning outside Ring-0. */
import { z } from 'zod';
import { digest, fault, makeRef, ProtocolSchema, LifecycleCostSchema, type EvaluationProtocol, type EvaluationSummary, type LifecycleCost } from './contracts';
const MetricsSchema = z.object({ correctness: z.number().min(0).max(1), regret: z.number().min(0), calibrationError: z.number().min(0), safetyViolations: z.number().int().min(0), episodeCost: z.number().min(0).nullable(), humanSeconds: z.number().min(0), decisionValue: z.tuple([z.number().finite(), z.number().finite()]).refine(([a, b]) => a <= b) }).strict();
export const AdmissionCaseSchema = z.object({ id: z.string(), company: z.string(), dependenceGroup: z.string(), knowledgeAt: z.string().datetime({ offset: true }), stratum: z.string(), priorDomain: z.string().nullable(), problem: z.unknown(), reference: z.object({ oracleDigest: z.string().regex(/^[a-f0-9]{64}$/), optimum: z.string().nullable(), metrics: MetricsSchema, baselineMetrics: z.record(MetricsSchema) }).strict() }).strict();
export type AdmissionCase = z.infer<typeof AdmissionCaseSchema>;
export interface ScoredCase {
    caseCommitment: string;
    company: string;
    dependenceGroup: string;
    stratum: string;
    priorDomain: string | null;
    candidate: z.infer<typeof MetricsSchema>;
    baselines: Record<string, z.infer<typeof MetricsSchema>>;
    failure: string | null;
}
const costKeys = ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment'] as const;
export function summarizeAdmission(protocolInput: EvaluationProtocol, rows: ScoredCase[], costInput: LifecycleCost, attemptsDigest: string, failedCandidates: number): EvaluationSummary {
    const p = ProtocolSchema.parse(protocolInput), costs = LifecycleCostSchema.parse(costInput), reasons: string[] = [];
    if (rows.length !== p.caseCommitments.length || new Set(rows.map(r => r.caseCommitment)).size !== rows.length || rows.some(r => !p.caseCommitments.includes(r.caseCommitment) || !p.companies.includes(r.company) || !p.dependenceGroups.includes(r.dependenceGroup) || !p.strata.includes(r.stratum)))
        fault('S8_EVALUATOR_CASE_MANIFEST_MISMATCH');
    if (new Set(rows.map(r => r.dependenceGroup)).size < p.minIndependentGroups || p.strata.some(s => !rows.some(r => r.stratum === s)) || p.priorDomains.some(d => !rows.some(r => r.priorDomain === d)))
        fault('S8_EVALUATOR_MISSING_REGISTERED_STRATUM');
    const companyGroups = new Map<string, string>();
    for (const row of rows) {
        const prior = companyGroups.get(row.company);
        if (prior && prior !== row.dependenceGroup)
            fault('S8_EVALUATOR_COMPANY_SPLIT_ACROSS_DEPENDENCE_GROUPS');
        companyGroups.set(row.company, row.dependenceGroup);
    }
    const unknownCost = costKeys.some(k => costs[k] === null) || costs.basis === 'UNKNOWN';
    if (unknownCost)
        reasons.push('COMPLETE_LIFECYCLE_COST_UNKNOWN');
    // All lifecycle costs are incurred once in this registered cohort. No projected
    // reuse denominator and no inference-speed label masquerades as decision gain.
    const costLow = costKeys.reduce((v, k) => v + (costs[k]?.[0] ?? 0), 0), costHigh = costKeys.reduce((v, k) => v + (costs[k]?.[1] ?? 0), 0);
    const floor = (m: z.infer<typeof MetricsSchema>) => m.correctness >= p.floors.correctness && m.regret <= p.floors.regret && m.calibrationError <= p.floors.calibrationError && m.safetyViolations === 0 && m.episodeCost !== null && m.episodeCost <= p.floors.maxEpisodeCost && m.humanSeconds <= p.floors.maxHumanSeconds;
    let allFloorsPassed = true, priorDomainsPassed = true;
    for (const r of rows) {
        MetricsSchema.parse(r.candidate);
        if (r.failure || !floor(r.candidate)) {
            allFloorsPassed = false;
            reasons.push('FLOOR_OR_FAILURE:' + r.stratum);
            if (r.priorDomain)
                priorDomainsPassed = false;
        }
        for (const b of p.baselines) {
            if (!r.baselines[b.id])
                fault('S8_EVALUATOR_BASELINE_MISSING');
            MetricsSchema.parse(r.baselines[b.id]);
        }
    }
    // Equal-weight dependence groups: repeated episodes from one company/cluster
    // never create artificial sample size. Freeze group membership before outputs.
    // Each endpoint receives the frozen simultaneous error budget. Conditional
    // on fresh independent groups, a bounded difference in [-R,R] has this
    // two-sided Hoeffding radius. Freshness/independence are data-authority
    // assumptions, not facts established by labels or this arithmetic.
    const cohorts = [rows, ...p.strata.map(s => rows.filter(r => r.stratum === s)), ...p.priorDomains.map(d => rows.filter(r => r.priorDomain === d))];
    const endpoints = p.baselines.length * cohorts.length, alpha = (1 - p.confidence) / (p.maxSubmissions * p.maxWaves * endpoints);
    let lower = Infinity, upper = Infinity;
    for (const cohort of cohorts)
        for (const baseline of p.baselines) {
            const groups = [...new Set(cohort.map(r => r.dependenceGroup))];
            const deltas = groups.map(g => { const cluster = cohort.filter(r => r.dependenceGroup === g); return [cluster.reduce((v, r) => v + r.candidate.decisionValue[0] - r.baselines[baseline.id]!.decisionValue[1], 0) / cluster.length, cluster.reduce((v, r) => v + r.candidate.decisionValue[1] - r.baselines[baseline.id]!.decisionValue[0], 0) / cluster.length] as const; });
            if (deltas.some(d => Math.abs(d[0]) > p.scoreRange || Math.abs(d[1]) > p.scoreRange))
                fault('S8_EVALUATOR_SCORE_SUPPORT_EXCEEDED');
            const radius = 2 * p.scoreRange * Math.sqrt(Math.log(2 / alpha) / (2 * groups.length));
            lower = Math.min(lower, deltas.reduce((v, d) => v + d[0], 0) / groups.length - radius - costHigh);
            upper = Math.min(upper, deltas.reduce((v, d) => v + d[1], 0) / groups.length + radius - costLow);
        }
    if (!allFloorsPassed)
        reasons.push('REGISTERED_FLOOR_FAILED');
    if (!priorDomainsPassed)
        reasons.push('FORGETTING_OR_PRIOR_DOMAIN_FAILURE');
    const gain = unknownCost ? null : [lower, upper] as [
        number,
        number
    ];
    const disposition = !allFloorsPassed || !priorDomainsPassed ? 'REJECTED' : gain && gain[1] < 0 ? 'HARMFUL' : gain && gain[0] >= p.materialGain ? 'BENEFICIAL' : 'INCONCLUSIVE';
    if (disposition === 'INCONCLUSIVE')
        reasons.push('NO_SELECTION_ADJUSTED_MATERIAL_FUTURE_GAIN');
    // This scorer compares finite reference-model decisions. Observed bills can
    // complete cost accounting; they cannot establish prospective field provenance.
    return { schema: 'finnor.s8.evaluation-summary.v1', protocolRef: makeRef('evaluation-protocol', p), revisionRef: p.revisionRef, evaluatorId: p.evaluatorId, completedAt: new Date().toISOString(), disposition, gain, allFloorsPassed, priorDomainsPassed, costs, failedCandidates, attemptsDigest, resultsCommitment: digest(rows), classification: gain ? 'PROBABILISTICALLY_SUPPORTED' : 'PARTIAL', qualification: 'GENERATIVE_H1', reasons: [...new Set(reasons)] };
}
