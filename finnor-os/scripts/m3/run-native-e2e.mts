import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  createStandardLboInputSnapshot,
  type StandardLboInputValues,
  type StandardLboModelConfig,
} from "../../packages/underwriting/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const phase = resolve(repo, "scope-pm/phase-05-m3-capital-program");
const fixturePath = resolve(here, "native-fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")).cases;
const evidenceIndex = process.argv.indexOf("--evidence");
const evidenceName = evidenceIndex < 0 ? "native-e2e-observed.json" : process.argv[evidenceIndex + 1]!;
assert.equal(basename(evidenceName), evidenceName, "Evidence must remain in the M3 phase evidence directory");
assert.match(evidenceName, /^[a-z0-9-]+\.json(?:\.gz)?$/);

type M3 = typeof import("../../packages/private-equity/src/capital-program/index.ts");
let m3: M3 | undefined;
let importFailure: unknown;
try {
  m3 = await import("../../packages/private-equity/src/capital-program/index.ts");
} catch (error) {
  importFailure = error;
}

function required(): M3 {
  if (!m3) throw importFailure;
  return m3;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
const copy = <T,>(value: T): T => structuredClone(value);
function context(fixture: any): any {
  return {
    schema: "finnor.m3.native-construction-context.v1",
    source: "INDEPENDENT_NATIVE_CORE",
    base: required().prepareNativeBase(
      fixture.config as StandardLboModelConfig,
      createStandardLboInputSnapshot(fixture.config as StandardLboModelConfig, fixture.inputs as StandardLboInputValues),
    ),
    entities: copy(fixture.entities),
    permitted: copy(fixture.permitted),
  };
}
function request(fixture: any, ctx: any): any {
  return { ...copy(fixture.request), baseDigest: ctx.base.digest };
}
function reference(fixture: any, req: any): any {
  return JSON.parse(execFileSync("python3", [resolve(here, "reference.py")], {
    input: JSON.stringify({ fixture, request: req }), encoding: "utf8",
  }));
}
function rationalNumber(value: string): number {
  const [top, bottom = "1"] = value.split("/");
  return Number(top) / Number(bottom);
}
function close(actual: string, fraction: string): void {
  // Decimal arithmetic for comparison is independently implemented below as
  // exact integer rational cross-multiplication; no FINNOR arithmetic import.
  function decimalFraction(value: string): [bigint, bigint] {
    const [integer, decimals = ""] = value.split(".");
    const sign = integer!.startsWith("-") ? -1n : 1n;
    return [sign * BigInt(integer!.replace("-", "") + decimals), 10n ** BigInt(decimals.length)];
  }
  const [a, b] = decimalFraction(actual);
  const [top, bottom = "1"] = fraction.split("/");
  const c = BigInt(top!), d = BigInt(bottom);
  const delta = a * d - c * b;
  assert.ok((delta < 0n ? -delta : delta) * 10n ** 20n <= b * d, `${actual} differs from ${fraction} beyond 1e-20`);
}
function verifyEconomics(actual: any, expected: any): void {
  for (const key of ["entryEnterpriseValue", "financingFees", "sponsorEquity", "exitEquity",
    "discountedSponsorCashFlow", "implementationCost", "localValueBeforeSearchCost"]) close(actual[key], expected[key]);
  for (const key of ["cashByPeriod", "cashInterestByPeriod"]) {
    assert.deepEqual(Object.keys(actual[key]).sort(), Object.keys(expected[key]).sort());
    for (const [period, value] of Object.entries(expected[key])) close(actual[key][period], String(value));
  }
  assert.equal(actual.sponsorCashFlows.length, expected.sponsorCashFlows.length);
  expected.sponsorCashFlows.forEach((flow: any, index: number) => {
    const observed = actual.sponsorCashFlows[index];
    assert.equal(observed.date, flow.date);
    assert.equal(observed.periodId, flow.periodId);
    close(observed.amount, flow.amount);
  });
}
function verifyReference(result: any, oracle: any): void {
  assert.equal(result.attempts.length, oracle.rows.length);
  result.attempts.forEach((row: any, index: number) => {
    const expected = oracle.rows[index];
    assert.equal(stable(row.candidate), stable(expected.candidate));
    assert.equal(row.disposition, expected.disposition);
    if (expected.economics) verifyEconomics(row.program.economics, expected.economics);
    if (expected.failureCode) assert.equal(row.program.nativeRun.failure?.code, expected.failureCode);
  });
  assert.equal(result.costs.nativeExecutions, oracle.nativeExecutions);
  close(result.costs.declaredEvaluationLiability, oracle.evaluationLiability);
  close(result.selection.costAdjustedImprovement, oracle.costAdjustedImprovement);
  assert.equal(result.selection.selectedAttempt, oracle.selectedIndex);
  assert.equal(result.selection.bestFiniteAttempt, oracle.bestIndex);
  assert.equal(result.gap.finiteDomainComplete, true);
  assert.equal(result.gap.globalOptimalityClaimed, false);
}
function verifyEnvelope(program: any): void {
  assert.equal(program.schema, "finnor.capital-program.v1");
  assert.equal(program.state, "PROPOSED");
  assert.equal(program.resolution, "BLOCKED");
  assert.equal(program.agreement, "PROPOSED");
  assert.equal(program.response, "UNKNOWN");
  assert.equal(program.executionAuthorityGranted, false);
  assert.equal(program.reservations.length, 0);
  assert.ok(Object.values(program.ownerRefs).every(value => value === null));
  assert.ok(program.blockers.some((row: any) => row.owner === "M1"));
  assert.ok(program.blockers.some((row: any) => row.owner === "S3"));
  assert.ok(program.blockers.some((row: any) => row.owner === "S5"));
  for (const change of program.semanticChanges) {
    assert.equal(change.agreement, "PROPOSED");
    assert.equal(change.response, "UNKNOWN");
    assert.ok(change.entityId && change.term && change.effectiveDate && change.unit);
  }
  const compiled = program.compilation;
  assert.equal(compiled.moduleDigest, digest(compiled.modulePreimage));
  assert.equal(compiled.graphDigest, digest(compiled.graphPreimage));
  assert.equal(program.semanticDigest, digest(program.semanticPreimage));
  assert.equal(compiled.graphPreimage.qualification, "NATIVE_DECLARED_GRAPH_NOT_COMPLETE_RUNTIME_DEPENDENCIES");
  assert.equal(compiled.modulePreimage.model, undefined);
  assert.equal(compiled.modulePreimage.modelPreimage.schemaVersion, "underwriting-model-ir.v1");
}

const observations: any[] = [];
async function contract(name: string, inputs: unknown, expected: unknown, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    const observed = await run();
    observations.push({ name, inputPreimages: inputs, steps: ["Prepare immutable native base", "Invoke bounded native construction/search", "Compare independent registered predicates"],
      expected, observed: { status: "PASS", details: observed ?? null }, qualification: "H0_DEV_H1_FIXTURE_ONLY" });
    console.log(`PASS ${name}`);
  } catch (error) {
    const failure = error as Error & { code?: string };
    observations.push({ name, inputPreimages: inputs, steps: ["Load native construction", "Execute registered contract if construction is available"],
      expected, observed: { status: "FAIL", code: failure?.code ?? null, message: failure?.message ?? String(error) },
      qualification: "H0_DEV_NO_PASS_CLAIM" });
    console.log(`FAIL ${name}: ${failure?.message ?? String(error)}`);
  }
}

