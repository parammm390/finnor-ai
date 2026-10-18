import type { ContingentPolicy, OperatingProfitDriver, OperatingProfitObjective, OperatingProfitCashPeriod } from '@finnor/shared-types';
import { OperatingProfitCertificateSchema, assessRevenueProfitTarget } from './operating-profit';
import { operatingProgrammeSearchReport } from './operating-programme';
import { epistemicHash } from './source-precedence';

const same = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);
const matchesConstant = (driver: OperatingProfitDriver, value: number) => driver.kind !== 'CONSTANT' || driver.value === value;
const cashComponents = ['fixedOperatingCost', 'depreciationAmortization', 'cashTaxes', 'capitalExpenditure',
  'nonOperatingCashInflow', 'nonOperatingCashOutflow'] as const;
const netComponents = ['financingExpense', 'incomeTaxExpense', 'otherIncome', 'otherExpense'] as const;

function ledgerCommitmentReason(profile: OperatingProfitObjective, row: OperatingProfitCashPeriod): string | null {
  if (cashComponents.some(key => !matchesConstant(profile[key], row[key])))
    return 'Operating-profit ledger differs from the original constant cash and expense drivers';
  if (row.workingCapitalFunding < Math.max(0, row.changeInWorkingCapital))
    return 'Gross working-capital funding cannot omit positive net stock movement';
  const net = row.netProfit;
  if (Boolean(profile.netProfit) !== Boolean(net)) return 'Net-profit P&L ledger is missing or unexpected';
  if (net) {
    if (net.profit !== row.operatingProfit - net.financingExpense - net.incomeTaxExpense + net.otherIncome - net.otherExpense ||
        net.comparator.profit !== row.comparatorOperatingProfit - net.comparator.financingExpense - net.comparator.incomeTaxExpense + net.comparator.otherIncome - net.comparator.otherExpense)
      return 'Net-profit P&L ledger differs from financing, tax and other expense recognition';
    if (profile.netProfit && netComponents.some(key => !matchesConstant(profile.netProfit[key], net[key]) ||
        !matchesConstant(profile.netProfit[key], net.comparator[key])))
      return 'Net-profit ledger differs from the original constant P&L drivers';
  }
  return null;
}

/** Reconcile retained ledger facts against the original charter and action path.
 * This checks accounting consistency, not state-driver causality or field profit.
 * The caller owns contract errors; this module has no storage or authority. */
