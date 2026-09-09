import { describe, expect, it } from "vitest";
import {
  UnderwritingError,
  compileUnderwritingModel,
  createStandardLboInputSnapshot,
  createStandardLboModel,
  executeSensitivity,
  executeUnderwritingModel,
  solvePeriodicIrr,
  withinTolerance,
  type DecimalString,
  type ModelValue,
  type UnderwritingRunResult,
} from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES, type GoldenLboCase } from "../underwriting-corpus/golden-cases";

function decimalAt(result: UnderwritingRunResult, nodeId: string, periodId?: string): string {
  const node = result.values[nodeId];
  expect(node, `missing golden result node ${nodeId}`).toBeDefined();
  const value = periodId ? (node!.value as Record<string, ModelValue>)[periodId] : node!.value;
  expect(typeof value, `${nodeId}${periodId ? `/${periodId}` : ""} must be scalar decimal`).toBe("string");
  return String(value);
}

function expectDecimal(actual: string, expected: string, tolerance = "0") {
  expect(withinTolerance(actual, expected, tolerance as DecimalString), `${actual} ≠ ${expected} ± ${tolerance}`).toBe(true);
}

function verifyLboGolden(golden: GoldenLboCase) {
  const compiled = compileUnderwritingModel(createStandardLboModel(golden.config));
  const snapshot = createStandardLboInputSnapshot(golden.config, golden.inputs);
  const result = executeUnderwritingModel(compiled, snapshot);
  const tolerance = golden.expected.returns?.tolerance ?? (golden.id === "13-average-balance-circularity" ? "0.00000000001" : "0");

  expect(result.status, `${golden.id}: ${result.failure?.code} ${result.failure?.message}`).toBe(golden.expected.status);
  expect(result.validity).toBe(golden.expected.validity);
  expect(result.failure?.code).toBe(golden.expected.failureCode);

  for (const [nodeId, expected] of Object.entries(golden.expected.values)) {
    if (typeof expected === "string") expectDecimal(decimalAt(result, nodeId), expected, tolerance);
    else for (const [periodId, periodExpected] of Object.entries(expected)) {
      expectDecimal(decimalAt(result, nodeId, periodId), periodExpected, tolerance);
    }
  }

  const checks = new Map(result.checks.map((check) => [check.nodeId, check.passed]));
  for (const [nodeId, passed] of Object.entries(golden.expected.checks)) expect(checks.get(nodeId), `${golden.id}/${nodeId}`).toBe(passed);

  for (const row of golden.expected.debtRollForward) {
    const prefix = `debt.${row.trancheId}`;
    expectDecimal(decimalAt(result, `${prefix}.opening_principal`, row.periodId), row.opening, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.cash_interest`, row.periodId), row.cashInterest, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.pik_interest`, row.periodId), row.pik, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.draw`, row.periodId), row.draw, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.mandatory_amortization`, row.periodId), row.mandatory, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.cash_sweep`, row.periodId), row.sweep, tolerance);
    expectDecimal(decimalAt(result, `${prefix}.ending_principal`, row.periodId), row.ending, tolerance);
  }

  if (golden.expected.status === "SUCCEEDED") {
    expect(result.sponsorCashFlows).toHaveLength(golden.expected.sponsorCashFlows.length);
    golden.expected.sponsorCashFlows.forEach((expected, index) => {
      const actual = result.sponsorCashFlows![index]!;
      expect({ date: actual.date, periodId: actual.periodId, type: actual.type }).toEqual({ date: expected.date, periodId: expected.periodId, type: expected.type });
      expectDecimal(actual.amount, expected.amount, tolerance);
    });
  }

  if (golden.expected.returns) {
    expectDecimal(String(result.outputs.gross_sponsor_moic!.value), golden.expected.returns.moic, tolerance);
    expectDecimal(String(result.outputs.gross_sponsor_irr!.value), golden.expected.returns.irr, tolerance);
    expectDecimal(String(result.outputs.gross_sponsor_xirr!.value), golden.expected.returns.xirr, tolerance);
  }
}

describe("P4 independently authored golden underwriting corpus", () => {
  it("contains exactly 20 named, documented, non-circular reference cases", () => {
    expect(GOLDEN_UNDERWRITING_CASES).toHaveLength(20);
    expect(new Set(GOLDEN_UNDERWRITING_CASES.map((item) => item.id)).size).toBe(20);
    for (const item of GOLDEN_UNDERWRITING_CASES) {
      expect(item.referenceMethod.length).toBeGreaterThan(30);
      expect(item.referenceMethod).not.toMatch(/executeUnderwritingModel|saved engine output/i);
    }
  });

  for (const golden of GOLDEN_UNDERWRITING_CASES) {
    if (golden.kind === "lbo") {
      it(`${golden.id}: ${golden.responsibility}`, () => verifyLboGolden(golden));
    } else if (golden.kind === "returns") {
      it(`${golden.id}: ${golden.responsibility}`, () => {
        try {
          solvePeriodicIrr(golden.cashFlows);
          throw new Error("Expected an ambiguous IRR failure");
        } catch (error) {
          expect(error).toBeInstanceOf(UnderwritingError);
          expect((error as UnderwritingError).code).toBe(golden.expectedFailureCode);
        }
      });
    } else {
      it(`${golden.id}: ${golden.responsibility}`, () => {
        const model = compileUnderwritingModel(createStandardLboModel(golden.config));
        const snapshot = createStandardLboInputSnapshot(golden.config, golden.inputs);
        const result = executeSensitivity(model, snapshot, golden.definition);
        expect(result.status).toBe("SUCCEEDED");
        expect(result.cells).toHaveLength(4);
        for (const cell of result.cells) {
          const expected = golden.expectedMoicByCoordinate[`${cell.rowIndex}:${cell.columnIndex}`]!;
          expectDecimal(String(cell.outputs.gross_sponsor_moic), expected, "0.000000000000000000001");
          expect(cell.runSemanticIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
        }
      });
    }
  }
});
