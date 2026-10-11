import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as uw from "../../packages/underwriting/src/index";
import {
  captureR6NativeIdentity, checkDecisionProof, checkDecisionProofCurrentness, checkDecisionProofDomainMembership,
  proposeDecisionProof, r6FixedInputMetadataDigest, r6OwnerEnvelopeCommitmentsDigest, r6Sha256, runVerifiedCapitalCompiler,
  R6_CHECKER_PATH,
  type R6ResolvedProblem, type R6ProofPacket, type R6RunRequest, type R6CheckerOptions,
} from "../../packages/epistemic-runtime/src/verified-capital-compiler/index";
import type {
  R6InputDomain, R6MoneyConvention, R6NativeIdentity, R6ReferenceState, R6ScalarDomain,
} from "../../packages/shared-types/src/decision-proof";
import type { ExperimentRef } from "../../packages/shared-types/src/experiments";

const args = process.argv.slice(2);
const selected = args[args.indexOf("--case") + 1];
const evidence = resolve(args[args.indexOf("--evidence") + 1]!);
const repo = resolve(process.env.R6_REPOSITORY_ROOT!);
const deps = resolve(process.env.R6_DEPS_ROOT!);
assert(evidence.startsWith(join(repo, "scope-r/r6-verified-capital-compiler/evidence-private/")));
const results: Array<Record<string, unknown>> = [];
const reference = (id: string, contents: unknown): ExperimentRef => ({
  owner: "@finnor/epistemic-runtime", id: `SYNTHETIC_R6_${id}`, version: "1",
  contentDigest: uw.semanticHash(contents),
});
const at = "2026-01-01T00:00:00.000Z";
const caseId = "60000000-0000-4000-8000-000000000001";