for (const fixture of fixtures) {
  await contract(`independent-rational-construction-${fixture.id}`, fixture, {
    completeFiniteEnumeration: true, rationalAgreement: "1e-20", originalGate: "UNPASSED",
  }, () => {
    const ctx = context(fixture), req = request(fixture, ctx);
    const frozen = stable(ctx);
    const result = required().searchCapitalPrograms(req, ctx);
    const oracle = reference(fixture, req);
    verifyReference(result, oracle);
    assert.equal(stable(ctx), frozen);
    const added = result.attempts.find((row: any) => row.candidate.financing?.mode === "ADD_FIXED_TERM" && row.disposition === "EVALUATED");
    assert.ok(added, "A genuinely new fixed-term topology must compile and execute");
    assert.ok(added.program?.compilation.modulePreimage.modelPreimage.runtime);
    assert.ok(added.candidate.financing);
    const newTrancheId = added.candidate.financing.trancheId;
    assert.equal(added.program.compilation.modulePreimage.modelPreimage.runtime.debtTranches.length, fixture.config.debtTranches.length + 1);
    assert.ok(Object.keys(added.program.compilation.graphPreimage.dependencyGraph).some(key => key.includes(newTrancheId)));
    result.attempts.filter((row: any) => row.program).forEach((row: any) => verifyEnvelope(row.program));
    assert.ok(result.selection);
    return { generated: result.attempts.length, executions: result.costs.nativeExecutions,
      selectedAttempt: result.selection.selectedAttempt, source: result.source, outputPreimage: result, referencePreimage: oracle };
  });
}

