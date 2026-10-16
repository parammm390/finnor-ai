import type { AffineFamilySource, AtlasAffine, AtlasFacet, AtlasSplitReason } from '../../../shared-types/src/decision-atlas';
import { AtlasError, combine, constant, difference, negate, O, rational, scale, zeroAffine } from './exact';

export interface LoweredPolicy {
  id: string; payoffs: Map<string, AtlasAffine>;
  constraints: Array<AtlasFacet & { id: string; worldId: string; period: number }>;
  demands: Map<string, Map<string, AtlasAffine[]>>;
}
export interface LoweredModel { source: AffineFamilySource; policies: LoweredPolicy[] }
/** Preserve original period/cost/tail utility and one complete world throughout. */
export function lowerOriginal(source: AffineFamilySource): LoweredModel {
  const m = source.mandate, n = source.domain.parameters.length, h = m.horizon.periods;
  const policies: LoweredPolicy[] = source.policies.map(policy => {
    const result: LoweredPolicy = { id: policy.id, payoffs: new Map(), constraints: [], demands: new Map() };
    const row = (id: string, expression: AtlasAffine, worldId: string, period: number, relation: AtlasFacet['relation'] = 'LE') =>
      result.constraints.push({ id, expression, worldId, period, relation });
    for (const world of source.worlds) {
      const path = world.paths.find(path => path.policyId === policy.id)!, raw = new Map<string, AtlasAffine[]>();
      const ensure = (id: string) => {
        if (!raw.has(id)) raw.set(id, Array.from({ length: h + 1 }, () => zeroAffine(n)));
        return raw.get(id)!;
      };
      const spend = new Map(m.dimensions.map(d => [d.id, zeroAffine(n)])),
        occupancy = new Map(m.dimensions.map(d => [d.id, Array.from({ length: h + 1 }, () => zeroAffine(n))]));
      let value = zeroAffine(n), liability = constant(n, m.utility.terminalLiability), human = zeroAffine(n);
      if (m.funding.liabilityResourceId) ensure(m.funding.liabilityResourceId)[h] = liability;
      else if (rational(m.utility.terminalLiability).n !== 0n) throw new AtlasError('TAIL_FUNDING_UNRESOLVED');
      for (let t = 0; t < h; t++) {
        const node = policy.nodes.find(node => node.id === path.nodeIds[t])!, a = policy.actions.find(a => a.id === node.actionId)!;
        let periodUtility = zeroAffine(n);
        for (const term of m.utility.periodTerms)
          periodUtility = combine(periodUtility, path.states[t + 1]![term.variableId]!, rational(term.coefficient));
        value = combine(value, scale(difference(periodUtility, a.cost), rational(m.utility.discountFactors[t]!)));
        liability = combine(liability, a.tailLiability); human = combine(human, a.humanSeconds);
        row(`human:${world.id}:${t}`, difference(human, constant(n, m.maxHumanSeconds)), world.id, t);
        for (const [name, amount] of [['cost', a.cost], ['liability', a.tailLiability], ['human', a.humanSeconds]] as const)
          row(`nonnegative:${world.id}:${t}:${name}`, scale(amount, negate(O)), world.id, t);
        for (const d of m.dimensions) {
          row(`nonnegative:${world.id}:${t}:total:${d.id}`, scale(a.resources[d.id]!, negate(O)), world.id, t);
          row(`nonnegative:${world.id}:${t}:occupancy:${d.id}`, scale(a.occupancy[d.id]!, negate(O)), world.id, t);
          spend.set(d.id, combine(spend.get(d.id)!, a.resources[d.id]!));
          row(`total:${world.id}:${t}:${d.id}`, difference(spend.get(d.id)!, constant(n, d.totalLimit)), world.id, t);
          const occupied = occupancy.get(d.id)!;
          for (let k = t; k < Math.min(h + 1, t + a.occupationPeriods); k++)
            occupied[k] = combine(occupied[k]!, a.occupancy[d.id]!);
          const amounts = ensure(d.resourceId);
          if (d.component === 'TOTAL') amounts[t] = combine(amounts[t]!, a.resources[d.id]!);
          else for (let k = t; k < Math.min(h + 1, t + a.occupationPeriods); k++)
            amounts[k] = combine(amounts[k]!, a.occupancy[d.id]!);
          // No dimension component can silently disappear from its S5 binding.
          const omitted = d.component === 'TOTAL' ? a.occupancy[d.id]! : a.resources[d.id]!;
          if ([...omitted.a, omitted.b].some(v => rational(v).n !== 0n))
            throw new AtlasError('DUAL_COMPONENT_RESOURCE_BINDING_REQUIRED');
        }
        const fund = (id: string | null, amount: AtlasAffine, period: number, name: string) => {
          if (id) { const quantities = ensure(id); quantities[period] = combine(quantities[period]!, amount); }
          else if ([...amount.a, amount.b].some(v => rational(v).n !== 0n)) throw new AtlasError(`${name}_FUNDING_UNRESOLVED`);
        };
        fund(m.funding.costResourceId, a.cost, t, 'COST');
        fund(m.funding.liabilityResourceId, a.tailLiability, h, 'LIABILITY');
        fund(m.funding.humanResourceId, a.humanSeconds, t, 'HUMAN');
      }
      for (const d of m.dimensions) for (let t = 0; t <= h; t++)
        row(`capacity:${world.id}:${t}:${d.id}`, difference(occupancy.get(d.id)![t]!, constant(n, d.capacity)), world.id, t);
      for (const c of m.couplings) for (let t = 0; t <= h; t++) {
        let used = zeroAffine(n);
        for (const [id, weight] of Object.entries(c.weights)) {
          if (!occupancy.has(id)) throw new AtlasError('COUPLING_DIMENSION_UNRESOLVED');
          used = combine(used, occupancy.get(id)![t]!, rational(weight));
        }
        row(`coupling:${world.id}:${t}:${c.id}`, difference(used, constant(n, c.maxPerPeriod)), world.id, t);
      }
      let terminal = zeroAffine(n);
      for (const term of m.utility.terminalTerms)
        terminal = combine(terminal, path.states[h]![term.variableId]!, rational(term.coefficient));
      value = combine(value, scale(difference(terminal, liability), rational(m.utility.discountFactors[h]!)));
      result.payoffs.set(world.id, value); result.demands.set(world.id, raw);
      row(`risk:${world.id}`, difference(constant(n, m.minimumUtility), value), world.id, h);
    }
    for (const c of source.hardPredicates.filter(c => c.policyId === policy.id))
      row(`hard:${c.id}`, c.expression, c.worldId, c.period, c.relation);
    return result;
  });
  return { source, policies };
}
export function splitExpression(model: LoweredModel, reason: AtlasSplitReason): AtlasAffine {
  const policy = (id: string) => {
    const p = model.policies.find(p => p.id === id); if (!p) throw new AtlasError('SPLIT_ORIGINAL_POLICY'); return p;
  };
  const payoff = (id: string, world: string) => {
    const value = policy(id).payoffs.get(world); if (!value) throw new AtlasError('SPLIT_ORIGINAL_WORLD'); return value;
  };
  if (reason.kind === 'CONSTRAINT') {
    const constraint = policy(reason.policyId).constraints.find(c => c.id === reason.constraintId);
    if (!constraint) throw new AtlasError('SPLIT_ORIGINAL_CONSTRAINT'); return constraint.expression;
  }
  if (reason.kind === 'WORLD') return difference(payoff(reason.policyId, reason.leftWorldId), payoff(reason.policyId, reason.rightWorldId));
  return difference(payoff(reason.leftPolicyId, reason.leftWorldId), payoff(reason.rightPolicyId, reason.rightWorldId));
}
