"use client"

// The Instruction Thread — depth 1, the document column (plan v3 §2.2/§2.3, P2.T5).
//
// An instruction is a causal document, not a series of screens. Once a block has
// been reached it stays in this thread, and a state change changes the same block's
// posture in place. The outer layout and the block body both animate, so the next
// block grows out of the previous one instead of replacing it with a detached row.

import { useEffect, useMemo, useRef, useState } from "react"
import { LayoutGroup, motion, useReducedMotion } from "framer-motion"
import type { Thread as ThreadData } from "../kernel/store"
import { useKernel } from "../kernel/store"
import { intentLaunchVariants, threadBirthVariants, threadBodyVariants, threadLayoutTransition } from "../kernel/choreography"
import { sfx } from "../sound"
import { ThreadAnswer, ThreadClarify, ThreadExecution, ThreadHeard, ThreadPlan, ThreadReceipt, ThreadUnderstood, type ExecutionWeavePlacement } from "./ThreadBlocks"
import type { InstructionState } from "../kernel/types"
import type { LiveFrameIntentLaunch } from "../kernel/liveframe"
import { getTracePixelMeasurements, markTraceStagePainted, onTracePixelMeasurement, type TracePixelStage, type TracePixelMeasurement } from "../kernel/trace-metrics"
import { shouldHandoffThreadFocus } from "./thread-presentation"

type BlockKey = "heard" | "understood" | "answer" | "plan" | "execution" | "receipt"

const BLOCK_ORDER: BlockKey[] = ["heard", "understood", "answer", "plan", "execution", "receipt"]

function isTerminal(state: InstructionState): boolean {
  return state === "completed" || state === "partial" || state === "failed" || state === "cancelled"
}

/** Which block owns the live cursor for the current instruction state. When an
 * already-running thread is interrupted for a human decision, the execution
 * block remains the live document anchor so the pause reads as a recovery, not
 * as a fresh plan. */
function activeBlock(state: InstructionState, everExecuted: boolean, hasAnswer: boolean): BlockKey {
  if (hasAnswer) return "answer"
  switch (state) {
    case "idle":
    case "captured":
      return "heard"
    case "understanding":
      return "understood"
    case "planning":
    case "clarifying":
      return "plan"
    case "awaiting_approval":
      return everExecuted ? "execution" : "plan"
    case "executing":
    case "verifying":
      return "execution"
    case "completed":
    case "partial":
    case "failed":
    case "cancelled":
      return "receipt"
    default:
      return "heard"
  }
}

/** Blocks become real at these state edges. The local seen-set is also important
 *  for clarification recovery: the same thread can go clarifying -> captured
 *  while its earlier plan remains part of the document. */
function reachedBlocks(thread: ThreadData): Set<BlockKey> {
  if (thread.answerResult) return new Set<BlockKey>(["heard", "answer"])
  const state = thread.machine.instructionState
  const reached = new Set<BlockKey>(["heard"])
  if (state !== "idle" && state !== "captured") reached.add("understood")
  if (state === "planning" || state === "clarifying" || state === "awaiting_approval" || state === "executing" || state === "verifying" || isTerminal(state)) {
    reached.add("plan")
  }
  if (thread.everExecuted) reached.add("execution")
  if (isTerminal(state)) reached.add("receipt")
  return reached
}

function blockStatus(key: BlockKey, thread: ThreadData, resuming: boolean): string {
  const state = thread.machine.instructionState
  switch (key) {
    case "heard":
      if (state === "captured") return resuming ? "Answer captured" : "Captured"
      if (state === "failed" && thread.submitError) return "Needs retry"
      return "Instruction"
    case "understood":
      if (state === "understanding") return "Checking context"
      if (state === "captured") return "Waiting for acknowledgement"
      return "Context used"
    case "answer":
      return thread.answerResult ? "Response" : "Answer"
    case "plan":
      if (state === "planning") return thread.nodes.length > 0 ? "Growing live" : "Drafting"
      if (state === "clarifying") return "Needs one detail"
      if (state === "awaiting_approval") return "Ready for review"
      return "Plan recorded"
    case "execution":
      if (state === "awaiting_approval") return "Paused for review"
      if (state === "executing") return "In progress"
      if (state === "verifying") return "Verifying"
      return "Execution recorded"
    case "receipt":
      if (state === "completed") return "Complete"
      if (state === "partial") return "Partial"
      if (state === "failed") return "Needs recovery"
      if (state === "cancelled") return "Cancelled"
      return "Preparing"
  }
}

