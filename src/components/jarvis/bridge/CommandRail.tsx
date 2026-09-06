"use client"

// The Instruction Thread — Command Rail (plan v3 §2.2/§6⓪/§3.4, P2.T6).
//
// Pinned, always focusable, `/` · `⌘K` · push-to-talk. Work voice and typed
// input share the same authenticated `kernel.submit(text, source)` path; Vapi
// supplies only the browser microphone and transcription transport.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { LoaderCircle, Mic, Send, Square } from "lucide-react"
import { canContinueWork, useKernel, type SubmissionOutcome } from "../kernel/store"
import { useVapiSession, VAPI_WEB_ASSISTANT_ID } from "../lib/useVapiSession"
import { intentLaunchVariants, railCommitVariants, transcriptInkVariants } from "../kernel/choreography"
import { sfx } from "../sound"
import { CommandPaletteV2, useCommandPaletteV2 } from "../lib/CommandPaletteV2"
import { registerAnchor } from "../lib/pulse-bus"
import { deriveVoiceStateCopy } from "../lib/voice-state"
import { nextVoiceFinalIntent } from "../lib/voice-final-intent"
import { OpsPanel } from "./OpsPanel"
import { RecentThreadsPanel } from "./RecentThreadsPanel"
import { sessionIdForVoiceCall } from "../kernel/instruction"
import type { InstructionState } from "../kernel/types"
import type { LiveFrameIntentLaunch, LiveFrameProjection } from "../kernel/liveframe"
import { useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { useOperatingInteractionActions } from "../kernel/operating-interaction"

const HOLD_TO_TALK_MS = 360

function railBusy(state: InstructionState | null): { disabled: boolean; placeholder?: string; cancelable: boolean } {
  switch (state) {
    case "captured":
      return { disabled: true, placeholder: "JARVIS is accepting…", cancelable: true }
    case "understanding":
      return { disabled: true, placeholder: "JARVIS is resolving context…", cancelable: true }
    case "planning":
      return { disabled: true, placeholder: "JARVIS is planning…", cancelable: true }
    case "stopping":
      return { disabled: true, placeholder: "JARVIS is stopping…", cancelable: false }
    case "clarifying":
      return { disabled: false, placeholder: "Answer above, or ask something else", cancelable: true }
    case "awaiting_approval":
    case "executing":
    case "verifying":
      return { disabled: true, cancelable: true }
    default:
      return { disabled: false, cancelable: false }
  }
}

type MicControlVariant = "dock" | "orb"
type TranscriptInk = { text: string; phase: "partial" | "final" }

/** Vapi/provider versions expose the call identity at slightly different
 *  boundaries. Read only the provider-owned identity when present; the kernel
 *  falls back to its browser voice session id when this deployment does not
 *  expose one. */
function readProviderCallId(provider: unknown): string | null {
  if (!provider || typeof provider !== "object") return null
  const value = provider as Record<string, unknown>
  const call = value.call && typeof value.call === "object" ? value.call as Record<string, unknown> : null
  const activeCall = value.activeCall && typeof value.activeCall === "object" ? value.activeCall as Record<string, unknown> : null
  for (const candidate of [value.voiceSessionId, value.callId, value.vapiCallId, call?.id, call?.callId, activeCall?.id, activeCall?.callId]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return null
}

/**
 * One accessible mic control used by both the Presence Core and Command Dock.
 * Both controls consume the same context-provided session callbacks; neither
 * creates a Vapi instance. Space remains owned once by CommandRail's global
 * shortcut, while pointer/tap semantics live here for both visible controls.
 */
export function MicControlButton({
  variant,
  liveframe,
  children,
  className = "",
}: {
  variant: MicControlVariant
  liveframe?: LiveFrameProjection
  children?: ReactNode
  className?: string
}) {
  const kernel = useKernel()
  const { config: workspaceConfig } = useWorkspaceConfig()
  const voice = useVapiSession()
  const { startVoice, stopVoice, toggleVoice } = voice
  const reducedMotion = useReducedMotion() ?? false
  const threadState = kernel.thread?.machine.instructionState ?? null
  const inputDisabled = railBusy(threadState).disabled
  const voiceActive = voice.voiceState === "connecting" || voice.voiceState === "live" || voice.voiceState === "speaking"
  // A failed lazy SDK import is retryable. Keep the control available when the
  // dedicated assistant id exists; the visible availability/error row remains
  // the truthful feedback surface.
  const dedicatedVoiceConfigured = Boolean(VAPI_WEB_ASSISTANT_ID) && (voice.configured || Boolean(voice.lastError) || voice.voiceState === "connecting")
  const voiceControlDisabled = !workspaceConfig.voiceEnabled || (inputDisabled && !voiceActive) || !dedicatedVoiceConfigured
  const voiceHoldTimerRef = useRef<number | null>(null)
  const voiceHoldActiveRef = useRef(false)
  const voicePointerIdRef = useRef<number | null>(null)
  const suppressVoiceClickRef = useRef(false)

  const clearVoiceHoldTimer = useCallback(() => {
    if (voiceHoldTimerRef.current !== null) {
      window.clearTimeout(voiceHoldTimerRef.current)
      voiceHoldTimerRef.current = null
    }
  }, [])

  const startVoiceHold = useCallback(() => {
    voiceHoldActiveRef.current = true
    suppressVoiceClickRef.current = true
    void startVoice(VAPI_WEB_ASSISTANT_ID ?? null)
  }, [startVoice])

  const onVoicePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (voiceControlDisabled) return
    voicePointerIdRef.current = event.pointerId
    voiceHoldActiveRef.current = false
    suppressVoiceClickRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)

    // A short tap is handled by the native click below. Delaying only the
    // start of a long press lets the same control support both tap-to-toggle
    // and push-to-talk without opening a call twice.
    if (!voiceActive) {
      clearVoiceHoldTimer()
      voiceHoldTimerRef.current = window.setTimeout(startVoiceHold, HOLD_TO_TALK_MS)
    }
  }, [clearVoiceHoldTimer, startVoiceHold, voiceActive, voiceControlDisabled])

  const finishVoicePointer = useCallback((event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    if (voicePointerIdRef.current !== event.pointerId) return
    clearVoiceHoldTimer()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    voicePointerIdRef.current = null

    if (voiceHoldActiveRef.current) {
      voiceHoldActiveRef.current = false
      suppressVoiceClickRef.current = true
      void stopVoice()
    } else if (cancelled) {
      // Pointer cancellation must not fall through to a synthetic click that
      // would start a session after the user's finger has left the control.
      suppressVoiceClickRef.current = true
    }
  }, [clearVoiceHoldTimer, stopVoice])

  const onVoiceClick = useCallback(() => {
    if (suppressVoiceClickRef.current) {
      suppressVoiceClickRef.current = false
      return
    }
    if (voiceControlDisabled) return
    void toggleVoice(VAPI_WEB_ASSISTANT_ID ?? null)
  }, [toggleVoice, voiceControlDisabled])

  const cancelVoicePointer = useCallback(() => {
    const pointerWasActive = voicePointerIdRef.current !== null
    clearVoiceHoldTimer()
    voicePointerIdRef.current = null
    if (voiceHoldActiveRef.current) {
      voiceHoldActiveRef.current = false
      suppressVoiceClickRef.current = true
      void stopVoice()
    } else if (pointerWasActive) {
      // A window blur can prevent the browser from delivering pointercancel;
      // suppress the matching synthetic click so a cancelled touch cannot open
      // a new session after focus returns.
      suppressVoiceClickRef.current = true
    }
  }, [clearVoiceHoldTimer, stopVoice])

  useEffect(() => {
    window.addEventListener("blur", cancelVoicePointer)
    return () => {
      window.removeEventListener("blur", cancelVoicePointer)
      cancelVoicePointer()
    }
  }, [cancelVoicePointer])

  const label = !workspaceConfig.voiceEnabled
    ? "Voice is disabled for this tenant workspace"
    : voice.voiceState === "connecting"
    ? "Connecting microphone"
    : voiceActive
      ? "End voice session"
      : "Tap to talk, or hold and release to push to talk"
  const dockContent = voice.voiceState === "connecting"
    ? <LoaderCircle className={`h-3.5 w-3.5${reducedMotion ? "" : " animate-spin"}`} />
    : voiceActive
      ? <Square className="h-3 w-3 fill-current" />
      : <Mic className="h-3.5 w-3.5" />
  const variantClass = variant === "orb"
    ? "relative block cursor-pointer touch-none select-none appearance-none rounded-full bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/80 disabled:cursor-not-allowed"
    : `inline-flex h-11 min-w-11 shrink-0 touch-none select-none items-center justify-center gap-1.5 rounded-xl border px-2.5 j-fs-micro font-black transition disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto ${
        voiceActive
          ? "border-cyan-200/50 bg-cyan-300/15 text-cyan-100"
          : "border-white/10 bg-white/[.045] text-[color:var(--j-text-dim)] hover:border-cyan-200/40 hover:text-cyan-100"
      }`

  return (
    <button
      type="button"
      data-voice-control="true"
      data-voice-state={voice.voiceState}
      data-liveframe-energy={liveframe?.energy}
      data-voice-energy={liveframe?.voiceEnergy}
      aria-pressed={voiceActive}
      aria-busy={voice.voiceState === "connecting"}
      aria-label={label}
      title={!workspaceConfig.voiceEnabled ? "Voice is disabled for this tenant workspace" : voiceActive ? "End voice session" : "Tap to talk · hold and release to push to talk"}
      disabled={voiceControlDisabled}
      onPointerDown={onVoicePointerDown}
      onPointerUp={finishVoicePointer}
      onPointerCancel={(event) => finishVoicePointer(event, true)}
      onClick={onVoiceClick}
      onContextMenu={(event) => event.preventDefault()}
      className={`${variantClass} ${className}`.trim()}
    >
      {children ?? <><span aria-hidden>{dockContent}</span><span className="hidden sm:inline">{voice.voiceState === "connecting" ? "Connecting" : voiceActive ? "End" : "Talk"}</span></>}
    </button>
  )
}