await contract("case02-incumbent-costs-and-ties", fixtures[0], { incumbent: 0, failedAndEvaluationCostsRetained: true }, () => {
  const fixture = copy(fixtures[0]);
  fixture.request.costs.perNativeExecution = "100";
  const ctx = context(fixture), req = request(fixture, ctx);
  const result = required().searchCapitalPrograms(req, ctx), oracle = reference(fixture, req);
  verifyReference(result, oracle);
  assert.ok(result.selection);
  assert.equal(result.selection.selectedAttempt, 0);
  assert.ok(rationalNumber(result.costs.declaredEvaluationLiability) > 0);
  assert.ok(rationalNumber(result.selection.selectedNetChangeVsUnsearchedIncumbent) < 0);
  const tie = copy(fixtures[0]);
  tie.permitted.entryEnterpriseValue = { minimum: "100.00", maximum: "100", step: "1" };
  tie.permitted.financing = [copy(tie.permitted.financing[0])];
  tie.permitted.financing[0].principal = { minimum: "40", maximum: "40", step: "1" };
  tie.permitted.financing[0].annualRate = { minimum: "0.050", maximum: "0.05", step: "0.01" };
  tie.permitted.interimDistribution.allowedDates = ["2028-12-31", "2028-12-31"];
  tie.request.costs.perNativeExecution = "0";
  const tieContext = context(tie), tieResult = required().searchCapitalPrograms(request(tie, tieContext), tieContext);
  verifyReference(tieResult, reference(tie, request(tie, tieContext)));
  assert.ok(tieResult.selection);
  assert.equal(tieResult.selection.selectedAttempt, 0);
  assert.equal(tieResult.costs.nativeExecutions, 1);
  assert.ok(tieResult.counts.duplicate > 0);
  return { costResult: result, tieResult };
});

await contract("case11-fees-units-and-timing", fixtures[0], { feeBridge: true, exactDates: true, fractionalRatesOnly: true }, () => {
  const fixture = fixtures[0], ctx = context(fixture), result = required().searchCapitalPrograms(request(fixture, ctx), ctx);
  const amend = result.attempts.find((row: any) => row.candidate.entryEnterpriseValue === "95" &&
    row.candidate.financing?.mode === "AMEND_FIXED_TERM" && row.candidate.financing.principal === "50" &&
    row.candidate.financing.fixedAnnualRate === "0.04" && row.candidate.distributionDate === "2027-12-31");
  assert.ok(amend?.program?.economics);
  assert.ok(amend.program.economics.sponsorCashFlows[1]);
  assert.equal(amend.program.economics.financingFees, "1.2");
  assert.equal(amend.program.economics.sponsorEquity, "48.2");
  assert.equal(amend.program.economics.sponsorCashFlows[1].date, "2027-12-31");
  assert.equal(amend.program.economics.sponsorCashFlows[1].amount, "10");
  assert.ok(amend.program.semanticChanges.some((row: any) => row.term === "FIXED_ANNUAL_RATE" && row.unit === "FRACTION_PER_YEAR"));
  assert.ok(amend.program.semanticChanges.some((row: any) => row.term === "INTERIM_DISTRIBUTION_DATE" && row.before === "2028-12-31" && row.after === "2027-12-31"));
  const percent = copy(ctx);
  percent.permitted.financing[0].annualRate = { minimum: "5", maximum: "5", step: "1" };
  const refused = required().searchCapitalPrograms(request(fixture, percent), percent);
  assert.equal(refused.status, "BLOCKED_INPUT");
  assert.equal(refused.attempts.length, 0);
  const badUnit = request(fixture, ctx);
  badUnit.objective.discountUnit = "PERCENT";
  assert.throws(() => required().searchCapitalPrograms(badUnit, ctx), /INVALID_REQUEST/);
  return { nativeFeeCandidate: amend, percentRefusal: refused };
});

