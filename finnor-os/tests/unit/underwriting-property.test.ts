import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_MODEL_SCHEMA_VERSION,
  UnderwritingError,
  add,
  applyScenario,
  canonicalSerialize,
  cmp,
  compileUnderwritingModel,
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  div,
  executeUnderwritingModel,
  runResultHash,
  sealInputSnapshot,
  semanticHash,
  solvePeriodicIrr,
  sub,
  type StandardLboInputValues,
  type StandardLboModelConfig,
  type UnderwritingModelIR,
} from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES } from "../underwriting-corpus/golden-cases";

function baseFixture(): { config: StandardLboModelConfig; inputs: StandardLboInputValues; periodId: string } {
  const golden = GOLDEN_UNDERWRITING_CASES.find((item) => item.id === "01-simple-annual-single-tranche");
  if (!golden || golden.kind !== "lbo") throw new Error("Golden base fixture is missing");
  const config = structuredClone(golden.config) as StandardLboModelConfig;
  const inputs = structuredClone(golden.inputs) as StandardLboInputValues;
  return { config, inputs, periodId: Object.keys(inputs.operating.ebitda!)[0]! };
}

function execute(config: StandardLboModelConfig, inputs: StandardLboInputValues) {
  const model = compileUnderwritingModel(createStandardLboModel(config));
  const snapshot = createStandardLboInputSnapshot(config, inputs);
  return { model, snapshot, result: executeUnderwritingModel(model, snapshot) };
}

