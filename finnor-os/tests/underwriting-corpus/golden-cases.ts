import {
  buildPeriods,
  decimal,
  type DecimalString,
  type SensitivityDefinition,
  type SponsorCashFlow,
  type StandardDebtTrancheDefinition,
  type StandardLboInputValues,
  type StandardLboModelConfig,
} from "@finnor/underwriting";

/**
 * Independently authored P4 finance oracles.
 *
 * Expected amounts below are fixed hand/algebra values, not snapshots emitted by
 * the underwriting runtime. The only P4 helper used while constructing inputs is
 * decimal-string validation; no expected value is calculated by execute* code.
 */

export interface ExpectedDebtPeriod {
  trancheId: string;
  periodId: string;
  opening: string;
  cashInterest: string;
  pik: string;
  draw: string;
  mandatory: string;
  sweep: string;
  ending: string;
}

export interface GoldenLboCase {
  kind: "lbo";
  id: string;
  responsibility: string;
  referenceMethod: string;
  config: StandardLboModelConfig;
  inputs: StandardLboInputValues;
  expected: {
    status: "SUCCEEDED" | "FAILED";
    validity: "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT";
    values: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
    checks: Readonly<Record<string, boolean>>;
    debtRollForward: readonly ExpectedDebtPeriod[];
    sponsorCashFlows: readonly SponsorCashFlow[];
    returns: null | { moic: string; irr: string; xirr: string; tolerance?: string };
    failureCode?: string;
  };
}

export interface GoldenReturnsCase {
  kind: "returns";
  id: string;
  responsibility: string;
  referenceMethod: string;
  cashFlows: readonly SponsorCashFlow[];
  expectedFailureCode: "IRR_AMBIGUOUS";
}

export interface GoldenSensitivityCase {
  kind: "sensitivity";
  id: string;
  responsibility: string;
  referenceMethod: string;
  config: StandardLboModelConfig;
  inputs: StandardLboInputValues;
  definition: SensitivityDefinition;
  expectedMoicByCoordinate: Readonly<Record<string, string>>;
}

export type GoldenUnderwritingCase = GoldenLboCase | GoldenReturnsCase | GoldenSensitivityCase;

const D = decimal;
const CASE_ID = "11111111-1111-4111-8111-111111111111";
const WORLD_AT = "2026-12-31T23:59:59.000Z";

function series(periodIds: readonly string[], values: readonly string[]): Readonly<Record<string, DecimalString>> {
  if (periodIds.length !== values.length) throw new Error("Independent fixture series length mismatch");
  return Object.fromEntries(periodIds.map((periodId, index) => [periodId, D(values[index]!)]));
}

function repeated(periodIds: readonly string[], value: string): Readonly<Record<string, DecimalString>> {
  return series(periodIds, periodIds.map(() => value));
}

function termDefinition(overrides: Partial<StandardDebtTrancheDefinition> = {}): StandardDebtTrancheDefinition {
  return {
    id: "term", name: "Term Loan", kind: "term", seniority: 1, sweepPriority: 1,
    rateType: "fixed", interestBasis: "beginning_balance", amortization: "original_principal_percent",
    cashSweepEligible: true, maturityTreatment: "mandatory_repayment", ...overrides,
  };
}

