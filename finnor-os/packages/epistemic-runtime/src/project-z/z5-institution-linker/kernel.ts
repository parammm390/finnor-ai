/** Exact bounded fixed-component composition. No provider, database or grant IO. */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const Z5_VERSION = "z5-coupled-kernel-v1";
export const PREORDER = "SHARED_STATE_EXACT_STRONG_MAY_SIMULATION_MUST_AVAILABILITY_LEGAL_QUIESCENCE_NONBLOCKING_V1";
export type Scalar = string | boolean;
export type Expr = { const: Scalar } | { cell: string } | { local: string }
  | { op: "eq" | "ne" | "lte" | "and" | "or" | "not" | "implies"; args: Expr[] };
export interface State { locals: Record<string, string>; cells: Record<string, string>; fault?: string }
export interface Transition {
  id: string; from: string; to: string; guard: Expr; writes: Record<string, Expr>;
  port: string; direction: "internal" | "input" | "output"; modality: "may" | "must";
}
export interface Component {
  id: string; revision: string; states: { id: string; terminal: boolean; quiescent: boolean }[];
  transitions: Transition[]; assumption: Expr;
  correspondence: { kind: string; scope: string; admission: string; implementationDigest: string };
  bridges: { fromRevision: string; fromState: string; toState: string }[];
}
export interface Input {
  schema: "finnor.z5.composition-input.v1"; claim: string; domain: string;
  components: Component[];
  cells: { id: string; identity: string; values: string[]; kind: string; public: boolean; immutable: boolean }[];
  ports: { label: string; environment: boolean; public: boolean }[];
  initial: State[]; safety: Expr[]; observe: string[]; excludedEnvironmentActions: string[];
  replacementCandidates: Component[]; live: State;
  limits: { maxProductStates: number; maxContextStates: number; maxTransitions: number;
    maxOperations: number; wallMs: number; maxRelationPairs: number; maxTranslationRows: number };
}
export interface Edge {
  from: string; to: string; label: string; owner: string; transitions: string[];
  control: "ENVIRONMENT" | "COMPONENT"; must: boolean;
}
export interface Graph { states: Map<string, State>; edges: Edge[]; initial: string[] }
export interface Context {
  states: string[]; initial: string[]; edges: Edge[]; ranks: Record<string, number>;
  semantics: "ALL_COMPONENT_STEPS_AND_REQUIRED_ENVIRONMENT_OFFERS_NO_INEVITABILITY";
  conditionality: string; maximality: "NOT_CLAIMED_SOUND_SUBSET";
}
export interface Replacement {
  status: "BRIDGED" | "RETAIN_OLD"; component: string | null; revision: string | null;
  relation: [string, string][]; ranks: Record<string, number>; bridge: { old: string; replacement: string; carriedCellsDigest: string } | null;
  reasons: string[]; preorder: typeof PREORDER;
}
export interface Certificate {
  schema: "finnor.z5.institution-composition-certificate.v1"; version: typeof Z5_VERSION;
  inputDigest: string; disposition: "CHECKED_CANDIDATE" | "CHECKED_INFEASIBLE" | "UNSUPPORTED" | "INCOMPLETE";
  reasons: string[]; context: Context | null; replacement: Replacement | null;
  originalCounterexample: { kind: string; initial: string; steps: Edge[]; final: string } | null;
  translation: { rows: number; digest: string } | null;
  original: { states: number; transitions: number; initial: number };
  discharge: { initial: number; componentTransitions: number; environmentTransitions: number; noncircular: boolean };
  correspondence: string; executionAuthorityGranted: false; protectedAdmission: false;
  costs: { operations: number; wallMs: number; cpuUserMicros: number; cpuSystemMicros: number; peakRssBytes: number;
    money: null; human: null; status: "MATERIAL_COSTS_UNMETERED"; gaps: string[] };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value as Record<string, unknown>).sort().map(key =>
    JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export class KernelRefusal extends Error {
  disposition: "UNSUPPORTED" | "INCOMPLETE";
  constructor(disposition: "UNSUPPORTED" | "INCOMPLETE", reason: string) { super(reason); this.disposition = disposition; }
}
export class Budget {
  operations = 0;
  readonly started = performance.now();
  readonly limits: Input["limits"];
  constructor(limits: Input["limits"]) { this.limits = limits; }
  step(n = 1) {
    this.operations += n;
    if (this.operations > this.limits.maxOperations || performance.now() - this.started > this.limits.wallMs)
      throw new KernelRefusal("INCOMPLETE", "ORIGINAL_OPERATION_OR_WALL_BOUND_EXHAUSTED");
  }
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new KernelRefusal("UNSUPPORTED", code);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_:./-]{1,192}$/.test(value)
  && !["__proto__", "constructor", "prototype"].includes(value);
function exact(value: unknown, fields: string[], code: string) {
  requireThat(object(value) && Object.keys(value).sort().join(",") === [...fields].sort().join(","), code);
}
function expr(value: unknown, input: Input, depth = 0): asserts value is Expr {
  requireThat(depth <= 16 && object(value), "UNSUPPORTED_EXPRESSION");
  if ("const" in value) {
    exact(value, ["const"], "EXPRESSION_FIELDS");
    requireThat(typeof value.const === "boolean" || typeof value.const === "string" && /^[\x20-\x7e]{0,192}$/.test(value.const), "CONSTANT_BOUND");
  } else if ("cell" in value) {
    exact(value, ["cell"], "EXPRESSION_FIELDS");
    requireThat(input.cells.some(c => c.id === value.cell), "UNKNOWN_SHARED_CELL");
  } else if ("local" in value) {
    exact(value, ["local"], "EXPRESSION_FIELDS");
    requireThat(input.components.some(c => c.id === value.local), "UNKNOWN_LOCAL_STATE");
  } else {
    exact(value, ["op", "args"], "EXPRESSION_FIELDS");
    requireThat(typeof value.op === "string" && ["eq", "ne", "lte", "and", "or", "not", "implies"].includes(value.op)
      && Array.isArray(value.args) && value.args.length <= 32, "UNSUPPORTED_OPERATOR");
    requireThat(["and", "or"].includes(value.op) ? value.args.length > 0
      : value.args.length === (value.op === "not" ? 1 : 2), "OPERATOR_ARITY");
    value.args.forEach(a => expr(a, input, depth + 1));
  }
}
export function evaluate(e: Expr, state: State): Scalar {
  if ("const" in e) return e.const;
  if ("cell" in e) return state.cells[e.cell]!;
  if ("local" in e) return state.locals[e.local]!;
  const args = e.args.map(a => evaluate(a, state));
  switch (e.op) {
    case "eq": return args[0] === args[1];
    case "ne": return args[0] !== args[1];
    case "lte":
      requireThat(args.every(v => typeof v === "string" && /^(0|-?[1-9][0-9]{0,63})$/.test(v)), "EXACT_INTEGER_COMPARISON_REQUIRED");
      return BigInt(args[0] as string) <= BigInt(args[1] as string);
    case "and": requireThat(args.every(a => typeof a === "boolean"), "BOOLEAN_REQUIRED"); return args.every(Boolean);
    case "or": requireThat(args.every(a => typeof a === "boolean"), "BOOLEAN_REQUIRED"); return args.some(Boolean);
    case "not": requireThat(typeof args[0] === "boolean", "BOOLEAN_REQUIRED"); return !args[0];
    case "implies": requireThat(args.every(a => typeof a === "boolean"), "BOOLEAN_REQUIRED"); return !args[0] || args[1] === true;
  }
}
function validateState(input: Input, state: State) {
  exact(state, ["locals", "cells"], "STATE_FIELDS");
  exact(state.locals, input.components.map(c => c.id), "ORIGINAL_LOCAL_COVERAGE");
  exact(state.cells, input.cells.map(c => c.id), "ORIGINAL_SHARED_COVERAGE");
  requireThat(input.components.every(c => c.states.some(s => s.id === state.locals[c.id]))
    && input.cells.every(c => c.values.includes(state.cells[c.id]!)), "STATE_OUTSIDE_ORIGINAL_DOMAIN");
}
export function parseInput(raw: unknown): Input {
  requireThat(Buffer.byteLength(JSON.stringify(raw)) <= 8 * 1024 * 1024, "INPUT_BYTE_BOUND");
  exact(raw, ["schema", "claim", "domain", "components", "cells", "ports", "initial", "safety", "observe",
    "excludedEnvironmentActions", "replacementCandidates", "live", "limits"], "INPUT_FIELDS");
  const input = raw as unknown as Input;
  requireThat(input.schema === "finnor.z5.composition-input.v1" && input.claim === "SOUND_SUBSET"
    && ["PUBLIC_OFFLINE_FIXED_KERNELS", "ORDINARY_DEVELOPMENT"].includes(input.domain), "UNSUPPORTED_CLAIM_OR_DOMAIN");
  requireThat(Array.isArray(input.components) && input.components.length >= 2 && input.components.length <= 16
    && Array.isArray(input.cells) && input.cells.length <= 8
    && Array.isArray(input.ports) && input.ports.length <= 16, "PROFILE_BOUND");
  requireThat(new Set(input.components.map(c => c.id)).size === input.components.length, "DUPLICATE_COMPONENT");
  requireThat(new Set(input.cells.map(c => c.id)).size === input.cells.length
    && new Set(input.cells.map(c => c.identity)).size === input.cells.length, "ALIASED_ORIGINAL_SHARED_IDENTITY");
  requireThat(new Set(input.ports.map(p => p.label)).size === input.ports.length, "DUPLICATE_PORT");
  for (const c of input.cells) {
    exact(c, ["id", "identity", "values", "kind", "public", "immutable"], "CELL_FIELDS");
    requireThat(name(c.id) && name(c.identity) && name(c.kind) && typeof c.public === "boolean" && typeof c.immutable === "boolean"
      && Array.isArray(c.values) && c.values.length > 0 && c.values.length <= 32
      && c.values.every(v => typeof v === "string" && /^[\x20-\x7e]{1,192}$/.test(v))
      && new Set(c.values).size === c.values.length, "CELL_DOMAIN");
  }
  for (const p of input.ports) {
    exact(p, ["label", "environment", "public"], "PORT_FIELDS");
    requireThat(name(p.label) && typeof p.environment === "boolean" && typeof p.public === "boolean"
      && (!p.environment || p.public), "UNAUTHORIZED_PRIVATE_ENVIRONMENT_PORT");
  }
  const bounds = { maxProductStates: 65536, maxContextStates: 4096, maxTransitions: 524288,
    maxOperations: 8000000, wallMs: 30000, maxRelationPairs: 262144, maxTranslationRows: 262144 };
  exact(input.limits, Object.keys(bounds), "LIMIT_FIELDS");
  for (const [key, upper] of Object.entries(bounds)) {
    const value = input.limits[key as keyof Input["limits"]];
    requireThat(Number.isSafeInteger(value) && value > 0 && value <= upper, "EXPLICIT_LIMIT_REQUIRED");
  }
  requireThat(Array.isArray(input.replacementCandidates) && input.replacementCandidates.length <= 16, "REVISION_BOUND");
  for (const c of [...input.components, ...input.replacementCandidates]) {
    exact(c, ["id", "revision", "states", "transitions", "assumption", "correspondence", "bridges"], "COMPONENT_FIELDS");
    requireThat(name(c.id) && name(c.revision) && input.components.some(x => x.id === c.id)
      && Array.isArray(c.states) && c.states.length > 0 && c.states.length <= 32
      && new Set(c.states.map(s => s.id)).size === c.states.length, "COMPONENT_STATE_BOUND");
    for (const s of c.states) {
      exact(s, ["id", "terminal", "quiescent"], "LOCATION_FIELDS");
      requireThat(name(s.id) && typeof s.terminal === "boolean" && typeof s.quiescent === "boolean", "LOCATION_SEMANTICS");
    }
    requireThat(Array.isArray(c.transitions) && c.transitions.length <= 256
      && new Set(c.transitions.map(t => t.id)).size === c.transitions.length, "TRANSITION_BOUND");
    exact(c.correspondence, ["kind", "scope", "admission", "implementationDigest"], "CORRESPONDENCE_FIELDS");
    requireThat(c.correspondence.kind === "BOUNDED_TYPED_KERNEL_V1" && c.correspondence.scope === "EXACT_LISTED_KERNEL_ONLY"
      && ["PUBLIC_OFFLINE_FIXED_FIXTURE", "NATIVE_S8_CURRENT_DECLARED_CONTRACT"].includes(c.correspondence.admission)
      && c.correspondence.implementationDigest === digest(c.transitions), "UNQUALIFIED_IMPLEMENTATION_CORRESPONDENCE");
    expr(c.assumption, input);
    for (const t of c.transitions) {
      exact(t, ["id", "from", "to", "guard", "writes", "port", "direction", "modality"], "TRANSITION_FIELDS");
      requireThat(name(t.id) && c.states.some(s => s.id === t.from) && c.states.some(s => s.id === t.to)
        && input.ports.some(p => p.label === t.port) && ["internal", "input", "output"].includes(t.direction)
        && ["may", "must"].includes(t.modality) && object(t.writes), "ORIGINAL_PORT_OR_TRANSITION_UNSUPPORTED");
      expr(t.guard, input);
      for (const [id, value] of Object.entries(t.writes)) {
        requireThat(input.cells.some(cell => cell.id === id && !cell.immutable), "IMMUTABLE_OR_FOREIGN_CELL_WRITE");
        expr(value, input);
      }
    }
    requireThat(Array.isArray(c.bridges) && c.bridges.length <= 1024, "BRIDGE_BOUND");
    for (const b of c.bridges) {
      exact(b, ["fromRevision", "fromState", "toState"], "BRIDGE_FIELDS");
      requireThat(name(b.fromRevision) && name(b.fromState) && c.states.some(s => s.id === b.toState), "BRIDGE_ENTRY_UNSUPPORTED");
    }
  }
  requireThat(Array.isArray(input.initial) && input.initial.length > 0 && input.initial.length <= 4096
    && Array.isArray(input.safety) && input.safety.length > 0 && input.safety.length <= 64, "ORIGINAL_INITIAL_OR_PROPERTY_BOUND");
  input.safety.forEach(p => expr(p, input));
  input.initial.forEach(s => validateState(input, s));
  validateState(input, input.live);
  requireThat(Array.isArray(input.observe) && new Set(input.observe).size === input.observe.length
    && input.observe.every(id => input.cells.some(c => c.id === id && c.public)), "UNAUTHORIZED_OBSERVATION");
  requireThat(input.cells.filter(c => c.public && ["resource", "reservation", "obligation", "authorization", "world"].includes(c.kind))
    .every(c => input.observe.includes(c.id)), "REQUIRED_OBSERVATION_ERASED");
  requireThat(Array.isArray(input.excludedEnvironmentActions) && input.excludedEnvironmentActions.every(p =>
    input.ports.some(x => x.label === p && x.environment)), "EXCLUSION_NOT_ORIGINAL_ENVIRONMENT_ACTION");
  return structuredClone(input);
}
type Selection = { component: Component; transition: Transition }[];
function enabled(c: Component, state: State, port?: string, direction?: Transition["direction"]) {
  return c.transitions.filter(t => t.from === state.locals[c.id]
    && (port === undefined || port === t.port) && (direction === undefined || direction === t.direction)
    && evaluate(t.guard, state) === true);
}
function combine(input: Input, state: State, selection: Selection): State {
  const next: State = { locals: { ...state.locals }, cells: { ...state.cells } }, written = new Map<string, string>();
  for (const { component, transition } of selection) {
    next.locals[component.id] = transition.to;
    for (const [cell, expression] of Object.entries(transition.writes)) {
      const value = evaluate(expression, state);
      if (typeof value !== "string" || !input.cells.find(c => c.id === cell)!.values.includes(value))
        return { ...next, fault: "WRITE_OUTSIDE_ORIGINAL_DOMAIN" };
      if (written.has(cell) && written.get(cell) !== value) return { ...next, fault: "CONFLICTING_ATOMIC_WRITES" };
      written.set(cell, value);
    }
  }
  written.forEach((value, id) => { next.cells[id] = value; });
  return next;
}
function choices(groups: Selection[], budget: Budget): Selection[] {
  let result: Selection[] = [[]];
  for (const group of groups) {
    const next: Selection[] = [];
    for (const prior of result) for (const choice of group) { budget.step(); next.push([...prior, choice]); }
    result = next;
  }
  return result;
}
export function originalSteps(input: Input, state: State, budget: Budget): { edge: Omit<Edge, "from" | "to">; state: State }[] {
  if (state.fault) return [];
  const result: { edge: Omit<Edge, "from" | "to">; state: State }[] = [];
  const add = (selection: Selection, label: string, owner: string, control: Edge["control"], fault?: string) => {
    budget.step();
    const next = fault ? { ...structuredClone(state), fault } : combine(input, state, selection);
    result.push({ edge: { label, owner, transitions: selection.map(s => s.component.id + ":" + s.transition.id),
      control, must: selection.some(s => s.transition.modality === "must") }, state: next });
  };
  for (const component of input.components) for (const t of enabled(component, state)) {
    budget.step();
    if (t.direction === "internal") add([{ component, transition: t }], t.port, component.id, "COMPONENT");
    if (t.direction !== "output") continue;
    const receivers = input.components.filter(c => c.id !== component.id
      && c.transitions.some(x => x.port === t.port && x.direction === "input"));
    const groups = receivers.map(c => enabled(c, state, t.port, "input").map(transition => ({ component: c, transition })));
    if (groups.some(g => g.length === 0)) {
      add([{ component, transition: t }], t.port, component.id, "COMPONENT", "UNMATCHED_OUTPUT");
    } else for (const inputs of choices(groups, budget)) {
      add([{ component, transition: t }, ...inputs], t.port, component.id, "COMPONENT");
    }
  }
  for (const port of input.ports.filter(p => p.environment)) {
    requireThat(!input.components.some(c => c.transitions.some(t => t.port === port.label && t.direction === "output")),
      "AMBIGUOUS_ENVIRONMENT_OUTPUT_OWNER");
    const receivers = input.components.filter(c => c.transitions.some(t => t.port === port.label && t.direction === "input"));
    if (receivers.length === 0) continue;
    const groups = receivers.map(c => enabled(c, state, port.label, "input").map(transition => ({ component: c, transition })));
    if (groups.some(g => g.length === 0)) continue;
    for (const inputs of choices(groups, budget)) add(inputs, port.label, "ENVIRONMENT", "ENVIRONMENT");
  }
  return result;
}
export function originalGraph(input: Input, budget: Budget): Graph {
  const states = new Map<string, State>(), edges: Edge[] = [], initial = input.initial.map(digest);
  const pending: string[] = [];
  for (const s of input.initial) {
    const id = digest(s);
    if (!states.has(id)) {
      if (states.size >= input.limits.maxProductStates) throw new KernelRefusal("INCOMPLETE", "ORIGINAL_PRODUCT_STATE_BOUND_EXHAUSTED");
      states.set(id, s); pending.push(id);
    }
  }
  for (let offset = 0; offset < pending.length; offset++) {
    budget.step();
    const from = pending[offset]!;
    for (const step of originalSteps(input, states.get(from)!, budget)) {
      const to = digest(step.state);
      if (!states.has(to)) {
        if (states.size >= input.limits.maxProductStates) throw new KernelRefusal("INCOMPLETE", "ORIGINAL_PRODUCT_STATE_BOUND_EXHAUSTED");
        states.set(to, step.state); pending.push(to);
      }
      if (edges.length >= input.limits.maxTransitions) throw new KernelRefusal("INCOMPLETE", "ORIGINAL_TRANSITION_BOUND_EXHAUSTED");
      edges.push({ from, to, ...step.edge });
    }
  }
  return { states, edges, initial };
}
export const admissible = (input: Input, state: State) => !state.fault
  && [...input.safety, ...input.components.map(c => c.assumption)].every(p => evaluate(p, state) === true);
export function completed(input: Input, state: State) {
  return !state.fault && input.components.every(c => {
    const s = c.states.find(x => x.id === state.locals[c.id])!;
    return s.terminal || s.quiescent;
  });
}
function outgoing(graph: Pick<Graph, "edges">) {
  const by = new Map<string, Edge[]>();
  for (const e of graph.edges) { const list = by.get(e.from) ?? []; list.push(e); by.set(e.from, list); }
  return by;
}
function coaccessible(nodes: Set<string>, edges: Edge[], terminals: Set<string>, budget: Budget) {
  const ranks = new Map<string, number>(), reverse = new Map<string, string[]>();
  for (const e of edges) if (nodes.has(e.from) && nodes.has(e.to)) {
    const list = reverse.get(e.to) ?? []; list.push(e.from); reverse.set(e.to, list);
  }
  const queue = [...terminals].filter(t => nodes.has(t));
  queue.forEach(t => ranks.set(t, 0));
  for (let i = 0; i < queue.length; i++) for (const previous of reverse.get(queue[i]!) ?? []) {
    budget.step();
    if (!ranks.has(previous)) { ranks.set(previous, ranks.get(queue[i]!)! + 1); queue.push(previous); }
  }
  return ranks;
}
function lawfulOffers(input: Input, graph: Graph, nodes: Set<string>, budget: Budget) {
  const by = outgoing(graph), groups = new Map<string, string[]>();
  for (const id of nodes) {
    const state = graph.states.get(id)!;
    const key = canonical(Object.fromEntries(input.observe.map(c => [c, state.cells[c]])));
    const list = groups.get(key) ?? []; list.push(id); groups.set(key, list);
  }
  const allowed = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    const labels = input.ports.filter(p => p.environment && !input.excludedEnvironmentActions.includes(p.label))
      .filter(p => group.every(id => {
        budget.step();
        const transitions = (by.get(id) ?? []).filter(e => e.control === "ENVIRONMENT" && e.label === p.label);
        return transitions.length > 0 && transitions.every(e => nodes.has(e.to));
      })).map(p => p.label);
    group.forEach(id => allowed.set(id, new Set(labels)));
  }
  return graph.edges.filter(e => nodes.has(e.from) && nodes.has(e.to)
    && (e.control === "COMPONENT" || allowed.get(e.from)?.has(e.label)));
}
export function compatibleContext(input: Input, graph: Graph, budget: Budget): Context | null {
  let nodes = new Set([...graph.states].filter(([, s]) => admissible(input, s)).map(([id]) => id));
  const terminals = new Set([...graph.states].filter(([, s]) => completed(input, s)).map(([id]) => id));
  let retained: Edge[] = [], ranks = new Map<string, number>();
  for (;;) {
    budget.step();
    const old = nodes.size;
    const unsafeSources = new Set(graph.edges.filter(e => e.control === "COMPONENT" && nodes.has(e.from) && !nodes.has(e.to)).map(e => e.from));
    nodes = new Set([...nodes].filter(n => !unsafeSources.has(n)));
    retained = lawfulOffers(input, graph, nodes, budget);
    ranks = coaccessible(nodes, retained, terminals, budget);
    nodes = new Set([...nodes].filter(n => ranks.has(n)));
    if (nodes.size === old) break;
  }
  if (!graph.initial.every(n => nodes.has(n))) return null;
  // Remove unreachable context states, not original states or original edges.
  const reached = new Set(graph.initial), queue = [...reached], by = outgoing({ edges: retained });
  for (let i = 0; i < queue.length; i++) for (const e of by.get(queue[i]!) ?? []) {
    budget.step();
    if (!reached.has(e.to)) { reached.add(e.to); queue.push(e.to); }
  }
  if (reached.size > input.limits.maxContextStates) throw new KernelRefusal("INCOMPLETE", "CONTEXT_AUTOMATON_BOUND_EXHAUSTED");
  retained = retained.filter(e => reached.has(e.from));
  return { states: [...reached].sort(), initial: [...graph.initial], edges: retained,
    ranks: Object.fromEntries([...ranks].filter(([id]) => reached.has(id)).sort(([a], [b]) => a < b ? -1 : 1)),
    semantics: "ALL_COMPONENT_STEPS_AND_REQUIRED_ENVIRONMENT_OFFERS_NO_INEVITABILITY",
    conditionality: "Every represented environment preserves all original component steps and offers every retained environmental input. Scheduling may delay indefinitely. Public-observation-equivalent states have uniform offers.",
    maximality: "NOT_CLAIMED_SOUND_SUBSET" };
}
function counterexample(input: Input, graph: Graph, budget: Budget): Certificate["originalCounterexample"] {
  const parent = new Map<string, Edge>(), seen = new Set(graph.initial), queue = [...seen], by = outgoing(graph);
  const all = new Set(graph.states.keys());
  const terminals = new Set([...graph.states].filter(([, s]) => completed(input, s)).map(([id]) => id));
  const live = coaccessible(all, graph.edges, terminals, budget);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!, state = graph.states.get(id)!;
    if (!admissible(input, state) || !live.has(id)) {
      const steps: Edge[] = []; let start = id;
      while (parent.has(start)) { const edge = parent.get(start)!; steps.unshift(edge); start = edge.from; }
      return { kind: state.fault ?? (!admissible(input, state) ? "SAFETY_OR_ASSUMPTION" : "NONBLOCKING"), initial: start, steps, final: id };
    }
    for (const edge of by.get(id) ?? []) if (!seen.has(edge.to)) { seen.add(edge.to); parent.set(edge.to, edge); queue.push(edge.to); }
  }
  return null;
}
export function translation(input: Input, budget: Budget): { rows: number; digest: string } {
  const hash = createHash("sha256"); let rows = 0;
  const enumerate = (offset: number, values: Record<string, string>, component: Component, location: string) => {
    budget.step();
    if (offset < input.cells.length) {
      const c = input.cells[offset]!;
      for (const value of c.values) enumerate(offset + 1, { ...values, [c.id]: value }, component, location);
      return;
    }
    // Local references are not independent factors. Enumerate their full joint
    // domain too; otherwise a hash of reachable examples could masquerade as
    // whole-kernel translation correspondence.
    const local = (index: number, locals: Record<string, string>) => {
      budget.step();
      if (index < input.components.length) {
        const c = input.components[index]!;
        if (c.id === component.id) { local(index + 1, { ...locals, [c.id]: location }); return; }
        for (const s of c.states) local(index + 1, { ...locals, [c.id]: s.id });
        return;
      }
      if (++rows > input.limits.maxTranslationRows) throw new KernelRefusal("INCOMPLETE", "FULL_TRANSLATION_ROW_BOUND_EXHAUSTED");
      const state: State = { locals, cells: values };
      const meaning = enabled(component, state).map(t => ({ id: t.id, port: t.port, direction: t.direction, modality: t.modality,
        result: combine(input, state, [{ component, transition: t }]) }));
      hash.update(canonical([component.id, location, state, meaning]) + "\n");
    };
    local(0, {});
  };
  for (const c of input.components) for (const s of c.states) enumerate(0, {}, c, s.id);
  return { rows, digest: hash.digest("hex") };
}
function replaceInput(input: Input, replacement: Component): Input | null {
  const old = input.components.find(c => c.id === replacement.id)!;
  const map = (s: State): State | null => {
    const choices = replacement.bridges.filter(b => b.fromRevision === old.revision && b.fromState === s.locals[old.id]);
    if (choices.length !== 1) return null;
    return { locals: { ...s.locals, [old.id]: choices[0]!.toState }, cells: { ...s.cells } };
  };
  const initial = input.initial.map(map);
  if (initial.some(s => !s)) return null;
  const live = map(input.live);
  if (!live) return null;
  return { ...input, components: input.components.map(c => c.id === old.id ? replacement : c), initial: initial as State[], live, replacementCandidates: [] };
}
const pairKey = (a: string, b: string) => a + ":" + b;
function replacementProof(input: Input, graph: Graph, context: Context, replacement: Component, budget: Budget): Replacement | null {
  const newer = replaceInput(input, replacement);
  if (!newer) return null;
  // Translation of the fixed supplied revision is independently reconstructed.
  translation(newer, budget);
  const newGraph = originalGraph(newer, budget);
  const oldBy = outgoing({ edges: context.edges }), newBy = outgoing(newGraph);
  const relation = new Map<string, [string, string]>();
  for (const a of context.states) for (const [b, state] of newGraph.states) {
    budget.step();
    if (admissible(newer, state) && canonical(graph.states.get(a)!.cells) === canonical(state.cells)
      && (!completed(newer, state) || completed(input, graph.states.get(a)!))) {
      if (relation.size >= input.limits.maxRelationPairs) throw new KernelRefusal("INCOMPLETE", "REPLACEMENT_RELATION_BOUND_EXHAUSTED");
      relation.set(pairKey(a, b), [a, b]);
    }
  }
  let ranks = new Map<string, number>();
  for (;;) {
    const count = relation.size, remove = new Set<string>(), joint: Edge[] = [];
    const targets = new Set<string>();
    for (const [key, [a, b]] of relation) {
      budget.step();
      const oldEdges = oldBy.get(a) ?? [], newEdges = newBy.get(b) ?? [];
      const offers = new Set(oldEdges.filter(e => e.control === "ENVIRONMENT").map(e => e.label));
      const permitted = newEdges.filter(e => e.control === "COMPONENT" || offers.has(e.label));
      const match = (e: Edge, f: Edge) => e.label === f.label && e.control === f.control
        && relation.has(pairKey(f.to, e.to));
      if (permitted.some(e => !oldEdges.some(f => match(e, f)))
        || oldEdges.filter(e => e.must || e.control === "ENVIRONMENT").some(f => !permitted.some(e => match(e, f))))
        remove.add(key);
      for (const e of permitted) for (const f of oldEdges.filter(f => match(e, f))) {
        joint.push({ ...e, from: key, to: pairKey(f.to, e.to) });
      }
      if (completed(newer, newGraph.states.get(b)!)) targets.add(key);
    }
    for (const key of remove) relation.delete(key);
    ranks = coaccessible(new Set(relation.keys()), joint, targets, budget);
    for (const key of relation.keys()) if (!ranks.has(key)) relation.delete(key);
    if (relation.size === count) break;
  }
  if (!newGraph.initial.every((b, i) => relation.has(pairKey(graph.initial[i]!, b)))) return null;
  const oldLive = digest(input.live), newLive = digest(newer.live), bridge = pairKey(oldLive, newLive);
  if (!graph.states.has(oldLive) || !newGraph.states.has(newLive) || !relation.has(bridge)) return null;
  return { status: "BRIDGED", component: replacement.id, revision: replacement.revision,
    relation: [...relation.values()].sort(([a, b], [c, d]) => pairKey(a, b) < pairKey(c, d) ? -1 : 1),
    ranks: Object.fromEntries([...ranks].filter(([key]) => relation.has(key))),
    bridge: { old: oldLive, replacement: newLive, carriedCellsDigest: digest(input.live.cells) },
    reasons: [], preorder: PREORDER };
}
export function produce(raw: unknown): Certificate {
  const start = performance.now(), cpu = process.cpuUsage();
  let budget: Budget | null = null;
  const result: Certificate = {
    schema: "finnor.z5.institution-composition-certificate.v1", version: Z5_VERSION,
    inputDigest: digest(raw), disposition: "UNSUPPORTED", reasons: [], context: null, replacement: null,
    originalCounterexample: null, translation: null, original: { states: 0, transitions: 0, initial: 0 },
    discharge: { initial: 0, componentTransitions: 0, environmentTransitions: 0, noncircular: false },
    correspondence: "EXACT_BOUNDED_LISTED_TYPED_KERNELS_NOT_ARBITRARY_TS_SQL_OR_PROVIDER",
    executionAuthorityGranted: false, protectedAdmission: false,
    costs: { operations: 0, wallMs: 0, cpuUserMicros: 0, cpuSystemMicros: 0, peakRssBytes: 0,
      money: null, human: null, status: "MATERIAL_COSTS_UNMETERED",
      gaps: ["EXTRACTION_INTEGRATION_INSTALL_RECOVERY_AND_HUMAN_COSTS_NOT_MEASURED_HERE", "NO_EQUIPPED_OR_FINANCIAL_RESULT"] },
  };
  try {
    const input = parseInput(raw);
    budget = new Budget(input.limits); budget.step();
    result.translation = translation(input, budget);
    const graph = originalGraph(input, budget);
    result.original = { states: graph.states.size, transitions: graph.edges.length, initial: graph.initial.length };
    result.originalCounterexample = counterexample(input, graph, budget);
    const context = compatibleContext(input, graph, budget);
    if (!context) {
      result.disposition = "CHECKED_INFEASIBLE";
      result.reasons = ["NO_NONEMPTY_CLOSED_NONBLOCKING_CONTEXT_COVERS_EVERY_ORIGINAL_INITIAL"];
    } else {
      result.context = context;
      result.disposition = "CHECKED_CANDIDATE";
      result.discharge = { initial: graph.initial.length,
        componentTransitions: context.edges.filter(e => e.control === "COMPONENT").length,
        environmentTransitions: context.edges.filter(e => e.control === "ENVIRONMENT").length, noncircular: true };
      result.replacement = { status: "RETAIN_OLD", component: null, revision: null, relation: [], ranks: {}, bridge: null,
        reasons: ["NO_CHECKED_SUPPLIED_REVISION_AND_ACTUAL_LIVE_BRIDGE"], preorder: PREORDER };
      if (!graph.states.has(digest(input.live))) {
        result.replacement.reasons = ["ACTUAL_LIVE_STATE_NOT_REACHABLE_NO_RESET_AUTHORITY"];
      } else for (const revision of input.replacementCandidates) {
        const proof = replacementProof(input, graph, context, revision, budget);
        if (proof) { result.replacement = proof; break; }
      }
    }
  } catch (error) {
    if (!(error instanceof KernelRefusal)) throw error;
    result.disposition = error.disposition; result.reasons = [error.message]; result.context = null; result.replacement = null;
    result.discharge = { initial: 0, componentTransitions: 0, environmentTransitions: 0, noncircular: false };
  }
  const measured = process.cpuUsage(cpu);
  result.costs = { ...result.costs, operations: budget?.operations ?? 0, wallMs: performance.now() - start,
    cpuUserMicros: measured.user, cpuSystemMicros: measured.system, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  return result;
}

// No top-level await: the OpenAPI generator imports this module through contracts.ts under a CommonJS transform.
async function main(): Promise<void> {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source) > 8 * 1024 * 1024) throw new Error("Z5_STDIN_BYTE_BOUND");
  }
  process.stdout.write(JSON.stringify(produce(JSON.parse(source))) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
