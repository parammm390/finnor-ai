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
  // A LAST_OWNER_RESULT target keeps the returned result itself as retained
  // knowledge instead of letting a later context read replace it.
  if (model.original.observations.find(row => row.stateId === edge.to)?.knowledge === "LAST_OWNER_RESULT") {
    return { ...observation, knowledge: "RETURNED_OWNER_RESULT",
      qualification: `RETAINED_OWNER_RESULT_NOT_NEW_READ:${observation.qualification}` };
  }
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
  edgeIndex: number, observation: NativeObservation | readonly NativeObservation[], resources: NativeResourceObservation,
  settlements: readonly NativeSettlementEvidence[]): GeneralViabilityCursor {
  const frame: readonly NativeObservation[] = Array.isArray(observation) ? observation : [observation as NativeObservation];
  const stateIndex = model.arena.states.findIndex(s => s.id === cursor.stateId);
  const state = model.arena.states[stateIndex];
  if (!state || state.owner === "C" && strategy.actions[cursor.memory]?.[stateIndex] !== edgeIndex) {
    z3Fault("Z3_S4_ACTION_NOT_COVERED");
  }
  assertNativeResourceStep(model, edgeIndex, settlements);
  const next = advanceViabilityCursor(model.arena, strategy, cursor, edgeIndex);
  if (!nativeStateMatches(model, next.stateId, frame, resources)) z3Fault("Z3_NATIVE_ACTUAL_SUCCESSOR_UNMODELLED");
  return { ...next, transitions: cursor.transitions + 1,
    operations: cursor.operations + (state.owner === "C" ? 1 : 0),
    goalVisits: Object.fromEntries(model.arena.goals.map((goal, i) => {
      const key = `GOAL:${i}`;
      return [key, cursor.goalVisits[key]! + (goal.includes(next.stateId) ? 1 : 0)];
    })) };
}
/** Separately versioned cursor that also persists the observed owner frame of
 * its current state. The v2 cursor above keeps its exact meaning and validator. */
export const GENERAL_FRAME_CURSOR = "finnor.z3.s4-cursor.v3" as const;
export interface RetainedOwnerLineage {
  sessionId: string; workId: string; workInputId: string; bindingDigest: string;
  mapDigest: string; ownerEvidenceDigest: string;
}
export type RetainedOwnerObservation = NativeObservation & { receiptRef: ExperimentRef };
export interface RetainedOwnerFrame {
  stateId: string; lineage: RetainedOwnerLineage; observations: RetainedOwnerObservation[]; digest: string;
}
export interface GeneralViabilityFrameCursor extends Omit<GeneralViabilityCursor, "schema" | "pending"> {
  schema: typeof GENERAL_FRAME_CURSOR;
  frame: RetainedOwnerFrame | null;
  pending: { receiptRef: ExperimentRef; observationDigest: string; lineage: RetainedOwnerLineage } | null;
}
export interface RetainedLineageBridge {
  previousSessionId: string; previousBindingDigest: string; currentBindingDigest: string;
}
export type RetainedOwnerSource =
  | { source: "CURRENT_OWNERS" }
  | { source: "RETAINED_FRAME"; observations: RetainedOwnerObservation[] };
type CursorIdentity = Pick<GeneralViabilityCursor, "candidateDigest" | "checkDigest" | "bindingDigest" | "ownerEvidenceDigest">;

const LINEAGE_KEYS = ["sessionId", "workId", "workInputId", "bindingDigest", "mapDigest", "ownerEvidenceDigest"] as const;
const BRIDGED_LINEAGE_KEYS = ["workId", "workInputId", "mapDigest", "ownerEvidenceDigest"] as const;
const frameDigest = (frame: Pick<RetainedOwnerFrame, "stateId" | "lineage" | "observations">) =>
  hash({ stateId: frame.stateId, lineage: frame.lineage, observations: frame.observations });

export function retainOwnerFrame(stateId: string, observations: readonly RetainedOwnerObservation[],
  lineage: RetainedOwnerLineage): RetainedOwnerFrame {
  const body = { stateId, lineage, observations: [...observations] };
  return { ...body, digest: frameDigest(body) };
}
/** A retained owner result is usable only by the exact Work, input and session
 * that produced it, or across an identity bridge from that same session and
 * binding. A receipt scope, reset or copied claim never establishes lineage. */
