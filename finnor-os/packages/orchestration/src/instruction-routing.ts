import type { DomainAction, OperatingInteractionContext } from "@finnor/shared-types";
import type { OperationalQueryDecision } from "./fast-read-lane";
import { isConsequentialAction } from "./compiler";

export const INSTRUCTION_ROUTING_POLICY_VERSION = 1 as const;

export type InstructionExecutionModel = "QUERY" | "ATOMIC_EFFECT" | "OBJECTIVE" | "CONVERSATION";

export interface InstructionRouteDecision {
  version: typeof INSTRUCTION_ROUTING_POLICY_VERSION;
  route: InstructionExecutionModel;
  reasonCodes: string[];
  queryDecision?: OperationalQueryDecision;
}

const OBJECTIVE_SIGNALS = [
  /\b(?:and then|then|after|before|once|until|unless|if|when|whenever)\b/i,
  /\b(?:ensure|make sure|own (?:this|it)|take care of|handle|resolve|unstuck|coordinate|arrange|oversee)\b/i,
  /\b(?:wait|reply|respond|response|acknowledg|approval|approve|deadline|follow up later)\b/i,
  /\b(?:delegate|handoff|hand off|team|vendor|supplier|customer)\b.*\b(?:complete|finish|respond|confirm|accept)\b/i,
  /\b(?:recover|retry|replan|fallback|compensat|escalat|outage|failure)\b/i,
  /\b(?:across|multi[- ]?step|workflow|browser|computer)\b/i,
];

const ATOMIC_VERB = /^(?:please\s+)?(?:send|text|email|message|call|assign|update|set|mark|reschedule|cancel|create|record)\b/i;
const DIRECT_TARGET = /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\+\d{8,15}\b|\b[^\s@]+@[^\s@]+\.[^\s@]+\b)/i;
const NAMED_TARGET = /\b(?:to|for|on)\s+(?:the\s+)?[\p{L}\d][\p{L}\d'’&.-]*(?:\s+[\p{L}\d][\p{L}\d'’&.-]*){0,5}\s*$/iu;
const PREPARED_EFFECT = /\b(?:this|that|already[- ]prepared|exact)\b.*\b(?:message|task|field|visit|invoice|payment|record)\b/i;
const QUESTION_SHAPE = /^(?:(?:please\s+)?(?:how|what|which|where|when|who|is|are|do|does|did|can|could|would)\b|(?:please\s+)?(?:tell me|show(?:\s+me)?|pull\s+up|find|get|give me|list|summarize|explain)\b)|\?\s*$/i;
const QUESTION_OBJECTIVE_LANGUAGE = [
  /\b(?:and then|then|after|before|once|until|unless|if|whenever)\b/i,
  ...OBJECTIVE_SIGNALS.slice(1),
];

function isLightweightInformationalQuestion(instruction: string, decision: OperationalQueryDecision): boolean {
  if (decision.route === "planner" && (decision.reason === "mutation_or_advice" || decision.reason === "external_or_ambiguous")) return false;
  const value = instruction.replace(/\s+/g, " ").trim();
  return QUESTION_SHAPE.test(value) && !QUESTION_OBJECTIVE_LANGUAGE.some((signal) => signal.test(value));
}

function exactContextTarget(context: OperatingInteractionContext | Record<string, unknown> | undefined): boolean {
  if (!context || typeof context !== "object" || Array.isArray(context)) return false;
  const row = context as Record<string, unknown>;
  const selected = Array.isArray(row.selectedEntities) ? row.selectedEntities : [];
  return selected.length === 1 || Boolean(row.focusedEntity) || typeof row.householdId === "string";
}

function strictAtomicCandidate(instruction: string, context?: OperatingInteractionContext | Record<string, unknown>): boolean {
  const value = instruction.replace(/\s+/g, " ").trim();
  if (!ATOMIC_VERB.test(value)) return false;
  if (OBJECTIVE_SIGNALS.some((signal) => signal.test(value))) return false;
  if (/\s(?:and|&)\s/i.test(value) || /[;\n]/.test(value)) return false;
  return exactContextTarget(context) || DIRECT_TARGET.test(value) || NAMED_TARGET.test(value) || PREPARED_EFFECT.test(value);
}

/** The one business-level intake policy. The Operational Query Plane interpreter
 * supplies the typed read candidate; this policy owns the final execution model. */
export function classifyInstructionRoute(input: {
  instruction: string;
  fastReadDecision: OperationalQueryDecision;
  activeContext?: OperatingInteractionContext | Record<string, unknown>;
  conversational?: boolean;
}): InstructionRouteDecision {
  if (input.fastReadDecision.route === "fast_read") {
    return { version: 1, route: "QUERY", reasonCodes: ["deterministic_canonical_read"], queryDecision: input.fastReadDecision };
  }
  if (input.conversational) return { version: 1, route: "CONVERSATION", reasonCodes: ["non_business_conversation"] };
  // A plain informational question outside the typed business-read grammar is
  // still not an objective. Keep it on the lightweight answer lane; business
  // terms, mutations, and external/research requests remain fail-closed.
  if (isLightweightInformationalQuestion(input.instruction, input.fastReadDecision)) {
    return { version: 1, route: "CONVERSATION", reasonCodes: ["lightweight_informational_question"] };
  }
  if (strictAtomicCandidate(input.instruction, input.activeContext)) {
    return { version: 1, route: "ATOMIC_EFFECT", reasonCodes: ["strict_single_effect_candidate"] };
  }
  const reasonCodes = OBJECTIVE_SIGNALS.filter((signal) => signal.test(input.instruction)).map((_, index) => `objective_signal_${index + 1}`);
  return { version: 1, route: "OBJECTIVE", reasonCodes: reasonCodes.length ? reasonCodes : ["meaningful_business_work_default"] };
}

const CONTINUATION_ACTION = /(?:workflow|delegate|handoff|hand_off|computer_task|clarification|manual_step)/i;

/** A strict atomic candidate is revalidated against the actual typed plan. This is
 * still the same routing policy, and fails toward Objective when the plan reveals a
 * dependency, workflow, read action, or other continuation requirement. */
export function finalizeInstructionRoute(
  preliminary: InstructionRouteDecision,
  actions: DomainAction[],
): InstructionRouteDecision {
  if (preliminary.route !== "ATOMIC_EFFECT") return preliminary;
  const action = actions[0];
  const dependencyCount = Array.isArray((action as DomainAction & { dependsOn?: unknown[] }).dependsOn)
    ? ((action as DomainAction & { dependsOn?: unknown[] }).dependsOn?.length ?? 0)
    : 0;
  const atomic = actions.length === 1
    && Boolean(action)
    && dependencyCount === 0
    && action!.compiledGraph?.kind === "single_action"
    && !CONTINUATION_ACTION.test(action!.actionType)
    && isConsequentialAction(action!.actionType, action!.payload);
  return atomic
    ? { ...preliminary, reasonCodes: [...preliminary.reasonCodes, "one_independent_effect_set"] }
    : { version: 1, route: "OBJECTIVE", reasonCodes: ["atomic_candidate_rejected_by_typed_plan"] };
}
