import type { MemorySnapshot } from "@finnor/shared-types";

const RESEARCH_READ = /\b(?:research|search(?: the)? web|look up|online|latest|current (?:news|benchmark|market|source|industry)|competitor|market|reviews?|weather|benchmarks?|sources?|source-backed|cite|citations?)\b/i;
const MUTATION_REQUEST = /\b(?:create|send|record|update|change|delete|remove|approve|reject|call|text|email|pay|charge|launch|assign|execute|run|start)\b/i;

export interface SafeReadFallback {
  action_type: "search_web";
  payload: Record<string, unknown>;
  reasoning: string;
}

/** A provider failure may fall back only to the one registered public-research read.
 * Internal business questions stay on the deterministic operational-query plane. */
export function safeReadFallbackForInstruction(instruction: string, actionTypes: readonly string[]): SafeReadFallback | null {
  const normalized = instruction.trim().replace(/\\s+/g, " ");
  if (!normalized || MUTATION_REQUEST.test(normalized)) return null;
  if (!RESEARCH_READ.test(normalized) || !actionTypes.includes("search_web")) return null;
  return {
    action_type: "search_web",
    payload: { query: normalized },
    reasoning: "Safe public-research fallback after the planning provider returned no usable plan.",
  };
}

/** Current/public evidence always uses the reusable research capability. */
export function enforceExternalResearchRoute(
  instruction: string,
  actions: Array<{ action_type: string; payload: Record<string, unknown>; reasoning?: string; depends_on?: number[] }>,
  actionTypes: readonly string[],
) {
  const normalized = instruction.trim().replace(/\\s+/g, " ");
  if (!normalized || MUTATION_REQUEST.test(normalized) || !RESEARCH_READ.test(normalized) || !actionTypes.includes("search_web")) {
    return actions;
  }
  if (actions.length === 1 && actions[0]?.action_type === "search_web") return actions;
  if (actions.length > 0 && actions.some((action) => action.action_type !== "clarification_request")) return actions;
  return [{
    action_type: "search_web",
    payload: { query: normalized },
    reasoning: "External/current/source-backed question routed through the registered research stack.",
  }];
}

export interface ClarificationContinuationAction {
  action_type: "clarification_request";
  payload: Record<string, unknown>;
  reasoning: string;
}

/** Domain-specific continuation compilers belong to the active vertical package.
 * Core deliberately performs no legacy business-entity reconstruction. */
export function clarificationContinuationAction(
  _instruction: string,
  _planningInstruction: string,
  _memory: MemorySnapshot,
  _actionTypes: readonly string[],
): ClarificationContinuationAction | null {
  return null;
}
