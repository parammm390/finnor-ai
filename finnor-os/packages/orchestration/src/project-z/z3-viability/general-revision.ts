/** Identity only. A changed native map, implementation, parent or resource
 * grant still needs a separately admitted relation, never an initial reset. */
import { hash, PROFILE, type OriginalBinding, type PublicArena, type Strategy } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import type { GeneralViabilityCursor, GeneralViabilityFrameCursor,
  RetainedOwnerLineage } from "../../../../private-equity/src/project-z/z3-viability/general-transition";

export interface GeneralViabilityRevisionBridge {
  schema: "finnor.z3.identity-revision-bridge.v2";
  previousSessionId: string; previousBindingDigest: string; currentBindingDigest: string;
  previousArenaDigest: string; strategyDigest: string; mapDigest: string; ownerEvidenceDigest: string;
  cursor: GeneralViabilityCursor; cursorDigest: string;
  rule: "EXACT_ORIGINAL_ARENA_OWNER_MAP_AND_REACHABLE_CHECKED_CURSOR";
  candidateReuseAllowed: false; newAllowance: false;
}
export function originalGeneralViabilityIdentityRefinement(input: {
  previousSessionId: string; previousBinding: OriginalBinding; binding: OriginalBinding;
  previousArena: PublicArena; arena: PublicArena; previousReservation: unknown; reservation: unknown;
  strategy: Strategy; cursor: GeneralViabilityCursor; mapDigest: string; ownerEvidenceDigest: string;
}): GeneralViabilityRevisionBridge {
  const a = input.previousBinding, b = input.binding, cursor = input.cursor;
  if (["tenantId", "principalId", "workId", "originalParentId", "mandateDigest", "observationDigest",
    "resourceDigest", "rightsRevision", "deadlineAt", "codeDigest"].some(key =>
    a[key as keyof OriginalBinding] !== b[key as keyof OriginalBinding])
    || hash(input.previousReservation) !== hash(input.reservation) || hash(input.previousArena) !== hash(input.arena)
    || cursor.mapDigest !== input.mapDigest || cursor.ownerEvidenceDigest !== input.ownerEvidenceDigest
    || cursor.pending !== null || cursor.schema !== "finnor.z3.s4-cursor.v2") {
    throw Error("Z3_GENERAL_NATIVE_SEMANTIC_REVISION_BRIDGE_REQUIRED");
  }
  const arena = input.arena, strategy = input.strategy;
  const states = new Map(arena.states.map((state, index) => [state.id, index]));
  const pending = arena.initial.map((id, i) => ({ state: states.get(id)!, memory: strategy.initial[i]! }));
  const seen = new Set<string>();
  for (let at = 0; at < pending.length; at++) {
    const current = pending[at]!, key = `${current.state}:${current.memory}`;
    if (seen.has(key)) continue;
    if (seen.size >= PROFILE.product || !Number.isSafeInteger(current.memory)
      || current.memory < 0 || current.memory >= strategy.memories.length) throw Error("Z3_GENERAL_BRIDGE_UNCHECKED_MEMORY");
    seen.add(key);
    const state = arena.states[current.state];
    if (!state) throw Error("Z3_GENERAL_BRIDGE_UNCHECKED_STATE");
    const edges = state.owner === "C" ? [strategy.actions[current.memory]?.[current.state] ?? -1]
      : arena.edges.flatMap((edge, i) => edge.from === state.id ? [i] : []);
    const memory = strategy.updates[current.memory]?.[current.state];
    if (!Number.isSafeInteger(memory) || memory === undefined || memory < 0 || memory >= strategy.memories.length) {
      throw Error("Z3_GENERAL_BRIDGE_UNCHECKED_MEMORY");
    }
    for (const index of edges) {
      const edge = arena.edges[index];
      if (!edge || edge.from !== state.id || !states.has(edge.to)) throw Error("Z3_GENERAL_BRIDGE_UNCHECKED_EDGE");
      pending.push({ state: states.get(edge.to)!, memory });
    }
  }
  if (!seen.has(`${states.get(cursor.stateId)}:${cursor.memory}`)) throw Error("Z3_GENERAL_BRIDGE_CURSOR_NOT_REACHABLE");
  return { schema: "finnor.z3.identity-revision-bridge.v2", previousSessionId: input.previousSessionId,
    previousBindingDigest: hash(a), currentBindingDigest: hash(b), previousArenaDigest: hash(input.previousArena),
    strategyDigest: hash(strategy), mapDigest: input.mapDigest, ownerEvidenceDigest: input.ownerEvidenceDigest,
    cursor, cursorDigest: hash(cursor), rule: "EXACT_ORIGINAL_ARENA_OWNER_MAP_AND_REACHABLE_CHECKED_CURSOR",
    candidateReuseAllowed: false, newAllowance: false };
}

export interface GeneralViabilityFrameRevisionBridge extends Omit<GeneralViabilityRevisionBridge, "schema" | "cursor" | "rule"> {
  schema: "finnor.z3.identity-revision-bridge.v3";
  cursor: GeneralViabilityFrameCursor; previousWorkInputId: string;
  pendingLineage: RetainedOwnerLineage | null;
  rule: "EXACT_ORIGINAL_ARENA_OWNER_MAP_REACHABLE_CURSOR_AND_RETAINED_LINEAGE";
}
/** Identity only, for the frame cursor. A pending or retained owner result is
 * carried only when it was produced by the previous session under the exact
 * previous binding and the same Work input. Every v2 identity, reachability and
 * no-allowance check is applied unchanged to the cursor's v2 projection. */
export function originalGeneralViabilityFrameRefinement(input: Omit<Parameters<
  typeof originalGeneralViabilityIdentityRefinement>[0], "cursor"> & { cursor: GeneralViabilityFrameCursor }):
  GeneralViabilityFrameRevisionBridge {
  const a = input.previousBinding, b = input.binding, cursor = input.cursor;
  const exact = (lineage: RetainedOwnerLineage) => lineage.sessionId === input.previousSessionId
    && lineage.bindingDigest === hash(a) && lineage.workId === a.workId && lineage.workInputId === a.workInputId
    && lineage.workInputId === b.workInputId && lineage.mapDigest === input.mapDigest
    && lineage.ownerEvidenceDigest === input.ownerEvidenceDigest;
  if (cursor.schema !== "finnor.z3.s4-cursor.v3" || cursor.pending && !exact(cursor.pending.lineage)
    || cursor.frame && !exact(cursor.frame.lineage)) throw Error("Z3_GENERAL_NATIVE_SEMANTIC_REVISION_BRIDGE_REQUIRED");
  const { frame: _frame, pending: _pending, schema: _schema, ...rest } = cursor;
  void _frame; void _pending; void _schema;
  const base = originalGeneralViabilityIdentityRefinement({ ...input,
    cursor: { ...rest, schema: "finnor.z3.s4-cursor.v2", pending: null } });
  return { ...base, schema: "finnor.z3.identity-revision-bridge.v3", cursor, cursorDigest: hash(cursor),
    previousWorkInputId: a.workInputId, pendingLineage: cursor.pending?.lineage ?? null,
    rule: "EXACT_ORIGINAL_ARENA_OWNER_MAP_REACHABLE_CURSOR_AND_RETAINED_LINEAGE" };
}
