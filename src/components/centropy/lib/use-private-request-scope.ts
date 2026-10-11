"use client"

import { useCallback, useRef } from "react"
import { useCentropyAuth } from "./centropy-auth"

/** Monotone browser cache identity. A→B→A gets a new generation; credentials
 * stay in memory and are never part of a rendered key or public projection. */
export function usePrivateRequestScope(resourceIdentity: string) {
  const auth = useCentropyAuth()
  const allowed = Boolean(auth.session && auth.role === "owner" && !auth.roleError && !auth.authError)
  const credential = auth.session?.access_token ?? null
  const principal = auth.session?.user.id ?? "signed-out"
  const state = useRef({ credential, principal, resourceIdentity, allowed, serial: 0, key: "" })
  if (state.current.credential !== credential || state.current.principal !== principal
      || state.current.resourceIdentity !== resourceIdentity || state.current.allowed !== allowed) {
    state.current = { credential, principal, resourceIdentity, allowed, serial: state.current.serial + 1, key: "" }
  }
  state.current.key = `${principal}:${state.current.serial}:${resourceIdentity}:${allowed ? "open" : "closed"}`
  const isCurrent = useCallback((key: string) => state.current.key === key && state.current.allowed, [])
  return { key: state.current.key, isCurrent, allowed }
}