function annualBase(modelVersion: string): { config: StandardLboModelConfig; inputs: StandardLboInputValues; periodId: string } {
  const periodDefinition = { frequency: "annual" as const, forecastStart: "2027-01-01", count: 1, fiscalYearStartMonth: 1 };
  const periodId = buildPeriods(periodDefinition)[0]!.id;
  const config: StandardLboModelConfig = {
    modelVersion,
    currency: "USD",
    periodDefinition,
    entryValuationMethod: "direct_enterprise_value",
    revenueMethod: "explicit",
    ebitdaMethod: "explicit",
    dAndATreatment: "ebitda_equals_ebit",
    capexMethod: "explicit",
    workingCapitalMethod: "explicit_nwc",
    debtTranches: [termDefinition()],
  };
  const inputs: StandardLboInputValues = {
    investmentCaseId: CASE_ID,
    worldAt: WORLD_AT,
    entry: {
      valuationDate: "2026-12-31", enterpriseValue: D("100"), cashAcquired: D("0"), existingDebt: D("0"),
      otherDebtLike: D("0"), transactionFees: D("0"), financingFees: D("0"), minimumCashFunding: D("0"), rolloverEquity: D("0"),
    },
    operating: {
      revenue: { [periodId]: D("100") }, ebitda: { [periodId]: D("20") }, capex: { [periodId]: D("0") },
      openingNwc: D("0"), nwc: { [periodId]: D("0") }, cashTaxRates: { [periodId]: D("0") },
      otherCashAdjustments: { [periodId]: D("0") },
    },
    debt: {
      term: {
        openingPrincipal: D("50"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"),
        mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31",
      },
    },
    cash: { minimum: D("0"), sweepPercentage: D("1") },
    ownership: { sponsor: D("1"), other: D("0") },
    interimDistributions: { [periodId]: D("0") },
    exit: { periodId, multiple: D("5"), adjustments: D("0") },
  };
  return { config, inputs, periodId };
}

const ALL_CHECKS_PASS = Object.freeze({
  "check.sources_uses": true,
  "check.ownership": true,
  "check.debt_roll_forward": true,
  "check.minimum_cash": true,
  "check.revolver_capacity": true,
  "check.cash_sweep": true,
  "check.debt_maturity": true,
  "check.solver_convergence": true,
  "check.exit_bridge": true,
  "check.sponsor_cash_flows": true,
});

function onePeriodCashFlows(initial: string, terminal: string, periodId: string, entryDate = "2026-12-31"): SponsorCashFlow[] {
  return [
    { amount: D(`-${initial}`), date: entryDate, type: "initial_investment" },
    { amount: D(terminal), date: "2027-12-31", periodId, type: "exit_distribution" },
  ];
}

function baseExpected(periodId: string): GoldenLboCase["expected"] {
  return {
    status: "SUCCEEDED",
    validity: "VALID",
    values: {
      "transaction.entry_enterprise_value": "100",
      "sources_uses.total_uses": "100",
      "sources_uses.total_sources": "100",
      "sources_uses.sponsor_equity": "50",
      "forecast.unlevered_fcf": { [periodId]: "20" },
      "debt.total.ending_principal": { [periodId]: "30" },
      "cash.ending": { [periodId]: "0" },
      "exit.enterprise_value": "100",
      "exit.equity_value": "70",
    },
    checks: ALL_CHECKS_PASS,
    debtRollForward: [{ trancheId: "term", periodId, opening: "50", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "20", ending: "30" }],
    sponsorCashFlows: onePeriodCashFlows("50", "70", periodId),
    returns: { moic: "1.4", irr: "0.4", xirr: "0.4", tolerance: "0.000000000000000000001" },
  };
}

function caseSimpleAnnual(): GoldenLboCase {
  const fixture = annualBase("golden-01");
  return { kind: "lbo", id: "01-simple-annual-single-tranche", responsibility: "simple annual single-tranche LBO", referenceMethod: "hand bridge: 100 uses = 50 debt + 50 sponsor; 20 FCF sweeps debt to 30; 100 EV - 30 debt = 70 equity", ...fixture, expected: baseExpected(fixture.periodId) };
}

function caseQuarterly(): GoldenLboCase {
  const periodDefinition = { frequency: "quarterly" as const, forecastStart: "2027-01-01", count: 4, fiscalYearStartMonth: 1 };
  const periods = buildPeriods(periodDefinition);
  const periodIds = periods.map((period) => period.id);
  const base = annualBase("golden-02");
  base.config.periodDefinition = periodDefinition;
  base.inputs.operating.revenue = repeated(periodIds, "25");
  base.inputs.operating.ebitda = repeated(periodIds, "5");
  base.inputs.operating.capex = repeated(periodIds, "0");
  base.inputs.operating.nwc = repeated(periodIds, "0");
  base.inputs.operating.cashTaxRates = repeated(periodIds, "0");
  base.inputs.operating.otherCashAdjustments = repeated(periodIds, "0");
  base.inputs.interimDistributions = repeated(periodIds, "0");
  base.inputs.exit.periodId = periodIds[3]!;
  base.inputs.exit.multiple = D("20");
  const balances = [["50", "45"], ["45", "40"], ["40", "35"], ["35", "30"]] as const;
  return {
    kind: "lbo", id: "02-quarterly-forecast", responsibility: "quarterly forecast LBO", referenceMethod: "four independently enumerated 5-unit quarterly FCF sweeps",
    config: base.config, inputs: base.inputs,
    expected: {
      status: "SUCCEEDED", validity: "VALID",
      values: { "forecast.unlevered_fcf": Object.fromEntries(periodIds.map((id) => [id, "5"])), "debt.total.ending_principal": Object.fromEntries(periodIds.map((id, index) => [id, balances[index]![1]])), "exit.enterprise_value": "100", "exit.equity_value": "70" },
      checks: ALL_CHECKS_PASS,
      debtRollForward: periodIds.map((periodId, index) => ({ trancheId: "term", periodId, opening: balances[index]![0], cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "5", ending: balances[index]![1] })),
      sponsorCashFlows: [
        { amount: D("-50"), date: "2026-12-31", type: "initial_investment" },
        ...periods.map((period, index) => ({ amount: D(index === 3 ? "70" : "0"), date: period.endDate, periodId: period.id, type: index === 3 ? "exit_distribution" as const : "interim_distribution" as const })),
      ],
      returns: { moic: "1.4", irr: "0.4", xirr: "0.4", tolerance: "0.000000000000000001" },
    },
  };
}

function caseDirectEvNetDebt(): GoldenLboCase {
  const fixture = annualBase("golden-03");
  fixture.inputs.entry.cashAcquired = D("10");
  fixture.inputs.entry.existingDebt = D("20");
  fixture.inputs.debt.term!.openingPrincipal = D("50");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "transaction.purchase_equity_value": "90", "sources_uses.total_uses": "110", "sources_uses.total_sources": "110", "sources_uses.sponsor_equity": "60", "cash.ending": { [fixture.periodId]: "0" }, "debt.total.ending_principal": { [fixture.periodId]: "20" }, "exit.equity_value": "80" };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "30", ending: "20" }];
  expected.sponsorCashFlows = onePeriodCashFlows("60", "80", fixture.periodId);
  expected.returns = { moic: "1.333333333333333333333333333333333", irr: "0.3333333333333333333333333333333333", xirr: "0.3333333333333333333333333333333333", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "03-direct-ev-net-debt", responsibility: "direct EV entry and explicit net-debt bridge", referenceMethod: "purchase equity = 100 EV - 20 debt + 10 cash = 90; refinance produces 110 uses; acquired cash increases sweep capacity", ...fixture, expected };
}

