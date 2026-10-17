import { z } from 'zod';
import type { ControlAction, ControlDynamicsAdapter, ControlProblem, EconomicMandate, OperatingProgrammeChoice,
  OperatingProgrammeCost, OperatingProgrammeSearchReport, PolicyNode } from '@finnor/shared-types';
import { ExperimentRefSchema } from './experiments';
import { epistemicHash } from './source-precedence';

const text = z.string().min(1).max(256), amount = z.number().finite().nonnegative().max(1e9);
const amounts = z.record(text, amount), choice = z.object({ leverId: text, optionId: text }).strict();
const cost = { cost: amount, resources: amounts, occupancy: amounts, tailLiability: amount, humanSeconds: amount.max(900) };
export const OperatingProgrammeSpaceSchema = z.object({
  schema: z.literal('finnor.s4.operating-programme-space.v1'), sourceRef: ExperimentRefSchema,
  scope: z.object({ mandateRef: ExperimentRefSchema, root: z.object({ entityType: text, entityId: z.string().uuid() }).strict(), unit: text,
    horizon: z.object({ startAt: z.string().datetime({ offset: true }), periodMs: z.number().int().positive().max(31536000000), periods: z.number().int().min(1).max(24) }).strict() }).strict(),
  levers: z.array(z.object({ id: text, exposureId: text,
    options: z.array(z.object({ id: text, schedule: z.array(z.number().finite().min(-1e9).max(1e9)).min(1).max(24), ...cost }).strict()).min(1).max(8) }).strict()).min(1).max(4),
  exclusions: z.array(z.object({ id: text, when: z.array(choice).min(1).max(4) }).strict()).max(32),
  interactionCharges: z.array(z.object({ id: text, when: z.array(choice).min(2).max(4), ...cost }).strict()).max(32),
  commitment: z.literal('FULL_HORIZON_COMMITMENTS_WITH_EXPLICIT_ADDITIVE_AND_INTERACTION_COSTS'),
  qualification: z.literal('OWNER_DECLARED_OPTIONS_NOT_VERIFIED_ACTIONABILITY'),
}).strict();
const resultState = z.enum(['POLICY_AVAILABLE', 'INFEASIBLE', 'MODEL_UNSUPPORTED', 'UNCERTAINTY_UNRESOLVED', 'SEARCH_EXHAUSTED', 'BLOCKED_ALLOCATION', 'BLOCKED_AUTHORITY', 'STALE_INPUT', 'NUMERICAL_FAILURE', 'NOT_EVALUATED']);
export const OperatingProgrammeSearchReportSchema = z.object({ schema: z.literal('finnor.s4.operating-programme-search.v1'),
  spaceDigest: z.string().regex(/^[a-f0-9]{64}$/), combinations: z.number().int().min(1).max(256), excludedCombinations: z.number().int().min(0).max(256),
  generatedProgrammes: z.number().int().min(0).max(256), evaluatedProgrammes: z.number().int().min(0).max(256), bestActionId: text.nullable(),
  selectedOptions: z.array(choice).max(4), interactionChargeIds: z.array(text).max(32), completeSearch: z.boolean(),
  candidates: z.array(z.object({ actionId: text, choices: z.array(choice).min(1).max(4), interactionChargeIds: z.array(text).max(32),
    status: resultState, valueBounds: z.tuple([z.number().finite(), z.number().finite()]).nullable(), reasons: z.array(text).max(32) }).strict()).max(256),
  qualification: z.literal('REGISTERED_FINITE_JOINT_DOMAIN_NOT_GLOBAL_OR_FIELD_OPTIMALITY'),
}).strict();
export class OperatingProgrammeError extends Error {}
const requireValue = (ok: unknown, reason: string): void => { if (!ok) throw new OperatingProgrammeError(reason); };
const same = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);
const keysEqual = (a: Record<string, unknown>, ids: string[]) => Object.keys(a).length === ids.length && ids.every(id => Object.hasOwn(a, id));
type Programme = { action: ControlAction; choices: OperatingProgrammeChoice[]; interactionChargeIds: string[] };

/** No response coefficients, profit estimates, probabilities or authority are
 * accepted here. The compiler combines only registered controls and costs.
 * Every generated action is one irreversible full-horizon commitment at t=0;
 * WAIT/STOP preserve scheduled consequences in the existing S4 owner. */
