"use client"

// Phase 7 (§7.9, frontend engineering bar): every major authenticated view needs an
// error boundary. This is the CENTROPY route's — a real, uncaught render error anywhere
// under /centropy lands here instead of a blank white screen, with a real reload path.

import { useEffect } from "react"

export default function CentropyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[centropy]", error)
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#050b16] px-6 text-center">
      <div className="max-w-md">
        <div className="mb-3 text-sm font-black uppercase tracking-widest text-amber-300">Something broke</div>
        <h1 className="mb-3 text-xl font-black text-white">CENTROPY hit a snag rendering this page.</h1>
        <p className="mb-6 text-sm text-white/60">
          Nothing on the backend was affected — this is a display error. Try again, and if it keeps happening, refresh the page.
        </p>
        <button
          onClick={reset}
          className="rounded-full bg-cyan-300 px-5 py-2 text-sm font-black text-slate-950 shadow-[0_0_18px_rgba(34,211,238,0.4)] transition hover:-translate-y-0.5"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
