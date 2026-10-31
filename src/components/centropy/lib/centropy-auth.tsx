"use client"

// Phase 1.3/1.4: real Supabase session state for the CENTROPY frontend. Logged-out
// visitors see only the closed signed-out boundary; a real session unlocks live data
// by having api.ts forward its access token to the proxy,
// which forwards it to the finnor-os backend's own requireContext/RBAC — no new
// authorization logic lives here or in the proxy, only session plumbing.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import { getSupabaseBrowser } from "@/lib/centropy/supabase-browser"
import { centropyGet } from "./api"

// The institutional shell remains owner-only. Existing non-owner canonical
// roles may open the separate, recipient-scoped workforce workspace; this union
// grants no backend capability and never falls back to the owner presentation.
export type CentropyRole = "owner" | "dispatcher" | "technician"

// Mirrors the old getCentropyKey() shape: a synchronous getter usable outside React
// (api.ts isn't a component) that always reflects the latest session from the one
// Supabase client instance's in-memory state.
let currentSession: Session | null = null
let rejectedCredential: string | null = null
let accessGeneration = 0
const rejectionListeners = new Set<(reason: string) => void>()
function adoptSession(next: Session | null): void {
  if (next?.access_token !== currentSession?.access_token || next?.user.id !== currentSession?.user.id) {
    accessGeneration++
    rejectedCredential = null
  }
  currentSession = next
}
export const getCurrentAccessGeneration = () => accessGeneration
export function rejectCurrentWorkspaceAccess(credential: string, expectedGeneration: number): void {
  if (currentSession?.access_token !== credential || accessGeneration !== expectedGeneration
    || rejectedCredential === credential) return
  rejectedCredential = credential
  accessGeneration++
  rejectionListeners.forEach(listener => listener("Your workspace access is no longer available. Retry verification or sign in again."))
}
export function getCurrentAccessToken(): string | null {
  return currentSession?.access_token && currentSession.access_token !== rejectedCredential ? currentSession.access_token : null
}
export function hasActiveSession(): boolean {
  return getCurrentAccessToken() !== null
}
export function getCurrentSessionKey(): string | null {
  return currentSession && getCurrentAccessToken() ? `${currentSession.user.id}:${accessGeneration}:${currentSession.access_token}` : null
}

export const CENTROPY_AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = globalThis.setTimeout(
          () => reject(new Error(`Authentication timed out after ${CENTROPY_AUTH_BOOTSTRAP_TIMEOUT_MS / 1000} seconds.`)),
          CENTROPY_AUTH_BOOTSTRAP_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
  }
}

function isCentropyRole(value: unknown): value is CentropyRole {
  return value === "owner" || value === "dispatcher" || value === "technician"
}

interface CentropyAuthState {
  session: Session | null
  loading: boolean
  authError: string | null
  retryAuth: () => void
  role: CentropyRole | null
  roleLoading: boolean
  roleError: string | null
  retryRole: () => void
  signOut: () => Promise<void>
}
const CentropyAuthContext = createContext<CentropyAuthState>({ session: null, loading: true, authError: null, retryAuth: () => {}, role: null, roleLoading: false, roleError: null, retryRole: () => {}, signOut: async () => {} })

export function CentropyAuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  // The authenticated product stays closed until Supabase resolves. Every private
  // API remains backend-gated and no sample business facts are rendered.
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authRetry, setAuthRetry] = useState(0)
  const [role, setRole] = useState<CentropyRole | null>(null)
  const [roleLoading, setRoleLoading] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)
  const [roleRetry, setRoleRetry] = useState(0)
  const resolvedRoleUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    const rejected = (reason: string) => {
      resolvedRoleUserIdRef.current = null
      setRole(null)
      setRoleLoading(false)
      setRoleError(reason)
    }
    rejectionListeners.add(rejected)
    return () => { rejectionListeners.delete(rejected) }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | null = null
    setLoading(true)
    setAuthError(null)
    void (async () => {
      try {
        const supabaseBrowser = await withTimeout(getSupabaseBrowser())
        if (!active) return
        const { data, error } = await withTimeout(supabaseBrowser.auth.getSession())
        if (error) throw error
        if (!active) return
        adoptSession(data.session)
        setSession(data.session)
        const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, next) => {
          if (!active) return
          adoptSession(next)
          setSession((previous) => previous?.user.id === next?.user.id && previous?.access_token === next?.access_token ? previous : next)
          setAuthError(null)
        })
        unsubscribe = () => sub.subscription.unsubscribe()
      } catch (error) {
        if (!active) return
        adoptSession(null)
        setSession(null)
        setAuthError(error instanceof Error ? error.message : "Authentication could not be restored.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [authRetry])

  useEffect(() => {
    if (!session) {
      resolvedRoleUserIdRef.current = null
      setRole(null)
      setRoleLoading(false)
      setRoleError(null)
      return
    }
    let cancelled = false
    // Supabase emits TOKEN_REFRESHED with a new Session/access-token object.
    // Clearing an already-resolved role here unmounted the entire instruction
    // kernel mid-request, making long research/action turns disappear. Retain the
    // role only for the same authenticated user while `/api/me` revalidates it.
    const sameResolvedUser = resolvedRoleUserIdRef.current === session.user.id
    if (!sameResolvedUser) setRole(null)
    setRoleLoading(true)
    setRoleError(null)
    centropyGet<{ role: CentropyRole }>("me")
      .then((r) => {
        if (!cancelled) {
          if (!isCentropyRole(r.role)) {
            setRoleError("CENTROPY returned an unknown workspace role. Retry connection or contact an administrator.")
            return
          }
          resolvedRoleUserIdRef.current = session.user.id
          setRole(r.role)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          if (!sameResolvedUser) setRole(null)
          setRoleError(error instanceof Error ? error.message : "CENTROPY could not load your role.")
        }
      })
      .finally(() => {
        if (!cancelled) setRoleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [session, roleRetry])

  const retryRole = useCallback(() => {
    // A retry may revalidate restored rights, but cannot show old private data
    // while that check is pending or reuse responses from the prior generation.
    rejectedCredential = null
    accessGeneration++
    resolvedRoleUserIdRef.current = null
    setRole(null)
    setRoleLoading(true)
    setRoleRetry(value => value + 1)
  }, [])
  const retryAuth = useCallback(() => {
    setLoading(true)
    setAuthRetry((value) => value + 1)
  }, [])

  async function signOut(): Promise<void> {
    const token = currentSession?.access_token
    // Close the local scope synchronously. A late response cannot resurrect
    // private state while provider logout or the delivery tombstone is pending.
    currentSession = null
    setSession(null); setRole(null); resolvedRoleUserIdRef.current = null
    if (token) await fetch("/api/centropy/live-controls", {
      method: "POST", cache: "no-store", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "end-delivery", input: {} }), signal: AbortSignal.timeout(3000),
    }).catch(() => undefined)
    const supabaseBrowser = await getSupabaseBrowser()
    await supabaseBrowser.auth.signOut()
  }

  return <CentropyAuthContext.Provider value={{ session, loading, authError, retryAuth, role, roleLoading, roleError, retryRole, signOut }}>{children}</CentropyAuthContext.Provider>
}

export function useCentropyAuth(): CentropyAuthState {
  return useContext(CentropyAuthContext)
}