await contract("failed-native-attempts-retain-liability", fixtures[0], { invalidSourcesUsesRecorded: true, failedCostsCharged: true }, () => {
  const fixture = copy(fixtures[0]);
  fixture.permitted.financing = [copy(fixture.permitted.financing[0])];
  fixture.permitted.financing[0].principal = { minimum: "200", maximum: "200", step: "1" };
  fixture.permitted.financing[0].annualRate = { minimum: "0.05", maximum: "0.05", step: "0.01" };
  const ctx = context(fixture), req = request(fixture, ctx), result = required().searchCapitalPrograms(req, ctx);
  verifyReference(result, reference(fixture, req));
  assert.ok(result.counts.failed > 0);
  result.attempts.filter((row: any) => row.disposition === "FAILED").forEach((row: any) => {
    assert.equal(row.declaredEvaluationCost, "0.01");
    assert.equal(row.program.economics, null);
    verifyEnvelope(row.program);
  });
  return result;
});

await contract("bounded-search-retains-incumbent-and-gap", fixtures[0], { nativeExecutions: 1, finiteDomainComplete: false }, () => {
  const fixture = copy(fixtures[0]), ctx = context(fixture), req = request(fixture, ctx);
  req.budget.maxNativeExecutions = 1;
  const result = required().searchCapitalPrograms(req, ctx);
  assert.equal(result.costs.nativeExecutions, 1);
  assert.ok(result.selection);
  assert.equal(result.selection.selectedAttempt, 0);
  assert.equal(result.gap.finiteDomainComplete, false);
  assert.ok(result.gap.remainingGeneratedDescriptors !== null && result.gap.remainingGeneratedDescriptors > 0);
  assert.equal(result.gap.externalOptimalityBound, null);
  assert.equal(result.gap.globalOptimalityClaimed, false);
  assert.ok(result.attempts.some((row: any) => row.disposition === "REJECTED" && row.reason === "NATIVE_EXECUTION_BUDGET"));
  result.attempts.filter((row: any) => row.disposition === "REJECTED").forEach((row: any) => assert.equal(row.program, null));
  return result;
});

await contract("strict-request-and-no-client-authority", fixtures[0], { tenantAuthorityRejected: true, candidatesRejected: true }, () => {
  const fixture = fixtures[0], ctx = context(fixture), req = request(fixture, ctx);
  for (const extra of [{ tenantId: "attacker" }, { candidates: [] }, { ownerRefs: { s4: "fake" } }]) {
    assert.throws(() => required().searchCapitalPrograms({ ...req, ...extra }, ctx), /INVALID_REQUEST/);
  }
  const blocked = required().searchCapitalPrograms(req, { ...ctx, base: null });
  assert.equal(blocked.status, "BLOCKED_INPUT");
  assert.equal(blocked.attempts.length, 0);
  assert.equal(blocked.selection, null);
  assert.ok(blocked.blockers.some((row: any) => row.code === "MISSING_NATIVE_BASE"));
  return blocked;
});

await contract("tamper-unknown-and-unsupported-native-base", fixtures[0], { noFakePreimages: true, unknownNeverFilled: true }, () => {
  const fixture = fixtures[0], ctx = context(fixture), req = request(fixture, ctx);
  const tampered = copy(ctx);
  tampered.base.snapshot.values["entry.enterprise_value"].value = "1";
  const blocked = required().searchCapitalPrograms(req, tampered);
  assert.equal(blocked.status, "BLOCKED_INPUT");
  assert.equal(blocked.attempts.length, 0);
  const wrongPin = required().searchCapitalPrograms({ ...req, baseDigest: `sha256:${"0".repeat(64)}` }, ctx);
  assert.equal(wrongPin.status, "BLOCKED_INPUT");
  const { semanticHash: _hash, ...snapshot } = copy(createStandardLboInputSnapshot(fixture.config, fixture.inputs));
  const unresolved = snapshot.values["operating.ebitda_explicit"];
  assert.ok(unresolved);
  unresolved.status = "UNKNOWN";
  unresolved.value = null;
  assert.throws(() => required().prepareNativeBase(fixture.config, snapshot), /UNKNOWN_INPUT/);
  const unsupported = copy(fixture.config);
  unsupported.debtTranches[0].rateType = "floating";
  assert.throws(() => required().prepareNativeBase(unsupported, createStandardLboInputSnapshot(fixture.config, fixture.inputs)), /UNSUPPORTED_NATIVE_DOMAIN/);
  return { tamper: blocked, wrongPin };
});

