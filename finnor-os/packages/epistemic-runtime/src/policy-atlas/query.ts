import type { AffineFamilySource, AtlasCellLabel, AtlasProposal, AtlasQueryDisposition, AtlasRational } from '../../../shared-types/src/decision-atlas';
import { domainFacets, parseAffineFamilySource } from './contracts';
import { AtlasError, atlasHash, encode, evaluate, holds, rational, sign } from './exact';
import { lowerOriginal } from './model';

export interface AtlasPointResult {
  disposition: AtlasQueryDisposition; cellId: string | null; label: AtlasCellLabel | null; value: AtlasRational | null;
  costs: { wallMs: number; membershipPredicates: number; fullFamilyEvaluations: number };
}
/** A checked immutable receipt is required by the owner before calling lookup. */
export function lookupAtlas(source: AffineFamilySource, atlas: AtlasProposal, values: string[]): AtlasPointResult {
  const started = performance.now(), point = values.map(v => rational(v, 256));
  if (values.length !== source.domain.parameters.length) throw new AtlasError('PARAMETER_DIMENSION_MISMATCH');
  const result = (disposition: AtlasQueryDisposition, cellId: string | null, label: AtlasCellLabel | null, predicates: number): AtlasPointResult =>
    ({ disposition, cellId, label, value: label?.value ? encode(evaluate(label.value, point)) : null,
      costs: { wallMs: performance.now() - started, membershipPredicates: predicates, fullFamilyEvaluations: 0 } });
  if (atlas.inputDigest !== atlasHash(source) || atlas.boundaryRule !== 'NEGATIVE_ZERO_POSITIVE_EXACT') throw new AtlasError('ATLAS_INPUT_BINDING');
  const domain = domainFacets(source.domain);
  if (!domain.every(f => holds(f, point))) return result('OUTSIDE_DOMAIN', null, null, domain.length);
  const nodes = new Map(atlas.nodes.map(node => [node.id, node]));
  let current = atlas.root, count = domain.length; const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) throw new AtlasError('COVERAGE_CYCLE'); seen.add(current);
    const node = nodes.get(current); if (!node) throw new AtlasError('COVERAGE_CHILD_MISSING');
    if (node.kind === 'GAP') return result('GAP', node.id, null, count);
    if (node.kind === 'EMPTY') throw new AtlasError('CHECKED_EMPTY_QUERY_CONTRADICTION');
    if (node.kind === 'CELL') return result(node.label.winnerPolicyId ? 'COVERED' : 'NAMED_FAMILY_INFEASIBLE', node.id, node.label, count);
    const s = sign(evaluate(node.expression, point)); count++;
    current = s < 0 ? node.negative : s > 0 ? node.positive : node.zero;
  }
}
export function evaluateFiniteFamily(value: unknown, values: string[], extraFeasibility: ReadonlySet<string> | null = null): AtlasPointResult {
  const started = performance.now(), source = parseAffineFamilySource(value), point = values.map(v => rational(v, 256));
  if (point.length !== source.domain.parameters.length) throw new AtlasError('PARAMETER_DIMENSION_MISMATCH');
  const model = lowerOriginal(source), statuses: AtlasCellLabel['policies'] = [], candidates: Array<{ id: string; world: string; value: string }> = [];
  for (const p of model.policies) {
    const violated = p.constraints.find(c => !holds(c, point));
    const feasible = !violated && (extraFeasibility === null || extraFeasibility.has(p.id));
    if (!feasible) { statuses.push({ policyId: p.id, feasible: false, violatedConstraintId: violated?.id ?? 'CURRENT_S5', worstWorldIds: [], bindingConstraintIds: [] }); continue; }
    const entries = [...p.payoffs], world = entries.reduce((a, b) => evaluate(a[1], point).compare(evaluate(b[1], point)) <= 0 ? a : b),
      minimum = evaluate(world[1], point), active = entries.filter(([, f]) => evaluate(f, point).compare(minimum) === 0).map(([id]) => id);
    statuses.push({ policyId: p.id, feasible: true, violatedConstraintId: null, worstWorldIds: active,
      bindingConstraintIds: p.constraints.filter(c => evaluate(c.expression, point).n === 0n).map(c => c.id) });
    candidates.push({ id: p.id, world: world[0], value: encode(minimum) });
  }
  const best = candidates.length ? candidates.reduce((a, b) => rational(a.value).compare(rational(b.value)) >= 0 ? a : b) : null,
    ties = source.tieOrder.filter(id => candidates.some(p => p.id === id && p.value === best?.value)),
    winner = candidates.find(p => p.id === ties[0]), label: AtlasCellLabel = { policies: statuses, winnerPolicyId: winner?.id ?? null,
      tiedPolicyIds: ties, value: winner ? model.policies.find(p => p.id === winner.id)!.payoffs.get(winner.world)! : null,
      disposition: winner ? 'NAMED_FAMILY_OPTIMUM' : 'NAMED_FAMILY_INFEASIBLE' };
  return { disposition: winner ? 'FULL_FAMILY_CHECKED' : 'NAMED_FAMILY_INFEASIBLE', cellId: null, label, value: winner?.value ?? null,
    costs: { wallMs: performance.now() - started, membershipPredicates: 0, fullFamilyEvaluations: model.policies.length } };
}
