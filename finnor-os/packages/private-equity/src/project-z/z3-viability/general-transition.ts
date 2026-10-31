import type { ExperimentRef } from "@finnor/shared-types";
import type { Strategy } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { hash, z3Fault } from "./contracts";
import { nativeStateMatches, selectNativeInitial, type GeneralNativeModel,
  type NativeObservation, type NativeResourceObservation } from "./general-model";
import { advanceViabilityCursor } from "./transition";

export interface GeneralViabilityCursor {
  schema: "finnor.z3.s4-cursor.v2";
  candidateDigest: string; checkDigest: string; bindingDigest: string;
  mapDigest: string; ownerEvidenceDigest: string;
  stateId: string; memory: number; operations: number; transitions: number;
  goalVisits: Record<string, number>;
  initialSelection: { stateId: string; initialIndex: number; evidenceDigest: string };
  pending: { receiptRef: ExperimentRef; observationDigest: string } | null;
}
export interface NativeSettlementEvidence { alias: string; obligationId: string; receiptRef: ExperimentRef }
export const GENERAL_NATIVE_MAPPING_FAILURES = [
  "Z3_NATIVE_ACTUAL_INITIAL_AMBIGUOUS", "Z3_NATIVE_ACTUAL_INITIAL_UNMODELLED",
  "Z3_NATIVE_ACTUAL_E_OUTCOME_AMBIGUOUS", "Z3_NATIVE_ACTUAL_E_OUTCOME_UNMODELLED",
  "Z3_NATIVE_ACTUAL_SOURCE_STATE_CHANGED", "Z3_NATIVE_ACTUAL_SUCCESSOR_UNMODELLED",
  "Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED", "Z3_NATIVE_OWNER_BINDING_CHANGED",
  "Z3_NATIVE_MAPPING_FALSIFIED_REQUIRES_ADMITTED_REVISION",
] as const;
export const isGeneralNativeMappingFailure = (code: string): boolean =>
  (GENERAL_NATIVE_MAPPING_FAILURES as readonly string[]).includes(code);

/** Consuming a returned owner result makes that same result current knowledge.
 * This changes only the observed protocol phase, never its source, values,
 * receipt or resource state. Its qualification explicitly records the derived
 * view, not a fresh external read. */
export function consumedOwnerObservation<T extends NativeObservation>(model: GeneralNativeModel,
  edgeIndex: number, observation: T): T {
  const edge = model.arena.edges[edgeIndex];
  if (!edge) z3Fault("Z3_S4_UNMODELLED_ORIGINAL_EDGE");
  return model.arena.states.find(s => s.id === edge.to)?.owner === "C" && observation.facts.$view === "OPERATION_RETURNED"
    ? { ...observation, facts: { ...observation.facts, $view: "CONTEXT" },
      qualification: `DERIVED_CONSUMED_OWNER_RESULT_NOT_NEW_READ:${observation.qualification}` } : observation;
}

