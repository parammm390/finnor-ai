import { deepFreeze } from "./canonical";
import { abs, add, cmp, d, decimal, div, max, min, mul, sub, withinTolerance, ZERO, ONE, type DecimalString } from "./decimal";
import { UnderwritingError, fail } from "./errors";
import { addDays, daysBetween, formatDateOnly, parseDateOnly } from "./periods";
import { annualizePeriodicIrr, solvePeriodicIrr, solveXirr, type SponsorCashFlow } from "./returns";
import { finalizeRunResult } from "./result";
import { assertSnapshotMatchesModel, sealInputSnapshot } from "./snapshot";
import {
  FINANCIAL_CONVENTION_VERSION,
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_MODEL_SCHEMA_VERSION,
  type CheckNode,
  type CheckResult,
  type CompiledUnderwritingModel,
  type FinancialPeriod,
  type InputNode,
  type InputProvenanceRef,
  type InputSourceBinding,
  type InputTruthStatus,
  type ModelNode,
  type ModelValue,
  type NodeExecutionResult,
  type PeriodDefinition,
  type ResolvedInput,
  type SolverDiagnostic,
  type SolverSettings,
  type StandardDebtTrancheDefinition,
  type TruthClass,
  type UnderwritingInputSnapshot,
  type UnderwritingModelIR,
  type UnderwritingRunResult,
  type ValueShape,
  type ValueType,
  type ValueUnit,
} from "./types";

export const STANDARD_LBO_MODEL_KEY = "standard_lbo_v1" as const;
export const STANDARD_LBO_CHECK_TOLERANCE = decimal("0.00000001");

export const STANDARD_LBO_CAPABILITIES = deepFreeze({
  entry_ev_metric_multiple: "SUPPORTED",
  direct_entry_ev: "SUPPORTED",
  net_debt_bridge: "SUPPORTED",
  transaction_fees: "SUPPORTED",
  financing_fees: "SUPPORTED",
  sponsor_equity_plug: "SUPPORTED",
  rollover: "SUPPORTED",
  seller_note: "SUPPORTED",
  fixed_rate_debt: "SUPPORTED",
  floating_rate_debt: "SUPPORTED",
  rate_floor: "SUPPORTED",
  cash_interest: "SUPPORTED",
  pik: "SUPPORTED",
  mandatory_amortization: "SUPPORTED",
  revolver: "SUPPORTED",
  minimum_cash: "SUPPORTED",
  cash_sweep: "SUPPORTED",
  average_balance_interest: "SUPPORTED",
  circularity: "SUPPORTED",
  debt_maturity_refinancing: "PARTIAL",
  revenue_growth_model: "SUPPORTED",
  ebitda_margin_model: "SUPPORTED",
  d_and_a: "SUPPORTED",
  cash_taxes: "SUPPORTED",
  nol: "UNSUPPORTED",
  capex: "SUPPORTED",
  nwc: "SUPPORTED",
  interim_distributions: "SUPPORTED",
  dividend_recap: "UNSUPPORTED",
  exit_multiple: "SUPPORTED",
  sponsor_ownership: "SUPPORTED",
  moic: "SUPPORTED",
  periodic_irr: "SUPPORTED",
  xirr: "SUPPORTED",
  one_way_sensitivity: "SUPPORTED",
  two_way_sensitivity: "SUPPORTED",
  multi_currency: "UNSUPPORTED",
  add_on_acquisitions: "UNSUPPORTED",
  management_option_pool: "UNSUPPORTED",
  preferred_equity: "UNSUPPORTED",
  complex_waterfall: "UNSUPPORTED",
  fund_carry: "UNSUPPORTED",
  management_fees: "UNSUPPORTED",
  lp_returns: "UNSUPPORTED",
} as const);

export interface StandardLboModelConfig {
  modelKey?: string;
  modelVersion: string;
  currency: string;
  periodDefinition: PeriodDefinition;
  entryValuationMethod: "direct_enterprise_value" | "metric_multiple";
  revenueMethod: "explicit" | "growth";
  ebitdaMethod: "explicit" | "margin";
  dAndATreatment: "explicit" | "ebitda_equals_ebit";
  capexMethod: "explicit" | "percent_revenue";
  workingCapitalMethod: "explicit_nwc" | "percent_revenue";
  debtTranches: readonly StandardDebtTrancheDefinition[];
  solver?: SolverSettings;
  inputBindings?: Readonly<Record<string, InputSourceBinding>>;
}

export interface StandardDebtTrancheInputs {
  openingPrincipal: DecimalString;
  commitment?: DecimalString;
  fixedRate?: DecimalString;
  baseRates?: Readonly<Record<string, DecimalString>>;
  spread?: DecimalString;
  floor?: DecimalString;
  cashInterestShare: DecimalString;
  pikInterestShare: DecimalString;
  mandatoryAmortizationRate?: DecimalString;
  mandatoryAmortizationAmounts?: Readonly<Record<string, DecimalString>>;
  maturityDate: string;
}

export interface StandardLboInputValues {
  investmentCaseId: string;
  worldAt: string;
  entry: {
    valuationDate: string;
    metricValue?: DecimalString;
    multiple?: DecimalString;
    enterpriseValue?: DecimalString;
    cashAcquired: DecimalString;
    existingDebt: DecimalString;
    otherDebtLike: DecimalString;
    transactionFees: DecimalString;
    financingFees: DecimalString;
    minimumCashFunding: DecimalString;
    rolloverEquity: DecimalString;
  };
  operating: {
    baseRevenue?: DecimalString;
    revenue?: Readonly<Record<string, DecimalString>>;
    growthRates?: Readonly<Record<string, DecimalString>>;
    ebitda?: Readonly<Record<string, DecimalString>>;
    ebitdaMargins?: Readonly<Record<string, DecimalString>>;
    depreciationAndAmortization?: Readonly<Record<string, DecimalString>>;
    capex?: Readonly<Record<string, DecimalString>>;
    capexRates?: Readonly<Record<string, DecimalString>>;
    openingNwc: DecimalString;
    nwc?: Readonly<Record<string, DecimalString>>;
    nwcRates?: Readonly<Record<string, DecimalString>>;
    cashTaxRates: Readonly<Record<string, DecimalString>>;
    otherCashAdjustments: Readonly<Record<string, DecimalString>>;
  };
  debt: Readonly<Record<string, StandardDebtTrancheInputs>>;
  cash: {
    minimum: DecimalString;
    sweepPercentage: DecimalString;
  };
  ownership: {
    sponsor: DecimalString;
    other: DecimalString;
  };
  interimDistributions: Readonly<Record<string, DecimalString>>;
  exit: {
    periodId: string;
    multiple: DecimalString;
    adjustments: DecimalString;
  };
  inputTruth?: Readonly<Record<string, {
    truthClass: TruthClass;
    status?: InputTruthStatus;
    provenance?: readonly InputProvenanceRef[];
    reason?: string;
  }>>;
}

function inputNode(
  id: string,
  valueType: ValueType,
  unit: ValueUnit,
  shape: ValueShape,
  currency: string | undefined,
  binding: InputSourceBinding | undefined,
  bounds?: { minimum?: DecimalString; maximum?: DecimalString },
): InputNode {
  return {
    id, kind: "input", valueType, unit, shape, dependencies: [], required: true,
    ...(currency ? { currency } : {}),
    ...(binding ? { source: binding } : {}),
    ...bounds,
  };
}

function scheduleNode(
  id: string,
  valueType: ValueType,
  unit: ValueUnit,
  shape: ValueShape,
  dependencies: readonly string[],
  currency?: string,
): ModelNode {
  return {
    id, kind: "schedule", valueType, unit, shape, dependencies: [...new Set(dependencies)].sort(),
    ...(currency ? { currency } : {}),
    schedule: { kind: "standard_lbo_v1", line: id },
  };
}