export function compileOperatingProgramme(p: ControlProblem): { problem: ControlProblem; programmes: Programme[]; combinations: number; excludedCombinations: number } {
  const s = p.programmeSpace;
  requireValue(p.schema === 'finnor.control-problem.operating-programme.v2' && s, 'OPERATING_PROGRAMME_VERSIONED_DOMAIN_REQUIRED');
  const space = s!, h = space.scope.horizon.periods, passive = p.actions.filter(a => a.kind === 'WAIT' || a.kind === 'STOP');
  requireValue(passive.length >= 1 && passive.length <= 2 && passive.filter(a => a.kind === 'STOP').length === 1 &&
    passive.filter(a => a.kind === 'WAIT').length <= 1 && !p.observations.length && !p.continuation,
  'OPERATING_PROGRAMME_FULL_HORIZON_PASSIVE_CHOICES_REQUIRED');
  const dimensions = Object.keys(passive[0]!.resources), exposures = Object.keys(p.baselineExposures);
  requireValue(dimensions.length >= 1 && dimensions.length <= 8 && exposures.length >= 1 && exposures.length <= 4,
    'OPERATING_PROGRAMME_RESOURCE_OR_EXPOSURE_CARDINALITY_OUTSIDE_DOMAIN');
  requireValue(Object.values(p.baselineExposures).every(v => v.length === h), 'OPERATING_PROGRAMME_BASELINE_HORIZON_DIFFERS');
  for (const a of passive) requireValue(a.costUnit === space.scope.unit && a.cost === 0 && a.tailLiability === 0 && a.humanSeconds === 0 &&
    a.earliestPeriod === 0 && a.lastPeriod === h - 1 && !a.atMostOnce && !a.precondition && a.protocolRef === null && !Object.keys(a.exposures).length &&
    keysEqual(a.resources, dimensions) && keysEqual(a.occupancy, dimensions) && [...Object.values(a.resources), ...Object.values(a.occupancy)].every(v => v === 0),
  'OPERATING_PROGRAMME_PASSIVE_ACTION_MUST_PRESERVE_DECLARED_BASELINE');
  requireValue(new Set(space.levers.map(l => l.id)).size === space.levers.length && new Set(space.levers.map(l => l.exposureId)).size === space.levers.length,
    'OPERATING_PROGRAMME_DUPLICATE_OR_OVERLAPPING_CONTROL');
  let combinations = 1;
  for (const lever of space.levers) {
    requireValue(exposures.includes(lever.exposureId) && new Set(lever.options.map(o => o.id)).size === lever.options.length,
      'OPERATING_PROGRAMME_UNREGISTERED_EXPOSURE_OR_DUPLICATE_OPTION');
    combinations *= lever.options.length;
    for (const option of lever.options) requireValue(option.schedule.length === h, 'OPERATING_PROGRAMME_OPTION_HORIZON_DIFFERS');
  }
  requireValue(combinations <= 256, 'OPERATING_PROGRAMME_CARTESIAN_DOMAIN_LIMIT_EXCEEDED_NO_TRUNCATION');
  const rules = [...space.exclusions, ...space.interactionCharges];
  requireValue(new Set(rules.map(r => r.id)).size === rules.length, 'OPERATING_PROGRAMME_DUPLICATE_RULE');
  for (const rule of rules) requireValue(new Set(rule.when.map(c => c.leverId)).size === rule.when.length &&
    rule.when.every(c => space.levers.some(l => l.id === c.leverId && l.options.some(o => o.id === c.optionId))), 'OPERATING_PROGRAMME_DANGLING_OR_CONFLICTING_RULE');
  for (const component of [...space.levers.flatMap(l => l.options), ...space.interactionCharges])
    requireValue(keysEqual(component.resources, dimensions) && keysEqual(component.occupancy, dimensions), 'OPERATING_PROGRAMME_INCOMPLETE_RESOURCE_PRICE');
  const programmes: Programme[] = []; let excludedCombinations = 0;
  function enumerate(selected: OperatingProgrammeChoice[], index: number): void {
    if (index < space.levers.length) {
      const lever = space.levers[index]!;
      for (const option of lever.options) enumerate([...selected, { leverId: lever.id, optionId: option.id }], index + 1);
      return;
    }
    const matches = (when: OperatingProgrammeChoice[]) => when.every(c => selected.some(x => x.leverId === c.leverId && x.optionId === c.optionId));
    if (space.exclusions.some(r => matches(r.when))) { excludedCombinations++; return; }
    const charges = space.interactionCharges.filter(r => matches(r.when));
    const options = selected.map(c => space.levers.find(l => l.id === c.leverId)!.options.find(o => o.id === c.optionId)!);
    const components: OperatingProgrammeCost[] = [...options, ...charges];
    const total = (read: (c: OperatingProgrammeCost) => number) => {
      const value = components.reduce((sum, c) => sum + read(c), 0);
      requireValue(Number.isFinite(value) && value >= 0 && value <= 1e9, 'OPERATING_PROGRAMME_AGGREGATE_COST_OUTSIDE_DOMAIN'); return value;
    };
    const schedule = structuredClone(p.baselineExposures);
    for (const [index, option] of options.entries()) schedule[space.levers[index]!.exposureId] = [...option.schedule];
    const id = `operating-programme:${epistemicHash({ space, selected })}`;
    programmes.push({ choices: selected, interactionChargeIds: charges.map(c => c.id), action: {
      id, kind: 'INTERVENE', cost: total(c => c.cost), costUnit: space.scope.unit,
      resources: Object.fromEntries(dimensions.map(id => [id, total(c => c.resources[id]!)])),
      occupancy: Object.fromEntries(dimensions.map(id => [id, total(c => c.occupancy[id]!)])), occupationPeriods: h,
      tailLiability: total(c => c.tailLiability), humanSeconds: total(c => c.humanSeconds),
      earliestPeriod: 0, lastPeriod: 0, atMostOnce: true, exposures: schedule, protocolRef: null, informationDelayPeriods: 1,
    } });
  }
  enumerate([], 0);
  const actions = [...programmes.map(p => p.action), ...passive];
  // Raw owner requests contain only passive actions. Persisted/replayed inputs
  // contain the complete deterministic expansion; edited/subsampled actions fail.
  requireValue(p.actions.length === passive.length || same(p.actions, actions), 'OPERATING_PROGRAMME_COMPILED_ACTIONS_DIFFER_FROM_ORIGINAL_DOMAIN');
  requireValue(new Set(actions.map(a => a.id)).size === actions.length, 'OPERATING_PROGRAMME_ACTION_ID_COLLISION');
  return { problem: { ...p, actions }, programmes, combinations, excludedCombinations };
}

