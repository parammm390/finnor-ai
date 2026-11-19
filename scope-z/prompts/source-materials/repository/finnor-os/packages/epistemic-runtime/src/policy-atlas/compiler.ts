import type { AtlasBuildBudget, AtlasCellLabel, AtlasFacet, AtlasGeometry, AtlasProposal, AtlasSplitReason, AtlasTreeNode } from '../../../shared-types/src/decision-atlas';
import { AtlasBudgetSchema, DEFAULT_ATLAS_BUDGET, domainFacets, parseAffineFamilySource } from './contracts';
import { AtlasError, atlasHash, canonical, difference, evaluate, rational } from './exact';
import { cellSign, geometry, GeometryMeter, splitFacets } from './geometry';
import { lowerOriginal, splitExpression, type LoweredModel } from './model';

type Resolution = { kind: 'LABEL'; label: AtlasCellLabel } | { kind: 'SPLIT'; reason: AtlasSplitReason };
function resolveLabel(model: LoweredModel, facets: AtlasFacet[], cell: AtlasGeometry, meter: GeometryMeter): Resolution {
  const point = cell.witness.map(v => rational(v)), statuses: AtlasCellLabel['policies'] = [];
  const feasible: Array<{ id: string; world: string }> = [];
  for (const p of model.policies) {
    let violation: string | null = null, unsettled: AtlasSplitReason | null = null;
    const binding: string[] = [];
    for (const c of p.constraints) {
      const s = cellSign(c.expression, facets, cell, meter);
      if (s === 'SPLIT') { unsettled ??= { kind: 'CONSTRAINT', policyId: p.id, constraintId: c.id }; continue; }
      const valid = c.relation === 'EQ' ? s === 0 : c.relation === 'LT' ? s === -1 : s !== 1;
      if (!valid) { violation = c.id; break; }
      if (s === 0) binding.push(c.id);
    }
    if (violation) { statuses.push({ policyId: p.id, feasible: false, violatedConstraintId: violation, worstWorldIds: [], bindingConstraintIds: [] }); continue; }
    if (unsettled) return { kind: 'SPLIT', reason: unsettled };
    const worlds = [...p.payoffs.keys()];
    const candidate = worlds.reduce((a, b) => evaluate(p.payoffs.get(a)!, point).compare(evaluate(p.payoffs.get(b)!, point)) <= 0 ? a : b);
    const active: string[] = [];
    for (const other of worlds) {
      const s = cellSign(difference(p.payoffs.get(candidate)!, p.payoffs.get(other)!), facets, cell, meter);
      if (s === 'SPLIT') return { kind: 'SPLIT', reason: { kind: 'WORLD', policyId: p.id, leftWorldId: candidate, rightWorldId: other } };
      if (s === 1) throw new AtlasError('WORST_WORLD_PROPOSAL_CONTRADICTION');
      if (s === 0) active.push(other);
    }
    statuses.push({ policyId: p.id, feasible: true, violatedConstraintId: null, worstWorldIds: active, bindingConstraintIds: binding });
    feasible.push({ id: p.id, world: candidate });
  }
  if (!feasible.length) return { kind: 'LABEL', label: { policies: statuses, winnerPolicyId: null, tiedPolicyIds: [], value: null, disposition: 'NAMED_FAMILY_INFEASIBLE' } };
  const value = (p: typeof feasible[number]) => model.policies.find(v => v.id === p.id)!.payoffs.get(p.world)!;
  const candidate = feasible.reduce((a, b) => evaluate(value(a), point).compare(evaluate(value(b), point)) >= 0 ? a : b), tied = new Set<string>();
  for (const other of feasible) {
    const s = cellSign(difference(value(candidate), value(other)), facets, cell, meter);
    if (s === 'SPLIT') return { kind: 'SPLIT', reason: { kind: 'RANKING', leftPolicyId: candidate.id, leftWorldId: candidate.world, rightPolicyId: other.id, rightWorldId: other.world } };
    if (s === -1) throw new AtlasError('WINNER_PROPOSAL_CONTRADICTION');
    if (s === 0) tied.add(other.id);
  }
  const ties = model.source.tieOrder.filter(id => tied.has(id)), winner = feasible.find(p => p.id === ties[0])!;
  return { kind: 'LABEL', label: { policies: statuses, winnerPolicyId: winner.id, tiedPolicyIds: ties, value: value(winner), disposition: 'NAMED_FAMILY_OPTIMUM' } };
}
/** All frontier leaves are present before work starts. Limits cannot erase them. */
export function compilePolicyAtlas(value: unknown, checkerDigest: string, suppliedBudget: AtlasBuildBudget = DEFAULT_ATLAS_BUDGET): AtlasProposal {
  const started = performance.now(), source = parseAffineFamilySource(value), budget = AtlasBudgetSchema.parse(suppliedBudget),
    meter = new GeometryMeter(budget), model = lowerOriginal(source), domain = domainFacets(source.domain);
  const rootGeometry = geometry(domain, source.domain.parameters.length, meter);
  if (!rootGeometry) throw new AtlasError('DOMAIN_EMPTY');
  const nodes: AtlasTreeNode[] = [{ id: 'n0', kind: 'GAP', reason: 'UNEXPLORED' }],
    frontier = [{ index: 0, facets: domain, depth: 0, known: rootGeometry as AtlasGeometry | null }]; let exhausted: string | null = null, evaluations = 0;
  while (frontier.length) {
    const task = frontier.pop()!, id = nodes[task.index]!.id;
    if (exhausted) { nodes[task.index] = { id, kind: 'GAP', reason: exhausted }; continue; }
    try {
      const cell = task.known ?? geometry(task.facets, source.domain.parameters.length, meter);
      if (!cell) { nodes[task.index] = { id, kind: 'EMPTY' }; continue; }
      const resolved = resolveLabel(model, task.facets, cell, meter); evaluations += model.policies.length;
      if (resolved.kind === 'LABEL') {
        nodes[task.index] = { id, kind: 'CELL', geometry: cell, label: resolved.label };
        if (Buffer.byteLength(canonical(nodes)) > budget.maxBytes / 2) nodes[task.index] = { id, kind: 'GAP', reason: 'CERTIFICATE_BYTE_LIMIT' };
        continue;
      }
      if (nodes.length + 3 > budget.maxNodes || task.depth >= budget.maxDepth) {
        nodes[task.index] = { id, kind: 'GAP', reason: 'PARTITION_NODE_OR_DEPTH_LIMIT' }; continue;
      }
      const facets = splitFacets(splitExpression(model, resolved.reason)), first = nodes.length,
        ids = [first, first + 1, first + 2].map(i => 'n' + i);
      nodes[task.index] = { id, kind: 'SPLIT', reason: resolved.reason, expression: splitExpression(model, resolved.reason),
        negative: ids[0]!, zero: ids[1]!, positive: ids[2]! };
      for (let i = 0; i < 3; i++) {
        nodes.push({ id: ids[i]!, kind: 'GAP', reason: 'UNEXPLORED' });
        frontier.push({ index: first + i, facets: [...task.facets, facets[i]!], depth: task.depth + 1, known: null });
      }
    } catch (error) {
      if (!(error instanceof AtlasError) || !/LIMIT|DEADLINE/.test(error.code)) throw error;
      exhausted = error.code; nodes[task.index] = { id, kind: 'GAP', reason: error.code };
    }
  }
  const cells = nodes.filter(node => node.kind === 'CELL').length, gaps = nodes.filter(node => node.kind === 'GAP').length;
  const result: AtlasProposal = { schema: 'finnor.decision-atlas.proposal.v1', inputDigest: atlasHash(source), checkerDigest,
    root: 'n0', nodes, coverage: gaps ? 'PARTIAL' : 'COMPLETE', boundaryRule: 'NEGATIVE_ZERO_POSITIVE_EXACT', budget,
    costs: { wallMs: performance.now() - started, bases: meter.bases, policyEvaluations: evaluations, cells, gaps } };
  if (Buffer.byteLength(canonical(result)) > budget.maxBytes) throw new AtlasError('OUTPUT_BYTE_LIMIT');
  return result;
}