function blockSummary(key: BlockKey, thread: ThreadData, status: string): string {
  const state = thread.machine.instructionState
  switch (key) {
    case "heard":
      return state === "captured" ? status : thread.instructionText
    case "understood":
      return status
    case "answer":
      return thread.answerResult?.displaySummary ?? thread.answerResult?.spokenSummary ?? status
    case "plan":
      if (state === "clarifying") return "One detail needed"
      if (thread.nodes.length === 0) return status
      return `${thread.nodes.length} action${thread.nodes.length === 1 ? "" : "s"}`
    case "execution":
      return status
    case "receipt":
      return status
  }
}

function BlockShell({
  blockKey,
  title,
  collapsedSummary,
  status,
  collapsed,
  active,
  reducedMotion,
  intentLaunch,
  onToggle,
  children,
}: {
  blockKey: BlockKey
  title: string
  collapsedSummary: string
  status: string
  collapsed: boolean
  active: boolean
  reducedMotion: boolean
  intentLaunch?: LiveFrameIntentLaunch | null
  onToggle: () => void
  children: React.ReactNode
}) {
  const bodyId = `thread-block-${blockKey}-body`
  const bodyVariants = threadBodyVariants(reducedMotion)

  return (
    <motion.section
      layout={!reducedMotion}
      transition={threadLayoutTransition(reducedMotion)}
      tabIndex={-1}
      aria-label={title}
      data-thread-block={blockKey}
      data-thread-spine-node={blockKey}
      data-thread-spine-state={active ? "active" : collapsed ? "collapsed" : "settled"}
      data-thread-block-active={active ? "true" : "false"}
      data-thread-block-collapsed={collapsed ? "true" : "false"}
      data-intent-launch={intentLaunch ? "accepted" : undefined}
      className="j-thread-spine-node relative overflow-hidden"
    >
      <motion.button
        type="button"
        layout={!reducedMotion}
        transition={threadLayoutTransition(reducedMotion)}
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="j-thread-spine-node__header flex min-h-10 w-full items-center justify-between gap-3 px-3 py-2 text-left outline-none transition-colors active:scale-[.995] focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        whileTap={reducedMotion ? undefined : { scale: 0.995 }}
      >
        <span className="j-fs-sm shrink-0 text-[color:var(--j-text-dim)]">{title}</span>
        <span className="min-w-0 truncate text-right j-fs-sm text-[color:var(--j-text-faint)]" aria-live={active ? "polite" : undefined}>
          {collapsed ? collapsedSummary : status}
        </span>
      </motion.button>

      {/* The body stays mounted while its height changes. This preserves local
          control state (clarification answers) and prevents lifecycle cues from
          replaying when a person re-expands an older block. `visibility` keeps
          collapsed controls out of keyboard navigation during the layout flight. */}
      <motion.div
        id={bodyId}
        initial={false}
        animate={collapsed ? "collapsed" : "expanded"}
        variants={bodyVariants}
        className="overflow-hidden"
        aria-hidden={collapsed}
        data-thread-block-body={blockKey}
        data-thread-block-body-collapsed={collapsed ? "true" : "false"}
      >
        <div className={`j-thread-spine-node__content ${collapsed ? "invisible pointer-events-none p-4 pt-2" : "p-4 pt-2"}`}>{children}</div>
        {intentLaunch && (
          <motion.span
            key={intentLaunch.id}
            {...intentLaunchVariants(reducedMotion)}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl border-2 border-cyan-200/80 shadow-[0_0_34px_rgba(34,211,238,0.38)]"
          />
        )}
      </motion.div>
    </motion.section>
  )
}

