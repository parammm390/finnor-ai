"use client"

// The Instruction Thread — top-level page (plan v3 §2.2/§6⓪, P2.T5).
//
// Mounts the kernel when used standalone and gates on owner role. The canonical
// `/jarvis` landing supplies the already-mounted auth/data contexts through
// `KernelSurface`, so the Thread and its shell share one live data/realtime stack.
// `VapiSessionProvider` is already mounted once at `src/app/jarvis/layout.tsx`
// for the whole /jarvis section — this page does not remount it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { motion, useReducedMotion } from "framer-motion"
import "../jarvis-theme.css"
import { KernelProvider, useKernel, type Thread as ThreadData } from "../kernel/store"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { useVapiSession } from "../lib/useVapiSession"
import { ThreadField } from "./ThreadField"
import { ThreadStack } from "./ThreadStack"
import { ThreadEventAtmosphere } from "./ThreadAtmosphere"
import { ThreadApprovalCockpit, ThreadExecutionWeave } from "./ThreadBlocks"
import { ApprovalCockpit } from "./ApprovalCockpit"
import type { ExecutionWeavePlacement } from "./ThreadBlocks"
import { CommandRail, MicControlButton } from "./CommandRail"
import { ModeChip } from "./ModeChip"
import type { JarvisRole } from "../lib/jarvis-auth"
import { derivePresence } from "../kernel/presence"
import { D3_LONG_EXECUTION_MS, D3_NARRATION_TEXT, shouldFireD3Narration } from "../lib/d3-narration"
import { receiptIdFromHash } from "../lib/receipt-nav"
import { deriveMood } from "../lib/mood"
import { useQuietHours } from "../lib/quiet-hours"
import { initialLowPowerMode, persistLowPowerMode } from "../lib/low-power"
import { ConsoleAtmosphere } from "../atmosphere"
import { GridBackdrop } from "../ui/fx/GridBackdrop"
import { OrbAuraRipple } from "./OrbAuraRipple"
import type { Presence, Truth } from "../kernel/types"
import type { TransportHealth } from "../kernel/transport"
import { JarvisOrbSurface } from "./JarvisOrbSurface"
import orbSurfaceStyles from "./JarvisOrbSurface.module.css"
import { deriveOrbVisualState, type CorrelatedOrbAction } from "./orb-visual-state"
import { INTENT_LAUNCH_DURATION_MS, intentLaunchVariants, questionFocusLayerVariants, signatureMomentRingVariants } from "../kernel/choreography"
import { deriveLiveFrame, projectKernelLiveFrame, type LiveFrameIntentLaunch, type LiveFrameMode, type LiveFrameProjection } from "../kernel/liveframe"
import { deriveSceneDirector } from "../kernel/scene-director"
import { SIGNATURE_MOMENTS, signatureMomentForEdge } from "../kernel/signature-moments"
import { getAnchorRect } from "../lib/pulse-bus"
import { approvalConsequencePrompt } from "./approval-consequence"
import {
  OperationalCommandIndex,
  OperationalContextRail,
  OperationalSignalRail,
  BusinessPulse,
  OperationsHeader,
  OrbIntelligenceReadout,
} from "./OperationalConsole"
import {
  onTracePixelMeasurement,
  recordTraceEventReceived,
  resetTracePixelMeasurements,
  type TracePixelMeasurement,
} from "../kernel/trace-metrics"
import { AdaptiveWorkspaceShell } from "../workspaces/AdaptiveWorkspaceShell"


const ReceiptContent = dynamic(() => import("../lib/ReceiptDrawer").then((m) => m.ReceiptContent), { ssr: false })
const ParticleField = dynamic(() => import("../panels/ParticleField").then((m) => m.ParticleField), { ssr: false })
// Role-specific surfaces stay out of the canonical public/owner Thread bundle.
// They only become reachable after a real role projection selects them.
const DispatchMap = dynamic(() => import("../panels/DispatchMap").then((m) => m.DispatchMap), { ssr: false })
const MyDay = dynamic(() => import("../panels/MyDay").then((m) => m.MyDay), { ssr: false })

// All existing labelled Thread fixtures carry this source-defined instruction
// id; using it here lets the real Thread paint marker close the fixture event.
const FIXTURE_JOURNEY_INSTRUCTION_ID = "fixture-instruction"
const FIXTURE_JOURNEY_STEPS = [
  { key: "rest", label: "ready", phase: null },
  { key: "heard", label: "captured", phase: "received" },
  { key: "understood", label: "understanding", phase: "context_retrieved" },
  { key: "plan", label: "planning", phase: "plan_ready" },
  { key: "clarify", label: "clarifying", phase: "clarification_required" },
  { key: "approval", label: "approval", phase: "action_gated" },
  { key: "execution", label: "executing", phase: "executing" },
  { key: "verifying", label: "verifying", phase: "verifying" },
  { key: "receipt", label: "terminal", phase: "completed" },
] as const

// P1.T4-only companion journey. The original P3 lifecycle harness above is
// kept byte-for-byte in its step contract; this labelled path adds source-edge
// boundaries needed to observe wake, Gather, and Draw without changing the
// existing evidence ledger.
const SIGNATURE_JOURNEY_STEPS = [
  { key: "rest", label: "ready", phase: null },
  { key: "listening", label: "listening", phase: null },
  { key: "heard", label: "captured", phase: "received" },
  { key: "understood-midfill", label: "gathering", phase: "context_retrieved" },
  { key: "understood-complete", label: "context complete", phase: "context_retrieved" },
  { key: "plan-empty", label: "plan boundary", phase: "plan_ready" },
  { key: "plan", label: "planning", phase: "plan_ready" },
  { key: "clarify", label: "clarifying", phase: "clarification_required" },
  { key: "approval", label: "approval", phase: "action_gated" },
  { key: "execution", label: "executing", phase: "executing" },
  { key: "verifying", label: "verifying", phase: "verifying" },
  { key: "receipt", label: "terminal", phase: "completed" },
] as const

// Three.js is only needed after the Thread has mounted. A native import here,
// rather than next/dynamic, intentionally avoids preloading the renderer as an
// initial-route dependency; the original Orb also initialized only after mount.

type Daypart = "dawn" | "day" | "dusk" | "night"

function getDaypart(): Daypart {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 8) return "dawn"
  if (hour >= 8 && hour < 18) return "day"
  if (hour >= 18 && hour < 21) return "dusk"
  return "night"
}

interface ThreadAtmosphereState {
  mood: ReturnType<typeof deriveMood>
  daypart: Daypart
  forceLowPower: boolean
  quiet: boolean
  relighting: boolean
  transport: TransportHealth
  voiceAmplitude?: number
  diagnostics: {
    now: number
    lastPollAtMs: number | null
    slowLastSuccessMs: number | null
    apiLatencyMs: number | null
  }
  onToggleLowPower: () => void
}

