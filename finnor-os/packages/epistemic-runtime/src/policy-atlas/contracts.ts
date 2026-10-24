import { z } from 'zod';
import type { AffineFamilySource, AtlasBuildBudget, AtlasDomain, AtlasFacet } from '../../../shared-types/src/decision-atlas';
import { AtlasError, atlasHash, rational, zeroAffine } from './exact';

export const R7_VERSION = 'r7-exact-affine-v1' as const;
export const DEFAULT_ATLAS_BUDGET: AtlasBuildBudget = Object.freeze({
  maxNodes: 1024, maxDepth: 256, maxFacets: 256, maxBases: 200000, maxTotalBases: 2000000,
  maxBytes: 33554432, deadlineMs: 30000,
});
const text = z.string().min(1).max(256), id = text.regex(/^[A-Za-z][A-Za-z0-9:_-]*$/);
const q = z.string().max(170).superRefine((v, ctx) => {
  try { rational(v, 256); } catch { ctx.addIssue({ code: 'custom', message: 'Canonical 256-bit rational required' }); }
});
const date = z.string().datetime({ offset: true });
export const AtlasRefSchema = z.object({ owner: text, id: z.string().min(1).max(4096), version: text,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const affine = z.object({ a: z.array(q).min(1).max(4), b: q }).strict();
const facet = z.object({ expression: affine, relation: z.enum(['LE', 'LT', 'EQ']) }).strict();
const observation = z.object({ instrumentId: text, token: z.string().min(1).max(4096), availablePeriod: z.number().int().min(0).max(12) }).strict();
const parameter = z.object({ id, unit: text, currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  owner: z.enum(['BUSINESS_OWNER', 'S5']), valueSource: z.enum(['AUTHENTICATED_OWNER_REVISION', 'CURRENT_S5_AVAILABLE']),
  resourceId: text.nullable(), resourcePeriod: z.number().int().min(0).max(12).nullable(), lower: q, upper: q }).strict();
const terms = z.array(z.object({ variableId: id, unit: text, coefficient: q, coefficientUnit: text }).strict()).max(32);
const mandate = z.object({
  ref: AtlasRefSchema, schema: z.literal('finnor.economic-mandate.exact-affine.v1'), tenantId: z.string().uuid(),
  principalId: z.string().uuid(), episodeId: text, rightsRef: text, knowledgeAt: date, validUntil: date,
  businessOwnerRef: AtlasRefSchema, utilityRef: AtlasRefSchema, accountingConventionRef: AtlasRefSchema,
  horizon: z.object({ startAt: date, periodMs: z.number().int().positive().max(31536000000), periods: z.number().int().min(1).max(12) }).strict(),
  quantityBasis: z.object({ unit: text, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), ownershipRef: AtlasRefSchema,
    valuationAt: date, discountBasisRef: AtlasRefSchema }).strict(),
  utility: z.object({ periodTerms: terms, terminalTerms: terms, discountFactors: z.array(q).min(2).max(13), terminalLiability: q }).strict(),
  minimumUtility: q, maxHumanSeconds: q,
  dimensions: z.array(z.object({ id, unit: text, resourceClass: z.enum(['CASH', 'BORROWING_HEADROOM', 'COMMITTED_CAPITAL',
    'OPERATIONAL_CAPACITY', 'HUMAN_ATTENTION', 'COMPUTE', 'INQUIRY_EXPOSURE', 'COUNTERPARTY_EXPOSURE', 'OTHER_RESTRICTED']),
    capacity: q, totalLimit: q, resourceId: text, component: z.enum(['TOTAL', 'OCCUPANCY']) }).strict()).max(16),
  couplings: z.array(z.object({ id, weights: z.record(z.string(), q), maxPerPeriod: q }).strict()).max(16),
  funding: z.object({ costResourceId: text.nullable(), liabilityResourceId: text.nullable(), humanResourceId: text.nullable() }).strict(),
  ambiguity: z.literal('ROBUST_FIXED_COMPLETE_WORLDS_NO_PROBABILITIES'),
  authorization: z.literal('AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'),
}).strict();
const action = z.object({
  id, kind: z.enum(['INQUIRE', 'INTERVENE', 'WAIT', 'STOP']), cost: affine, costUnit: text,
  tailLiability: affine, humanSeconds: affine, resources: z.record(z.string(), affine), occupancy: z.record(z.string(), affine),
  exposures: z.record(z.string(), z.object({ unit: text, doses: z.array(affine).min(1).max(12) }).strict()),
  occupationPeriods: z.number().int().min(1).max(13), earliestPeriod: z.number().int().min(0).max(11),
  lastPeriod: z.number().int().min(0).max(11), atMostOnce: z.boolean(), protocolRef: AtlasRefSchema.nullable(),
  informationDelayPeriods: z.number().int().min(1).max(12),
  precondition: z.object({ afterActionIds: z.array(id).max(12),
    observations: z.array(z.object({ instrumentId: text, tokens: z.array(text).min(1).max(64) }).strict()).max(8) }).strict(),
}).strict();
export const AffineFamilySourceSchema = z.object({
  schema: z.literal('finnor.s3.affine-family-source.v1'), modelKey: id, familyKey: id,
  representation: z.literal('SUPPLIED_COMPLETE_AFFINE_PATH_HYPOTHESIS'),
  domain: z.object({ parameters: z.array(parameter).min(1).max(4), facets: z.array(facet).max(128) }).strict(),
  mandate, stateUnits: z.record(z.string(), text),
  policies: z.array(z.object({ id, ref: AtlasRefSchema, rootNodeId: id, actions: z.array(action).min(1).max(32),
    nodes: z.array(z.object({ id, period: z.number().int().min(0).max(11), actionId: id, actionHistory: z.array(id).max(12),
      observations: z.array(observation).max(8), children: z.array(id).max(64) }).strict()).min(1).max(768) }).strict()).min(1).max(32),
  worlds: z.array(z.object({ id, mechanismRef: AtlasRefSchema, supportRef: AtlasRefSchema,
    paths: z.array(z.object({ policyId: id, nodeIds: z.array(id).min(1).max(12),
      states: z.array(z.record(z.string(), affine)).min(2).max(13) }).strict()).min(1).max(32) }).strict()).min(1).max(64),
  hardPredicates: z.array(facet.extend({ id, policyId: id, worldId: id, period: z.number().int().min(0).max(12), unit: text,
    owner: z.enum(['S3', 'S4', 'S5', 'BUSINESS_OWNER']), sourceRef: AtlasRefSchema })).max(65536),
  tieOrder: z.array(id).min(1).max(32), assumptions: z.array(z.string().min(1).max(2048)).min(1).max(64),
  qualification: z.literal('MODEL_RELATIVE_EXACT_UNADMITTED'), parameterValues: z.array(q).min(1).max(4),
}).strict();
const unique = (ids: string[], code: string) => { if (new Set(ids).size !== ids.length) throw new AtlasError(code); };
export function parseAffineFamilySource(value: unknown): AffineFamilySource {
  if (Buffer.byteLength(JSON.stringify(value)) > DEFAULT_ATLAS_BUDGET.maxBytes) throw new AtlasError('INPUT_BYTE_LIMIT');
  const parsed = AffineFamilySourceSchema.safeParse(value);
  if (!parsed.success) throw new AtlasError('UNSUPPORTED', 'Unsupported or incomplete exact-affine source contract');
  const s: AffineFamilySource = parsed.data, m = s.mandate, n = s.domain.parameters.length, h = m.horizon.periods;
  const { ref: mr, ...mb } = m;
  if (mr.owner !== 'BUSINESS_OWNER' || mr.version !== 'economic-mandate-exact-affine-v1' || mr.contentDigest !== atlasHash(mb) ||
      mr.id !== `exact-affine-mandate:${mr.contentDigest}` || m.businessOwnerRef.id !== m.principalId ||
      Date.parse(m.validUntil) <= Date.parse(m.knowledgeAt) || m.utility.discountFactors.length !== h + 1)
    throw new AtlasError('ORIGINAL_MANDATE_BINDING');
  if (m.quantityBasis.currency && m.quantityBasis.unit !== m.quantityBasis.currency)
    throw new AtlasError('UNIT_CURRENCY_MISMATCH');
  unique(s.domain.parameters.map(p => p.id), 'PARAMETER_IDENTITY'); unique(s.policies.map(p => p.id), 'FAMILY_IDENTITY');
  unique(s.worlds.map(w => w.id), 'WORLD_IDENTITY'); unique(m.dimensions.map(d => d.id), 'DIMENSION_IDENTITY');
  unique(s.hardPredicates.map(c => c.id), 'CONSTRAINT_IDENTITY'); unique(s.tieOrder, 'TIE_RULE');
  if (s.parameterValues.length !== n || s.tieOrder.length !== s.policies.length ||
      s.tieOrder.some(id => !s.policies.some(p => p.id === id))) throw new AtlasError('FAMILY_OR_TIE_COVERAGE');
  for (const p of s.domain.parameters) {
    if (rational(p.lower).compare(rational(p.upper)) > 0) throw new AtlasError('DOMAIN_EMPTY');
    if (p.owner === 'S5' ? p.valueSource !== 'CURRENT_S5_AVAILABLE' || p.resourceId === null || p.resourcePeriod === null :
      p.valueSource !== 'AUTHENTICATED_OWNER_REVISION' || p.resourceId !== null || p.resourcePeriod !== null)
      throw new AtlasError('PARAMETER_OWNER_SEMANTICS');
    if (p.currency !== null && p.unit !== p.currency) throw new AtlasError('PARAMETER_UNIT');
  }
  function scan(v: unknown): void {
    if (!v || typeof v !== 'object') return;
    if ('a' in v && 'b' in v && Array.isArray(v.a) && v.a.length !== n) throw new AtlasError('AFFINE_DIMENSION_MISMATCH');
    for (const nested of Object.values(v)) scan(nested);
  }
  scan(s);
  const variables = Object.keys(s.stateUnits);
  if (!variables.length || variables.length > 32 || [...m.utility.periodTerms, ...m.utility.terminalTerms]
    .some(t => s.stateUnits[t.variableId] !== t.unit || t.coefficientUnit !== `${m.quantityBasis.unit}/${t.unit}`)) throw new AtlasError('ORIGINAL_UTILITY_UNITS');
  if ([...m.utility.discountFactors, m.maxHumanSeconds, m.utility.terminalLiability,
    ...m.dimensions.flatMap(d => [d.capacity, d.totalLimit]), ...m.couplings.map(c => c.maxPerPeriod)]
    .some(q => rational(q).n < 0n)) throw new AtlasError('NEGATIVE_ORIGINAL_LIMIT');
  unique(m.couplings.map(c=>c.id),'COUPLING_IDENTITY');
  for(const c of m.couplings)if(Object.keys(c.weights).some(id=>!m.dimensions.some(d=>d.id===id)) ||
    new Set(Object.keys(c.weights).map(id=>m.dimensions.find(d=>d.id===id)!.unit)).size>1)
    throw new AtlasError('COUPLING_UNIT_BASIS_UNSUPPORTED');
  for (const policy of s.policies) {
    const { ref, ...body } = policy;
    if (ref.owner !== 'S4' || ref.version !== 's4-exact-affine-v1' || ref.contentDigest !== atlasHash(body) ||
      ref.id !== `exact-affine-policy:${ref.contentDigest}`) throw new AtlasError('ORIGINAL_POLICY_BINDING');
    unique(policy.actions.map(a => a.id), 'ACTION_IDENTITY'); unique(policy.nodes.map(a => a.id), 'NODE_IDENTITY');
    const root = policy.nodes.find(node => node.id === policy.rootNodeId), parents = new Map<string, number>(),
      informationStates = new Set<string>();
    if (!root || root.period !== 0 || root.actionHistory.length || root.observations.length) throw new AtlasError('POLICY_ROOT');
    for (const a of policy.actions) {
      if (a.costUnit !== m.quantityBasis.unit || a.earliestPeriod > a.lastPeriod || a.lastPeriod >= h ||
        m.dimensions.some(d => !Object.hasOwn(a.resources, d.id) || !Object.hasOwn(a.occupancy, d.id)) ||
        Object.keys(a.resources).length !== m.dimensions.length || Object.keys(a.occupancy).length !== m.dimensions.length ||
        (a.kind === 'INQUIRE') !== (a.protocolRef !== null) || a.kind !== 'INTERVENE' && Object.keys(a.exposures).length ||
        a.precondition.afterActionIds.some(id=>!policy.actions.some(a=>a.id===id)))
        throw new AtlasError('ORIGINAL_ACTION_SEMANTICS');
    }
    for (const node of policy.nodes) {
      const a = policy.actions.find(a => a.id === node.actionId);
      if (!a || node.period < a.earliestPeriod || node.period > a.lastPeriod || node.actionHistory.length !== node.period ||
        a.atMostOnce && node.actionHistory.includes(a.id) || a.precondition.afterActionIds.some(id => !node.actionHistory.includes(id)) ||
        a.precondition.observations.some(o => !node.observations.some(v => v.instrumentId === o.instrumentId && o.tokens.includes(v.token))) ||
        node.observations.some(o => o.availablePeriod > node.period) || (node.period === h - 1) !== (node.children.length === 0) ||
        node.actionHistory.some(id=>policy.actions.find(a=>a.id===id)?.kind==='STOP') && a.kind!=='STOP')
        throw new AtlasError('LAWFUL_POLICY_HISTORY');
      for (const obs of node.observations) {
        const inquiry = policy.actions.find(a => a.protocolRef?.id === obs.instrumentId);
        if (!inquiry || obs.availablePeriod < inquiry.informationDelayPeriods ||
          node.actionHistory[obs.availablePeriod - inquiry.informationDelayPeriods] !== inquiry.id)
          throw new AtlasError('LAWFUL_OBSERVATION_TIMING');
      }
      unique(node.observations.map(o => atlasHash([o.instrumentId, o.availablePeriod])), 'OBSERVATION_EVENT_IDENTITY');
      const information = atlasHash([node.period, node.actionHistory,
        node.observations.map(o => atlasHash([o.instrumentId, o.availablePeriod, o.token])).sort()]);
      if (informationStates.has(information)) throw new AtlasError('NONANTICIPATIVE_POLICY');
      informationStates.add(information);
      unique(node.children, 'BRANCH_IDENTITY');
      for (const id of node.children) {
        const child = policy.nodes.find(n => n.id === id);
        if (!child || child.period !== node.period + 1 ||
          atlasHash(child.actionHistory) !== atlasHash([...node.actionHistory, node.actionId]) ||
          node.observations.some(o => !child.observations.some(v => atlasHash(v) === atlasHash(o))))
          throw new AtlasError('ORIGINAL_POLICY_TOPOLOGY');
        parents.set(id, (parents.get(id) ?? 0) + 1);
      }
    }
    if (policy.nodes.some(node => node.id === root.id ? parents.has(node.id) : parents.get(node.id) !== 1))
      throw new AtlasError('ORIGINAL_POLICY_TOPOLOGY');
  }
  for (const world of s.worlds) {
    unique(world.paths.map(p => p.policyId), 'WORLD_POLICY_COVERAGE');
    if (world.paths.length !== s.policies.length) throw new AtlasError('WORLD_POLICY_COVERAGE');
    for (const path of world.paths) {
      const p = s.policies.find(p => p.id === path.policyId);
      if (!p || path.states.length !== h + 1 || path.nodeIds.length !== h || path.nodeIds[0] !== p.rootNodeId ||
        path.nodeIds.some((id, t) => !p.nodes.some(v => v.id === id && v.period === t &&
          (t === 0 || p.nodes.find(v => v.id === path.nodeIds[t - 1])!.children.includes(id)))) ||
        path.states.some(state => Object.keys(state).length !== variables.length || variables.some(id => !state[id])))
        throw new AtlasError('COMPLETE_FIXED_WORLD_PATH');
    }
  }
  for (const policy of s.policies) if (policy.nodes.some(node =>
    !s.worlds.some(w => w.paths.find(path => path.policyId === policy.id)!.nodeIds.includes(node.id))))
    throw new AtlasError('OMITTED_REACHABLE_BRANCH');
  if (s.hardPredicates.some(c => !s.policies.some(p => p.id === c.policyId) || !s.worlds.some(w => w.id === c.worldId) || c.period > h))
    throw new AtlasError('ORIGINAL_CONSTRAINT_BINDING');
  return s;
}
export function domainFacets(domain: AtlasDomain): AtlasFacet[] {
  const n = domain.parameters.length, result = [...domain.facets];
  for (let i = 0; i < n; i++) {
    const lower = zeroAffine(n), upper = zeroAffine(n);
    // Signs are mathematical, not string prefix operations on negative bounds.
    lower.a[i] = '-1/1'; lower.b = domain.parameters[i]!.lower;
    upper.a[i] = '1/1';
    const u = rational(domain.parameters[i]!.upper); upper.b = `${-u.n}/${u.d}`;
    result.push({ expression: lower, relation: 'LE' }, { expression: upper, relation: 'LE' });
  }
  return result;
}
export const AtlasBudgetSchema = z.object({
  maxNodes: z.number().int().min(1).max(1024), maxDepth: z.number().int().min(1).max(256),
  maxFacets: z.number().int().min(8).max(256), maxBases: z.number().int().min(1).max(200000),
  maxTotalBases: z.number().int().min(1).max(2000000), maxBytes: z.number().int().min(4096).max(33554432),
  deadlineMs: z.number().int().min(1).max(30000),
}).strict();