await contract("deterministic-replay-permission-order-and-grid-limit", fixtures[0], { replayIdentical: true, overflowRefused: true }, () => {
  const fixture = fixtures[0], ctx = context(fixture), req = request(fixture, ctx);
  const first = required().searchCapitalPrograms(req, ctx);
  const reordered = copy(ctx);
  reordered.permitted.financing.reverse();
  reordered.permitted.interimDistribution.allowedDates.reverse();
  const second = required().searchCapitalPrograms(req, reordered);
  assert.equal(stable(first), stable(second));
  const overflow = copy(ctx);
  overflow.permitted.entryEnterpriseValue = { minimum: "1", maximum: "1000000000000", step: "0.01" };
  const refused = required().searchCapitalPrograms(req, overflow);
  assert.equal(refused.status, "BLOCKED_INPUT");
  assert.equal(refused.attempts.length, 0);
  const wrongDate = copy(ctx);
  wrongDate.permitted.interimDistribution.allowedDates = ["2027-06-30"];
  assert.equal(required().searchCapitalPrograms(req, wrongDate).status, "BLOCKED_INPUT");
  const staleFee = copy(ctx);
  staleFee.permitted.financing[0].replacedBaseFee = "20";
  assert.equal(required().searchCapitalPrograms(req, staleFee).status, "BLOCKED_INPUT");
  return { reportDigest: digest(first), gridRefusal: refused };
});

const sourcePaths = [
  "scope-pm/phase-05-m3-capital-program/phase-plan.md",
  "scope-pm/phase-05-m3-capital-program/failure-model.md",
  "scope-pm/phase-05-m3-capital-program/requirement-map.md",
  "scope-pm/phase-05-m3-capital-program/preregistration.md",
  "finnor-os/scripts/m3/native-fixtures.json", "finnor-os/scripts/m3/reference.py", "finnor-os/scripts/m3/run-native-e2e.mts",
  ...["contracts", "grammar", "native-finance", "search", "index"].map(name => `finnor-os/packages/private-equity/src/capital-program/${name}.ts`),
  ...["compiler", "executor", "snapshot", "standard-lbo", "decimal", "canonical", "periods", "returns", "result", "types", "errors"]
    .map(name => `finnor-os/packages/underwriting/src/${name}.ts`),
];
const sources = sourcePaths.map(path => {
  const absolutePath = resolve(repo, path);
  return { path: absolutePath, sha256: existsSync(absolutePath) ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex") : null };
});
const rerun = `cd ${resolve(repo, "finnor-os")} && node_modules/.bin/tsx scripts/m3/run-native-e2e.mts --evidence ${evidenceName}`;
const body = {
  schema: "finnor.m3.native-e2e-evidence.v1", qualification: "H0_DEV_H1_FIXTURE_ONLY",
  sourceCommit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceHashes: sources, inputPreimages: { fixturePath, fixtureDigest: digest(JSON.parse(readFileSync(fixturePath, "utf8"))) },
  steps: ["Preregister docs and independent fixture/reference", "Run the same end-to-end contracts without skipping unavailable construction", "Record observed predicates and complete native output preimages"],
  expected: { everyRegisteredContractPasses: true, originalM3Gate: "UNPASSED" },
  observed: { passed: observations.filter(row => row.observed.status === "PASS").length,
    failed: observations.filter(row => row.observed.status === "FAIL").length, contracts: observations },
  rerun, independentR0: "UNSET", independentEpsilon: "UNSET", independentSeal: "UNSET",
};
mkdirSync(resolve(phase, "scope-evidence"), { recursive: true });
const output = resolve(phase, "scope-evidence", evidenceName);
const bytes = Buffer.from(JSON.stringify({ ...body, evidenceDigest: digest(body) }, null, 2) + "\n");
writeFileSync(output, evidenceName.endsWith(".gz") ? gzipSync(bytes, { level: 9 }) : bytes);
console.log(`Evidence ${output}`);
if (body.observed.failed) process.exitCode = 1;
