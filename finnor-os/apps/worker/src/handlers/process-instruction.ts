// process_instruction job: the async entry point for Vapi transcripts — runs the full
// Planner → gate → Executor → Reflection pipeline under the tenant's context.

import { FinnorOrchestrator } from "@finnor/orchestration";
import { PLACEHOLDER_NEEDS_REAL_VALUE } from "@finnor/shared-types";
import type { JobHandler } from "../queue";

let orchestrator: FinnorOrchestrator | null = null;

export const processInstruction: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const instruction = String(payload.instruction ?? "");
  if (!tenantId || tenantId === PLACEHOLDER_NEEDS_REAL_VALUE) {
    throw new Error("process_instruction: tenantId is missing from the durable Work/job payload");
  }
  if (!instruction) throw new Error("process_instruction requires an instruction");
  orchestrator ??= new FinnorOrchestrator();
  // A2.T1: forward the trace id the webhook route minted at intake (queue.ts's own
  // convention, payload._correlationId) into the orchestrator's ctx — otherwise the
  // thread that runs live in Sentry/receipts for the synchronous vapi tool-calls path
  // silently goes cold for the far more common async transcript path.
  const correlationId = typeof payload._correlationId === "string" ? payload._correlationId : undefined;
  await orchestrator.handleInstruction(instruction, {
    tenantId,
    userId: "00000000-0000-4000-8000-0000000000ee", // system principal for webhook-originated work
    role: "owner",
    correlationId,
  }, {
    channel: "voice",
    sessionId: typeof payload.callId === "string" ? `vapi:${payload.callId}` : undefined,
    workId: typeof payload.workId === "string" ? payload.workId : undefined,
    workInputId: typeof payload.workInputId === "string" ? payload.workInputId : undefined,
    instructionId: typeof payload.instructionId === "string" ? payload.instructionId : undefined,
  });
};
