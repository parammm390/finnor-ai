import type { InteractionProblem, InteractionCandidate } from "../../packages/private-equity/src/interaction-synthesis/contracts.js";

export const mathematicalCampaignPlan = Object.freeze({
  frozenBeforeCriticalImplementation: true,
  failures: [
    "Noncanonical rational arithmetic or floating tolerance",
    "A report-only check misses an early lie followed by exploitation",
    "Local posteriors cannot share one joint tremble sequence",
    "Changed priors, observations, or asserted partitions reuse stale beliefs",
    "A policy depends on private state or an undeclared future observation",
    "Mandatory disclosures disappear on a strategy-zero history",
    "Outside options or resources are checked only on the prescribed path",
    "Search exhaustion or timeout is mislabeled INFEASIBLE",
    "The independent reference accidentally imports producer/checker logic",
    "The emitted runtime loses its assets or changes pins before dispatch",
    "The 16-information-set boundary silently truncates deviations"
  ],
  proof: "Original-tree exhaustive pure continuation reference for small games; independent perfect-recall counterfactual dynamic programming at the profile boundary.",
  searchGap: "Finite rational behavior grid and unit-order/unit-coefficient producer witnesses do not cover every sequential assessment.",
  notQualification: "Public development only. No protected games, financial claim, deploy, or effect authority."
});

export const ref = { owner: "S1", id: "public-math-model", version: "1", contentDigest: "a".repeat(64) };
export const basis = (owner: string) => ({
  unit: "utility", currency: null, timeBasis: "three-date-model", owner,
  rounding: "EXACT" as const, sourceStatus: "SUPPLIED_MODEL" as const, sourceRef: ref
});
export const quantity = (value: string, owner: string) => ({ value, basis: basis(owner) });
const financial = (owner:string) => ({value:"0",basis:{...basis(owner),unit:"node-monetary-snapshot",currency:"USD"}});
const common = (id: string, date: 0 | 1 | 2, state: [0 | 1, 0 | 1] = [0, 0]) => ({
  id, date, state, observations: [] as { key: string; value: string; recipients: ("P0" | "P1" | "PUBLIC")[] }[],
  resources: { capacity: "0" }, payments: ["0", "0"] as [string, string],
  liabilities: ["0", "0"] as [string, string]
});
const terminal = (id: string, date: 0 | 1 | 2, u = "1", owner = "1", state: [0 | 1, 0 | 1] = [0, 0]) =>
  ({ ...common(id, date, state), kind: "TERMINAL" as const, payoff: [u, "1"] as [string, string], ownerValue: owner });
const decision = (id: string, date: 0 | 1 | 2, participant: "P0" | "P1", edges: { actionId: string; next: string }[], state: [0 | 1, 0 | 1] = [0, 0]) =>
  ({ ...common(id, date, state), kind: "DECISION" as const, participant, edges });
