import type { InstructionState } from "../kernel/types"
import type { ThreadProgress } from "../kernel/store"

export type WorkspaceProgressStage =
  | "accepted"
  | "context"
  | "query"
  | "planning"
  | "authority"
  | "executing"
  | "verifying"
  | "recovery"
  | "completed"

export type WorkspaceProgressStatus = "complete" | "active" | "pending" | "not-applicable"

export interface WorkspaceProgressStep {
  key: WorkspaceProgressStage
  label: string
  status: WorkspaceProgressStatus
}

export interface WorkspaceProgressModel {
  activeStage: WorkspaceProgressStage
  activeLabel: string
  detail: string
  steps: WorkspaceProgressStep[]
}

export interface WorkspaceProgressInput {
  state: InstructionState
  actionCount: number
  expectedActionCount: number | null
  contextCount: number
  hasCanonicalQuery: boolean
  hasExternalEvidence: boolean
  progress?: ThreadProgress | null
  transportPosture?: "healthy" | "degraded" | "offline"
}

const FLOW: Array<{ key: WorkspaceProgressStage; label: string }> = [
  { key: "accepted", label: "Instruction accepted" },
  { key: "context", label: "Resolving context" },
  { key: "query", label: "Querying business / researching" },
  { key: "planning", label: "Planning" },
  { key: "authority", label: "Awaiting authority" },
  { key: "executing", label: "Executing" },
  { key: "verifying", label: "Verifying" },
  { key: "recovery", label: "Recovery" },
  { key: "completed", label: "Completed" },
]

function stageForState(state: InstructionState): WorkspaceProgressStage {
  switch (state) {
    case "captured": return "accepted"
    case "understanding": return "context"
    case "clarifying": return "context"
    case "planning": return "planning"
    case "awaiting_approval": return "authority"
    case "executing": return "executing"
    case "verifying": return "verifying"
    case "failed":
    case "partial":
    case "cancelled": return "recovery"
    case "completed": return "completed"
    default: return "accepted"
  }
}

function stageForInput(input: WorkspaceProgressInput): WorkspaceProgressStage {
  const stateStage = stageForState(input.state)
  if (["completed", "recovery", "verifying", "authority"].includes(stateStage)) return stateStage
  if (input.progress?.stage === "verified" || input.progress?.stage === "verifying") return "verifying"
  if (input.progress?.stage === "resolving_context" && ["accepted", "context"].includes(stateStage)) return "context"
  if (
    input.progress?.stage === "querying_business"
    || input.progress?.stage === "querying_grounded_sources"
    || input.progress?.stage === "researching_verified_external_sources"
  ) {
    // Research actions are planned first, then query the outside world while
    // their real executor is active. Keep the lifecycle monotonic while making
    // the exact backend activity visible.
    return stateStage === "executing" ? "executing" : "query"
  }
  return stateStage
}

function queryStatus(input: WorkspaceProgressInput, stageIndex: number, currentIndex: number): WorkspaceProgressStatus {
  if (input.hasCanonicalQuery || input.hasExternalEvidence) return currentIndex > stageIndex ? "complete" : currentIndex === stageIndex ? "active" : "pending"
  if (currentIndex >= FLOW.findIndex((step) => step.key === "authority") && currentIndex !== stageIndex) return "not-applicable"
  return currentIndex > stageIndex ? "pending" : "pending"
}

