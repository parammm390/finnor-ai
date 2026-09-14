"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ProductResource } from "./contracts"
import { unavailableState, type ProductTruthState } from "./source-health"

export function useProductRequest<T>(options: {
  enabled: boolean
  key: string
  load: () => Promise<T>
  stateFor?: (data: T) => ProductTruthState
  confirmedAt?: (data: T) => string | null
}): ProductResource<T> {
  const { enabled, key, load, stateFor, confirmedAt } = options
  const retained = useRef<{ key: string; data: T } | null>(null)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<T | null>(null)
  const [status, setStatus] = useState<ProductResource<T>["status"]>("idle")
  const [error, setError] = useState<string | null>(null)
  const [errorValue, setErrorValue] = useState<unknown>(null)
  const [truthState, setTruthState] = useState<ProductTruthState>("UNKNOWN")
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
  const loadRef = useRef(load)
  const stateForRef = useRef(stateFor)
  const confirmedAtRef = useRef(confirmedAt)
  loadRef.current = load
  stateForRef.current = stateFor
  confirmedAtRef.current = confirmedAt
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    if (!enabled) {
      setData(null); setStatus("idle"); setError(null); setErrorValue(null); setTruthState("UNKNOWN"); setLastConfirmedAt(null)
      return
    }
    const cached = retained.current?.key === key ? retained.current.data : null
    if (!cached) setData(null)
    let active = true
    setStatus("loading"); setError(null); setErrorValue(null)
    void loadRef.current().then((value) => {
      if (!active) return
      retained.current = { key, data: value }
      setData(value); setStatus("ready"); setTruthState(stateForRef.current?.(value) ?? "KNOWN"); setLastConfirmedAt(confirmedAtRef.current?.(value) ?? new Date().toISOString())
    }).catch((cause) => {
      if (!active) return
      const fallback = retained.current?.key === key ? retained.current.data : null
      setData(fallback); setStatus("error"); setError(cause instanceof Error ? cause.message : "Canonical source request failed."); setErrorValue(cause); setTruthState(unavailableState(cause, Boolean(fallback)))
    })
    return () => { active = false }
  }, [enabled, key, revision])

  return useMemo(() => ({ data, status, error, errorValue, truthState, lastConfirmedAt, reload }), [data, error, errorValue, lastConfirmedAt, reload, status, truthState])
}