export function assertRetainedOwnerLineage(lineage: RetainedOwnerLineage, current: RetainedOwnerLineage,
  bridge: RetainedLineageBridge | null): void {
  if (LINEAGE_KEYS.every(key => lineage[key] === current[key])) return;
  if (bridge && lineage.sessionId === bridge.previousSessionId && lineage.bindingDigest === bridge.previousBindingDigest
    && bridge.currentBindingDigest === current.bindingDigest
    && BRIDGED_LINEAGE_KEYS.every(key => lineage[key] === current[key])) return;
  z3Fault("Z3_NATIVE_RETAINED_OWNER_LINEAGE_REQUIRED");
}
function v2Projection(cursor: GeneralViabilityFrameCursor): GeneralViabilityCursor {
  const { frame: _frame, pending, schema: _schema, ...rest } = cursor;
  void _frame; void _schema;
  return { ...rest, schema: "finnor.z3.s4-cursor.v2",
    pending: pending && { receiptRef: pending.receiptRef, observationDigest: pending.observationDigest } };
}
export function initialGeneralFrameCursor(model: GeneralNativeModel, strategy: Strategy,
  observations: readonly RetainedOwnerObservation[], resources: NativeResourceObservation,
  identity: CursorIdentity, lineage: RetainedOwnerLineage): GeneralViabilityFrameCursor {
  const { schema: _schema, pending: _pending, ...base } = initialGeneralCursor(model, strategy, observations, resources, identity);
  void _schema; void _pending;
  return { ...base, schema: GENERAL_FRAME_CURSOR, frame: retainOwnerFrame(base.stateId, observations, lineage), pending: null };
}
export function assertGeneralFrameCursor(model: GeneralNativeModel, strategy: Strategy,
  cursor: GeneralViabilityFrameCursor, digest: string, identity: CursorIdentity) {
  if (cursor.schema !== GENERAL_FRAME_CURSOR || hash(cursor) !== digest) z3Fault("Z3_S4_CURSOR_PREIMAGE_CHANGED");
  const base = v2Projection(cursor);
  assertGeneralCursor(model, strategy, base, hash(base), identity);
  if (cursor.frame && (cursor.frame.stateId !== cursor.stateId || frameDigest(cursor.frame) !== cursor.frame.digest
    || cursor.frame.lineage.mapDigest !== cursor.mapDigest)) z3Fault("Z3_NATIVE_RETAINED_OWNER_FRAME_CHANGED");
  if (cursor.pending && cursor.pending.lineage.mapDigest !== cursor.mapDigest) {
    z3Fault("Z3_NATIVE_RETAINED_OWNER_LINEAGE_REQUIRED");
  }
}
/** A LAST_OWNER_RESULT state reads the authenticated frame retained when the
 * owner returned it: historical knowledge, never a fresh external read. Any
 * other state reads its current owners. */
export function retainedOwnerSource(model: GeneralNativeModel, cursor: GeneralViabilityFrameCursor,
  current: RetainedOwnerLineage, bridge: RetainedLineageBridge | null): RetainedOwnerSource {
  const mapping = model.original.observations.find(row => row.stateId === cursor.stateId);
  if (!mapping) z3Fault("Z3_NATIVE_STATE_OBSERVATION_MISSING");
  if (mapping.knowledge !== "LAST_OWNER_RESULT") return { source: "CURRENT_OWNERS" };
  const frame = cursor.frame;
  if (!frame || frame.stateId !== cursor.stateId) z3Fault("Z3_NATIVE_RETAINED_OWNER_FRAME_REQUIRED");
  if (frameDigest(frame) !== frame.digest) z3Fault("Z3_NATIVE_RETAINED_OWNER_FRAME_CHANGED");
  assertRetainedOwnerLineage(frame.lineage, current, bridge);
  return { source: "RETAINED_FRAME", observations: frame.observations };
}
export function advanceGeneralFrameCursor(model: GeneralNativeModel, strategy: Strategy,
  cursor: GeneralViabilityFrameCursor, edgeIndex: number, targetFrame: readonly RetainedOwnerObservation[],
  resources: NativeResourceObservation, settlements: readonly NativeSettlementEvidence[],
  lineage: RetainedOwnerLineage, operationReturn: RetainedOwnerObservation | null): GeneralViabilityFrameCursor {
  const source = model.arena.states.find(s => s.id === cursor.stateId);
  const { schema: _schema, pending: _pending, ...next } = advanceGeneralCursor(model, strategy, v2Projection(cursor),
    edgeIndex, targetFrame, resources, settlements);
  void _schema; void _pending;
  const target = model.arena.states.find(s => s.id === next.stateId);
  let pending: GeneralViabilityFrameCursor["pending"] = null;
  // The C operation return is the E outcome still to be consumed; a later
  // context read must not replace it.
  if (source?.owner === "C" && target?.owner === "E") {
    if (!operationReturn) z3Fault("Z3_NATIVE_OPERATION_RETURN_REQUIRED");
    pending = { receiptRef: operationReturn.receiptRef, observationDigest: hash(operationReturn), lineage };
  }
  return { ...next, schema: GENERAL_FRAME_CURSOR, frame: retainOwnerFrame(next.stateId, targetFrame, lineage), pending };
}
