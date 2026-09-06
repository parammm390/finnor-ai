// Self-critique & repair pass (Phase 7, docs/jarvis-99-phase-7-9-execution-plan.md).
// Runs INSIDE LLMPlanner.plan() itself — not the orchestrator, not a job — because
// direct planner callers would never see a repair pass wired anywhere else. Must
// never run while a withTenant() transaction is
// open: production's pool caps at max: 2, and a real incident (commit 81d613e) showed
// two stuck connections silently wedging the entire queue. Callers must invoke this
// before opening any transaction.

import { z } from "zod";
import { isPurposeConfigured, type LLMChannel, type LLMProvider, resolveProviderForPurpose } from "./llm";
import { redactStructured, redactText } from "@finnor/security";

export interface RepairCandidate {
  actionType: string;
  payload: Record<string, unknown>;
}

export interface RepairInput {
  instruction: string;
  candidate: RepairCandidate;
  reasoning?: string;
  allowedActionTypes: string[];
  payloadSpec: string; // plugins.payloadSpecJson() — same string planner.ts's system prompt uses
  /** B2.T8: the plugin's concrete schema error, supplied for the one permitted
   * repair attempt before the planner fails loudly. */
  validationError?: string;
  tenantId?: string;
  traceId?: string;
  channel?: LLMChannel;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineMs?: number;
}

export interface RepairVerdict {
  repaired: boolean;
  actionType: string; // == candidate.actionType when repaired === false
  payload: Record<string, unknown>;
  reason: string;
  deterministicFlags: string[]; // ids of checklist rules that fired, [] if none
}

export function runChecklist(_input: RepairInput): { flags: string[]; highConfidenceSuggestion: RepairCandidate | null } {
  return { flags: [], highConfidenceSuggestion: null };
}

const RepairResponseSchema = z.object({
  repaired: z.boolean(),
  actionType: z.string(),
  payload: z.record(z.unknown()),
  reason: z.string(),
});

/** Same plug-and-play signal every other adapter in this codebase uses (see
 *  critic.ts's criticConfigured()): nothing to do until a real key lands, never a
 *  hard failure in the meantime. */
export function repairLlmConfigured(): boolean {
  return isPurposeConfigured("repair");
}

export async function repairAction(
  input: RepairInput,
  provider?: LLMProvider,
): Promise<RepairVerdict> {
  const { flags, highConfidenceSuggestion } = runChecklist(input);

  if (highConfidenceSuggestion) {
    return {
      repaired: true,
      actionType: highConfidenceSuggestion.actionType,
      payload: highConfidenceSuggestion.payload,
      reason: `deterministic rule matched (${flags.join(", ")})`,
      deterministicFlags: flags,
    };
  }

  if (!repairLlmConfigured()) {
    return {
      repaired: false,
      actionType: input.candidate.actionType,
      payload: input.candidate.payload,
      reason: "repair LLM not configured — deterministic checks only",
      deterministicFlags: flags,
    };
  }

  const system = [
    "You are reviewing a domain action Finnor's planner just drafted, BEFORE a human ever sees it for approval. Nothing has executed yet.",
    "Confirm the draft as-is, or correct its action_type and/or payload ONLY if it clearly misreads the instruction — a wrong action entirely, or a workflow-vs-single-step mismatch.",
    `The ONLY valid action_type values are: ${input.allowedActionTypes.join(", ")}.`,
    `Required payload fields per action_type: ${input.payloadSpec}`,
    flags.length > 0
      ? `A pattern check flagged this draft for possible confusion: ${flags.join(", ")}. Weigh this, but use your own judgment.`
      : "",
    input.validationError ? `The candidate failed plugin schema validation: ${input.validationError}. Repair that exact error; do not invent missing facts.` : "",
    'Respond with ONLY this JSON: {"repaired": boolean, "actionType": "...", "payload": {...}, "reason": "one short sentence"}. If repaired is false, actionType/payload must equal the original draft exactly.',
  ]
    .filter(Boolean)
    .join("\n");

  const user = JSON.stringify(
    redactStructured({
      instruction: redactText(input.instruction).value,
      draftedActionType: input.candidate.actionType,
      draftedPayload: input.candidate.payload,
      plannerReasoning: input.reasoning ?? null,
    }),
  );

  let verdict: RepairVerdict;
  try {
    const selectedProvider = provider ?? resolveProviderForPurpose("repair", input.channel ?? "text");
    const raw = await selectedProvider.complete({ system, user, json: true, tenantId: input.tenantId, traceId: input.traceId, purpose: "repair", channel: input.channel, signal: input.signal, deadlineAt: input.deadlineAt, deadlineMs: input.deadlineMs });
    const parsed = RepairResponseSchema.parse(JSON.parse(raw));
    verdict = { ...parsed, deterministicFlags: flags };
  } catch (err) {
    return {
      repaired: false,
      actionType: input.candidate.actionType,
      payload: input.candidate.payload,
      reason: `repair LLM call failed or returned malformed JSON: ${(err as Error).message}`,
      deterministicFlags: flags,
    };
  }

  if (!verdict.repaired) {
    return { ...verdict, actionType: input.candidate.actionType, payload: input.candidate.payload };
  }
  if (!input.allowedActionTypes.includes(verdict.actionType)) {
    return {
      repaired: false,
      actionType: input.candidate.actionType,
      payload: input.candidate.payload,
      reason: `repair proposed an unregistered action_type "${verdict.actionType}" — discarded`,
      deterministicFlags: flags,
    };
  }
  return verdict; // payload validation against the target plugin happens in planner.ts, which has the registry
}