const chance = (id: string, edges: { actionId: string; next: string; probability: string }[]) => ({
  ...common(id, 0), kind: "CHANCE" as const, chanceRole: "PRIOR" as const,
  probabilityBasis: { population: "public development fixture", conditioning: "root", identificationRef: ref }, edges
});
export function base(id: string): InteractionProblem {
  return {
    schema: "finnor.interaction-problem.v1", id, title: id,
    participants: [
      { id: "P0", principalId: "00000000-0000-4000-8000-000000000001", outsideOption: quantity("0", "P0") },
      { id: "P1", principalId: "00000000-0000-4000-8000-000000000002", outsideOption: quantity("0", "P1") }
    ],
    dates: ["2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z"],
    fixedOperatorRefs: [ref], actorModelRefs: [ref],
    quantityBasis: { utilities: [basis("P0"), basis("P1")], ownerValue: basis("OWNER") },
    financialLimits: {
      absolutePayments: [financial("P0"),financial("P1")],
      liabilities: [financial("P0"),financial("P1")],
      semantics: "SIGNED_NODE_SNAPSHOTS_NO_IMPLICIT_NETTING_OR_UTILITY_CONVERSION"
    },
    observationRules: [], controls: [], models: [],
    resourceLimits: { capacity: quantity("1", "S5") },
    goal: { minimumOwnerValue: quantity("0", "OWNER"), requireNontrivial: false }
  };
}
export function dynamicFixture(): InteractionProblem {
  const p = base("public-dynamic-selection");
  p.controls = [{ id: "release", kind: "DISCLOSURE", options: ["hold", "disclose"] }];
  p.observationRules = [
    { key: "market", allowedRecipients: ["PUBLIC"], mandatoryByDate: 0, classification: "SOURCED_FACT", sourceRef: ref },
    { key: "private-type", allowedRecipients: ["P0", "PUBLIC"], mandatoryByDate: null, classification: "MODEL_RELATIVE_STATEMENT", sourceRef: ref }
  ];
  const nodes: InteractionProblem["models"][number]["nodes"] = [
    chance("root", [{ actionId: "low", next: "p0", probability: "1/2" }, { actionId: "high", next: "p1", probability: "1/2" }])
  ];
  for (const bit of [0, 1] as const) {
    const protocol = {
      ...common(`p${bit}`, 0, [bit, 0]), kind: "PROTOCOL" as const, controlId: "release",
      observations: [{ key: "market", value: String(bit), recipients: ["PUBLIC" as const] }],
      edges: ["hold", "disclose"].map(a => ({ actionId: a, next: `${bit}-${a}-engage` }))
    };
    nodes.push(protocol);
    for (const option of ["hold", "disclose"]) {
      const id = `${bit}-${option}`;
      const first = decision(`${id}-engage`, 1, "P0",
        [{ actionId: "engage", next: `${id}-accept` }, { actionId: "withdraw", next: `${id}-withdrawn` }], [bit, 0]);
      first.observations = [{ key: "private-type", value: String(bit), recipients: option === "disclose" ? ["PUBLIC"] : ["P0"] }];
      nodes.push(first, decision(`${id}-accept`, 2, "P1",
        [{ actionId: "accept", next: `${id}-done` }, { actionId: "reject", next: `${id}-rejected` }], [bit, 1]));
      const owner = bit === 0 ? option === "hold" ? "7" : "3" : option === "disclose" ? "8" : "4";
      nodes.push(terminal(`${id}-done`, 2, "2", owner, [bit, 1]),
        terminal(`${id}-withdrawn`, 1, "0", "0", [bit, 0]), terminal(`${id}-rejected`, 2, "0", "0", [bit, 1]));
      const done = nodes.find(n => n.id === `${id}-done`)!;
      if (done.kind === "TERMINAL") done.payoff[1] = "2";
    }
  }
  p.models = [{ id: "supplied", qualificationRef: ref, root: "root", nodes }];
  p.goal = { minimumOwnerValue: quantity("7", "OWNER"), requireNontrivial: true };
  return p;
}
export function lieFixture(): InteractionProblem {
  const p = base("early-lie-later-exploitation");
  p.models = [{ id: "supplied", qualificationRef: ref, root: "report", nodes: [
    decision("report", 0, "P0", [{ actionId: "truth", next: "truthful" }, { actionId: "lie", next: "approval" }]),
    terminal("truthful", 0, "0"),
    decision("approval", 1, "P1", [{ actionId: "approve", next: "delivery" }, { actionId: "block", next: "blocked" }]),
    terminal("blocked", 1, "-1"),
    decision("delivery", 2, "P0", [{ actionId: "honor", next: "honored" }, { actionId: "exploit", next: "exploited" }]),
    terminal("honored", 2, "-1"), terminal("exploited", 2, "2")
  ] }];
  return p;
}
export function beliefFixture(): InteractionProblem {
  const p = base("one-global-offpath-limit");
  p.observationRules = [
    { key: "type", allowedRecipients: ["P0"], mandatoryByDate: null, classification: "MODEL_RELATIVE_STATEMENT", sourceRef: ref }
  ];
  const nodes: InteractionProblem["models"][number]["nodes"] = [
    chance("root", [{ actionId: "H", next: "H", probability: "1/2" }, { actionId: "L", next: "L", probability: "1/2" }])
  ];
  for (const type of ["H", "L"]) {
    const first = decision(type, 0, "P0", [{ actionId: "stay", next: `${type}-stay` }, { actionId: "go", next: `${type}-first` }]);
    first.observations = [{ key: "type", value: type, recipients: ["P0"] }];
    nodes.push(first, terminal(`${type}-stay`, 0),
      decision(`${type}-first`, 1, "P1", [{ actionId: "a", next: `${type}-a` }, { actionId: "b", next: `${type}-b` }]));
    for (const a of ["a", "b"]) {
      nodes.push(decision(`${type}-${a}`, 2, "P1", [{ actionId: "finish", next: `${type}-${a}-done` }, { actionId: "stop", next: `${type}-${a}-stop` }]),
        terminal(`${type}-${a}-done`, 2), terminal(`${type}-${a}-stop`, 2));
    }
  }
  p.models = [{ id: "supplied", qualificationRef: ref, root: "root", nodes }];
  return p;
}
export function boundaryFixture(): InteractionProblem {
  const p = base("sixteen-information-sets-per-party");
  p.observationRules = [{ key: "branch", allowedRecipients: ["PUBLIC"], mandatoryByDate: null, classification: "SOURCED_FACT", sourceRef: ref }];
  const nodes: InteractionProblem["models"][number]["nodes"] = [];
  function branches(prefix: string, depth: number): string {
    if (depth === 4) {
      const first = decision(`${prefix}-P0`, 1, "P0", [{ actionId: "continue", next: `${prefix}-P1` }, { actionId: "stop", next: `${prefix}-stop0` }]);
      first.observations = [{ key: "branch", value: prefix, recipients: ["PUBLIC"] }];
      nodes.push(first, terminal(`${prefix}-stop0`, 1, "0", "0"),
        decision(`${prefix}-P1`, 2, "P1", [{ actionId: "continue", next: `${prefix}-done` }, { actionId: "stop", next: `${prefix}-stop1` }]),
        terminal(`${prefix}-done`, 2, "2", "2"), terminal(`${prefix}-stop1`, 2, "0", "0"));
      const done = nodes.find(n => n.id === `${prefix}-done`)!;
      if (done.kind === "TERMINAL") done.payoff[1] = "2";
      return first.id;
    }
    const edges = ["0", "1"].map(a => ({ actionId: a, next: branches(prefix + a, depth + 1), probability: "1/2" }));
    nodes.push(chance(prefix || "root", edges));
    return prefix || "root";
  }
  const root = branches("", 0);
  p.models = [{ id: "supplied", qualificationRef: ref, root, nodes }];
  return p;
}
export function prescribedCandidate(problem: InteractionProblem, games: { informationSets: { id: string; actionIds: string[]; nodeIds: string[] }[] }[], digest: (x: unknown) => string, profileDigest: string): InteractionCandidate {
  const strategy: InteractionCandidate["strategy"] = {};
  const models: InteractionCandidate["models"] = [];
  for (let m = 0; m < games.length; m++) {
    const beliefs: InteractionCandidate["models"][number]["beliefs"] = {};
    const trembles: InteractionCandidate["models"][number]["trembles"] = {};
    for (const info of games[m]!.informationSets) {
      strategy[info.id] = Object.fromEntries(info.actionIds.map((a, i) => [a, i === 0 ? "1" : "0"]));
      beliefs[info.id] = Object.fromEntries(info.nodeIds.map(n => [n, info.nodeIds.length === 1 ? "1" : `1/${info.nodeIds.length}`]));
      trembles[info.id] = Object.fromEntries(info.actionIds.map(a => [a, { order: 1, coefficient: "1" }]));
    }
    models.push({ modelId: problem.models[m]!.id, beliefs, trembles });
  }
  return {
    schema: "finnor.interaction-candidate.v1", problemDigest: digest(problem), profileDigest,
    policy: {}, strategy, models, objective: "1", upperBound: "1", nontrivial: false
  };
}
