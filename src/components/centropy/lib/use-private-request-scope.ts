"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { getCurrentAccessToken, useCentropyAuth } from "./centropy-auth"
import { advancePrivateReadGeneration } from "./private-read-generation"

/** Monotone browser cache identity. A→B→A gets a new generation; credentials
 * stay in memory and are never part of a rendered key or public projection. */
export function usePrivateRequestScope(resourceIdentity: string) {
  const instance = useId()
  const [, render] = useState(0)
  const auth = useCentropyAuth()
  const allowed = Boolean(auth.session && auth.role === "owner" && !auth.roleError && !auth.authError)
  const credential = auth.session?.access_token ?? null
  const principal = auth.session?.user.id ?? "signed-out"
  const state = useRef<null | { credential: string | null; principal: string; resourceIdentity: string;
    allowed: boolean; serial: number; key: string; mounted: boolean }>(null)
  if (!state.current || state.current.credential !== credential || state.current.principal !== principal
      || state.current.resourceIdentity !== resourceIdentity || state.current.allowed !== allowed) {
    advancePrivateReadGeneration()
    state.current = { credential, principal, resourceIdentity, allowed,
      serial: (state.current?.serial ?? -1) + 1, key: "", mounted: true }
  }
  const keyFor = () => `${instance}:${state.current!.principal}:${state.current!.serial}:${state.current!.resourceIdentity}:${state.current!.allowed ? "open" : "closed"}`
  state.current.key = keyFor()
  const isCurrent = useCallback((key: string) => Boolean(state.current?.mounted && state.current.key === key
    && state.current.allowed && getCurrentAccessToken() === state.current.credential), [])
  const invalidate = useCallback(() => {
    if (!state.current) return
    state.current.serial += 1
    state.current.key = `${instance}:${state.current.principal}:${state.current.serial}:${state.current.resourceIdentity}:${state.current.allowed ? "open" : "closed"}`
    advancePrivateReadGeneration()
    render(value => value + 1)
  }, [instance])
  useEffect(() => {
    state.current!.mounted = true
    return () => { state.current!.mounted = false; advancePrivateReadGeneration() }
  }, [])
  return { key: state.current.key, isCurrent, invalidate, allowed }
}
