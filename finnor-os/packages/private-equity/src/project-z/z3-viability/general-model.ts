/** Versioned original-Work mapping. Public edge indices and justice predicates
 * keep their original meanings; action strings are never executable selectors. */
import { z } from "zod";
import { ExperimentRefSchema } from "@finnor/epistemic-runtime";
import type { ExperimentRef } from "@finnor/shared-types";
import { PROFILE, type PublicArena } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { hash, parseArena, z3Fault } from "./contracts";

const id = z.string().min(1).max(256);
const index = z.number().int().min(0).max(PROFILE.states * PROFILE.outgoing - 1);
const atom = z.union([z.string().max(4096), z.boolean(), z.number().int().min(-1e9).max(1e9), z.null()]);
const values = z.record(id, atom).refine(value => Object.keys(value).length <= 64);
const atomPredicate = z.object({ observerId: id, revision: ExperimentRefSchema, values }).strict();
const predicate = atomPredicate.extend({ and: z.array(atomPredicate).max(PROFILE.states).optional() }).strict();
const observer = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("CONTROL_OBSERVATION"), policyRef: ExperimentRefSchema,
    instrumentId: id, availablePeriod: z.number().int().min(0).max(1e9) }).strict(),
  z.object({ id, kind: z.literal("EXACT_POLICY"), policyRef: ExperimentRefSchema }).strict(),
  z.object({ id, kind: z.literal("APPLICATION_SNAPSHOT"),
    responsibilityIdentity: z.string().regex(/^x1-obligation:[a-f0-9]{64}$/),
    observation: z.literal("CURRENT_ORIGINAL_LAWFUL_READBACK") }).strict(),
]);
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONTROL_OBSERVE"), observerId: id }).strict(),
  z.object({ kind: z.literal("EXACT_CONTROL_CHOOSE"), observerId: id, decision: z.unknown(),
    actionId: id.nullable() }).strict(),
  z.object({ kind: z.literal("APPLICATION_COMPOSE"), observerId: id,
    operationId: id, semanticRevision: id }).strict(),
]);
const justice = z.object({ index: z.number().int().min(0).max(1),
  clauses: z.array(predicate).max(PROFILE.states) }).strict();
export const GeneralNativeSchema = z.object({
  schema: z.literal("finnor.z3.original-native-map.v2"),
  profile: z.literal("S4_TYPED_OWNER_OPERATIONS"),
  predicateScope: z.enum(["TAGGED_ACTIVE_OWNER", "COMPOSITE_OWNER_FRAME"]).optional(),
  arena: z.unknown(),
  observers: z.array(observer).min(1).max(PROFILE.states * PROFILE.outgoing),
  controller: z.array(z.object({ edgeIndex: index, operation }).strict())
    .max(PROFILE.states * PROFILE.outgoing),
  observations: z.array(z.object({ stateId: id, predicate,
    knowledge: z.enum(["CURRENT_CONTEXT", "LAST_OWNER_RESULT"]).optional() }).strict()).min(1).max(PROFILE.states),
  environment: z.array(z.object({ edgeIndex: index, predicate }).strict())
    .max(PROFILE.states * PROFILE.outgoing),
  assumptions: z.array(justice).max(2),
  goals: z.array(justice).max(2),
  resources: z.object({
    meaning: z.enum(["ORIGINAL_S5_REQUEST_ALLOWANCE_AND_S4_UNKNOWN_CAPACITY",
      "NO_MODELED_EFFECT_RESOURCE_NOT_COMPUTE_ALLOWANCE"]),
    capacityObserverId: id.nullable(),
    renewals: z.array(z.object({ alias: id, receiptRef: ExperimentRefSchema }).strict())
      .max(PROFILE.states * PROFILE.outgoing),
    settlements: z.array(z.object({ alias: id,
      obligations: z.array(z.object({ obligationId: id, obligationRef: ExperimentRefSchema }).strict()).min(1).max(PROFILE.states),
      receipt: z.literal("CURRENT_ORIGINAL_INDEPENDENT_DISPOSITION") }).strict())
      .max(PROFILE.states * PROFILE.outgoing),
  }).strict(),
}).strict();

export type NativeFacts = Record<string, string | number | boolean | null>;
export type NativePredicate = z.infer<typeof predicate>;
export type NativeAtomPredicate = z.infer<typeof atomPredicate>;
export type NativeObserver = z.infer<typeof observer>;
export type NativeBoundOperation = z.infer<typeof operation>;
export type GeneralNativeInstruction = z.infer<typeof GeneralNativeSchema>;
export interface GeneralNativeModel {
  kind: "GENERAL";
  original: GeneralNativeInstruction;
  arena: PublicArena;
  mapDigest: string;
  environmentOperations: ReadonlyMap<string, never>;
}
export interface NativeObservation {
  observerId: string; revision: ExperimentRef; sourceRef: ExperimentRef; facts: NativeFacts;
  qualification: string;
  knowledge?: "CURRENT_CONTEXT" | "RETURNED_OWNER_RESULT";
}
export interface NativeResourceObservation {
  maximum: number; remaining: number; capacity: number; unknown: string[];
  reservationRef: ExperimentRef;
}

