/** Original native meanings for the first S4 profile. This parser reads the
 * accepted Work instruction, not a solver/HTTP replacement for that input. */
import { z } from "zod";
import { parseArena, hash, z3Fault } from "./contracts";
import type { PublicArena } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { PROFILE } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { parseGeneralNativeModel, type GeneralNativeModel } from "./general-model";

const OriginalSchema = z.object({
  schema: z.literal("finnor.z3.original-internal-readiness.v1"),
  profile: z.literal("S4_READINESS_RECONCILIATION"),
  resourceMeaning: z.literal("S6_OUTSTANDING_CAPACITY_NOT_COMPUTE_ALLOWANCE"),
  arena: z.unknown(),
}).strict();
export type NativeOperation = "READINESS" | "RECONCILE";
export const NATIVE_OUTCOMES: Readonly<Record<NativeOperation, readonly string[]>> = Object.freeze({
  READINESS: ["READY", "NOT_READY"], RECONCILE: ["CLEAR", "UNKNOWN_RETAINED"],
});
export interface NativeReadinessModel {
  kind: "READINESS";
  original: z.infer<typeof OriginalSchema>; arena: PublicArena;
  environmentOperations: ReadonlyMap<string, NativeOperation>;
}
export type NativeOriginalModel = NativeReadinessModel | GeneralNativeModel;

export function parseNativeOriginalInstruction(instruction: string): NativeOriginalModel {
  if (Buffer.byteLength(instruction) > PROFILE.inputBytes) z3Fault("Z3_ORIGINAL_INSTRUCTION_BYTE_BOUND");
  let value: unknown;
  try { value = JSON.parse(instruction); } catch { z3Fault("Z3_ORIGINAL_NATIVE_MANDATE_REQUIRED"); }
  if (value && typeof value === "object" && !Array.isArray(value)
    && "schema" in value && value.schema === "finnor.z3.original-native-map.v2") {
    return parseGeneralNativeModel(value);
  }
  const parsed = OriginalSchema.safeParse(value);
  if (!parsed.success) z3Fault("Z3_ORIGINAL_NATIVE_MANDATE_REQUIRED");
  const arena = parseArena(parsed.data.arena);
  if (arena.assumptions.length || arena.goals.length !== 2
    || arena.resources.maximum !== 0 || arena.resources.renewalRefs.length
    || arena.resources.settlementRefs.length
    || arena.states.some(s => s.remaining !== 0)) z3Fault("Z3_NATIVE_PROFILE_UNSUPPORTED");
  const states = new Map(arena.states.map(s => [s.id, s]));
  const operations = new Map<string, NativeOperation>();
  for (const edge of arena.edges) {
    if (states.get(edge.from)?.owner !== "C") continue;
    if (!(edge.action === "READINESS" || edge.action === "RECONCILE")
      || states.get(edge.to)?.owner !== "E") z3Fault("Z3_NATIVE_OPERATION_UNMODELLED");
    const prior = operations.get(edge.to);
    if (prior && prior !== edge.action) z3Fault("Z3_NATIVE_OBSERVATION_MEANING_AMBIGUOUS");
    operations.set(edge.to, edge.action);
  }
  for (const state of arena.states.filter(s => s.owner === "E")) {
    const operation = operations.get(state.id);
    if (!operation) z3Fault("Z3_NATIVE_OBSERVATION_MEANING_MISSING");
    const outgoing = arena.edges.filter(e => e.from === state.id);
    if (hash(outgoing.map(e => e.action).sort()) !== hash([...NATIVE_OUTCOMES[operation]].sort())
      || outgoing.some(e => states.get(e.to)?.owner !== "C")) z3Fault("Z3_NATIVE_ORIGINAL_OUTCOME_COVERAGE");
  }
  if (arena.initial.length !== 1 || arena.initial.some(id => states.get(id)?.owner !== "C")) z3Fault("Z3_NATIVE_INITIAL_OBSERVATION_REQUIRED");
  for (const [index, operation] of (["READINESS", "RECONCILE"] as const).entries()) {
    const goal = [...operations].filter(([, op]) => op === operation).map(([id]) => id).sort();
    if (!goal.length || hash(goal) !== hash([...(arena.goals[index] ?? [])].sort())) {
      z3Fault("Z3_NATIVE_RECURRING_GOAL_MEANING");
    }
  }
  return { kind: "READINESS", original: parsed.data, arena, environmentOperations: operations };
}
