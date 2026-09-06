"use client"

// The Instruction Thread — blocks ①–⑦ (plan v3 §6, P2.T7/T8/T9/T10/T11).
//
// Each block is a plain content component; `Thread.tsx` owns collapse/expand
// (§2.2: "Blocks never disappear. They collapse to a 40 px summary row... and
// re-expand on click") and mounts the shared motions from `kernel/choreography.ts`.

import { useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { motion, useReducedMotion } from "framer-motion"
import type { Thread, ThreadNode } from "../kernel/store"
import {
  gateRiseVariants,
  contextConstellationChipVariants,
  planDrawEdgeVariants,
  planDrawNodeVariants,
  policyClampBracketVariants,
  policyClampVariants,
  questionFocusQuestionVariants,
  receiptSealVariants,
  blastRadiusDotVariants,
  BLAST_RADIUS_DOT_CAP,
} from "../kernel/choreography"
import { SIGNATURE_MOMENTS } from "../kernel/signature-moments"
import { sfx, stepCueThrottled } from "../sound"
import { useKernel } from "../kernel/store"
import { jarvisGet } from "../lib/api"
import { DecryptText } from "../ui/fx/DecryptText"
import { Press, Ticker } from "../ui/motion/primitives"
import { blastRadiusRecipientCount } from "../lib/risk-tier"
import { approvalConsequenceLines, approvalConsequenceSummary, bulkNotifyDelivery } from "./approval-consequence"
import { receiptCopyText, receiptHash } from "../lib/receipt-nav"
import { executionProgressForActions, runsForActionIds, type ActionExecutionState } from "../kernel/execution-presentation"
import type { LiveFrameIntentLaunch } from "../kernel/liveframe"
import { registerAnchor } from "../lib/pulse-bus"

// These surfaces are only reachable once an instruction is executing or has a
// receipt. Keep their existing implementations out of the initial Thread load.
const WorkflowTheater = dynamic(() => import("../panels/WorkflowTheater").then((m) => m.WorkflowTheater), { ssr: false })
const ReceiptContent = dynamic(() => import("../lib/ReceiptDrawer").then((m) => m.ReceiptContent), { ssr: false })
const ApprovalCockpit = dynamic(() => import("./ApprovalCockpit").then((m) => m.ApprovalCockpit), { ssr: false })

function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

function humanizeActionType(actionType: string): string {
  return actionType
    .replace(/^start_/, "")
    .replace(/_workflow$/, "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
}

function ThreadSignal({ children, tone = "cyan", role }: { children: React.ReactNode; tone?: "cyan" | "amber" | "red" | "green"; role?: "status" | "alert" }) {
  const toneClass = {
    cyan: "border-cyan-300/20 bg-cyan-300/[.05] text-cyan-100",
    amber: "border-amber-300/20 bg-amber-300/[.05] text-amber-100",
    red: "border-red-300/20 bg-red-300/[.05] text-red-100",
    green: "border-emerald-300/20 bg-emerald-300/[.05] text-emerald-100",
  }[tone]
  return (
    <div role={role} className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 j-fs-sm ${toneClass}`}>
      <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span>{children}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ① HEARD
// ---------------------------------------------------------------------------
export function ThreadHeard({
  thread,
  onCancel,
  onRetry,
  resuming = false,
  intentLaunch,
}: {
  thread: Thread
  onCancel: () => void
  onRetry: () => void | Promise<void>
  resuming?: boolean
  intentLaunch?: LiveFrameIntentLaunch | null
}) {
  const heardRef = useRef<HTMLDivElement | null>(null)
  const state = thread.machine.instructionState
  const failed = thread.machine.instructionState === "failed" && thread.nodes.length === 0 && thread.submitError
  const canCancel = !["completed", "failed", "partial", "cancelled", "stopping"].includes(state)

  useEffect(() => {
    if (!intentLaunch) return
    return registerAnchor("instruction-heard", () => heardRef.current?.getBoundingClientRect() ?? null)
  }, [intentLaunch])

  useEffect(() => {
    if (!intentLaunch) return
    const frame = window.requestAnimationFrame(() => heardRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [intentLaunch])

  return (
    <div ref={heardRef} tabIndex={-1} data-intent-launch={intentLaunch ? "accepted" : undefined} className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        {/* M3 EchoResolve (§5.3): char-scrambled -> resolved L->R, 24ms/char cap.
            Reduced motion renders the final text immediately (DecryptText's own
            contract). */}
        <p className="j-fs-xl font-extrabold text-[color:var(--j-text)]">
          <DecryptText text={thread.instructionText} mode="decrypt" charMs={24} />
        </p>
        {state === "captured" && !failed && (
          <ThreadSignal>
            {resuming ? "Your answer is captured. I’m continuing this thread from here." : "Captured. Waiting for JARVIS to acknowledge the instruction."}
          </ThreadSignal>
        )}
        {state === "stopping" && (
          <ThreadSignal>
            Cancellation requested. Waiting for the canonical Work state to confirm the stop.
          </ThreadSignal>
        )}
        {failed && (
          <ThreadSignal tone="red" role="alert">
            {thread.submitError ?? "I couldn't send that."}{" "}
            <Press className="inline-flex rounded-full">
              <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void onRetry()}>
                Retry
              </button>
            </Press>
          </ThreadSignal>
        )}
        {thread.cancelError && (
          <ThreadSignal tone="red" role="alert">
            {thread.cancelError}{" "}
            <Press className="inline-flex rounded-full">
              <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void onCancel()}>
                Try cancellation again
              </button>
            </Press>
          </ThreadSignal>
        )}
      </div>
      <span className="j-chip shrink-0 border border-white/10 bg-white/[.035] text-[color:var(--j-text-dim)]">{thread.source === "voice" ? "VOICE" : "TYPED"}</span>
      {canCancel && (
        <Press className="shrink-0 rounded-full">
          <button type="button" onClick={onCancel} className="j-fs-sm min-h-11 px-2 text-[color:var(--j-text-faint)] hover:text-[color:var(--j-text)]">
          Cancel
          </button>
        </Press>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ② UNDERSTOOD — P2 scope: "Context used" from the real plan response
// (groundedPayload), not real streamed per-event chips (that is P3's job — see
// PHASE 2's own "Exact user-visible result" carve-out in the plan).
// ---------------------------------------------------------------------------
export function ThreadUnderstood({ thread, reducedMotion }: { thread: Thread; reducedMotion: boolean }) {
  // jarvis-v3 P3.T7: real chips streamed in from `context_retrieved` trace events
  // (kernel/store.tsx's `applyTraceEvents`) lead the grid — M4 ContextGather fires
  // per chip as it actually arrives. The groundedPayload-derived chips (P2, from
  // the plan response) follow, additive — both are real, from different real
  // sources, never fabricated.
  const groundedChips = useMemo(() => {
    const out: { label: string; source: string }[] = []
    for (const node of thread.nodes) {
      for (const g of node.groundedPayload) {
        out.push({ label: `${g.field} · ${g.status.replace("_", " ")}`, source: "compiled plan · groundEntitiesWithDb" })
      }
    }
    return out
  }, [thread.nodes])
  const state = thread.machine.instructionState
  const initialContextKeysRef = useRef<Set<string> | null>(null)
  const animatedContextKeysRef = useRef<Set<string> | null>(null)
  if (initialContextKeysRef.current === null) {
    const keys = new Set(thread.contextChips.map((chip) => `${chip.label}·${chip.source}`))
    initialContextKeysRef.current = keys
    animatedContextKeysRef.current = new Set(keys)
  }
  const enteringContextKeys = new Set(
    thread.contextChips
      .map((chip) => `${chip.label}·${chip.source}`)
      .filter((key) => !animatedContextKeysRef.current?.has(key)),
  )

  useEffect(() => {
    const animated = animatedContextKeysRef.current
    if (!animated) return
    thread.contextChips.forEach((chip) => animated.add(`${chip.label}·${chip.source}`))
  }, [thread.contextChips])

  const liveContextChips = thread.contextChips

  return (
    <div>
      <div className="j-label mb-2">Context used</div>
      {liveContextChips.length === 0 && groundedChips.length === 0 ? (
        <ThreadSignal tone={state === "understanding" ? "cyan" : "amber"}>
          {state === "captured"
            ? "Context review starts after JARVIS acknowledges this instruction."
            : state === "understanding"
              ? "Checking the context JARVIS can verify. New facts appear here as they arrive."
              : state === "planning"
                ? "No context signal has arrived yet; the plan is still growing from live events."
                : "No additional business context was returned for this thread."}
        </ThreadSignal>
      ) : (
        <>
          {state === "understanding" && liveContextChips.length > 0 && <ThreadSignal>{`${liveContextChips.length} verified context fact${liveContextChips.length === 1 ? "" : "s"} received so far.`}</ThreadSignal>}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {liveContextChips.map((chip, index) => {
              const key = `${chip.label}·${chip.source}`
              return <ContextConstellationChip key={key} chip={chip} index={index} reducedMotion={reducedMotion} entering={enteringContextKeys.has(key)} />
            })}
            {groundedChips.map((chip, index) => (
              <div
                key={`grounded·${chip.label}·${chip.source}·${index}`}
                className="j-chip min-w-0 flex-col items-start justify-center border border-white/10 bg-white/[.035] text-[color:var(--j-text-dim)]"
                data-jarvis-fact
                data-source={`planned_action.groundedPayload · ${chip.source}`}
              >
                <span className="max-w-full truncate">{chip.label}</span>
                <span className="j-fs-micro max-w-full truncate text-[color:var(--j-text-faint)]">Verified plan context</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ContextConstellationChip({
  chip,
  index,
  reducedMotion,
  entering,
}: {
  chip: { label: string; source: string }
  index: number
  reducedMotion: boolean
  entering: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => registerAnchor(`instruction-context-${index}`, () => ref.current?.getBoundingClientRect() ?? null), [index])
  return (
    <motion.div
      ref={ref}
      {...contextConstellationChipVariants(index, reducedMotion, entering)}
      className="j-chip min-w-0 flex-col items-start justify-center border border-cyan-200/15 bg-cyan-300/[.045] text-[color:var(--j-text-dim)]"
      data-jarvis-context-fact
      data-jarvis-fact
      data-jarvis-signature-moment={entering ? "gather" : undefined}
      data-jarvis-signature-source={entering ? SIGNATURE_MOMENTS.gather.source : undefined}
      data-context-index={index}
      data-source={`instruction_events.context_retrieved · ${chip.source}`}
    >
      <span className="max-w-full truncate">{chip.label}</span>
      <span className="j-fs-micro max-w-full truncate text-[color:var(--j-text-faint)]">Verified business context</span>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// READ-ONLY ANSWER — a grounded conversational result is not a plan, an
// execution receipt, or an approval surface. It has no action controls.
// ---------------------------------------------------------------------------
export function ThreadAnswer({ thread }: { thread: Thread }) {
  const answer = thread.answerResult
  if (!answer) return null
  return (
    <div data-jarvis-answer data-source="instruction_events.completed.result">
      <div className="j-label mb-2">JARVIS</div>
      {answer.displaySummary && answer.displaySummary !== answer.spokenSummary && answer.displaySummary !== "JARVIS" && (
        <h3 className="j-fs-sm mb-2 font-semibold text-[color:var(--j-text-dim)]">{answer.displaySummary}</h3>
      )}
      <p className="j-fs-lg leading-relaxed text-[color:var(--j-text)]" data-jarvis-fact data-source="instruction_events.completed.result.spokenSummary">
        {answer.spokenSummary}
      </p>
      {answer.facts && answer.facts.length > 0 && (
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {answer.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`} className="rounded-lg border border-white/10 bg-white/[.035] px-3 py-2" data-jarvis-fact data-source={fact.source ?? "instruction_events.completed.result.facts"}>
              <dt className="j-fs-micro uppercase tracking-[0.14em] text-[color:var(--j-text-faint)]">{fact.label}</dt>
              <dd className="j-fs-sm mt-1 text-[color:var(--j-text-dim)]">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {answer.evidence && answer.evidence.length > 0 && (
        <div className="mt-4 border-t border-white/10 pt-3" data-jarvis-answer-evidence>
          <div className="j-fs-micro mb-2 uppercase tracking-[0.14em] text-[color:var(--j-text-faint)]">Sources</div>
          <ul className="grid gap-2">
            {answer.evidence.map((item) => {
              const isWebLink = /^https?:\/\//i.test(item.ref)
              const label = item.title ?? item.source.replaceAll("_", " ")
              return (
                <li key={`${item.source}:${item.ref}`} className="j-fs-sm flex min-w-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[.025] px-3 py-2">
                  {isWebLink ? <a className="min-w-0 truncate text-cyan-200 underline decoration-cyan-300/30 underline-offset-4 hover:text-cyan-100" href={item.ref} target="_blank" rel="noreferrer">{label}</a> : <span className="min-w-0 truncate text-[color:var(--j-text-dim)]">{label}</span>}
                  <span className="shrink-0 j-fs-micro text-[color:var(--j-text-faint)]">{item.source}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ③ PLAN
// ---------------------------------------------------------------------------
function policyLine(nodes: ThreadNode[], state: Thread["machine"]["instructionState"]): string {
  const policyStillArriving = state === "planning" && nodes.some((n) => n.policyVersion === null)
  if (policyStillArriving) return "Policy checks are still arriving for these actions; nothing will be sent before the approval boundary."
  const v0 = nodes.some((n) => n.policyVersion === 0)
  if (v0) return "No policy is configured for this yet, so I'm defaulting to asking you."
  const first = nodes[0]
  const name = first ? humanizeActionType(first.actionType).toLowerCase().replace(/\s+/g, "_") : "this_action"
  const version = first?.policyVersion ?? 1
  return `Every one of these needs your approval — policy ${name} v${version} requires it for anything that moves money.`
}

interface PlanDependencyEdge {
  key: string
  source: ThreadNode
  target: ThreadNode
}

function planDependencyEdges(nodes: ThreadNode[]): PlanDependencyEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const edges: PlanDependencyEdge[] = []
  for (const target of nodes) {
    if (!Array.isArray(target.dependsOn)) continue
    for (const sourceId of target.dependsOn) {
      const source = byId.get(sourceId)
      if (!source || source.id === target.id) continue
      const key = `${source.id}→${target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ key, source, target })
    }
  }
  return edges
}

function planNodeLabel(node: ThreadNode): string {
  return `${humanizeActionType(node.actionType)}${node.targetLabel ? ` · ${node.targetLabel}` : ""}`
}

function PlanDependencyEdge({ edge, reducedMotion, entering }: { edge: PlanDependencyEdge; reducedMotion: boolean; entering: boolean }) {
  return (
    <motion.div
      {...planDrawEdgeVariants(reducedMotion, entering)}
      className="ml-3 flex min-h-7 origin-top items-center gap-2 border-l-2 border-cyan-200/30 pl-3"
      data-jarvis-plan-edge={`${edge.source.id}->${edge.target.id}`}
      data-source="domain_actions.depends_on"
      aria-label={`Plan dependency: ${planNodeLabel(edge.target)} waits for ${planNodeLabel(edge.source)}`}
    >
      <span aria-hidden className="text-cyan-200/70">↳</span>
      <span className="j-fs-micro text-[color:var(--j-text-faint)]">After {planNodeLabel(edge.source)}</span>
    </motion.div>
  )
}

export function ThreadPlan({ thread, reducedMotion, restored = false }: { thread: Thread; reducedMotion: boolean; restored?: boolean }) {
  const state = thread.machine.instructionState
  const clampActive = state === "awaiting_approval"
  const edges = useMemo(() => planDependencyEdges(thread.nodes), [thread.nodes])
  const initialNodeIdsRef = useRef<Set<string> | null>(null)
  const initialEdgeKeysRef = useRef<Set<string> | null>(null)
  if (initialNodeIdsRef.current === null) initialNodeIdsRef.current = new Set(thread.nodes.map((node) => node.id))
  if (initialEdgeKeysRef.current === null) initialEdgeKeysRef.current = new Set(edges.map((edge) => edge.key))
  const enteringNodeIds = new Set(thread.nodes.map((node) => node.id).filter((id) => !initialNodeIdsRef.current?.has(id)))
  const enteringEdgeKeys = new Set(edges.map((edge) => edge.key).filter((key) => !initialEdgeKeysRef.current?.has(key)))

  useEffect(() => {
    thread.nodes.forEach((node) => initialNodeIdsRef.current?.add(node.id))
    edges.forEach((edge) => initialEdgeKeysRef.current?.add(edge.key))
  }, [edges, thread.nodes])

  if (state === "captured" || state === "understanding") {
    return (
      <div>
        <div className="j-label mb-2">What I&rsquo;ll do</div>
        <ThreadSignal>
          {state === "captured" ? "Waiting for acknowledgement before planning continues." : "Context review is still in progress; no plan has been committed yet."}
        </ThreadSignal>
      </div>
    )
  }
  if (state === "failed" && thread.nodes.length === 0) {
    return (
      <div>
        <div className="j-label mb-2">What I&rsquo;ll do</div>
        <ThreadSignal tone="red" role="alert">I couldn&rsquo;t turn that into a runnable plan.</ThreadSignal>
        <p className="j-fs-sm mt-2 text-[color:var(--j-text-dim)]">Try naming a customer, an invoice, or a time window.</p>
      </div>
    )
  }
  return (
    <div>
      <div className="j-label mb-2">What I&rsquo;ll do</div>
      {state === "planning" && (
        <ThreadSignal>
          {thread.traceGating.expectedCount !== null
            ? `${thread.nodes.length} of ${thread.traceGating.expectedCount} action${thread.traceGating.expectedCount === 1 ? "" : "s"} received from the live plan.`
            : thread.nodes.length > 0
              ? `${thread.nodes.length} action${thread.nodes.length === 1 ? "" : "s"} received. The plan is still growing.`
              : "Waiting for the first action from the live plan."}
        </ThreadSignal>
      )}
      {state === "awaiting_approval" && <ThreadSignal tone="amber">The plan is ready. Review the real actions before anything is sent.</ThreadSignal>}
      <div className="space-y-2" data-jarvis-plan-graph>
        {thread.nodes.map((n) => {
          const inbound = edges.filter((edge) => edge.target.id === n.id)
          const entering = enteringNodeIds.has(n.id)
          return (
            <div key={n.id} className="space-y-1" data-jarvis-plan-action={n.id}>
              {inbound.map((edge) => (
                <PlanDependencyEdge key={edge.key} edge={edge} reducedMotion={reducedMotion} entering={enteringEdgeKeys.has(edge.key)} />
              ))}
              <motion.div
                {...planDrawNodeVariants(reducedMotion, entering)}
                className="j-panel flex items-center justify-between gap-3 rounded-xl border border-white/8 px-3 py-2.5"
                data-jarvis-fact
                data-jarvis-plan-node={n.id}
                data-jarvis-plan-node-entering={entering ? "true" : "false"}
                data-jarvis-signature-moment={entering ? "draw" : undefined}
                data-jarvis-signature-source={entering ? SIGNATURE_MOMENTS.draw.source : undefined}
                data-source="instruction_events.action_created · domain_actions"
              >
                <span className="j-fs-base text-[color:var(--j-text)]">{planNodeLabel(n)}</span>
                {n.amountUsd !== null && <span className="j-fs-base font-bold tabular-nums text-[color:var(--j-green)]">{formatUsd(n.amountUsd)}</span>}
              </motion.div>
            </div>
          )
        })}
      </div>
      {thread.nodes.length > 0 && (
        // M6 PolicyClamp (§5.3): a 2px amber bracket draws top->bottom, block
        // shifts right 4px, 300ms EASE_IO.
        <motion.div
          {...policyClampVariants(reducedMotion, clampActive, restored)}
          className="relative mt-3 pl-3"
          data-jarvis-policy-clamp={clampActive ? "active" : "settled"}
          data-jarvis-policy-source={SIGNATURE_MOMENTS.clamp.source}
        >
          <motion.span
            {...policyClampBracketVariants(reducedMotion, clampActive, restored)}
            aria-hidden
            className="absolute inset-y-0 left-0 w-[2px]"
            style={{ background: "var(--j-amber)", transformOrigin: "top" }}
          />
          <p className="j-fs-sm text-[color:var(--j-text-dim)]" data-jarvis-fact data-source="thread.nodes[].policyVersion">{policyLine(thread.nodes, state)}</p>
        </motion.div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ④ CLARIFY — never Approve/Reject (C-07). Answer/Skip/Cancel only.
// ---------------------------------------------------------------------------
export function ThreadClarify({ thread, onAnswer, onSkip, onCancel }: { thread: Thread; onAnswer: (text: string) => void; onSkip: () => void; onCancel: () => void }) {
  const clarification = thread.clarification
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [why, setWhy] = useState(false)
  const firstInputRef = useRef<HTMLInputElement | null>(null)
  const questionRef = useRef<HTMLParagraphElement | null>(null)
  const reducedMotion = useReducedMotion() ?? false
  const questionId = `thread-${thread.id}-clarification-question`
  const questionKey = clarification ? `${thread.id}:${clarification.question}:${clarification.missingFields.join("|")}` : ""

  useEffect(() => {
    if (!clarification) return
    const frame = window.requestAnimationFrame(() => {
      const target = firstInputRef.current ?? questionRef.current
      if (!target) return
      const active = document.activeElement
      const isInteractive = active instanceof HTMLElement && active !== document.body && Boolean(active.closest("input, textarea, button, select, [contenteditable='true'], [data-jarvis-command-rail]"))
      const focusIsInsideCollapsingBody = active instanceof HTMLElement && Boolean(active.closest("[data-thread-block-body-collapsed='true']"))
      target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" })
      if (!isInteractive || focusIsInsideCollapsingBody) target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [clarification, questionKey, reducedMotion])

  if (!clarification) return null

  const submit = () => {
    const text = clarification.missingFields.length <= 1 ? Object.values(answers)[0] ?? "" : clarification.missingFields.map((f) => `${f}: ${answers[f] ?? ""}`).join("; ")
    if (!text.trim()) return
    onAnswer(text)
  }

  return (
    <div data-jarvis-clarification>
      <div className="j-label mb-2">I need one thing</div>
      <motion.p
        ref={questionRef}
        {...questionFocusQuestionVariants(reducedMotion, true)}
        id={questionId}
        tabIndex={-1}
        className="j-fs-lg font-bold text-[color:var(--j-text)] outline-none"
        aria-live="polite"
        data-jarvis-clarification-question
      >{clarification.question}</motion.p>
      <div className="mt-3 space-y-2">
        {clarification.missingFields.map((field, i) => (
          <input
            key={field}
            ref={i === 0 ? firstInputRef : undefined}
            value={answers[field] ?? ""}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [field]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={field}
            aria-label={field}
            aria-describedby={questionId}
            data-jarvis-clarification-input
            className="j-fs-base h-12 w-full rounded-lg border border-white/10 bg-white/[.035] px-3 text-[color:var(--j-text)] outline-none focus:border-cyan-300/50"
          />
        ))}
      </div>
      {clarification.context && (
        <div className="mt-2">
          <button type="button" className="inline-flex min-h-11 items-center px-1 j-fs-sm text-[color:var(--j-text-faint)] underline" onClick={() => setWhy((w) => !w)}>
            Why I&rsquo;m asking
          </button>
          {why && <p className="j-fs-sm mt-1 text-[color:var(--j-text-dim)]">{clarification.context}</p>}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Press className="rounded-full">
          <button type="button" onClick={submit} className="j-chip min-h-11 border border-cyan-300/30 bg-cyan-400/10 px-4 text-cyan-200">
            Answer
          </button>
        </Press>
        <Press className="rounded-full">
          <button type="button" onClick={onSkip} className="j-chip min-h-11 border border-white/10 bg-white/[.035] px-4 text-[color:var(--j-text-dim)]">
            Skip
          </button>
        </Press>
        <Press className="rounded-full">
          <button type="button" onClick={onCancel} className="j-chip min-h-11 border border-white/10 bg-white/[.035] px-4 text-[color:var(--j-text-dim)]">
            Cancel
          </button>
        </Press>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// M8 BlastRadius's count-up half (§5.3: "the count... counts up 0->N over
// 520 ms"). Reuses the existing `<Ticker>` primitive (ui/motion/primitives.tsx,
// already used elsewhere in this exact cockpit for a live batch count) rather
// than a second numeric-spring implementation — mounted at 0 (or straight at
// the real count under reduced motion) then flipped to the real value one
// frame later, letting Ticker's own spring carry it the rest of the way.
function BlastRadiusCount({ count, reduced, restored }: { count: number; reduced: boolean; restored: boolean }) {
  const [value, setValue] = useState(reduced || restored ? count : 0)
  useEffect(() => {
    if (reduced || restored) {
      setValue(count)
      return
    }
    const raf = requestAnimationFrame(() => setValue(count))
    return () => cancelAnimationFrame(raf)
  }, [count, reduced, restored])
  return <Ticker value={value} />
}

// jarvis-v3 P5.T3 — M8 BlastRadius, real recipient count (§5.3/§8 P5
// Architecture: "driven by the real recipient count from the action
// payload... if the backend does not return a count, the header reads 'an
// unknown number of customers'"). Scoped exactly to the one real per-action
// blast-radius case this repo has (`bulk_notify_existing_customers`'s own
// `targets[]`, attached to the payload by `draft()` — verified from source)
// — any other single-node thread falls through to the action-type consequence
// list below, never invented for action types that don't carry this shape.
function BlastRadiusHeader({ count, channel, reducedMotion, restored }: { count: number | null; channel: unknown; reducedMotion: boolean; restored: boolean }) {
  const delivery = bulkNotifyDelivery({ channel })
  if (count === null) {
    return (
      <p className="j-fs-base font-bold text-amber-200">An unknown number of customers will be {delivery.verb}.</p>
    )
  }
  const dotCount = Math.min(count, BLAST_RADIUS_DOT_CAP)
  return (
    <p className="j-fs-base flex flex-wrap items-center gap-2 font-bold text-[color:var(--j-text)]">
      <span>
        <BlastRadiusCount count={count} reduced={reducedMotion} restored={restored} /> customer{count === 1 ? "" : "s"} will be {delivery.verb} via {delivery.noun}
      </span>
      {dotCount > 0 && (
        <span className="inline-flex flex-wrap items-center gap-0.5" aria-hidden>
          {Array.from({ length: dotCount }).map((_, i) => (
            <motion.span key={i} {...blastRadiusDotVariants(i, reducedMotion, restored)} className="h-1 w-1 rounded-full bg-amber-300/70" />
          ))}
        </span>
      )}
    </p>
  )
}

function KnownConsequenceFacts({
  summary,
  hideRecipients = false,
}: {
  summary: ReturnType<typeof approvalConsequenceSummary>
  hideRecipients?: boolean
}) {
  const facts: string[] = []
  if (!hideRecipients && summary.recipientCount !== null) {
    facts.push(`${summary.recipientCount} recipient${summary.recipientCount === 1 ? "" : "s"} in scope`)
  }
  if (summary.totalAmountUsd !== null) facts.push(`known total ${formatUsd(summary.totalAmountUsd)}`)
  if (summary.policyVersions.length > 0) {
    facts.push(summary.policyVersions.length === 1 ? `policy v${summary.policyVersions[0]}` : `policies v${summary.policyVersions.join(", v")}`)
  }
  if (facts.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Known approval consequence facts" data-jarvis-fact data-source="thread.nodes">
      {facts.map((fact) => <span key={fact} className="rounded-full border border-white/10 bg-white/[.035] px-2.5 py-1 j-fs-micro font-bold text-[color:var(--j-text-dim)]">{fact}</span>)}
    </div>
  )
}

// ⑤ APPROVAL — depth 2. The physical cockpit is still the shared
// `ApprovalCockpit`, but its queue is explicitly scoped to this thread's real
// action ids/instruction id. The header is derived from those same action types
// and payloads, so it never borrows invoice/customer-texting copy from another
// thread shape.
// ---------------------------------------------------------------------------
export function ThreadApprovalCockpit({ thread, onClose, reducedMotion, escalateOnly = false, restored = false }: { thread: Thread; onClose: () => void; reducedMotion: boolean; escalateOnly?: boolean; restored?: boolean }) {
  const rise = gateRiseVariants(reducedMotion, restored)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  // A "blast" thread is exactly one node whose action type carries a real
  // per-action recipient list — today, only bulk_notify_existing_customers.
  // Every other shape (the golden journey's own N-separate-actions case,
  // Flagship B's per-node cards, etc.) uses the action-type consequence list.
  const blastNode = thread.nodes.length === 1 && thread.nodes[0]!.actionType === "bulk_notify_existing_customers" ? thread.nodes[0]! : null
  const blastCount = blastNode ? blastRadiusRecipientCount(blastNode.payload) : undefined
  const consequenceLines = blastNode ? [] : approvalConsequenceLines(thread.nodes)
  const consequenceSummary = approvalConsequenceSummary(thread.nodes)
  // §5.4: "propose | cockpit rises | two-note rising, brighter."
  useEffect(() => {
    if (restored) return
    sfx.propose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, thread.id])
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [restored, thread.id])
  return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        data-thread-approval-motion={restored ? "settled" : "entering"}
        data-jarvis-approval-cockpit
        data-jarvis-signature-moment={restored ? undefined : "clamp"}
        data-jarvis-signature-source={restored ? undefined : SIGNATURE_MOMENTS.clamp.source}
        role="dialog"
      aria-modal="true"
      aria-labelledby={`thread-${thread.id}-approval-heading`}
      data-liveframe-motion="LF-08"
      data-liveframe-focus="approval"
      className="jarvis-approval-overlay fixed inset-0 z-40 flex items-start justify-center overscroll-contain overflow-y-auto bg-black/35 px-4 pt-[max(8vh,4rem)] pb-[calc(8rem+env(safe-area-inset-bottom))] touch-pan-y"
      style={{ backdropFilter: "blur(20px)" }}
      onMouseDown={onClose}
    >
      {/* M7 CockpitRise (§5.3): translateY(24px)->0, 380ms EASE_OUT. */}
      <motion.div
        initial={rise.initial}
        animate={rise.animate}
        transition={rise.transition}
        className="jarvis-approval-stage w-full max-w-[1180px]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="jarvis-approval-brief j-panel rounded-xl border border-amber-300/20 px-4 py-3" data-liveframe-gate-rise>
          <h2 ref={headingRef} id={`thread-${thread.id}-approval-heading`} tabIndex={-1} className="sr-only outline-none">Needs your approval</h2>
          {blastNode ? (
            <BlastRadiusHeader count={blastCount ?? null} channel={blastNode.payload.channel} reducedMotion={reducedMotion} restored={restored} />
          ) : (
            <div data-jarvis-fact data-source="thread.nodes">
              <p className="j-fs-base font-bold text-[color:var(--j-text)]">
                {consequenceSummary.actionCount} action{consequenceSummary.actionCount === 1 ? "" : "s"} need{consequenceSummary.actionCount === 1 ? "s" : ""} your approval
              </p>
              {consequenceLines.length > 0 && (
                <ul className="mt-1 space-y-1 pl-4 j-fs-sm text-[color:var(--j-text-dim)]">
                  {consequenceLines.map((line) => <li key={line} className="list-disc">{line}</li>)}
                </ul>
              )}
            </div>
          )}
          <KnownConsequenceFacts summary={consequenceSummary} hideRecipients={Boolean(blastNode)} />
        </div>
        <ApprovalCockpit
          escalateOnly={escalateOnly}
          scopeActionIds={thread.nodes.map((node) => node.id)}
          scopeInstructionId={thread.instructionId}
          restored={restored}
        />
      </motion.div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// ⑥ EXECUTION — real `WorkflowTheater`, reused unmodified.
// ---------------------------------------------------------------------------
export type ExecutionWeavePlacement = "document" | "side"

export function ThreadExecution({ thread, restored = false, executionWeavePlacement = "document", energy = 0 }: { thread: Thread; restored?: boolean; executionWeavePlacement?: ExecutionWeavePlacement; energy?: number }) {
  // §4.7's "one fact, one selector" bans `useJarvis()` outside `kernel/` — this
  // isn't a displayed fact, just sound-cue bookkeeping, but the rule is a
  // blanket ban with no such carve-out. `kernel.selectorInput.runs` is the
  // sanctioned bridge (`useSelectorInput.ts`) exposing the SAME list.
  const kernel = useKernel()
  const actionIds = useMemo(() => thread.nodes.map((node) => node.id), [thread.nodes])
  const linkedRuns = useMemo(
    () => runsForActionIds([...kernel.selectorInput.runs, ...(kernel.selectorInput.terminalRuns ?? [])], actionIds),
    [kernel.selectorInput.runs, kernel.selectorInput.terminalRuns, actionIds],
  )
  const blockedActionIds = useMemo(
    () => (kernel.selectorInput.blockedActions ?? []).map((action) => action.id).filter((id) => actionIds.includes(id)),
    [actionIds, kernel.selectorInput.blockedActions],
  )
  const progress = useMemo(
    () => executionProgressForActions(actionIds, [...kernel.selectorInput.runs, ...(kernel.selectorInput.terminalRuns ?? [])], thread.traceGating, blockedActionIds),
    [blockedActionIds, kernel.selectorInput.runs, kernel.selectorInput.terminalRuns, actionIds, thread.traceGating],
  )
  const stepsSeenRef = useMemoStepTracker(linkedRuns, restored)
  useEffect(() => {
    if (stepsSeenRef.fired) stepCueThrottled()
  }, [stepsSeenRef.fired])
  const state = thread.machine.instructionState
  if (state === "awaiting_approval" && thread.everExecuted) {
    return (
      <div>
        <div className="j-label mb-2">Execution paused</div>
        <ThreadSignal tone="amber" role="status">A real execution signal asked for human review. The thread is paused here until the decision above is resolved.</ThreadSignal>
      </div>
    )
  }
  if (state !== "executing" && state !== "verifying") return null
  return (
    <div>
      <div className="j-label mb-2">{state === "verifying" ? "Checking the result" : "Doing it"}</div>
      <ThreadSignal tone={state === "verifying" ? "green" : "cyan"} role="status">
        {state === "verifying"
          ? "Execution returned. JARVIS is checking the recorded outcome before sealing the receipt."
            : progress.linkedActions > 0 && progress.unresolvedActions === 0
            ? `${progress.completedActions} of ${progress.totalActions} action${progress.totalActions === 1 ? "" : "s"} outcome${progress.totalActions === 1 ? "" : "s"} recorded${progress.failedActions > 0 ? ` · ${progress.failedActions} failed` : ""}${progress.compensatingActions > 0 ? ` · ${progress.compensatingActions} rolling back` : ""}${progress.blockedActions > 0 ? ` · ${progress.blockedActions} blocked` : ""} for this instruction.`
            : linkedRuns.length > 0
              ? `${linkedRuns.length} real workflow run${linkedRuns.length === 1 ? "" : "s"} reported for this instruction.`
              : "Approval landed. Waiting for the connected workflow lane to report a real run."}
      </ThreadSignal>
      {executionWeavePlacement === "document" && (
        <WorkflowTheater
          actionIds={actionIds}
          blockedActionIds={blockedActionIds}
          traceOutcomes={thread.traceGating}
          energy={energy}
        />
      )}
    </div>
  )
}

/** The same action-ID-scoped theater, composed into LIVEFRAME's desktop right
 * plane. It only mounts for an observed linked run; the in-document execution
 * signal remains mounted while the run is still pending or absent. */
export function ThreadExecutionWeave({ thread, restored = false, energy = 0 }: { thread: Thread; restored?: boolean; energy?: number }) {
  const kernel = useKernel()
  const actionIds = useMemo(() => thread.nodes.map((node) => node.id), [thread.nodes])
  const linkedRuns = useMemo(
    () => runsForActionIds([...kernel.selectorInput.runs, ...(kernel.selectorInput.terminalRuns ?? [])], actionIds),
    [actionIds, kernel.selectorInput.runs, kernel.selectorInput.terminalRuns],
  )
  const blockedActionIds = useMemo(
    () => (kernel.selectorInput.blockedActions ?? []).map((action) => action.id).filter((id) => actionIds.includes(id)),
    [actionIds, kernel.selectorInput.blockedActions],
  )
  if ((thread.machine.instructionState !== "executing" && thread.machine.instructionState !== "verifying") || linkedRuns.length === 0) return null
  return (
    <aside className="jarvis-execution-weave-plane" data-liveframe-surface="execution-weave" data-weave-placement="side" aria-label="Execution Weave">
      <WorkflowTheater actionIds={actionIds} blockedActionIds={blockedActionIds} traceOutcomes={thread.traceGating} energy={energy} />
      <span className="sr-only">This workflow is linked to the current instruction.</span>
      {restored && <span className="sr-only">Restored from the recorded instruction state.</span>}
    </aside>
  )
}

// Tiny local hook: fires `stepCueThrottled()` once per newly-completed step
// across any run, without duplicating WorkflowTheater's own step-completed
// bookkeeping. A restored snapshot seeds status without a cue; a later real
// non-completed -> completed transition still receives the same one-shot cue.
// Kept file-local (§0.1 permits a small inline helper).
function useMemoStepTracker(runs: { steps: { id: string; status: string }[] }[], restored: boolean) {
  const [fired, setFired] = useState(0)
  const statusRef = useMemoRef(new Map<string, string>())
  useEffect(() => {
    let newlyDone = false
    for (const run of runs) {
      for (const step of run.steps) {
        const previousStatus = statusRef.current.get(step.id)
        if (step.status === "completed" && previousStatus !== "completed" && (!restored || previousStatus !== undefined)) {
          newlyDone = true
        }
        statusRef.current.set(step.id, step.status)
      }
    }
    if (newlyDone) setFired((f) => f + 1)
  }, [restored, runs, statusRef])
  return { fired }
}

function useMemoRef<T>(initial: T): { current: T } {
  const ref = useState(() => ({ current: initial }))[0]
  return ref
}

// `ReceiptContent` (T11's reuse target) fetches by `decisionReceipts.id` via
// `GET /api/receipts/:id` — NOT the same id as a `domain_action`. The response
// this phase has never carries that receipt id directly, but the real,
// allowlisted `GET /api/receipts?domainActionId=` lookup (verified:
// `finnor-os/apps/api/app/api/receipts/route.ts`) resolves it — one extra real
// fetch per node, once the thread is terminal, no fabrication.
function useNodeReceiptIds(nodeIds: string[], enabled: boolean, refreshKey: number): Record<string, string> {
  const [ids, setIds] = useState<Record<string, string>>({})
  const idsRef = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!enabled || nodeIds.length === 0) return
    let cancelled = false
    const unresolved = nodeIds.filter((nodeId) => !idsRef.current[nodeId])
    void Promise.all(
      unresolved.map(async (nodeId) => {
        try {
          const res = await jarvisGet<{ receipts: Array<{ id: string }> }>("receipts", { domainActionId: nodeId })
          const first = res.receipts[0]
          if (first && !cancelled) {
            idsRef.current = { ...idsRef.current, [nodeId]: first.id }
            setIds((prev) => ({ ...prev, [nodeId]: first.id }))
          }
        } catch {
          // No receipt yet for this node (e.g. it never reached execution) —
          // the honest fallback (no deep-link for that node) below handles it.
        }
      }),
    )
    return () => {
      cancelled = true
    }
  }, [nodeIds, enabled, refreshKey])
  return ids
}

function actionStatusLabel(status: ActionExecutionState): string {
  switch (status) {
    case "completed": return "sent"
    case "failed": return "couldn’t send"
    case "blocked": return "blocked"
    case "paused": return "paused"
    case "running": return "running"
    case "compensating": return "rolling back"
    case "compensated": return "rolled back"
    case "cancelled": return "cancelled"
    case "escalated": return "escalated"
    case "unobserved": return "outcome not observed"
  }
}

function actionLabel(node: ThreadNode): string {
  return `${humanizeActionType(node.actionType)}${node.targetLabel ? ` · ${node.targetLabel}` : ""}${node.amountUsd !== null ? ` · ${formatUsd(node.amountUsd)}` : ""}`
}

function receiptOutcome(progress: ReturnType<typeof executionProgressForActions>): string {
  const total = progress.totalActions
  if (total === 0) return "No runnable action was recorded for this instruction."
  const noun = total === 1 ? "action" : "actions"
  const details = [
    progress.failedActions > 0 ? `${progress.failedActions} couldn’t be sent` : null,
    progress.blockedActions > 0 ? `${progress.blockedActions} blocked before a workflow run` : null,
    progress.compensatingActions > 0 ? `${progress.compensatingActions} rolling back` : null,
    progress.compensatedActions > 0 ? `${progress.compensatedActions} rolled back` : null,
    progress.cancelledActions > 0 ? `${progress.cancelledActions} cancelled` : null,
    progress.escalatedActions > 0 ? `${progress.escalatedActions} escalated` : null,
    progress.unresolvedActions > 0 ? `${progress.unresolvedActions} outcome${progress.unresolvedActions === 1 ? "" : "s"} not observed` : null,
  ].filter((detail): detail is string => detail !== null)
  const suffix = details.length > 0 ? ` · ${details.join(" · ")}` : ""
  return `${progress.completedActions} of ${total} ${noun} sent${suffix}.`
}

// ---------------------------------------------------------------------------
// ⑦ RECEIPT
// ---------------------------------------------------------------------------
export function ThreadReceipt({ thread, reducedMotion, onRetry, restored = false }: { thread: Thread; reducedMotion: boolean; onRetry: () => void | Promise<void>; restored?: boolean }) {
  const kernel = useKernel()
  const state = thread.machine.instructionState
  const isTerminal = state === "completed" || state === "partial" || state === "failed" || state === "cancelled"
  const nodeIds = useMemo(() => thread.nodes.map((n) => n.id), [thread.nodes])
  const receiptIds = useNodeReceiptIds(nodeIds, isTerminal, thread.receiptRefreshTick)
  const progress = useMemo(
    () => executionProgressForActions(nodeIds, [...kernel.selectorInput.runs, ...(kernel.selectorInput.terminalRuns ?? [])], thread.traceGating),
    [kernel.selectorInput.runs, kernel.selectorInput.terminalRuns, nodeIds, thread.traceGating],
  )
  const [copiedReceiptId, setCopiedReceiptId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  if (!isTerminal) return null

  if (state === "cancelled") {
    return (
      <div>
        <div className="j-label mb-2">What actually happened</div>
        <p className="j-fs-base text-[color:var(--j-text-dim)]">{thread.everExecuted ? "Cancelled — no further action was sent after execution paused." : "Cancelled — nothing was sent."}</p>
      </div>
    )
  }

  const outcome = receiptOutcome(progress)

  async function copyReceipt(receiptId: string, node: ThreadNode) {
    const href = new URL(`/jarvis${receiptHash(receiptId)}`, window.location.origin).toString()
    const status = actionStatusLabel(progress.actionStates[node.id] ?? "unobserved")
    const text = receiptCopyText({ receiptId, objective: actionLabel(node), outcome: status, href })
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const input = document.createElement("textarea")
        input.value = text
        input.setAttribute("readonly", "")
        input.style.position = "fixed"
        input.style.opacity = "0"
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand("copy")
        input.remove()
        if (!copied) throw new Error("clipboard unavailable")
      }
      setCopyError(null)
      setCopiedReceiptId(receiptId)
      window.setTimeout(() => setCopiedReceiptId((current) => current === receiptId ? null : current), 1600)
    } catch {
      setCopyError("Couldn’t copy the receipt summary.")
    }
  }

  return (
    <motion.div
      {...receiptSealVariants(reducedMotion, restored)}
      data-thread-receipt-motion={restored ? "settled" : "entering"}
      data-jarvis-signature-moment={!restored && (state === "completed" || state === "partial") ? "settle" : undefined}
      data-jarvis-signature-source={!restored && (state === "completed" || state === "partial") ? SIGNATURE_MOMENTS.settle.source : undefined}
    >
      <div className="j-label mb-2">What actually happened</div>
      <p className="j-fs-base text-[color:var(--j-text)]" data-jarvis-fact data-source="thread.nodes">
        {outcome}
      </p>
      {state === "failed" && (
        <ThreadSignal tone="red" role="alert">
          The instruction stopped before JARVIS could complete it.{" "}
          <Press className="inline-flex rounded-full">
            <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void onRetry()}>Try again</button>
          </Press>
        </ThreadSignal>
      )}
      {thread.receiptRefreshTick > 0 && (
        <p className="mt-2 rounded-lg border border-emerald-300/20 bg-emerald-300/[.05] px-3 py-2 j-fs-sm text-emerald-100" data-testid="receipt-consequence-update">
          Payment update received — this receipt and the downstream totals were refreshed.
        </p>
      )}
      {copyError && <p role="status" className="mt-2 j-fs-micro text-amber-200">{copyError}</p>}
      <ul className="mt-3 space-y-1">
        {thread.nodes.map((n) =>
          receiptIds[n.id] ? (
            <li key={n.id} id={`receipt-${receiptIds[n.id]}`} data-jarvis-fact data-source="thread.nodes">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="j-fs-sm text-[color:var(--j-text-dim)]">
                  {actionLabel(n)} · {actionStatusLabel(progress.actionStates[n.id] ?? "unobserved")}
                </span>
                <span className="flex items-center gap-2">
                  <a href={`/jarvis${receiptHash(receiptIds[n.id])}`} className="inline-flex min-h-11 items-center j-fs-micro font-black text-cyan-200 underline hover:text-cyan-100">
                    Open receipt
                  </a>
                  <button
                    type="button"
                    onClick={() => void copyReceipt(receiptIds[n.id]!, n)}
                    className="inline-flex min-h-11 items-center j-fs-micro font-black text-[color:var(--j-text-faint)] underline hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                    aria-label={`Copy receipt for ${actionLabel(n)}`}
                  >
                    {copiedReceiptId === receiptIds[n.id] ? "Receipt copied" : "Copy receipt"}
                  </button>
                </span>
              </div>
            </li>
          ) : (
            <li key={n.id} className="j-fs-sm text-[color:var(--j-text-dim)]" data-jarvis-fact data-source="thread.nodes">
              {actionLabel(n)} · {actionStatusLabel(progress.actionStates[n.id] ?? "unobserved")} · No receipt yet
            </li>
          ),
        )}
      </ul>
      {thread.nodes[0] && receiptIds[thread.nodes[0].id] && (
        <div className="j-panel mt-3 rounded-xl border border-white/8 p-3">
          {/* jarvis-v3 P4.T5: receiptRefreshTick bumps when the kernel's own
              payment-watch effect sees a real payment_recorded event for one
              of this thread's invoices — the SAME receipt re-fetches in
              place, no new view, no fresh page load required. */}
          <ReceiptContent receiptId={receiptIds[thread.nodes[0].id]!} refreshKey={thread.receiptRefreshTick} />
        </div>
      )}
    </motion.div>
  )
}