export function nativeFactsMatch(expected: NativeFacts, actual: NativeFacts): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Object.hasOwn(actual, key) && hash(actual[key]) === hash(value));
}
export function nativePredicateAtoms(value: NativePredicate): NativeAtomPredicate[] {
  const { and, ...first } = value;
  return [first, ...(and ?? [])];
}
export function nativePredicateObservers(value: NativePredicate): string[] {
  return [...new Set(nativePredicateAtoms(value).map(atom => atom.observerId))];
}
export function nativePredicateMatches(value: NativePredicate, observations: readonly NativeObservation[],
  resources: NativeFacts): boolean {
  return nativePredicateAtoms(value).every(atom => {
    const observed = observations.find(row => row.observerId === atom.observerId);
    if (!observed) return false;
    assertNativePredicateRevision(atom, observed);
    return nativeFactsMatch(atom.values, { ...observed.facts, ...resources });
  });
}
/** Resource facts come only from the original S5/S6 observation supplied by
 * the native origin, never from the instruction's claimed current counters. */
export function nativeResourceFacts(model: Pick<GeneralNativeModel, "arena">,
  resources: Pick<NativeResourceObservation, "maximum" | "remaining" | "capacity" | "unknown">): NativeFacts {
  return { $maximum: resources.maximum, $remaining: resources.remaining, $capacity: resources.capacity,
    $unknownDigest: hash([...resources.unknown].sort()),
    ...Object.fromEntries(model.arena.resources.obligationIds.map(id => [`$unknown:${id}`, resources.unknown.includes(id)])) };
}
const sameSet = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && hash([...a].sort()) === hash([...b].sort());

function exactIndices(actual: number[], expected: number[], code: string) {
  if (new Set(actual).size !== actual.length || !sameSet(actual, expected)) z3Fault(code);
}