function useThreadAtmosphere(
  voice: ReturnType<typeof useVapiSession>,
  transport: ThreadAtmosphereState["transport"],
  presence: Presence,
  diagnostics: ThreadAtmosphereState["diagnostics"],
): ThreadAtmosphereState {
  const { quiet } = useQuietHours()
  const [daypart, setDaypart] = useState<Daypart>("day")
  const [forceLowPower, setForceLowPower] = useState(false)
  const [relighting, setRelighting] = useState(false)
  const degraded = transport === "offline" || transport === "reconnecting" || transport === "unavailable"
  const wasDegradedRef = useRef(degraded)

  useEffect(() => {
    setDaypart(getDaypart())
    setForceLowPower(initialLowPowerMode())
    const id = window.setInterval(() => setDaypart(getDaypart()), 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (wasDegradedRef.current && !degraded) {
      setRelighting(true)
      const id = window.setTimeout(() => setRelighting(false), 900)
      wasDegradedRef.current = degraded
      return () => window.clearTimeout(id)
    }
    wasDegradedRef.current = degraded
  }, [degraded])

  const onToggleLowPower = () => {
    setForceLowPower((current) => {
      const next = !current
      persistLowPowerMode(next)
      return next
    })
  }

  return {
    mood: deriveMood({
      voiceLive: voice.voiceState === "live" || voice.voiceState === "speaking",
      degraded,
    }),
    daypart,
    forceLowPower,
    quiet,
    relighting,
    transport,
    voiceAmplitude: presence === "hearing" ? voice.localVolumeLevel : undefined,
    diagnostics,
    onToggleLowPower,
  }
}

const PRIMARY_STATUS_BY_MODE: Record<LiveFrameMode, string> = {
  ready: "Ready",
  listening: "Listening",
  thinking: "Checking records / Preparing actions",
  decision: "Needs your approval",
  working: "Working",
  verifying: "Verifying the outcome",
  resolved: "Done",
  fault: "Needs attention",
}

function primaryStatus(liveframe: LiveFrameProjection): string {
  if (liveframe.mode === "decision" && liveframe.focus === "clarification") return "Needs one detail"
  if (liveframe.mode === "fault" && (liveframe.transportPosture === "offline" || liveframe.presence === "severed")) return "Connection lost"
  if (liveframe.mode === "fault" && liveframe.presence === "wounded") return "Partially completed"
  return PRIMARY_STATUS_BY_MODE[liveframe.mode]
}

function diagnosticAge(lastAtMs: number | null, now: number): string {
  if (lastAtMs === null) return "Not observed"
  const ageMs = Math.max(0, now - lastAtMs)
  if (ageMs < 1_000) return "Just now"
  if (ageMs < 60_000) return String(Math.floor(ageMs / 1_000)) + "s ago"
  if (ageMs < 3_600_000) return String(Math.floor(ageMs / 60_000)) + "m ago"
  return String(Math.floor(ageMs / 3_600_000)) + "h ago"
}

const TRANSPORT_DIAGNOSTIC: Record<TransportHealth, string> = {
  live: "Live",
  polling: "Polling",
  reconnecting: "Reconnecting",
  offline: "Offline",
  unavailable: "Unavailable",
}

function DiagnosticsDisclosure({
  atmosphere,
  onRetry,
}: {
  atmosphere: ThreadAtmosphereState
  onRetry?: () => void
}) {
  const { diagnostics } = atmosphere
  return (
    <details id="jarvis-diagnostics" className="relative scroll-mt-20" data-jarvis-diagnostics>
      <summary className="j-chip min-h-11 cursor-pointer list-none border border-white/10 bg-white/[.035] px-3 text-[color:var(--j-text-dim)] hover:text-cyan-100">Diagnostics</summary>
      <div className="fixed left-2 right-2 top-[6.75rem] z-40 w-auto rounded-2xl border border-white/10 bg-[#07101d]/[.98] p-3 text-left shadow-[0_16px_48px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[min(22rem,calc(100vw-2rem))]">
        <dl className="grid gap-2 j-fs-micro text-[color:var(--j-text-dim)]">
          <div className="flex items-center justify-between gap-3"><dt>Transport</dt><dd className="font-bold text-[color:var(--j-text)]" data-diagnostics-transport>{TRANSPORT_DIAGNOSTIC[atmosphere.transport]}</dd></div>
          <div className="flex items-center justify-between gap-3"><dt>Last poll</dt><dd className="font-bold text-[color:var(--j-text)]">{diagnosticAge(diagnostics.lastPollAtMs, diagnostics.now)}</dd></div>
          <div className="flex items-center justify-between gap-3"><dt>Source freshness</dt><dd className="font-bold text-[color:var(--j-text)]">{diagnosticAge(diagnostics.slowLastSuccessMs, diagnostics.now)}</dd></div>
          <div className="flex items-center justify-between gap-3"><dt>API latency</dt><dd className="font-bold text-[color:var(--j-text)]">{diagnostics.apiLatencyMs === null ? "Not observed" : String(Math.round(diagnostics.apiLatencyMs)) + " ms"}</dd></div>
          <div className="flex items-center justify-between gap-3"><dt>Low power</dt><dd className="font-bold text-[color:var(--j-text)]">{atmosphere.forceLowPower ? "On" : "Off"}</dd></div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
          <button type="button" className="min-h-11 rounded-xl border border-white/10 px-3 j-fs-micro font-bold text-[color:var(--j-text-dim)] hover:text-cyan-100" onClick={atmosphere.onToggleLowPower} aria-pressed={atmosphere.forceLowPower}>
            {atmosphere.forceLowPower ? "Turn low power off" : "Turn low power on"}
          </button>
          {onRetry && <button type="button" className="min-h-11 rounded-xl border border-white/10 px-3 j-fs-micro font-bold text-[color:var(--j-text-dim)] hover:text-cyan-100" onClick={onRetry}>Retry data</button>}
        </div>
      </div>
    </details>
  )
}

function ThreadAtmosphere({
  atmosphere,
  liveframe,
}: {
  atmosphere: ThreadAtmosphereState
  liveframe: LiveFrameProjection
}) {
  // P1 rest gate: ready owns the Presence Breath and the source-backed Field
  // drift only. The generic cinematic atmosphere and particle canvas belong to
  // active presentation modes, so they must not add standing loops to the rest
  // scene. Once a linked workflow is actually visible, the Weave owns the live
  // motion budget and the expensive cinematic/particle layers stay deferred.
  const linkedWorkflowVisible = liveframe.linkedRunIds.length > 0 || liveframe.activeRunIds.length > 0 || liveframe.activeStepIds.length > 0
  const showCinematicAtmosphere = liveframe.mode !== "ready" && !linkedWorkflowVisible
  return (
    <>
      <div
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        data-jarvis-atmosphere
        style={{ opacity: "var(--aurora-opacity)", backgroundColor: "var(--day-tint)", transition: "background-color 2s ease" }}
      >
        {!atmosphere.forceLowPower && showCinematicAtmosphere && <ConsoleAtmosphere slow={atmosphere.quiet} />}
      </div>
      {!atmosphere.forceLowPower && showCinematicAtmosphere && <ParticleField />}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <GridBackdrop />
      </div>
    </>
  )
}

function PresenceCore({
  liveframe,
  visualState,
  forceLowPower,
  deferWebgl = false,
  docked,
  intentLaunch,
  reducedMotion,
  showVoiceControl = false,
  telemetry,
  wakeCueKey = 0,
}: {
  liveframe: LiveFrameProjection
  visualState: ReturnType<typeof deriveOrbVisualState>
  forceLowPower?: boolean
  /** Keep the 14k-particle WebGL orb deferred while the linked SVG Weave owns the active frame budget. */
  deferWebgl?: boolean
  docked: boolean
  intentLaunch?: LiveFrameIntentLaunch | null
  reducedMotion: boolean
  showVoiceControl?: boolean
  /** Source-backed labels around the Orb. They belong to the same liveframe
   * projection and make the surface operational rather than decorative. */
  telemetry?: ReactNode
  wakeCueKey?: number
}) {
  return (
    <section
      className={`jarvis-presence-core relative${docked ? " jarvis-presence-core--docked" : ""}`}
      data-liveframe-surface="presence-core"
      data-liveframe-mode={liveframe.mode}
      data-liveframe-focus={liveframe.focus}
      data-liveframe-energy={liveframe.energy}
      data-jarvis-orb-depth="ambient"
      data-intent-launch={intentLaunch ? "accepted" : undefined}
      aria-label="JARVIS Presence Core"
    >
      <div className="jarvis-presence-core__orb">
        <JarvisOrbSurface
          visualState={visualState}
          liveFrame={liveframe}
          forceLowPower={forceLowPower || deferWebgl}
          reducedMotion={reducedMotion}
          activeRunCount={liveframe.activeRunIds.length}
        />
        {!forceLowPower && <OrbAuraRipple />}
        {wakeCueKey > 0 && <SignatureMomentCue moment="wake" cueKey={wakeCueKey} reducedMotion={reducedMotion} />}
        {telemetry}
      </div>
      {showVoiceControl && (
        <div className="jarvis-presence-core__mic" data-jarvis-orb-control="microphone">
          <MicControlButton variant="orb" liveframe={liveframe} />
        </div>
      )}
      {intentLaunch && (
        <motion.span
          key={intentLaunch.id}
          {...intentLaunchVariants(reducedMotion)}
          aria-hidden
          className="pointer-events-none absolute inset-[-10px] rounded-full border-2 border-cyan-200/80 shadow-[0_0_34px_rgba(34,211,238,0.38)]"
        />
      )}
    </section>
  )
}

function SignatureMomentCue({ moment, cueKey, reducedMotion }: { moment: "wake"; cueKey: number; reducedMotion: boolean }) {
  return (
    <motion.span
      key={`${moment}-${cueKey}`}
      aria-hidden
      data-jarvis-signature-moment={moment}
      data-jarvis-signature-source={SIGNATURE_MOMENTS[moment].source}
      className="pointer-events-none absolute -inset-5 rounded-full border-2 border-cyan-200/70 shadow-[0_0_34px_rgba(34,211,238,0.3)]"
      {...signatureMomentRingVariants(moment, reducedMotion)}
    />
  )
}

function rectCenter(rect: DOMRect): { left: number; top: number } {
  return { left: rect.left + rect.width / 2, top: rect.top + rect.height / 2 }
}

function IntentLaunchTrail({
  event,
  reducedMotion,
  onComplete,
}: {
  event: LiveFrameIntentLaunch | null | undefined
  reducedMotion: boolean
  onComplete?: () => void
}) {
  const [flight, setFlight] = useState<{ id: number; from: { left: number; top: number }; to: { left: number; top: number } } | null>(null)

  useEffect(() => {
    if (!event) {
      setFlight(null)
      return
    }

    setFlight(null)
    let active = true
    let frame: number | null = null
    let timeout: number | null = null

    if (reducedMotion) {
      frame = window.requestAnimationFrame(() => {
        if (active) onComplete?.()
      })
    } else {
      frame = window.requestAnimationFrame(() => {
        if (!active) return
        const from = getAnchorRect("command-dock")
        const to = getAnchorRect("instruction-heard")
        if (!from || !to) {
          timeout = window.setTimeout(() => {
            if (active) onComplete?.()
          }, INTENT_LAUNCH_DURATION_MS)
          return
        }
        setFlight({ id: event.id, from: rectCenter(from), to: rectCenter(to) })
      })
    }

    return () => {
      active = false
      if (frame !== null) window.cancelAnimationFrame(frame)
      if (timeout !== null) window.clearTimeout(timeout)
    }
  }, [event, onComplete, reducedMotion])

  if (!event || reducedMotion || !flight) return null
  const variants = intentLaunchVariants(false)
  return (
    <motion.span
      key={flight.id}
      initial={{ ...variants.initial, left: flight.from.left, top: flight.from.top }}
      animate={{ ...variants.animate, left: flight.to.left, top: flight.to.top }}
      transition={variants.transition}
      onAnimationComplete={() => onComplete?.()}
      aria-hidden
      className="pointer-events-none fixed z-[60] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-100 shadow-[0_0_28px_rgba(34,211,238,0.8)]"
    />
  )
}

function useExecutionWeavePlacement(): ExecutionWeavePlacement {
  const [placement, setPlacement] = useState<ExecutionWeavePlacement>("document")
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1180px)")
    const sync = () => setPlacement(media.matches ? "side" : "document")
    sync()
    media.addEventListener?.("change", sync)
    return () => media.removeEventListener?.("change", sync)
  }, [])
  return placement
}