function outputNode(id: string, sourceNodeId: string, source: ModelNode): ModelNode {
  return {
    id, kind: "output", valueType: source.valueType, unit: source.unit, shape: source.shape,
    ...(source.currency ? { currency: source.currency } : {}), dependencies: [sourceNodeId], sourceNodeId,
  };
}

function checkNode(id: string, sourceNodeId: string, failureCode: CheckNode["failureCode"]): CheckNode {
  return {
    id, kind: "check", valueType: "boolean", unit: "boolean", shape: "scalar",
    dependencies: [sourceNodeId], assertion: { op: "ref", nodeId: sourceNodeId }, failureCode, severity: "error",
  };
}

function debtInputId(trancheId: string, field: string): string {
  return `debt_input.${trancheId}.${field}`;
}

const defaultSolver = (): SolverSettings => ({
  algorithm: "fixed_point",
  initialState: "opening_balance",
  absoluteTolerance: decimal("0.00000001"),
  relativeTolerance: decimal("0.000000000001"),
  maxIterations: 100,
});

export function createStandardLboModel(config: StandardLboModelConfig): UnderwritingModelIR {
  const currency = config.currency;
  const bindings = config.inputBindings ?? {};
  const nodes: ModelNode[] = [];
  const addInput = (id: string, valueType: ValueType, unit: ValueUnit, shape: ValueShape = "scalar", money = false, bounds?: { minimum?: DecimalString; maximum?: DecimalString }) => {
    nodes.push(inputNode(id, valueType, unit, shape, money ? currency : undefined, bindings[id], bounds));
    return id;
  };
  const nonnegative = { minimum: ZERO };
  const rate = { minimum: ZERO, maximum: ONE };

  addInput("entry.valuation_date", "date", "date");
  if (config.entryValuationMethod === "metric_multiple") {
    addInput("entry.metric_value", "decimal", "money", "scalar", true, nonnegative);
    addInput("entry.multiple", "decimal", "multiple", "scalar", false, nonnegative);
  } else addInput("entry.enterprise_value", "decimal", "money", "scalar", true, nonnegative);
  for (const id of ["entry.cash_acquired", "entry.existing_debt", "entry.other_debt_like", "entry.transaction_fees", "entry.financing_fees", "entry.minimum_cash_funding", "entry.rollover_equity"] as const) {
    addInput(id, "decimal", "money", "scalar", true, nonnegative);
  }
  if (config.revenueMethod === "growth") {
    addInput("operating.base_revenue", "decimal", "money", "scalar", true, nonnegative);
    addInput("operating.revenue_growth", "decimal", "rate", "series");
  } else addInput("operating.revenue_explicit", "decimal", "money", "series", true, nonnegative);
  if (config.ebitdaMethod === "margin") addInput("operating.ebitda_margin", "decimal", "rate", "series");
  else addInput("operating.ebitda_explicit", "decimal", "money", "series", true);
  if (config.dAndATreatment === "explicit") addInput("operating.d_and_a", "decimal", "money", "series", true, nonnegative);
  if (config.capexMethod === "percent_revenue") addInput("operating.capex_rate", "decimal", "rate", "series", false, rate);
  else addInput("operating.capex_explicit", "decimal", "money", "series", true, nonnegative);
  addInput("operating.opening_nwc", "decimal", "money", "scalar", true);
  if (config.workingCapitalMethod === "percent_revenue") addInput("operating.nwc_rate", "decimal", "rate", "series");
  else addInput("operating.nwc_explicit", "decimal", "money", "series", true);
  addInput("operating.cash_tax_rate", "decimal", "rate", "series", false, rate);
  addInput("operating.other_cash_adjustments", "decimal", "money", "series", true);
  addInput("cash.minimum", "decimal", "money", "scalar", true, nonnegative);
  addInput("cash.sweep_percentage", "decimal", "rate", "scalar", false, rate);
  addInput("ownership.sponsor", "decimal", "rate", "scalar", false, rate);
  addInput("ownership.other", "decimal", "rate", "scalar", false, rate);
  addInput("distributions.interim", "decimal", "money", "series", true, nonnegative);
  addInput("exit.period_id", "text", "period");
  addInput("exit.multiple", "decimal", "multiple", "scalar", false, nonnegative);
  addInput("exit.adjustments", "decimal", "money", "scalar", true);

  for (const tranche of config.debtTranches) {
    addInput(debtInputId(tranche.id, "opening_principal"), "decimal", "money", "scalar", true, nonnegative);
    if (tranche.kind === "revolver") addInput(debtInputId(tranche.id, "commitment"), "decimal", "money", "scalar", true, nonnegative);
    if (tranche.rateType === "fixed") addInput(debtInputId(tranche.id, "fixed_rate"), "decimal", "rate", "scalar", false, rate);
    else {
      addInput(debtInputId(tranche.id, "base_rate"), "decimal", "rate", "series", false, rate);
      addInput(debtInputId(tranche.id, "spread"), "decimal", "rate", "scalar", false, rate);
      addInput(debtInputId(tranche.id, "floor"), "decimal", "rate", "scalar", false, rate);
    }
    addInput(debtInputId(tranche.id, "cash_interest_share"), "decimal", "rate", "scalar", false, rate);
    addInput(debtInputId(tranche.id, "pik_interest_share"), "decimal", "rate", "scalar", false, rate);
    if (tranche.amortization === "original_principal_percent") addInput(debtInputId(tranche.id, "mandatory_amortization_rate"), "decimal", "rate", "scalar", false, rate);
    else addInput(debtInputId(tranche.id, "mandatory_amortization_amount"), "decimal", "money", "series", true, nonnegative);
    addInput(debtInputId(tranche.id, "maturity_date"), "date", "date");
  }

  const ids = () => nodes.map((node) => node.id);
  const valuationInputs = config.entryValuationMethod === "metric_multiple" ? ["entry.metric_value", "entry.multiple"] : ["entry.enterprise_value"];
  const entryEv = scheduleNode("transaction.entry_enterprise_value", "decimal", "money", "scalar", valuationInputs, currency);
  nodes.push(entryEv);
  nodes.push(scheduleNode("transaction.purchase_equity_value", "decimal", "money", "scalar", [entryEv.id, "entry.cash_acquired", "entry.existing_debt", "entry.other_debt_like"], currency));
  nodes.push(scheduleNode("sources_uses.total_uses", "decimal", "money", "scalar", ["transaction.purchase_equity_value", "entry.existing_debt", "entry.other_debt_like", "entry.transaction_fees", "entry.financing_fees", "entry.minimum_cash_funding"], currency));

  const openingDebtInputs = config.debtTranches.map((tranche) => debtInputId(tranche.id, "opening_principal"));
  nodes.push(scheduleNode("sources_uses.debt_sources", "decimal", "money", "scalar", openingDebtInputs, currency));
  nodes.push(scheduleNode("sources_uses.sponsor_equity", "decimal", "money", "scalar", ["sources_uses.total_uses", "sources_uses.debt_sources", "entry.rollover_equity"], currency));
  nodes.push(scheduleNode("sources_uses.total_sources", "decimal", "money", "scalar", ["sources_uses.debt_sources", "sources_uses.sponsor_equity", "entry.rollover_equity"], currency));

  const revenueDeps = config.revenueMethod === "growth" ? ["operating.base_revenue", "operating.revenue_growth"] : ["operating.revenue_explicit"];
  nodes.push(scheduleNode("forecast.revenue", "decimal", "money", "series", revenueDeps, currency));
  const ebitdaDeps = config.ebitdaMethod === "margin" ? ["forecast.revenue", "operating.ebitda_margin"] : ["operating.ebitda_explicit"];
  nodes.push(scheduleNode("forecast.ebitda", "decimal", "money", "series", ebitdaDeps, currency));
  if (config.dAndATreatment === "explicit") nodes.push(scheduleNode("forecast.d_and_a", "decimal", "money", "series", ["operating.d_and_a"], currency));
  nodes.push(scheduleNode("forecast.ebit", "decimal", "money", "series", ["forecast.ebitda", ...(config.dAndATreatment === "explicit" ? ["forecast.d_and_a"] : [])], currency));
  nodes.push(scheduleNode("forecast.cash_taxes", "decimal", "money", "series", ["forecast.ebit", "operating.cash_tax_rate"], currency));
  const capexDeps = config.capexMethod === "percent_revenue" ? ["forecast.revenue", "operating.capex_rate"] : ["operating.capex_explicit"];
  nodes.push(scheduleNode("forecast.capex", "decimal", "money", "series", capexDeps, currency));
  const nwcDeps = config.workingCapitalMethod === "percent_revenue" ? ["forecast.revenue", "operating.nwc_rate"] : ["operating.nwc_explicit"];
  nodes.push(scheduleNode("forecast.nwc", "decimal", "money", "series", nwcDeps, currency));
  nodes.push(scheduleNode("forecast.change_in_nwc", "decimal", "money", "series", ["forecast.nwc", "operating.opening_nwc"], currency));
  nodes.push(scheduleNode("forecast.unlevered_fcf", "decimal", "money", "series", ["forecast.ebitda", "forecast.cash_taxes", "forecast.capex", "forecast.change_in_nwc", "operating.other_cash_adjustments"], currency));

  const debtCoreInputs = ["forecast.unlevered_fcf", "cash.minimum", "cash.sweep_percentage", "distributions.interim", ...openingDebtInputs];
  const debtLineIds: string[] = [];
  const interestIds: string[] = [];
  const endingIds: string[] = [];
  for (const tranche of config.debtTranches) {
    const prefix = `debt.${tranche.id}`;
    const rateDeps = tranche.rateType === "fixed"
      ? [debtInputId(tranche.id, "fixed_rate")]
      : [debtInputId(tranche.id, "base_rate"), debtInputId(tranche.id, "spread"), debtInputId(tranche.id, "floor")];
    const interestId = `${prefix}.cash_interest`;
    const endingId = `${prefix}.ending_principal`;
    interestIds.push(interestId);
    endingIds.push(endingId);
    const common = [debtInputId(tranche.id, "opening_principal"), debtInputId(tranche.id, "cash_interest_share"), debtInputId(tranche.id, "pik_interest_share"), debtInputId(tranche.id, "maturity_date"), ...rateDeps, ...debtCoreInputs];
    const lineDefinitions: Array<[string, readonly string[]]> = [
      [`${prefix}.opening_principal`, [debtInputId(tranche.id, "opening_principal")]],
      [`${prefix}.effective_rate`, rateDeps],
      [interestId, [...common, ...(tranche.interestBasis === "average_balance" ? [endingId] : [])]],
      [`${prefix}.pik_interest`, [...common, interestId]],
      [`${prefix}.draw`, [...common, ...interestIds]],
      [`${prefix}.mandatory_amortization`, [...common, tranche.amortization === "original_principal_percent" ? debtInputId(tranche.id, "mandatory_amortization_rate") : debtInputId(tranche.id, "mandatory_amortization_amount")]],
      [`${prefix}.cash_sweep`, [...common, ...interestIds]],
      [endingId, [...common, interestId]],
    ];
    for (const [id, deps] of lineDefinitions) {
      debtLineIds.push(id);
      nodes.push(scheduleNode(id, "decimal", id.endsWith("effective_rate") ? "rate" : "money", "series", deps, id.endsWith("effective_rate") ? undefined : currency));
    }
  }
  for (const [id, deps] of [
    ["debt.total.opening_principal", debtLineIds.filter((id) => id.endsWith("opening_principal"))],
    ["debt.total.cash_interest", debtLineIds.filter((id) => id.endsWith("cash_interest"))],
    ["debt.total.pik_interest", debtLineIds.filter((id) => id.endsWith("pik_interest"))],
    ["debt.total.draw", debtLineIds.filter((id) => id.endsWith(".draw"))],
    ["debt.total.mandatory_amortization", debtLineIds.filter((id) => id.endsWith("mandatory_amortization"))],
    ["debt.total.cash_sweep", debtLineIds.filter((id) => id.endsWith("cash_sweep"))],
    ["debt.total.ending_principal", endingIds],
  ] as const) nodes.push(scheduleNode(id, "decimal", "money", "series", deps, currency));
  nodes.push(scheduleNode("cash.ending", "decimal", "money", "series", ["forecast.unlevered_fcf", "debt.total.cash_interest", "debt.total.draw", "debt.total.mandatory_amortization", "debt.total.cash_sweep", "distributions.interim", "cash.minimum"], currency));
  nodes.push(scheduleNode("forecast.levered_fcf", "decimal", "money", "series", ["forecast.unlevered_fcf", "debt.total.cash_interest"], currency));

  nodes.push(scheduleNode("exit.metric_value", "decimal", "money", "scalar", ["forecast.ebitda", "exit.period_id"], currency));
  nodes.push(scheduleNode("exit.enterprise_value", "decimal", "money", "scalar", ["exit.metric_value", "exit.multiple"], currency));
  nodes.push(scheduleNode("exit.debt", "decimal", "money", "scalar", ["debt.total.ending_principal", "exit.period_id"], currency));
  nodes.push(scheduleNode("exit.cash", "decimal", "money", "scalar", ["cash.ending", "exit.period_id"], currency));
  nodes.push(scheduleNode("exit.net_debt", "decimal", "money", "scalar", ["exit.debt", "exit.cash"], currency));
  nodes.push(scheduleNode("exit.equity_value", "decimal", "money", "scalar", ["exit.enterprise_value", "exit.debt", "exit.cash", "exit.adjustments"], currency));
  nodes.push(scheduleNode("returns.sponsor_exit_proceeds", "decimal", "money", "scalar", ["exit.equity_value", "ownership.sponsor"], currency));
  nodes.push(scheduleNode("returns.gross_sponsor_moic", "decimal", "multiple", "scalar", ["sources_uses.sponsor_equity", "returns.sponsor_exit_proceeds", "distributions.interim", "ownership.sponsor"]));
  nodes.push(scheduleNode("returns.gross_sponsor_irr", "decimal", "rate", "scalar", ["sources_uses.sponsor_equity", "returns.sponsor_exit_proceeds", "distributions.interim", "ownership.sponsor", "exit.period_id"]));
  nodes.push(scheduleNode("returns.gross_sponsor_xirr", "decimal", "rate", "scalar", ["entry.valuation_date", "sources_uses.sponsor_equity", "returns.sponsor_exit_proceeds", "distributions.interim", "ownership.sponsor", "exit.period_id"]));

  const checkCalcs = [
    scheduleNode("checkcalc.sources_uses", "boolean", "boolean", "scalar", ["sources_uses.total_uses", "sources_uses.total_sources"]),
    scheduleNode("checkcalc.ownership", "boolean", "boolean", "scalar", ["ownership.sponsor", "ownership.other"]),
    scheduleNode("checkcalc.debt_roll_forward", "boolean", "boolean", "scalar", debtLineIds),
    scheduleNode("checkcalc.minimum_cash", "boolean", "boolean", "scalar", ["cash.ending", "cash.minimum"]),
    scheduleNode("checkcalc.revolver_capacity", "boolean", "boolean", "scalar", debtLineIds),
    scheduleNode("checkcalc.cash_sweep", "boolean", "boolean", "scalar", debtLineIds),
    scheduleNode("checkcalc.debt_maturity", "boolean", "boolean", "scalar", debtLineIds),
    scheduleNode("checkcalc.solver_convergence", "boolean", "boolean", "scalar", debtLineIds),
    scheduleNode("checkcalc.exit_bridge", "boolean", "boolean", "scalar", ["exit.enterprise_value", "exit.debt", "exit.cash", "exit.adjustments", "exit.equity_value"]),
    scheduleNode("checkcalc.sponsor_cash_flows", "boolean", "boolean", "scalar", ["sources_uses.sponsor_equity", "returns.sponsor_exit_proceeds", "distributions.interim", "ownership.sponsor"]),
  ];
  nodes.push(...checkCalcs);
  nodes.push(
    checkNode("check.sources_uses", "checkcalc.sources_uses", "SOURCES_USES_IMBALANCE"),
    checkNode("check.ownership", "checkcalc.ownership", "OWNERSHIP_MISMATCH"),
    checkNode("check.debt_roll_forward", "checkcalc.debt_roll_forward", "DEBT_ROLL_FORWARD_MISMATCH"),
    checkNode("check.minimum_cash", "checkcalc.minimum_cash", "LIQUIDITY_SHORTFALL"),
    checkNode("check.revolver_capacity", "checkcalc.revolver_capacity", "REVOLVER_EXHAUSTED"),
    checkNode("check.cash_sweep", "checkcalc.cash_sweep", "CASH_SWEEP_EXCEEDED"),
    checkNode("check.debt_maturity", "checkcalc.debt_maturity", "MODEL_UNSUPPORTED_MATURITY"),
    checkNode("check.solver_convergence", "checkcalc.solver_convergence", "NON_CONVERGENT"),
    checkNode("check.exit_bridge", "checkcalc.exit_bridge", "EXIT_BRIDGE_MISMATCH"),
    checkNode("check.sponsor_cash_flows", "checkcalc.sponsor_cash_flows", "SPONSOR_CASH_FLOW_INVALID"),
  );

  const outputSources = [
    "returns.gross_sponsor_moic", "returns.gross_sponsor_irr", "returns.gross_sponsor_xirr",
    "transaction.entry_enterprise_value", "transaction.purchase_equity_value",
    "sources_uses.total_uses", "sources_uses.debt_sources", "sources_uses.sponsor_equity", "sources_uses.total_sources",
    "forecast.revenue", "forecast.ebitda", "forecast.ebit", "forecast.cash_taxes", "forecast.capex",
    "forecast.nwc", "forecast.change_in_nwc", "forecast.unlevered_fcf", "forecast.levered_fcf",
    "debt.total.opening_principal", "debt.total.cash_interest", "debt.total.pik_interest", "debt.total.draw",
    "debt.total.mandatory_amortization", "debt.total.cash_sweep", "debt.total.ending_principal", "cash.ending",
    "exit.metric_value", "exit.enterprise_value", "exit.debt", "exit.cash", "exit.net_debt", "exit.equity_value",
    "returns.sponsor_exit_proceeds",
  ];
  for (const sourceId of outputSources) {
    const source = nodes.find((node) => node.id === sourceId)!;
    const outputId = sourceId.startsWith("returns.") ? sourceId.slice("returns.".length) : `output.${sourceId}`;
    nodes.push(outputNode(outputId, sourceId, source));
  }

  const averageBalance = config.debtTranches.some((tranche) => tranche.interestBasis === "average_balance");
  const circularMembers = [...new Set(debtLineIds)].sort();
  return {
    schemaVersion: UNDERWRITING_MODEL_SCHEMA_VERSION,
    modelKey: config.modelKey ?? STANDARD_LBO_MODEL_KEY,
    modelVersion: config.modelVersion,
    financialConventionVersion: FINANCIAL_CONVENTION_VERSION,
    minimumEngineVersion: UNDERWRITING_ENGINE_VERSION,
    periodDefinition: config.periodDefinition,
    nodes,
    circularBlocks: averageBalance ? [{ id: "debt_interest_cash_sweep", nodeIds: circularMembers, iterationOrder: circularMembers, settings: config.solver ?? defaultSolver() }] : [],
    runtime: {
      kind: "standard_lbo_v1",
      currency,
      entryValuationMethod: config.entryValuationMethod,
      revenueMethod: config.revenueMethod,
      ebitdaMethod: config.ebitdaMethod,
      dAndATreatment: config.dAndATreatment,
      capexMethod: config.capexMethod,
      workingCapitalMethod: config.workingCapitalMethod,
      debtTranches: [...config.debtTranches],
      solver: config.solver ?? defaultSolver(),
    },
    metadata: { referenceModel: true, capabilityMatrix: "STANDARD_LBO_CAPABILITIES" },
  };
}

