import type { PublicArena, Strategy } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { z3Fault } from "./contracts";

/** The actual S4 state/memory step, also exercised by the offline process E2E.
 * It does not observe, charge, dispatch effects, or establish currentness. */
export function advanceViabilityCursor<T extends { stateId: string; memory: number }>(
  arena: PublicArena, strategy: Strategy, cursor: T, edgeIndex: number,
): T {
  const edge = arena.edges[edgeIndex];
  if (!Number.isSafeInteger(edgeIndex) || !edge || edge.from !== cursor.stateId) {
    z3Fault("Z3_S4_UNMODELLED_ORIGINAL_EDGE");
  }
  // The monitor advances on the source state, independently of edge ordering.
  const stateIndex = arena.states.findIndex(state => state.id === cursor.stateId);
  const memory = strategy.updates[cursor.memory]?.[stateIndex];
  if (!Number.isSafeInteger(memory) || memory === undefined || memory < 0 || memory >= strategy.memories.length) {
    z3Fault("Z3_S4_UNMODELLED_MEMORY_UPDATE");
  }
  return { ...cursor, stateId: edge.to, memory };
}
