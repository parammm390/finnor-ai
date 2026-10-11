import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as uw from "../../packages/underwriting/src/index";
import {
  assertR6NativeNumericPolicy, captureR6NativeIdentity, r6FixedInputMetadataDigest, r6Sha256,
} from "../../packages/epistemic-runtime/src/verified-capital-compiler/index";
import type { R6InputDomain, R6ReferenceState } from "../../packages/shared-types/src/decision-proof";
import type { ExperimentRef } from "../../packages/shared-types/src/experiments";

const args = process.argv.slice(2);
const evidence = resolve(args[args.indexOf("--evidence") + 1]!);
const repo = resolve(process.env.R6_REPOSITORY_ROOT!);
const deps = resolve(process.env.R6_DEPS_ROOT!);
assert(evidence.startsWith(join(repo, "scope-r/r6-verified-capital-compiler/evidence-private/")));
const started = performance.now();
const results: Array<Record<string, unknown>> = [];
const caseId = "60000000-0000-4000-8000-000000000001";
const at = "2026-01-01T00:00:00.000Z";
const syntheticRef = (id: string, value: unknown): ExperimentRef => ({
  owner: "@finnor/epistemic-runtime", id: `SYNTHETIC_R6_LBO_${id}`,
  version: "1", contentDigest: uw.semanticHash(value),
});
let retainedBytes = 0;
async function retain(path: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  retainedBytes += Buffer.byteLength(bytes);
  assert(retainedBytes <= 32 * 1024 * 1024, "Registered new-evidence byte bound");
  await writeFile(path, bytes, { flag: "wx" });
}

/** Preserve the original one-period native case's amounts and conventions.
 * Later-period copies are explicit diagnostic inputs, not an approved original
 * reference domain. Never mutate an original packet or remove any native node. */
function fixture(frequency: uw.PeriodFrequency, count: number, exitOrdinal = count,
  averageDebt = false): {
    config: uw.StandardLboModelConfig; model: uw.UnderwritingModelIR;
    compiled: uw.CompiledUnderwritingModel; snapshot: Readonly<uw.UnderwritingInputSnapshot>;
    domain: R6InputDomain; inventory: R6ReferenceState[];
  } {
  const config: uw.StandardLboModelConfig = {
    modelVersion: "1", currency: "USD",
    periodDefinition: { frequency, forecastStart: "2026-01-01", count },
    entryValuationMethod: "direct_enterprise_value", revenueMethod: "explicit", ebitdaMethod: "explicit",
    dAndATreatment: "ebitda_equals_ebit", capexMethod: "explicit", workingCapitalMethod: "explicit_nwc",
    debtTranches: averageDebt ? [{
      id: "term", name: "Synthetic average-balance term",
      kind: "term", seniority: 0, sweepPriority: 0, rateType: "fixed",
      interestBasis: "average_balance", amortization: "original_principal_percent",
      cashSweepEligible: true, maturityTreatment: "mandatory_repayment",
    }] : [],
  };
  const model = uw.createStandardLboModel(config);
  const compiled = uw.compileUnderwritingModel(model);
  const series = (value: string): Record<string, uw.DecimalString> =>
    Object.fromEntries(compiled.periods.map(p => [p.id, uw.decimal(value)]));
  const snapshot = uw.createStandardLboInputSnapshot(config, {
    investmentCaseId: caseId, worldAt: at,
    entry: { valuationDate: "2026-01-01", enterpriseValue: uw.decimal("100"),
      cashAcquired: uw.ZERO, existingDebt: uw.ZERO, otherDebtLike: uw.ZERO,
      transactionFees: uw.ZERO, financingFees: uw.ZERO, minimumCashFunding: uw.ZERO, rolloverEquity: uw.ZERO },
    operating: { revenue: series("50"), ebitda: series("20"), capex: series("0"),
      openingNwc: uw.ZERO, nwc: series("0"), cashTaxRates: series("0"), otherCashAdjustments: series("0") },
    debt: averageDebt ? {
      term: { openingPrincipal: uw.decimal("50"), fixedRate: uw.decimal("0.1"),
        cashInterestShare: uw.ONE, pikInterestShare: uw.ZERO,
        mandatoryAmortizationRate: uw.ZERO, maturityDate: "2050-12-31" },
    } : {},
    cash: { minimum: uw.ZERO, sweepPercentage: averageDebt ? uw.ONE : uw.ZERO },
    ownership: { sponsor: uw.ONE, other: uw.ZERO },
    interimDistributions: series("0"),
    exit: { periodId: compiled.periods[exitOrdinal - 1]!.id, multiple: uw.decimal("6"), adjustments: uw.ZERO },
  });
  const inputs: R6InputDomain["inputs"] = model.nodes
    .filter((n): n is uw.InputNode => n.kind === "input").map(node => {
      const raw = snapshot.values[node.id]!.value!;
      const components: R6InputDomain["inputs"][number]["components"] = {};
      const values = node.shape === "scalar" ? { $scalar: raw }
        : raw as Readonly<Record<string, uw.ModelValue>>;
      for (const [component, value] of Object.entries(values)) {
        if (node.valueType === "decimal") {
          // Wide lattices contain the retained exact original native values.
          const range = node.id === "entry.enterprise_value" ? ["100", "101"]
            : node.id === "operating.revenue_explicit" ? ["50", "51"]
            : node.id === "operating.ebitda_explicit" ? ["20", "21"]
            : [String(value), String(value)];
          components[component] = {
            kind: "DECIMAL_LATTICE", minimum: range[0]!, maximum: range[1]!, decimalPlaces: 2,
          };
        } else components[component] = {
          kind: "ENUMERATION",
          values: node.id === "exit.period_id" ? compiled.periods.map(p => p.id) : [String(value)],
        };
      }
      return {
        ownerRef: syntheticRef(`INPUT_${node.id}`, { nodeId: node.id }),
        programmeNodeId: node.id, referenceNodeId: node.id, valueType: node.valueType,
        unit: node.unit, currency: node.currency ?? null, shape: node.shape, components,
      };
    });
  const domain: R6InputDomain = {
    schema: "finnor.r6.input-domain.v1", ref: syntheticRef("DIAGNOSTIC_DOMAIN", inputs),
    fixedInputMetadataDigest: r6FixedInputMetadataDigest(snapshot), inputs,
  };
  const inventory = model.nodes.map(node => {
    const liability = node.unit === "money" && (node.id.startsWith("debt.") || node.id.startsWith("debt_input.")
      || /existing_debt|other_debt_like|financing_fees|transaction_fees/.test(node.id));
    const role: R6ReferenceState["role"] = node.valueType === "boolean" ? "CONSTRAINT"
      : node.valueType === "date" || node.valueType === "text" ? "TIMING"
      : liability ? "LIABILITY" : node.unit === "money" ? "CASH" : "OBJECTIVE";
    return {
      ledgerRef: syntheticRef(`NODE_${node.id}`, { nodeId: node.id, role }),
      role, nodeId: node.id,
      timing: node.shape === "series" ? { kind: "PERIOD_END" as const }
        : { kind: "AS_OF" as const, date: "2026-01-01" },
      obligationRef: liability ? syntheticRef(`OBLIGATION_${node.id}`, { synthetic: true, nodeId: node.id }) : null,
      obligationStatus: liability ? "REPRESENTED" as const : "NOT_APPLICABLE" as const,
      sourceClauseRefs: [syntheticRef(`CLAUSE_${node.id}`, { noReferenceApproval: true, nodeId: node.id })],
    };
  });
  return { config, model, compiled, snapshot, domain, inventory };
}

