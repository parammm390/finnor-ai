import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  digest, PROFILE_DIGEST, type InteractionProblem, type InteractionCandidate
} from "../../packages/private-equity/src/interaction-synthesis/contracts.js";
import { compileGame, protocolControlKeys } from "../../packages/private-equity/src/interaction-synthesis/game.js";
import { construct } from "../../packages/private-equity/src/interaction-synthesis/producer.js";
import { independentlyCheck, runtimeIdentity } from "../../packages/private-equity/src/interaction-synthesis/process.js";
import {
  mathematicalCampaignPlan, dynamicFixture, lieFixture, beliefFixture, boundaryFixture,
  prescribedCandidate, quantity
} from "./math-fixtures.mjs";

const delivery = process.env.FINNOR_Y3_MATH_OUTPUT ?? "/home/factory-user/y3-delivery";
const runId = `math-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const directory = resolve(delivery, runId);
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, "frozen-campaign.json"), JSON.stringify(mathematicalCampaignPlan, null, 2));
const results: unknown[] = [];
const identity = await runtimeIdentity();
const check = (problem: InteractionProblem, candidate: InteractionCandidate | null) =>
  independentlyCheck(problem, candidate, Date.now() + 110_000, identity);
const rebind = (problem: InteractionProblem, candidate: InteractionCandidate) =>
  ({ ...structuredClone(candidate), problemDigest: digest(problem) });
const oracle = (problem: InteractionProblem, candidate: InteractionCandidate) => {
  const r = spawnSync("/usr/bin/python3", ["-I", resolve(import.meta.dirname, "../../packages/private-equity/src/interaction-synthesis/reference.py")], {
    input: JSON.stringify({ problem, candidate }), encoding: "utf8", timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, env: { LANG: "C.UTF-8", NODE_ENV:"test" }
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
async function record(name: string, inputs: unknown, operation: () => Promise<unknown>) {
  await writeFile(resolve(directory, `${name}-input.json`), JSON.stringify(inputs, null, 2));
  const started = Date.now();
  try {
    const evidence = await operation();
    const result = { name, status: "PASS", wallMs: Date.now() - started, evidence };
    results.push(result);
    await writeFile(resolve(directory, `${name}-result.json`), JSON.stringify(result, null, 2));
  } catch (error) {
    const result = { name, status: "FAIL", wallMs: Date.now() - started, error: String(error), stack: error instanceof Error ? error.stack : null };
    results.push(result);
    await writeFile(resolve(directory, `${name}-result.json`), JSON.stringify(result, null, 2));
    throw error;
  }
}
try {
  const dynamic = dynamicFixture();
  let built: InteractionCandidate;
  await record("A-dynamic-synthesis", dynamic, async () => {
    const construction = await construct(dynamic, Date.now() + 110_000, identity);
    assert.equal(construction.status, "CANDIDATE", JSON.stringify(construction));
    built = construction.candidate!;
    const checked = await check(dynamic, built);
    assert.equal(checked.status, "CHECKED", JSON.stringify(checked));
    assert.equal(built.objective, "15/2");
    assert.equal(built.nontrivial, true);
    assert.equal(new Set(Object.values(built.policy)).size, 2, "Policy adapts to the public market history");
    const reference = oracle(dynamic, built);
    assert(reference.models.every((m: { maxRegret: string }) => m.maxRegret === "0"));
    return { construction, checked, reference, keys: protocolControlKeys(dynamic) };
  });
  const lie = lieFixture();
  const lieGames = lie.models.map(m => compileGame(lie, m, {}));
  const liar = prescribedCandidate(lie, lieGames, digest, PROFILE_DIGEST);
  await record("B-early-lie-plus-later-action", { problem: lie, candidate: liar }, async () => {
    const reference = oracle(lie, liar);
    assert.equal(reference.models[0].maxRegret, "3");
    const root = reference.models[0].cases.find((c: { informationKey: string }) => c.informationKey === lieGames[0]!.informationSets.find(i => i.nodeIds.includes("report"))!.id);
    assert.equal(root.gain, "2");
    assert(Object.values(root.plan).includes("lie") && Object.values(root.plan).includes("exploit"));
    const checked = await check(lie, liar);
    assert.equal(checked.status, "REJECTED");
    assert.equal(checked.fullDeviationCoverage, true);
    assert.equal(checked.maxRegret, "3");
    return { reportOnlyGain: "-1", exactRootGain: "2", reference, checked };
  });
  const belief = beliefFixture();
  const games = belief.models.map(m => compileGame(belief, m, {}));
  const candidate = prescribedCandidate(belief, games, digest, PROFILE_DIGEST);
  await record("C-positive-on-and-offpath", { problem: belief, candidate }, async () => {
    const checked = await check(belief, candidate);
    assert.equal(checked.status, "CHECKED", JSON.stringify(checked));
    const reference = oracle(belief, candidate);
    assert.equal(reference.models[0].maxRegret, "0");
    return { checked, reference };
  });
  const skew = structuredClone(candidate);
  for (const info of games[0]!.informationSets) {
    if (info.participant === "P0") {
      const node = info.nodeIds[0];
      skew.models[0]!.trembles[info.id]!.go!.coefficient = node === "H" ? "1" : "3";
    } else {
      skew.models[0]!.beliefs[info.id] = Object.fromEntries(info.nodeIds.map(n => [n, n.startsWith("H") ? "1/4" : "3/4"]));
    }
  }
  await record("C-nonunit-common-limit", { problem: belief, candidate: skew }, async () => {
    const checked = await check(belief, skew);
    assert.equal(checked.status, "CHECKED", JSON.stringify(checked));
    return checked;
  });
  const conflict = structuredClone(skew);
  const later = games[0]!.informationSets.find(i => i.nodeIds.includes("H-b"))!;
  conflict.models[0]!.beliefs[later.id] = Object.fromEntries(later.nodeIds.map(n => [n, n.startsWith("H") ? "3/4" : "1/4"]));
  await record("C-conflicting-local-witnesses", { problem: belief, candidate: conflict }, async () => {
    const checked = await check(belief, conflict);
    assert.equal(checked.status, "REJECTED");
    assert.equal(checked.globalBeliefConsistency, false);
    return checked;
  });
  const mutations: [string, (p: InteractionProblem) => void][] = [
    ["prior", p => {
      const n = p.models[0]!.nodes.find(n => n.id === "root")!;
      if (n.kind === "CHANCE") { n.edges[0]!.probability = "1/4"; n.edges[1]!.probability = "3/4"; }
    }],
    ["observation", p => {
      p.observationRules.push({ ...p.observationRules[0]!, key: "later-signal", allowedRecipients: ["P1"] });
      p.models[0]!.nodes.find(n => n.id === "H-first")!.observations = [{ key: "later-signal", value: "H", recipients: ["P1"] }];
    }],
    ["future-oracle-partition", p => {
      for (const n of p.models[0]!.nodes) if (n.kind === "DECISION") n.informationSet = n.id;
    }],
    ["forgotten-own-action-partition", p => {
      for (const n of p.models[0]!.nodes) if (n.kind === "DECISION" && n.participant === "P1") n.informationSet = "same";
    }],
    ["outside-option", p => { p.participants[0].outsideOption = quantity("2", "P0"); }],
    ["offpath-resource", p => { p.models[0]!.nodes.find(n => n.id === "H-b-stop")!.resources.capacity = "2"; }],
    ["offpath-negative-liability", p => { p.models[0]!.nodes.find(n => n.id === "L-b-stop")!.liabilities[1] = "-1"; }],
    ["offpath-payment-limit", p => { p.models[0]!.nodes.find(n => n.id === "H-b-stop")!.payments[0] = "1"; }],
    ["offpath-liability-limit", p => { p.models[0]!.nodes.find(n => n.id === "L-b-stop")!.liabilities[1] = "1"; }],
    ["unknown-financial-basis", p => { p.financialLimits.absolutePayments[0].basis.sourceStatus="UNKNOWN"; }],
    ["unknown-chance", p => { const n = p.models[0]!.nodes[0]!; if (n.kind === "CHANCE") n.edges[0]!.probability = null; }]
  ];
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(belief);
    mutate(changed);
    const current = rebind(changed, candidate);
    await record(`D-${name}`, { problem: changed, candidate: current }, async () => {
      const checked = await check(changed, current);
      assert.notEqual(checked.status, "CHECKED", JSON.stringify(checked));
      assert.notEqual(checked.status, "INFEASIBLE");
      return checked;
    });
  }
  const removed = structuredClone(dynamic);
  removed.models[0]!.nodes.find(n => n.id === "p0")!.observations = [];
  const missingDisclosure = rebind(removed, built!);
  missingDisclosure.policy = Object.fromEntries(protocolControlKeys(removed).map(k => [k.key, k.options[0]!]));
  await record("D-mandatory-disclosure", { problem: removed, candidate: missingDisclosure }, async () => {
    const checked = await check(removed, missingDisclosure);
    assert.equal(checked.status, "REJECTED");
    assert.equal(checked.reason, "Y3_MANDATORY_DISCLOSURE_MISSING");
    return checked;
  });
  const impossible = structuredClone(dynamic);
  impossible.goal.minimumOwnerValue = quantity("9", "OWNER");
  await record("D-whole-family-goal-bound", impossible, async () => {
    const checked = await check(impossible, null);
    assert.equal(checked.status, "INFEASIBLE", JSON.stringify(checked));
    return checked;
  });
  await record("D-deadline-not-infeasibility", dynamic, async () => {
    const result = await construct(dynamic, Date.now() - 1, identity);
    assert(["INCOMPLETE", "UNKNOWN"].includes(result.status));
    return result;
  });
  const boundary = boundaryFixture();
  await record("A-profile-boundary-16", boundary, async () => {
    const construction = await construct(boundary, Date.now() + 110_000, identity);
    assert.equal(construction.status, "CANDIDATE", JSON.stringify(construction));
    const game = compileGame(boundary, boundary.models[0]!, {});
    assert.equal(game.informationSets.filter(i => i.participant === "P0").length, 16);
    assert.equal(game.informationSets.filter(i => i.participant === "P1").length, 16);
    const checked = await check(boundary, construction.candidate);
    assert.equal(checked.status, "CHECKED", JSON.stringify(checked));
    assert.equal(checked.fullDeviationCoverage, true);
    return { construction, checked, informationSets: 32, purePlansPerParty: 65536 };
  });
} finally {
  const report = {
    schema: "finnor.y3.math-campaign.v1", runId, plan: mathematicalCampaignPlan,
    identity, results, status: results.some((x: any) => x.status === "FAIL") ? "FAIL" : "PASS",
    protectedQualification: false, executionAuthorityGranted: false
  };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifact: resolve(directory, "report.json"), status: report.status, cases: results.length }));
}