/** LF-07 canvas depth: every non-spine surface consumes the same real
 * LIVEFRAME clarification focus. The wrapper changes only opacity, so the
 * controls remain mounted and reachable while the action spine stays at full
 * emphasis. */
function QuestionDepth({ surface, focused, reducedMotion, className = "", children }: { surface: string; focused: boolean; reducedMotion: boolean; className?: string; children: ReactNode }) {
  const variants = questionFocusLayerVariants(reducedMotion, focused)
  return (
    <motion.div
      initial={false}
      animate={variants.animate}
      transition={variants.transition}
      data-jarvis-question-depth={surface}
      data-jarvis-question-dimmed={focused ? "true" : "false"}
      className={className}
    >
      {children}
    </motion.div>
  )
}

function projectKernelOrbActions(kernel: ReturnType<typeof useKernel>): CorrelatedOrbAction[] {
  const rows = [
    ...kernel.selectorInput.pendingActions,
    ...(kernel.selectorInput.blockedActions ?? []),
  ]
  const byId = new Map<string, CorrelatedOrbAction>()
  for (const row of rows) {
    if (!row.id) continue
    byId.set(row.id, { id: row.id, instructionId: row.instructionId, status: row.status })
  }
  return [...byId.values()]
}

function LoadingGate() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#04070f]">
      <div className="flex items-center gap-3 text-lg font-black tracking-tight text-white">
        <span className="flex h-9 w-9 animate-pulse items-center justify-center rounded-xl bg-cyan-400/20 text-xs font-black text-cyan-200 shadow-lg">F</span>
        Waking JARVIS…
      </div>
    </div>
  )
}

function RoleErrorGate({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#04070f] px-6 text-center">
      <h1 className="text-lg font-black text-white">JARVIS could not load your workspace</h1>
      <p className="max-w-md j-fs-sm text-[color:var(--j-text-dim)]">{message}</p>
      <button type="button" onClick={onRetry} className="rounded-full bg-teal-300 px-4 py-1.5 j-fs-micro font-black text-slate-950 hover:bg-teal-200">
        Retry connection
      </button>
    </div>
  )
}

function AuthErrorGate({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#04070f] px-6 text-center">
      <h1 className="text-lg font-black text-white">JARVIS could not restore sign-in</h1>
      <p className="max-w-md j-fs-sm text-[color:var(--j-text-dim)]">{message}</p>
      <button type="button" onClick={onRetry} className="rounded-full bg-teal-300 px-4 py-1.5 j-fs-micro font-black text-slate-950 hover:bg-teal-200">
        Retry connection
      </button>
    </div>
  )
}

function SignInGate() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#04070f] px-6 text-center">
      <h1 className="text-lg font-black text-white">Sign in required</h1>
      <p className="max-w-sm j-fs-sm text-[color:var(--j-text-dim)]">The Instruction Thread works with real vitals, real approvals, and real execution for your own tenant.</p>
      <a href="/jarvis/login" className="rounded-full bg-teal-300 px-4 py-1.5 j-fs-micro font-black text-slate-950 hover:bg-teal-200">
        Sign in
      </a>
    </div>
  )
}

function NotOwnerGate() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#04070f] px-6 text-center">
      <h1 className="text-lg font-black text-white">This view is for owners right now</h1>
      <a href="/jarvis" className="j-fs-sm text-cyan-200 underline">
        Back to JARVIS
      </a>
    </div>
  )
}