function decimalObservation(value: InstanceType<typeof uw.FinnorDecimal>): Record<string, unknown> {
  return { text: value.toFixed(), finite: value.isFinite(), zero: value.isZero() };
}
function irrAttempt(flows: readonly uw.SponsorCashFlow[]): Record<string, unknown> {
  try { return { status: "SUCCEEDED", rate: uw.solvePeriodicIrr(flows) }; }
  catch (error) {
    return { status: "FAILED", code: error instanceof uw.UnderwritingError ? error.code : "UNKNOWN",
      error: String(error) };
  }
}
/** Observe the *actual* returns.ts lower/upper ordered calculation, including
 * zero numerators over underflowed denominators; do not substitute a real NPV. */
function orderedNpv(rate: string, flows: readonly uw.SponsorCashFlow[]): Record<string, unknown> {
  const base = uw.d(rate).plus(1);
  let total = new uw.FinnorDecimal(0);
  const terms = flows.map((flow, index) => {
    const denominator = base.pow(String(index));
    const quotient = uw.d(flow.amount).dividedBy(denominator);
    total = total.plus(quotient);
    return { index, amount: flow.amount, denominator: decimalObservation(denominator),
      quotient: decimalObservation(quotient), partial: decimalObservation(total) };
  });
  return { base: decimalObservation(base), terms, total: decimalObservation(total) };
}