function truthFor(values: StandardLboInputValues, nodeId: string): { truthClass: TruthClass; status: InputTruthStatus; provenance: readonly InputProvenanceRef[]; reason?: string } {
  const specified = values.inputTruth?.[nodeId];
  return {
    truthClass: specified?.truthClass ?? "MODEL_PARAMETER",
    status: specified?.status ?? "KNOWN",
    provenance: specified?.provenance ?? [{ kind: "model_parameter", id: nodeId }],
    ...(specified?.reason ? { reason: specified.reason } : {}),
  };
}

function standardInputValue(config: StandardLboModelConfig, values: StandardLboInputValues, nodeId: string): ModelValue {
  const path: Record<string, ModelValue | undefined> = {
    "entry.valuation_date": values.entry.valuationDate,
    "entry.metric_value": values.entry.metricValue,
    "entry.multiple": values.entry.multiple,
    "entry.enterprise_value": values.entry.enterpriseValue,
    "entry.cash_acquired": values.entry.cashAcquired,
    "entry.existing_debt": values.entry.existingDebt,
    "entry.other_debt_like": values.entry.otherDebtLike,
    "entry.transaction_fees": values.entry.transactionFees,
    "entry.financing_fees": values.entry.financingFees,
    "entry.minimum_cash_funding": values.entry.minimumCashFunding,
    "entry.rollover_equity": values.entry.rolloverEquity,
    "operating.base_revenue": values.operating.baseRevenue,
    "operating.revenue_explicit": values.operating.revenue,
    "operating.revenue_growth": values.operating.growthRates,
    "operating.ebitda_explicit": values.operating.ebitda,
    "operating.ebitda_margin": values.operating.ebitdaMargins,
    "operating.d_and_a": values.operating.depreciationAndAmortization,
    "operating.capex_explicit": values.operating.capex,
    "operating.capex_rate": values.operating.capexRates,
    "operating.opening_nwc": values.operating.openingNwc,
    "operating.nwc_explicit": values.operating.nwc,
    "operating.nwc_rate": values.operating.nwcRates,
    "operating.cash_tax_rate": values.operating.cashTaxRates,
    "operating.other_cash_adjustments": values.operating.otherCashAdjustments,
    "cash.minimum": values.cash.minimum,
    "cash.sweep_percentage": values.cash.sweepPercentage,
    "ownership.sponsor": values.ownership.sponsor,
    "ownership.other": values.ownership.other,
    "distributions.interim": values.interimDistributions,
    "exit.period_id": values.exit.periodId,
    "exit.multiple": values.exit.multiple,
    "exit.adjustments": values.exit.adjustments,
  };
  if (path[nodeId] !== undefined) return path[nodeId]!;
  const match = /^debt_input\.([a-z][a-z0-9_.:-]*)\.(.+)$/.exec(nodeId);
  if (!match) fail("MISSING_REQUIRED_INPUT", "No Standard LBO input mapping exists", { nodeId });
  const tranche = values.debt[match[1]!];
  if (!tranche) fail("MISSING_REQUIRED_INPUT", "Debt tranche inputs are missing", { trancheId: match[1] });
  const fields: Record<string, ModelValue | undefined> = {
    opening_principal: tranche.openingPrincipal,
    commitment: tranche.commitment,
    fixed_rate: tranche.fixedRate,
    base_rate: tranche.baseRates,
    spread: tranche.spread,
    floor: tranche.floor,
    cash_interest_share: tranche.cashInterestShare,
    pik_interest_share: tranche.pikInterestShare,
    mandatory_amortization_rate: tranche.mandatoryAmortizationRate,
    mandatory_amortization_amount: tranche.mandatoryAmortizationAmounts,
    maturity_date: tranche.maturityDate,
  };
  const value = fields[match[2]!];
  if (value === undefined) fail("MISSING_REQUIRED_INPUT", "Required debt tranche field is missing", { nodeId });
  return value;
}