function StandaloneReceiptView({ receiptId, onBack }: { receiptId: string; onBack: () => void }) {
  // T11: "the whole receipt is addressable at /jarvis/next#receipt-{id} and
  // survives refresh". A receipt is a real, fetch-by-id backend record — this
  // renders it directly, with no live thread required, which is what actually
  // makes a reload survivable (the ephemeral in-memory Thread does not persist
  // across a reload until P3's instruction_sessions ships; the RECEIPT itself,
  // being real stored data, already can).
  return (
    <div className="mx-auto max-w-[720px] px-4 pb-[calc(10rem+env(safe-area-inset-bottom))] pt-24 sm:pb-40">
      <button type="button" onClick={onBack} className="j-chip mb-3 border border-white/10 bg-white/[.035] text-[color:var(--j-text-dim)]">
        ← Back
      </button>
      <div className="j-panel rounded-xl border border-white/10 p-4">
        <ReceiptContent receiptId={receiptId} />
      </div>
    </div>
  )
}

function RestPrompt({
  overdue,
  pending,
  onRetry,
}: {
  overdue: Truth<{ count: number; totalUsd: number }>
  pending: Truth<number>
  onRetry?: () => void
}) {
  const segments: Array<{ source: "selectOverdueInvoices" | "selectPendingApprovals"; text: string }> = []
  if (overdue.status === "known" || overdue.status === "stale") {
    segments.push({
      source: "selectOverdueInvoices",
      text: `${overdue.value.count} invoice${overdue.value.count === 1 ? "" : "s"} overdue · $${overdue.value.totalUsd.toLocaleString("en-US")}`,
    })
  }
  if (pending.status === "known" || pending.status === "stale" || pending.status === "partial") {
    segments.push({
      source: "selectPendingApprovals",
      text: `${pending.value} approval${pending.value === 1 ? "" : "s"} waiting`,
    })
  }
  const errored = overdue.status === "unavailable"
  return (
    <div className="jarvis-rest-prompt flex min-h-0 flex-col items-center justify-center px-4 pb-[calc(10rem+env(safe-area-inset-bottom))] text-center sm:pb-0">
      <p className="j-fs-lg font-bold text-[color:var(--j-text)]">Tell JARVIS what you need.</p>
      {errored ? (
        <p className="j-fs-sm mt-2 text-[color:var(--j-red)]">
          Can&rsquo;t reach JARVIS.{" "}
          <button type="button" className="underline" onClick={onRetry}>Retry</button>
        </p>
      ) : (
        segments.length > 0 && (
          <p className="j-fs-sm mt-2 text-[color:var(--j-text-dim)]">
            {segments.map((segment, index) => (
              <span key={segment.source}>
                {index > 0 && " · "}
                <span data-jarvis-fact data-source={segment.source}>{segment.text}</span>
              </span>
            ))}
          </p>
        )
      )}
    </div>
  )
}

/** Shared visual body — Field + Orb + Thread + (approval) Cockpit + Rail. Both
 *  the real, live page and the dev-only fixture harness below render through
 *  this SAME function, so a fixture screenshot is evidence about the real
 *  component tree, not a separate mock of it. `showRail` is false in fixture
 *  mode — the rail submits real instructions via the real kernel, which a
 *  fixture thread has no backing kernel state for. */
