/** Evolvable finite search outside Ring-0. Original S5 checker retains authority. */
import type { CanonicalAllocationProblem } from '@finnor/shared-types';
import { verifyCanonicalAllocation } from '../../epistemic-runtime/src/allocation-checker';
import { allocationDerivedQuantity as quantity, assertAllocationProblem } from '../../epistemic-runtime/src/allocation-contracts';
import { ExperimentRational, ER_ZERO } from '../../epistemic-runtime/src/experiment-numerics';
import { AllocationMethodSchema, digest, fault, type AllocationMethod } from './contracts';
export type S8AllocationMethod = AllocationMethod;
export const parseAllocationMethod = (v: unknown) => AllocationMethodSchema.parse(v);
export const allocationMethodDigest = (v: AllocationMethod) => digest(parseAllocationMethod(v));
export function runAllocationMethod(problem: CanonicalAllocationProblem, payload: AllocationMethod, options: {
    deadlineAt: number;
    maxExpansions: number;
}) {
    assertAllocationProblem(problem);
    const method = parseAllocationMethod(payload), start = performance.now(), cpu = process.cpuUsage(), ids = problem.policies.map(p => p.ref.id).sort();
    if (ids.length > method.maxPolicies || ids.length > 20)
        fault('METHOD_DOMAIN_POLICY_BOUND');
    if (!Number.isFinite(options.deadlineAt) || !Number.isSafeInteger(options.maxExpansions) || options.maxExpansions < 1)
        fault('METHOD_RESOURCE_BOUND');
    if (method.order === 'VALUE_IMPACT')
        ids.sort((a, b) => {
            const impact = (id: string) => problem.jointModel.scenarios.flatMap(s => s.terms).filter(t => t.policyIds.includes(id)).reduce((v, t) => v.add(quantity(t.value).n < 0n ? quantity(t.value).mul(new ExperimentRational(-1n)) : quantity(t.value)), ER_ZERO);
            return impact(b).compare(impact(a)) || a.localeCompare(b);
        });
    const bound = Math.min(method.maximumNodes, options.maxExpansions), selected = new Set<string>();
    let nodes = 0, leaves = 0, pruned = 0, exhausted = false;
    let best: string[] | null = null, bestValue: ExperimentRational | null = null;
    const consider = () => {
        leaves++;
        const check = verifyCanonicalAllocation(problem, [...selected]);
        if (check.feasible && check.objective !== null) {
            const v = quantity(check.objective);
            if (bestValue === null || v.compare(bestValue) > 0 || (v.compare(bestValue) === 0 && JSON.stringify(check.selectedPolicyIds) < JSON.stringify(best))) {
                bestValue = v;
                best = check.selectedPolicyIds;
            }
        }
    };
    if (method.incumbent === 'EMPTY_THEN_SEARCH')
        consider();
    const upper = (depth: number) => {
        const undecided = new Set(ids.slice(depth));
        return problem.jointModel.scenarios.map(s => s.terms.reduce((v, t) => {
            if (t.policyIds.some(id => !selected.has(id) && !undecided.has(id)))
                return v;
            const q = quantity(t.value);
            return t.policyIds.every(id => selected.has(id)) || q.n > 0n ? v.add(q) : v;
        }, quantity(s.baseValue))).reduce((a, b) => a.compare(b) < 0 ? a : b);
    };
    const visit = (depth: number): void => {
        if (nodes >= bound || performance.now() >= options.deadlineAt) {
            exhausted = true;
            return;
        }
        nodes++;
        // Signed/negative constraints cannot justify partial infeasibility pruning.
        // Only an optimistic original-objective bound prunes; every leaf is checked.
        if (method.algorithm === 'BRANCH_BOUND_EXACT' && bestValue !== null && upper(depth).compare(bestValue) < 0) {
            pruned++;
            return;
        }
        if (depth === ids.length) {
            consider();
            return;
        }
        const id = ids[depth]!;
        selected.add(id);
        visit(depth + 1);
        selected.delete(id);
        if (!exhausted)
            visit(depth + 1);
    };
    visit(0);
    const check = best === null ? null : verifyCanonicalAllocation(problem, best), usage = process.cpuUsage(cpu);
    return { schema: 'finnor.s8.allocation-search-result.v1', methodDigest: allocationMethodDigest(method), problemRef: problem.ref, selectedPolicyIds: best, objective: check?.objective ?? null, check, complete: !exhausted, status: exhausted ? 'SEARCH_EXHAUSTED' : best === null ? 'INFEASIBLE' : 'FEASIBLE', upperBound: !exhausted ? check?.objective ?? null : null, nodes, leaves, pruned, usage: { elapsedMs: performance.now() - start, cpuUserMicros: usage.user, cpuSystemMicros: usage.system, rssBytes: process.memoryUsage().rss }, cost: { money: null, status: 'LOCAL_COST_UNMETERED' }, executionAuthorityGranted: false as const };
}