export function Thread({
  thread,
  onCancel,
  onAnswer,
  onSkip,
  onRetry,
  intentLaunch,
  executionWeavePlacement = "document",
  executionEnergy = 0,
  restored = false,
  restoredTraceEventCount = 0,
}: {
  thread: ThreadData
  onCancel: () => void
  onAnswer: (text: string) => void
  onSkip: () => void
  onRetry: () => void | Promise<void>
  intentLaunch?: LiveFrameIntentLaunch | null
  executionWeavePlacement?: ExecutionWeavePlacement
  /** Current LIVEFRAME energy, used only for a real leased-edge speed. */
  executionEnergy?: number
  /** True only when this snapshot was rebuilt from the persisted refresh pointer. */
  restored?: boolean
  /** Non-visual release-audit count of real rows fetched during restore. */
  restoredTraceEventCount?: number
}) {
  const reducedMotionRaw = useReducedMotion()
  const reducedMotion = reducedMotionRaw ?? false
  const [manuallyExpanded, setManuallyExpanded] = useState<Set<BlockKey>>(new Set())
  const [seenBlocks, setSeenBlocks] = useState<Set<BlockKey>>(() => new Set(["heard"]))
  const [resuming, setResuming] = useState(false)
  const [traceMeasurements, setTraceMeasurements] = useState<TracePixelMeasurement[]>([])
  const blockRefs = useRef<Partial<Record<BlockKey, HTMLElement | null>>>({})
  const previousThreadIdRef = useRef(thread.id)
  const previousStateRef = useRef<InstructionState | null>(null)
  const active = activeBlock(thread.machine.instructionState, thread.everExecuted, Boolean(thread.answerResult))
  const reached = useMemo(() => reachedBlocks(thread), [thread])
  const restoredBlocksRef = useRef<Set<BlockKey> | null>(null)
  if (restoredBlocksRef.current === null) restoredBlocksRef.current = restored ? reachedBlocks(thread) : new Set<BlockKey>()

  useEffect(() => {
    const state = thread.machine.instructionState
    const was = previousStateRef.current
    if (previousThreadIdRef.current !== thread.id) {
      previousThreadIdRef.current = thread.id
      previousStateRef.current = null
      setSeenBlocks(new Set(["heard"]))
      setManuallyExpanded(new Set())
      setResuming(false)
    }

    setSeenBlocks((previous) => {
      const next = new Set(previous)
      for (const key of reached) next.add(key)
      return next.size === previous.size ? previous : next
    })

    if (was !== null) {
      if (was !== "understanding" && state === "understanding") sfx.think()
      if (was !== "clarifying" && state === "clarifying") sfx.propose({ lower: true })
      if (was !== "completed" && was !== "partial" && (state === "completed" || state === "partial")) sfx.seal()
    }
    setResuming(was === "clarifying" && state === "captured")
    previousStateRef.current = state
  }, [reached, thread.id, thread.machine.instructionState])

  // Keep the live cursor in view when a real state edge opens a new block. Do
  // not steal focus from a person typing or operating a control; if focus is
  // passive, move it to the new document anchor so keyboard and screen-reader
  // users follow the same causal handoff as sighted users.
  const lastActiveRef = useRef<BlockKey | null>(null)
  useEffect(() => {
    lastActiveRef.current = null
  }, [thread.id])

  useEffect(() => {
    const target = blockRefs.current[active]
    if (!target) return
    if (lastActiveRef.current === active) return
    const previous = lastActiveRef.current
    lastActiveRef.current = active

    const move = () => {
      target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" })
      // Read focus at the frame where the handoff occurs. A child control such
      // as ThreadClarify may claim focus in its own effect during the same
      // commit; using the pre-frame snapshot would steal it back on mobile.
      const currentFocus = document.activeElement
      const currentFocusElement = currentFocus instanceof HTMLElement ? currentFocus : null
      const isInteractive = Boolean(currentFocusElement?.closest("input, textarea, button, select, [contenteditable='true'], [data-jarvis-command-rail]"))
      const commandRailOwnsFocus = Boolean(currentFocusElement?.closest("[data-jarvis-command-rail]"))
      const clarificationOwnsFocus = active === "plan" && thread.clarification !== null && Boolean(currentFocusElement?.closest("[data-jarvis-clarification]"))
      const focusIsInsideCollapsingBody = Boolean(currentFocusElement?.closest("[data-thread-block-body-collapsed='true']"))
      if (shouldHandoffThreadFocus({ focusIsInteractive: isInteractive, focusIsInsideCollapsingBody, commandRailOwnsFocus, clarificationOwnsFocus }) && (currentFocus === document.body || currentFocus === null || previous !== null)) {
        target.focus({ preventScroll: true })
      }
    }
    const frame = window.requestAnimationFrame(move)
    return () => window.cancelAnimationFrame(frame)
  }, [active, reducedMotion, thread.clarification, seenBlocks])

  const toggle = (key: BlockKey) =>
    setManuallyExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const visibleBlocks = thread.answerResult ? (["heard", "answer"] as BlockKey[]) : BLOCK_ORDER.filter((key) => seenBlocks.has(key) || reached.has(key))
  const visibleTraceStages: TracePixelStage[] = visibleBlocks.filter((key): key is TracePixelStage => key !== "answer")
  useEffect(() => {
    if (!thread.instructionId) {
      setTraceMeasurements([])
      return
    }
    setTraceMeasurements(getTracePixelMeasurements(thread.instructionId))
    return onTracePixelMeasurement((measurement) => {
      if (measurement.instructionId !== thread.instructionId) return
      setTraceMeasurements(getTracePixelMeasurements(thread.instructionId!))
    })
  }, [thread.instructionId])
  useEffect(() => {
    if (!thread.instructionId) return
    const frame = window.requestAnimationFrame((timestamp) => {
      for (const stage of visibleTraceStages) markTraceStagePainted(thread.instructionId!, stage, timestamp)
    })
    return () => window.cancelAnimationFrame(frame)
    // A block edge, node, or context chip is a real DOM-changing edge. Measuring
    // after the next frame captures event-to-pixel rather than handler time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.instructionId, visibleBlocks.join(","), thread.nodes.length, thread.contextChips.length, thread.machine.instructionState])
  const renderBlock = (key: BlockKey) => {
    const status = blockStatus(key, thread, resuming)
    const collapsedSummary = blockSummary(key, thread, status)
    const launchHeard = key === "heard" && Boolean(intentLaunch)
    const collapsed = !launchHeard && !manuallyExpanded.has(key) && key !== active
    const blockRestored = restoredBlocksRef.current?.has(key) ?? false
    const birth = threadBirthVariants(reducedMotion, blockRestored)
    const answerClarification = (text: string) => {
      // Keep the causal return legible immediately, including the brief
      // clarifying -> captured edge before the new same-thread turn arrives.
      setResuming(true)
      onAnswer(text)
    }

    return (
      <motion.div
        key={key}
        ref={(node) => { blockRefs.current[key] = node }}
        tabIndex={-1}
        {...birth}
        layout={!reducedMotion}
        transition={threadLayoutTransition(reducedMotion)}
        data-thread-block-entry={blockRestored ? "settled" : "entering"}
        className="j-thread-spine__item scroll-mt-24"
      >
        <BlockShell
          blockKey={key}
          title={key === "plan" && thread.clarification ? "Clarify" : key[0]!.toUpperCase() + key.slice(1)}
          collapsedSummary={collapsedSummary}
          status={status}
          collapsed={collapsed}
          active={key === active || launchHeard}
          reducedMotion={reducedMotion}
          intentLaunch={launchHeard ? intentLaunch : null}
          onToggle={() => {
            // The live causal block is always expanded. Keeping this guard at
            // the interaction boundary makes the invariant explicit as well
            // as preserving it in the derived `collapsed` value above.
            if (key !== active) toggle(key)
          }}
        >
          {key === "heard" && <ThreadHeard thread={thread} onCancel={onCancel} onRetry={onRetry} resuming={resuming} intentLaunch={launchHeard ? intentLaunch : null} />}
          {key === "understood" && <ThreadUnderstood thread={thread} reducedMotion={reducedMotion} />}
          {key === "answer" && <ThreadAnswer thread={thread} />}
          {key === "plan" && (thread.clarification ? <ThreadClarify thread={thread} onAnswer={answerClarification} onSkip={onSkip} onCancel={onCancel} /> : <ThreadPlan thread={thread} reducedMotion={reducedMotion} restored={blockRestored} />)}
          {key === "execution" && <ThreadExecution thread={thread} restored={blockRestored} executionWeavePlacement={executionWeavePlacement} energy={executionEnergy} />}
          {key === "receipt" && <ThreadReceipt thread={thread} reducedMotion={reducedMotion} onRetry={onRetry} restored={blockRestored} />}
        </BlockShell>
      </motion.div>
    )
  }

  // Non-visual release-audit seam: lets an authenticated observer compare this
  // exact live Thread's client-minted id with the backend trace endpoint. It is
  // not read by product logic and carries no customer-facing copy.
  return (
    <LayoutGroup id={`instruction-thread-${thread.id}`}>
      <div
        className="j-thread-spine mx-auto w-full max-w-[720px] pl-5 pr-4 pb-[calc(10rem+env(safe-area-inset-bottom))] pt-24 sm:pb-40"
        data-thread-document
        data-jarvis-action-spine-document
        data-thread-restored={restored ? "true" : "false"}
        data-jarvis-restored-event-count={restored ? restoredTraceEventCount : undefined}
        data-jarvis-instruction-id={thread.instructionId ?? undefined}
        data-jarvis-trace-metrics-count={traceMeasurements.length}
        data-jarvis-trace-metrics={traceMeasurements.length > 0 ? JSON.stringify(traceMeasurements) : undefined}
        aria-label="Instruction thread"
      >
        {visibleBlocks.map(renderBlock)}
      </div>
    </LayoutGroup>
  )
}

export function useThreadKernel() {
  return useKernel()
}