export function createStandardLboInputSnapshot(config: StandardLboModelConfig, values: StandardLboInputValues): Readonly<UnderwritingInputSnapshot> {
  const model = createStandardLboModel(config);
  const resolved: Record<string, ResolvedInput> = {};
  for (const node of model.nodes) {
    if (node.kind !== "input") continue;
    resolved[node.id] = {
      nodeId: node.id,
      valueType: node.valueType,
      unit: node.unit,
      ...(node.currency ? { currency: node.currency } : {}),
      shape: node.shape,
      value: standardInputValue(config, values, node.id),
      ...truthFor(values, node.id),
    };
  }
  return sealInputSnapshot({
    schemaVersion: "underwriting-input-snapshot.v1",
    investmentCaseId: values.investmentCaseId,
    worldAt: values.worldAt,
    values: resolved,
  });
}

function valueResult(node: ModelNode, value: ModelValue, calculation: string, truthClass: TruthClass = "DERIVED_VALUE"): NodeExecutionResult {
  return {
    nodeId: node.id, value, valueType: node.valueType, unit: node.unit,
    ...(node.currency ? { currency: node.currency } : {}), shape: node.shape, truthClass,
    directDependencies: [...node.dependencies], calculation,
  };
}

interface TranchePeriodResult {
  opening: DecimalString;
  rate: DecimalString;
  cashInterest: DecimalString;
  pik: DecimalString;
  draw: DecimalString;
  mandatory: DecimalString;
  sweep: DecimalString;
  ending: DecimalString;
}