function caseMetricMultiple(): GoldenLboCase {
  const fixture = annualBase("golden-04");
  fixture.config.entryValuationMethod = "metric_multiple";
  delete fixture.inputs.entry.enterpriseValue;
  fixture.inputs.entry.metricValue = D("20");
  fixture.inputs.entry.multiple = D("5");
  return { kind: "lbo", id: "04-ebitda-entry-multiple", responsibility: "EBITDA × entry-multiple valuation", referenceMethod: "20 entry metric × 5.0x = 100 entry EV", ...fixture, expected: baseExpected(fixture.periodId) };
}

function caseFees(): GoldenLboCase {
  const fixture = annualBase("golden-05");
  fixture.inputs.entry.transactionFees = D("5");
  fixture.inputs.entry.financingFees = D("5");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "sources_uses.total_uses": "110", "sources_uses.total_sources": "110", "sources_uses.sponsor_equity": "60" };
  expected.sponsorCashFlows = onePeriodCashFlows("60", "70", fixture.periodId);
  expected.returns = { moic: "1.166666666666666666666666666666667", irr: "0.1666666666666666666666666666666667", xirr: "0.1666666666666666666666666666666667", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "05-transaction-financing-fees", responsibility: "transaction and financing fees", referenceMethod: "100 purchase + 5 transaction + 5 financing = 110 uses; 50 debt leaves 60 sponsor investment", ...fixture, expected };
}

