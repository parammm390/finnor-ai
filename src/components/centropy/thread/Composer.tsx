"use client"

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { ArrowUp, CornerDownLeft, Mic, RotateCcw, X } from "lucide-react"

interface RecognitionResultLike { 0: { transcript: string }; isFinal: boolean }
interface RecognitionEventLike { results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  continuous: boolean; interimResults: boolean; lang: string
  start: () => void; stop: () => void; abort?: () => void
  onstart: (() => void) | null; onresult: ((event: RecognitionEventLike) => void) | null
  onend: (() => void) | null; onerror: ((event: { error?: string }) => void) | null
}
type RecognitionConstructor = new () => RecognitionLike
function browserRecognition(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null
  const voice = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return voice.SpeechRecognition ?? voice.webkitSpeechRecognition ?? null
}

export function Composer({ onSubmit, busy, contextLabel, onClearContext, redirecting, onRedirectToggle, suggestion, onVoiceListeningChange }: {
  onSubmit: (instruction: string, channel: "text" | "voice") => Promise<void>
  busy: boolean
  contextLabel: string | null
  onClearContext?: () => void
  redirecting: boolean
  onRedirectToggle?: () => void
  suggestion?: { id: string; text: string } | null
  onVoiceListeningChange?: (listening: boolean) => void
}) {
  const [value, setValue] = useState("")
  const [channel, setChannel] = useState<"text" | "voice">("text")
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [voiceState, setVoiceState] = useState<"idle" | "starting" | "listening" | "stopping" | "final" | "error">("idle")
  const [partial, setPartial] = useState("")
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const recognition = useRef<RecognitionLike | null>(null)
  const voiceHadError = useRef(false)
  const voiceBase = useRef("")
  const voiceBaseChannel = useRef<"text" | "voice">("text")
  useEffect(() => { onVoiceListeningChange?.(voiceState === "starting" || voiceState === "listening") }, [onVoiceListeningChange, voiceState])
  useEffect(() => { setVoiceSupported(Boolean(browserRecognition())) }, [])
  useEffect(() => () => recognition.current?.abort?.(), [])
  useEffect(() => { if (suggestion) { setValue(suggestion.text); input.current?.focus() } }, [suggestion])

  function toggleVoice() {
    if (voiceState === "starting" || voiceState === "listening") {
      setVoiceState("stopping")
      recognition.current?.stop()
      return
    }
    if (voiceState === "stopping") return
    const Constructor = browserRecognition()
    if (!Constructor) { setVoiceState("error"); setVoiceError("Voice recognition is unavailable in this browser."); return }
    recognition.current?.abort?.()
    const next = new Constructor()
    const base = value.trim()
    voiceBase.current = value
    voiceBaseChannel.current = channel
    voiceHadError.current = false
    next.continuous = true
    next.interimResults = true
    next.lang = navigator.language || "en-US"
    next.onstart = () => { if (recognition.current !== next) return; setVoiceState("listening"); setVoiceError(null) }
    next.onresult = (event) => {
      if (recognition.current !== next) return
      const results = Array.from(event.results)
      const final = results.filter((result) => result.isFinal).map((result) => result[0]?.transcript?.trim() ?? "").filter(Boolean).join(" ")
      const interim = results.filter((result) => !result.isFinal).map((result) => result[0]?.transcript?.trim() ?? "").filter(Boolean).join(" ")
      setValue([base, final].filter(Boolean).join(" "))
      setPartial(interim)
      if (final) setChannel("voice")
    }
    next.onerror = (event) => { if (recognition.current !== next) return; voiceHadError.current = true; setVoiceState("error"); setVoiceError(event.error ? `Voice stopped: ${event.error.replaceAll("-", " ")}.` : "Voice recognition failed."); setPartial("") }
    next.onend = () => { if (recognition.current !== next) return; recognition.current = null; setPartial(""); if (!voiceHadError.current) setVoiceState((current) => current === "stopping" || current === "listening" || current === "starting" ? "final" : current) }
    recognition.current = next
    setVoiceError(null)
    setPartial("")
    setVoiceState("starting")
    try { next.start() } catch (cause) { recognition.current = null; setVoiceState("error"); setVoiceError(cause instanceof Error ? cause.message : "Microphone could not start.") }
  }

  function interruptVoice() {
    const current = recognition.current
    recognition.current = null
    voiceHadError.current = true
    try { if (current?.abort) current.abort(); else current?.stop() } catch { /* The captured draft remains restorable. */ }
    setValue(voiceBase.current)
    setChannel(voiceBaseChannel.current)
    setPartial("")
    setVoiceError(null)
    setVoiceState("idle")
    input.current?.focus()
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const instruction = value.trim()
    if (!instruction || busy || voiceState === "listening" || voiceState === "starting" || voiceState === "stopping") return
    setValue("")
    try { await onSubmit(instruction, channel); setChannel("text"); setVoiceState("idle"); setVoiceError(null) }
    catch { setValue(instruction) }
    input.current?.focus()
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && ["starting", "listening", "stopping"].includes(voiceState)) {
      event.preventDefault()
      interruptVoice()
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
  }

  return <form className="ct-composer" onSubmit={(event) => void submit(event)}>
    {contextLabel ? <div className="ct-composer__context"><span>Context: {contextLabel}</span>{onClearContext ? <button type="button" onClick={onClearContext} aria-label="Clear selected context">×</button> : null}</div> : null}
    {redirecting ? <p className="ct-composer__mode">Redirecting the current Objective through its durable control route.</p> : null}
    <label className="ct-visually-hidden" htmlFor="centropy-instruction">Message CENTROPY</label>
    <textarea ref={input} id="centropy-instruction" rows={3} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown}
      placeholder={redirecting ? "What should this Objective do instead?" : "Ask a question or state an objective…"} disabled={busy} />
    {partial ? <p className="ct-composer__partial" aria-live="polite">Hearing: {partial}</p> : null}
    {voiceState === "final" ? <p className="ct-composer__partial" role="status">Voice draft ready. Review it before sending to this Investigation.</p> : null}
    {voiceError ? <p className="ct-composer__voice-error" role="alert">{voiceError}</p> : null}
    <footer>
      <div className="ct-composer__tools">
        <span className="ct-composer__hint"><CornerDownLeft size={13} aria-hidden /> Enter to send · Shift+Enter for a new line</span>
        {onRedirectToggle ? <button type="button" onClick={onRedirectToggle} aria-pressed={redirecting} title="Redirect active Objective"><RotateCcw size={14} aria-hidden /> Redirect</button> : null}
        <button type="button" onClick={toggleVoice} disabled={busy || !voiceSupported} aria-pressed={voiceState === "starting" || voiceState === "listening"} title={voiceSupported ? voiceState === "listening" ? "Stop listening" : "Dictate into this Thread" : "Voice recognition is unavailable in this browser"} aria-label={voiceState === "listening" ? "Stop voice input" : "Start voice input"}><Mic size={15} aria-hidden /><span>{voiceState === "listening" ? "Listening" : voiceState === "starting" ? "Starting" : voiceState === "stopping" ? "Stopping" : channel === "voice" ? "Voice draft" : "Voice"}</span></button>
        {["starting", "listening", "stopping"].includes(voiceState) ? <button type="button" onClick={interruptVoice} aria-label="Cancel voice input and restore draft" title="Cancel voice input"><X size={14} aria-hidden /> Cancel</button> : null}
      </div>
      <button className="ct-composer__send" type="submit" disabled={busy || !value.trim() || voiceState === "starting" || voiceState === "listening" || voiceState === "stopping"} aria-label="Send instruction"><ArrowUp size={17} aria-hidden /></button>
    </footer>
  </form>
}