export function parseGeneralNativeModel(value: unknown): GeneralNativeModel {
  const result = GeneralNativeSchema.safeParse(value);
  if (!result.success) z3Fault("Z3_GENERAL_NATIVE_MAPPING_SCHEMA");
  const original = result.data, arena = parseArena(original.arena);
  if (original.resources.meaning === "NO_MODELED_EFFECT_RESOURCE_NOT_COMPUTE_ALLOWANCE"
    && (arena.resources.maximum !== 0 || arena.states.some(state => state.remaining !== 0))) {
    z3Fault("Z3_NATIVE_ZERO_MODELED_RESOURCE_MEANING_CHANGED");
  }
  const observers = new Map(original.observers.map(o => [o.id, o]));
  if (observers.size !== original.observers.length) z3Fault("Z3_NATIVE_DUPLICATE_OBSERVER");
  const states = new Map(arena.states.map(state => [state.id, state]));
  exactIndices(original.controller.map(row => row.edgeIndex),
    arena.edges.flatMap((edge, i) => states.get(edge.from)?.owner === "C" ? [i] : []),
    "Z3_NATIVE_TOTAL_C_EDGE_BINDING_REQUIRED");
  exactIndices(original.environment.map(row => row.edgeIndex),
    arena.edges.flatMap((edge, i) => states.get(edge.from)?.owner === "E" ? [i] : []),
    "Z3_NATIVE_TOTAL_E_OUTCOME_BINDING_REQUIRED");
  if (!sameSet(original.observations.map(row => row.stateId), arena.states.map(state => state.id))
    || new Set(original.observations.map(row => row.stateId)).size !== arena.states.length) {
    z3Fault("Z3_NATIVE_TOTAL_STATE_OBSERVATION_REQUIRED");
  }
  for (const mapping of original.observations) {
    const state = states.get(mapping.stateId)!;
    const resources = nativeResourceFacts({ arena }, { maximum: arena.resources.maximum, capacity: arena.resources.capacity,
      remaining: state.remaining, unknown: state.unknown });
    if (nativePredicateAtoms(mapping.predicate).some(atom => Object.entries(atom.values).some(([key, value]) =>
      Object.hasOwn(resources, key) && hash(resources[key]) !== hash(value)))) {
      z3Fault("Z3_NATIVE_ORIGINAL_RESOURCE_PREDICATE_MEANING_CHANGED");
    }
  }
  for (const row of original.controller) {
    const source = observers.get(row.operation.observerId);
    const expected = { CONTROL_OBSERVE: "CONTROL_OBSERVATION", EXACT_CONTROL_CHOOSE: "EXACT_POLICY",
      APPLICATION_COMPOSE: "APPLICATION_SNAPSHOT" } as const;
    if (!source || source.kind !== expected[row.operation.kind]) z3Fault("Z3_NATIVE_TYPED_OPERATION_OWNER_MISMATCH");
  }
  const predicates = [...original.observations.map(row => row.predicate),
    ...original.environment.map(row => row.predicate),
    ...original.assumptions.flatMap(row => row.clauses), ...original.goals.flatMap(row => row.clauses)];
  for (const p of predicates) {
    const atoms = nativePredicateAtoms(p);
    for (const atom of atoms) {
      if (!observers.has(atom.observerId)) z3Fault("Z3_NATIVE_PREDICATE_OBSERVER_MISSING");
      for (const other of atoms.filter(other => other.observerId === atom.observerId)) {
        if (hash(atom.revision) !== hash(other.revision)
          || Object.keys(atom.values).some(key => Object.hasOwn(other.values, key)
            && hash(atom.values[key]) !== hash(other.values[key]))) z3Fault("Z3_NATIVE_CONTRADICTORY_OWNER_CONJUNCTION");
      }
    }
    if (p.and?.length && original.predicateScope !== "COMPOSITE_OWNER_FRAME") {
      z3Fault("Z3_NATIVE_COMPOSITE_PREDICATE_SCOPE_REQUIRED");
    }
  }
  for (const state of arena.states.filter(state => state.owner === "E")) {
    const outcomes = original.environment.filter(row => arena.edges[row.edgeIndex]!.from === state.id);
    for (let i = 0; i < outcomes.length; i++) for (let j = i + 1; j < outcomes.length; j++) {
      const a = outcomes[i]!.predicate, b = outcomes[j]!.predicate;
      const targetA = states.get(arena.edges[outcomes[i]!.edgeIndex]!.to)!;
      const targetB = states.get(arena.edges[outcomes[j]!.edgeIndex]!.to)!;
      const distinctResources = targetA.remaining !== targetB.remaining || !sameSet(targetA.unknown, targetB.unknown);
      const contradictory = nativePredicateAtoms(a).some(left => nativePredicateAtoms(b).some(right =>
        left.observerId === right.observerId && hash(left.revision) === hash(right.revision)
        && Object.keys(left.values).some(key => Object.hasOwn(right.values, key)
          && hash(left.values[key]) !== hash(right.values[key]))));
      if (!distinctResources && !contradictory) z3Fault("Z3_NATIVE_AMBIGUOUS_E_OUTCOME_PREDICATES");
    }
  }
  for (const [kind, sets] of [["assumptions", arena.assumptions], ["goals", arena.goals]] as const) {
    exactIndices(original[kind].map(row => row.index), sets.map((_, i) => i),
      "Z3_NATIVE_ORIGINAL_JUSTICE_COVERAGE_REQUIRED");
    for (const row of original[kind]) {
      const realized: string[] = [];
      for (const state of original.observations) {
        const publicState = states.get(state.stateId)!;
        const resourceFacts = nativeResourceFacts({ arena }, { maximum: arena.resources.maximum,
          capacity: arena.resources.capacity, remaining: publicState.remaining, unknown: publicState.unknown });
        const valuations = new Map<string, { revision: ExperimentRef; values: NativeFacts }>();
        for (const atom of nativePredicateAtoms(state.predicate)) {
          const previous = valuations.get(atom.observerId);
          valuations.set(atom.observerId, { revision: atom.revision,
            values: { ...previous?.values, ...atom.values, ...resourceFacts } });
        }
        const truths = row.clauses.map(clause => {
          if (original.predicateScope !== "COMPOSITE_OWNER_FRAME"
            && clause.observerId !== state.predicate.observerId) return false;
          let missing = false, falseAtom = false;
          for (const atom of nativePredicateAtoms(clause)) {
            const valuation = valuations.get(atom.observerId);
            if (!valuation) { missing = true; continue; }
            if (hash(atom.revision) !== hash(valuation.revision)) {
              z3Fault("Z3_NATIVE_ORIGINAL_PREDICATE_REVISION_OR_VALUATION_MISSING");
            }
            const different = Object.entries(atom.values).some(([key, value]) =>
              Object.hasOwn(valuation.values, key) && hash(valuation.values[key]) !== hash(value));
            falseAtom ||= different;
            missing ||= !different && Object.keys(atom.values).some(key => !Object.hasOwn(valuation.values, key));
          }
          if (!falseAtom && missing) z3Fault("Z3_NATIVE_ORIGINAL_PREDICATE_REVISION_OR_VALUATION_MISSING");
          return !falseAtom;
        });
        if (truths.some(Boolean)) realized.push(state.stateId);
      }
      if (!sameSet(realized, sets[row.index]!)) z3Fault("Z3_NATIVE_ORIGINAL_JUSTICE_MEANING_CHANGED");
    }
  }
  for (const [bindings, refs] of [[original.resources.renewals, arena.resources.renewalRefs],
    [original.resources.settlements, arena.resources.settlementRefs]] as const) {
    if (new Set(bindings.map(row => row.alias)).size !== bindings.length
      || !sameSet(bindings.map(row => row.alias), refs)) z3Fault("Z3_NATIVE_TOTAL_RESOURCE_RECEIPT_BINDING_REQUIRED");
  }
  if (original.resources.capacityObserverId !== null
    && observers.get(original.resources.capacityObserverId)?.kind !== "APPLICATION_SNAPSHOT") {
    z3Fault("Z3_NATIVE_UNKNOWN_CAPACITY_OWNER_REQUIRED");
  }
  for (const binding of original.resources.settlements) {
    const ids = binding.obligations.map(row => row.obligationId);
    if (new Set(ids).size !== ids.length || ids.some(id => !arena.resources.obligationIds.includes(id))
      || binding.obligations.some(row => row.obligationRef.owner !== "S6" || row.obligationRef.id !== row.obligationId)) {
      z3Fault("Z3_NATIVE_ORIGINAL_S6_RECEIPT_IDENTITY_REQUIRED");
    }
  }
  const { arena: _arena, ...mapping } = original;
  void _arena;
  return { kind: "GENERAL", original, arena, mapDigest: hash(mapping), environmentOperations: new Map<string, never>() };
}

