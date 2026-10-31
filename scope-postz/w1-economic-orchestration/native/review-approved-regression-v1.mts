/** Registered before the N1/N2/C2/R3/R4 repairs. Synthetic/isolated, not E2E. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fitNativeContinuation, nativeFrameKey } from "../../../finnor-os/packages/private-equity/src/economic-orchestration/continuation";
import { compileNativePolicy, consumeNativePolicy } from "../../../finnor-os/packages/private-equity/src/economic-orchestration/policy";
import { readNativeFrameTx } from "../../../finnor-os/packages/private-equity/src/economic-orchestration/observations";
import { interpretEconomicRead } from "../../../finnor-os/packages/orchestration/src/economic-read-intake";
import { requestsPositiveInstructionEffect } from "../../../finnor-os/packages/orchestration/src/instruction-effects";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
const originalPath = resolve(import.meta.dirname, "../evidence/review-hygiene-conditional-v1/mechanics.json");
const originalBytes = await readFile(originalPath), original = JSON.parse(originalBytes.toString());
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const watched = [
  "finnor-os/packages/private-equity/src/economic-orchestration/policy.ts",
  "finnor-os/packages/private-equity/src/economic-orchestration/continuation.ts",
  "finnor-os/packages/private-equity/src/economic-orchestration/observations.ts",
  "finnor-os/packages/orchestration/src/economic-read-intake.ts",
  "finnor-os/packages/orchestration/src/instruction-effects.ts",
];
async function sources() {
  return Object.fromEntries(await Promise.all(watched.map(async path => [path, digest(await readFile(resolve(root, path)))])));
}
const before = await sources(), cases: any[] = [];
const startedAt = new Date().toISOString();
async function check(id: string, input: unknown, run: (observation: any) => unknown | Promise<unknown>) {
  const observation: any = {};
  try {
    await run(observation); cases.push({ id, status: "PASS", input, observed: observation });
  } catch (error) {
    cases.push({ id, status: "FAIL", input, observed: observation, error: String(error) });
  }
}
function units(frame: any) {
  return frame.units.map((u: any) => ({ id: u.unitId, status: u.status,
    prerequisites: u.prerequisites.map((key: string) => frame.units.find((p: any) => p.key === key).unitId) }));
}
function fittedInput(samples: any[]) {
  const input = structuredClone(original.input);
  input.continuation = fitNativeContinuation(samples, input.continuation.context, null, input.now);
  input.binding.responseRef = input.continuation.ref;
  return input;
}

await check("N1-distinct-joint-cost-branches-remain-selectable", { sourceFixture: originalPath,
  secondExecuteWallMs: "2", currentRemaining: { attempts: 19, steps: 999, wallMs: 9998 } }, out => {
  const samples = structuredClone(original.samples), duplicate = structuredClone(samples[0]);
  duplicate.id = duplicate.assignmentRef = "same-frame-distinct-joint-cost";
  duplicate.consumption.wallMs = "2"; samples.push(duplicate);
  const input = fittedInput(samples), proposal = compileNativePolicy(input);
  assert.equal(proposal.status, "CHECKED_POLICY", JSON.stringify(proposal));
  if (proposal.status !== "CHECKED_POLICY" || !proposal.continuation) throw Error("VALID_CONDITIONAL_PROPOSAL_REQUIRED");
  const frame = structuredClone(samples[0].after), model = JSON.parse(proposal.modelBytes);
  const sameFrame = model.states.filter((state: any) => proposal.continuation!.frames[state.id]
    && nativeFrameKey(proposal.continuation!.frames[state.id]!) === nativeFrameKey(frame));
  assert(sameFrame.length >= 2, "THE_REGISTERED_SAME_FRAME_DIFFERENT_COST_TRIGGER_MUST_EXIST");
  const current = { ...input, frame, remaining: { ...input.remaining, attempts: 19, steps: 999, wallMs: 9998 } };
  const expected = sameFrame.filter((state: any) => state.remaining["native-attempt"] === "19"
    && state.remaining["logical-step"] === "998" && state.remaining["wall-ms"] === "9998");
  assert.equal(expected.length, 1, "ONE_ACTUAL_RESOURCE_BRANCH_REQUIRED");
  const consumed = consumeNativePolicy(current, proposal, units(frame));
  Object.assign(out, { input, proposal, frame, matchingStates: sameFrame.map((state: any) => ({ id: state.id, remaining: state.remaining })), consumed });
  assert.equal(consumed.status, "DISPATCH");
  if (consumed.status !== "DISPATCH") return;
  assert.deepEqual(consumed.unitIds, ["A-verify"]);
  assert.equal(consumed.stateId, expected[0].id, "DO_NOT_SELECT_FIRST_OR_AVERAGE_DISTINCT_JOINT_COST_BRANCHES");
});

await check("N2-whole-continuation-must-fit-current-wall-budget", { executeWallMs: "1000", verifyWallMs: "1000",
  solvedWallMs: 2000, currentWallMs: 1500, immediateStageFits: true, completeChainFits: false }, out => {
  const samples = structuredClone(original.samples.slice(0, 2));
  for (const sample of samples) {
    sample.consumption.wallMs = "1000";
    for (const frame of [sample.before, sample.after]) {
      frame.units = frame.units.filter((u: any) => u.key.startsWith("A:"));
      frame.requiredChecks = ["A:verify"];
    }
  }
  const input = fittedInput(samples);
  input.frame = structuredClone(samples[0].before);
  input.catalogue.entries = input.catalogue.entries.filter((entry: any) => entry.computationRef === "A");
  input.utility.delayMsCost = "0"; input.remaining.wallMs = 2000;
  const proposal = compileNativePolicy(input);
  assert.equal(proposal.status, "CHECKED_POLICY", JSON.stringify(proposal));
  const positive = consumeNativePolicy(input, proposal, units(input.frame));
  assert.equal(positive.status, "DISPATCH", "REGISTERED_COMPLETE_2000MS_CHAIN_MUST_BE_POSITIVE");
  const current = { ...input, remaining: { ...input.remaining, wallMs: 1500 } };
  const consumed = consumeNativePolicy(current, proposal, units(current.frame));
  Object.assign(out, { input, proposal, positive, current, consumed });
  assert.notEqual(consumed.status, "DISPATCH", "AN_IMMEDIATE_1000MS_STAGE_IS_NOT_A_FEASIBLE_2000MS_CHECKED_CONTINUATION");
});

for (const [name, program] of [
  ["missing-acceptance", { modules: [] }],
  ["nonarray-targets", { modules: [], acceptance: { targets: {} } }],
  ["target-without-key-or-expression", { modules: [], acceptance: { targets: [{}] } }],
] as const) {
  await check("C2-" + name, { persistedProgram: program }, async out => {
    const sql: string[] = [];
    const client: any = { query: async (statement: string) => {
      sql.push(statement);
      assert(statement.startsWith("SELECT "), "ISOLATED_BOUNDARY_CANNOT_WRITE_OR_CLAIM_DATABASE_EVIDENCE");
      return { rows: [], rowCount: 0 };
    } };
    let caught: any;
    try {
      out.frame = await readNativeFrameTx({ id: "search", tenant_id: "tenant", principal_id: "principal",
        status: "RUNNING", context: { program, acceptanceDigest: "a".repeat(64) } } as any, [], client);
    } catch (error) { caught = error; }
    Object.assign(out, { queriedSql: sql, rejection: caught ? { name: caught.name, message: caught.message } : null });
    assert.equal(caught?.name, "ZodError", "CANONICAL_CONSUMED_PROGRAM_SCHEMA_MUST_REJECT_BEFORE_PROPERTY_ACCESS");
  });
}

for (const instruction of [
  "Predict the stock price of $AAPL tomorrow",
  "What was the stock price of $AAPL yesterday?",
  "Show the stock price of $AAPL on 2025-01-01.",
  "Forecast the stock price of NASDAQ:AAPL next week.",
]) {
  await check("R3-unsupported-temporal-" + cases.length, { instruction, expected: null }, out => {
    out.request = interpretEconomicRead(instruction); assert.equal(out.request, null);
  });
}
for (const instruction of [
  "What is the stock price of $AAPL?",
  "What is the stock price of Forecast Analytics?",
  "What is the stock price of Yesterday Markets?",
]) {
  await check("R3-current-read-and-entity-name-" + cases.length, { instruction, expectedIntent: "stock_quote" }, out => {
    out.request = interpretEconomicRead(instruction); assert.equal(out.request?.intent, "stock_quote");
  });
}

for (const instruction of [
  "What is the stock price of $AAPL? Do not buy, sell, or trade.",
  "What is the stock price of $AAPL? Do not buy or sell.",
  "What is the stock price of $AAPL? Don't buy, sell, or trade shares.",
]) {
  await check("R4-coordinated-negated-list-" + cases.length, { instruction, expectedPositiveEffect: false,
    expectedReadIntent: "stock_quote" }, out => {
    out.positive = requestsPositiveInstructionEffect(instruction);
    out.request = interpretEconomicRead(instruction);
    assert.equal(out.positive, false); assert.equal(out.request?.intent, "stock_quote");
  });
}
for (const instruction of [
  "What is the stock price of $AAPL? Do not buy. Sell AAPL.",
  "What is the stock price of $AAPL? Do not buy\n- Sell AAPL.",
  "What is the stock price of $AAPL? Do not buy; sell AAPL.",
  "What is the stock price of $AAPL? Do not buy, then sell AAPL.",
  "What is the stock price of $AAPL? Do not buy, but please sell AAPL.",
  "What is the stock price of $AAPL? Do not buy, and please sell AAPL.",
]) {
  await check("R4-independent-positive-command-" + cases.length, { instruction, expectedPositiveEffect: true,
    expectedRead: null }, out => {
    out.positive = requestsPositiveInstructionEffect(instruction);
    out.request = interpretEconomicRead(instruction);
    assert.equal(out.positive, true); assert.equal(out.request, null);
  });
}

const after = await sources(), unchanged = JSON.stringify(before) === JSON.stringify(after);
const report = { schema: "finnor.w1.review-approved-isolated-regressions.v1", startedAt, completedAt: new Date().toISOString(),
  qualification: "SYNTHETIC_AND_ISOLATED_BOUNDARY_FAILURE_FIRST_NOT_OWNING_E2E_OR_W001_W060_OR_ECONOMIC_PROOF",
  sourceFixture: { path: originalPath, sha256: digest(originalBytes) }, before, after, sourcesUnchanged: unchanged,
  actualPostgres: false, actualHttp: false, productProviderCalls: 0, billingUSD: null, cases,
  summary: { total: cases.length, pass: cases.filter(c => c.status === "PASS").length, fail: cases.filter(c => c.status === "FAIL").length } };
await writeFile(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report.summary, sourcesUnchanged: unchanged, receipt: destination }));
process.exitCode = unchanged && report.summary.fail === 0 ? 0 : 1;
