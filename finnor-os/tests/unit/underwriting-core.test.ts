import { describe, expect, it } from "vitest";
import {
  buildPeriods,
  canonicalSerialize,
  compileUnderwritingModel,
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  diffRuns,
  executeSensitivity,
  executeUnderwritingModel,
  explainOutput,
  round,
  semanticHash,
  type StandardLboInputValues,
  type StandardLboModelConfig,
} from "@finnor/underwriting";

const money = decimal;

export function standardLboFixture(): { config: StandardLboModelConfig; inputs: StandardLboInputValues } {
  const periodDefinition = { frequency: "annual" as const, forecastStart: "2027-01-01", count: 5, fiscalYearStartMonth: 1 };
  const periods = buildPeriods(periodDefinition);
  const series = (values: string[]) => Object.fromEntries(periods.map((period, index) => [period.id, decimal(values[index]!)]));
  const config: StandardLboModelConfig = {
    modelVersion: "1.0.0",
    currency: "USD",
    periodDefinition,
    entryValuationMethod: "metric_multiple",
    revenueMethod: "growth",
    ebitdaMethod: "margin",
    dAndATreatment: "explicit",
    capexMethod: "percent_revenue",
    workingCapitalMethod: "percent_revenue",
    debtTranches: [
      {
        id: "term_a", name: "Term A", kind: "term", seniority: 1, sweepPriority: 1,
        rateType: "floating", interestBasis: "average_balance", amortization: "original_principal_percent",
        cashSweepEligible: true, maturityTreatment: "mandatory_repayment",
      },
      {
        id: "revolver", name: "Revolver", kind: "revolver", seniority: 0, sweepPriority: 0,
        rateType: "fixed", interestBasis: "beginning_balance", amortization: "explicit_amount",
        cashSweepEligible: false, maturityTreatment: "mandatory_repayment",
      },
      {
        id: "seller_note", name: "Seller Note", kind: "seller_note", seniority: 2, sweepPriority: 2,
        rateType: "fixed", interestBasis: "beginning_balance", amortization: "original_principal_percent",
        cashSweepEligible: false, maturityTreatment: "mandatory_repayment",
      },
    ],
  };
  const inputs: StandardLboInputValues = {
    investmentCaseId: "11111111-1111-4111-8111-111111111111",
    worldAt: "2026-12-31T23:59:59.000Z",
    entry: {
      valuationDate: "2026-12-31", metricValue: money("20"), multiple: decimal("8"),
      cashAcquired: money("5"), existingDebt: money("20"), otherDebtLike: money("2"),
      transactionFees: money("4"), financingFees: money("2"), minimumCashFunding: money("3"), rolloverEquity: money("10"),
    },
    operating: {
      baseRevenue: money("100"), growthRates: series(["0.08", "0.07", "0.06", "0.05", "0.04"]),
      ebitdaMargins: series(["0.20", "0.205", "0.21", "0.215", "0.22"]),
      depreciationAndAmortization: series(["3", "3.2", "3.4", "3.6", "3.8"]),
      capexRates: series(["0.03", "0.03", "0.03", "0.03", "0.03"]), openingNwc: money("10"),
      nwcRates: series(["0.10", "0.10", "0.10", "0.10", "0.10"]),
      cashTaxRates: series(["0.25", "0.25", "0.25", "0.25", "0.25"]),
      otherCashAdjustments: series(["0", "0", "0", "0", "0"]),
    },
    debt: {
      term_a: {
        openingPrincipal: money("70"), baseRates: series(["0.04", "0.0425", "0.045", "0.045", "0.045"]), spread: decimal("0.03"), floor: decimal("0.035"),
        cashInterestShare: decimal("1"), pikInterestShare: decimal("0"), mandatoryAmortizationRate: decimal("0.02"), maturityDate: "2031-12-31",
      },
      revolver: {
        openingPrincipal: money("0"), commitment: money("100"), fixedRate: decimal("0.08"), cashInterestShare: decimal("1"), pikInterestShare: decimal("0"),
        mandatoryAmortizationAmounts: series(["0", "0", "0", "0", "0"]), maturityDate: "2031-12-31",
      },
      seller_note: {
        openingPrincipal: money("10"), fixedRate: decimal("0.10"), cashInterestShare: decimal("0.5"), pikInterestShare: decimal("0.5"),
        mandatoryAmortizationRate: decimal("0"), maturityDate: "2031-12-31",
      },
    },
    cash: { minimum: money("5"), sweepPercentage: decimal("0.75") },
    ownership: { sponsor: decimal("0.9"), other: decimal("0.1") },
    interimDistributions: series(["0", "0", "2", "0", "0"]),
    exit: { periodId: periods[4]!.id, multiple: decimal("9"), adjustments: money("0") },
  };
  return { config, inputs };
}

