"use client"

// Phase 1.3: real Supabase email+password sign-in. Session storage/refresh is fully
// library-managed (supabaseBrowser client, persistSession+autoRefreshToken) — this
// component only calls signInWithPassword and reacts to the result.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Lock } from "lucide-react"
import { getSupabaseBrowser } from "@/lib/jarvis/supabase-browser"
import "../jarvis-theme.css"

export function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Password managers—and very fast users on a cold JavaScript load—can fill
  // these native controls before React attaches its change handlers. Reconcile
  // the actual DOM values once hydrated so a visibly complete form never stays
  // disabled with stale component state.
  useEffect(() => {
    if (emailRef.current?.value) setEmail(emailRef.current.value)
    if (passwordRef.current?.value) setPassword(passwordRef.current.value)
  }, [])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const supabaseBrowser = await getSupabaseBrowser()
      const { error: signInError } = await supabaseBrowser.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) throw signInError
      router.push("/jarvis")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JARVIS sign-in is unavailable.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#04070f] px-4 text-[color:var(--j-text)]">
      <div className="w-full max-w-sm rounded-2xl border border-[color:var(--j-border)] bg-slate-950 p-6">
        <div className="mb-1 flex items-center gap-2 j-fs-base font-black">
          <Lock className="h-4 w-4 text-[color:var(--j-cyan)]" /> Sign in to JARVIS
        </div>
        <p className="mb-5 j-fs-sm text-[color:var(--j-text-dim)]">Real account, real data. The public page stays readable without signing in.</p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="jarvis-login-email" className="mb-1 block j-fs-micro font-bold uppercase tracking-widest text-[color:var(--j-text-faint)]">
              Email
            </label>
            <input
              id="jarvis-login-email"
              ref={emailRef}
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 w-full rounded-xl border border-white/12 bg-slate-900 px-3 j-fs-sm text-white focus:border-[color:var(--j-border-hot)] focus:outline-none"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label htmlFor="jarvis-login-password" className="mb-1 block j-fs-micro font-bold uppercase tracking-widest text-[color:var(--j-text-faint)]">
              Password
            </label>
            <input
              id="jarvis-login-password"
              ref={passwordRef}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 w-full rounded-xl border border-white/12 bg-slate-900 px-3 j-fs-sm text-white focus:border-[color:var(--j-border-hot)] focus:outline-none"
              placeholder="••••••••"
            />
          </div>
          {error && <div className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 j-fs-micro text-red-300">{error}</div>}
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="h-10 w-full rounded-xl bg-teal-300 j-fs-sm font-black text-slate-950 transition hover:bg-teal-200 disabled:opacity-40"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <Link href="/jarvis/reset-password" className="mt-3 block text-center j-fs-micro text-[color:var(--j-text-faint)] hover:text-white">
          Forgot your password?
        </Link>
        <Link href="/jarvis" className="mt-4 block text-center j-fs-micro text-[color:var(--j-text-faint)] hover:text-white">
          Back to JARVIS
        </Link>
      </div>
    </div>
  )
}