export function assertNativePredicateRevision(predicate: NativeAtomPredicate, observation: NativeObservation) {
  if (predicate.observerId !== observation.observerId || hash(predicate.revision) !== hash(observation.revision)) {
    z3Fault("Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED");
  }
}
export function nativeStateMatches(model: GeneralNativeModel, stateId: string,
  observations: readonly NativeObservation[], resources: NativeResourceObservation): boolean {
  const state = model.arena.states.find(state => state.id === stateId);
  const mapping = model.original.observations.find(row => row.stateId === stateId);
  if (!state || !mapping) z3Fault("Z3_NATIVE_STATE_OBSERVATION_MISSING");
  const observation = observations.find(row => row.observerId === mapping.predicate.observerId);
  if (!observation) z3Fault("Z3_NATIVE_ACTUAL_OWNER_OBSERVATION_REQUIRED");
  if (mapping.knowledge === "LAST_OWNER_RESULT" && observation.knowledge !== "RETURNED_OWNER_RESULT") return false;
  return nativePredicateMatches(mapping.predicate, observations, nativeResourceFacts(model, resources))
    && resources.maximum === model.arena.resources.maximum && resources.capacity === model.arena.resources.capacity
    && resources.remaining === state.remaining && sameSet(resources.unknown, state.unknown);
}
export function selectNativeInitial(model: GeneralNativeModel, observations: readonly NativeObservation[],
  resources: NativeResourceObservation): { stateId: string; initialIndex: number } {
  const matches = model.arena.initial.flatMap((stateId, initialIndex) =>
    nativeStateMatches(model, stateId, observations, resources) ? [{ stateId, initialIndex }] : []);
  if (matches.length !== 1) z3Fault(matches.length ? "Z3_NATIVE_ACTUAL_INITIAL_AMBIGUOUS" : "Z3_NATIVE_ACTUAL_INITIAL_UNMODELLED");
  return matches[0]!;
}
export function selectNativeEnvironmentEdge(model: GeneralNativeModel, stateId: string,
  observation: NativeObservation | readonly NativeObservation[],
  resources: NativeResourceObservation): number {
  const frame: readonly NativeObservation[] = Array.isArray(observation) ? observation : [observation as NativeObservation];
  const rows = model.original.environment.filter(row => model.arena.edges[row.edgeIndex]!.from === stateId);
  const matches = rows.filter(row => {
    const target = model.arena.states.find(state => state.id === model.arena.edges[row.edgeIndex]!.to)!;
    return nativePredicateMatches(row.predicate, frame, nativeResourceFacts(model, resources))
      && resources.maximum === model.arena.resources.maximum && resources.capacity === model.arena.resources.capacity
      && target.remaining === resources.remaining && sameSet(target.unknown, resources.unknown);
  });
  if (matches.length !== 1) z3Fault(matches.length ? "Z3_NATIVE_ACTUAL_E_OUTCOME_AMBIGUOUS" : "Z3_NATIVE_ACTUAL_E_OUTCOME_UNMODELLED");
  return matches[0]!.edgeIndex;
}
