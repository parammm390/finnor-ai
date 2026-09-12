"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Lock, Mail } from "lucide-react"
import { getSupabaseBrowser } from "@/lib/jarvis/supabase-browser"
import "../jarvis-theme.css"

export function ResetPasswordForm() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [recoverySession, setRecoverySession] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getSupabaseBrowser()
      .then((supabaseBrowser) => supabaseBrowser.auth.getSession())
      .then(({ data, error: sessionError }) => {
        if (sessionError) throw sessionError
        if (active) setRecoverySession(Boolean(data.session))
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Password recovery is unavailable.")
      })
    return () => { active = false }
  }, [])

  async function requestReset(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const supabaseBrowser = await getSupabaseBrowser()
      const { error: resetError } = await supabaseBrowser.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/jarvis/reset-password`,
      })
      if (resetError) throw resetError
      setMessage("If that address has a JARVIS account, a password-reset link is on its way.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password recovery is unavailable.")
    } finally {
      setBusy(false)
    }
  }

  async function setNewPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const supabaseBrowser = await getSupabaseBrowser()
      const { error: updateError } = await supabaseBrowser.auth.updateUser({ password })
      if (updateError) throw updateError
      router.push("/jarvis")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password recovery is unavailable.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#04070f] px-4 text-[color:var(--j-text)]">
      <div className="w-full max-w-sm rounded-2xl border border-[color:var(--j-border)] bg-slate-950 p-6">
        <div className="mb-1 flex items-center gap-2 j-fs-base font-black">
          {recoverySession ? <Lock className="h-4 w-4 text-[color:var(--j-cyan)]" /> : <Mail className="h-4 w-4 text-[color:var(--j-cyan)]" />}
          {recoverySession ? "Choose a new password" : "Reset your password"}
        </div>
        <p className="mb-5 j-fs-sm text-[color:var(--j-text-dim)]">
          {recoverySession ? "Set a new password for your JARVIS account." : "We will send a reset link to the email address on your JARVIS account."}
        </p>
        {recoverySession ? (
          <form onSubmit={setNewPassword} className="space-y-3">
            <div>
              <label htmlFor="jarvis-reset-password" className="mb-1 block j-fs-micro font-bold uppercase tracking-widest text-[color:var(--j-text-faint)]">New password</label>
              <input id="jarvis-reset-password" type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 w-full rounded-xl border border-white/12 bg-slate-900 px-3 j-fs-sm text-white focus:border-[color:var(--j-border-hot)] focus:outline-none" placeholder="At least 12 characters" />
            </div>
            <button type="submit" disabled={busy || password.length < 12} className="h-10 w-full rounded-xl bg-teal-300 j-fs-sm font-black text-slate-950 transition hover:bg-teal-200 disabled:opacity-40">{busy ? "Saving…" : "Save password"}</button>
          </form>
        ) : (
          <form onSubmit={requestReset} className="space-y-3">
            <div>
              <label htmlFor="jarvis-reset-email" className="mb-1 block j-fs-micro font-bold uppercase tracking-widest text-[color:var(--j-text-faint)]">Email</label>
              <input id="jarvis-reset-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-10 w-full rounded-xl border border-white/12 bg-slate-900 px-3 j-fs-sm text-white focus:border-[color:var(--j-border-hot)] focus:outline-none" placeholder="you@example.com" />
            </div>
            <button type="submit" disabled={busy || !email.trim()} className="h-10 w-full rounded-xl bg-teal-300 j-fs-sm font-black text-slate-950 transition hover:bg-teal-200 disabled:opacity-40">{busy ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
        {message && <div className="mt-3 rounded-lg border border-teal-300/30 bg-teal-300/5 px-3 py-2 j-fs-micro text-teal-100">{message}</div>}
        {error && <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 j-fs-micro text-red-300">{error}</div>}
        <Link href="/jarvis/login" className="mt-4 block text-center j-fs-micro text-[color:var(--j-text-faint)] hover:text-white">Back to sign in</Link>
      </div>
    </div>
  )
}
