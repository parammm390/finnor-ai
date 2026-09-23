"use client"

import { useRef, useState } from "react"
import { Mic, MicOff } from "lucide-react"

interface RecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}

interface RecognitionEventLike {
  results: ArrayLike<RecognitionResultLike>
}

interface RecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: RecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

type RecognitionConstructor = new () => RecognitionLike

export default function CentropyVoiceInput({ onTranscript, disabled = false }: { onTranscript: (value: string) => void; disabled?: boolean }) {
  const recognition = useRef<RecognitionLike | null>(null)
  const [listening, setListening] = useState(false)
  const supported = typeof window !== "undefined" && Boolean((window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }).SpeechRecognition
    ?? (window as typeof window & { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition)

  function toggle() {
    if (listening) {
      recognition.current?.stop()
      setListening(false)
      return
    }
    const BrowserRecognition = (window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }).SpeechRecognition
      ?? (window as typeof window & { webkitSpeechRecognition?: RecognitionConstructor }).webkitSpeechRecognition
    if (!BrowserRecognition) return
    const next = new BrowserRecognition()
    next.continuous = false
    next.interimResults = false
    next.lang = navigator.language || "en-US"
    next.onresult = (event) => {
      const values = Array.from(event.results).filter((result) => result.isFinal).map((result) => result[0]?.transcript ?? "").filter(Boolean)
      if (values.length) onTranscript(values.join(" "))
    }
    next.onend = () => setListening(false)
    next.onerror = () => setListening(false)
    recognition.current = next
    setListening(true)
    next.start()
  }

  return <button type="button" className="pw-voice-button" onClick={toggle} disabled={disabled || !supported} aria-pressed={listening} title={supported ? "Dictate command" : "Voice input is unavailable in this browser"}>{listening ? <MicOff size={15} /> : <Mic size={15} />}<span>{listening ? "Listening" : "Voice"}</span></button>
}