interface DebtPeriodResult {
  tranches: Record<string, TranchePeriodResult>;
  endingCash: DecimalString;
  diagnostic: SolverDiagnostic;
  maturityOkay: boolean;
}

function sumValues(values: readonly DecimalString[]): DecimalString {
  return values.length ? add(...values) : ZERO;
}

function nextDate(value: string): string {
  return formatDateOnly(addDays(parseDateOnly(value), 1));
}

function executeDebtPeriod(input: {
  model: CompiledUnderwritingModel;
  snapshot: UnderwritingInputSnapshot;
  period: FinancialPeriod;
  periodIndex: number;
  openingCash: DecimalString;
  openingDebt: Record<string, DecimalString>;
  unleveredFcf: DecimalString;
  interimDistribution: DecimalString;
}): DebtPeriodResult {
  const runtime = input.model.model.runtime!;
  const solver = runtime.solver;
  const read = (id: string, period?: string): DecimalString => {
    const source = input.snapshot.values[id]?.value;
    if (source === null || source === undefined) fail("MISSING_REQUIRED_INPUT", "Debt input is missing", { nodeId: id });
    return decimal(String(period ? (source as Record<string, ModelValue>)[period] : source));
  };
  const initial: Record<string, DecimalString> = {};
  for (const tranche of runtime.debtTranches) initial[tranche.id] = solver.initialState === "opening_balance" ? input.openingDebt[tranche.id]! : ZERO;

  const calculate = (assumedEnding: Record<string, DecimalString>): { tranches: Record<string, TranchePeriodResult>; endingCash: DecimalString; maturityOkay: boolean } => {
    const tranches: Record<string, TranchePeriodResult> = {};
    let maturityOkay = true;
    for (const tranche of runtime.debtTranches) {
      const opening = input.openingDebt[tranche.id]!;
      const rate = tranche.rateType === "fixed"
        ? read(debtInputId(tranche.id, "fixed_rate"))
        : add(max(read(debtInputId(tranche.id, "base_rate"), input.period.id), read(debtInputId(tranche.id, "floor"))), read(debtInputId(tranche.id, "spread")));
      const basis = tranche.interestBasis === "average_balance" ? div(add(opening, assumedEnding[tranche.id]!), "2") : opening;
      const yearFraction = div(String(daysBetween(input.period.startDate, nextDate(input.period.endDate))), "365");
      const totalInterest = mul(basis, rate, yearFraction);
      const cashShare = read(debtInputId(tranche.id, "cash_interest_share"));
      const pikShare = read(debtInputId(tranche.id, "pik_interest_share"));
      if (!withinTolerance(add(cashShare, pikShare), ONE, STANDARD_LBO_CHECK_TOLERANCE)) fail("MODEL_SCHEMA_INVALID", "Cash and PIK interest shares must total 100%", { trancheId: tranche.id });
      const cashInterest = mul(totalInterest, cashShare);
      const pik = mul(totalInterest, pikShare);
      let mandatory = tranche.amortization === "original_principal_percent"
        ? mul(read(debtInputId(tranche.id, "opening_principal")), read(debtInputId(tranche.id, "mandatory_amortization_rate")))
        : read(debtInputId(tranche.id, "mandatory_amortization_amount"), input.period.id);
      const available = add(opening, pik);
      mandatory = min(mandatory, available);
      const maturityDate = String(input.snapshot.values[debtInputId(tranche.id, "maturity_date")]!.value);
      // A facility maturing exactly on the modeled exit date is settled in the
      // exit bridge. The forecast only "crosses" maturity once period end is
      // later than the contractual date.
      if (daysBetween(maturityDate, input.period.endDate) > 0 && cmp(sub(available, mandatory), ZERO) > 0) {
        if (tranche.maturityTreatment === "mandatory_repayment") mandatory = available;
        else maturityOkay = false;
      }
      tranches[tranche.id] = { opening, rate, cashInterest, pik, draw: ZERO, mandatory, sweep: ZERO, ending: sub(available, mandatory) };
    }

    const cashInterest = sumValues(Object.values(tranches).map((row) => row.cashInterest));
    const mandatory = sumValues(Object.values(tranches).map((row) => row.mandatory));
    let cash = sub(sub(add(input.openingCash, input.unleveredFcf), cashInterest), add(mandatory, input.interimDistribution));
    const minimumCash = read("cash.minimum");
    if (cmp(cash, minimumCash) < 0) {
      let need = sub(minimumCash, cash);
      const revolvers = runtime.debtTranches
        .filter((row) => row.kind === "revolver" && daysBetween(String(input.snapshot.values[debtInputId(row.id, "maturity_date")]!.value), input.period.endDate) <= 0)
        .sort((left, right) => left.sweepPriority - right.sweepPriority || left.id.localeCompare(right.id));
      for (const tranche of revolvers) {
        const commitment = read(debtInputId(tranche.id, "commitment"));
        const capacity = max(sub(commitment, tranches[tranche.id]!.ending), ZERO);
        const draw = min(need, capacity);
        tranches[tranche.id]!.draw = draw;
        tranches[tranche.id]!.ending = add(tranches[tranche.id]!.ending, draw);
        cash = add(cash, draw);
        need = sub(need, draw);
        if (cmp(need, ZERO) <= 0) break;
      }
      if (cmp(need, STANDARD_LBO_CHECK_TOLERANCE) > 0) fail("LIQUIDITY_SHORTFALL", "Available revolver capacity cannot fund minimum cash", { periodId: input.period.id, shortfall: need });
    }

    let excess = max(sub(cash, minimumCash), ZERO);
    const revolvers = runtime.debtTranches.filter((row) => row.kind === "revolver").sort((left, right) => left.sweepPriority - right.sweepPriority || left.id.localeCompare(right.id));
    for (const tranche of revolvers) {
      const repayment = min(excess, tranches[tranche.id]!.ending);
      tranches[tranche.id]!.sweep = add(tranches[tranche.id]!.sweep, repayment);
      tranches[tranche.id]!.ending = sub(tranches[tranche.id]!.ending, repayment);
      cash = sub(cash, repayment);
      excess = sub(excess, repayment);
    }
    let sweepBudget = mul(excess, read("cash.sweep_percentage"));
    const eligible = runtime.debtTranches.filter((row) => row.kind !== "revolver" && row.cashSweepEligible).sort((left, right) => left.sweepPriority - right.sweepPriority || left.seniority - right.seniority || left.id.localeCompare(right.id));
    for (const tranche of eligible) {
      const repayment = min(sweepBudget, tranches[tranche.id]!.ending);
      tranches[tranche.id]!.sweep = add(tranches[tranche.id]!.sweep, repayment);
      tranches[tranche.id]!.ending = sub(tranches[tranche.id]!.ending, repayment);
      cash = sub(cash, repayment);
      sweepBudget = sub(sweepBudget, repayment);
    }
    return { tranches, endingCash: cash, maturityOkay };
  };

  const hasCircularity = runtime.debtTranches.some((tranche) => tranche.interestBasis === "average_balance");
  if (!hasCircularity) {
    const calculated = calculate(initial);
    return { ...calculated, diagnostic: { blockId: "debt_interest_cash_sweep", periodId: input.period.id, algorithm: "fixed_point", iterations: 1, converged: true, absoluteError: ZERO, relativeError: ZERO } };
  }
  let assumed = initial;
  let absoluteError = ZERO;
  let relativeError = ZERO;
  for (let iteration = 1; iteration <= solver.maxIterations; iteration += 1) {
    const calculated = calculate(assumed);
    absoluteError = ZERO;
    relativeError = ZERO;
    for (const tranche of runtime.debtTranches) {
      const next = calculated.tranches[tranche.id]!.ending;
      const difference = abs(sub(next, assumed[tranche.id]!));
      absoluteError = max(absoluteError, difference);
      relativeError = max(relativeError, div(difference, max(abs(next), abs(assumed[tranche.id]!), ONE)));
    }
    if (cmp(absoluteError, solver.absoluteTolerance) <= 0 || cmp(relativeError, solver.relativeTolerance) <= 0) {
      return { ...calculated, diagnostic: { blockId: "debt_interest_cash_sweep", periodId: input.period.id, algorithm: "fixed_point", iterations: iteration, converged: true, absoluteError, relativeError } };
    }
    assumed = Object.fromEntries(runtime.debtTranches.map((tranche) => [tranche.id, calculated.tranches[tranche.id]!.ending]));
  }
  fail("NON_CONVERGENT", "Debt/interest/cash-sweep circular block did not converge", { periodId: input.period.id, iterations: solver.maxIterations, absoluteError, relativeError });
}

