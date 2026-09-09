import { beforeAll, describe, expect, it } from "vitest";
import {
  UNDERWRITING_LIMITS,
  UnderwritingError,
  canonicalSerialize,
  compileUnderwritingModel,
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  executeSensitivity,
  executeUnderwritingModel,
  semanticHash,
  type CompiledUnderwritingModel,
  type UnderwritingInputSnapshot,
  type UnderwritingRunResult,
} from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES, type GoldenLboCase } from "../underwriting-corpus/golden-cases";

interface Metrics {
  compileMeanMs: number;
  singleRunMeanMs: number;
  debtScheduleMeanMs: number;
  circularSolverMeanMs: number;
  sensitivity100Ms: number;
  sensitivity2500Ms: number;
  serializationHash100Ms: number;
}

const GUARDRAILS = Object.freeze({
  compileMeanMs: 100,
  singleRunMeanMs: 250,
  debtScheduleMeanMs: 250,
  circularSolverMeanMs: 500,
  sensitivity100Ms: 10_000,
  sensitivity2500Ms: 60_000,
  serializationHash100Ms: 5_000,
});

function lbo(id: string): GoldenLboCase {
  const fixture = GOLDEN_UNDERWRITING_CASES.find((item): item is GoldenLboCase => item.kind === "lbo" && item.id === id);
  if (!fixture) throw new Error(`missing benchmark fixture ${id}`);
  return structuredClone(fixture);
}

function compileFixture(fixture: GoldenLboCase): { model: CompiledUnderwritingModel; snapshot: UnderwritingInputSnapshot } {
  const model = compileUnderwritingModel(createStandardLboModel(fixture.config));
  return { model, snapshot: createStandardLboInputSnapshot(fixture.config, fixture.inputs) };
}

function meanExecutionMs(iterations: number, action: () => unknown): number {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) action();
  return (performance.now() - started) / iterations;
}