export function CommandRail({
  liveframe,
  intentLaunch,
  onIntentAccepted,
  embedded = false,
}: {
  liveframe: LiveFrameProjection
  intentLaunch?: LiveFrameIntentLaunch | null
  onIntentAccepted?: () => void
  /** The owner command center mounts the exact same rail inside its central
   * stage so the composition remains dense. Other consumers keep the docked
   * viewport treatment. Interaction and submission wiring stay identical. */
  embedded?: boolean
}) {
  const kernel = useKernel()
  const interaction = useOperatingInteractionActions()
  const { config: workspaceConfig } = useWorkspaceConfig()
  const voice = useVapiSession()
  const { startVoice, stopVoice, transcript } = voice
  const palette = useCommandPaletteV2()
  const [opsOpen, setOpsOpen] = useState(false)
  const [recentThreadsOpen, setRecentThreadsOpen] = useState(false)
  const [value, setValue] = useState("")
  const [committing, setCommitting] = useState(false)
  const [transcriptInk, setTranscriptInk] = useState<TranscriptInk | null>(null)
  const [voiceRetrying, setVoiceRetrying] = useState(false)
  const [startNewWork, setStartNewWork] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dockRef = useRef<HTMLFormElement>(null)
  const spaceHeldRef = useRef(false)
  const reducedMotion = useReducedMotion() ?? false
  const voiceSessionBaselineRef = useRef(transcript.length)
  const processedVoiceFinalRef = useRef<string | null>(null)
  const previousVoiceStateRef = useRef(voice.voiceState)

  useEffect(() => {
    // LF-04's flight reads the real Dock rect after the layout has mounted;
    // the anchor registry owns no state and does not synthesize coordinates.
    return registerAnchor("command-dock", () => dockRef.current?.getBoundingClientRect() ?? null)
  }, [])

  const threadState = kernel.thread?.machine.instructionState ?? null
  const continuableWorkId = canContinueWork(kernel.thread) ? kernel.thread?.workId ?? null : null
  const continuingWork = Boolean(continuableWorkId) && !startNewWork
  const busy = railBusy(threadState)
  // A Work lifecycle state is not a global command lock. A stalled objective
  // must remain cancellable, but it must not freeze the rail or make the next
  // ordinary instruction inherit that Work. `continuingWork` is only true for
  // terminal Work, so an input submitted while this Work is active starts a
  // fresh Work through the normal `submit` path.
  const inputDisabled = committing
  const voiceActive = voice.voiceState === "connecting" || voice.voiceState === "live" || voice.voiceState === "speaking"
  const waveformOpen = voice.voiceState === "live" || voice.voiceState === "speaking"
  const voiceEnergy = liveframe.voiceEnergy
  const sharedEnergy = liveframe.energy
  // Fixed factors give the meter a stable silhouette. Its level and opacity
  // come only from LIVEFRAME's real local mic contribution and shared energy.
  const waveformFactors = [0.52, 0.78, 0.62, 1, 0.7]
  // A failed lazy SDK import is still retryable. Keep the control available
  // when the dedicated assistant id exists; `voice.configured` remains visible
  // below as truthful availability feedback instead of making Retry inert.
  const dedicatedVoiceConfigured = Boolean(VAPI_WEB_ASSISTANT_ID) && (voice.configured || Boolean(voice.lastError) || voice.voiceState === "connecting")
  const derivedVoiceCopy = deriveVoiceStateCopy({
    available: dedicatedVoiceConfigured,
    voiceState: voice.voiceState,
    userSpeaking: voice.userSpeaking,
    micSilenceWarning: voice.micSilenceWarning,
    lastError: voice.lastError,
    retrying: voiceRetrying,
  })
  const voiceCopy = workspaceConfig.voiceEnabled ? derivedVoiceCopy : { state: "unavailable" as const, label: "Voice off", detail: "Disabled for this tenant workspace.", retryable: false }
  const cancelInstruction = useCallback(() => {
    if (committing) return
    void kernel.cancelThread()
  }, [committing, kernel])
  const voiceSessionId = sessionIdForVoiceCall(
    typeof voice.voiceSessionId === "string" && voice.voiceSessionId.trim()
      ? voice.voiceSessionId
      : readProviderCallId(voice),
  )

  useEffect(() => {
    if (!continuableWorkId) setStartNewWork(false)
  }, [continuableWorkId])

  useEffect(() => {
    if (voiceRetrying && voice.voiceState !== "connecting") setVoiceRetrying(false)
  }, [voice.voiceState, voiceRetrying])

  useEffect(() => {
    const previous = previousVoiceStateRef.current
    const next = voice.voiceState
    const sessionStarted = (previous === "idle" || previous === "error") && next === "connecting"
    if (sessionStarted) {
      voiceSessionBaselineRef.current = transcript.length
      processedVoiceFinalRef.current = null
    }
    previousVoiceStateRef.current = next
  }, [transcript.length, voice.voiceState])

  const retryVoice = useCallback(() => {
    setVoiceRetrying(true)
    void startVoice(VAPI_WEB_ASSISTANT_ID ?? null).catch(() => setVoiceRetrying(false))
  }, [startVoice])

  const submitTyped = useCallback(async () => {
    const text = value.trim()
    if (!text || inputDisabled) return
    setCommitting(true)
    sfx.commit()
    setValue("")
    let outcome: SubmissionOutcome = "failed"
    try {
      outcome = threadState === "clarifying"
        ? await kernel.answerClarification(text)
        : continuingWork
          ? await kernel.continueWork(text, "typed")
          : await kernel.submit(text, "typed")
    } catch {
      outcome = "failed"
    } finally {
      // A failed API call must never leave the command rail in its committing
      // animation/disabled state. The previous path only cleared this flag on
      // success, which made a transient backend failure look like a dead input.
      setCommitting(false)
      if (outcome === "failed") setValue(text)
      if (outcome === "accepted") onIntentAccepted?.()
    }
  }, [value, inputDisabled, threadState, continuingWork, kernel, onIntentAccepted])

  // `/` focuses the rail from anywhere except while already typing in a field.
  // `⌘K` is NOT handled here — `useCommandPaletteV2()` already owns that
  // shortcut globally (own `keydown` listener); adding a second one here would
  // race it. `palette.open` is only consumed below to mount the palette.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable
      if (e.key === "/" && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }
      // The visible mic button owns pointer/touch gestures. Do not also handle
      // keyboard events dispatched from that button, or a native button Space
      // press would start a second session through this global listener.
      if (target?.closest("[data-voice-control]")) return
      // Hold-Space push-to-talk (§3.4 point 1) — never while typing (a normal
      // space keystroke in the input must stay a space, not start a call).
      if (e.code === "Space" && !typing && !spaceHeldRef.current && !inputDisabled && !voiceActive && dedicatedVoiceConfigured && workspaceConfig.voiceEnabled) {
        e.preventDefault()
        spaceHeldRef.current = true
        void startVoice(VAPI_WEB_ASSISTANT_ID ?? null)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && spaceHeldRef.current) {
        spaceHeldRef.current = false
        void stopVoice()
      }
    }
    const onWindowBlur = () => {
      if (!spaceHeldRef.current) return
      spaceHeldRef.current = false
      void stopVoice()
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onWindowBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onWindowBlur)
    }
  }, [dedicatedVoiceConfigured, inputDisabled, startVoice, stopVoice, voiceActive, workspaceConfig.voiceEnabled])

  // LF-03: each real Vapi partial replaces the visible ink. The final event
  // clears the partial state in the voice provider, but this local final ink
  // stays mounted until the authenticated kernel promise resolves or fails.
  useEffect(() => {
    const partial = voice.partialTranscript
    if (!partial) {
      setTranscriptInk((current) => (current?.phase === "partial" ? null : current))
      return
    }
    setTranscriptInk({ text: partial, phase: "partial" })
  }, [voice.partialTranscript])

  // On a final transcript, submit exactly like a typed Enter. Voice and typed
  // work instructions stay on the same authenticated kernel path; Vapi is only
  // the browser microphone/transcription transport.
  useEffect(() => {
    const pending = nextVoiceFinalIntent(transcript, voiceSessionBaselineRef.current, processedVoiceFinalRef.current)
    if (!pending) return
    // Do not mark this final as processed while another transition owns the
    // command rail. Once the current action releases the lock, this effect runs
    // again and submits the exact phrase instead of silently discarding it.
    if (inputDisabled) return
    processedVoiceFinalRef.current = pending.key
    sfx.commit()
    // Keep the final heard phrase visible while the authenticated kernel path
    // starts. Clearing it before this request resolves made voice feel like it
    // had been dropped, especially on a mobile network.
    setValue(pending.text)
    setTranscriptInk({ text: pending.text, phase: "final" })
    setCommitting(true)
    void (async () => {
      let outcome: SubmissionOutcome = "failed"
      try {
        outcome = threadState === "clarifying"
          ? await kernel.answerClarification(pending.text)
          : continuingWork
            ? await kernel.continueWork(pending.text, "voice", voiceSessionId ?? undefined)
            : await kernel.submit(pending.text, "voice", voiceSessionId ?? undefined)
      } catch {
        // The kernel reports normal transport failures as "failed"; this catch
        // keeps the same editable retry behavior for an unexpected rejection.
        outcome = "failed"
      } finally {
        setCommitting(false)
        if (outcome === "accepted") {
          setValue("")
          onIntentAccepted?.()
        }
        // On failure the underlying input still contains the exact final
        // phrase, now visible/editable after the lock overlay is removed.
        setTranscriptInk(null)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcript, inputDisabled, threadState, continuingWork, kernel, voiceSessionId])

  useEffect(() => {
    // jarvis-v3 P5.T6 (V4 barge-in) — real, live fix: §4.5's own rule is
    // "user speaking -> hearing"; `voice.voiceState === "speaking"` is the
    // ASSISTANT's own speaking turn (verified against the Vapi SDK's real
    // event semantics — see useVapiSession.tsx's own header note), not the
    // user's. `voice.userSpeaking` (real local-mic amplitude crossing the
    // same threshold the mic watchdog already trusts) is the correct signal
    // — this is also what makes a real barge-in show `hearing` promptly
    // instead of staying stuck on whatever the assistant's own turn state
    // was a moment ago.
    kernel.setVoiceIndicators({ micOpen: voice.voiceState === "live" || voice.voiceState === "speaking", speaking: voice.userSpeaking })
  }, [voice.voiceState, voice.userSpeaking, kernel])

  useEffect(() => {
    if (workspaceConfig.voiceEnabled || !voiceActive) return
    void stopVoice()
  }, [stopVoice, voiceActive, workspaceConfig.voiceEnabled])

  const showingPartial = Boolean(voice.partialTranscript)
  const commitVariants = railCommitVariants(reducedMotion)
  const canSend = Boolean(value.trim()) && !inputDisabled && !showingPartial
  const showVoiceStatus = committing || busy.cancelable || voiceCopy.state !== "stopped" || voiceCopy.retryable

  return (
    <div className={`pointer-events-none z-30 flex flex-col items-center gap-1.5 ${embedded ? "jarvis-command-rail--embedded relative w-full px-0 pb-0" : "fixed inset-x-0 bottom-0 px-3 pb-[max(env(safe-area-inset-bottom),12px)]"}`} data-jarvis-command-rail data-jarvis-command-rail-embedded={embedded || undefined} data-command-palette-ready={palette.ready ? "true" : "false"} data-intent-feedback={committing ? "pending" : intentLaunch ? "accepted" : "idle"}>
      <form
        ref={dockRef}
        onSubmit={(event) => {
          event.preventDefault()
          void submitTyped()
        }}
        className="pointer-events-auto relative w-full max-w-[720px]"
      >
        {continuableWorkId && (
          <aside className="jarvis-command-work-context" data-command-work-id={continuableWorkId} data-command-work-mode={startNewWork ? "new" : "continue"} aria-label="Command Work context">
            <div className="jarvis-command-work-context__copy"><span>Work mode</span><strong>{startNewWork ? "Start New Work" : "Continuing Work"}</strong><small>{startNewWork ? "Open a separate durable objective." : `${continuableWorkId.slice(0, 12)}… · text and voice stay on this Work.`}</small></div>
            <div className="jarvis-command-work-context__switch" role="group" aria-label="Choose Work mode">
              <button type="button" data-work-mode="continue" aria-pressed={!startNewWork} onClick={() => setStartNewWork(false)}>Continuing Work</button>
              <button type="button" data-work-mode="new" aria-pressed={startNewWork} onClick={() => { setStartNewWork(true); interaction.beginUnrelatedWork() }}>Start New Work</button>
            </div>
          </aside>
        )}
        {!continuableWorkId && (
          <aside className="jarvis-command-work-context" data-command-work-mode="new" data-command-work-empty aria-label="Command Work context">
            <div className="jarvis-command-work-context__copy"><span>Work mode</span><strong>Start New Work</strong><small>Your next instruction opens a separate durable objective.</small></div>
            <div className="jarvis-command-work-context__switch" role="group" aria-label="Choose Work mode">
              <button type="button" data-work-mode="continue" aria-pressed="false" disabled>Continuing Work</button>
              <button type="button" data-work-mode="new" aria-pressed="true">Start New Work</button>
            </div>
          </aside>
        )}
        <motion.div
          initial={false}
          animate={committing ? commitVariants.animate : commitVariants.initial}
          transition={commitVariants.transition}
          className="flex min-w-0 items-center gap-2 rounded-2xl border bg-[#05090f]/95 px-3 py-3 shadow-[0_10px_40px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:px-4 sm:py-3.5"
          style={{ borderColor: "rgba(34,211,238,0.25)" }}
        >
        <MicControlButton variant="dock" liveframe={liveframe} />
        <div
          className="relative min-w-0 flex-1"
          data-transcript-ink-phase={transcriptInk?.phase ?? "none"}
        >
          <AnimatePresence initial={false} mode="sync">
            {transcriptInk && (
              <motion.span
                key={`${transcriptInk.phase}:${transcriptInk.text}`}
                {...transcriptInkVariants(transcriptInk.phase, reducedMotion)}
                aria-hidden
                className={`pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap j-fs-base ${
                  transcriptInk.phase === "partial" ? "italic text-[color:var(--j-text-dim)]" : "text-[color:var(--j-text)]"
                }`}
              >
                {transcriptInk.text}
              </motion.span>
            )}
          </AnimatePresence>
          <input
            ref={inputRef}
            value={showingPartial ? voice.partialTranscript ?? "" : value}
            onChange={(e) => setValue(e.target.value)}
            disabled={inputDisabled || showingPartial}
            placeholder={committing ? "Sending instruction…" : busy.disabled ? "Start another Work…" : busy.placeholder ?? "Tell JARVIS what you need"}
            className={`j-fs-base min-w-0 w-full bg-transparent text-[color:var(--j-text)] outline-none placeholder:text-[color:var(--j-text-faint)] disabled:opacity-60 ${
              showingPartial ? "italic text-[color:var(--j-text-dim)]" : ""
            } ${transcriptInk ? "text-transparent caret-transparent" : ""}`}
            style={{ color: transcriptInk ? "transparent" : undefined }}
            aria-label="Tell JARVIS what you need"
            aria-busy={showingPartial || committing}
          />
        </div>
        {waveformOpen && (
          <div
            className="flex h-7 w-9 shrink-0 items-center justify-center gap-0.5"
            role="img"
            aria-label={`Microphone level ${Math.round(voiceEnergy * 100)} percent`}
            data-voice-waveform
            data-voice-energy={voiceEnergy}
            data-liveframe-energy={sharedEnergy}
          >
            {waveformFactors.map((factor) => (
              <span
                key={factor}
                aria-hidden
                className={`w-1 rounded-full${reducedMotion ? "" : " transition-[height,opacity] duration-100"}`}
                style={{
                  height: `${4 + voiceEnergy * 14 * factor}px`,
                  backgroundColor: "var(--j-cyan)",
                  opacity: 0.35 + sharedEnergy * 0.45,
                }}
              />
            ))}
          </div>
        )}
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send instruction"
          title="Send instruction"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cyan-200 text-slate-950 shadow-[0_0_26px_rgba(34,211,238,0.24)] transition hover:bg-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-35"
        >
          <Send className="h-4 w-4" />
        </button>
        </motion.div>
        {intentLaunch && (
          <motion.span
            key={intentLaunch.id}
            {...intentLaunchVariants(reducedMotion)}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-cyan-200/80 shadow-[0_0_34px_rgba(34,211,238,0.38)]"
          />
        )}
        <div
          className="jarvis-command-status mt-1.5 flex min-h-10 flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#05090f]/95 px-3 py-2 j-fs-micro text-[color:var(--j-text-dim)] shadow-[0_8px_24px_rgba(0,0,0,0.25)] backdrop-blur-xl"
          data-voice-state={voiceCopy.state}
          data-command-status-active={showVoiceStatus ? "true" : "false"}
          role="status"
          aria-live="polite"
        >
          <span className="min-w-0 flex-1">
            <span className="font-black text-[color:var(--j-text)]" data-voice-state-label>{committing ? "Instruction accepted" : busy.placeholder ?? (busy.cancelable ? "Work in progress" : showVoiceStatus ? voiceCopy.label : "Ready")}</span>
            <span className="ml-2" data-voice-state-detail>{committing ? "Live Work state is updating." : threadState === "stopping" ? "Waiting for canonical cancellation confirmation." : busy.cancelable && voiceCopy.state === "stopped" ? "Cancel remains available here." : showVoiceStatus ? voiceCopy.detail : "No instruction is in flight."}</span>
          </span>
          {busy.cancelable && <button type="button" className="min-h-9 shrink-0 rounded-lg border border-white/15 px-2.5 font-bold text-[color:var(--j-text)] hover:border-cyan-200/40 hover:text-cyan-100" onClick={cancelInstruction} disabled={committing}>Cancel</button>}
          {voiceCopy.retryable && (
            <button
              type="button"
              className="min-h-9 shrink-0 rounded-lg px-2 text-cyan-100 underline disabled:cursor-wait disabled:opacity-60"
              onClick={retryVoice}
              disabled={voiceRetrying}
            >
              {voiceRetrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      </form>
      <div className="pointer-events-none j-fs-micro text-center text-[color:var(--j-text-faint)]">
        <span className="sm:hidden">{workspaceConfig.voiceEnabled ? "Tap mic to talk · Enter to send" : "Enter to send · voice is off"}</span>
        <span className="hidden sm:inline">{workspaceConfig.voiceEnabled ? "/ to type · tap mic to talk · hold mic or Space, then release · ⌘K for anything else" : "/ to type · Enter to send · voice is disabled for this workspace · ⌘K for anything else"}</span>
      </div>
      {palette.open && (
        // P4.T7: the real "⌘K → Ops" destination opens OpsPanel below — a
        // single deliberate overlay, never a route, never a landing page
        // (§2.4/§8 PHASE 4). Navigate's scene switches ("Overview"/"Pipeline
        // theater") are legacy-Bridge-specific and stay a no-op on this page.
        <CommandPaletteV2
          onClose={() => palette.setOpen(false)}
          onNavigate={() => palette.setOpen(false)}
          onOpenOps={() => setOpsOpen(true)}
          onOpenRecentThreads={() => setRecentThreadsOpen(true)}
          onInstruct={async (text) => {
            const outcome = await kernel.submit(text, "typed")
            if (outcome === "accepted") onIntentAccepted?.()
          }}
        />
      )}
      <OpsPanel open={opsOpen} onClose={() => setOpsOpen(false)} />
      <RecentThreadsPanel open={recentThreadsOpen} onClose={() => setRecentThreadsOpen(false)} threads={kernel.recentThreads} status={kernel.recentThreadsStatus} activeThreadId={kernel.thread?.conversationThreadId ?? null} onSelect={kernel.openThread} />
    </div>
  )
}