export function executeStandardLboModel(
  model: CompiledUnderwritingModel,
  inputSnapshot: UnderwritingInputSnapshot,
  scenarioSemanticHash?: string,
): Readonly<UnderwritingRunResult> {
  const snapshot = sealInputSnapshot(inputSnapshot);
  const runtime = model.model.runtime;
  const values: Record<string, NodeExecutionResult> = {};
  const outputs: Record<string, NodeExecutionResult> = {};
  const checks: CheckResult[] = [];
  const diagnostics: SolverDiagnostic[] = [];
  try {
    if (!runtime || runtime.kind !== "standard_lbo_v1") fail("MODEL_SCHEMA_INVALID", "Compiled model is not the Standard LBO runtime");
    for (const tranche of runtime.debtTranches) {
      const opening = snapshot.values[debtInputId(tranche.id, "opening_principal")]?.value;
      const commitment = tranche.kind === "revolver" ? snapshot.values[debtInputId(tranche.id, "commitment")]?.value : undefined;
      if (opening !== null && opening !== undefined && cmp(String(opening), ZERO) < 0) {
        fail("NEGATIVE_DEBT", "Opening debt principal cannot be negative", { trancheId: tranche.id });
      }
      if (commitment !== null && commitment !== undefined && cmp(String(commitment), ZERO) < 0) {
        fail("NEGATIVE_DEBT", "Debt commitment cannot be negative", { trancheId: tranche.id });
      }
    }
    assertSnapshotMatchesModel(model, snapshot);
    const readValue = (id: string): ModelValue => {
      const value = snapshot.values[id]?.value;
      if (value === null || value === undefined) fail("MISSING_REQUIRED_INPUT", "Standard LBO input is missing", { nodeId: id });
      return value;
    };
    const scalar = (id: string): DecimalString => decimal(String(readValue(id)));
    const text = (id: string): string => String(readValue(id));
    const series = (id: string, periodId: string): DecimalString => {
      const value = (readValue(id) as Record<string, ModelValue>)[periodId];
      if (value === undefined) fail("MISSING_REQUIRED_INPUT", "Input series is missing a modeled period", { nodeId: id, periodId });
      return decimal(String(value));
    };
    const put = (id: string, value: ModelValue, calculation: string, truthClass: TruthClass = "DERIVED_VALUE") => {
      const node = model.nodeById[id];
      if (!node) fail("MODEL_SCHEMA_INVALID", "Standard LBO result node is missing from ModelVersion", { nodeId: id });
      values[id] = valueResult(node, value, calculation, truthClass);
    };
    for (const node of Object.values(model.nodeById)) {
      if (node.kind !== "input") continue;
      const resolved = snapshot.values[node.id]!;
      put(node.id, resolved.value!, `input:${resolved.status}`, resolved.truthClass);
    }

    const entryEnterpriseValue = runtime.entryValuationMethod === "metric_multiple"
      ? mul(scalar("entry.metric_value"), scalar("entry.multiple"))
      : scalar("entry.enterprise_value");
    const purchaseEquity = add(sub(sub(entryEnterpriseValue, scalar("entry.existing_debt")), scalar("entry.other_debt_like")), scalar("entry.cash_acquired"));
    const totalUses = add(purchaseEquity, scalar("entry.existing_debt"), scalar("entry.other_debt_like"), scalar("entry.transaction_fees"), scalar("entry.financing_fees"), scalar("entry.minimum_cash_funding"));
    const debtSources = sumValues(runtime.debtTranches.map((tranche) => scalar(debtInputId(tranche.id, "opening_principal"))));
    const sponsorEquity = sub(sub(totalUses, debtSources), scalar("entry.rollover_equity"));
    if (cmp(sponsorEquity, ZERO) < 0) fail("SOURCES_USES_IMBALANCE", "Entry sources exceed uses before the sponsor equity plug", { sponsorEquity });
    const totalSources = add(debtSources, sponsorEquity, scalar("entry.rollover_equity"));
    put("transaction.entry_enterprise_value", entryEnterpriseValue, runtime.entryValuationMethod);
    put("transaction.purchase_equity_value", purchaseEquity, "entry EV - existing debt - other debt-like + cash acquired");
    put("sources_uses.total_uses", totalUses, "purchase equity + refinancing + fees + minimum cash funding");
    put("sources_uses.debt_sources", debtSources, "sum opening debt principal");
    put("sources_uses.sponsor_equity", sponsorEquity, "explicit sponsor equity plug");
    put("sources_uses.total_sources", totalSources, "debt + rollover + sponsor equity");

    const revenue: Record<string, DecimalString> = {};
    const ebitda: Record<string, DecimalString> = {};
    const dAndA: Record<string, DecimalString> = {};
    const ebit: Record<string, DecimalString> = {};
    const taxes: Record<string, DecimalString> = {};
    const capex: Record<string, DecimalString> = {};
    const nwc: Record<string, DecimalString> = {};
    const deltaNwc: Record<string, DecimalString> = {};
    const unleveredFcf: Record<string, DecimalString> = {};
    let priorRevenue = runtime.revenueMethod === "growth" ? scalar("operating.base_revenue") : ZERO;
    let priorNwc = scalar("operating.opening_nwc");
    for (const period of model.periods) {
      revenue[period.id] = runtime.revenueMethod === "explicit"
        ? series("operating.revenue_explicit", period.id)
        : mul(priorRevenue, add(ONE, series("operating.revenue_growth", period.id)));
      priorRevenue = revenue[period.id]!;
      ebitda[period.id] = runtime.ebitdaMethod === "explicit"
        ? series("operating.ebitda_explicit", period.id)
        : mul(revenue[period.id]!, series("operating.ebitda_margin", period.id));
      dAndA[period.id] = runtime.dAndATreatment === "explicit" ? series("operating.d_and_a", period.id) : ZERO;
      ebit[period.id] = sub(ebitda[period.id]!, dAndA[period.id]!);
      taxes[period.id] = mul(max(ebit[period.id]!, ZERO), series("operating.cash_tax_rate", period.id));
      capex[period.id] = runtime.capexMethod === "explicit" ? series("operating.capex_explicit", period.id) : mul(revenue[period.id]!, series("operating.capex_rate", period.id));
      nwc[period.id] = runtime.workingCapitalMethod === "explicit_nwc" ? series("operating.nwc_explicit", period.id) : mul(revenue[period.id]!, series("operating.nwc_rate", period.id));
      deltaNwc[period.id] = sub(nwc[period.id]!, priorNwc);
      priorNwc = nwc[period.id]!;
      unleveredFcf[period.id] = add(sub(sub(sub(ebitda[period.id]!, taxes[period.id]!), capex[period.id]!), deltaNwc[period.id]!), series("operating.other_cash_adjustments", period.id));
    }
    put("forecast.revenue", revenue, runtime.revenueMethod === "growth" ? "prior revenue × (1 + growth)" : "explicit revenue series");
    put("forecast.ebitda", ebitda, runtime.ebitdaMethod === "margin" ? "revenue × EBITDA margin" : "explicit EBITDA series");
    if (runtime.dAndATreatment === "explicit") put("forecast.d_and_a", dAndA, "explicit D&A series");
    put("forecast.ebit", ebit, runtime.dAndATreatment === "explicit" ? "EBITDA - D&A" : "explicit convention: EBITDA equals EBIT");
    put("forecast.cash_taxes", taxes, "max(EBIT, 0) × cash tax rate");
    put("forecast.capex", capex, runtime.capexMethod === "percent_revenue" ? "revenue × capex rate" : "explicit positive cash-use series");
    put("forecast.nwc", nwc, runtime.workingCapitalMethod === "percent_revenue" ? "revenue × NWC rate" : "explicit NWC series");
    put("forecast.change_in_nwc", deltaNwc, "ending NWC - prior NWC");
    put("forecast.unlevered_fcf", unleveredFcf, "EBITDA - cash taxes - capex - change in NWC + explicit adjustments");

    const perTranche: Record<string, Record<string, Record<string, DecimalString>>> = {};
    for (const tranche of runtime.debtTranches) perTranche[tranche.id] = { opening_principal: {}, effective_rate: {}, cash_interest: {}, pik_interest: {}, draw: {}, mandatory_amortization: {}, cash_sweep: {}, ending_principal: {} };
    const totals: Record<string, Record<string, DecimalString>> = { opening_principal: {}, cash_interest: {}, pik_interest: {}, draw: {}, mandatory_amortization: {}, cash_sweep: {}, ending_principal: {} };
    const endingCash: Record<string, DecimalString> = {};
    const leveredFcf: Record<string, DecimalString> = {};
    let openingCash = add(scalar("entry.cash_acquired"), scalar("entry.minimum_cash_funding"));
    let openingDebt = Object.fromEntries(runtime.debtTranches.map((tranche) => [tranche.id, scalar(debtInputId(tranche.id, "opening_principal"))]));
    let maturityOkay = true;
    for (let periodIndex = 0; periodIndex < model.periods.length; periodIndex += 1) {
      const period = model.periods[periodIndex]!;
      const periodDebt = executeDebtPeriod({
        model, snapshot, period, periodIndex, openingCash, openingDebt,
        unleveredFcf: unleveredFcf[period.id]!,
        interimDistribution: series("distributions.interim", period.id),
      });
      diagnostics.push(periodDebt.diagnostic);
      maturityOkay = maturityOkay && periodDebt.maturityOkay;
      for (const tranche of runtime.debtTranches) {
        const row = periodDebt.tranches[tranche.id]!;
        perTranche[tranche.id]!.opening_principal![period.id] = row.opening;
        perTranche[tranche.id]!.effective_rate![period.id] = row.rate;
        perTranche[tranche.id]!.cash_interest![period.id] = row.cashInterest;
        perTranche[tranche.id]!.pik_interest![period.id] = row.pik;
        perTranche[tranche.id]!.draw![period.id] = row.draw;
        perTranche[tranche.id]!.mandatory_amortization![period.id] = row.mandatory;
        perTranche[tranche.id]!.cash_sweep![period.id] = row.sweep;
        perTranche[tranche.id]!.ending_principal![period.id] = row.ending;
      }
      for (const field of Object.keys(totals)) totals[field]![period.id] = sumValues(runtime.debtTranches.map((tranche) => perTranche[tranche.id]![field]![period.id]!));
      endingCash[period.id] = periodDebt.endingCash;
      leveredFcf[period.id] = sub(unleveredFcf[period.id]!, totals.cash_interest![period.id]!);
      openingCash = periodDebt.endingCash;
      openingDebt = Object.fromEntries(runtime.debtTranches.map((tranche) => [tranche.id, periodDebt.tranches[tranche.id]!.ending]));
    }
    for (const tranche of runtime.debtTranches) {
      for (const [field, seriesValue] of Object.entries(perTranche[tranche.id]!)) put(`debt.${tranche.id}.${field}`, seriesValue, `deterministic ${tranche.name} debt roll-forward`);
    }
    for (const [field, seriesValue] of Object.entries(totals)) put(`debt.total.${field}`, seriesValue, `sum tranche ${field}`);
    put("cash.ending", endingCash, "opening cash + FCF - interest - distributions - repayments + revolver draws");
    put("forecast.levered_fcf", leveredFcf, "unlevered FCF - cash interest");

    const exitPeriodId = text("exit.period_id");
    const exitPeriod = model.periods.find((period) => period.id === exitPeriodId);
    if (!exitPeriod) fail("EXIT_METRIC_MISSING", "Exit period is not in the exact ModelVersion period set", { exitPeriodId });
    const exitMetric = ebitda[exitPeriodId];
    if (exitMetric === undefined) fail("EXIT_METRIC_MISSING", "Exit EBITDA is missing", { exitPeriodId });
    const exitEnterpriseValue = mul(exitMetric, scalar("exit.multiple"));
    const exitDebt = totals.ending_principal![exitPeriodId]!;
    const exitCash = endingCash[exitPeriodId]!;
    const exitNetDebt = sub(exitDebt, exitCash);
    const exitEquity = add(sub(exitEnterpriseValue, exitDebt), exitCash, scalar("exit.adjustments"));
    if (cmp(exitEquity, ZERO) < 0) fail("NEGATIVE_EXIT_EQUITY", "Exit equity value is negative under the modeled bridge", { exitEquity });
    const sponsorExitProceeds = mul(exitEquity, scalar("ownership.sponsor"));
    put("exit.metric_value", exitMetric, "exit-period EBITDA");
    put("exit.enterprise_value", exitEnterpriseValue, "exit metric × exit multiple");
    put("exit.debt", exitDebt, "exit-period ending debt");
    put("exit.cash", exitCash, "exit-period ending cash");
    put("exit.net_debt", exitNetDebt, "exit debt - exit cash");
    put("exit.equity_value", exitEquity, "exit EV - debt + cash + explicit adjustments");
    put("returns.sponsor_exit_proceeds", sponsorExitProceeds, "exit equity × sponsor ownership");

    const cashFlows: SponsorCashFlow[] = [{ amount: sub(ZERO, sponsorEquity), date: text("entry.valuation_date"), type: "initial_investment" }];
    for (const period of model.periods) {
      const interim = mul(series("distributions.interim", period.id), scalar("ownership.sponsor"));
      const amount = period.id === exitPeriodId ? add(interim, sponsorExitProceeds) : interim;
      cashFlows.push({ amount, date: period.endDate, periodId: period.id, type: period.id === exitPeriodId ? "exit_distribution" : "interim_distribution" });
      if (period.id === exitPeriodId) break;
    }
    const invested = sumValues(cashFlows.filter((flow) => cmp(flow.amount, ZERO) < 0).map((flow) => abs(flow.amount)));
    if (cmp(invested, ZERO) === 0) fail("MOIC_UNDEFINED", "Sponsor MOIC has zero invested capital");
    const distributions = sumValues(cashFlows.filter((flow) => cmp(flow.amount, ZERO) > 0).map((flow) => flow.amount));
    const moic = div(distributions, invested);
    const periodicIrr = solvePeriodicIrr(cashFlows);
    const periodsPerYear = model.model.periodDefinition.frequency === "annual" ? 1 : model.model.periodDefinition.frequency === "quarterly" ? 4 : 12;
    const irr = annualizePeriodicIrr(periodicIrr, periodsPerYear);
    const xirr = solveXirr(cashFlows);
    put("returns.gross_sponsor_moic", moic, "positive sponsor distributions / absolute invested sponsor capital");
    put("returns.gross_sponsor_irr", irr, "bounded periodic IRR annualized by declared period frequency");
    put("returns.gross_sponsor_xirr", xirr, "bounded dated XIRR using ACT/365F");

    let debtRollForwardOkay = true;
    let minimumCashOkay = true;
    let revolverOkay = true;
    let cashSweepOkay = true;
    for (const period of model.periods) {
      minimumCashOkay = minimumCashOkay && cmp(endingCash[period.id]!, scalar("cash.minimum")) >= 0;
      for (const tranche of runtime.debtTranches) {
        const row = perTranche[tranche.id]!;
        const expected = sub(add(row.opening_principal![period.id]!, row.draw![period.id]!, row.pik_interest![period.id]!), add(row.mandatory_amortization![period.id]!, row.cash_sweep![period.id]!));
        debtRollForwardOkay = debtRollForwardOkay && withinTolerance(expected, row.ending_principal![period.id]!, STANDARD_LBO_CHECK_TOLERANCE) && cmp(row.ending_principal![period.id]!, ZERO) >= 0;
        const repaymentCapacity = sub(add(row.opening_principal![period.id]!, row.draw![period.id]!, row.pik_interest![period.id]!), row.mandatory_amortization![period.id]!);
        cashSweepOkay = cashSweepOkay
          && cmp(row.cash_sweep![period.id]!, ZERO) >= 0
          && cmp(row.cash_sweep![period.id]!, repaymentCapacity) <= 0;
        if (tranche.kind === "revolver") revolverOkay = revolverOkay && cmp(row.ending_principal![period.id]!, scalar(debtInputId(tranche.id, "commitment"))) <= 0;
      }
    }
    const expectedSponsorDistributions = add(
      sponsorExitProceeds,
      ...model.periods.slice(0, model.periods.findIndex((period) => period.id === exitPeriodId) + 1)
        .map((period) => mul(series("distributions.interim", period.id), scalar("ownership.sponsor"))),
    );
    const actualSponsorDistributions = sumValues(cashFlows.filter((flow) => cmp(flow.amount, ZERO) > 0).map((flow) => flow.amount));
    const sponsorCashFlowsOkay = cashFlows.length >= 2
      && cashFlows[0]!.type === "initial_investment"
      && cashFlows[0]!.amount === sub(ZERO, sponsorEquity)
      && cashFlows.at(-1)!.type === "exit_distribution"
      && cashFlows.every((flow, index) => index === 0 || daysBetween(cashFlows[index - 1]!.date, flow.date) >= 0)
      && withinTolerance(actualSponsorDistributions, expectedSponsorDistributions, STANDARD_LBO_CHECK_TOLERANCE);
    const checkValues: Record<string, { passed: boolean; code: CheckResult["code"]; message: string; difference?: DecimalString; tolerance?: DecimalString }> = {
      "checkcalc.sources_uses": { passed: withinTolerance(totalSources, totalUses, STANDARD_LBO_CHECK_TOLERANCE), code: "SOURCES_USES_IMBALANCE", message: "Sources equal uses", difference: abs(sub(totalSources, totalUses)), tolerance: STANDARD_LBO_CHECK_TOLERANCE },
      "checkcalc.ownership": { passed: withinTolerance(add(scalar("ownership.sponsor"), scalar("ownership.other")), ONE, STANDARD_LBO_CHECK_TOLERANCE), code: "OWNERSHIP_MISMATCH", message: "Modeled ownership totals 100%", difference: abs(sub(add(scalar("ownership.sponsor"), scalar("ownership.other")), ONE)), tolerance: STANDARD_LBO_CHECK_TOLERANCE },
      "checkcalc.debt_roll_forward": { passed: debtRollForwardOkay, code: "DEBT_ROLL_FORWARD_MISMATCH", message: "Debt roll-forward reconciles and debt is nonnegative" },
      "checkcalc.minimum_cash": { passed: minimumCashOkay, code: "LIQUIDITY_SHORTFALL", message: "Minimum cash is maintained" },
      "checkcalc.revolver_capacity": { passed: revolverOkay, code: "REVOLVER_EXHAUSTED", message: "Revolver balances remain within commitments" },
      "checkcalc.cash_sweep": { passed: cashSweepOkay, code: "CASH_SWEEP_EXCEEDED", message: "Cash sweep never exceeds available tranche principal" },
      "checkcalc.debt_maturity": { passed: maturityOkay, code: "MODEL_UNSUPPORTED_MATURITY", message: "Debt maturity treatment is supported" },
      "checkcalc.solver_convergence": { passed: diagnostics.every((diagnostic) => diagnostic.converged), code: "NON_CONVERGENT", message: "Every declared circular solver block converged" },
      "checkcalc.exit_bridge": { passed: withinTolerance(exitEquity, add(sub(exitEnterpriseValue, exitDebt), exitCash, scalar("exit.adjustments")), STANDARD_LBO_CHECK_TOLERANCE), code: "EXIT_BRIDGE_MISMATCH", message: "Exit equity bridge reconciles", difference: abs(sub(exitEquity, add(sub(exitEnterpriseValue, exitDebt), exitCash, scalar("exit.adjustments")))), tolerance: STANDARD_LBO_CHECK_TOLERANCE },
      "checkcalc.sponsor_cash_flows": { passed: sponsorCashFlowsOkay, code: "SPONSOR_CASH_FLOW_INVALID", message: "Sponsor cash-flow timeline reconciles to invested capital and exact sponsor distributions", difference: abs(sub(actualSponsorDistributions, expectedSponsorDistributions)), tolerance: STANDARD_LBO_CHECK_TOLERANCE },
    };
    for (const [calculationId, check] of Object.entries(checkValues)) {
      put(calculationId, check.passed, check.message);
      const nodeId = calculationId.replace("checkcalc.", "check.");
      put(nodeId, check.passed, `check(${calculationId})`);
      checks.push({ nodeId, passed: check.passed, severity: "error", code: check.code, message: check.message, ...(check.difference ? { difference: check.difference } : {}), ...(check.tolerance ? { tolerance: check.tolerance } : {}) });
    }
    for (const node of Object.values(model.nodeById)) {
      if (node.kind !== "output") continue;
      const source = values[node.sourceNodeId];
      if (!source) fail("MISSING_DEPENDENCY", "Standard output source was not calculated", { nodeId: node.id, sourceNodeId: node.sourceNodeId });
      put(node.id, source.value, `output(${node.sourceNodeId})`);
      outputs[node.id] = values[node.id]!;
    }
    const invalid = checks.some((check) => !check.passed && check.severity === "error");
    return finalizeRunResult({
      status: "SUCCEEDED", validity: invalid ? "INVALID" : "VALID", modelSemanticHash: model.semanticHash,
      inputSemanticHash: snapshot.semanticHash!, scenarioSemanticHash, values, outputs, checks, solverDiagnostics: diagnostics, sponsorCashFlows: cashFlows,
    });
  } catch (error) {
    return finalizeRunResult({
      status: "FAILED", validity: error instanceof UnderwritingError && error.code === "NON_CONVERGENT" ? "NON_CONVERGENT" : "INCOMPLETE", modelSemanticHash: model.semanticHash,
      inputSemanticHash: snapshot.semanticHash!, scenarioSemanticHash, values, outputs, checks, solverDiagnostics: diagnostics, failure: error,
    });
  }
}