export function operatingProfitCertificateReason(policy: ContingentPolicy): string | null {
  const { mandate, problem } = policy, profile = mandate.utility.operatingProfit, certificate = policy.certificate.operatingProfit;
  if (Boolean(profile) !== Boolean(certificate)) return 'Operating-profit profile and conditional certificate differ';
  if (!profile || !certificate) return null;
  if (!OperatingProfitCertificateSchema.safeParse(certificate).success || certificate.objective !== profile.objective ||
      certificate.unit !== mandate.utility.unit || certificate.currency !== profile.currency || certificate.moneyScale !== profile.moneyScale ||
      !same(certificate.root, profile.root) || certificate.measure !== (profile.netProfit ? 'NET_PROFIT_AFTER_FINANCING_AND_INCOME_TAX' : 'OPERATING_PROFIT_BEFORE_FINANCING_AND_TAX'))
    return 'Operating-profit profile and conditional certificate differ';
  if (problem.obligations.some(o => o.terminalLiability === null || o.status === 'UNKNOWN' || o.status === 'PARTIAL'))
    return 'Operating-profit terminal debt cannot be certified with unresolved obligations';
  // SETTLED releases occupation, not residual debt. Match the producer's
  // addition order; no roundoff allowance is added to the profit hurdle.
  const commonLiability = mandate.utility.tail.terminalLiability + problem.obligations.reduce((sum, o) => sum + o.terminalLiability!, 0);
  const constantNonOperating = profile.nonOperatingCashInflow.kind === 'CONSTANT' && profile.nonOperatingCashOutflow.kind === 'CONSTANT'
    ? profile.nonOperatingCashInflow.value - profile.nonOperatingCashOutflow.value : null;

  for (const forecast of certificate.forecasts) {
    if (forecast.incrementalOperatingProfit !== forecast.operatingProfit - forecast.comparatorOperatingProfit ||
        forecast.incrementalFreeCashFlow !== forecast.freeCashFlow - forecast.comparatorFreeCashFlow ||
        forecast.closingCash < profile.minimumCash || forecast.minimumCashObserved < profile.minimumCash ||
        forecast.minimumCashObserved > Math.min(profile.openingCash, forecast.closingCash))
      return 'Operating-profit forecast accounting or cash floor differs';
    if (forecast.periods.length !== mandate.horizon.periods || forecast.nodeIds.length !== forecast.periods.length || forecast.nodeIds[0] !== policy.rootNodeId)
      return 'Operating-profit full cash ledger path is incomplete';
    if (Boolean(profile.netProfit) !== Boolean(forecast.netProfit)) return 'Net-profit forecast accounting is missing or unexpected';

    let utility = 0, revenue = 0, op = 0, fcf = 0, baselineOp = 0, baselineFcf = 0, net = 0, baselineNet = 0;
    let cost = 0, nonOperating = 0, baselineNonOperating = 0, cash = profile.openingCash, baselineCash = cash, minimum = cash;
    let liability = commonLiability;
    for (let t = 0; t < forecast.periods.length; t++) {
      const row = forecast.periods[t]!, node = policy.nodes.find(n => n.id === forecast.nodeIds[t]);
      const action = problem.actions.find(a => a.id === node?.actionId);
      if (!node || !action || node.period !== t || row.period !== t ||
          t > 0 && !policy.nodes.find(n => n.id === forecast.nodeIds[t - 1])?.branches.some(b => b.childId === node.id) ||
          row.actionCost !== action.cost || row.openingCash !== cash || row.cashAfterAction !== cash - row.actionCost ||
          row.operatingProfit !== row.revenue - row.variableCost - row.fixedOperatingCost - row.depreciationAmortization - row.actionCost ||
          row.freeCashFlow !== row.operatingProfit + row.depreciationAmortization - row.cashTaxes - row.capitalExpenditure - row.changeInWorkingCapital ||
          row.nonOperatingNetCashFlow !== row.nonOperatingCashInflow - row.nonOperatingCashOutflow ||
          row.closingCash !== cash + row.freeCashFlow + row.nonOperatingNetCashFlow)
        return 'Operating-profit cash ledger differs from its original action path';
      const commitmentReason = ledgerCommitmentReason(profile, row);
      if (commitmentReason) return commitmentReason;
      liability += action.tailLiability;
      const n = row.netProfit;
      if (n) { net += n.profit; baselineNet += n.comparator.profit; }
      revenue += row.revenue; op += row.operatingProfit; fcf += row.freeCashFlow; cost += row.actionCost;
      nonOperating += row.nonOperatingNetCashFlow; cash = row.closingCash; minimum = Math.min(minimum, row.cashAfterAction, cash);
      baselineOp += row.comparatorOperatingProfit; baselineFcf += row.comparatorFreeCashFlow;
      if (constantNonOperating !== null) {
        baselineNonOperating += constantNonOperating;
        baselineCash = baselineCash + row.comparatorFreeCashFlow + constantNonOperating;
      }
      utility += mandate.utility.discountFactors[t]! * (profile.objective === 'INCREMENTAL_NET_PROFIT' ? n!.profit - n!.comparator.profit :
        profile.objective === 'INCREMENTAL_OPERATING_PROFIT' ? row.operatingProfit - row.comparatorOperatingProfit : row.freeCashFlow - row.comparatorFreeCashFlow);
    }
    if (forecast.terminalLiability !== liability || forecast.comparatorTerminalLiability !== commonLiability)
      return 'Operating-profit terminal debt differs from the mandate, obligations or selected actions';
    utility += mandate.utility.discountFactors[mandate.horizon.periods]! * (commonLiability - liability);
    if (revenue !== forecast.revenue || nonOperating !== forecast.nonOperatingNetCashFlow ||
        op !== forecast.operatingProfit || baselineOp !== forecast.comparatorOperatingProfit || fcf !== forecast.freeCashFlow || baselineFcf !== forecast.comparatorFreeCashFlow ||
        forecast.netProfit && (net !== forecast.netProfit.profit || baselineNet !== forecast.netProfit.comparatorProfit || forecast.netProfit.incrementalProfit !== net - baselineNet) ||
        cost !== forecast.implementationCost || cash - liability !== forecast.closingCash ||
        Math.min(minimum, cash - liability) !== forecast.minimumCashObserved || utility !== forecast.discountedUtility)
      return 'Operating-profit ledger totals or discounted utility differ';
    // v1 retains no comparator nonoperating period ledger. Reconstruct it only
    // when both original drivers are constant (or the horizon is one period).
    // Reassociating FLOAT64 aggregate sums would reject valid multi-period cash.
    if (constantNonOperating !== null && (baselineNonOperating !== forecast.comparatorNonOperatingNetCashFlow ||
        baselineCash - commonLiability !== forecast.comparatorClosingCash) ||
        forecast.periods.length === 1 && profile.openingCash + forecast.comparatorFreeCashFlow + forecast.comparatorNonOperatingNetCashFlow - commonLiability !== forecast.comparatorClosingCash)
      return 'Comparator cash differs from its retained ledger and original debt';
  }
  const worst = Math.min(...certificate.forecasts.map(f => f.discountedUtility));
  const assessment = assessRevenueProfitTarget(mandate, worst, policy.certificate.completeSearch);
  const root = policy.nodes.find(n => n.id === policy.rootNodeId);
  if (assessment && (assessment.status !== 'TARGET_MET_IN_RETAINED_MODEL' || policy.certificate.valueBounds.some(v => v !== worst) || root?.valueBounds.some(v => v !== worst)) ||
      !same(assessment ?? null, certificate.profitTargetAssessment ?? null))
    return 'Fixed revenue profit target or retained worst-world value differs';
  const programme = operatingProgrammeSearchReport(problem, root?.alternatives ?? [], root?.actionId ?? null, policy.certificate.completeSearch);
  if (!same(programme ?? null, certificate.programmeSearch ?? null) || programme && policy.certificate.completeSearch &&
      (programme.evaluatedProgrammes !== programme.generatedProgrammes || programme.candidates.some(c =>
        c.status !== 'POLICY_AVAILABLE' && c.status !== 'INFEASIBLE' || c.valueBounds && c.valueBounds[0] > worst)))
    return 'Joint operating programme domain, choices, charges or complete-search bound differs';
  return null;
}