async function retain(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function input(id: string, valueType: uw.ValueType = "decimal", unit: uw.ValueUnit = "money",
  shape: uw.ValueShape = "scalar"): uw.InputNode {
  return {
    id, kind: "input", valueType, unit, shape, dependencies: [], required: true,
    ...(unit === "money" ? { currency: "USD" } : {}),
    source: { kind: "explicit" }, allowedTruthClasses: ["MODEL_PARAMETER"],
  };
}
const nodeRef = (nodeId: string): uw.Expression => ({ op: "ref", nodeId });
const literal = (value: string, unit: uw.ValueUnit = "money"): uw.Expression => ({
  op: "literal", value: uw.decimal(value), valueType: "decimal", unit,
  ...(unit === "money" ? { currency: "USD" } : {}),
});
function expression(id: string, expr: uw.Expression, dependencies: string[],
  options: { unit?: uw.ValueUnit; rounding?: number; series?: boolean } = {}): uw.ExpressionNode | uw.SeriesNode {
  const unit = options.unit ?? "money";
  return {
    id, kind: options.series ? "series" : "expression", valueType: "decimal",
    unit, shape: options.series ? "series" : "scalar", dependencies,
    ...(unit === "money" ? { currency: "USD" } : {}),
    expression: expr,
    ...(options.rounding !== undefined ? { rounding: { decimalPlaces: options.rounding } } : {}),
  } as uw.ExpressionNode | uw.SeriesNode;
}
function output(id: string, source: uw.ModelNode): uw.OutputNode {
  return {
    id, kind: "output", valueType: source.valueType, unit: source.unit,
    ...(source.currency ? { currency: source.currency } : {}),
    shape: source.shape, dependencies: [source.id], sourceNodeId: source.id,
  };
}
function hardCheck(id: string, source: string, threshold = "0"): uw.CheckNode {
  return {
    id, kind: "check", valueType: "boolean", unit: "boolean", shape: "scalar",
    dependencies: [source], severity: "error", failureCode: "LIQUIDITY_SHORTFALL",
    assertion: { op: "compare", comparison: "gte", left: nodeRef(source), right: literal(threshold) },
  };
}
function model(nodes: uw.ModelNode[], periodDefinition: uw.PeriodDefinition = {
  frequency: "annual", forecastStart: "2026-01-01", count: 1,
}): uw.UnderwritingModelIR {
  return {
    schemaVersion: uw.UNDERWRITING_MODEL_SCHEMA_VERSION, modelKey: "r6-synthetic-mechanics",
    modelVersion: "1", financialConventionVersion: uw.FINANCIAL_CONVENTION_VERSION,
    minimumEngineVersion: uw.UNDERWRITING_ENGINE_VERSION,
    periodDefinition, nodes, circularBlocks: [],
  };
}
function snapshot(source: uw.UnderwritingModelIR, values: Record<string, uw.ModelValue>): uw.UnderwritingInputSnapshot {
  const resolved: Record<string, uw.ResolvedInput> = {};
  for (const node of source.nodes) if (node.kind === "input") {
    resolved[node.id] = {
      nodeId: node.id, valueType: node.valueType, unit: node.unit,
      ...(node.currency ? { currency: node.currency } : {}), shape: node.shape,
      value: values[node.id]!, truthClass: "MODEL_PARAMETER", status: "KNOWN",
      provenance: [{ kind: "model_parameter", id: `SYNTHETIC_R6_${node.id}`, versionId: "1" }],
    };
  }
  return uw.sealInputSnapshot({
    schemaVersion: "underwriting-input-snapshot.v1",
    investmentCaseId: caseId, worldAt: at, values: resolved,
  });
}
const lattice = (minimum: string, maximum: string, decimalPlaces: number): R6ScalarDomain => ({
  kind: "DECIMAL_LATTICE", minimum, maximum, decimalPlaces,
});
const enumeration = (...values: Array<string | boolean>): R6ScalarDomain => ({ kind: "ENUMERATION", values });
function moneyConvention(source: uw.UnderwritingModelIR): R6MoneyConvention {
  const periods = uw.buildPeriods(source.periodDefinition);
  return {
    currency: "USD", valuationDate: "2026-01-01",
    ownerShare: { numerator: "1", denominator: "1" },
    discountConventionRef: reference("NO_DISCOUNT_SYNTHETIC", { native: "no additional discount arithmetic" }),
    timeBasis: "EXACT_NATIVE_FINANCIAL_PERIODS",
    semantics: {
      entityType: "investment_case", entityId: caseId,
      periodStart: `${periods[0]!.startDate}T00:00:00.000Z`,
      periodEnd: `${periods.at(-1)!.endDate}T23:59:59.999Z`,
      unit: "currency", currencyCode: "USD", frequency: source.periodDefinition.frequency,
      calendar: "GREGORIAN", consolidation: "OWNER_SUBJECT_ONLY", instrument: "SYNTHETIC_DECLARED_R6_TEST",
      scale: "1", sign: "AS_RECORDED",
    },
  };
}
function state(id: string, role: R6ReferenceState["role"], nodeId: string,
  timing: R6ReferenceState["timing"]): R6ReferenceState {
  return {
    ledgerRef: reference(`DECLARED_LEDGER_${id}`, { id, role }), role, nodeId, timing,
    obligationRef: role === "LIABILITY" ? reference(`DECLARED_OBLIGATION_${id}`, { synthetic: true, id }) : null,
    obligationStatus: role === "LIABILITY" ? "REPRESENTED" : "NOT_APPLICABLE",
    sourceClauseRefs: [reference(`CLAUSE_${id}`, { synthetic: "explicit fixture interpretation, not accepted reference approval" })],
  };
}
function finishProblem(programme: uw.UnderwritingModelIR, referenceModel: uw.UnderwritingModelIR,
  witness: uw.UnderwritingInputSnapshot, componentBounds: Record<string, Record<string, R6ScalarDomain>>,
  states: R6ReferenceState[], identity: R6NativeIdentity): R6ResolvedProblem {
  const inputs: R6InputDomain["inputs"] = programme.nodes.filter((n): n is uw.InputNode => n.kind === "input").map(node => ({
    ownerRef: reference(`NATIVE_INPUT_${node.id}`, { nodeId: node.id, source: node.source }),
    programmeNodeId: node.id, referenceNodeId: node.id,
    valueType: node.valueType, unit: node.unit, currency: node.currency ?? null, shape: node.shape,
    components: componentBounds[node.id]!,
  }));
  return {
    programme,
    reference: {
      schema: "finnor.r6.reference-specification.v1",
      ref: reference("SUPPLIED_REFERENCE_UNAPPROVED", { referenceModel, states }),
      model: referenceModel, stateInventory: states,
      inventoryBasis: "ALL_DECLARED_REFERENCE_ITEMS_NOT_ALL_REAL_WORLD_OBLIGATIONS",
      moneyConventions: [moneyConvention(referenceModel)],
      assumptions: [{
        ref: reference("EXPLICIT_SYNTHETIC_MODEL_ASSUMPTION", { noBusinessTruth: true }),
        statement: "Synthetic declared financial mechanics only. No actual source truth, reference approval, modeled-world completeness, legal interpretation or S6 settlement is asserted.",
        qualification: "SUPPLIED_MODEL_RELATIVE",
      }],
      approval: null,
    },
    domain: {
      schema: "finnor.r6.input-domain.v1", ref: reference("DECLARED_DOMAIN", { inputs }),
      fixedInputMetadataDigest: r6FixedInputMetadataDigest(witness), inputs,
    },
    programmeBindings: states.map(s => ({ ledgerRef: s.ledgerRef, nodeId: s.nodeId, timing: s.timing })),
    witness, nativeIdentity: identity,
  };
}
function scalarProblem(identity: R6NativeIdentity, small = false, alternate = false): R6ResolvedProblem {
  const revenue = input("revenue"), liability = input("payment"), due = input("due", "boolean", "boolean");
  const payable = expression("payable", {
    op: "if", condition: nodeRef("due"), then: nodeRef("payment"), else: literal("0"),
  }, ["due", "payment"], { rounding: 2 });
  const alias = expression("payable_alias", nodeRef("payable"), ["payable"]);
  const cash = expression("cash_calc", {
    op: "subtract", args: [nodeRef("revenue"), nodeRef(alternate ? "payable_alias" : "payable")],
  }, ["revenue", alternate ? "payable_alias" : "payable"]);
  const paymentDate: uw.ConstantNode = {
    id: "payment_date", kind: "constant", valueType: "date", unit: "date", shape: "scalar",
    value: "2026-02-28", dependencies: [], truthClass: "MODEL_PARAMETER",
  };
  const nodes = [revenue, liability, due, payable, ...(alternate ? [alias] : []), cash, paymentDate,
    hardCheck("check_cash", "cash_calc"), output("cash_out", cash),
    output("liability_out", alternate ? alias : payable), output("date_out", paymentDate)];
  const programme = model(nodes);
  const referenceModel = alternate ? scalarProblem(identity, small, false).reference.model : structuredClone(programme);
  const witness = snapshot(programme, {
    revenue: small ? "5.001" : "100.005", payment: small ? "2.345" : "2.345", due: true,
  });
  const bounds = {
    revenue: { $scalar: small ? lattice("5", "5.003", 3) : lattice("100", "100000000000000000000", 3) },
    payment: { $scalar: small ? lattice("2.344", "2.346", 3) : lattice("0", "50", 3) },
    due: { $scalar: enumeration(false, true) },
  };
  return finishProblem(programme, referenceModel, witness, bounds, [
    state("cash", "CASH", "cash_out", { kind: "NODE", nodeId: "payment_date" }),
    state("liability", "LIABILITY", "liability_out", { kind: "NODE", nodeId: "payment_date" }),
    state("liquidity", "CONSTRAINT", "check_cash", { kind: "AS_OF", date: "2026-01-01" }),
    state("settlement", "TIMING", "date_out", { kind: "AS_OF", date: "2026-01-01" }),
  ], identity);
}
function seriesProblem(identity: R6NativeIdentity, frequency: uw.PeriodFrequency, small = false): R6ResolvedProblem {
  const definition: uw.PeriodDefinition = {
    frequency, forecastStart: frequency === "annual" ? "2024-02-29" : "2024-01-31",
    count: small ? 3 : 12, fiscalYearStartMonth: 7,
  };
  const periods = uw.buildPeriods(definition);
  const revenue = input("revenue", "decimal", "money", "series");
  const liability = input("payment", "decimal", "money", "series");
  const ready = input("history_ready", "boolean", "boolean", "series");
  const cash = expression("cash_series", { op: "subtract", args: [nodeRef("revenue"), nodeRef("payment")] },
    ["revenue", "payment"], { series: true, rounding: 2 });
  const debt = expression("liability_series", nodeRef("payment"), ["payment"], { series: true });
  const lag = expression("lagged_series", {
    op: "if", condition: nodeRef("history_ready"),
    then: { op: "lag", nodeId: "revenue", periods: 1 }, else: literal("0"),
  }, ["history_ready", "revenue"], { series: true });
  const aggregates: uw.AggregateNode[] = (["sum", "first", "last", "min", "max"] as const).map(method => ({
    id: `aggregate_${method}`, kind: "aggregate", valueType: "decimal", unit: "money",
    currency: "USD", shape: "scalar", dependencies: ["cash_series"],
    sourceNodeId: "cash_series", aggregation: method,
  }));
  const source = model([revenue, liability, ready, cash, debt, lag, ...aggregates,
    hardCheck("check_cash", "aggregate_sum"),
    output("cash_out", cash), output("liability_out", debt), output("lag_out", lag),
    ...aggregates.map(aggregate => output(`out_${aggregate.aggregation}`, aggregate))], definition);
  const numbers = Object.fromEntries(periods.map(p => [p.id, "10"]));
  const payments = Object.fromEntries(periods.map(p => [p.id, "2"]));
  const history = Object.fromEntries(periods.map(p => [p.id, p.ordinal > 0]));
  const witness = snapshot(source, { revenue: numbers, payment: payments, history_ready: history });
  const bounds = {
    revenue: Object.fromEntries(periods.map(p => [p.id, small ? lattice("10", "11", 0) : lattice("10", "1000000", 2)])),
    payment: Object.fromEntries(periods.map(p => [p.id, small ? lattice("2", "2", 0) : lattice("0", "2", 2)])),
    history_ready: Object.fromEntries(periods.map(p => [p.id, enumeration(p.ordinal > 0)])),
  };
  return finishProblem(source, structuredClone(source), witness, bounds, [
    state("cash_series", "CASH", "cash_out", { kind: "PERIOD_END" }),
    state("liability_series", "LIABILITY", "liability_out", { kind: "PERIOD_END" }),
    state("lagged_observable", "OBJECTIVE", "lag_out", { kind: "PERIOD_END" }),
    state("hard_liquidity", "CONSTRAINT", "check_cash", { kind: "AS_OF", date: "2026-01-01" }),
    ...aggregates.map(a => state(a.id, "OBJECTIVE", `out_${a.aggregation}`, { kind: "AS_OF", date: "2026-01-01" })),
  ], identity);
}
function arithmeticProblem(identity: R6NativeIdentity): R6ResolvedProblem {
  const x = input("x"), count = input("count", "decimal", "count"), choose = input("choose", "boolean", "boolean");
  const defs: Array<[string, uw.Expression, string[]]> = [
    ["neg", { op: "negate", arg: nodeRef("x") }, ["x"]],
    ["product", { op: "multiply", args: [nodeRef("x"), nodeRef("count")] }, ["x", "count"]],
    ["quotient", { op: "divide", args: [nodeRef("product"), nodeRef("count")] }, ["product", "count"]],
    ["minimum", { op: "min", args: [nodeRef("x"), literal("1")] }, ["x"]],
    ["maximum", { op: "max", args: [nodeRef("x"), literal("1")] }, ["x"]],
    ["sum", { op: "sum", args: [nodeRef("x"), nodeRef("neg"), literal("2")] }, ["x", "neg"]],
    ["choice", { op: "if", condition: nodeRef("choose"), then: nodeRef("minimum"), else: nodeRef("maximum") },
      ["choose", "minimum", "maximum"]],
    ["cash", { op: "add", args: [literal("100"), nodeRef("sum"), nodeRef("choice")] }, ["sum", "choice"]],
  ];
  const expressions = defs.map(([id, expr, refs]) => expression(id, expr, refs));
  const source = model([x, count, choose, ...expressions, hardCheck("check_cash", "cash"),
    ...expressions.map(node => output(`out_${node.id}`, node))]);
  const witness = snapshot(source, { x: "1.2345678901234567890123456789012345", count: "3", choose: true });
  const bounds = {
    x: { $scalar: lattice("1.2345678901234567890123456789012344", "1.2345678901234567890123456789012346", 34) },
    count: { $scalar: lattice("2", "3", 0) }, choose: { $scalar: enumeration(false, true) },
  };
  return finishProblem(source, structuredClone(source), witness, bounds, [
    ...expressions.map(node => state(node.id, node.id === "cash" ? "CASH" : "OBJECTIVE", `out_${node.id}`, { kind: "AS_OF", date: "2026-01-01" })),
    state("constraint", "CONSTRAINT", "check_cash", { kind: "AS_OF", date: "2026-01-01" }),
  ], identity);
}

function checkerOptions(dir: string, name = "checker"): R6CheckerOptions {
  return {
    repositoryRoot: repo, pythonExecutable: "/usr/bin/python3",
    decimalModulePath: join(deps, "decimal.js/decimal.mjs"),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    retainTranscript: transcript => retain(join(dir, `${name}.transcript.json`), transcript),
  };
}
function requestFor(problem: R6ResolvedProblem, dir: string): R6RunRequest {
  const grant = reference("ORIGINAL_EPISODE_GRANT_NOT_ISSUED", { synthetic: "no grant issuance" });
  return {
    envelope_inputs: {
      schema: "finnor.r6.artifact-envelope.v1", work_ref: reference("WORK", { synthetic: true }),
      work_revision: "1", tenant_ref: { owner: "@finnor/db", id: "SYNTHETIC_R6_TENANT" },
      baseline_manifest_ref: reference("BASELINE", { commit: "4a90ed33ca96afa252c51f511fea279e0034cddb" }),
      producer_ref: {
        code_digest: problem.nativeIdentity.producerDigest,
        dependency_lock_digest: problem.nativeIdentity.dependencyLockDigest, admission_ref: null,
      },
      input_refs: problem.domain.inputs.map(i => ({
        owner_ref: i.ownerRef, revision: "1", content_digest: i.ownerRef.contentDigest,
        as_of: at, rights_revision: 1,
      })),
      domain_ref: problem.domain.ref, assumptions_ref: reference("ASSUMPTIONS", problem.reference.assumptions),
      programme_grammar_ref: reference("EXISTING_NATIVE_IR", { schema: "underwriting-model-ir.v1" }),
      resource_receipt_refs: [], budget_grant_ref: grant,
      invalidation_dependency_refs: [{ key: "SYNTHETIC_OWNER_RIGHTS", revision: 1, digest: uw.semanticHash({ rights: 1 }), nodeIds: [] }],
      lifecycle_event_refs: [],
    },
    problem_ref: reference("NATIVE_PROGRAMME", problem.programme), existing_work_revision: "1",
    domain_profile_ref: problem.domain.ref, budget_grant_ref: grant,
    cancellation_ref: reference("CANCELLATION", { synthetic: false }), problem, checker: checkerOptions(dir),
  };
}
async function caseRun(id: string, expected: string, action: (dir: string) => Promise<unknown>): Promise<void> {
  const directory = join(evidence, id);
  await mkdir(directory);
  const start = performance.now();
  try {
    const observed = await action(directory);
    const result = { id, status: "PASS", expected, observed, elapsedMs: Math.round(performance.now() - start) };
    results.push(result);
    await retain(join(directory, "case.json"), result);
    console.log(`${id}: PASS`);
  } catch (error) {
    const result = {
      id, status: "FAIL", expected, actualFailure: String(error),
      stack: error instanceof Error ? error.stack : null, elapsedMs: Math.round(performance.now() - start),
    };
    results.push(result);
    await retain(join(directory, "case.json"), result);
    throw error;
  }
}
async function positive(problem: R6ResolvedProblem, dir: string): Promise<Awaited<ReturnType<typeof runVerifiedCapitalCompiler>>> {
  const run = await runVerifiedCapitalCompiler(requestFor(problem, dir));
  await retain(join(dir, "run.json"), run);
  assert.equal(run.receipt?.disposition, "ACCEPTED", `${run.receipt?.predicate}: ${run.receipt?.reason}`);
  assert.equal(run.receipt.allInputEquivalence, true);
  assert.equal(run.receipt.universallyValid, true);
  assert.equal(run.status, "INCOMPLETE", "Ordinary proof cannot self-approve the reference or admit its checker");
  assert.equal(run.proof?.qualification.referenceApproval, "NOT_ESTABLISHED");
  assert.equal(run.proof?.executionAuthorityGranted, false);
  assert.equal(run.proof?.reservationGranted, false);
  assert.equal(run.artifact_ref, null, "Leaf did not falsely claim DB persistence");
  return run;
}
function alternatives(raw: R6ScalarDomain): Array<string | boolean> {
  if (raw.kind === "ENUMERATION") return raw.values;
  const scale = 10n ** BigInt(raw.decimalPlaces);
  const coefficient = (value: string): bigint => {
    const canonical = uw.decimal(value);
    const [integer, fraction = ""] = canonical.split(".");
    return BigInt(integer!) * scale + BigInt(fraction.padEnd(raw.decimalPlaces, "0"));
  };
  const lower = coefficient(raw.minimum), upper = coefficient(raw.maximum);
  assert(upper - lower <= 4096n, "Finite native comparison does not enumerate a narrowed large domain");
  const values: string[] = [];
  for (let n = lower; n <= upper; n++) {
    const digits = n.toString().padStart(raw.decimalPlaces + 1, "0");
    values.push(uw.decimal(raw.decimalPlaces ? `${digits.slice(0, -raw.decimalPlaces)}.${digits.slice(-raw.decimalPlaces)}` : digits));
  }
  return values;
}
async function conformance(problem: R6ResolvedProblem, dir: string): Promise<unknown> {
  const run = await positive(problem, dir);
  const packet = run.packet!;
  const components = problem.domain.inputs.flatMap(binding => Object.entries(binding.components).map(([component, raw]) => ({
    binding, component, values: alternatives(raw),
  })));
  const count = components.reduce((n, c) => n * c.values.length, 1);
  assert(count <= 4096);
  assert.equal(String(count), run.receipt!.domainCardinality);
  const trials: Array<{ snapshot: uw.UnderwritingInputSnapshot; nativeResult: uw.UnderwritingRunResult }> = [];
  const values: Record<string, uw.ModelValue> = {};
  const enumerate = (index: number): void => {
    if (index === components.length) {
      const s = snapshot(problem.programme, structuredClone(values));
      const nativeResult = uw.executeUnderwritingModel(packet.compiledProgramme, s);
      assert.equal(nativeResult.status, "SUCCEEDED");
      trials.push({ snapshot: s, nativeResult });
      return;
    }
    const { binding, component, values: permitted } = components[index]!;
    for (const value of permitted) {
      if (component === "$scalar") values[binding.programmeNodeId] = value;
      else {
        const series = values[binding.programmeNodeId] as Record<string, uw.ScalarValue> | undefined;
        values[binding.programmeNodeId] = { ...series, [component]: value };
      }
      enumerate(index + 1);
    }
  };
  enumerate(0);
  const packetPath = join(dir, "packet.json"), conformancePath = join(dir, "conformance-inputs.json");
  await retain(packetPath, packet);
  await retain(conformancePath, {
    schema: "finnor.r6.complete-finite-conformance.v1", packetDigest: uw.semanticHash(packet), trials,
  });
  const command = ["/usr/bin/python3", "-I", "-B", join(repo, R6_CHECKER_PATH), "--repo", repo,
    "--packet", packetPath, "--decimal-module", join(deps, "decimal.js/decimal.mjs"),
    "--conformance", conformancePath];
  const executed = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  await retain(join(dir, "conformance-process.json"), { command, pid: executed.pid, status: executed.status, stdout: executed.stdout, stderr: executed.stderr, error: String(executed.error ?? "") });
  assert.equal(executed.status, 0, executed.stderr);
  const independent = JSON.parse(executed.stdout);
  assert.equal(independent.disposition, "ACCEPTED", `${independent.predicate}: ${independent.reason}`);
  assert.equal(independent.finiteConformance.checkedInputs, String(count));
  await retain(join(dir, "conformance-receipt.json"), independent);
  return { allInputProof: run.receipt, fullFiniteNativeComparison: independent.finiteConformance };
}
function refreshProofBindings(packet: R6ProofPacket): void {
  packet.proof.programmeDigest = uw.semanticHash(packet.programme);
  packet.proof.referenceDigest = uw.semanticHash(packet.reference);
  packet.proof.domainDigest = uw.semanticHash(packet.domain);
  packet.proof.bindingsDigest = uw.semanticHash(packet.programmeBindings);
  packet.proof.compiledProgrammeDigest = uw.semanticHash(packet.compiledProgramme);
  packet.proof.compiledReferenceDigest = uw.semanticHash(packet.compiledReference);
  packet.proof.nativeIdentityDigest = uw.semanticHash(packet.nativeIdentity);
  packet.proof.witnessDigest = uw.semanticHash(packet.witness);
}

async function core(identity: R6NativeIdentity): Promise<void> {
  let originalProof: Awaited<ReturnType<typeof runVerifiedCapitalCompiler>> | null = null;
  await caseRun("whole-domain-cash-liability", "Independent all-input proof on an explicitly large domain; no approved-reference or authority claim", async dir => {
    originalProof = await positive(scalarProblem(identity), dir);
    assert(BigInt(originalProof.receipt!.domainCardinality!) > 100000000000000000000000n);
    return originalProof.receipt;
  });
  await caseRun("different-ordinary-code-structure", "No-rounding let/alias changes pass checked congruence", async dir => {
    const problem = scalarProblem(identity, false, true);
    assert.notEqual(uw.semanticHash(problem.programme), uw.semanticHash(problem.reference.model));
    return (await positive(problem, dir)).receipt;
  });
  await caseRun("small-decimal-complete-native-conformance", "Every input of frozen 24-input D matches exact independent arithmetic, including HALF_EVEN ties", dir => conformance(scalarProblem(identity, true), dir));
  for (const frequency of ["annual", "quarterly", "monthly"] as const) {
    await caseRun(`twelve-period-${frequency}`, "All periods/lazy lag guards/aggregates/outputs checked, not sampled; Gregorian/fiscal calendar reconstructed", async dir => {
      const run = await positive(seriesProblem(identity, frequency), dir);
      assert.equal(run.receipt!.coverage.periods, 12);
      return run.receipt;
    });
  }
  await caseRun("small-series-complete-native-conformance", "Every input of frozen eight-input D checks series/lag/sum/min/max/first/last/output semantics", dir => conformance(seriesProblem(identity, "monthly", true), dir));
  await caseRun("precision34-expression-complete-conformance", "Every input of frozen twelve-input D checks native arithmetic folds and 34-significant-digit rounding", dir => conformance(arithmeticProblem(identity), dir));

  type Mutation = { id: string; expected: string; problem?: (identity: R6NativeIdentity) => R6ResolvedProblem; mutate?: (problem: R6ResolvedProblem) => void; packet?: (packet: R6ProofPacket) => void };
  const mutations: Mutation[] = [
    { id: "currency", expected: "CURRENCY_MISMATCH", mutate: p => {
      // Keep the mutated native programme internally well-typed: literal
      // currencies must change too, or native compilation fails before the
      // independent checker can test reference/programme currency drift.
      const changeCurrency = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.currency === "string") record.currency = "EUR";
        for (const child of Object.values(record)) changeCurrency(child);
      };
      changeCurrency(p.programme);
      for (const i of Object.values(p.witness.values)) if (i.currency) (i as uw.ResolvedInput).currency = "EUR";
      p.witness = uw.sealInputSnapshot({ ...p.witness, semanticHash: undefined });
      p.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(p.witness);
    }, packet: p => {
      const values: Record<string, uw.ModelValue> = {};
      for (const [id, i] of Object.entries(p.witness.values)) values[id] = i.value!;
      p.nativeWitness.referenceSnapshot = snapshot(p.reference.model, values);
      p.nativeWitness.reference = uw.executeUnderwritingModel(p.compiledReference, p.nativeWitness.referenceSnapshot);
      assert.equal(p.nativeWitness.programme.status, "SUCCEEDED");
      assert.equal(p.nativeWitness.reference.status, "SUCCEEDED");
    }},
    { id: "rounding-placement", expected: "ORDERED_TERM_CONGRUENCE", mutate: p => {
      const payable = p.programme.nodes.find(n => n.id === "payable")!;
      delete payable.rounding;
      p.programme.nodes.find(n => n.id === "liability_out")!.rounding = { decimalPlaces: 2 };
    }},
    { id: "missing-liability", expected: "COMPLETE_STATE_INVENTORY", mutate: p => { p.programmeBindings = p.programmeBindings.filter(b => b.nodeId !== "liability_out"); }},
    { id: "shifted-payment-date", expected: "SETTLEMENT_TIMING", mutate: p => { (p.programme.nodes.find(n => n.id === "payment_date") as uw.ConstantNode).value = "2026-03-01"; }},
    { id: "double-inflow", expected: "ORDERED_TERM_CONGRUENCE", mutate: p => {
      (p.programme.nodes.find(n => n.id === "cash_calc") as uw.ExpressionNode).expression = {
        op: "subtract", args: [{ op: "add", args: [nodeRef("revenue"), nodeRef("revenue")] }, nodeRef("payable")],
      };
    }},
    { id: "false-branch-guard", expected: "ORDERED_TERM_CONGRUENCE", mutate: p => {
      const payable = p.programme.nodes.find(n => n.id === "payable") as uw.ExpressionNode;
      payable.expression = { op: "if", condition: { op: "literal", value: false, valueType: "boolean", unit: "boolean" }, then: nodeRef("payment"), else: literal("0") };
      payable.dependencies = ["payment"];
    }},
    { id: "empty-domain-bounds", expected: "EMPTY_DOMAIN", mutate: p => { p.domain.inputs[0]!.components.$scalar = lattice("200", "100", 0); }},
    { id: "empty-domain-enumeration", expected: "EMPTY_DOMAIN", mutate: p => { p.domain.inputs[2]!.components.$scalar = enumeration(); }},
    { id: "hard-constraint-false", expected: "UNIVERSAL_HARD_CONSTRAINT", mutate: p => {
      p.domain.inputs[0]!.components.$scalar = lattice("10", "12", 0);
      p.domain.inputs[1]!.components.$scalar = lattice("20", "20", 0);
      p.witness = snapshot(p.programme, { revenue: "10", payment: "20", due: false });
      p.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(p.witness);
    }},
    { id: "possible-zero-divisor", expected: "DIVISOR_TOTALITY", problem: arithmeticProblem, mutate: p => {
      p.domain.inputs.find(i => i.programmeNodeId === "count")!.components.$scalar = lattice("0", "3", 0);
    }},
    { id: "applicable-preforecast-lag", expected: "EXECUTION_TOTALITY", problem: i => seriesProblem(i, "monthly", true), mutate: p => {
      const first = uw.buildPeriods(p.programme.periodDefinition)[0]!.id;
      p.domain.inputs.find(i => i.programmeNodeId === "history_ready")!.components[first] = enumeration(true);
      const values = structuredClone(p.witness.values);
      (values.history_ready!.value as Record<string, boolean>)[first] = true;
      p.witness = uw.sealInputSnapshot({ ...p.witness, semanticHash: undefined, values });
      p.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(p.witness);
    }},
    { id: "unknown-native-input", expected: "WITNESS_TRUTH_POLICY", mutate: p => {
      const values = structuredClone(p.witness.values);
      values.revenue!.status = "UNKNOWN";
      p.witness = uw.sealInputSnapshot({ ...p.witness, semanticHash: undefined, values });
      p.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(p.witness);
    }},
    { id: "unknown-owner-liability", expected: "UNKNOWN_LIABILITY", mutate: p => { p.reference.stateInventory.find(s => s.role === "LIABILITY")!.obligationStatus = "UNKNOWN"; }},
    { id: "source-pin", expected: "NATIVE_SOURCE_PIN", packet: p => { p.nativeIdentity.sourcePins[0]!.sha256 = "0".repeat(64); }},
    { id: "lock-pin", expected: "DEPENDENCY_LOCK_PIN", packet: p => { p.nativeIdentity.dependencyLockDigest = `sha256:${"0".repeat(64)}`; }},
    { id: "domain-proof-pin", expected: "PROOF_BINDING_domainDigest", packet: p => { p.proof.domainDigest = `sha256:${"0".repeat(64)}`; }},
    { id: "compiled-execution-order", expected: "NATIVE_COMPILED_PROGRAMME", packet: p => { p.compiledProgramme.executionOrder = [...p.compiledProgramme.executionOrder].reverse(); }},
    { id: "omitted-proof-statement", expected: "PROOF_STATEMENT_COVERAGE", packet: p => { p.proof.statements.pop(); }},
    { id: "unapproved-axiom", expected: "UNAPPROVED_AXIOMS", packet: p => { (p.proof.axioms as unknown[]) = ["cash theorem by assumption"]; }},
    { id: "unresolved-proof-goal", expected: "UNRESOLVED_GOALS", packet: p => { (p.proof.unresolvedGoals as unknown[]) = ["settlement date"]; }},
    { id: "outside-domain-witness", expected: "WITNESS_DOMAIN", mutate: p => {
      p.witness = snapshot(p.programme, { revenue: "99", payment: "2.345", due: false });
      p.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(p.witness);
    }},
    { id: "duplicate-input-owner", expected: "DUPLICATE_INPUT_OWNER", mutate: p => { p.domain.inputs[1]!.ownerRef = p.domain.inputs[0]!.ownerRef; }},
    { id: "changed-fixed-owner-metadata", expected: "DOMAIN_FIXED_INPUT_METADATA", packet: p => { p.domain.fixedInputMetadataDigest = `sha256:${"0".repeat(64)}`; }},
  ];
  assert(mutations.length <= 24);
  for (const mutation of mutations) {
    await caseRun(`mutation-${mutation.id}`, `Independent checker reaches and refuses ${mutation.expected}`, async dir => {
      const problem = structuredClone((mutation.problem ?? scalarProblem)(identity));
      mutation.mutate?.(problem);
      const packet = structuredClone(proposeDecisionProof(problem));
      mutation.packet?.(packet);
      if (mutation.id !== "domain-proof-pin") refreshProofBindings(packet);
      await retain(join(dir, "packet.json"), packet);
      const receipt = await checkDecisionProof(packet, checkerOptions(dir));
      await retain(join(dir, "receipt.json"), receipt);
      assert.notEqual(receipt.disposition, "ACCEPTED");
      assert.equal(receipt.predicate, mutation.expected, receipt.reason ?? "");
      assert.deepEqual(receipt.checkedInvariants, []);
      return receipt;
    });
  }
  await caseRun("mutation-live-native-numeric-policy", "Actual changed native Decimal clone configuration cannot produce a candidate or independent proof claim", async dir => {
    const problem = scalarProblem(identity);
    const precision = uw.FinnorDecimal.precision;
    uw.FinnorDecimal.set({ precision: 12 });
    try {
      const response = await runVerifiedCapitalCompiler(requestFor(problem, dir));
      await retain(join(dir, "response.json"), response);
      assert.equal(response.status, "UNKNOWN");
      assert.equal(response.proof, null);
      assert(response.reason?.includes("Live native Decimal"));
      let captureRefused = false;
      try { await captureR6NativeIdentity({ repositoryRoot: repo, dependencyRoot: deps }); }
      catch { captureRefused = true; }
      assert(captureRefused);
      return { response, captureRefused, changedLivePrecision: 12, restoredPrecision: precision };
    } finally { uw.FinnorDecimal.set({ precision }); }
  });
  const faultPacket = proposeDecisionProof(scalarProblem(identity));
  await caseRun("checker-real-crash", "SIGKILL the actual independently checked Python child; no receipt acceptance", async dir => {
    const options = checkerOptions(dir);
    options.onChildStarted = pid => process.kill(pid, "SIGKILL");
    const receipt = await checkDecisionProof(faultPacket, options);
    await retain(join(dir, "receipt.json"), receipt);
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_PROCESS_FAILURE");
    const transcript = JSON.parse(await readFile(join(dir, "checker.transcript.json"), "utf8"));
    assert(transcript.pid > 0 && transcript.signal === "SIGKILL");
    return receipt;
  });
  await caseRun("checker-original-deadline", "Original short owner deadline kills actual checker, not a new episode/grant", async dir => {
    const options = checkerOptions(dir);
    options.deadlineAt = new Date(Date.now() + 25).toISOString();
    const receipt = await checkDecisionProof(faultPacket, options);
    await retain(join(dir, "receipt.json"), receipt);
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_TIMEOUT");
    const transcript = JSON.parse(await readFile(join(dir, "checker.transcript.json"), "utf8"));
    assert(transcript.pid > 0 && transcript.signal === "SIGKILL");
    return receipt;
  });
  await caseRun("checker-real-cancellation", "Cancellation kills the actual child and grants no financial/effect claim", async dir => {
    const options = checkerOptions(dir), controller = new AbortController();
    options.signal = controller.signal;
    options.onChildStarted = () => controller.abort();
    const receipt = await checkDecisionProof(faultPacket, options);
    await retain(join(dir, "receipt.json"), receipt);
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_CANCELLED");
    return receipt;
  });
  await caseRun("checker-retention-cancellation", "Actual independent child completes, but original cancellation during transcript retention prevents publication", async dir => {
    const options = checkerOptions(dir), controller = new AbortController();
    options.signal = controller.signal;
    options.retainTranscript = async transcript => {
      await retain(join(dir, "checker.transcript.json"), transcript);
      controller.abort();
    };
    const receipt = await checkDecisionProof(faultPacket, options);
    await retain(join(dir, "receipt.json"), receipt);
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_CANCELLED");
    const transcript = JSON.parse(await readFile(join(dir, "checker.transcript.json"), "utf8"));
    assert.equal(JSON.parse(transcript.stdout).disposition, "ACCEPTED");
    assert(transcript.pid > 0);
    return receipt;
  });
  await caseRun("checker-real-retention-failure", "Actual independently accepted child result cannot publish after a real filesystem transcript-sink failure", async dir => {
    const options = checkerOptions(dir);
    let originalTranscript: unknown = null;
    options.retainTranscript = transcript => {
      originalTranscript = transcript;
      return retain(join(dir, "absent-directory", "checker.transcript.json"), transcript);
    };
    const receipt = await checkDecisionProof(faultPacket, options);
    await retain(join(dir, "receipt.json"), receipt);
    assert(originalTranscript);
    // Evidence salvage is not an alternate acceptance or a reset episode.
    await retain(join(dir, "actual-transcript-after-primary-sink-failure.json"), originalTranscript);
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_TRANSCRIPT_RETENTION");
    assert(receipt.reason?.includes("ENOENT"));
    return receipt;
  });
  await caseRun("alternate-checker-forbidden", "A producer executable cannot replace the enrolled independent checker", async dir => {
    const receipt = await checkDecisionProof(faultPacket, { ...checkerOptions(dir), pythonExecutable: "/usr/bin/true" });
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_INTERPRETER");
    await retain(join(dir, "receipt.json"), receipt);
    return receipt;
  });
  await caseRun("checker-pin-response-fence", "Wrong checker identity is refused before executing a different checker", async dir => {
    const packet = structuredClone(faultPacket);
    packet.nativeIdentity.checkerDigest = `sha256:${"0".repeat(64)}`;
    refreshProofBindings(packet);
    await retain(join(dir, "packet.json"), packet);
    let started = false;
    const receipt = await checkDecisionProof(packet, {
      ...checkerOptions(dir), onChildStarted: () => { started = true; },
    });
    assert.equal(receipt.disposition, "UNKNOWN");
    assert.equal(receipt.predicate, "CHECKER_ENTRY_PIN");
    assert.equal(started, false);
    await retain(join(dir, "receipt.json"), receipt);
    return receipt;
  });
  await caseRun("substituted-checker-entry-forbidden", "A supplied repository root cannot execute its producer-written checker entry", async dir => {
    const otherRoot = join(dir, "substituted-root");
    const otherEntry = join(otherRoot, R6_CHECKER_PATH);
    await mkdir(dirname(otherEntry), { recursive: true });
    await writeFile(otherEntry, 'raise Exception("PRODUCER_CHECKER_EXECUTED")\n', { flag: "wx" });
    const receipt = await checkDecisionProof(faultPacket, { ...checkerOptions(dir), repositoryRoot: otherRoot });
    await retain(join(dir, "receipt.json"), receipt);
    assert.equal(receipt.disposition, "UNKNOWN");
    const transcript = JSON.parse(await readFile(join(dir, "checker.transcript.json"), "utf8"));
    assert.equal(transcript.command[3], join(repo, R6_CHECKER_PATH));
    assert.equal(transcript.stdout.includes("PRODUCER_CHECKER_EXECUTED"), false);
    assert.equal(transcript.stderr.includes("PRODUCER_CHECKER_EXECUTED"), false);
    return { receipt, actualCommand: transcript.command, substitutedEntry: otherEntry };
  });
  await caseRun("currentness-and-historical-evidence", "Changed Work/rights/domain/native/checker vectors invalidate only use; immutable original proof remains", async dir => {
    assert(originalProof?.proof);
    const proof = originalProof.proof, packet = originalProof.packet!;
    const current = {
      workRevision: proof.envelope.work_revision, programmeDigest: packet.proof.programmeDigest,
      ownerEnvelopeDigest: r6OwnerEnvelopeCommitmentsDigest(proof.envelope), bindingsDigest: packet.proof.bindingsDigest,
      referenceDigest: packet.proof.referenceDigest, domainDigest: packet.proof.domainDigest,
      nativeIdentityDigest: packet.proof.nativeIdentityDigest,
      dependencies: proof.envelope.invalidation_dependency_refs,
    };
    const digest = uw.semanticHash(proof);
    const original = checkDecisionProofCurrentness(proof, current);
    assert.equal(original.status, "CURRENT");
    assert.equal(original.certifiedLabelPermitted, false);
    const variants = [
      { ...current, workRevision: "2" },
      { ...current, programmeDigest: uw.semanticHash("changed programme") },
      { ...current, bindingsDigest: uw.semanticHash("changed ledger/statement bindings") },
      { ...current, domainDigest: uw.semanticHash("changed domain") },
      { ...current, nativeIdentityDigest: uw.semanticHash("changed native/checker method") },
      { ...current, dependencies: [{ key: "SYNTHETIC_OWNER_RIGHTS", revision: 2, digest: uw.semanticHash({ rights: 2 }), nodeIds: [] }] },
      ...[
        { ...proof.envelope, work_ref: reference("DIFFERENT_WORK", { revision: "1" }) },
        { ...proof.envelope, tenant_ref: { owner: "@finnor/db" as const, id: "DIFFERENT_TENANT" } },
        { ...proof.envelope, budget_grant_ref: reference("DIFFERENT_ORIGINAL_GRANT", { issued: false }) },
        { ...proof.envelope, input_refs: [] },
        { ...proof.envelope, assumptions_ref: reference("DIFFERENT_ASSUMPTIONS", {}) },
        { ...proof.envelope, programme_grammar_ref: reference("DIFFERENT_GRAMMAR", {}) },
        { ...proof.envelope, baseline_manifest_ref: reference("DIFFERENT_BASELINE", {}) },
      ].map(envelope => ({ ...current, ownerEnvelopeDigest: r6OwnerEnvelopeCommitmentsDigest(envelope) })),
    ];
    const observed = variants.map(v => checkDecisionProofCurrentness(proof, v));
    assert(observed.every(o => o.status === "INVALIDATED" && !o.certifiedLabelPermitted));
    assert.equal(uw.semanticHash(proof), digest);
    await retain(join(dir, "currentness.json"), { original, variants, observed, immutableOriginalDigest: digest });
    return { original, observed };
  });
  await caseRun("actual-domain-membership-consumption", "Actual later native snapshots must belong to the proved D; metadata/lattice/bounds/receipt faults cannot permit a certified label", async dir => {
    assert(originalProof?.packet && originalProof.receipt);
    const packet = originalProof.packet, receipt = originalProof.receipt;
    const sourceDigest = uw.semanticHash(packet);
    const revenue = packet.domain.inputs.find(i => i.programmeNodeId === "revenue")!.components.$scalar!;
    assert.equal(revenue.kind, "DECIMAL_LATTICE");
    if (revenue.kind !== "DECIMAL_LATTICE") throw new Error("Expected registered decimal domain");
    const changedSnapshot = (change: (s: uw.UnderwritingInputSnapshot) => void): uw.UnderwritingInputSnapshot => {
      const copy = structuredClone(packet.witness);
      delete copy.semanticHash;
      change(copy);
      return uw.sealInputSnapshot(copy);
    };
    const inside = changedSnapshot(s => { s.values.revenue!.value = revenue.maximum; });
    const outside = changedSnapshot(s => { s.values.revenue!.value = uw.add(revenue.maximum, "1"); });
    const offLattice = changedSnapshot(s => {
      s.values.revenue!.value = uw.add(revenue.minimum, `1e-${revenue.decimalPlaces + 1}`);
    });
    const unknown = changedSnapshot(s => { s.values.revenue!.status = "UNKNOWN"; s.values.revenue!.value = null; });
    const asOf = changedSnapshot(s => { s.worldAt = "2026-01-01T00:00:00.001Z"; });
    const variants = [packet.witness, inside, outside, offLattice, unknown, asOf];
    const observed = variants.map(s => checkDecisionProofDomainMembership(packet, receipt, s));
    assert.deepEqual(observed.map(o => o.status), [
      "INSIDE_DECLARED_DOMAIN", "INSIDE_DECLARED_DOMAIN", "OUTSIDE_DECLARED_DOMAIN",
      "OUTSIDE_DECLARED_DOMAIN", "OUTSIDE_DECLARED_DOMAIN", "OUTSIDE_DECLARED_DOMAIN",
    ]);
    assert(observed.every(o => o.certifiedLabelPermitted === false));
    const noReceipt = checkDecisionProofDomainMembership(packet, { ...receipt, disposition: "UNKNOWN" }, inside);
    assert.equal(noReceipt.status, "UNKNOWN");
    const actualNativeResult = uw.executeUnderwritingModel(packet.compiledProgramme, inside);
    assert.equal(actualNativeResult.status, "SUCCEEDED");
    assert.equal(actualNativeResult.validity, "VALID");
    const attack = structuredClone(packet);
    Object.assign(attack.witness.values.due!, { currency: null });
    attack.witness = uw.sealInputSnapshot({ ...attack.witness, semanticHash: undefined });
    attack.domain.fixedInputMetadataDigest = r6FixedInputMetadataDigest(attack.witness);
    const actualFailure = uw.executeUnderwritingModel(attack.compiledProgramme, attack.witness);
    assert.equal(actualFailure.status, "FAILED");
    // Deliberately counterfeit the old success report; no production path does
    // this. The independent checker must prove policy validity, not trust it.
    attack.nativeWitness.programme.inputSemanticHash = attack.witness.semanticHash!;
    const { resultSemanticHash: _oldHash, ...counterfeitBody } = attack.nativeWitness.programme;
    attack.nativeWitness.programme = { ...counterfeitBody, resultSemanticHash: uw.semanticHash(counterfeitBody) };
    refreshProofBindings(attack);
    await retain(join(dir, "currency-presence-attack.json"), { explicitlyCounterfeitTestOnly: true, attack, actualFailure });
    const attackReceipt = await checkDecisionProof(attack, checkerOptions(dir, "currency-presence-attack"));
    assert.equal(attackReceipt.disposition, "REJECTED");
    assert.equal(attackReceipt.predicate, "WITNESS_INPUT_METADATA");
    assert.equal(uw.semanticHash(packet), sourceDigest);
    await retain(join(dir, "consumption.json"), {
      variants, observed, noReceipt, actualNativeResult, attackReceipt, immutablePacketDigest: sourceDigest,
    });
    return { observed, noReceipt, attackReceipt, actualNativeStatus: actualNativeResult.status };
  });
  await caseRun("standard-lbo-not-silently-certified", "Actual native runtime investigated; absence of exact independent reference cannot be labeled R6 proof", async dir => {
    const config: uw.StandardLboModelConfig = {
      modelVersion: "1", currency: "USD", periodDefinition: { frequency: "annual", forecastStart: "2026-01-01", count: 1 },
      entryValuationMethod: "direct_enterprise_value", revenueMethod: "explicit", ebitdaMethod: "explicit",
      dAndATreatment: "ebitda_equals_ebit", capexMethod: "explicit", workingCapitalMethod: "explicit_nwc", debtTranches: [],
    };
    const native = uw.createStandardLboModel(config), compiled = uw.compileUnderwritingModel(native);
    const pid = compiled.periods[0]!.id;
    const nativeSnapshot = uw.createStandardLboInputSnapshot(config, {
      investmentCaseId: caseId, worldAt: at,
      entry: { valuationDate: "2026-01-01", enterpriseValue: uw.decimal("100"), cashAcquired: uw.decimal("0"),
        existingDebt: uw.decimal("0"), otherDebtLike: uw.decimal("0"), transactionFees: uw.decimal("0"),
        financingFees: uw.decimal("0"), minimumCashFunding: uw.decimal("0"), rolloverEquity: uw.decimal("0") },
      operating: { revenue: { [pid]: uw.decimal("50") }, ebitda: { [pid]: uw.decimal("20") },
        capex: { [pid]: uw.decimal("0") }, openingNwc: uw.decimal("0"), nwc: { [pid]: uw.decimal("0") },
        cashTaxRates: { [pid]: uw.decimal("0") }, otherCashAdjustments: { [pid]: uw.decimal("0") } },
      debt: {}, cash: { minimum: uw.decimal("0"), sweepPercentage: uw.decimal("0") },
      ownership: { sponsor: uw.decimal("1"), other: uw.decimal("0") },
      interimDistributions: { [pid]: uw.decimal("0") },
      exit: { periodId: pid, multiple: uw.decimal("6"), adjustments: uw.decimal("0") },
    });
    const nativeResult = uw.executeUnderwritingModel(compiled, nativeSnapshot);
    await retain(join(dir, "actual-native-lbo.json"), { config, native, compiled, nativeSnapshot, nativeResult });
    assert.equal(nativeResult.status, "SUCCEEDED");
    const problem = scalarProblem(identity);
    problem.programme = native;
    const response = await runVerifiedCapitalCompiler(requestFor(problem, dir));
    await retain(join(dir, "response.json"), response);
    assert.equal(response.status, "UNSUPPORTED");
    assert(response.reason?.startsWith("SPECIALIZED_RUNTIME:"));
    return { actualNativeStatus: nativeResult.status, r6Status: response.status, missingProof: response.reason };
  });
}