function ThreadBody({
  thread,
  threadHistory,
  presence,
  overdueInvoices,
  pendingApprovals,
  activeRunCount,
  transport,
  voiceAmplitude,
  reducedMotion,
  onCancel,
  onAnswer,
  onSkip,
  onRetry,
  onRetryThread,
  showRail,
  fixtureLabel,
  fixtureLabelPlacement = "fixed",
  role = "owner",
  mode = "production",
  atmosphere,
  liveframe,
  orbActions,
  intentLaunch,
  onIntentAccepted,
  onIntentLaunchComplete,
  threadRestored = false,
  restoredTraceEventCount = 0,
}: {
  thread: ThreadData | null
  threadHistory: ThreadData[]
  presence: ReturnType<typeof derivePresence>
  overdueInvoices: Truth<{ count: number; totalUsd: number }>
  pendingApprovals: Truth<number>
  activeRunCount: number
  transport: TransportHealth
  /** The real local Vapi mic level; omitted by fixture/preview surfaces. */
  voiceAmplitude?: number
  reducedMotion: boolean
  onCancel: () => void
  onAnswer: (text: string) => void
  onSkip: () => void
  onRetry?: () => void
  onRetryThread?: () => void | Promise<void>
  showRail: boolean
  fixtureLabel?: string
  fixtureLabelPlacement?: "fixed" | "flow"
  role?: JarvisRole
  mode?: "production" | "showcase" | "preview"
  atmosphere?: ThreadAtmosphereState
  liveframe: LiveFrameProjection
  /** Pending/blocked rows already fetched by the shared data provider. The
   * adapter correlates them against this thread's instruction/action ids. */
  orbActions?: readonly CorrelatedOrbAction[]
  intentLaunch?: LiveFrameIntentLaunch | null
  onIntentAccepted?: () => void
  onIntentLaunchComplete?: () => void
  threadRestored?: boolean
  restoredTraceEventCount?: number
}) {
  const isApproving = role !== "technician" && thread?.machine.instructionState === "awaiting_approval"
  const showWeave = liveframe.linkedRunIds.length > 0 || liveframe.activeRunIds.length > 0 || liveframe.activeStepIds.length > 0
  const executionWeavePlacement = useExecutionWeavePlacement()
  const isRestComposition = role !== "technician" && !thread && !showWeave
  const sceneDirector = deriveSceneDirector(liveframe)
  const readyScene = sceneDirector.scene === "ready" && isRestComposition
  const showOperationalContext = sceneDirector.scene !== "listening"
  const presenceDocked = Boolean(thread && liveframe.mode !== "ready" && liveframe.mode !== "listening")
  const questionFocus = liveframe.focus === "clarification"
  const humanStatus = primaryStatus(liveframe)
  const [wakeCueKey, setWakeCueKey] = useState(0)
  const [standaloneApprovalOpen, setStandaloneApprovalOpen] = useState(false)
  const previousLiveframeModeRef = useRef<LiveFrameMode | null>(null)
  useEffect(() => {
    const previous = previousLiveframeModeRef.current
    previousLiveframeModeRef.current = liveframe.mode
    if (previous === null) return
    const moment = signatureMomentForEdge({ kind: "presence", previous, current: liveframe.mode })
    if (moment === "wake") setWakeCueKey((key) => key + 1)
  }, [liveframe.mode])
  // The rails are an owner-facing projection of the same kernel/data state.
  // Public preview stays deliberately sparse because it has no private source
  // observations to populate an operational surface with.
  // The labelled, non-production fixture harness intentionally exercises the
  // historical ThreadBody composition used by its visual regression pack.
  // Real owner sessions—including every Upgrade 10 journey—always use the
  // canonical adaptive workspace above; fixtureLabel is never supplied there.
  const showOperationalDeck = role === "owner" && !fixtureLabel
  if (showOperationalDeck) {
    return (
      <div
        className="jarvis-root min-h-screen overflow-x-hidden bg-[#04070f] text-[color:var(--j-text)]"
        data-jarvis-thread
        data-jarvis-mode={mode}
        data-liveframe-mode={liveframe.mode}
        data-liveframe-focus={liveframe.focus}
        data-liveframe-posture={liveframe.transportPosture}
        data-command-canvas-scene={sceneDirector.scene}
        data-source={fixtureLabel ? "fixture" : undefined}
        data-jarvis-adaptive-runtime
      >
        <ThreadField overdueInvoices={overdueInvoices} contextChips={thread?.contextChips ?? []} freezeMotion />
        <AdaptiveWorkspaceShell
          thread={thread}
          threadHistory={threadHistory}
          liveframe={liveframe}
          role={role}
          reducedMotion={reducedMotion}
          onAnswer={onAnswer}
          onCancel={onCancel}
          onRetry={onRetryThread ?? (() => {})}
          fixtureLabel={fixtureLabel}
          publicPreview={mode === "preview"}
          threadRestored={threadRestored}
          restoredTraceEventCount={restoredTraceEventCount}
          composer={showRail ? <CommandRail liveframe={liveframe} intentLaunch={intentLaunch} onIntentAccepted={onIntentAccepted} embedded /> : null}
        />
        <IntentLaunchTrail event={intentLaunch} reducedMotion={reducedMotion} onComplete={onIntentLaunchComplete} />
      </div>
    )
  }
  const visualState = deriveOrbVisualState({
    instructionId: thread?.instructionId,
    instructionState: thread?.machine.instructionState,
    answerResult: thread?.answerResult,
    actions: orbActions,
    currentActionIds: thread?.nodes.map((node) => node.id),
    transport,
    presence,
    liveFrame: liveframe,
  })
  const renderActionSpine = () => (
    <section className="jarvis-action-spine" data-liveframe-surface="action-spine" data-jarvis-composition-region="response" data-jarvis-orb-secondary="true">
      {!thread && <RestPrompt overdue={overdueInvoices} pending={pendingApprovals} onRetry={onRetry} />}
      {!thread && mode === "preview" && (
        <div className={orbSurfaceStyles.previewAccess} data-jarvis-composition-region="access">
          <a href="/jarvis/login" className="flex min-h-11 w-fit items-center rounded-full bg-teal-300 px-4 py-2.5 j-fs-sm font-black text-slate-950">
            Sign in
          </a>
        </div>
      )}
      {thread && <ThreadStack thread={thread} threadHistory={threadHistory} onCancel={onCancel} onAnswer={onAnswer} onSkip={onSkip} onRetry={onRetryThread} reducedMotion={reducedMotion} intentLaunch={intentLaunch} executionWeavePlacement={executionWeavePlacement} executionEnergy={liveframe.energy} threadRestored={threadRestored} restoredTraceEventCount={restoredTraceEventCount} />}
      {role === "dispatcher" && <DispatchMap />}
    </section>
  )
  const renderStage = () => {
    if (role === "technician") {
      return <main className="mx-auto max-w-lg px-4 pb-[calc(10rem+env(safe-area-inset-bottom))] pt-8 lg:pb-32"><MyDay /></main>
    }
    if (isRestComposition) {
      return (
        <main className={`jarvis-canvas jarvis-rest-composition${mode === "preview" ? " jarvis-canvas--preview" : ""}`} data-liveframe-composition="rest" data-jarvis-composition-region="stage" data-jarvis-orb-composition="ambient">
          <QuestionDepth surface="presence" focused={questionFocus} reducedMotion={reducedMotion} className="w-full min-w-0">
            <PresenceCore
              liveframe={liveframe}
              visualState={visualState}
              forceLowPower={atmosphere?.forceLowPower}
              docked={false}
              intentLaunch={intentLaunch}
              reducedMotion={reducedMotion}
              showVoiceControl={showRail && !showOperationalDeck}
              wakeCueKey={wakeCueKey}
              telemetry={<OrbIntelligenceReadout thread={thread} liveframe={liveframe} pendingApprovals={pendingApprovals} fixtureLabel={fixtureLabel} primaryStatus={humanStatus} />}
            />
          </QuestionDepth>
          {renderActionSpine()}
        </main>
      )
    }
    // The live composition owns its two-column no-weave geometry in the
    // canonical command-canvas stylesheet. Do not also apply the old ambient
    // layout module here: it collapses all children into grid column one and
    // shrinks the real Thread to its min-content width.
    return (
      <main className={`jarvis-canvas jarvis-live-layout ${showWeave ? "jarvis-live-layout--weave" : "jarvis-live-layout--no-weave"}`} data-liveframe-composition="live" data-jarvis-composition-region="stage" data-jarvis-orb-composition="ambient">
        <QuestionDepth surface="presence" focused={questionFocus} reducedMotion={reducedMotion} className="w-full min-w-0">
          <aside className="jarvis-presence-rail" data-jarvis-orb-composition="ambient">
            <PresenceCore
              liveframe={liveframe}
              visualState={visualState}
              forceLowPower={atmosphere?.forceLowPower}
              deferWebgl={showWeave}
              docked={presenceDocked}
              intentLaunch={intentLaunch}
              reducedMotion={reducedMotion}
              showVoiceControl={showRail && !showOperationalDeck}
              wakeCueKey={wakeCueKey}
              telemetry={<OrbIntelligenceReadout thread={thread} liveframe={liveframe} pendingApprovals={pendingApprovals} fixtureLabel={fixtureLabel} primaryStatus={humanStatus} />}
            />
          </aside>
        </QuestionDepth>
        {renderActionSpine()}
        {showWeave && executionWeavePlacement === "side" && thread && (
          <QuestionDepth surface="execution-weave" focused={questionFocus} reducedMotion={reducedMotion} className="w-full min-w-0">
            <ThreadExecutionWeave thread={thread} restored={threadRestored} energy={liveframe.energy} />
          </QuestionDepth>
        )}
      </main>
    )
  }
  // In the owner command center, the real command rail belongs directly below
  // the intelligence surface rather than after the tallest side rail. This is
  // presentation-only: it is still the same authenticated input, voice, and
  // keyboard contract. Non-owner/preview surfaces retain their existing dock.
  const renderCommandDock = () => showRail && !isApproving ? (
    <div data-jarvis-composition-region="controls" data-scene-dock={sceneDirector.dock} data-scene-focus={sceneDirector.focus}>
      <QuestionDepth surface="command-dock" focused={questionFocus} reducedMotion={reducedMotion}>
        <CommandRail liveframe={liveframe} intentLaunch={intentLaunch} onIntentAccepted={onIntentAccepted} embedded={showOperationalDeck} />
      </QuestionDepth>
    </div>
  ) : null
  return (
    <div
      className="jarvis-root relative min-h-screen bg-[#04070f] text-[color:var(--j-text)]"
      data-jarvis-thread
      data-jarvis-mode={mode}
      data-source={fixtureLabel ? "fixture" : undefined}
      data-mood={atmosphere?.mood}
      data-daypart={atmosphere?.daypart}
      data-low-power={atmosphere?.forceLowPower || undefined}
      data-relighting={atmosphere?.relighting || undefined}
      data-liveframe-mode={liveframe.mode}
      data-liveframe-focus={liveframe.focus}
      data-liveframe-posture={liveframe.transportPosture}
      data-command-canvas-scene={sceneDirector.scene}
      data-scene-dominant={sceneDirector.dominant}
      data-scene-orb-position={sceneDirector.orbPosition}
      data-scene-orb-size={sceneDirector.orbSize}
      data-scene-orb-scale={sceneDirector.orbScale}
      data-scene-now-rail={sceneDirector.nowRail}
      data-scene-business-pulse={sceneDirector.businessPulse}
      data-scene-thread={sceneDirector.thread}
      data-scene-dock={sceneDirector.dock}
      data-scene-focus={sceneDirector.focus}
      data-scene-allowed-animations={sceneDirector.allowedAnimations.join(",")}
      data-liveframe-weave={showWeave ? "true" : undefined}
      data-jarvis-orb-depth="ambient"
      data-jarvis-orb-composition="ambient"
      data-jarvis-question-focus={questionFocus ? "true" : "false"}
    >
      {atmosphere ? (
        <QuestionDepth surface="atmosphere" focused={questionFocus} reducedMotion={reducedMotion}>
          <ThreadAtmosphere atmosphere={atmosphere} liveframe={liveframe} />
        </QuestionDepth>
      ) : null}
      {atmosphere && (
        <QuestionDepth surface="event-atmosphere" focused={questionFocus} reducedMotion={reducedMotion}>
          <ThreadEventAtmosphere instructionState={thread?.machine.instructionState ?? null} transport={atmosphere.transport} />
        </QuestionDepth>
      )}
      {fixtureLabel && (
        <div className={fixtureLabelPlacement === "flow" ? "relative z-50 mx-auto flex w-fit justify-center pt-2" : "fixed left-1/2 top-2 z-50 -translate-x-1/2"}>
          <span className="j-chip border border-violet-300/40 bg-violet-400/15 text-violet-200">FIXTURE · {fixtureLabel}</span>
        </div>
      )}
      <QuestionDepth surface="field" focused={questionFocus} reducedMotion={reducedMotion}>
      <ThreadField overdueInvoices={overdueInvoices} contextChips={thread?.contextChips ?? []} freezeMotion={showWeave} />
      </QuestionDepth>
      <div className={`${orbSurfaceStyles.consoleStack} relative z-[1] jarvis-console-stack`} data-jarvis-console-stack data-jarvis-orb-composition="ambient">
        <OperationsHeader
          liveframe={liveframe}
          diagnostics={atmosphere ? <DiagnosticsDisclosure atmosphere={atmosphere} onRetry={onRetry} /> : undefined}
          environment={mode === "production" ? undefined : <ModeChip mode={mode} />}
          showSignIn={mode !== "preview"}
        />
        {showOperationalDeck ? <OperationalCommandIndex ready={readyScene} /> : null}
        {showOperationalDeck ? (
          <div className={`jarvis-command-deck${readyScene ? " jarvis-command-deck--ready" : ""}`} data-liveframe-scene={sceneDirector.scene} data-command-canvas-scene={sceneDirector.scene} data-scene-business-pulse={sceneDirector.businessPulse} data-liveframe-weave={showWeave ? "true" : undefined}>
            {showOperationalContext ? (
              <QuestionDepth surface="operational-context" focused={questionFocus} reducedMotion={reducedMotion} className="min-w-0">
                <OperationalContextRail thread={thread} liveframe={liveframe} pendingApprovals={pendingApprovals} overdueInvoices={overdueInvoices} fixtureLabel={fixtureLabel} />
              </QuestionDepth>
            ) : null}
            <div id="jarvis-command-core" className="jarvis-command-deck__stage min-w-0">
              {renderStage()}
              {renderCommandDock()}
            </div>
            <QuestionDepth surface="operational-signals" focused={questionFocus} reducedMotion={reducedMotion} className="min-w-0">
              <OperationalSignalRail thread={thread} liveframe={liveframe} pendingApprovals={pendingApprovals} fixtureLabel={fixtureLabel} onReviewApprovals={() => {
                setStandaloneApprovalOpen(true)
                window.setTimeout(() => document.getElementById("jarvis-standalone-approvals")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" }), 0)
              }} />
            </QuestionDepth>
            <QuestionDepth surface="operations-floor" focused={questionFocus} reducedMotion={reducedMotion} className="jarvis-command-deck__floor min-w-0">
              {sceneDirector.businessPulse === "hidden" ? null : <BusinessPulse quiet={sceneDirector.businessPulse === "quiet"} />}
            </QuestionDepth>
          </div>
        ) : <>{renderStage()}{renderCommandDock()}</>}
      </div>
      {isApproving && thread && <ThreadApprovalCockpit thread={thread} onClose={() => {}} reducedMotion={reducedMotion} escalateOnly={role === "dispatcher"} restored={threadRestored} />}
      {standaloneApprovalOpen && !isApproving && role !== "technician" && (
        <section id="jarvis-standalone-approvals" className="relative z-20 mx-auto w-full max-w-5xl scroll-mt-4 px-4 pb-10" aria-label="Approval queue">
          <div className="mb-2 flex justify-end">
            <button type="button" onClick={() => setStandaloneApprovalOpen(false)} className="min-h-11 rounded-full border border-white/15 px-4 j-fs-micro font-black text-white/70 hover:text-white">Close approvals</button>
          </div>
          <ApprovalCockpit escalateOnly={role === "dispatcher"} />
        </section>
      )}
      <IntentLaunchTrail event={intentLaunch} reducedMotion={reducedMotion} onComplete={onIntentLaunchComplete} />
    </div>
  )
}

// jarvis-v3 P5.T7 — D3 pilot: "while a long action runs, JARVIS may narrate
// once via say. Best-effort." §6⑥'s own "silent during execution — do not
// narrate STEPS" forbids per-step chatter, not a single, content-free
// check-in — the decision/content details live in `lib/d3-narration.ts`
// (pure, unit-tested; BLOCKER B-1 means this effect itself cannot be).
function ThreadPage({ role }: { role: JarvisRole }) {
  const kernel = useKernel()
  const voice = useVapiSession()
  const reducedMotion = useReducedMotion() ?? false
  const atmosphere = useThreadAtmosphere(voice, kernel.transport, kernel.presence, {
    now: kernel.lane.now,
    lastPollAtMs: kernel.lane.lastPollAtMs,
    slowLastSuccessMs: kernel.lane.slowLastSuccessMs,
    apiLatencyMs: kernel.lane.apiLatencyMs,
  })
  const [intentLaunch, setIntentLaunch] = useState<LiveFrameIntentLaunch | null>(null)
  const intentLaunchIdRef = useRef(0)
  const onIntentAccepted = useCallback(() => {
    intentLaunchIdRef.current += 1
    setIntentLaunch({
      id: intentLaunchIdRef.current,
      atMs: Date.now(),
      durationMs: INTENT_LAUNCH_DURATION_MS,
      kind: "intent-launch",
    })
  }, [])
  const onIntentLaunchComplete = useCallback(() => setIntentLaunch(null), [])
  const liveframe = projectKernelLiveFrame(kernel, voice.localVolumeLevel, intentLaunch)
  const orbActions = projectKernelOrbActions(kernel)
  const [standaloneReceiptId, setStandaloneReceiptId] = useState<string | null>(null)
  const executingNarratedThreadIdRef = useRef<string | null>(null)
  const answeredThreadKeyRef = useRef<string | null>(null)
  const approvalNarratedThreadKeyRef = useRef<string | null>(null)
  const currentThread = kernel.thread
  const say = voice.say

  useEffect(() => {
    const syncReceiptHash = () => setStandaloneReceiptId(receiptIdFromHash(window.location.hash))
    syncReceiptHash()
    window.addEventListener("hashchange", syncReceiptHash)
    return () => window.removeEventListener("hashchange", syncReceiptHash)
  }, [])

  useEffect(() => {
    // Consequential work keeps its explicit approval prompt. A read-only
    // completion instead speaks the backend-grounded summary exactly once;
    // there is no generic completion narration to blur the two experiences.
    const thread = currentThread
    if (!thread) return
    const answer = thread.answerResult
    if (answer) {
      const key = `${thread.instructionId ?? thread.id}:${answer.spokenSummary}`
      if (answeredThreadKeyRef.current !== key) {
        answeredThreadKeyRef.current = key
        say(answer.spokenSummary)
      }
      return
    }
    if (thread.machine.instructionState === "awaiting_approval" && thread.nodes.length > 0) {
      const key = `${thread.instructionId ?? thread.id}:approval`
      if (approvalNarratedThreadKeyRef.current !== key) {
        approvalNarratedThreadKeyRef.current = key
        say(`${approvalConsequencePrompt(thread.nodes)} Want me to go ahead?`)
      }
    }
  }, [currentThread, say])

  // jarvis-v3 P5.T7 — D3 pilot (see D3_LONG_EXECUTION_MS's own header
  // comment for why this is content-free and one-shot). Separate effect from
  // the plan/outcome narration above: this one needs a real elapsed-time
  // trigger, not a state-transition edge.
  useEffect(() => {
    const thread = kernel.thread
    if (thread?.answerResult || !shouldFireD3Narration(thread?.id, thread?.machine.instructionState, executingNarratedThreadIdRef.current)) return
    const timer = window.setTimeout(() => {
      executingNarratedThreadIdRef.current = thread!.id
      voice.say(D3_NARRATION_TEXT)
    }, D3_LONG_EXECUTION_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel.thread?.id, kernel.thread?.machine.instructionState, kernel.thread?.answerResult?.spokenSummary])

  if (standaloneReceiptId) {
    return (
      <StandaloneReceiptView
        receiptId={standaloneReceiptId}
          onBack={() => {
            setStandaloneReceiptId(null)
            window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
          }}
      />
    )
  }

  return (
    <ThreadBody
      thread={kernel.thread}
      threadHistory={kernel.threadHistory}
      presence={kernel.presence}
      overdueInvoices={kernel.overdueInvoices}
      pendingApprovals={kernel.pendingApprovals}
      activeRunCount={kernel.selectorInput.runs.length}
      transport={kernel.transport}
      voiceAmplitude={kernel.presence === "hearing" ? voice.localVolumeLevel : undefined}
      reducedMotion={reducedMotion}
      onCancel={kernel.cancelThread}
      onAnswer={kernel.answerClarification}
      onSkip={kernel.cancelThread}
      onRetry={kernel.refetchSlowLaneNow}
      onRetryThread={kernel.retryThread}
      showRail
      role={role}
      mode={kernel.mode}
      atmosphere={atmosphere}
      liveframe={liveframe}
      orbActions={orbActions}
      intentLaunch={intentLaunch}
      onIntentAccepted={onIntentAccepted}
      onIntentLaunchComplete={onIntentLaunchComplete}
      threadRestored={kernel.threadRestored}
      restoredTraceEventCount={kernel.restoredTraceEventCount}
    />
  )
}

function PreviewThread() {
  const kernel = useKernel()
  const voice = useVapiSession()
  const reducedMotion = useReducedMotion() ?? false
  const atmosphere = useThreadAtmosphere(voice, kernel.transport, kernel.presence, {
    now: kernel.lane.now,
    lastPollAtMs: kernel.lane.lastPollAtMs,
    slowLastSuccessMs: kernel.lane.slowLastSuccessMs,
    apiLatencyMs: kernel.lane.apiLatencyMs,
  })
  const liveframe = projectKernelLiveFrame(kernel)
  return <ThreadBody thread={null} threadHistory={[]} presence={kernel.presence} overdueInvoices={kernel.overdueInvoices} pendingApprovals={kernel.pendingApprovals} activeRunCount={0} transport={kernel.transport} reducedMotion={reducedMotion} onCancel={() => {}} onAnswer={() => {}} onSkip={() => {}} onRetry={kernel.refetchSlowLaneNow} onRetryThread={() => {}} showRail={false} mode="preview" atmosphere={atmosphere} liveframe={liveframe} threadRestored={false} />
}

// ---------------------------------------------------------------------------
// P2 exit-gate evidence harness — see thread-fixtures.ts's own header for why
// this exists and what it can and cannot prove. `NODE_ENV !== "production"` is
// the ONLY gate (no owner/session check), by design: the whole point is to be
// reachable without the credentials this environment does not have. This can
// never reach a production build regardless of query string.
// ---------------------------------------------------------------------------
function ThreadFixtureHarness({ fixtureKey, restored = false }: { fixtureKey: string; restored?: boolean }) {
  const reducedMotion = useReducedMotion() ?? false
  const kernel = useKernel()
  const [fixture, setFixture] = useState<{ thread: ThreadData | undefined; history: ThreadData[]; keys: string[]; frameSignals: { micOpen: boolean; voiceSpeaking: boolean }; frameFixture: boolean } | null>(null)

  useEffect(() => {
    let active = true
    void import("./thread-fixtures").then(({ THREAD_FIXTURES, THREAD_HISTORY_FIXTURES, FIXTURE_FRAME_SIGNALS, FIXTURE_STATE_KEYS }) => {
      if (!active) return
      setFixture({
        thread: THREAD_FIXTURES[fixtureKey],
        history: THREAD_HISTORY_FIXTURES[fixtureKey] ?? [],
        keys: FIXTURE_STATE_KEYS,
        frameSignals: FIXTURE_FRAME_SIGNALS[fixtureKey] ?? { micOpen: false, voiceSpeaking: false },
        frameFixture: Boolean(FIXTURE_FRAME_SIGNALS[fixtureKey]),
      })
    })
    return () => { active = false }
  }, [fixtureKey])

  if (!fixture) return null
  const { thread, frameSignals, frameFixture } = fixture
  if (!thread && fixtureKey !== "rest" && !frameFixture) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#04070f] text-center text-white">
        Unknown fixture &ldquo;{fixtureKey}&rdquo;. Known: {fixture.keys.join(", ")}
      </div>
    )
  }
  const fixtureThread = thread ?? null
  // The fixture label remains the authority boundary: this is a real
  // source-labelled Thread tree, with optional intercepted workflow GET data
  // supplied through the same KernelProvider bridge as production. It is not a
  // second run store and it never creates a business event.
  const workflowRuns = kernel.selectorInput.terminalRuns
    ? [...kernel.selectorInput.runs, ...kernel.selectorInput.terminalRuns]
    : kernel.selectorInput.runs
  const presence = derivePresence({
    transport: "polling",
    activeInstructionState: fixtureThread?.machine.instructionState ?? null,
    terminalDecayActive: true,
    voiceSpeaking: frameSignals.voiceSpeaking,
    micOpen: frameSignals.micOpen,
    blockedCount: 0,
    needsHumanReviewCount: 0,
  })
  const liveframe = deriveLiveFrame({
    presence,
    transport: "polling",
    micOpen: frameSignals.micOpen,
    voiceSpeaking: frameSignals.voiceSpeaking,
    nowMs: kernel.selectorInput.now,
    instruction: fixtureThread
      ? {
          state: fixtureThread.machine.instructionState,
          actionIds: fixtureThread.nodes.map((node) => node.id),
          clarificationRequired: fixtureThread.clarification !== null || fixtureThread.machine.instructionState === "clarifying",
          approvalRequired: fixtureThread.machine.instructionState === "awaiting_approval",
          verificationActive: fixtureThread.machine.instructionState === "verifying",
        }
      : null,
    workflowRuns,
    latestImpulse: null,
  })
  return (
    <ThreadBody
      thread={fixtureThread}
      threadHistory={fixture.history}
      presence={presence}
      overdueInvoices={{ status: "known", value: { count: 6, totalUsd: 4200 }, source: "fixture", atMs: 0 }}
      pendingApprovals={{ status: "known", value: 2, source: "fixture", atMs: 0 }}
      activeRunCount={fixtureThread?.machine.instructionState === "executing" ? fixtureThread.nodes.length : 0}
      transport="polling"
      reducedMotion={reducedMotion}
      onCancel={() => {}}
      onAnswer={() => {}}
      onSkip={() => {}}
      onRetryThread={() => {}}
      showRail={false}
      fixtureLabel={fixtureKey}
      fixtureLabelPlacement="flow"
      liveframe={liveframe}
      threadRestored={restored}
    />
  )
}

