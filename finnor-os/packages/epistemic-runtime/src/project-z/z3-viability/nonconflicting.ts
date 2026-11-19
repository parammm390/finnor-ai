import { fault, PROFILE, type PublicArena, type Strategy } from "./contracts";

type Mask = bigint;
interface Budget { tick(n?: number): void; emit(trace: string[], mask: Mask): void }
interface OriginalFixedPoints {
  kernel: Mask; region: Mask; assumptions: Mask[]; goals: Mask[];
  edges: number[][]; n: number; ids: Map<string, number>;
}
interface Choice { a: number; j: number; target: Mask; permitted: Mask }
interface Rank { i: number; earlier: Mask; choices: Choice[] }

/** Vectorized environmentally-friendly GR(1), with the original assumptions
 * ALSO chased as goals. Without that reduction the usual four-fixed-point
 * theorem does not imply nonconflict on general original arenas.
 *
 * Maximum input remains 256 states/8 choices/2 assumptions/2 goals. Every
 * iteration shares the producer's original operation/time/transcript budget.
 * No environment edge is deleted, even on an unfair play.
 */
export function synthesizeNonconflicting(arena: PublicArena, fixed: OriginalFixedPoints, budget: Budget) {
  const { n, ids, kernel, assumptions } = fixed;
  const bits = arena.states.map((_, v) => 1n << BigInt(v));
  const jointGoals = [...new Set([...fixed.goals, ...assumptions])];
  const edgeMasks = fixed.edges.map(row => row.reduce((mask, w) => mask | bits[w]!, 0n));
  const pre = (target: Mask): Mask => {
    let result = 0n;
    for (let v = 0; v < n; v++) {
      budget.tick(fixed.edges[v]!.length + 1);
      if (arena.states[v]!.owner === "C" ? !!(edgeMasks[v]! & target)
        : (edgeMasks[v]! & target) === edgeMasks[v]!) result |= bits[v]!;
    }
    return result;
  };
  const conditionalPre = (target: Mask, escape: Mask): Mask => {
    let result = 0n;
    const permitted = target | escape;
    for (let v = 0; v < n; v++) {
      budget.tick(fixed.edges[v]!.length + 1);
      if ((edgeMasks[v]! & target) && (arena.states[v]!.owner === "C"
        || (edgeMasks[v]! & permitted) === edgeMasks[v]!)) result |= bits[v]!;
    }
    return result;
  };
  const certificate: string[] = [];
  let z = jointGoals.map(() => kernel);
  for (const mask of z) budget.emit(certificate, mask);
  let ranks: Array<Array<Rank | undefined>>;
  for (;;) {
    const nextZ: Mask[] = [];
    const nextRanks: Array<Array<Rank | undefined>> = [];
    for (let g = 0; g < jointGoals.length; g++) {
      const goalReturn = jointGoals[g]! & pre(z[(g + 1) % jointGoals.length]!);
      const ranking: Array<Rank | undefined> = arena.states.map(() => undefined);
      let y = 0n, i = 0;
      budget.emit(certificate, y);
      for (;;) {
        const base = goalReturn | pre(y), finalW: Mask[][] = [];
        let nextY = 0n;
        for (const assumption of assumptions) {
          let x = kernel;
          budget.emit(certificate, x);
          for (;;) {
            let w = 0n;
            const rows: Mask[] = [w];
            budget.emit(certificate, w);
            for (;;) {
              const next = kernel & (base | ((kernel ^ assumption) & conditionalPre(w, x & ~assumption)));
              budget.emit(certificate, next);
              rows.push(next);
              if (next === w) break;
              w = next;
            }
            budget.emit(certificate, w);
            if (w === x) { finalW.push(rows); break; }
            x = w;
          }
          nextY |= x;
        }
        budget.emit(certificate, nextY);
        if (nextY === y) break;
        i++;
        const added = nextY & ~y;
        for (let v = 0; v < n; v++) if (added & bits[v]!) {
          const choices: Choice[] = [];
          for (const [a, rows] of finalW.entries()) {
            const j = rows.findIndex(mask => !!(mask & bits[v]!));
            budget.tick(rows.length + 1);
            if (j > 0) choices.push({ a, j, target: rows[j - 1]!,
              permitted: rows[j - 1]! | (rows[rows.length - 1]! & ~assumptions[a]!) });
          }
          if (!choices.length) fault("Z3_NONCONFLICTING_RANK_MISSING");
          ranking[v] = { i, earlier: y, choices };
        }
        y = nextY;
      }
      nextZ.push(y); nextRanks.push(ranking);
    }
    for (const mask of nextZ) budget.emit(certificate, mask);
    if (nextZ.every((mask, g) => mask === z[g])) { z = nextZ; ranks = nextRanks; break; }
    z = nextZ;
  }
  // All cyclic goal phases describe the same prefix-independent property.
  if (z.some(mask => mask !== z[0]) || (z[0]! & ~fixed.region)) fault("Z3_NONCONFLICTING_REGION_INCONSISTENT");
  const memories: Strategy["memories"] = [];
  for (let b = 0; b < jointGoals.length; b++) memories.push({ a: 0, b });
  if (memories.length > PROFILE.memories || n * memories.length > PROFILE.product) {
    fault("Z3_NONCONFLICTING_PRODUCT_BOUND");
  }
  const outgoing: number[][] = arena.states.map(() => []);
  arena.edges.forEach((edge, index) => outgoing[ids.get(edge.from)!]!.push(index));
  const updates: number[][] = [], actions: number[][] = [];
  for (const { b: g } of memories) {
    const update: number[] = [], action: number[] = [];
    for (let v = 0; v < n; v++) {
      budget.tick(outgoing[v]!.length + 1);
      const state = arena.states[v]!, rank = ranks![g]![v];
      let target = kernel, permitted = kernel, nextG = g;
      if (rank) {
        // Derive the LEAST assumption row from this original state. On a
        // same-Y-layer successor the selected row remains available, so its
        // least index cannot increase. No assumption-mode memory is needed.
        const choice = rank.choices[0]!;
        if (choice.j === 1) {
          if (rank.i === 1) { nextG = (g + 1) % jointGoals.length; target = z[nextG]!; }
          else target = rank.earlier;
          permitted = target;
        } else {
          target = choice.target; permitted = choice.permitted;
        }
        if (state.owner === "E" && (!(edgeMasks[v]! & target)
          || (edgeMasks[v]! & permitted) !== edgeMasks[v]!)) fault("Z3_NONCONFLICTING_ENVIRONMENT_COVERAGE");
      }
      update.push(nextG);
      if (state.owner === "E") action.push(-1);
      else {
        const chosen = rank ? outgoing[v]!.find(edge => !!(target & bits[ids.get(arena.edges[edge]!.to)!]!))
          : outgoing[v]![0];
        if (chosen === undefined) fault("Z3_NONCONFLICTING_ACTION_MISSING");
        action.push(chosen);
      }
    }
    updates.push(update); actions.push(action);
  }
  return { region: z[0]!, certificate,
    strategy: { memories, initial: arena.states.map(() => 0), actions, updates } satisfies Strategy };
}