export function initialGeneralCursor(model: GeneralNativeModel, strategy: Strategy,
  observations: readonly NativeObservation[], resources: NativeResourceObservation,
  identity: Pick<GeneralViabilityCursor, "candidateDigest" | "checkDigest" | "bindingDigest" | "ownerEvidenceDigest">): GeneralViabilityCursor {
  const initial = selectNativeInitial(model, observations, resources);
  const memory = strategy.initial[initial.initialIndex];
  if (!Number.isSafeInteger(memory) || memory === undefined || memory < 0 || memory >= strategy.memories.length) {
    z3Fault("Z3_NATIVE_ACTUAL_INITIAL_MEMORY_UNCOVERED");
  }
  return { schema: "finnor.z3.s4-cursor.v2", ...identity, mapDigest: model.mapDigest,
    stateId: initial.stateId, memory, operations: 0, transitions: 0,
    goalVisits: Object.fromEntries(model.arena.goals.map((_, i) => [`GOAL:${i}`, 0])),
    initialSelection: { ...initial, evidenceDigest: hash({ observations, resources }) }, pending: null };
}
export function assertGeneralCursor(model: GeneralNativeModel, strategy: Strategy, cursor: GeneralViabilityCursor,
  digest: string, identity: Pick<GeneralViabilityCursor, "candidateDigest" | "checkDigest" | "bindingDigest" | "ownerEvidenceDigest">) {
  if (cursor.schema !== "finnor.z3.s4-cursor.v2" || hash(cursor) !== digest
    || Object.entries(identity).some(([key, value]) => cursor[key as keyof GeneralViabilityCursor] !== value)
    || cursor.mapDigest !== model.mapDigest || !model.arena.states.some(s => s.id === cursor.stateId)
    || !Number.isSafeInteger(cursor.memory) || cursor.memory < 0 || cursor.memory >= strategy.memories.length
    || !Number.isSafeInteger(cursor.operations) || cursor.operations < 0
    || !Number.isSafeInteger(cursor.transitions) || cursor.transitions < cursor.operations
    || !Number.isSafeInteger(cursor.initialSelection.initialIndex)
    || model.arena.initial[cursor.initialSelection.initialIndex] !== cursor.initialSelection.stateId
    || Object.keys(cursor.goalVisits).length !== model.arena.goals.length
    || model.arena.goals.some((_, i) => !Number.isSafeInteger(cursor.goalVisits[`GOAL:${i}`])
      || cursor.goalVisits[`GOAL:${i}`]! < 0)) z3Fault("Z3_S4_CURSOR_PREIMAGE_CHANGED");
}
export function assertNativeResourceStep(model: GeneralNativeModel, edgeIndex: number,
  settlements: readonly NativeSettlementEvidence[]) {
  const edge = model.arena.edges[edgeIndex];
  if (!edge) z3Fault("Z3_S4_UNMODELLED_ORIGINAL_EDGE");
  const from = model.arena.states.find(s => s.id === edge.from)!;
  const to = model.arena.states.find(s => s.id === edge.to)!;
  if (to.remaining > from.remaining) z3Fault("Z3_S5_ORIGINAL_RENEWAL_RECEIPT_REPRESENTATION_REQUIRED");
  for (const obligationId of from.unknown.filter(id => !to.unknown.includes(id))) {
    if (!edge.settlementRef || !settlements.some(receipt => receipt.alias === edge.settlementRef
      && receipt.obligationId === obligationId && receipt.receiptRef.owner === "S6")) {
      z3Fault("Z3_NATIVE_ACTUAL_S6_SETTLEMENT_REQUIRED");
    }
  }
}
export function advanceGeneralCursor(model: GeneralNativeModel, strategy: Strategy, cursor: GeneralViabilityCursor,
  edgeIndex: number, observation: NativeObservation, resources: NativeResourceObservation,
  settlements: readonly NativeSettlementEvidence[]): GeneralViabilityCursor {
  const stateIndex = model.arena.states.findIndex(s => s.id === cursor.stateId);
  const state = model.arena.states[stateIndex];
  if (!state || state.owner === "C" && strategy.actions[cursor.memory]?.[stateIndex] !== edgeIndex) {
    z3Fault("Z3_S4_ACTION_NOT_COVERED");
  }
  assertNativeResourceStep(model, edgeIndex, settlements);
  const next = advanceViabilityCursor(model.arena, strategy, cursor, edgeIndex);
  if (!nativeStateMatches(model, next.stateId, [observation], resources)) z3Fault("Z3_NATIVE_ACTUAL_SUCCESSOR_UNMODELLED");
  return { ...next, transitions: cursor.transitions + 1,
    operations: cursor.operations + (state.owner === "C" ? 1 : 0),
    goalVisits: Object.fromEntries(model.arena.goals.map((goal, i) => {
      const key = `GOAL:${i}`;
      return [key, cursor.goalVisits[key]! + (goal.includes(next.stateId) ? 1 : 0)];
    })) };
}