function caseFixedRate(): GoldenLboCase {
  const fixture = annualBase("golden-06");
  fixture.inputs.debt.term!.fixedRate = D("0.1");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "debt.total.cash_interest": { [fixture.periodId]: "5" }, "forecast.levered_fcf": { [fixture.periodId]: "15" }, "debt.total.ending_principal": { [fixture.periodId]: "35" }, "exit.equity_value": "65" };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "5", pik: "0", draw: "0", mandatory: "0", sweep: "15", ending: "35" }];
  expected.sponsorCashFlows = onePeriodCashFlows("50", "65", fixture.periodId);
  expected.returns = { moic: "1.3", irr: "0.3", xirr: "0.3", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "06-fixed-rate-debt", responsibility: "fixed-rate cash interest", referenceMethod: "50 beginning debt × 10% × 365/365 = 5 cash interest; 15 residual FCF sweeps principal", ...fixture, expected };
}

function caseFloatingFloor(): GoldenLboCase {
  const fixture = annualBase("golden-07");
  fixture.config.debtTranches = [termDefinition({ rateType: "floating" })];
  fixture.inputs.debt = { term: {
    openingPrincipal: D("50"), baseRates: { [fixture.periodId]: D("0.02") }, spread: D("0.01"), floor: D("0.04"),
    cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31",
  } };
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "debt.term.effective_rate": { [fixture.periodId]: "0.05" }, "debt.total.cash_interest": { [fixture.periodId]: "2.5" }, "debt.total.ending_principal": { [fixture.periodId]: "32.5" }, "exit.equity_value": "67.5" };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "2.5", pik: "0", draw: "0", mandatory: "0", sweep: "17.5", ending: "32.5" }];
  expected.sponsorCashFlows = onePeriodCashFlows("50", "67.5", fixture.periodId);
  expected.returns = { moic: "1.35", irr: "0.35", xirr: "0.35", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "07-floating-rate-floor", responsibility: "floating rate plus floor", referenceMethod: "max(2% base, 4% floor) + 1% spread = 5%; 2.5 cash interest", ...fixture, expected };
}

function caseCashPik(): GoldenLboCase {
  const fixture = annualBase("golden-08");
  fixture.inputs.debt.term!.fixedRate = D("0.1");
  fixture.inputs.debt.term!.cashInterestShare = D("0.6");
  fixture.inputs.debt.term!.pikInterestShare = D("0.4");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "debt.total.cash_interest": { [fixture.periodId]: "3" }, "debt.total.pik_interest": { [fixture.periodId]: "2" }, "debt.total.cash_sweep": { [fixture.periodId]: "17" }, "debt.total.ending_principal": { [fixture.periodId]: "35" }, "exit.equity_value": "65" };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "3", pik: "2", draw: "0", mandatory: "0", sweep: "17", ending: "35" }];
  expected.sponsorCashFlows = onePeriodCashFlows("50", "65", fixture.periodId);
  expected.returns = { moic: "1.3", irr: "0.3", xirr: "0.3", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "08-cash-and-pik", responsibility: "cash/PIK interest separation", referenceMethod: "5 total interest × 60% = 3 cash and × 40% = 2 PIK; 50 + 2 - 17 sweep = 35", ...fixture, expected };
}

