import { getCurrentAccessToken } from "@/components/centropy/lib/centropy-auth"
import { centropyGet, CentropyApiError } from "@/components/centropy/lib/api"
import { parseInstructionEventPage, type InstructionEvent } from "@/components/centropy/product/instruction-event-model"

const TERMINAL = new Set(["completed", "failed", "cancelled"])
const PHASES = new Set([
  "received", "context_retrieved", "planning", "plan_ready", "clarification_required",
  "action_created", "action_gated", "dispatched", "executing", "step_progress",
  "verifying", "verified", "completed", "failed", "cancelled",
])

export interface InstructionTraceSnapshot {
  instructionId: string
  events: InstructionEvent[]
  sequence: number
  phase: string | null
  terminal: boolean
  transport: "connecting" | "sse" | "poll" | "stopped"
  error: string | null
}

/** Apply only contiguous persisted sequence numbers, so a late frame cannot regress or skip truth. */
export class InstructionEventLedger {
  private pending = new Map<number, InstructionEvent>()
  private ordered: InstructionEvent[] = []
  private cursor = 0
  private ended = false

  get sequence(): number { return this.cursor }
  get events(): InstructionEvent[] { return this.ordered }
  get phase(): string | null { return this.ordered.at(-1)?.phase ?? null }
  get terminal(): boolean { return this.ended }

  apply(incoming: InstructionEvent[]): boolean {
    let changed = false
    for (const event of incoming) {
      if (this.ended || event.seq <= this.cursor || event.seq > this.cursor + 500 || this.pending.has(event.seq)) continue
      this.pending.set(event.seq, event)
    }
    while (!this.ended) {
      const next = this.pending.get(this.cursor + 1)
      if (!next) break
      this.pending.delete(next.seq)
      this.cursor = next.seq
      this.ordered = [...this.ordered, next].slice(-500)
      this.ended = TERMINAL.has(next.phase)
      changed = true
    }
    return changed
  }
}

function parseStreamEvent(raw: string): InstructionEvent | null {
  let data = ""
  let id: number | null = null
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart()
    if (line.startsWith("id:")) id = Number(line.slice(3).trim())
  }
  if (!data) return null
  try {
    const event = JSON.parse(data) as Record<string, unknown>
    if (!Number.isInteger(event.seq) || Number(event.seq) < 1 || !PHASES.has(String(event.phase)) ||
      !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
      typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt)) ||
      (id !== null && id !== event.seq)) return null
    return event as unknown as InstructionEvent
  } catch { return null }
}

function pause(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

export class InstructionTraceRuntime {
  private ledger = new InstructionEventLedger()
  private controller: AbortController | null = null
  private active = false
  private transport: InstructionTraceSnapshot["transport"] = "connecting"
  private error: string | null = null

  constructor(
    readonly instructionId: string,
    private readonly onChange: (snapshot: InstructionTraceSnapshot) => void,
  ) {}

  get snapshot(): InstructionTraceSnapshot {
    return {
      instructionId: this.instructionId, events: this.ledger.events, sequence: this.ledger.sequence,
      phase: this.ledger.phase, terminal: this.ledger.terminal, transport: this.transport, error: this.error,
    }
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.onChange(this.snapshot)
    void this.streamThenPoll()
  }

  stop(): void {
    this.active = false
    this.controller?.abort()
    this.controller = null
    this.transport = "stopped"
    this.onChange(this.snapshot)
  }

  private update(transport?: InstructionTraceSnapshot["transport"], error?: string | null): void {
    if (transport) this.transport = transport
    if (error !== undefined) this.error = error
    this.onChange(this.snapshot)
  }

  private async streamThenPoll(): Promise<void> {
    let failures = 0
    while (this.active && !this.ledger.terminal && failures < 3) {
      const token = getCurrentAccessToken()
      if (!token) break
      this.controller = new AbortController()
      try {
        const response = await fetch(`/api/centropy/stream?instructionId=${encodeURIComponent(this.instructionId)}`, {
          headers: { authorization: `Bearer ${token}`, ...(this.ledger.sequence ? { "last-event-id": String(this.ledger.sequence) } : {}) },
          cache: "no-store", signal: this.controller.signal,
        })
        if (response.status === 404 && this.ledger.sequence === 0) {
          // The stream is opened before POST; the Work claim may not exist yet.
          failures += 1
          await pause(200)
          continue
        }
        if (!response.ok || !response.body) throw new Error(`Stream returned ${response.status}`)
        failures = 0
        this.update("sse", null)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (this.active && !this.ledger.terminal) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
          let boundary: number
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const event = parseStreamEvent(frame)
            if (event && this.ledger.apply([event])) this.update("sse", null)
          }
        }
        reader.releaseLock()
        if (!this.ledger.terminal && this.active) await pause(250)
      } catch (cause) {
        if (!this.active) return
        failures += 1
        this.update("connecting", cause instanceof Error ? cause.message : "Instruction stream disconnected")
        await pause(Math.min(250 * failures, 750))
      } finally {
        this.controller = null
      }
    }
    if (this.active && !this.ledger.terminal) await this.pollLoop()
    if (this.active && this.ledger.terminal) this.update("stopped", null)
  }

  private async pollLoop(): Promise<void> {
    this.update("poll", null)
    while (this.active && !this.ledger.terminal) {
      try {
        const raw = await centropyGet<unknown>(`instructions/${this.instructionId}/events`, {
          after: String(this.ledger.sequence), limit: "100",
        })
        const page = parseInstructionEventPage(raw)
        if (!page) throw new Error("Invalid persisted instruction event page")
        if (this.ledger.apply(page.events)) this.update("poll", null)
        if (page.hasMore) continue
        await pause(850)
      } catch (cause) {
        if (!this.active) return
        if (!(cause instanceof CentropyApiError && cause.status === 404 && this.ledger.sequence === 0)) {
          this.update("poll", cause instanceof Error ? cause.message : "Instruction events unavailable")
        }
        await pause(1500)
      }
    }
  }
}
