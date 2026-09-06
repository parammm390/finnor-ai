"use client"

// Owner-journey atmosphere. This is deliberately event-led rather than a
// standing activity loop: the state tint comes from the kernel, one-shot cues
// come from real data-core diffs, and transport recovery is the only thing that
// can trigger Relight. No timer invents work and no heartbeat is rendered as a
// pulse.

import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import type { InstructionState } from "../kernel/types"
import type { TransportHealth } from "../kernel/transport"
import { faultShakeVariants, relightVariants } from "../kernel/choreography"
import { authoritativeDecisionWave } from "../kernel/decision-wave"
import { LF09_DECISION_WAVE_MS } from "../kernel/execution-choreography"
import { onJarvisEvent, type JarvisEventType } from "../lib/data-core"
import { getAnchorRect } from "../lib/pulse-bus"
import { choreo } from "../ui/motion/choreo"
import { SIGNATURE_MOMENTS } from "../kernel/signature-moments"

type CueTone = "cyan" | "teal" | "green" | "amber" | "red" | "violet"
type AtmosphereCue = { id: number; tone: CueTone; label: string; fault: boolean }
type DecisionWaveState = { id: number; tone: CueTone; origin: { left: number; top: number }; target: { left: number; top: number } }

const TONE_COLOR: Record<CueTone, string> = {
  cyan: "var(--j-cyan)",
  teal: "var(--j-teal)",
  green: "var(--j-green)",
  amber: "var(--j-amber)",
  red: "var(--j-red)",
  violet: "var(--j-violet)",
}

function actionDecisionCue(detail: unknown): { tone: CueTone; label: string } {
  const verb = typeof detail === "object" && detail !== null && "verb" in detail && typeof detail.verb === "string" ? detail.verb : null
  if (verb === "confirm") return { tone: "green", label: "Approval recorded" }
  if (verb === "reject") return { tone: "red", label: "Rejection recorded" }
  if (verb === "escalate") return { tone: "amber", label: "Escalation recorded" }
  return { tone: "cyan", label: "Action updated" }
}

function cueForEvent(type: JarvisEventType, detail: unknown): { tone: CueTone; label: string; fault: boolean } | null {
  switch (type) {
    case "new-business-event":
      return { tone: "cyan", label: "New system event", fault: false }
    case "step-completed":
      return { tone: "teal", label: "Step completed", fault: false }
    case "step-failed":
      return { tone: "red", label: "Step failed", fault: true }
    case "run-completed":
      return { tone: "green", label: "Workflow completed", fault: false }
    case "run-failed":
      return { tone: "red", label: "Workflow failed", fault: true }
    case "new-pending-action":
      return { tone: "amber", label: "Approval waiting", fault: false }
    case "action-decided": {
      const cue = actionDecisionCue(detail)
      return { ...cue, fault: false }
    }
    case "poll-landed":
      // A successful poll is transport bookkeeping, not user-visible activity.
      return null
  }
}

function stateTone(state: InstructionState | null, transport: TransportHealth): { tone: CueTone; opacity: number } {
  if (transport === "offline" || transport === "unavailable") return { tone: "amber", opacity: 0.42 }
  if (transport === "reconnecting") return { tone: "amber", opacity: 0.62 }
  switch (state) {
    case "understanding":
    case "planning":
      return { tone: "violet", opacity: 0.82 }
    case "awaiting_approval":
      return { tone: "amber", opacity: 0.9 }
    case "executing":
      return { tone: "cyan", opacity: 0.96 }
    case "verifying":
      return { tone: "teal", opacity: 0.96 }
    case "completed":
      return { tone: "green", opacity: 0.96 }
    case "partial":
      return { tone: "amber", opacity: 0.9 }
    case "failed":
      return { tone: "red", opacity: 0.86 }
    default:
      return { tone: "cyan", opacity: 0.78 }
  }
}

function useReducedMotionSafe(): boolean {
  const preference = useReducedMotion()
  const [reduced, setReduced] = useState(false)
  useEffect(() => setReduced(Boolean(preference)), [preference])
  return reduced
}

