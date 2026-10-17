/** Test inputs registered before the operating-profit implementation.
 * These are supplied finite worlds, not customer measurements or causal truth. */
import { createHash } from 'node:crypto';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';

export const profitRef = (id: string, owner = 'BUSINESS_OWNER') => ({
  owner, id, version: 'generated-profit-fixture-v1', contentDigest: createHash('sha256').update(id).digest('hex'),
});
export const profitRoot = { entityType: 'external_organization', entityId: '11111111-1111-4111-8111-111111111111' };
export function sealProfitMandate(m: any) {
  const { ref: _ref, ...body } = m, digest = epistemicHash(body);
  return { ...body, ref: { owner: 'BUSINESS_OWNER', id: `mandate:${digest}`, version: 'economic-mandate-v1', contentDigest: digest } };
}
export function profitInput(options: { periods?: number; actions?: string[]; worlds?: string[] } = {}): any {
  const periods = options.periods ?? 1, at = new Date().toISOString(), unit = 'USD';
  const constant = (value: number, unit: string) => ({ kind: 'CONSTANT', value, unit, sourceRef: profitRef(`constant:${unit}:${value}`) });
  const state = (variableId: string, unit: string) => ({ kind: 'STATE', variableId, unit });
  const operatingProfit = {
    schema: 'finnor.s4.operating-profit.v1', root: profitRoot, currency: 'USD', moneyScale: '1',
    objective: 'INCREMENTAL_OPERATING_PROFIT',
    segments: [{ id: 'product', quantityUnit: 'item', netUnitPrice: state('price', 'USD/item'),
      unitsSold: state('units', 'item'), variableUnitCost: constant(6, 'USD/item') }],
    fixedOperatingCost: constant(100, unit), depreciationAmortization: constant(20, unit),
    accountsReceivable: state('ar', unit), inventory: constant(50, unit), accountsPayable: constant(30, unit),
    capitalExpenditure: constant(0, unit), cashTaxes: constant(0, unit),
    openingCash: 100, minimumCash: 50,
    actionCostTreatment: 'IMMEDIATE_OPERATING_EXPENSE_AND_CASH_OUTFLOW',
    terminalWorkingCapital: 'NO_AUTOMATIC_RELEASE',
    qualification: 'OWNER_ACCOUNTING_CONDITIONAL_S3_DYNAMICS_NOT_OBSERVED_VALUE',
  };
  const mandate = sealProfitMandate({ schema: 'finnor.economic-mandate.v1',
    tenantId: '22222222-2222-4222-8222-222222222222', principalId: '33333333-3333-4333-8333-333333333333',
    episodeId: 'generated-profit-programme', knowledgeAt: at, validUntil: new Date(Date.parse(at) + 3600000).toISOString(),
    businessOwnerRef: profitRef('33333333-3333-4333-8333-333333333333'), rightsRef: 'generated-owner-rights', utilityRef: profitRef('profit-objective'),
    horizon: { startAt: at, periodMs: 60000, periods },
    utility: { unit, accountingConventionRef: profitRef('generated-net-revenue-no-double-cost'), periodTerms: [], terminalTerms: [],
      discountFactors: Array(periods + 1).fill(1), tail: { status: 'SUPPLIED_COMPLETE_FINITE_HORIZON', terminalLiability: 0, ref: profitRef('tail') }, operatingProfit },
    risk: { kind: 'HARD_WORST_PATH_UTILITY_FLOOR', minimumUtility: -10000 },
    ambiguity: { kind: 'ROBUST_FIXED_JOINT_SCENARIOS', authorizationRef: profitRef('robust') },
    resources: { dimensions: [{ id: 'capacity', unit: 'unit', capacity: 100, totalLimit: 100 }], couplings: [] },
    search: { maxExpansions: 50000, deadlineMs: 30000, maxWorlds: 512, maxPolicyNodes: 50000, maxHumanSeconds: 900 },
    scoring: { normalization: 100, maxRegret: 0.05 }, authorization: { basis: 'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED', protectedReceipt: null },
  });
  const ids = [...(options.actions ?? ['grow', 'smart']), 'wait', 'stop'];
  const dose = (id: string) => id === 'grow' ? 1 : id === 'smart' ? 2 : id === 'cash-trap' ? 3 : 0;
  const stateUnits = { price: 'USD/item', units: 'item', ar: unit };
  const dynamics: any = { ref: profitRef('generated-profit-dynamics', 'S3'), stateUnits,
    stateRoots: Object.fromEntries(Object.keys(stateUnits).map(id => [id, profitRoot])),
    stateRanges: { price: [0, 100], units: [0, 1000], ar: [0, 1000] }, exposureIds: ['choice'],
    qualification: 'SUPPLIED_FINITE_REFERENCE_ONLY', limitations: ['Generated finite laws only'],
    initialWorlds: (options.worlds ?? ['base']).map(id => ({ id, mechanismId: id, supported: true,
      history: [{ states: { price: 10, units: 100, ar: 100 }, exposures: { choice: 0 } }] })),
    advance(world: any, exposures: any) {
      const n = exposures.choice, states = { price: n === 1 ? 8 : n >= 2 ? 11 : 10,
        units: n === 1 ? 150 : world.id === 'adverse' && n === 2 ? 70 : 100, ar: n === 3 ? 600 : 100 };
      return { ...world, history: [...world.history, { states, exposures }] };
    },
  };
  return { mandate, problem: { schema: 'finnor.control-problem.v1', id: 'generated-profit-policy', episodeId: mandate.episodeId,
    modelRef: profitRef('generated-profit-model', 'S3'), context: 'generated', regime: 'generated',
    baselineExposures: { choice: Array(periods).fill(0) }, observations: [], obligations: [], validUntil: mandate.validUntil,
    actions: ids.map(id => ({ id, kind: id === 'wait' ? 'WAIT' : id === 'stop' ? 'STOP' : 'INTERVENE', cost: 0, costUnit: unit,
      resources: { capacity: 0 }, occupancy: { capacity: 0 }, occupationPeriods: 1, tailLiability: 0, earliestPeriod: 0,
      lastPeriod: id === 'wait' || id === 'stop' ? periods - 1 : 0, atMostOnce: id !== 'wait' && id !== 'stop',
      exposures: id === 'wait' || id === 'stop' ? {} : { choice: Array(periods).fill(dose(id)) },
      protocolRef: null, informationDelayPeriods: 1, humanSeconds: 0 })) }, dynamics, instruments: [], now: at };
}