async function main(): Promise<void> {
  const identity = await captureR6NativeIdentity({ repositoryRoot: repo, dependencyRoot: deps });
  await retain(join(evidence, "native-identity.json"), identity);
  const sourceStatus = execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" });
  await retain(join(evidence, "source-cut.json"), {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    status: sourceStatus,
    runnerSha256: r6Sha256(await readFile(new URL(import.meta.url))),
    failureModelSha256: r6Sha256(await readFile(join(repo, "scope-r/r6-verified-capital-compiler/failure-model.md"))),
    verificationPlanSha256: r6Sha256(await readFile(join(repo, "scope-r/r6-verified-capital-compiler/verification-plan.json"))),
    node: process.version, nodeExecutable: process.execPath,
    nodeExecutableSha256: r6Sha256(await readFile(process.execPath)),
    ordinaryUncommittedDevelopmentCut: sourceStatus.length !== 0,
  });
  if (selected === "runtime") {
    await caseRun("actual-installed-runtime", "Actually loaded pinned native compiler/executor/Decimal module and system Python", async dir => {
      const p = scalarProblem(identity);
      const compiled = uw.compileUnderwritingModel(p.programme);
      const result = uw.executeUnderwritingModel(compiled, p.witness);
      assert.equal(result.status, "SUCCEEDED");
      const python = spawnSync("/usr/bin/python3", ["-I", "-B", "-c", "import sys,platform,decimal,fractions; print(sys.executable); print(platform.python_version())"], { encoding: "utf8", timeout: 10000 });
      assert.equal(python.status, 0, python.stderr);
      const observed = { nativeResult: result, nativeIdentity: identity, actualPython: python.stdout, actualNode: process.version };
      await retain(join(dir, "runtime.json"), observed);
      return observed;
    });
  } else {
    assert.equal(selected, "core");
    await core(identity);
  }
}
let failure: unknown = null;
try { await main(); }
catch (error) { failure = error; console.error(error); }
await retain(join(evidence, "summary.json"), {
  schema: "finnor.r6.end-to-end-evidence.v1", selected,
  status: failure ? "FAIL" : "PASS_SELECTED_LEAF_CHECKS_ONLY",
  cases: results, failure: failure ? String(failure) : null,
  fullOriginalR6FunctionalGate: "INCOMPLETE",
  referenceApproval: "NOT_ESTABLISHED", checkerAdmission: "NOT_ESTABLISHED",
  sharedOwnerApiQueueWorkerPersistenceWork: "NOT_RUN_SERIAL_INTEGRATOR_SCOPE",
  protectedGain: "NOT_RUN", economicRelease: "NOT_RUN",
  monetaryMeter: "UNMETERED", noFinancialAuthorityGranted: true,
  rerun: `python3 finnor-os/scripts/r6/run-local.py --deps ${deps} --case ${selected} --evidence <new ignored attempt directory>`,
});
if (failure) process.exitCode = 1;