describe("P4 underwriting deterministic properties", () => {
  it("same exact model and input snapshot always produce the same semantic result hash", () => {
    fc.assert(fc.property(
      fc.integer({ min: 51, max: 500 }),
      fc.integer({ min: 1, max: 50 }),
      (entryEv, debtSeed) => {
        const { config, inputs } = baseFixture();
        const debt = Math.min(debtSeed, entryEv - 1);
        inputs.entry.enterpriseValue = decimal(String(entryEv));
        inputs.debt.term!.openingPrincipal = decimal(String(debt));
        const first = execute(config, inputs).result;
        const second = execute(config, inputs).result;
        expect(first.resultSemanticHash).toBe(second.resultSemanticHash);
        expect(runResultHash(first)).toBe(first.resultSemanticHash);
      },
    ), { numRuns: 40, seed: 4_004 });
  });

  it("canonical serialization and hashes ignore object insertion order", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.integer()), { minLength: 1, maxLength: 30, selector: ([key]) => key }),
      (entries) => {
        const forward = Object.fromEntries(entries);
        const reverse = Object.fromEntries([...entries].reverse());
        expect(canonicalSerialize(forward)).toBe(canonicalSerialize(reverse));
        expect(semanticHash(forward)).toBe(semanticHash(reverse));
      },
    ), { numRuns: 100, seed: 4_005 });
  });

  it("generated balanced LBOs preserve Sources/Uses and every debt roll-forward identity", () => {
    fc.assert(fc.property(
      fc.record({ entryEv: fc.integer({ min: 51, max: 500 }), debt: fc.integer({ min: 1, max: 50 }), fcf: fc.integer({ min: 1, max: 20 }) }),
      ({ entryEv, debt: debtSeed, fcf }) => {
        const { config, inputs, periodId } = baseFixture();
        const debt = Math.min(debtSeed, entryEv - 1);
        inputs.entry.enterpriseValue = decimal(String(entryEv));
        inputs.debt.term!.openingPrincipal = decimal(String(debt));
        inputs.operating.ebitda = { [periodId]: decimal(String(fcf)) };
        inputs.exit.multiple = decimal("100");
        const { result } = execute(config, inputs);
        expect(result.status, result.failure?.message).toBe("SUCCEEDED");
        expect(result.checks.find((item) => item.nodeId === "check.sources_uses")?.passed).toBe(true);
        const value = (id: string) => String((result.values[id]!.value as Record<string, string>)[periodId]);
        const expectedEnding = sub(
          add(value("debt.term.opening_principal"), value("debt.term.draw"), value("debt.term.pik_interest")),
          add(value("debt.term.mandatory_amortization"), value("debt.term.cash_sweep")),
        );
        expect(value("debt.term.ending_principal")).toBe(expectedEnding);
        expect(cmp(expectedEnding, "0")).toBeGreaterThanOrEqual(0);
        const capacityBeforeSweep = sub(
          add(value("debt.term.opening_principal"), value("debt.term.draw"), value("debt.term.pik_interest")),
          value("debt.term.mandatory_amortization"),
        );
        expect(cmp(value("debt.term.cash_sweep"), capacityBeforeSweep)).toBeLessThanOrEqual(0);
      },
    ), { numRuns: 50, seed: 4_006 });
  });

  it("generated revolver draws never exceed the exact commitment", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), (cashDeficit) => {
      const { config, inputs, periodId } = baseFixture();
      config.debtTranches = [{
        id: "revolver", name: "Revolver", kind: "revolver", seniority: 0, sweepPriority: 0,
        rateType: "fixed", interestBasis: "beginning_balance", amortization: "explicit_amount",
        cashSweepEligible: false, maturityTreatment: "mandatory_repayment",
      }];
      inputs.debt = { revolver: {
        openingPrincipal: decimal("0"), commitment: decimal(String(cashDeficit + 5)), fixedRate: decimal("0"),
        cashInterestShare: decimal("1"), pikInterestShare: decimal("0"), mandatoryAmortizationAmounts: { [periodId]: decimal("0") }, maturityDate: "2027-12-31",
      } };
      inputs.operating.capex = { [periodId]: decimal(String(20 + cashDeficit)) };
      inputs.cash.minimum = decimal("5");
      const { result } = execute(config, inputs);
      expect(result.status, result.failure?.message).toBe("SUCCEEDED");
      const ending = String((result.values["debt.revolver.ending_principal"]!.value as Record<string, string>)[periodId]);
      expect(cmp(ending, String(cashDeficit + 5))).toBeLessThanOrEqual(0);
      expect(result.checks.find((item) => item.nodeId === "check.revolver_capacity")?.passed).toBe(true);
    }), { numRuns: 40, seed: 4_007 });
  });

  it("gross sponsor MOIC is positive distributions divided by absolute invested capital", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 90 }),
      fc.integer({ min: 1, max: 30 }),
      (debt, fcf) => {
        const { config, inputs, periodId } = baseFixture();
        inputs.debt.term!.openingPrincipal = decimal(String(debt));
        inputs.operating.ebitda = { [periodId]: decimal(String(fcf)) };
        inputs.exit.multiple = decimal("100");
        const { result } = execute(config, inputs);
        expect(result.status).toBe("SUCCEEDED");
        const invested = String(result.values["sources_uses.sponsor_equity"]!.value);
        const distributed = String(result.values["returns.sponsor_exit_proceeds"]!.value);
        expect(String(result.outputs.gross_sponsor_moic!.value)).toBe(div(distributed, invested));
      },
    ), { numRuns: 30, seed: 4_008 });
  });

  it("IRR is undefined for generated cash-flow sequences without a sign change", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 2, maxLength: 12 }),
      (amounts) => {
        try {
          solvePeriodicIrr(amounts.map((amount, index) => ({
            amount: decimal(String(amount)), date: `${2020 + index}-01-01`, type: "interim_distribution" as const,
          })));
          throw new Error("Expected IRR_UNDEFINED");
        } catch (error) {
          expect(error).toBeInstanceOf(UnderwritingError);
          expect((error as UnderwritingError).code).toBe("IRR_UNDEFINED");
        }
      },
    ), { numRuns: 50, seed: 4_009 });
  });

  it("scenario overrides never mutate the sealed base snapshot or historical result", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), (exitMultiple) => {
      const { config, inputs } = baseFixture();
      const { model, snapshot, result: historical } = execute(config, inputs);
      const beforeSnapshot = canonicalSerialize(snapshot);
      const beforeResult = canonicalSerialize(historical);
      const applied = applyScenario(model, snapshot, {
        schemaVersion: "underwriting-scenario.v1", name: "Generated", overrides: [{ nodeId: "exit.multiple", value: decimal(String(exitMultiple)) }],
      });
      executeUnderwritingModel(model, snapshot, {
        schemaVersion: "underwriting-scenario.v1", name: "Generated", overrides: [{ nodeId: "exit.multiple", value: decimal(String(exitMultiple)) }],
      });
      expect(canonicalSerialize(snapshot)).toBe(beforeSnapshot);
      expect(canonicalSerialize(historical)).toBe(beforeResult);
      expect(snapshot.values["exit.multiple"]!.value).toBe("5");
      expect(applied.snapshot.values["exit.multiple"]!.value).toBe(String(exitMultiple));
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(historical)).toBe(true);
    }), { numRuns: 30, seed: 4_010 });
  });

  it("undeclared cycles fail compilation while an exact declared block is structurally accepted", () => {
    const node = (id: string, dependency: string) => ({
      id, kind: "expression" as const, valueType: "decimal" as const, unit: "ratio" as const, shape: "scalar" as const,
      dependencies: [dependency], expression: { op: "ref" as const, nodeId: dependency },
    });
    const model: UnderwritingModelIR = {
      schemaVersion: UNDERWRITING_MODEL_SCHEMA_VERSION,
      modelKey: "cycle_property",
      modelVersion: "1",
      financialConventionVersion: "test/1",
      minimumEngineVersion: UNDERWRITING_ENGINE_VERSION,
      periodDefinition: { frequency: "annual", forecastStart: "2027-01-01", count: 1 },
      nodes: [node("calc.a", "calc.b"), node("calc.b", "calc.a")],
      circularBlocks: [],
    };
    expect(() => compileUnderwritingModel(model)).toThrowError(/undeclared cycle/i);
    expect(() => compileUnderwritingModel({
      ...model,
      circularBlocks: [{
        id: "solver.block", nodeIds: ["calc.a", "calc.b"], iterationOrder: ["calc.a", "calc.b"],
        settings: { algorithm: "fixed_point", initialState: "zero", absoluteTolerance: decimal("0.0001"), relativeTolerance: decimal("0.0001"), maxIterations: 10 },
      }],
    })).not.toThrow();
  });

  it("malformed decimals, NaN and Infinity can never enter a sealed snapshot", () => {
    fc.assert(fc.property(fc.constantFrom("NaN", "Infinity", "-Infinity", "$1", "1,000", " 1", "1%", ""), (bad) => {
      expect(() => decimal(bad)).toThrow();
    }), { numRuns: 30, seed: 4_011 });
    const { config, inputs } = baseFixture();
    const snapshot = createStandardLboInputSnapshot(config, inputs);
    const malformed = structuredClone(snapshot);
    (malformed.values["entry.enterprise_value"] as { value: unknown }).value = Number.NaN;
    delete (malformed as { semanticHash?: string }).semanticHash;
    expect(() => sealInputSnapshot(malformed)).toThrowError(/base-10|decimal/i);
  });
});