describe("P4 deterministic underwriting core", () => {
  it("uses canonical decimal strings and ROUND_HALF_EVEN", () => {
    expect(decimal("001.2300")).toBe("1.23");
    expect(round("2.5", 0)).toBe("2");
    expect(round("3.5", 0)).toBe("4");
    expect(() => decimal("$5.2m")).toThrowError(/base-10 strings/);
  });

  it("serializes and hashes without object insertion-order drift", () => {
    expect(canonicalSerialize({ b: "2", a: "1" })).toBe(canonicalSerialize({ a: "1", b: "2" }));
    expect(semanticHash({ b: "2", a: "1" })).toBe(semanticHash({ a: "1", b: "2" }));
  });

  it("compiles and executes the standard LBO with debt, exit, and returns", () => {
    const { config, inputs } = standardLboFixture();
    const compiled = compileUnderwritingModel(createStandardLboModel(config));
    const snapshot = createStandardLboInputSnapshot(config, inputs);
    const result = executeUnderwritingModel(compiled, snapshot);
    expect(result.status, result.failure?.message).toBe("SUCCEEDED");
    expect(result.validity).toBe("VALID");
    expect(result.outputs.gross_sponsor_moic?.value).toBeTruthy();
    expect(result.outputs.gross_sponsor_irr?.value).toBeTruthy();
    expect(result.outputs.gross_sponsor_xirr?.value).toBeTruthy();
    expect(result.solverDiagnostics).toHaveLength(5);
    expect(result.solverDiagnostics.every((row) => row.converged)).toBe(true);
    const explanation = explainOutput(compiled, snapshot, result, "gross_sponsor_moic");
    expect(explanation.nodeId).toBe("gross_sponsor_moic");
    expect(JSON.stringify(explanation)).toContain("entry.metric_value");
  });

  it("applies scenarios immutably and executes one-way sensitivities", () => {
    const { config, inputs } = standardLboFixture();
    const compiled = compileUnderwritingModel(createStandardLboModel(config));
    const snapshot = createStandardLboInputSnapshot(config, inputs);
    const baseline = executeUnderwritingModel(compiled, snapshot);
    const sensitivity = executeSensitivity(compiled, snapshot, {
      schemaVersion: "underwriting-sensitivity.v1",
      name: "Exit multiple",
      rowAxis: { nodeId: "exit.multiple", values: [decimal("8"), decimal("9"), decimal("10")] },
      outputNodeIds: ["gross_sponsor_moic", "gross_sponsor_xirr"],
    });
    expect(sensitivity.status).toBe("SUCCEEDED");
    expect(sensitivity.cells).toHaveLength(3);
    expect(snapshot.values["exit.multiple"]?.value).toBe("9");
    expect(diffRuns(baseline, executeUnderwritingModel(compiled, snapshot, {
      schemaVersion: "underwriting-scenario.v1", name: "Downside", overrides: [{ nodeId: "exit.multiple", value: decimal("8") }],
    })).changedOutputs).toHaveProperty("gross_sponsor_moic");
  });
});