// P3 exit-gate evidence harness. This is a visibly labelled, dev-only journey
// through the same ThreadBody/ThreadStack/Thread components using the existing
// source-labelled fixture states. The button makes each same-document edge
// deterministic for a recording; it never reaches the kernel or a backend.
function FixtureJourneyHarness({ signature = false }: { signature?: boolean } = {}) {
  const reducedMotion = useReducedMotion() ?? false
  const [fixtures, setFixtures] = useState<{ threads: Record<string, ThreadData>; frameSignals: Record<string, { micOpen: boolean; voiceSpeaking: boolean }> } | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [measurements, setMeasurements] = useState<TracePixelMeasurement[]>([])

  useEffect(() => {
    let active = true
    void import("./thread-fixtures").then(({ THREAD_FIXTURES, FIXTURE_FRAME_SIGNALS }) => {
      if (active) setFixtures({ threads: THREAD_FIXTURES, frameSignals: FIXTURE_FRAME_SIGNALS })
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    resetTracePixelMeasurements()
    return onTracePixelMeasurement((measurement) => {
      if (measurement.instructionId !== FIXTURE_JOURNEY_INSTRUCTION_ID) return
      setMeasurements((previous) => [...previous, measurement].slice(-20))
    })
  }, [])

  if (!fixtures) return null
  const journeySteps = signature ? SIGNATURE_JOURNEY_STEPS : FIXTURE_JOURNEY_STEPS
  const step = journeySteps[stepIndex]!
  const fixtureThread = step.key === "rest" || step.key === "listening" ? null : fixtures.threads[step.key] ?? null
  if (step.key !== "rest" && step.key !== "listening" && !fixtureThread) return null
  const frameSignals = fixtures.frameSignals[step.key] ?? { micOpen: false, voiceSpeaking: false }

  const presence = derivePresence({
    transport: "polling",
    activeInstructionState: fixtureThread?.machine.instructionState ?? null,
    terminalDecayActive: true,
    voiceSpeaking: frameSignals.voiceSpeaking,
    micOpen: frameSignals.micOpen,
    blockedCount: 0,
    needsHumanReviewCount: 0,
  })
  const liveframe = deriveLiveFrame({
    presence,
    transport: "polling",
    micOpen: frameSignals.micOpen,
    voiceSpeaking: frameSignals.voiceSpeaking,
    nowMs: 0,
    instruction: fixtureThread
      ? {
          state: fixtureThread.machine.instructionState,
          actionIds: fixtureThread.nodes.map((node) => node.id),
          clarificationRequired: fixtureThread.clarification !== null || fixtureThread.machine.instructionState === "clarifying",
          approvalRequired: fixtureThread.machine.instructionState === "awaiting_approval",
          verificationActive: fixtureThread.machine.instructionState === "verifying",
        }
      : null,
    workflowRuns: [],
    latestImpulse: null,
  })

  const advance = () => {
    const nextIndex = Math.min(stepIndex + 1, journeySteps.length - 1)
    if (nextIndex === stepIndex) return
    const next = journeySteps[nextIndex]!
    if (next.phase) {
      recordTraceEventReceived(FIXTURE_JOURNEY_INSTRUCTION_ID, { seq: nextIndex, phase: next.phase }, performance.now())
    }
    setStepIndex(nextIndex)
  }

  return (
    <div data-fixture-journey>
      <div data-fixture-journey-controls className="relative z-[60] mx-auto flex w-full max-w-[720px] items-center justify-center gap-2 px-4 pt-4 text-violet-100">
        <span data-fixture-journey-state={step.key} data-fixture-journey-label={step.label} className="j-fs-micro rounded-full border border-violet-300/30 bg-slate-950/90 px-3 py-2 font-bold uppercase tracking-widest">{step.label}</span>
        <button type="button" data-fixture-journey-next onClick={advance} disabled={stepIndex >= journeySteps.length - 1} className="min-h-9 rounded-full border border-violet-300/40 bg-slate-950/90 px-3 j-fs-sm disabled:opacity-40">
          {stepIndex >= journeySteps.length - 1 ? "Journey complete" : "Advance fixture"}
        </button>
      </div>
      <ThreadBody
        thread={fixtureThread}
        threadHistory={[]}
        presence={presence}
        overdueInvoices={{ status: "known", value: { count: 6, totalUsd: 4200 }, source: "fixture", atMs: 0 }}
        pendingApprovals={{ status: "known", value: 2, source: "fixture", atMs: 0 }}
        activeRunCount={fixtureThread && (step.key === "execution" || step.key === "verifying") ? fixtureThread.nodes.length : 0}
        transport="polling"
        reducedMotion={reducedMotion}
        onCancel={() => {}}
        onAnswer={() => {}}
        onSkip={() => {}}
        onRetry={() => {}}
        onRetryThread={() => {}}
        showRail={false}
        fixtureLabel={signature ? "signature-journey" : "journey"}
        fixtureLabelPlacement="flow"
        liveframe={liveframe}
        threadRestored={false}
      />
      <div data-fixture-trace-metrics aria-label="Fixture event to pixel metrics" className="mx-auto mb-8 mt-4 w-[calc(100%-1.5rem)] max-w-[720px] rounded-lg border border-violet-300/20 bg-slate-950/90 px-3 py-2 text-violet-100">
        {measurements.map((measurement) => (
          <div key={`${measurement.seq}-${measurement.stage}`} data-fixture-trace-metric data-fixture-trace-metric-seq={measurement.seq} data-fixture-trace-metric-stage={measurement.stage} data-fixture-trace-event-to-pixel-ms={measurement.eventToPixelMs} className="j-fs-micro">
            {measurement.phase} → {measurement.stage}: {measurement.eventToPixelMs}ms
          </div>
        ))}
      </div>
    </div>
  )
}

function ThreadGate() {
  const auth = useJarvisAuth()
  // Render the truthful public preview during the first server/client paint;
  // the dev-only fixture query is still resolved immediately after hydration.
  // This keeps the canonical route from shipping a blank client-only document
  // while preserving the same source-labelled fixture boundary.
  const [fixtureKey, setFixtureKey] = useState<string | null | undefined>(null)
  const [fixtureRestored, setFixtureRestored] = useState(false)

  useEffect(() => {
    if (process.env.NODE_ENV === "production") {
      setFixtureKey(null)
      return
    }
    const params = new URLSearchParams(window.location.search)
    setFixtureKey(params.get("fixture"))
    setFixtureRestored(params.get("restore") === "1")
  }, [])

  if (fixtureKey === undefined) return null // avoid a hydration flash either way
  if (fixtureKey === "journey") return <FixtureJourneyHarness />
  if (fixtureKey === "signature-journey") return <FixtureJourneyHarness signature />
  if (fixtureKey) return <ThreadFixtureHarness fixtureKey={fixtureKey} restored={fixtureRestored} />

  if (auth.loading) return <LoadingGate />
  if (auth.authError) return <AuthErrorGate message={auth.authError} onRetry={auth.retryAuth} />
  if (!auth.session) return <PreviewThread />
  if (auth.roleError) return <RoleErrorGate message={auth.roleError} onRetry={auth.retryRole} />
  if (auth.roleLoading || auth.role === null) return <LoadingGate />
  return <ThreadPage role={auth.role} />
}

export function InstructionThreadBridge({ standalone = true }: { standalone?: boolean } = {}) {
  return standalone ? (
    <KernelProvider>
      <ThreadGate />
    </KernelProvider>
  ) : (
    <ThreadGate />
  )
}

/** Backward-compatible name for the standalone Thread route. */
export function Bridge() {
  return <InstructionThreadBridge />
}