export function ThreadEventAtmosphere({ instructionState, transport }: { instructionState: InstructionState | null; transport: TransportHealth }) {
  const reduced = useReducedMotionSafe()
  const [cue, setCue] = useState<AtmosphereCue | null>(null)
  const [relightId, setRelightId] = useState(0)
  const [decisionWave, setDecisionWave] = useState<DecisionWaveState | null>(null)
  const previousTransportRef = useRef<TransportHealth | null>(null)
  const cueTimerRef = useRef<number | null>(null)
  const waveTimerRef = useRef<number | null>(null)
  const sequenceRef = useRef(0)
  const atmosphere = stateTone(instructionState, transport)

  useEffect(() => {
    const eventTypes: JarvisEventType[] = [
      "new-business-event",
      "step-completed",
      "step-failed",
      "run-completed",
      "run-failed",
      "new-pending-action",
      "action-decided",
    ]
    const offs = eventTypes.map((type) =>
      onJarvisEvent(type, (detail) => {
        const next = cueForEvent(type, detail)
        if (!next) return
        sequenceRef.current += 1
        setCue({ ...next, id: sequenceRef.current })
        if (type === "action-decided") {
          const wave = authoritativeDecisionWave(detail)
          if (wave) {
            const actionRect = wave.actionId ? getAnchorRect(`approval-action-${wave.actionId}`) : null
            const cockpitRect = getAnchorRect("approval-cockpit")
            const fieldRect = getAnchorRect("signal-field") ?? getAnchorRect("workflow-origin")
            const source = actionRect ?? cockpitRect
            const target = fieldRect
            const center = (rect: DOMRect) => ({ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 })
            const waveId = sequenceRef.current
            if (source && target) setDecisionWave({ id: waveId, tone: wave.tone, origin: center(source), target: center(target) })
            else setDecisionWave(null)
            if (waveTimerRef.current !== null) window.clearTimeout(waveTimerRef.current)
            waveTimerRef.current = window.setTimeout(() => setDecisionWave(null), reduced ? 40 : LF09_DECISION_WAVE_MS)
          }
        }
        if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current)
        cueTimerRef.current = window.setTimeout(() => setCue(null), reduced ? 220 : next.fault ? 680 : 760)
      }),
    )
    return () => {
      offs.forEach((off) => off())
      if (cueTimerRef.current !== null) window.clearTimeout(cueTimerRef.current)
      if (waveTimerRef.current !== null) window.clearTimeout(waveTimerRef.current)
    }
  }, [reduced])

  useEffect(() => {
    const previous = previousTransportRef.current
    const recovered = previous !== null && (previous === "offline" || previous === "reconnecting" || previous === "unavailable") && (transport === "live" || transport === "polling")
    if (recovered) setRelightId((id) => id + 1)
    previousTransportRef.current = transport
  }, [transport])

  const ringVariants = reduced ? choreo.orbAuraRipple.reducedVariants : choreo.orbAuraRipple.variants
  const cueVariants = reduced ? choreo.inkBleed.reducedVariants : choreo.inkBleed.variants
  const relight = relightVariants(reduced)
  const fault = faultShakeVariants(reduced)

  return (
    <>
      <div
        aria-hidden
        data-thread-atmosphere
        data-thread-tone={atmosphere.tone}
        className={`pointer-events-none fixed inset-0 z-0 overflow-hidden ${reduced ? "" : "transition-opacity duration-700"}`}
        style={{ opacity: atmosphere.opacity * 0.2 }}
      >
        <div
          className={`absolute inset-0 ${reduced ? "" : "transition-opacity duration-700"}`}
          style={{ background: `radial-gradient(60% 42% at 50% 16%, ${TONE_COLOR[atmosphere.tone]} 0%, transparent 72%)`, opacity: 0.12 }}
        />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--accent)]/45 to-transparent" />
      </div>

      <AnimatePresence initial={false}>
        {relightId > 0 && (
          <motion.div
            key={`relight-${relightId}`}
            aria-hidden
            data-jarvis-signature-moment="recover"
            data-jarvis-signature-source={SIGNATURE_MOMENTS.recover.source}
            className="pointer-events-none fixed inset-0 z-10"
            variants={relight}
            initial="initial"
            animate="animate"
            onAnimationComplete={() => setRelightId((id) => (id === relightId ? 0 : id))}
            style={{ background: "linear-gradient(90deg, transparent, color-mix(in srgb, var(--j-cyan) 42%, transparent), transparent)" }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {cue && (
          <>
            <motion.span
              key={`cue-ring-${cue.id}`}
              aria-hidden
              variants={ringVariants}
              initial="initial"
              animate="animate"
              className="pointer-events-none fixed left-1/2 top-[27vh] z-10 h-28 w-28 -translate-x-1/2 rounded-full border-2"
              style={{ borderColor: TONE_COLOR[cue.tone] }}
            />
            <motion.div
              key={`cue-label-${cue.id}`}
              role="status"
              aria-live={cue.fault ? "assertive" : "polite"}
              className={`pointer-events-none fixed left-1/2 top-6 z-30 -translate-x-1/2 rounded-full border px-3 py-1.5 j-fs-micro font-black backdrop-blur-md ${cue.fault ? "border-red-300/40 bg-red-400/12 text-red-200" : "border-white/12 bg-[#071120]/90 text-[color:var(--j-text)]"}`}
              variants={cue.fault ? fault : cueVariants}
              initial="initial"
              animate="animate"
              exit={{ opacity: 0, transition: { duration: reduced ? 0 : 0.16 } }}
            >
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: TONE_COLOR[cue.tone] }} />
              {cue.label}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {decisionWave && (
          <motion.span
            key={`decision-wave-${decisionWave.id}`}
            aria-hidden
            data-liveframe-impulse="LF-09"
            data-decision-wave-tone={decisionWave.tone}
            className="pointer-events-none fixed z-20 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
            style={{ left: decisionWave.origin.left, top: decisionWave.origin.top, borderColor: TONE_COLOR[decisionWave.tone], boxShadow: `0 0 28px ${TONE_COLOR[decisionWave.tone]}` }}
            initial={{ opacity: 0, scale: 0.35 }}
            animate={reduced
              ? { opacity: 1, scale: 1, left: decisionWave.target.left, top: decisionWave.target.top }
              : { opacity: [0, 0.95, 0], scale: [0.35, 1.15, 2.1], left: decisionWave.target.left, top: decisionWave.target.top }}
            transition={{ duration: reduced ? 0 : 0.52, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>
    </>
  )
}
