// B2.T8: opt-in planner memory. Keep this separate from memory retrieval itself so
// the prompt contract (and its token budget) remains explicit and unit-testable.

import type { MemorySnapshot } from "@finnor/shared-types";
import { redactText, redactStructured } from "@finnor/security";

const MAX_MEMORY_WORDS = 1500;
const MAX_SHORT_TERM_TURNS = 6;
const FOLLOW_UP_REFERENCE = /\b(?:again|also|same|them|they|their|him|his|her|hers|it|its|that|those|these|this|former|latter|previous|earlier|above|second\s+one|first\s+one|last\s+one)\b/i;
const SELF_CONTAINED_INTENT = /\b(?:research|search|look\s+up|show|tell|give|summarize|explain|create|open|close|resolve|verify|submit|waive|declare|raise|link|send|record|update|change|delete|remove|approve|reject|schedule|book|call|text|email|pay|charge|launch|assign|execute|run|start|what|which|where|when|who|how|is|are|do|does|did|can|could)\b/i;

function isClarificationFragment(instruction: string): boolean {
  const normalized = instruction.trim().replace(/\s+/g, " ");
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount > 0 && wordCount <= 24 && !SELF_CONTAINED_INTENT.test(normalized);
}

export function plannerMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLANNER_MEMORY === "1";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Short-term memory exists to resolve genuine references and clarification
 * fragments, not to turn every new command into prompt continuation. A
 * self-contained instruction receives no prior turns at all. When continuity is
 * needed, preserve only bounded identifiers/action state and citation references;
 * free-form answer prose is deliberately excluded so an old research result can
 * never be copied into a later operational answer.
 */
export function plannerShortTermContext(
  instruction: string,
  shortTerm: MemorySnapshot["shortTerm"],
): Record<string, unknown> | null {
  const memory = asRecord(shortTerm);
  const rawTurns = Array.isArray(memory?.turns) ? memory.turns : [];
  if (rawTurns.length === 0) return null;

  const normalized = instruction.trim().replace(/\s+/g, " ");
  const isReference = FOLLOW_UP_REFERENCE.test(normalized);
  if (!isReference && !isClarificationFragment(normalized)) return null;

  const turns = rawTurns.slice(-MAX_SHORT_TERM_TURNS).flatMap((value) => {
    const turn = asRecord(value);
    if (!turn) return [];
    const actions = Array.isArray(turn.actions)
      ? turn.actions.slice(0, 8).flatMap((candidate) => {
          const action = asRecord(candidate);
          if (!action) return [];
          const actionType = boundedText(action.actionType, 120);
          if (!actionType) return [];
          return [{
            actionType,
            payload: redactStructured(asRecord(action.payload) ?? {}),
            status: boundedText(action.status, 80),
            awaitingApproval: action.awaitingApproval === true,
          }];
        })
      : [];
    const answer = asRecord(turn.answer);
    const evidence = Array.isArray(answer?.evidence)
      ? answer.evidence.slice(0, 5).flatMap((candidate) => {
          const item = asRecord(candidate);
          const source = boundedText(item?.source, 120);
          const ref = boundedText(item?.ref, 500);
          return source && ref ? [{ source, ref }] : [];
        })
      : [];
    return [{
      instruction: boundedText(turn.instruction),
      actions,
      ...(answer ? {
        answer: {
          intent: boundedText(answer.intent, 120),
          title: boundedText(answer.title, 200),
          evidence,
        },
      } : {}),
      at: boundedText(turn.at, 80),
    }];
  });
  return turns.length > 0 ? { turns } : null;
}

/**
 * Clarification answers are intentionally terse (for example
 * `scheduledAt: ...; serviceType: ...`) and therefore do not repeat the command
 * they complete. Reattach only the immediately preceding clarification turn's
 * original instruction so the planner can finish that command; never reattach an
 * arbitrary prior answer, research topic, or business summary.
 */
export function plannerContinuationInstruction(
  instruction: string,
  shortTerm: MemorySnapshot["shortTerm"],
): string {
  if (!isClarificationFragment(instruction)) return instruction;
  const memory = asRecord(shortTerm);
  const rawTurns = Array.isArray(memory?.turns) ? memory.turns : [];
  for (let index = rawTurns.length - 1; index >= 0; index -= 1) {
    const turn = asRecord(rawTurns[index]);
    const actions = Array.isArray(turn?.actions) ? turn.actions : [];
    const clarification = actions.some((candidate) => asRecord(candidate)?.actionType === "clarification_request");
    const original = boundedText(turn?.instruction, 700);
    if (clarification && original && original !== instruction.trim()) {
      return `${original}\nClarification supplied in this turn: ${instruction.trim().slice(0, 700)}`;
    }
  }
  return instruction;
}

function withinWordBudget(text: string, remaining: number): { text: string; used: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const accepted = words.slice(0, Math.max(0, remaining));
  return { text: accepted.join(" "), used: accepted.length };
}

/** Exactly five semantic rows maximum; the combined redacted content is capped at
 * 1,500 whitespace tokens (a conservative prompt-budget unit, not a fabricated
 * tokenizer claim). */
export function plannerMemoryContext(memory: MemorySnapshot, enabled = plannerMemoryEnabled()): Record<string, unknown> {
  if (!enabled) return {};
  let remaining = MAX_MEMORY_WORDS;
  const longTerm = (memory.longTerm ?? {}) as Record<string, unknown>;
  const canonicalSummary = withinWordBudget(JSON.stringify(redactStructured(longTerm.canonicalSummary ?? null)), remaining);
  remaining -= canonicalSummary.used;
  const semantic: string[] = [];
  for (const hit of memory.semantic.slice(0, 5)) {
    const redacted = redactText(hit.chunk).value;
    const bounded = withinWordBudget(redacted, remaining);
    if (bounded.used === 0) break;
    semantic.push(bounded.text);
    remaining -= bounded.used;
  }
  return {
    canonicalSummary: canonicalSummary.text || null,
    semantic,
  };
}