function caseMultipleTranches(): GoldenLboCase {
  const fixture = annualBase("golden-09");
  fixture.config.debtTranches = [termDefinition({ id: "senior", name: "Senior", sweepPriority: 1 }), termDefinition({ id: "seller", name: "Seller Note", kind: "seller_note", seniority: 2, sweepPriority: 2, cashSweepEligible: false })];
  fixture.inputs.debt = {
    senior: { openingPrincipal: D("40"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31" },
    seller: { openingPrincipal: D("10"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31" },
  };
  const expected = baseExpected(fixture.periodId);
  expected.debtRollForward = [
    { trancheId: "senior", periodId: fixture.periodId, opening: "40", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "20", ending: "20" },
    { trancheId: "seller", periodId: fixture.periodId, opening: "10", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "0", ending: "10" },
  ];
  return { kind: "lbo", id: "09-multiple-tranches", responsibility: "multiple debt tranches", referenceMethod: "20 sweep applies only to eligible senior debt; seller note remains at 10", ...fixture, expected };
}

function caseMandatoryAmortization(): GoldenLboCase {
  const fixture = annualBase("golden-10");
  fixture.inputs.debt.term!.mandatoryAmortizationRate = D("0.1");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "debt.total.mandatory_amortization": { [fixture.periodId]: "5" }, "debt.total.cash_sweep": { [fixture.periodId]: "15" } };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "0", pik: "0", draw: "0", mandatory: "5", sweep: "15", ending: "30" }];
  return { kind: "lbo", id: "10-mandatory-amortization", responsibility: "mandatory amortization", referenceMethod: "10% of original 50 = 5 mandatory; residual 15 FCF sweeps", ...fixture, expected };
}

function caseRevolverMinimumCash(): GoldenLboCase {
  const fixture = annualBase("golden-11");
  fixture.config.debtTranches = [termDefinition({ id: "revolver", name: "Revolver", kind: "revolver", seniority: 0, sweepPriority: 0, amortization: "explicit_amount", cashSweepEligible: false })];
  fixture.inputs.debt = {
    revolver: { openingPrincipal: D("0"), commitment: D("15"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationAmounts: { [fixture.periodId]: D("0") }, maturityDate: "2027-12-31" },
  };
  fixture.inputs.operating.capex = { [fixture.periodId]: D("30") };
  fixture.inputs.cash.minimum = D("5");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "sources_uses.sponsor_equity": "100", "forecast.unlevered_fcf": { [fixture.periodId]: "-10" }, "debt.total.draw": { [fixture.periodId]: "15" }, "debt.total.ending_principal": { [fixture.periodId]: "15" }, "cash.ending": { [fixture.periodId]: "5" }, "exit.equity_value": "90" };
  expected.debtRollForward = [{ trancheId: "revolver", periodId: fixture.periodId, opening: "0", cashInterest: "0", pik: "0", draw: "15", mandatory: "0", sweep: "0", ending: "15" }];
  expected.sponsorCashFlows = onePeriodCashFlows("100", "90", fixture.periodId);
  expected.returns = { moic: "0.9", irr: "-0.1", xirr: "-0.1", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "11-revolver-minimum-cash", responsibility: "revolver draw and minimum cash", referenceMethod: "-10 FCF plus 5 minimum cash creates exact 15 revolver draw", ...fixture, expected };
}

function caseSweepWaterfall(): GoldenLboCase {
  const fixture = annualBase("golden-12");
  fixture.config.debtTranches = [termDefinition({ id: "senior", name: "Senior", sweepPriority: 1 }), termDefinition({ id: "junior", name: "Junior", seniority: 2, sweepPriority: 2 })];
  fixture.inputs.debt = {
    senior: { openingPrincipal: D("30"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31" },
    junior: { openingPrincipal: D("20"), fixedRate: D("0"), cashInterestShare: D("1"), pikInterestShare: D("0"), mandatoryAmortizationRate: D("0"), maturityDate: "2027-12-31" },
  };
  fixture.inputs.operating.ebitda = { [fixture.periodId]: D("35") };
  fixture.inputs.exit.multiple = D("2.857142857142857142857142857142857");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "forecast.unlevered_fcf": { [fixture.periodId]: "35" }, "debt.total.cash_sweep": { [fixture.periodId]: "35" }, "debt.total.ending_principal": { [fixture.periodId]: "15" }, "exit.enterprise_value": "100", "exit.equity_value": "85" };
  expected.debtRollForward = [
    { trancheId: "senior", periodId: fixture.periodId, opening: "30", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "30", ending: "0" },
    { trancheId: "junior", periodId: fixture.periodId, opening: "20", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "5", ending: "15" },
  ];
  expected.sponsorCashFlows = onePeriodCashFlows("50", "85", fixture.periodId);
  expected.returns = { moic: "1.7", irr: "0.7", xirr: "0.7", tolerance: "0.00000000000000000001" };
  return { kind: "lbo", id: "12-cash-sweep-waterfall", responsibility: "cash sweep waterfall", referenceMethod: "35 FCF repays 30 senior before 5 junior; no lower-priority repayment while senior remains", ...fixture, expected };
}

function caseAverageBalance(): GoldenLboCase {
  const fixture = annualBase("golden-13");
  fixture.config.debtTranches = [termDefinition({ interestBasis: "average_balance" })];
  fixture.config.solver = { algorithm: "fixed_point", initialState: "opening_balance", absoluteTolerance: D("0.000000000001"), relativeTolerance: D("0.000000000001"), maxIterations: 200 };
  fixture.inputs.debt.term!.fixedRate = D("0.1");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "debt.total.cash_interest": { [fixture.periodId]: "4.210526315789473684210526315789474" }, "debt.total.cash_sweep": { [fixture.periodId]: "15.78947368421052631578947368421053" }, "debt.total.ending_principal": { [fixture.periodId]: "34.21052631578947368421052631578947" }, "exit.equity_value": "65.78947368421052631578947368421053" };
  expected.debtRollForward = [{ trancheId: "term", periodId: fixture.periodId, opening: "50", cashInterest: "4.210526315789473684210526315789474", pik: "0", draw: "0", mandatory: "0", sweep: "15.78947368421052631578947368421053", ending: "34.21052631578947368421052631578947" }];
  expected.sponsorCashFlows = onePeriodCashFlows("50", "65.78947368421052631578947368421053", fixture.periodId);
  expected.returns = { moic: "1.315789473684210526315789473684211", irr: "0.3157894736842105263157894736842105", xirr: "0.3157894736842105263157894736842105", tolerance: "0.00000000001" };
  return { kind: "lbo", id: "13-average-balance-circularity", responsibility: "average-balance interest and bounded circularity", referenceMethod: "independent algebra: E = 50 - (20 - .1×(50+E)/2), yielding E=650/19 and interest=80/19", ...fixture, expected };
}

function caseExitMultiple(): GoldenLboCase {
  const fixture = annualBase("golden-14");
  fixture.inputs.exit.multiple = D("6");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "exit.enterprise_value": "120", "exit.equity_value": "90" };
  expected.sponsorCashFlows = onePeriodCashFlows("50", "90", fixture.periodId);
  expected.returns = { moic: "1.8", irr: "0.8", xirr: "0.8", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "14-exit-multiple", responsibility: "exit multiple valuation", referenceMethod: "20 exit EBITDA × 6.0x = 120 EV; less 30 debt = 90 sponsor proceeds", ...fixture, expected };
}

