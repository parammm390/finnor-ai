// Clarification is a first-class action, not a planner error string. It deliberately
// produces no external effect: its only purpose is to preserve an ambiguous request
// as a durable, tenant-scoped question card instead of guessing an entity, party, or
// consequential business detail.

import type { DomainEnginePlugin } from "../shared/plugin-interface";
import type { DomainPolicy, DraftAction, ExecutionResult, ValidationResult } from "@finnor/shared-types";
import { z } from "zod";

const ACTION = "clarification_request";
export const ClarificationRequestSchema = z.object({
  question: z.string().min(3).max(1000),
  missingFields: z.array(z.string().min(1).max(120)).min(1).max(12),
  context: z.string().min(1).max(1000).optional(),
});

export const clarificationPlugin: DomainEnginePlugin = {
  name: "clarification",
  actionTypes: [ACTION],
  payloadSchemas: { [ACTION]: ClarificationRequestSchema },
  canHandle: (actionType) => actionType === ACTION,
  validate(actionType, payload): ValidationResult {
    if (actionType !== ACTION) return { valid: false, errors: [`unhandled action ${actionType}`] };
    const parsed = ClarificationRequestSchema.safeParse(payload);
    return parsed.success ? { valid: true, errors: [] } : { valid: false, errors: parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`) };
  },
  draft(actionType, payload, _policy: DomainPolicy): DraftAction {
    const request = ClarificationRequestSchema.parse(payload);
    return {
      actionType,
      summary: request.question,
      payload: request,
      // Reuses the existing confirmation queue as a question card. This is not an
      // approval to perform work; a later user instruction supplies the missing fact.
      requiresConfirmation: true,
    };
  },
  simulate(_actionType, payload) {
    const request = ClarificationRequestSchema.parse(payload);
    return {
      mode: "schema" as const,
      summary: `Clarification required: ${request.question}`,
      predicted: { question: request.question, missingFields: request.missingFields, fieldChanges: [] },
    };
  },
  async execute(draft): Promise<ExecutionResult> {
    // Reached only if a client explicitly resolves the queue item. No business effect
    // occurred; the durable record simply documents that a question was acknowledged.
    return { status: "success", output: { clarificationRequested: true, question: draft.payload.question } };
  },
};

export default clarificationPlugin;
