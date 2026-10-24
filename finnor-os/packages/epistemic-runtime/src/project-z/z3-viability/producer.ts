import { canonical, fault, hash, parseArena, parseBinding, parseLimits, PROFILE, ViabilityFault, Z3_VERSION,
  type Candidate, type CompleteCandidate, type OriginalBinding, type PublicArena, type SolverLimits, type Strategy } from "./contracts";

type Mask = bigint;
class Budget {
  operations = 0; iterants = 0;
  readonly started = performance.now();
  constructor(readonly limits: Required<SolverLimits>) {}
  tick(n = 1): void {
    this.operations += n;
    if (this.operations > this.limits.maxOperations || performance.now() - this.started > this.limits.deadlineMs) fault("Z3_FINITE_SOLVER_BUDGET_EXHAUSTED");
  }
  emit(trace: string[], mask: Mask): void {
    this.tick();
    if (++this.iterants > this.limits.maxIterants) fault("Z3_COMPLETE_TRANSCRIPT_BOUND");
    trace.push(mask.toString(16));
  }
}
const bit = (v: number) => 1n << BigInt(v);
function members(mask: Mask, n: number): number[] { return Array.from({ length: n }, (_, i) => i).filter(i => (mask & bit(i)) !== 0n); }

function fixedPoints(arena: PublicArena, budget: Budget) {
  const n = arena.states.length, universe = (1n << BigInt(n)) - 1n;
  const ids = new Map(arena.states.map((s, i) => [s.id, i]));
  const edges: number[][] = arena.states.map(() => []);
  arena.edges.forEach(e => edges[ids.get(e.from)!]!.push(ids.get(e.to)!));
  const pre = (target: Mask): Mask => {
    let result = 0n;
    for (let v = 0; v < n; v++) {
      budget.tick(edges[v]!.length + 1);
      const found = arena.states[v]!.owner === "C"
        ? edges[v]!.some(w => !!(target & bit(w))) : edges[v]!.every(w => !!(target & bit(w)));
      if (found) result |= bit(v);
    }
    return result;
  };
  const safety: string[] = [], gr1: string[] = [];
  const safe = arena.states.reduce((mask, s, i) => s.safe ? mask | bit(i) : mask, 0n);
  let kernel = universe; budget.emit(safety, kernel);
  for (;;) {
    const next = safe & pre(kernel); budget.emit(safety, next);
    if (next === kernel) break;
    kernel = next;
  }
  const sets = (values: string[][]): Mask[] => values.length
    ? values.map(row => row.reduce((mask, id) => mask | bit(ids.get(id)!), 0n)) : [universe];
  const assumptions = sets(arena.assumptions), goals = sets(arena.goals);
  let z = kernel; budget.emit(gr1, z);
  for (;;) {
    let nextZ = kernel;
    for (const goal of goals) {
      let y = 0n; budget.emit(gr1, y);
      for (;;) {
        let nextY = 0n;
        const base = (goal & pre(z)) | pre(y);
        for (const assumption of assumptions) {
          let x = kernel; budget.emit(gr1, x);
          for (;;) {
            const next = kernel & (base | ((universe ^ assumption) & pre(x)));
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

interface ParityResult { wins: [Set<number>, Set<number>]; moves: [Map<number, number>, Map<number, number>] }
/** Maximum-parity Zielonka recursion. Complement subgames retain all adversary
 * moves; the attractor removes only vertices in the mathematically defined set. */
function parity(owner: number[], priority: number[], edges: number[][], vertices: Set<number>, budget: Budget): ParityResult {
  if (!vertices.size) return { wins: [new Set(), new Set()], moves: [new Map(), new Map()] };
  budget.tick(vertices.size);
  const p = Math.max(...[...vertices].map(v => priority[v]!)), player = p % 2, opponent = 1 - player;
  const attract = (who: number, targets: Set<number>) => {
    const set = new Set(targets), moves = new Map<number, number>();
    for (;;) {
      let changed = false;
      for (const v of vertices) {
        if (set.has(v)) continue;
        const successors = edges[v]!.filter(w => vertices.has(w));
        budget.tick(edges[v]!.length + 1);
        if (!successors.length) fault("Z3_PARITY_SUBGAME_NOT_TOTAL");
        const chosen = successors.find(w => set.has(w));
        if (owner[v] === who ? chosen !== undefined : successors.every(w => set.has(w))) {
          set.add(v); changed = true;
          if (owner[v] === who) moves.set(v, chosen!);
        }
      }
      if (!changed) return { set, moves };
    }
  };
  const top = new Set([...vertices].filter(v => priority[v] === p));
  const a = attract(player, top);
  const first = parity(owner, priority, edges, new Set([...vertices].filter(v => !a.set.has(v))), budget);
  if (!first.wins[opponent]!.size) {
    const moves = first.moves[player]!;
    for (const [v, w] of a.moves) moves.set(v, w);
    for (const v of top) if (owner[v] === player && !moves.has(v)) {
      const target = edges[v]!.find(w => vertices.has(w));
      if (target === undefined) fault("Z3_PARITY_TARGET_NOT_TOTAL");
      moves.set(v, target);
    }
    first.wins[player] = new Set(vertices); first.moves[player] = moves;
    return first;
  }
  const b = attract(opponent, first.wins[opponent]!);
  const second = parity(owner, priority, edges, new Set([...vertices].filter(v => !b.set.has(v))), budget);
  for (const v of b.set) second.wins[opponent]!.add(v);
  for (const [v, w] of first.moves[opponent]!) if (first.wins[opponent]!.has(v)) second.moves[opponent]!.set(v, w);
  for (const [v, w] of b.moves) second.moves[opponent]!.set(v, w);
  return second;
}

function extract(arena: PublicArena, fixed: ReturnType<typeof fixedPoints>, budget: Budget): Strategy {
  const { assumptions, goals, n, ids, kernel, region } = fixed;
  const memories: Strategy["memories"] = [];
  for (let a = 0; a < assumptions.length; a++) for (let b = 0; b < goals.length; b++) memories.push({ a, b });
  const size = n * memories.length;
  if (size > PROFILE.product) fault("Z3_STRATEGY_PRODUCT_BOUND");
  const owner: number[] = [], priority: number[] = [], edges: number[][] = [], vertices = new Set<number>();
  const updates: number[][] = memories.map(() => []);
  for (const [m, { a, b }] of memories.entries()) for (let v = 0; v < n; v++) {
    const assumption = !!(assumptions[a]! & bit(v)), goal = !!(goals[b]! & bit(v));
    const nextA = assumption ? (a + 1) % assumptions.length : a;
    const nextB = goal ? (b + 1) % goals.length : b;
    const mm = nextA * goals.length + nextB;
    updates[m]![v] = mm;
    const index = m * n + v;
    owner[index] = arena.states[v]!.owner === "C" ? 0 : 1;
    priority[index] = goal && b === goals.length - 1 ? 2 : assumption && a === assumptions.length - 1 ? 1 : 0;
    edges[index] = fixed.edges[v]!.filter(w => !!(kernel & bit(w))).map(w => mm * n + w);
    if (kernel & bit(v)) vertices.add(index);
  }
  const solved = parity(owner, priority, edges, vertices, budget);
  for (let m = 0; m < memories.length; m++) for (let v = 0; v < n; v++) {
    if (solved.wins[0].has(m * n + v) !== !!(region & bit(v))) fault("Z3_PARITY_AND_GR1_REGION_DISAGREE");
  }
  const actions = memories.map((_, m) => arena.states.map((state, v) => {
    if (state.owner === "E") return -1;
    const chosen = solved.moves[0].get(m * n + v);
    const index = arena.edges.findIndex(e => e.from === state.id
      && (chosen === undefined || ids.get(e.to) === chosen % n));
    if (index < 0) fault("Z3_ACTION_EXTRACTION_INCOMPLETE");
    if (region & bit(v) && chosen === undefined) fault("Z3_WINNING_ACTION_MISSING");
    return index;
  }));
  return { memories, initial: arena.states.map(() => 0), actions, updates };
}

export function produceViability(rawArena: unknown, rawBinding: unknown, rawLimits: SolverLimits = {}): Candidate {
  const start = performance.now();
  let arena: PublicArena, binding: OriginalBinding, budget: Budget | undefined;
  try {
    arena = parseArena(rawArena); binding = parseBinding(rawBinding);
    budget = new Budget(parseLimits(rawLimits));
    const fixed = fixedPoints(arena, budget), strategy = extract(arena, fixed, budget);
    const region = members(fixed.region, fixed.n);
    const candidate: CompleteCandidate = {
      schema: "finnor.z3.viability-candidate.v1", version: Z3_VERSION, disposition: "COMPLETE",
      arenaDigest: hash(arena), bindingDigest: hash(binding),
      safetyKernel: members(fixed.kernel, fixed.n), winningRegion: region,
      certificate: { safety: fixed.safety, gr1: fixed.gr1 }, strategy,
      ordinaryStatus: arena.initial.every(id => region.includes(fixed.ids.get(id)!)) ? "WINNING" : "UNREALIZABLE",
      completeness: "COMPLETE_ORDINARY_REGION_NOT_COMPLETE_NONCONFLICTING_SYNTHESIS",
      metrics: { wallMs: performance.now() - start, operations: budget.operations, iterants: budget.iterants,
        productVertices: fixed.n * strategy.memories.length },
    };
    if (Buffer.byteLength(canonical(candidate)) > PROFILE.artifactBytes) fault("Z3_COMPLETE_ARTIFACT_BYTE_BOUND");
    return candidate;
  } catch (error) {
    if (!(error instanceof ViabilityFault)) throw error;
    // The error path must itself be total: undigestible raw input yields a
    // null identity, never a second escape from the failure record.
    const safeDigest = (value: unknown): string | null => { try { return hash(value); } catch { return null; } };
    return { schema: "finnor.z3.viability-candidate.v1", version: Z3_VERSION,
      disposition: budget ? "UNKNOWN" : "UNSUPPORTED", arenaDigest: safeDigest(rawArena), bindingDigest: safeDigest(rawBinding),
      reason: error.code, certificate: null, strategy: null,
      metrics: { wallMs: performance.now() - start, operations: budget?.operations ?? 0 } };
  }
}