function caseSponsorOwnership(): GoldenLboCase {
  const fixture = annualBase("golden-15");
  fixture.inputs.entry.rolloverEquity = D("10");
  fixture.inputs.ownership.sponsor = D("0.8");
  fixture.inputs.ownership.other = D("0.2");
  const expected = baseExpected(fixture.periodId);
  expected.values = { ...expected.values, "sources_uses.sponsor_equity": "40", "returns.sponsor_exit_proceeds": "56" };
  expected.sponsorCashFlows = onePeriodCashFlows("40", "56", fixture.periodId);
  expected.returns = { moic: "1.4", irr: "0.4", xirr: "0.4", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "15-sponsor-ownership-rollover", responsibility: "sponsor ownership and rollover", referenceMethod: "10 rollover reduces sponsor cheque to 40; sponsor owns 80% of 70 exit equity = 56", ...fixture, expected };
}

function caseInterimDistribution(): GoldenLboCase {
  const fixture = annualBase("golden-16");
  fixture.config.periodDefinition = { frequency: "annual", forecastStart: "2027-01-01", count: 2, fiscalYearStartMonth: 1 };
  const periods = buildPeriods(fixture.config.periodDefinition);
  const ids = periods.map((period) => period.id);
  fixture.inputs.operating.revenue = repeated(ids, "100");
  fixture.inputs.operating.ebitda = repeated(ids, "20");
  fixture.inputs.operating.capex = repeated(ids, "0");
  fixture.inputs.operating.nwc = repeated(ids, "0");
  fixture.inputs.operating.cashTaxRates = repeated(ids, "0");
  fixture.inputs.operating.otherCashAdjustments = repeated(ids, "0");
  fixture.inputs.interimDistributions = series(ids, ["10", "0"]);
  fixture.inputs.exit.periodId = ids[1]!;
  fixture.inputs.debt.term!.maturityDate = "2028-12-31";
  return {
    kind: "lbo", id: "16-interim-distribution", responsibility: "interim sponsor distribution", referenceMethod: "year-one 20 FCF funds 10 distribution and 10 sweep; year-two leaves 20 debt; periodic root solves 50x²-10x-80=0 and ACT/365F separately uses the 731-day leap span",
    config: fixture.config, inputs: fixture.inputs,
    expected: {
      status: "SUCCEEDED", validity: "VALID",
      values: { "debt.total.ending_principal": { [ids[0]!]: "40", [ids[1]!]: "20" }, "exit.equity_value": "80" },
      checks: ALL_CHECKS_PASS,
      debtRollForward: [
        { trancheId: "term", periodId: ids[0]!, opening: "50", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "10", ending: "40" },
        { trancheId: "term", periodId: ids[1]!, opening: "40", cashInterest: "0", pik: "0", draw: "0", mandatory: "0", sweep: "20", ending: "20" },
      ],
      sponsorCashFlows: [
        { amount: D("-50"), date: "2026-12-31", type: "initial_investment" },
        { amount: D("10"), date: periods[0]!.endDate, periodId: ids[0]!, type: "interim_distribution" },
        { amount: D("80"), date: periods[1]!.endDate, periodId: ids[1]!, type: "exit_distribution" },
      ],
      returns: { moic: "1.8", irr: "0.368857754044952038019377274608949", xirr: "0.3683162022744893386471963349138659", tolerance: "0.000000000000000000001" },
    },
  };
}

