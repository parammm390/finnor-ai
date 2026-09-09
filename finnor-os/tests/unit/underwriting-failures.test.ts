import { describe, expect, it } from "vitest";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_LIMITS,
  UNDERWRITING_MODEL_SCHEMA_VERSION,
  UnderwritingError,
  buildPeriods,
  compileUnderwritingModel,
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  executeSensitivity,
  executeUnderwritingModel,
  sealInputSnapshot,
  type ModelNode,
  type StandardLboInputValues,
  type StandardLboModelConfig,
  type UnderwritingInputSnapshot,
  type UnderwritingModelIR,
} from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES } from "../underwriting-corpus/golden-cases";

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(UnderwritingError);
    expect((error as UnderwritingError).code).toBe(code);
  }
}

function model(nodes: readonly ModelNode[], circularBlocks: UnderwritingModelIR["circularBlocks"] = []): UnderwritingModelIR {
  return {
    schemaVersion: UNDERWRITING_MODEL_SCHEMA_VERSION,
    modelKey: "failure_fixture",
    modelVersion: "1",
    financialConventionVersion: "failure-fixture/1",
    minimumEngineVersion: UNDERWRITING_ENGINE_VERSION,
    periodDefinition: { frequency: "annual", forecastStart: "2027-01-01", count: 1 },
    nodes,
    circularBlocks,
  };
}

function constant(id: string, unit: "ratio" | "money", value: string, currency?: string): ModelNode {
  return {
    id, kind: "constant", valueType: "decimal", unit, ...(currency ? { currency } : {}), shape: "scalar",
    dependencies: [], value: decimal(value), truthClass: "MODEL_PARAMETER",
  };
}

function baseFixture(): { config: StandardLboModelConfig; inputs: StandardLboInputValues; periodId: string } {
  const golden = GOLDEN_UNDERWRITING_CASES.find((item) => item.id === "01-simple-annual-single-tranche");
  if (!golden || golden.kind !== "lbo") throw new Error("Golden base fixture is missing");
  const config = structuredClone(golden.config) as StandardLboModelConfig;
  const inputs = structuredClone(golden.inputs) as StandardLboInputValues;
  return { config, inputs, periodId: Object.keys(inputs.operating.ebitda!)[0]! };
}

function standardResult(config: StandardLboModelConfig, inputs: StandardLboInputValues, snapshotMutator?: (snapshot: UnderwritingInputSnapshot) => void) {
  const compiled = compileUnderwritingModel(createStandardLboModel(config));
  let snapshot = createStandardLboInputSnapshot(config, inputs);
  if (snapshotMutator) {
    const mutable = structuredClone(snapshot) as UnderwritingInputSnapshot;
    delete (mutable as { semanticHash?: string }).semanticHash;
    snapshotMutator(mutable);
    snapshot = sealInputSnapshot(mutable);
  }
  return executeUnderwritingModel(compiled, snapshot);
}

