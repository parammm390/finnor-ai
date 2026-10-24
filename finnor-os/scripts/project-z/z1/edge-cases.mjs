import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { produce, applyChanges, currentness } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/engine.ts";
import { digest } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts";
import { checkOriginal, runProducer, runtimeIdentity, Z1ProcessFailure } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";
import { freshRequest, money, scalar } from "./fixtures.mjs";

const evidence = process.argv[2];
if (!evidence || !isAbsolute(evidence)) throw Error("ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(evidence, { recursive: false, mode: 0o700 });
const runtime = await runtimeIdentity(), records = [];
const simple = (counter, rows, operators) => {
  const request = freshRequest(31, counter + 100, runtime.digest);
  request.sources.find(s => s.id === "ledger").rows = rows;
  for (const [index, work] of request.works.entries()) work.programme = {
    nodes: [{ id: "s", op: "source", sourceId: "ledger" }, ...operators(index)], output: "out",
  };
  return request;
};
const row = (amount, company = "A") => ({ company, amount, period: "1" });
const sumNode = (keys = []) => ({ id: "out", op: "sum", input: "s", keys, values: { amount: { op: "field", name: "amount" } }, empty: "zero" });
async function trial(name, input, action) {
  const record = { name, input, actions: [], nativeFlow: "NOT_RUN" };
  try { await action(record); record.status = "PASSED"; }
  catch (e) { record.status = "FAILED"; record.error = { message: e.message, stack: e.stack }; }
  records.push({ name, status: record.status, error: record.error ?? null });
  await writeFile(resolve(evidence, name + ".json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
for (const mode of ["HALF_EVEN", "HALF_AWAY", "FLOOR", "CEILING", "TRUNCATE"]) {
  const expected = { HALF_EVEN: ["-2", "2"], HALF_AWAY: ["-3", "3"], FLOOR: ["-3", "2"], CEILING: ["-2", "3"], TRUNCATE: ["-2", "2"] }[mode];
  const request = simple(1, [row("-5/2")], i => [{
    id: "out", op: "project", input: "s", semantics: "bag", fields: { rounded: {
      op: "round", value: i ? { op: "sub", left: { op: "literal", type: money, value: "0" }, right: { op: "field", name: "amount" } } :
        { op: "field", name: "amount" }, places: 0, mode,
    } },
  }]);
  await trial("signed-rounding-" + mode.toLowerCase(), request, async r => {
    const out = await runProducer(request, undefined, 15000);
    assert.ok(out.production.program, out.production.reason);
    assert.deepEqual(out.production.program.workProjections.map(p => p.result.rows[0].rounded), expected);
    const checked = await checkOriginal(request, out.production.program, 15000);
    assert.equal(checked.disposition, "CHECKED_CANDIDATE");
    r.actions.push({ production: out, checked, independentHandExpected: expected });
  });
}
const empty = simple(2, [], i => [sumNode(i ? [] : ["company"])]);
await trial("empty-keyed-and-global-sums", empty, async r => {
  const out = produce(empty);
  assert.deepEqual(out.program.workProjections[0].result.rows, []);
  assert.deepEqual(out.program.workProjections[1].result.rows, [{ amount: "0" }]);
  assert.equal((await checkOriginal(empty, out.program, 15000)).disposition, "CHECKED_CANDIDATE");
  r.actions.push(out);
});
const division = simple(3, [{ company: "A", amount: "10", period: "2" }], () => [{
  id: "out", op: "project", input: "s", semantics: "bag", fields: { ratio: { op: "div",
    left: { op: "field", name: "amount" },
    right: { op: "sub", left: { op: "field", name: "period" }, right: { op: "literal", type: scalar, value: "1" } },
  } },
}]);
await trial("original-data-dependent-denominator", division, async r => {
  const out = produce(division);
  assert.equal(out.program.workProjections[0].result.rows[0].ratio, "10");
  const checked = await checkOriginal(division, out.program, 15000);
  assert.equal(checked.disposition, "CHECKED_CANDIDATE");
  r.actions.push({ out, checked });
});
const boundary = simple(4, [row(String((1n << 512n) - 1n))], () => [sumNode()]);
await trial("512-bit-boundary-and-overflow", boundary, async r => {
  const out = produce(boundary);
  assert.ok(out.program, out.reason);
  assert.equal((await checkOriginal(boundary, out.program, 15000)).disposition, "CHECKED_CANDIDATE");
  const exceeded = structuredClone(boundary);
  exceeded.sources[0].rows.push(row("1"));
  const failed = produce(exceeded);
  assert.equal(failed.disposition, "INCOMPLETE"); assert.equal(failed.program, null);
  r.actions.push({ out, failed });
});
const independent = freshRequest(25, 150, runtime.digest);
await trial("unaffected-result-current-on-selective-revocation", independent, async r => {
  const out = produce(independent);
  const updated = applyChanges(out.checkpoint, { sourceChanges: [{
    sourceId: "ledger", fromRevision: independent.sources[0].revision, toRevision: "revoked-ledger",
    insert: [], retract: [], revoked: true,
  }] });
  assert.equal(updated.program.workProjections[0].disposition, "REVOKED");
  assert.deepEqual(updated.program.workProjections[1].result, out.program.workProjections[1].result);
  assert.equal(currentness(out.program, updated.checkpoint.request, independent.works[1].id), "CURRENT");
  assert.equal((await checkOriginal(updated.checkpoint.request, updated.program, 15000)).disposition, "CHECKED_CANDIDATE");
  r.actions.push({ out, updated });
});
for (const [name, mutate, expected] of [
  ["unsupported-float", q => { q.sources[0].rows[0].amount = 1.5; }, "UNSUPPORTED"],
  ["cross-currency", q => { q.sources[0].columns.amount.currency = "EUR"; }, "UNSUPPORTED"],
  ["duplicate-original-work", q => { q.works[1].id = q.works[0].id; }, "UNSUPPORTED"],
  ["missing-original-field", q => { delete q.sources[0].rows[0].amount; }, "UNSUPPORTED"],
  ["hidden-unreachable-node", q => { q.works[0].programme.nodes.push({ id: "hidden", op: "source", sourceId: "ledger2" }); }, "UNSUPPORTED"],
  ["original-cycle", q => { q.works[0].programme.nodes[0] = { id: "s", op: "filter", input: "out", predicate: { op: "eq", left: { op: "literal", type: scalar, value: "1" }, right: { op: "literal", type: scalar, value: "1" } } }; }, "UNSUPPORTED"],
  ["unpaired-unicode", q => { q.sources[0].rows[0].company = "\ud800"; }, "UNSUPPORTED"],
]) {
  const input = simple(5, [row("3")], () => [sumNode()]);
  // Currency mutation is made against an explicit USD addition, not a sum
  // whose lawful original result would simply have the changed currency.
  if (name === "cross-currency") for (const w of input.works) w.programme.nodes[1].values.amount = {
    op: "add", left: { op: "field", name: "amount" }, right: { op: "literal", type: money, value: "1" },
  };
  mutate(input);
  await trial(name, input, async r => {
    const out = produce(input); assert.equal(out.disposition, expected); assert.equal(out.program, null); r.actions.push(out);
  });
}
const failedBudget = simple(6, [row("2")], () => [sumNode()]);
for (const w of failedBudget.works) w.resources.remainingTicks = "18";
await trial("cumulative-failed-retry-no-fresh-parent", failedBudget, async r => {
  let state = produce(failedBudget);
  assert.ok(state.program, state.reason);
  for (let index = 0; index < 5; index++) {
    const next = structuredClone(state.checkpoint.request);
    next.sources[0].revision = "budget-revision-" + index;
    next.sources[0].rows[0].amount = String(index + 3);
    state = produce(next, { previous: state.checkpoint });
    r.actions.push(state);
    if (!state.program) break;
  }
  assert.equal(state.disposition, "INCOMPLETE");
  assert.deepEqual(state.checkpoint.request.works[1].unresolvedObligationRefs, failedBudget.works[1].unresolvedObligationRefs);
  const fallback = produce(state.checkpoint.request, { previous: state.checkpoint, mode: "DIRECT" });
  assert.equal(fallback.disposition, "INCOMPLETE");
  assert.equal(fallback.program, null);
  r.actions.push(fallback);
});
const abortRequest = simple(7, [row("1")], () => [sumNode()]);
await trial("owned-producer-abort-before-private-input", abortRequest, async r => {
  const controller = new AbortController(); controller.abort();
  let failed = null;
  try { await runProducer(abortRequest, undefined, 15000, controller.signal); }
  catch (e) { failed = e; }
  assert.ok(failed instanceof Z1ProcessFailure);
  assert.equal(failed.receipt.signal, "SIGKILL");
  assert.equal(failed.receipt.inheritedCredentialEnvironment, false);
  r.actions.push({ disposition: failed.disposition, receipt: failed.receipt });
});
for (const [name, ids] of [
  ["unicode-original-work-identities", ["work_\ue000", "work_\u{1f600}"]],
  ["prototype-like-original-work-identities", ["__proto__", "constructor"]],
]) {
  const input = simple(8, [row("3")], i => [sumNode(i ? [] : ["company"])]);
  input.works.forEach((work, i) => { work.id = ids[i]; });
  await trial(name, input, async r => {
    const out = await runProducer(input, undefined, 15000);
    r.actions.push({ out });
    assert.ok(out.production.program, out.production.reason);
    const checked = await checkOriginal(input, out.production.program, 15000);
    r.actions.push({ checked });
    assert.equal(checked.disposition, "CHECKED_CANDIDATE");
  });
}
const lazyPredicates = simple(9, [row("3")], i => [
  { id: "gate", op: "filter", input: "s", predicate: { op: i ? "or" : "and", args: [
    { op: "eq", left: { op: "literal", type: scalar, value: "1" },
      right: { op: "literal", type: scalar, value: i ? "1" : "0" } },
    { op: "gt", left: { op: "div", left: { op: "field", name: "amount" }, right: {
      op: "sub", left: { op: "field", name: "period" }, right: { op: "literal", type: scalar, value: "1" },
    } }, right: { op: "literal", type: money, value: "0" } },
  ] } },
  { ...sumNode(), input: "gate" },
]);
await trial("original-left-to-right-short-circuit", lazyPredicates, async r => {
  const out = await runProducer(lazyPredicates, undefined, 15000);
  r.actions.push({ out, independentHandExpected: ["0", "3"] });
  assert.ok(out.production.program, out.production.reason);
  assert.deepEqual(out.production.program.workProjections.map(p => p.result.rows[0].amount), ["0", "3"]);
  const checked = await checkOriginal(lazyPredicates, out.production.program, 15000);
  r.actions.push({ checked });
  assert.equal(checked.disposition, "CHECKED_CANDIDATE");
});
const wideGroup = simple(10, [row("3")], () => [{ ...sumNode(),
  values: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ["v" + i, { op: "literal", type: money, value: "1" }])),
}]);
await trial("derived-group-column-profile-bound", wideGroup, async r => {
  const out = produce(wideGroup);
  r.actions.push(out);
  assert.equal(out.disposition, "UNSUPPORTED"); assert.equal(out.program, null);
});
const foreignUnused = simple(12, [row("3")], i => [sumNode(i ? [] : ["company"])]);
foreignUnused.sources.find(source => source.id === "ledger2").partition.tenantId = "other-public-fixture-tenant";
await trial("unused-foreign-source-raw-data-rejected", foreignUnused, async r => {
  const out = await runProducer(foreignUnused, undefined, 15000);
  r.actions.push(out);
  assert.equal(out.production.disposition, "REVOKED"); assert.equal(out.production.program, null);
});
for (const [name, mutate] of [
  ["rehashed-false-envelope-tenant", p => { p.envelope.originalTenant = "other-public-fixture-tenant"; }],
  ["rehashed-false-envelope-build", p => { p.envelope.producerBuildIdentity = "fabricated-build"; }],
  ["rehashed-false-envelope-checker", p => { p.envelope.checkerIdentityAndResultReferences.identity = "fabricated-checker"; }],
  ["rehashed-source-evidence-upgrade", p => { p.envelope.claimAndEvidenceClasses = ["deterministic"]; }],
  ["rehashed-null-authority-flag", p => { p.executionAuthorityGranted = null; }],
  ["rehashed-fabricated-zero-usd", p => { p.costs.usd = 0; }],
  ["rehashed-removed-meter-gaps", p => { p.costs.gaps = []; }],
  ["rehashed-zeroed-all-operation-charges", p => {
    p.costs.charges = []; p.costs.totalTicks = "0";
    p.costs.byWork = Object.fromEntries(p.workProjections.map(x => [x.workId, "0"]));
    for (const projection of p.workProjections) projection.accounting = {
      chargedTicks: "0", cumulativeTicks: "0", remainingTicks: projection.binding.original.resources.remainingTicks,
    };
  }],
]) {
  const input = simple(11, [row("3")], i => [sumNode(i ? [] : ["company"])]);
  await trial(name, input, async r => {
    const out = await runProducer(input, undefined, 15000);
    assert.ok(out.production.program, out.production.reason);
    const candidate = structuredClone(out.production.program);
    mutate(candidate);
    candidate.envelope.costAndResourceReceiptReferences = [digest(candidate.costs)];
    candidate.envelope.immutableArtifactDigest = "";
    candidate.envelope.immutableArtifactDigest = digest(candidate);
    const checked = await checkOriginal(input, candidate, 15000);
    r.actions.push({ candidate, checked });
    assert.equal(checked.disposition, "COUNTEREXAMPLE");
  });
}
const report = { scope: "Public full-programme/process edge E2E, not native/protected qualification",
  status: records.every(r => r.status === "PASSED") ? "PASSED" : "FAILED",
  passed: records.filter(r => r.status === "PASSED").length, failed: records.filter(r => r.status === "FAILED").length,
  runtime, records, nativeOwnerFlow: "NOT_RUN" };
await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: report.status, passed: report.passed, failed: report.failed, evidence }));
if (report.failed) process.exitCode = 1;
