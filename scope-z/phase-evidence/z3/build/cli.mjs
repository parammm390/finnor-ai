// finnor-os/scripts/project-z/z3/cli.mts
import { createInterface } from "node:readline";

// finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/contracts.ts
import { createHash } from "node:crypto";
var Z3_VERSION = "z3-public-gr1-v1";
var PROFILE = Object.freeze({
  states: 256,
  outgoing: 8,
  assumptions: 2,
  goals: 2,
  memories: 4,
  product: 1024,
  inputBytes: 1048576,
  artifactBytes: 8388608,
  operations: 4e7,
  iterants: 65536,
  deadlineMs: 1e4
});
var ViabilityFault = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "ViabilityFault";
  }
};
function fault(code) {
  throw new ViabilityFault(code);
}
function canonical(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === void 0) fault("Z3_NON_JSON_VALUE");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
var hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");
function record(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fault("Z3_OBJECT_REQUIRED");
  const r = value;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !Object.hasOwn(r, k))) fault("Z3_EXACT_SCHEMA_REQUIRED");
  return r;
}
function ident(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)) fault("Z3_BOUNDED_PUBLIC_IDENTIFIER_REQUIRED");
  return value;
}
function integer(value, maximum) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fault("Z3_INTEGER_BOUND");
  return value;
}
function list(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fault("Z3_SET_BOUND");
  const result = value.map(ident);
  if (new Set(result).size !== result.length) fault("Z3_DUPLICATE_SET_MEMBER");
  return result;
}
function parseBinding(value) {
  const keys = [
    "tenantId",
    "principalId",
    "workId",
    "workInputId",
    "originalParentId",
    "sourceRevision",
    "rightsRevision",
    "mandateDigest",
    "observationDigest",
    "resourceDigest",
    "deadlineAt",
    "codeDigest"
  ];
  const r = record(value, keys);
  for (const key of keys) if (typeof r[key] !== "string" || !r[key].length || r[key].length > 256) fault("Z3_ORIGINAL_BINDING_REQUIRED");
  return r;
}
function parseArena(value) {
  if (Buffer.byteLength(canonical(value)) > PROFILE.inputBytes) fault("Z3_INPUT_BYTE_BOUND");
  const r = record(value, ["schema", "id", "observationMode", "states", "edges", "initial", "assumptions", "goals", "resources"]);
  if (r.schema !== "finnor.z3.public-arena.v1") fault("Z3_ARENA_VERSION");
  if (r.observationMode !== "PUBLIC_PERFECT_INFORMATION") fault("Z3_PARTIAL_OBSERVATION_UNSUPPORTED");
  ident(r.id);
  if (!Array.isArray(r.states) || !r.states.length || r.states.length > PROFILE.states) fault("Z3_STATE_BOUND");
  const states = r.states.map((value2) => {
    const s = record(value2, ["id", "owner", "observation", "safe", "remaining", "unknown"]);
    ident(s.id);
    ident(s.observation);
    if (!["C", "E"].includes(s.owner) || typeof s.safe !== "boolean") fault("Z3_STATE_SEMANTICS");
    integer(s.remaining, 1e9);
    list(s.unknown, PROFILE.states);
    return s;
  });
  const ids = new Set(states.map((s) => s.id));
  if (ids.size !== states.length || new Set(states.map((s) => s.observation)).size !== states.length) fault("Z3_PARTIAL_OBSERVATION_UNSUPPORTED");
  const resources = record(r.resources, ["capacity", "maximum", "obligationIds", "renewalRefs", "settlementRefs", "unknownOccupiesCapacity"]);
  integer(resources.capacity, PROFILE.states);
  integer(resources.maximum, 1e9);
  const obligations = list(resources.obligationIds, PROFILE.states), renewals = list(resources.renewalRefs, PROFILE.states), settlements = list(resources.settlementRefs, PROFILE.states);
  if (resources.unknownOccupiesCapacity !== true) fault("Z3_UNKNOWN_CANNOT_RELEASE_CAPACITY");
  for (const state of states) if (state.remaining > resources.maximum || state.unknown.some((id) => !obligations.includes(id)) || state.safe && state.unknown.length > resources.capacity) fault("Z3_ORIGINAL_RESOURCE_STATE");
  if (!Array.isArray(r.edges) || r.edges.length > PROFILE.states * PROFILE.outgoing) fault("Z3_EDGE_BOUND");
  const counts = /* @__PURE__ */ new Map(), actions = /* @__PURE__ */ new Set();
  for (const value2 of r.edges) {
    const edge = record(value2, ["from", "to", "action", "renewalRef", "settlementRef"]);
    const from = ident(edge.from), to = ident(edge.to), action = ident(edge.action);
    if (!ids.has(from) || !ids.has(to)) fault("Z3_ORIGINAL_EDGE_COVERAGE");
    const key = JSON.stringify([from, action]);
    if (actions.has(key)) fault("Z3_AMBIGUOUS_ACTION");
    actions.add(key);
    counts.set(from, (counts.get(from) ?? 0) + 1);
    if (counts.get(from) > PROFILE.outgoing) fault("Z3_OUTGOING_BOUND");
    if (edge.renewalRef !== null && !renewals.includes(ident(edge.renewalRef))) fault("Z3_UNADMITTED_RENEWAL");
    if (edge.settlementRef !== null && !settlements.includes(ident(edge.settlementRef))) fault("Z3_UNADMITTED_SETTLEMENT");
    const a = states.find((s) => s.id === from), b = states.find((s) => s.id === to);
    if (b.remaining > a.remaining && edge.renewalRef === null) fault("Z3_INVENTED_RESOURCE_RENEWAL");
    if (a.unknown.some((id) => !b.unknown.includes(id)) && edge.settlementRef === null) fault("Z3_UNKNOWN_ERASED_WITHOUT_S6");
  }
  if (states.some((s) => !counts.has(s.id))) fault("Z3_EXPLICIT_TOTALIZATION_REQUIRED");
  const initial = list(r.initial, PROFILE.states);
  if (!initial.length || initial.some((id) => !ids.has(id))) fault("Z3_ORIGINAL_INITIAL_COVERAGE");
  for (const key of ["assumptions", "goals"]) {
    if (!Array.isArray(r[key]) || r[key].length > 2) fault("Z3_JUSTICE_BOUND");
    for (const values of r[key]) if (list(values, PROFILE.states).some((id) => !ids.has(id))) fault("Z3_JUSTICE_COVERAGE");
  }
  return r;
}
function parseLimits(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !["maxOperations", "deadlineMs", "maxIterants"].includes(k))) fault("Z3_LIMIT_SCHEMA");
  const result = {
    maxOperations: value.maxOperations ?? PROFILE.operations,
    deadlineMs: value.deadlineMs ?? PROFILE.deadlineMs,
    maxIterants: value.maxIterants ?? PROFILE.iterants
  };
  for (const [key, limit] of Object.entries({ maxOperations: PROFILE.operations, deadlineMs: PROFILE.deadlineMs, maxIterants: PROFILE.iterants })) {
    integer(result[key], limit);
    if (result[key] < 1) fault("Z3_POSITIVE_LIMIT_REQUIRED");
  }
  return result;
}

// finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/producer.ts
var Budget = class {
  constructor(limits) {
    this.limits = limits;
  }
  operations = 0;
  iterants = 0;
  started = performance.now();
  tick(n = 1) {
    this.operations += n;
    if (this.operations > this.limits.maxOperations || performance.now() - this.started > this.limits.deadlineMs) fault("Z3_FINITE_SOLVER_BUDGET_EXHAUSTED");
  }
  emit(trace, mask) {
    this.tick();
    if (++this.iterants > this.limits.maxIterants) fault("Z3_COMPLETE_TRANSCRIPT_BOUND");
    trace.push(mask.toString(16));
  }
};
var bit = (v) => 1n << BigInt(v);
function members(mask, n) {
  return Array.from({ length: n }, (_, i) => i).filter((i) => (mask & bit(i)) !== 0n);
}
function fixedPoints(arena, budget) {
  const n = arena.states.length, universe = (1n << BigInt(n)) - 1n;
  const ids = new Map(arena.states.map((s, i) => [s.id, i]));
  const edges = arena.states.map(() => []);
  arena.edges.forEach((e) => edges[ids.get(e.from)].push(ids.get(e.to)));
  const pre = (target) => {
    let result = 0n;
    for (let v = 0; v < n; v++) {
      budget.tick(edges[v].length + 1);
      const found = arena.states[v].owner === "C" ? edges[v].some((w) => !!(target & bit(w))) : edges[v].every((w) => !!(target & bit(w)));
      if (found) result |= bit(v);
    }
    return result;
  };
  const safety = [], gr1 = [];
  const safe = arena.states.reduce((mask, s, i) => s.safe ? mask | bit(i) : mask, 0n);
  let kernel = universe;
  budget.emit(safety, kernel);
  for (; ; ) {
    const next = safe & pre(kernel);
    budget.emit(safety, next);
    if (next === kernel) break;
    kernel = next;
  }
  const sets = (values) => values.length ? values.map((row) => row.reduce((mask, id) => mask | bit(ids.get(id)), 0n)) : [universe];
  const assumptions = sets(arena.assumptions), goals = sets(arena.goals);
  let z = kernel;
  budget.emit(gr1, z);
  for (; ; ) {
    let nextZ = kernel;
    for (const goal of goals) {
      let y = 0n;
      budget.emit(gr1, y);
      for (; ; ) {
        let nextY = 0n;
        const base = goal & pre(z) | pre(y);
        for (const assumption of assumptions) {
          let x = kernel;
          budget.emit(gr1, x);
          for (; ; ) {
            const next = kernel & (base | (universe ^ assumption) & pre(x));
            budget.emit(gr1, next);
            if (next === x) break;
            x = next;
          }
          nextY |= x;
        }
        budget.emit(gr1, nextY);
        if (nextY === y) break;
        y = nextY;
      }
      nextZ &= y;
    }
    budget.emit(gr1, nextZ);
    if (nextZ === z) break;
    z = nextZ;
  }
  return { kernel, region: z, safety, gr1, assumptions, goals, edges, n, ids };
}
function parity(owner, priority, edges, vertices, budget) {
  if (!vertices.size) return { wins: [/* @__PURE__ */ new Set(), /* @__PURE__ */ new Set()], moves: [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()] };
  budget.tick(vertices.size);
  const p = Math.max(...[...vertices].map((v) => priority[v])), player = p % 2, opponent = 1 - player;
  const attract = (who, targets) => {
    const set = new Set(targets), moves = /* @__PURE__ */ new Map();
    for (; ; ) {
      let changed = false;
      for (const v of vertices) {
        if (set.has(v)) continue;
        const successors = edges[v].filter((w) => vertices.has(w));
        budget.tick(edges[v].length + 1);
        if (!successors.length) fault("Z3_PARITY_SUBGAME_NOT_TOTAL");
        const chosen = successors.find((w) => set.has(w));
        if (owner[v] === who ? chosen !== void 0 : successors.every((w) => set.has(w))) {
          set.add(v);
          changed = true;
          if (owner[v] === who) moves.set(v, chosen);
        }
      }
      if (!changed) return { set, moves };
    }
  };
  const top = new Set([...vertices].filter((v) => priority[v] === p));
  const a = attract(player, top);
  const first = parity(owner, priority, edges, new Set([...vertices].filter((v) => !a.set.has(v))), budget);
  if (!first.wins[opponent].size) {
    const moves = first.moves[player];
    for (const [v, w] of a.moves) moves.set(v, w);
    for (const v of top) if (owner[v] === player && !moves.has(v)) {
      const target = edges[v].find((w) => vertices.has(w));
      if (target === void 0) fault("Z3_PARITY_TARGET_NOT_TOTAL");
      moves.set(v, target);
    }
    first.wins[player] = new Set(vertices);
    first.moves[player] = moves;
    return first;
  }
  const b = attract(opponent, first.wins[opponent]);
  const second = parity(owner, priority, edges, new Set([...vertices].filter((v) => !b.set.has(v))), budget);
  for (const v of b.set) second.wins[opponent].add(v);
  for (const [v, w] of first.moves[opponent]) if (first.wins[opponent].has(v)) second.moves[opponent].set(v, w);
  for (const [v, w] of b.moves) second.moves[opponent].set(v, w);
  return second;
}
function extract(arena, fixed, budget) {
  const { assumptions, goals, n, ids, kernel, region } = fixed;
  const memories = [];
  for (let a = 0; a < assumptions.length; a++) for (let b = 0; b < goals.length; b++) memories.push({ a, b });
  const size = n * memories.length;
  if (size > PROFILE.product) fault("Z3_STRATEGY_PRODUCT_BOUND");
  const owner = [], priority = [], edges = [], vertices = /* @__PURE__ */ new Set();
  const updates = memories.map(() => []);
  for (const [m, { a, b }] of memories.entries()) for (let v = 0; v < n; v++) {
    const assumption = !!(assumptions[a] & bit(v)), goal = !!(goals[b] & bit(v));
    const nextA = assumption ? (a + 1) % assumptions.length : a;
    const nextB = goal ? (b + 1) % goals.length : b;
    const mm = nextA * goals.length + nextB;
    updates[m][v] = mm;
    const index = m * n + v;
    owner[index] = arena.states[v].owner === "C" ? 0 : 1;
    priority[index] = goal && b === goals.length - 1 ? 2 : assumption && a === assumptions.length - 1 ? 1 : 0;
    edges[index] = fixed.edges[v].filter((w) => !!(kernel & bit(w))).map((w) => mm * n + w);
    if (kernel & bit(v)) vertices.add(index);
  }
  const solved = parity(owner, priority, edges, vertices, budget);
  for (let m = 0; m < memories.length; m++) for (let v = 0; v < n; v++) {
    if (solved.wins[0].has(m * n + v) !== !!(region & bit(v))) fault("Z3_PARITY_AND_GR1_REGION_DISAGREE");
  }
  const actions = memories.map((_, m) => arena.states.map((state, v) => {
    if (state.owner === "E") return -1;
    const chosen = solved.moves[0].get(m * n + v);
    const index = arena.edges.findIndex((e) => e.from === state.id && (chosen === void 0 || ids.get(e.to) === chosen % n));
    if (index < 0) fault("Z3_ACTION_EXTRACTION_INCOMPLETE");
    if (region & bit(v) && chosen === void 0) fault("Z3_WINNING_ACTION_MISSING");
    return index;
  }));
  return { memories, initial: arena.states.map(() => 0), actions, updates };
}
function produceViability(rawArena, rawBinding, rawLimits = {}) {
  const start = performance.now();
  let arena, binding, budget;
  try {
    arena = parseArena(rawArena);
    binding = parseBinding(rawBinding);
    budget = new Budget(parseLimits(rawLimits));
    const fixed = fixedPoints(arena, budget), strategy = extract(arena, fixed, budget);
    const region = members(fixed.region, fixed.n);
    const candidate = {
      schema: "finnor.z3.viability-candidate.v1",
      version: Z3_VERSION,
      disposition: "COMPLETE",
      arenaDigest: hash(arena),
      bindingDigest: hash(binding),
      safetyKernel: members(fixed.kernel, fixed.n),
      winningRegion: region,
      certificate: { safety: fixed.safety, gr1: fixed.gr1 },
      strategy,
      ordinaryStatus: arena.initial.every((id) => region.includes(fixed.ids.get(id))) ? "WINNING" : "UNREALIZABLE",
      completeness: "COMPLETE_ORDINARY_REGION_NOT_COMPLETE_NONCONFLICTING_SYNTHESIS",
      metrics: {
        wallMs: performance.now() - start,
        operations: budget.operations,
        iterants: budget.iterants,
        productVertices: fixed.n * strategy.memories.length
      }
    };
    if (Buffer.byteLength(canonical(candidate)) > PROFILE.artifactBytes) fault("Z3_COMPLETE_ARTIFACT_BYTE_BOUND");
    return candidate;
  } catch (error) {
    if (!(error instanceof ViabilityFault)) throw error;
    const safeDigest = (value) => {
      try {
        return hash(value);
      } catch {
        return null;
      }
    };
    return {
      schema: "finnor.z3.viability-candidate.v1",
      version: Z3_VERSION,
      disposition: budget ? "UNKNOWN" : "UNSUPPORTED",
      arenaDigest: safeDigest(rawArena),
      bindingDigest: safeDigest(rawBinding),
      reason: error.code,
      certificate: null,
      strategy: null,
      metrics: { wallMs: performance.now() - start, operations: budget?.operations ?? 0 }
    };
  }
}

// finnor-os/scripts/project-z/z3/cli.mts
if (process.argv[2] !== "produce-batch") throw Error("Expected produce-batch with bounded NDJSON original inputs");
var unsupported = (reason) => JSON.stringify({
  schema: "finnor.z3.viability-candidate.v1",
  version: Z3_VERSION,
  disposition: "UNSUPPORTED",
  arenaDigest: null,
  bindingDigest: null,
  reason,
  certificate: null,
  strategy: null,
  metrics: { wallMs: 0, operations: 0 }
});
var count = 0;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (++count > 8192) throw Error("Z3_FINITE_CLI_INPUT_BOUND");
  if (Buffer.byteLength(line) > PROFILE.inputBytes) {
    process.stdout.write(unsupported("Z3_FINITE_CLI_INPUT_BOUND") + "\n");
    continue;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(unsupported("Z3_CLI_MALFORMED_NDJSON") + "\n");
    continue;
  }
  process.stdout.write(JSON.stringify(produceViability(request?.arena, request?.binding, request?.limits ?? {})) + "\n");
}
