import type { InstructionTraceSnapshot } from "./instruction-events"

export type PresenceState = "IDLE" | "LISTENING" | "UNDERSTANDING" | "PLANNING" | "WORKING" | "DELEGATING" | "WAITING" | "APPROVAL_REQUIRED" | "VERIFYING" | "COMPLETED" | "BLOCKED" | "FAILED"

const PHASE_STATE: Record<string, PresenceState> = {
  received: "UNDERSTANDING", context_retrieved: "UNDERSTANDING",
  planning: "PLANNING", plan_ready: "PLANNING",
  clarification_required: "WAITING", action_created: "WORKING", action_gated: "APPROVAL_REQUIRED",
  dispatched: "DELEGATING", executing: "WORKING", step_progress: "WORKING",
  verifying: "VERIFYING", verified: "VERIFYING", completed: "COMPLETED", failed: "FAILED", cancelled: "BLOCKED",
}

/** Presence reflects recorded runtime state, never an invented thinking timer. */
export function presenceFromRuntime(input: { voiceListening: boolean; submitting: boolean; trace: InstructionTraceSnapshot | null; workStatus: string | null }): PresenceState {
  if (input.voiceListening) return "LISTENING"
  if (input.workStatus === "failed") return "FAILED"
  if (input.workStatus === "cancelled") return "BLOCKED"
  if (input.workStatus === "completed") return "COMPLETED"
  if (input.trace?.phase) return PHASE_STATE[input.trace.phase] ?? "WAITING"
  return input.submitting ? "UNDERSTANDING" : "IDLE"
}