function caseIrregularXirr(): GoldenLboCase {
  const fixture = annualBase("golden-17");
  fixture.inputs.entry.valuationDate = "2026-06-30";
  const expected = baseExpected(fixture.periodId);
  expected.sponsorCashFlows = onePeriodCashFlows("50", "70", fixture.periodId, "2026-06-30");
  expected.returns = { moic: "1.4", irr: "0.4", xirr: "0.2506981837441586339410425619292883", tolerance: "0.000000000000000000001" };
  return { kind: "lbo", id: "17-irregular-date-xirr", responsibility: "ACT/365F irregular-date XIRR", referenceMethod: "independent equation 50 = 70/(1+r)^(549/365), so r = 1.4^(365/549)-1", ...fixture, expected };
}

function caseIrrUndefined(): GoldenLboCase {
  const fixture = annualBase("golden-18");
  fixture.config.debtTranches = [];
  fixture.inputs.debt = {};
  fixture.inputs.operating.ebitda = { [fixture.periodId]: D("0") };
  fixture.inputs.exit.multiple = D("0");
  return {
    kind: "lbo", id: "18-irr-undefined", responsibility: "IRR undefined without sign-changing distributions", referenceMethod: "cash-flow signs are [-100, 0], so no root exists by definition",
    config: fixture.config, inputs: fixture.inputs,
    expected: {
      status: "FAILED", validity: "INCOMPLETE", values: { "sources_uses.sponsor_equity": "100", "exit.equity_value": "0" }, checks: {}, debtRollForward: [],
      sponsorCashFlows: onePeriodCashFlows("100", "0", fixture.periodId), returns: null, failureCode: "IRR_UNDEFINED",
    },
  };
}