async function runNative(id: string, frequency: uw.PeriodFrequency, count: number,
  exitOrdinal = count, averageDebt = false): Promise<void> {
  const dir = join(evidence, id);
  await mkdir(dir);
  const input = fixture(frequency, count, exitOrdinal, averageDebt);
  const result = uw.executeUnderwritingModel(input.compiled, input.snapshot);
  await retain(join(dir, "native.json"), { ...input, result });
  const flows: uw.SponsorCashFlow[] = [{
    amount: uw.sub("0", String(result.values["sources_uses.sponsor_equity"]!.value)),
    date: "2026-01-01", type: "initial_investment",
  }];
  for (const period of input.compiled.periods.slice(0, exitOrdinal)) {
    flows.push({
      amount: period.id === input.compiled.periods[exitOrdinal - 1]!.id
        ? String(result.values["returns.sponsor_exit_proceeds"]!.value) as uw.DecimalString : uw.ZERO,
      date: period.endDate, periodId: period.id,
      type: period.id === input.compiled.periods[exitOrdinal - 1]!.id ? "exit_distribution" : "interim_distribution",
    });
  }
  const lower = orderedNpv(uw.RETURN_SOLVER_POLICY.minimumRate, flows);
  const upper = orderedNpv(uw.RETURN_SOLVER_POLICY.maximumRate, flows);
  const returns = irrAttempt(flows);
  // A legal positive-scale diagnostic cannot repair a zero power denominator.
  const scaled = flows.map(flow => ({ ...flow, amount: uw.mul(flow.amount, "0.0001") }));
  const scaledAttempt = irrAttempt(scaled);
  await retain(join(dir, "return-boundary.json"), {
    flows, lower, upper, returns, positiveScaleDiagnostic: { factor: "0.0001", flows: scaled, result: scaledAttempt },
    nativePolicy: uw.RETURN_SOLVER_POLICY,
    noNativeRepairApplied: true,
  });
  if (exitOrdinal >= 9) {
    assert.equal(result.status, "FAILED", "Actual late-exit native totality hypothesis");
    assert.equal(result.failure?.code, "IRR_UNDEFINED");
    assert.equal(returns.status, "FAILED");
    assert.equal(returns.code, "IRR_UNDEFINED");
    assert.equal(scaledAttempt.status, "FAILED");
    assert.equal(scaledAttempt.code, "IRR_UNDEFINED");
  } else {
    assert.equal(result.status, "SUCCEEDED", JSON.stringify(result.failure));
    assert.equal(result.validity, "VALID", JSON.stringify(result.checks));
    assert.equal(returns.status, "SUCCEEDED");
    assert(result.checks.length === 10 && result.checks.every(check => check.passed));
  }
  const observed = { id, frequency, horizon: count, exitOrdinal,
    nativeStatus: result.status, nativeValidity: result.validity, failureCode: result.failure?.code ?? null,
    periodicIrrStatus: returns.status, averageDebt,
    nodes: input.model.nodes.length, inventory: input.inventory.length,
    completeNativeInventoryRetained: true };
  results.push(observed);
  console.log(`${id}: native ${result.status}/${result.validity}${result.failure ? `/${result.failure.code}` : ""}`);
}

async function main(): Promise<void> {
  const disk = await statfs(repo);
  assert(Number(disk.bavail) * Number(disk.bsize) >= 256 * 1024 * 1024, "Registered free-disk reserve");
  assertR6NativeNumericPolicy();
  const identity = await captureR6NativeIdentity({ repositoryRoot: repo, dependencyRoot: deps });
  await retain(join(evidence, "source-cut.json"), {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    status: execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }),
    identity, runnerSha256: r6Sha256(await readFile(new URL(import.meta.url))),
    campaignSha256: r6Sha256(await readFile(join(repo, "scope-r/r6-verified-capital-compiler/standard-lbo-campaign.json"))),
    numericPolicy: { precision: uw.FinnorDecimal.precision, rounding: uw.FinnorDecimal.rounding,
      minE: uw.FinnorDecimal.minE, maxE: uw.FinnorDecimal.maxE },
    originalCoreSummarySha256: r6Sha256(await readFile(join(repo,
      "scope-r/r6-verified-capital-compiler/evidence-private/core-005/summary.json"))),
  });
  await runNative("retained-original-one-period", "annual", 1);
  for (const frequency of ["annual", "quarterly", "monthly"] as const) {
    for (const count of [8, 9, 12]) await runNative(`${frequency}-${count}-late-exit`, frequency, count);
  }
  await runNative("annual-12-earlier-exit-control", "annual", 12, 1);
  await runNative("average-balance-8-late-exit", "annual", 8, 8, true);
  await runNative("average-balance-12-late-exit", "annual", 12, 12, true);
  assertR6NativeNumericPolicy();
  assert(results.length === 13 && results.filter(r => r.nativeStatus === "FAILED").length === 7);
  const directoryStat = await stat(evidence);
  assert(directoryStat.isDirectory());
}
let failure: unknown = null;
try { await main(); }
catch (error) { failure = error; console.error(error); }
await retain(join(evidence, "summary.json"), {
  schema: "finnor.r6.standard-lbo-native-feasibility.v1",
  engineeringChecks: failure ? "FAIL" : "PASS_REGISTERED_OBSERVATIONS",
  standardLboProfile: "NOT_IMPLEMENTED_SUCCESSFUL_UNIVERSAL_VALIDITY_CONTRADICTED_IF_LATE_EXIT_IS_IN_D",
  cases: results, failure: failure ? String(failure) : null,
  elapsedMs: Math.round(performance.now() - started), retainedBytes,
  originalDomainNarrowed: false, actualFinancialFailuresAreNotPassingFinancialProofs: true,
  approval: "NOT_ESTABLISHED", admission: "NOT_ESTABLISHED", noNativeRepairApplied: true,
});
if (failure) process.exitCode = 1;
