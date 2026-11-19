import {
  canonical, digest, fail, PROFILE, ProblemSchema, type InteractionProblem, type InteractionModel, type Node
} from "./contracts.js";
import { q, ONE, ZERO, sum } from "./exact.js";

export type ObservationToken = { date: number; key: string; value: string; visibility: "PUBLIC" | "PRIVATE" };
export type RecallToken = { informationKey: string; actionId: string };
export type InformationSet = {
  id: string; participant: "P0" | "P1"; actionIds: string[]; nodeIds: string[]; date: number;
  observations: ObservationToken[]; recall: RecallToken[];
};
export type CompiledNode = {
  id: string; original: Node; kind: Node["kind"]; date: number; depth: number;
  informationKey: string | null; controlKey: string | null; chanceReach: string;
  edges: { actionId: string; next: string; probability: string }[];
  observations: [ObservationToken[], ObservationToken[]]; publicObservations: ObservationToken[];
  recall: [RecallToken[], RecallToken[]];
};
export type CompiledGame = {
  modelId: string; root: string; informationSets: InformationSet[]; nodes: Record<string, CompiledNode>;
  topologicalOrder: string[]; usedControlKeys: string[];
};
export type ProtocolControlKey = {
  key: string; controlId: string; date: number; publicObservations: ObservationToken[];
  options: string[]; modelIds: string[]; nodeIds: string[];
};
const unique = (v: string[], code: string) => { if (new Set(v).size !== v.length) fail(code); };
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function protocolKey(controlId: string, date: number, publicObservations: ObservationToken[]) {
  return "K:" + digest({ controlId, date, publicObservations });
}
export function informationKey(participant: string, date: number, observations: ObservationToken[], recall: RecallToken[]) {
  return "I:" + digest({ participant, date, observations, recall });
}
function originalTree(problem: InteractionProblem, model: InteractionModel) {
  const nodes = new Map(model.nodes.map(n => [n.id, n]));
  unique(model.nodes.map(n => n.id), "Y3_DUPLICATE_NODE");
  unique(problem.controls.map(c => c.id), "Y3_DUPLICATE_CONTROL");
  unique(problem.models.map(m => m.id), "Y3_DUPLICATE_MODEL");
  unique(problem.observationRules.map(r => r.key), "Y3_DUPLICATE_OBSERVATION_RULE");
  const controls = new Map(problem.controls.map(c => [c.id, c]));
  const rules = new Map(problem.observationRules.map(r => [r.key, r]));
  const seen = new Set<string>();
  function walk(id: string, parentDate: number) {
    if (seen.has(id)) fail("Y3_NOT_A_FINITE_TREE");
    seen.add(id);
    const n = nodes.get(id);
    if (!n) fail("Y3_MISSING_NODE");
    if (n.date < parentDate) fail("Y3_TIME_REVERSAL");
    for (const o of n.observations) {
      const rule = rules.get(o.key);
      if (!rule) fail("Y3_UNDECLARED_OBSERVATION");
      unique(o.recipients, "Y3_DUPLICATE_RECIPIENT");
      if (o.recipients.some(r => !rule.allowedRecipients.includes(r))) fail("Y3_UNLAWFUL_RECIPIENT");
    }
    if (n.kind === "TERMINAL") return;
    unique(n.edges.map(e => e.actionId), "Y3_DUPLICATE_ACTION");
    if (n.kind === "PROTOCOL") {
      const c = controls.get(n.controlId);
      if (!c || !same([...c.options].sort(), n.edges.map(e => e.actionId).sort())) fail("Y3_PROTOCOL_ALPHABET_CHANGED");
    }
    if (n.kind === "CHANCE") {
      if (n.edges.some(e => e.probability === null)) fail("Y3_UNIDENTIFIED_CHANCE");
      const ps = n.edges.map(e => q(e.probability!));
      if (ps.some(p => p.compare(ZERO) < 0) || sum(ps).compare(ONE) !== 0) fail("Y3_INVALID_CHANCE_LAW");
    }
    for (const e of n.edges) walk(e.next, n.date);
  }
  walk(model.root, 0);
  if (seen.size !== nodes.size) fail("Y3_DISCONNECTED_TREE");
  return { nodes, controls, rules };
}
function compatibleBases(problem: InteractionProblem) {
  for (const i of [0, 1] as const) {
    const outside = problem.participants[i].outsideOption;
    if (!same(outside.basis, problem.quantityBasis.utilities[i])) fail("Y3_OUTSIDE_OPTION_BASIS");
    if (outside.value === null || outside.basis.sourceStatus === "UNKNOWN") fail("Y3_UNKNOWN_OUTSIDE_OPTION");
  }
  if (!same(problem.goal.minimumOwnerValue.basis, problem.quantityBasis.ownerValue)) fail("Y3_GOAL_BASIS");
  const quantities = [problem.goal.minimumOwnerValue, ...Object.values(problem.resourceLimits),
    ...problem.financialLimits.absolutePayments, ...problem.financialLimits.liabilities];
  if (quantities.some(v => v.value === null || v.basis.sourceStatus === "UNKNOWN")
      || [...problem.quantityBasis.utilities, problem.quantityBasis.ownerValue].some(b => b.sourceStatus === "UNKNOWN"))
    fail("Y3_UNKNOWN_QUANTITY");
  for (const v of Object.values(problem.resourceLimits)) if (q(v.value!).compare(ZERO) < 0) fail("Y3_NEGATIVE_RESOURCE_LIMIT");
  for (const v of [...problem.financialLimits.absolutePayments, ...problem.financialLimits.liabilities])
    if (q(v.value!).compare(ZERO) < 0) fail("Y3_NEGATIVE_FINANCIAL_LIMIT");
}
export function protocolControlKeys(input: InteractionProblem): ProtocolControlKey[] {
  const problem = ProblemSchema.parse(input);
  const found = new Map<string, ProtocolControlKey>();
  for (const model of problem.models) {
    const { nodes, controls } = originalTree(problem, model);
    function walk(id: string, publicHistory: ObservationToken[]) {
      const n = nodes.get(id)!;
      const pub = [...publicHistory, ...n.observations.filter(o => o.recipients.includes("PUBLIC"))
        .map(o => ({ date: n.date, key: o.key, value: o.value, visibility: "PUBLIC" as const }))];
      if (n.kind === "TERMINAL") return;
      if (n.kind === "PROTOCOL") {
        const key = protocolKey(n.controlId, n.date, pub);
        const entry = found.get(key) ?? {
          key, controlId: n.controlId, date: n.date, publicObservations: pub,
          options: [...controls.get(n.controlId)!.options], modelIds: [], nodeIds: []
        };
        if (!entry.modelIds.includes(model.id)) entry.modelIds.push(model.id);
        entry.nodeIds.push(n.id);
        found.set(key, entry);
      }
      for (const e of n.edges) if (n.kind !== "CHANCE" || q((e as { probability: string }).probability).compare(ZERO) > 0)
        walk(e.next, pub);
    }
    walk(model.root, []);
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export function compileGame(input: InteractionProblem, suppliedModel: InteractionModel, policy: Record<string, string>): CompiledGame {
  const problem = ProblemSchema.parse(input);
  const model = problem.models.find(m => m.id === suppliedModel.id);
  if (!model || !same(model, suppliedModel)) fail("Y3_MODEL_NOT_BOUND");
  compatibleBases(problem);
  const { nodes: original, controls, rules } = originalTree(problem, model);
  const nodes: Record<string, CompiledNode> = Object.create(null);
  const infos = new Map<string, InformationSet>();
  const assertedToLegal = new Map<string, string>(), legalToAsserted = new Map<string, string>();
  const topologicalOrder: string[] = [], used = new Set<string>();
  function mandatory(delivered: Map<string, Set<string>>, throughDate: number) {
    for (const rule of rules.values()) if (rule.mandatoryByDate !== null && rule.mandatoryByDate <= throughDate) {
      const have = delivered.get(rule.key) ?? new Set<string>();
      if (rule.allowedRecipients.some(r => !have.has(r) && !(r !== "PUBLIC" && have.has("PUBLIC"))))
        fail("Y3_MANDATORY_DISCLOSURE_MISSING");
    }
  }
  function walk(id: string, depth: number, observed: [ObservationToken[], ObservationToken[]],
    publicHistory: ObservationToken[], recall: [RecallToken[], RecallToken[]],
    delivered: Map<string, Set<string>>, chanceReach: string) {
    const n = original.get(id)!;
    const obs: [ObservationToken[], ObservationToken[]] = [[...observed[0]], [...observed[1]]];
    const pub = [...publicHistory];
    const sent = new Map([...delivered].map(([k, v]) => [k, new Set(v)]));
    for (const o of n.observations) {
      const token: ObservationToken = {
        date: n.date, key: o.key, value: o.value,
        visibility: o.recipients.includes("PUBLIC") ? "PUBLIC" : "PRIVATE"
      };
      if (o.recipients.includes("PUBLIC")) pub.push(token);
      for (const i of [0, 1] as const) if (o.recipients.includes(i === 0 ? "P0" : "P1") || o.recipients.includes("PUBLIC")) obs[i].push(token);
      const recipients = sent.get(o.key) ?? new Set<string>();
      o.recipients.forEach(r => recipients.add(r)); sent.set(o.key, recipients);
    }
    for (const [resource, value] of Object.entries(n.resources)) {
      const limit = problem.resourceLimits[resource];
      if (!limit || q(value).compare(ZERO) < 0 || q(value).compare(q(limit.value!)) > 0) fail("Y3_ALL_HISTORY_RESOURCE_LIMIT");
    }
    if (n.liabilities.some(v => q(v).compare(ZERO) < 0)) fail("Y3_NEGATIVE_LIABILITY");
    for (const i of [0, 1] as const) {
      const payment = q(n.payments[i]), absolute = payment.compare(ZERO) < 0 ? ZERO.sub(payment) : payment;
      if (absolute.compare(q(problem.financialLimits.absolutePayments[i].value!)) > 0
        || q(n.liabilities[i]).compare(q(problem.financialLimits.liabilities[i].value!)) > 0)
        fail("Y3_ALL_HISTORY_FINANCIAL_LIMIT");
    }
    const state: CompiledNode = {
      id, original: n, kind: n.kind, date: n.date, depth, informationKey: null, controlKey: null,
      chanceReach, edges: [], observations: obs, publicObservations: pub, recall
    };
    nodes[id] = state; topologicalOrder.push(id);
    if (n.kind === "TERMINAL") {
      mandatory(sent, 2);
      if (n.payoff.some(v => v === null) || n.ownerValue === null) fail("Y3_UNKNOWN_PAYOFF");
      return;
    }
    let edges = n.edges;
    if (n.kind === "PROTOCOL") {
      const key = protocolKey(n.controlId, n.date, pub);
      const choice = policy[key];
      if (choice === undefined || !controls.get(n.controlId)!.options.includes(choice)) fail("Y3_MISSING_OR_INVALID_POLICY");
      state.controlKey = key; used.add(key);
      edges = n.edges.filter(e => e.actionId === choice);
    }
    if (n.kind === "DECISION") {
      const p = n.participant === "P0" ? 0 : 1;
      const key = informationKey(n.participant, n.date, obs[p], recall[p]);
      state.informationKey = key;
      const info = infos.get(key) ?? {
        id: key, participant: n.participant, actionIds: n.edges.map(e => e.actionId), nodeIds: [],
        date: n.date, observations: obs[p], recall: recall[p]
      };
      if (!same([...info.actionIds].sort(), n.edges.map(e => e.actionId).sort())) fail("Y3_INFORMATION_ACTION_ALPHABET");
      info.nodeIds.push(id); infos.set(key, info);
      const asserted = n.participant + ":" + (n.informationSet ?? key);
      if ((assertedToLegal.has(asserted) && assertedToLegal.get(asserted) !== key)
        || (legalToAsserted.has(key) && legalToAsserted.get(key) !== asserted)) fail("Y3_ASSERTED_PARTITION_NOT_LAWFUL");
      assertedToLegal.set(asserted, key); legalToAsserted.set(key, asserted);
    }
    for (const e of edges) {
      const probability = n.kind === "CHANCE" ? (e as { probability: string }).probability : "1";
      if (q(probability).compare(ZERO) === 0) continue;
      const next = original.get(e.next)!;
      if (next.date > n.date) mandatory(sent, next.date - 1);
      const nextRecall: [RecallToken[], RecallToken[]] = [[...recall[0]], [...recall[1]]];
      if (n.kind === "DECISION") nextRecall[n.participant === "P0" ? 0 : 1].push({ informationKey: state.informationKey!, actionId: e.actionId });
      state.edges.push({ actionId: e.actionId, next: e.next, probability });
      walk(e.next, depth + 1, obs, pub, nextRecall, sent, q(chanceReach).mul(q(probability)).toString());
    }
  }
  walk(model.root, 0, [[], []], [], [[], []], new Map(), "1");
  for (const p of ["P0", "P1"])
    if ([...infos.values()].filter(i => i.participant === p).length > PROFILE.protocol_horizon_and_deviation_classes.maxInformationSetsPerParty)
      fail("Y3_INFORMATION_SET_BOUND");
  return { modelId: model.id, root: model.root, informationSets: [...infos.values()], nodes, topologicalOrder, usedControlKeys: [...used] };
}