function caseIrrAmbiguous(): GoldenReturnsCase {
  return {
    kind: "returns", id: "19-multiple-root-irr", responsibility: "multiple-root / ambiguous IRR",
    referenceMethod: "independent polynomial -100x² + 230x - 132 = 0 has discount factors x=1.1 and x=1.2 (IRRs 10% and 20%)",
    cashFlows: [
      { amount: D("-100"), date: "2026-12-31", type: "initial_investment" },
      { amount: D("230"), date: "2027-12-31", periodId: "P001", type: "interim_distribution" },
      { amount: D("-132"), date: "2028-12-31", periodId: "P002", type: "subsequent_contribution" },
    ],
    expectedFailureCode: "IRR_AMBIGUOUS",
  };
}

function caseDownsideSensitivity(): GoldenSensitivityCase {
  const fixture = annualBase("golden-20");
  fixture.config.entryValuationMethod = "metric_multiple";
  delete fixture.inputs.entry.enterpriseValue;
  fixture.inputs.entry.metricValue = D("20");
  fixture.inputs.entry.multiple = D("5");
  return {
    kind: "sensitivity", id: "20-downside-two-way-sensitivity", responsibility: "downside scenario and two-way sensitivity",
    referenceMethod: "hand matrix: sponsor investment is entry EV minus 50 debt; terminal proceeds are exit EV minus 30 debt",
    config: fixture.config, inputs: fixture.inputs,
    definition: {
      schemaVersion: "underwriting-sensitivity.v1", name: "Entry / exit multiple",
      rowAxis: { nodeId: "entry.multiple", values: [D("4"), D("6")] },
      columnAxis: { nodeId: "exit.multiple", values: [D("4"), D("6")] },
      outputNodeIds: ["gross_sponsor_moic"],
    },
    expectedMoicByCoordinate: {
      "0:0": "1.666666666666666666666666666666667",
      "0:1": "3",
      "1:0": "0.7142857142857142857142857142857143",
      "1:1": "1.285714285714285714285714285714286",
    },
  };
}

export const GOLDEN_UNDERWRITING_CASES: readonly GoldenUnderwritingCase[] = Object.freeze([
  caseSimpleAnnual(),
  caseQuarterly(),
  caseDirectEvNetDebt(),
  caseMetricMultiple(),
  caseFees(),
  caseFixedRate(),
  caseFloatingFloor(),
  caseCashPik(),
  caseMultipleTranches(),
  caseMandatoryAmortization(),
  caseRevolverMinimumCash(),
  caseSweepWaterfall(),
  caseAverageBalance(),
  caseExitMultiple(),
  caseSponsorOwnership(),
  caseInterimDistribution(),
  caseIrregularXirr(),
  caseIrrUndefined(),
  caseIrrAmbiguous(),
  caseDownsideSensitivity(),
]);