describe("P4 exact typed failure census", () => {
  it("rejects duplicate nodes", () => {
    const node = constant("constant.a", "ratio", "1");
    expectCode(() => compileUnderwritingModel(model([node, structuredClone(node)])), "DUPLICATE_NODE");
  });

  it("rejects a missing dependency", () => {
    expectCode(() => compileUnderwritingModel(model([{
      id: "calc.a", kind: "expression", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: ["missing.a"],
      expression: { op: "ref", nodeId: "missing.a" },
    }])), "MISSING_DEPENDENCY");
  });

  it("rejects unit and currency mismatches", () => {
    const expression = (rightId: string): ModelNode => ({
      id: "calc.sum", kind: "expression", valueType: "decimal", unit: "money", currency: "USD", shape: "scalar",
      dependencies: ["constant.left", rightId], expression: { op: "add", args: [{ op: "ref", nodeId: "constant.left" }, { op: "ref", nodeId: rightId }] },
    });
    expectCode(() => compileUnderwritingModel(model([
      constant("constant.left", "money", "1", "USD"), constant("constant.rate", "ratio", "1"), expression("constant.rate"),
    ])), "UNIT_MISMATCH");
    expectCode(() => compileUnderwritingModel(model([
      constant("constant.left", "money", "1", "USD"), constant("constant.eur", "money", "1", "EUR"), expression("constant.eur"),
    ])), "CURRENCY_MISMATCH");
  });

  it("rejects undeclared cycles and malformed solver blocks", () => {
    const expression = (id: string, dependency: string): ModelNode => ({
      id, kind: "expression", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: [dependency], expression: { op: "ref", nodeId: dependency },
    });
    const nodes = [expression("calc.a", "calc.b"), expression("calc.b", "calc.a")];
    expectCode(() => compileUnderwritingModel(model(nodes)), "UNDECLARED_CYCLE");
    expectCode(() => compileUnderwritingModel(model(nodes, [{
      id: "solver.bad", nodeIds: ["calc.a", "calc.b"], iterationOrder: ["calc.a", "calc.a"],
      settings: { algorithm: "fixed_point", initialState: "zero", absoluteTolerance: decimal("0"), relativeTolerance: decimal("0"), maxIterations: 1 },
    }])), "INVALID_SOLVER_BLOCK");
  });

  it("rejects deep or unsupported expression AST and divide by zero", () => {
    let expression: unknown = { op: "literal", value: decimal("1"), valueType: "decimal", unit: "ratio" };
    for (let index = 0; index < UNDERWRITING_LIMITS.expressionDepth + 2; index += 1) expression = { op: "negate", arg: expression };
    expectCode(() => compileUnderwritingModel(model([{
      id: "calc.deep", kind: "expression", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: [], expression,
    } as ModelNode])), "AST_DEPTH_LIMIT");
    expectCode(() => compileUnderwritingModel(model([{
      id: "calc.bad", kind: "expression", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: [], expression: { op: "network_fetch" },
    } as unknown as ModelNode])), "UNSUPPORTED_EXPRESSION");

    const compiled = compileUnderwritingModel(model([
      constant("constant.one", "ratio", "1"), constant("constant.zero", "ratio", "0"),
      { id: "calc.div", kind: "expression", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: ["constant.one", "constant.zero"], expression: { op: "divide", args: [{ op: "ref", nodeId: "constant.one" }, { op: "ref", nodeId: "constant.zero" }] } },
      { id: "output.div", kind: "output", valueType: "decimal", unit: "ratio", shape: "scalar", dependencies: ["calc.div"], sourceNodeId: "calc.div" },
    ]));
    const result = executeUnderwritingModel(compiled, sealInputSnapshot({ schemaVersion: "underwriting-input-snapshot.v1", investmentCaseId: "11111111-1111-4111-8111-111111111111", worldAt: "2026-12-31T00:00:00.000Z", values: {} }));
    expect(result.failure?.code).toBe("DIVIDE_BY_ZERO");
  });

  it("rejects malformed, oversized decimals and invalid/oversized periods", () => {
    expectCode(() => decimal("1,000"), "INVALID_DECIMAL");
    expectCode(() => decimal(`1e${UNDERWRITING_LIMITS.resultBytes}`), "DECIMAL_LIMIT");
    expectCode(() => buildPeriods({ frequency: "annual", forecastStart: "2027-02-30", count: 1 }), "INVALID_PERIOD");
    expectCode(() => buildPeriods({ frequency: "monthly", forecastStart: "2027-01-01", count: UNDERWRITING_LIMITS.forecastPeriods + 1 }), "PERIOD_LIMIT");
  });

  it("fails missing, UNKNOWN, STALE and CONFLICTING required inputs without zero coercion", () => {
    const states = [
      ["UNKNOWN", "UNKNOWN_INPUT"],
      ["STALE", "STALE_INPUT"],
      ["CONFLICTING", "CONFLICTING_INPUT"],
    ] as const;
    for (const [status, code] of states) {
      const { config, inputs } = baseFixture();
      const result = standardResult(config, inputs, (snapshot) => {
        snapshot.values["entry.enterprise_value"]!.status = status;
        if (status === "UNKNOWN") snapshot.values["entry.enterprise_value"]!.value = null;
      });
      expect(result.failure?.code).toBe(code);
    }
    const { config, inputs } = baseFixture();
    const missing = standardResult(config, inputs, (snapshot) => {
      delete (snapshot.values as Record<string, unknown>)["entry.enterprise_value"];
    });
    expect(missing.failure?.code).toBe("MISSING_REQUIRED_INPUT");
  });

  it("allows STALE only when the exact InputNode policy explicitly allows it", () => {
    const { config, inputs } = baseFixture();
    const definition = createStandardLboModel(config);
    const policyDefinition: UnderwritingModelIR = {
      ...definition,
      nodes: definition.nodes.map((node) => node.id === "entry.enterprise_value" && node.kind === "input" ? { ...node, allowStale: true } : node),
    };
    const compiled = compileUnderwritingModel(policyDefinition);
    const mutable = structuredClone(createStandardLboInputSnapshot(config, inputs)) as UnderwritingInputSnapshot;
    delete (mutable as { semanticHash?: string }).semanticHash;
    mutable.values["entry.enterprise_value"]!.status = "STALE";
    const result = executeUnderwritingModel(compiled, sealInputSnapshot(mutable));
    expect(result.status, result.failure?.message).toBe("SUCCEEDED");
    expect(result.values["entry.enterprise_value"]?.calculation).toBe("input:STALE");
  });

  it("enforces exact truth-class policy", () => {
    const { config, inputs } = baseFixture();
    const definition = createStandardLboModel(config);
    const policyDefinition: UnderwritingModelIR = {
      ...definition,
      nodes: definition.nodes.map((node) => node.id === "entry.enterprise_value" && node.kind === "input"
        ? { ...node, allowedTruthClasses: ["CANONICAL_ASSUMPTION"] as const } : node),
    };
    const result = executeUnderwritingModel(compileUnderwritingModel(policyDefinition), createStandardLboInputSnapshot(config, inputs));
    expect(result.failure?.code).toBe("UNSUPPORTED_INPUT");
  });

  it("surfaces negative debt, Sources/Uses overfunding, liquidity shortage and revolver overflow distinctly", () => {
    {
      const { config, inputs } = baseFixture();
      inputs.debt.term!.openingPrincipal = decimal("-1");
      expect(standardResult(config, inputs).failure?.code).toBe("NEGATIVE_DEBT");
    }
    {
      const { config, inputs } = baseFixture();
      inputs.debt.term!.openingPrincipal = decimal("101");
      expect(standardResult(config, inputs).failure?.code).toBe("SOURCES_USES_IMBALANCE");
    }
    {
      const golden = GOLDEN_UNDERWRITING_CASES.find((item) => item.id === "11-revolver-minimum-cash");
      if (!golden || golden.kind !== "lbo") throw new Error("Revolver fixture missing");
      const config = structuredClone(golden.config) as StandardLboModelConfig;
      const inputs = structuredClone(golden.inputs) as StandardLboInputValues;
      inputs.debt.revolver!.commitment = decimal("14");
      expect(standardResult(config, inputs).failure?.code).toBe("LIQUIDITY_SHORTFALL");
    }
    {
      const golden = GOLDEN_UNDERWRITING_CASES.find((item) => item.id === "11-revolver-minimum-cash");
      if (!golden || golden.kind !== "lbo") throw new Error("Revolver fixture missing");
      const config = structuredClone(golden.config) as StandardLboModelConfig;
      const inputs = structuredClone(golden.inputs) as StandardLboInputValues;
      const periodId = Object.keys(inputs.operating.ebitda!)[0]!;
      inputs.debt.revolver!.openingPrincipal = decimal("20");
      inputs.debt.revolver!.commitment = decimal("10");
      inputs.operating.capex = { [periodId]: decimal("20") };
      inputs.cash.minimum = decimal("0");
      const result = standardResult(config, inputs);
      expect(result.status).toBe("SUCCEEDED");
      expect(result.validity).toBe("INVALID");
      expect(result.checks.find((check) => check.nodeId === "check.revolver_capacity")?.code).toBe("REVOLVER_EXHAUSTED");
      expect(result.checks.find((check) => check.nodeId === "check.revolver_capacity")?.passed).toBe(false);
    }
  });

  it("fails closed on non-convergence and reports NON_CONVERGENT validity", () => {
    const { config, inputs } = baseFixture();
    config.debtTranches = [{ ...config.debtTranches[0]!, interestBasis: "average_balance" }];
    config.solver = { algorithm: "fixed_point", initialState: "opening_balance", absoluteTolerance: decimal("0"), relativeTolerance: decimal("0"), maxIterations: 1 };
    inputs.debt.term!.fixedRate = decimal("0.1");
    const result = standardResult(config, inputs);
    expect(result.status).toBe("FAILED");
    expect(result.validity).toBe("NON_CONVERGENT");
    expect(result.failure?.code).toBe("NON_CONVERGENT");
  });

  it("keeps unsupported maturity and ownership failures as completed-but-invalid underwriting", () => {
    const { config, inputs } = baseFixture();
    config.periodDefinition = { frequency: "annual", forecastStart: "2027-01-01", count: 2 };
    config.debtTranches = [{ ...config.debtTranches[0]!, maturityTreatment: "unsupported" }];
    const ids = buildPeriods(config.periodDefinition).map((period) => period.id);
    inputs.operating.revenue = Object.fromEntries(ids.map((id) => [id, decimal("100")]));
    inputs.operating.ebitda = Object.fromEntries(ids.map((id) => [id, decimal("20")]));
    inputs.operating.capex = Object.fromEntries(ids.map((id) => [id, decimal("20")]));
    inputs.operating.nwc = Object.fromEntries(ids.map((id) => [id, decimal("0")]));
    inputs.operating.cashTaxRates = Object.fromEntries(ids.map((id) => [id, decimal("0")]));
    inputs.operating.otherCashAdjustments = Object.fromEntries(ids.map((id) => [id, decimal("0")]));
    inputs.interimDistributions = Object.fromEntries(ids.map((id) => [id, decimal("0")]));
    inputs.exit.periodId = ids[1]!;
    inputs.debt.term!.maturityDate = "2027-12-31";
    inputs.ownership.sponsor = decimal("0.9");
    inputs.ownership.other = decimal("0");
    const result = standardResult(config, inputs);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.validity).toBe("INVALID");
    expect(result.checks.find((check) => check.nodeId === "check.debt_maturity")?.passed).toBe(false);
    expect(result.checks.find((check) => check.nodeId === "check.ownership")?.passed).toBe(false);
  });

  it("surfaces exit metric, negative exit equity and zero sponsor denominator failures", () => {
    {
      const { config, inputs } = baseFixture();
      inputs.exit.periodId = "P999:not-a-model-period";
      expect(standardResult(config, inputs).failure?.code).toBe("EXIT_METRIC_MISSING");
    }
    {
      const { config, inputs, periodId } = baseFixture();
      inputs.operating.ebitda = { [periodId]: decimal("0") };
      inputs.operating.capex = { [periodId]: decimal("0") };
      expect(standardResult(config, inputs).failure?.code).toBe("NEGATIVE_EXIT_EQUITY");
    }
    {
      const { config, inputs } = baseFixture();
      inputs.entry.enterpriseValue = decimal("50");
      expect(standardResult(config, inputs).failure?.code).toBe("MOIC_UNDEFINED");
    }
  });

  it("rejects invalid/oversized scenario targets and oversized sensitivities", () => {
    const { config, inputs } = baseFixture();
    const compiled = compileUnderwritingModel(createStandardLboModel(config));
    const snapshot = createStandardLboInputSnapshot(config, inputs);
    expect(executeUnderwritingModel(compiled, snapshot, {
      schemaVersion: "underwriting-scenario.v1", name: "Bad", overrides: [{ nodeId: "exit.equity_value", value: decimal("1") }],
    }).failure?.code).toBe("SCENARIO_INVALID_TARGET");
    expect(executeUnderwritingModel(compiled, snapshot, {
      schemaVersion: "underwriting-scenario.v1", name: "Too many", overrides: Array.from({ length: UNDERWRITING_LIMITS.scenarioOverrides + 1 }, (_, index) => ({ nodeId: `missing.${index}`, value: decimal("1") })),
    }).failure?.code).toBe("SCENARIO_LIMIT");
    expectCode(() => executeSensitivity(compiled, snapshot, {
      schemaVersion: "underwriting-sensitivity.v1", name: "Too large",
      rowAxis: { nodeId: "entry.enterprise_value", values: Array.from({ length: 50 }, () => decimal("100")) },
      columnAxis: { nodeId: "exit.multiple", values: Array.from({ length: 51 }, () => decimal("5")) },
      outputNodeIds: ["gross_sponsor_moic"],
    }), "SENSITIVITY_LIMIT");
  });

  it("retains a failed sensitivity cell rather than interpolating or dropping it", () => {
    const { config, inputs } = baseFixture();
    const compiled = compileUnderwritingModel(createStandardLboModel(config));
    const snapshot = createStandardLboInputSnapshot(config, inputs);
    const sensitivity = executeSensitivity(compiled, snapshot, {
      schemaVersion: "underwriting-sensitivity.v1", name: "Partial",
      rowAxis: { nodeId: "exit.multiple", values: [decimal("5"), decimal("0")] },
      outputNodeIds: ["gross_sponsor_moic"],
    });
    expect(sensitivity.status).toBe("PARTIAL");
    expect(sensitivity.cells).toHaveLength(2);
    expect(sensitivity.cells[1]).toMatchObject({ rowIndex: 1, status: "FAILED", failureCode: "NEGATIVE_EXIT_EQUITY", outputs: {} });
  });

  it("enforces ModelVersion and result payload hard limits", () => {
    const oversized = model([constant("constant.a", "ratio", "1")]);
    oversized.metadata = { padding: "x".repeat(UNDERWRITING_LIMITS.modelBytes + 1) };
    expectCode(() => compileUnderwritingModel(oversized), "MODEL_TOO_LARGE");
  });
});