function detailFor(input: WorkspaceProgressInput, activeStage: WorkspaceProgressStage): string {
  const actionCount = input.actionCount
  const actionLabel = `action${actionCount === 1 ? "" : "s"}`
  const contextLabel = `${input.contextCount} context signal${input.contextCount === 1 ? "" : "s"}`

  if (input.progress?.stage === "researching_verified_external_sources" && activeStage === "executing") {
    return "Authenticated company context is bound. JARVIS is researching actual candidates and attaching verified WEB citations."
  }
  if (input.progress?.stage === "querying_business" && activeStage === "query") {
    return "The canonical tenant-local read model is being queried. Zero results will only be shown after the query completes."
  }
  if (input.progress?.stage === "querying_grounded_sources" && ["query", "executing"].includes(activeStage)) {
    return "Grounded sources are being queried through this durable Work; completion has not been inferred."
  }
  if (input.progress?.stage === "verified" && activeStage === "verifying") {
    return `${input.progress.sourceKind ?? "Attached"} evidence has been observed; JARVIS is closing the durable Work result.`
  }

  switch (input.state) {
    case "captured": return "The instruction is captured. Waiting for the live trace to acknowledge the Work."
    case "understanding": return `${contextLabel} attached; tenant, user, and referenced records are being resolved.`
    case "clarifying": return "One precise detail is required before JARVIS can commit a safe plan."
    case "planning":
      return input.expectedActionCount !== null
        ? `${actionCount} of ${input.expectedActionCount} ${actionLabel} received from the live plan.`
        : actionCount > 0
          ? `${actionCount} ${actionLabel} received; the live plan is still growing.`
          : "The live plan is still forming; no action has been committed yet."
    case "awaiting_approval": return `${actionCount} ${actionLabel} are ready for a recorded human decision. Nothing consequential runs before approval.`
    case "executing": return `${actionCount} ${actionLabel} are executing through the linked durable Work.`
    case "verifying": return "Execution has ended; JARVIS is reconciling observed outcomes and receipts."
    case "completed": return input.hasCanonicalQuery || input.hasExternalEvidence ? "Observed records and attached evidence are ready to inspect." : "The durable Work reached a completed terminal state."
    case "partial": return "The Work is partially complete. Only observed outcomes are shown; recovery stays attached to this Work."
    case "failed": return "The Work stopped safely. No unverified success is being shown."
    case "cancelled": return "The Work was cancelled before completion; its durable record remains available."
    default: return `Live Work state: ${activeStage}.`
  }
}

export function deriveWorkspaceProgress(input: WorkspaceProgressInput): WorkspaceProgressModel {
  const activeStage = stageForInput(input)
  const currentIndex = FLOW.findIndex((step) => step.key === activeStage)
  const queryIndex = FLOW.findIndex((step) => step.key === "query")
  const steps = FLOW.map((step, index): WorkspaceProgressStep => {
    if (step.key === "query") {
      return { ...step, status: queryStatus(input, queryIndex, currentIndex) }
    }
    if (step.key === "recovery" && !["failed", "partial", "cancelled"].includes(input.state)) {
      return { ...step, status: "not-applicable" }
    }
    if (step.key === "completed" && ["failed", "partial", "cancelled"].includes(input.state)) {
      return { ...step, status: "not-applicable" }
    }
    if (index < currentIndex) return { ...step, status: "complete" }
    if (index === currentIndex) return { ...step, status: "active" }
    return { ...step, status: "pending" }
  })

  const progressLabel = input.progress?.stage === "researching_verified_external_sources"
    ? "Researching verified external sources"
    : input.progress?.stage === "querying_business"
      ? "Querying canonical business records"
      : input.progress?.stage === "querying_grounded_sources"
        ? "Querying grounded sources"
        : input.progress?.stage === "verified" && activeStage === "verifying"
          ? "Evidence verified"
          : null

  return {
    activeStage,
    activeLabel: progressLabel ?? FLOW.find((step) => step.key === activeStage)?.label ?? "Live Work",
    detail: input.transportPosture === "offline"
      ? `${detailFor(input, activeStage)} Live trace is offline; completion is not inferred.`
      : detailFor(input, activeStage),
    steps,
  }
}

/** Turn a long answer into a few readable narrative blocks without changing its words. */
export function splitResearchNarrative(value: string): string[] {
  const normalized = value.replace(/\*\*/g, "").replace(/\s+/g, " ").trim()
  if (!normalized) return []
  const sentences = normalized.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [normalized]
  const chunks: string[] = []
  let current = ""
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence
    if (current && next.length > 300) {
      chunks.push(current)
      current = sentence
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}