describe("P4 deterministic underwriting measured performance and hard limits", () => {
  let metrics: Metrics;
  let baseModel: CompiledUnderwritingModel;
  let baseSnapshot: UnderwritingInputSnapshot;
  let baseResult: UnderwritingRunResult;

  beforeAll(() => {
    const base = lbo("01-simple-annual-single-tranche");
    const debt = lbo("09-multiple-tranches");
    const circular = lbo("13-average-balance-circularity");
    ({ model: baseModel, snapshot: baseSnapshot } = compileFixture(base));
    const debtRuntime = compileFixture(debt);
    const circularRuntime = compileFixture(circular);

    // Warm the JIT before recording guardrail evidence.
    baseResult = executeUnderwritingModel(baseModel, baseSnapshot);
    executeUnderwritingModel(debtRuntime.model, debtRuntime.snapshot);
    executeUnderwritingModel(circularRuntime.model, circularRuntime.snapshot);

    const compileMeanMs = meanExecutionMs(20, () => compileUnderwritingModel(createStandardLboModel(base.config)));
    const singleRunMeanMs = meanExecutionMs(20, () => executeUnderwritingModel(baseModel, baseSnapshot));
    const debtScheduleMeanMs = meanExecutionMs(20, () => executeUnderwritingModel(debtRuntime.model, debtRuntime.snapshot));
    const circularSolverMeanMs = meanExecutionMs(20, () => executeUnderwritingModel(circularRuntime.model, circularRuntime.snapshot));

    const tenExitValues = Array.from({ length: 10 }, (_, index) => decimal(String(3 + index / 10)));
    const tenOwnershipValues = Array.from({ length: 10 }, (_, index) => decimal(String((index + 1) / 10)));
    let started = performance.now();
    const sensitivity100 = executeSensitivity(baseModel, baseSnapshot, {
      schemaVersion: "underwriting-sensitivity.v1",
      name: "Measured 100-cell sensitivity",
      rowAxis: { nodeId: "exit.multiple", values: tenExitValues },
      columnAxis: { nodeId: "ownership.sponsor", values: tenOwnershipValues },
      outputNodeIds: ["gross_sponsor_moic", "gross_sponsor_xirr"],
    });
    const sensitivity100Ms = performance.now() - started;
    expect(sensitivity100.cells).toHaveLength(100);

    const fiftyExitValues = Array.from({ length: 50 }, (_, index) => decimal(String(3 + index / 10)));
    const fiftyOwnershipValues = Array.from({ length: 50 }, (_, index) => decimal(String((index + 1) / 100)));
    started = performance.now();
    const sensitivity2500 = executeSensitivity(baseModel, baseSnapshot, {
      schemaVersion: "underwriting-sensitivity.v1",
      name: "Measured maximum 2,500-cell sensitivity",
      rowAxis: { nodeId: "exit.multiple", values: fiftyExitValues },
      columnAxis: { nodeId: "ownership.sponsor", values: fiftyOwnershipValues },
      outputNodeIds: ["gross_sponsor_moic"],
    });
    const sensitivity2500Ms = performance.now() - started;
    expect(sensitivity2500.cells).toHaveLength(UNDERWRITING_LIMITS.sensitivityCells);

    started = performance.now();
    for (let index = 0; index < 100; index += 1) {
      canonicalSerialize(baseResult);
      semanticHash(baseResult);
    }
    const serializationHash100Ms = performance.now() - started;

    metrics = {
      compileMeanMs,
      singleRunMeanMs,
      debtScheduleMeanMs,
      circularSolverMeanMs,
      sensitivity100Ms,
      sensitivity2500Ms,
      serializationHash100Ms,
    };
    console.info("P4_PURE_BENCHMARK " + JSON.stringify({ metrics, guardrails: GUARDRAILS }));
  }, 120_000);

  it("compiles a standard ModelIR inside the measured release guardrail", () => {
    expect(metrics.compileMeanMs).toBeLessThan(GUARDRAILS.compileMeanMs);
  });

  it("executes one standard LBO independently of DB, Excel, network or LLM inside the guardrail", () => {
    expect(baseResult).toMatchObject({ status: "SUCCEEDED", validity: "VALID" });
    expect(metrics.singleRunMeanMs).toBeLessThan(GUARDRAILS.singleRunMeanMs);
  });

  it("executes the multi-tranche debt schedule inside its measured guardrail", () => {
    expect(metrics.debtScheduleMeanMs).toBeLessThan(GUARDRAILS.debtScheduleMeanMs);
  });

  it("executes the bounded average-balance circular solver inside its measured guardrail", () => {
    expect(metrics.circularSolverMeanMs).toBeLessThan(GUARDRAILS.circularSolverMeanMs);
  });

  it("executes exactly 100 sensitivity cells inside its measured guardrail", () => {
    expect(metrics.sensitivity100Ms).toBeLessThan(GUARDRAILS.sensitivity100Ms);
  });

  it("executes the exact 2,500-cell maximum inside its measured guardrail", () => {
    expect(metrics.sensitivity2500Ms).toBeLessThan(GUARDRAILS.sensitivity2500Ms);
  });

  it("canonically serializes and hashes 100 complete results inside its measured guardrail", () => {
    expect(metrics.serializationHash100Ms).toBeLessThan(GUARDRAILS.serializationHash100Ms);
  });

  it("freezes and enforces the certified model, period, debt, scenario, sensitivity, solver and payload ceilings", () => {
    expect(UNDERWRITING_LIMITS).toMatchObject({
      modelNodes: 10_000,
      forecastPeriods: 240,
      debtTranches: 32,
      scenarioOverrides: 100,
      sensitivityCells: 2_500,
      solverIterations: 200,
      modelBytes: 5 * 1024 * 1024,
      resultBytes: 10 * 1024 * 1024,
    });
    const tooMany = Array.from({ length: 51 }, (_, index) => decimal(String(3 + index / 10)));
    try {
      executeSensitivity(baseModel, baseSnapshot, {
        schemaVersion: "underwriting-sensitivity.v1",
        name: "2,501-cell rejection",
        rowAxis: { nodeId: "exit.multiple", values: tooMany },
        columnAxis: { nodeId: "ownership.sponsor", values: Array.from({ length: 50 }, (_, index) => decimal(String((index + 1) / 100))) },
        outputNodeIds: ["gross_sponsor_moic"],
      });
      throw new Error("2,501-cell sensitivity unexpectedly executed");
    } catch (error) {
      expect(error).toBeInstanceOf(UnderwritingError);
      expect((error as UnderwritingError).code).toBe("SENSITIVITY_LIMIT");
    }
  });
});
