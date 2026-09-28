export interface InstructionEvent {
  seq: number
  phase: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface InstructionEventPage {
  events: InstructionEvent[]
  hasMore: boolean
  nextAfter: number | null
}

export interface InstructionEventDisplay {
  title: string
  detail: string | null
  tone: "neutral" | "active" | "waiting" | "success" | "failure"
}

const PHASES = new Set([
  "received", "context_retrieved", "planning", "plan_ready", "clarification_required",
  "action_created", "action_gated", "dispatched", "executing", "step_progress",
  "verifying", "verified", "completed", "failed", "cancelled",
])

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function small(value: unknown): string | null {
  const text = string(value)
  return text ? text.slice(0, 160) : null
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function parseInstructionEventPage(value: unknown): InstructionEventPage | null {
  const body = object(value)
  const page = object(body?.page)
  if (!Array.isArray(body?.events) || typeof page?.hasMore !== "boolean") return null
  const events: InstructionEvent[] = []
  for (const raw of body.events) {
    const row = object(raw)
    const payload = object(row?.payload)
    if (!row || !Number.isInteger(row.seq) || Number(row.seq) < 1 || !string(row.phase) || !PHASES.has(row.phase as string) || !string(row.createdAt) || Number.isNaN(Date.parse(row.createdAt as string)) || !payload) return null
    events.push({ seq: Number(row.seq), phase: row.phase as string, payload, createdAt: row.createdAt as string })
  }
  const nextAfter = page.nextAfter
  if (nextAfter !== null && nextAfter !== undefined && (!Number.isInteger(nextAfter) || Number(nextAfter) < 0)) return null
  if (page.hasMore && (nextAfter === null || nextAfter === undefined)) return null
  return { events, hasMore: page.hasMore, nextAfter: typeof nextAfter === "number" ? nextAfter : null }
}

export function mergeInstructionEvents(current: InstructionEvent[], incoming: InstructionEvent[], limit = 500): { events: InstructionEvent[]; omitted: boolean } {
  const bySequence = new Map(current.map((event) => [event.seq, event]))
  for (const event of incoming) if (!bySequence.has(event.seq)) bySequence.set(event.seq, event)
  const ordered = [...bySequence.values()].sort((a, b) => a.seq - b.seq)
  return { events: ordered.slice(-limit), omitted: ordered.length > limit }
}

export function instructionEventDisplay(event: InstructionEvent): InstructionEventDisplay {
  const action = small(event.payload.actionType)
  const actionId = small(event.payload.actionId)
  const route = small(event.payload.route)
  const stage = small(event.payload.stage)
  const error = small(event.payload.error)
  const result = object(event.payload.result)
  const answer = result?.kind === "answer"
  const answerTitle = small(object(result?.display)?.title)
  const count = typeof event.payload.count === "number" && Number.isFinite(event.payload.count) ? event.payload.count : null
  const actionDetail = action ? humanize(action) : actionId ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actionId) ? `Action ${actionId.slice(0, 8)}` : humanize(actionId) : null
  switch (event.phase) {
    case "received": return { title: "Instruction received", detail: null, tone: "neutral" }
    case "context_retrieved": return { title: "Context retrieved", detail: null, tone: "neutral" }
    case "planning": return { title: "Planning", detail: route ? humanize(route) : null, tone: "active" }
    case "plan_ready": return { title: "Plan recorded", detail: count !== null ? `${count} action${count === 1 ? "" : "s"}` : route ? humanize(route) : null, tone: "active" }
    case "clarification_required": return { title: "Clarification required", detail: small(event.payload.question), tone: "waiting" }
    case "action_created": return { title: "Action drafted", detail: actionDetail, tone: "neutral" }
    case "action_gated": return { title: "Human approval required", detail: actionDetail, tone: "waiting" }
    case "dispatched": return { title: "Action dispatched", detail: actionDetail, tone: "active" }
    case "executing": return { title: "Executing", detail: actionDetail, tone: "active" }
    case "step_progress": return { title: "Tool progress", detail: stage ? humanize(stage) : actionDetail, tone: "active" }
    case "verifying": return { title: "Checking result", detail: actionDetail, tone: "active" }
    case "verified": return { title: "Verification event recorded", detail: actionDetail, tone: "success" }
    case "completed": return answer
      ? { title: "Answer recorded", detail: answerTitle, tone: "success" }
      : { title: actionId ? "Action completed" : "Instruction completed", detail: actionDetail, tone: "success" }
    case "failed": return { title: actionId ? "Action failed" : "Instruction failed", detail: error ?? actionDetail, tone: "failure" }
    case "cancelled": return { title: "Instruction cancelled", detail: null, tone: "failure" }
    default: return { title: humanize(event.phase), detail: null, tone: "neutral" }
  }
}