export function operatingProgrammeScopeReason(m: EconomicMandate, p: ControlProblem, dynamics?: ControlDynamicsAdapter): string | null {
  if (p.schema !== 'finnor.control-problem.operating-programme.v2') return p.programmeSpace ? 'OPERATING_PROGRAMME_VERSIONED_DOMAIN_REQUIRED' : null;
  const s = p.programmeSpace;
  if (!s || m.utility.operatingProfit?.objective !== 'INCREMENTAL_NET_PROFIT' || !m.utility.operatingProfit.profitTarget)
    return 'OPERATING_PROGRAMME_REQUIRES_EXPLICIT_NET_PROFIT_AND_FIXED_REVENUE_TARGET';
  if (!same(s.scope.mandateRef, m.ref) || !same(s.scope.root, m.utility.operatingProfit.root) || s.scope.unit !== m.utility.unit || !same(s.scope.horizon, m.horizon))
    return 'OPERATING_PROGRAMME_ORIGINAL_MANDATE_ENTITY_CURRENCY_OR_HORIZON_DIFFERS';
  if (dynamics && s.levers.some(l => !dynamics.exposureIds.includes(l.exposureId))) return 'OPERATING_PROGRAMME_EXPOSURE_NOT_IN_CURRENT_JOINT_S3_MODEL';
  return null;
}

export function operatingProgrammeSearchReport(p: ControlProblem, alternatives: PolicyNode['alternatives'], bestActionId: string | null, completeSearch: boolean): OperatingProgrammeSearchReport | undefined {
  if (!p.programmeSpace) return undefined;
  const domain = compileOperatingProgramme(p), chosen = domain.programmes.find(c => c.action.id === bestActionId);
  const candidates = domain.programmes.map(c => { const result = alternatives.find(a => a.actionId === c.action.id); return {
    actionId: c.action.id, choices: c.choices, interactionChargeIds: c.interactionChargeIds,
    status: result?.status ?? 'NOT_EVALUATED' as const, valueBounds: result?.valueBounds ?? null, reasons: result?.reasons ?? [],
  }; });
  return { schema: 'finnor.s4.operating-programme-search.v1', spaceDigest: epistemicHash(p.programmeSpace), combinations: domain.combinations,
    excludedCombinations: domain.excludedCombinations, generatedProgrammes: domain.programmes.length,
    evaluatedProgrammes: candidates.filter(c => c.status !== 'NOT_EVALUATED').length, bestActionId,
    selectedOptions: chosen?.choices ?? [], interactionChargeIds: chosen?.interactionChargeIds ?? [], completeSearch, candidates,
    qualification: 'REGISTERED_FINITE_JOINT_DOMAIN_NOT_GLOBAL_OR_FIELD_OPTIMALITY' };
}
