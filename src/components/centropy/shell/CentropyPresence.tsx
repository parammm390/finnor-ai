"use client"

import { lazy, Suspense, useEffect, useRef, useState } from "react"
import type { OrbState } from "../product/vendor/LiquidGlassOrb"
import type { PresenceState } from "../runtime/presence-state"

const LiquidGlassOrb = lazy(() => import("@/components/centropy/product/vendor/LiquidGlassOrb").then((module) => ({ default: module.LiquidGlassOrb })))
const VISUAL_STATE: Record<PresenceState, OrbState> = {
  IDLE: "breathing", LISTENING: "listening", UNDERSTANDING: "searching", PLANNING: "solving",
  WORKING: "working", DELEGATING: "connecting", WAITING: "breathing", APPROVAL_REQUIRED: "shaping",
  VERIFYING: "searching", COMPLETED: "weaving", BLOCKED: "shaping", FAILED: "shaping",
}

export function CentropyPresence({ state, size, animated = true }: { state: PresenceState; size: number; animated?: boolean }) {
  const holder = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [allowed, setAllowed] = useState(false)
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const mobile = window.matchMedia("(max-width: 780px)")
    const update = () => setAllowed(!motion.matches && !mobile.matches)
    update()
    motion.addEventListener("change", update)
    mobile.addEventListener("change", update)
    return () => { motion.removeEventListener("change", update); mobile.removeEventListener("change", update) }
  }, [])
  useEffect(() => {
    const element = holder.current
    if (!element || !animated || !allowed) { setVisible(false); return }
    const observer = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.1 })
    observer.observe(element)
    return () => observer.disconnect()
  }, [animated, allowed])
  return <span ref={holder} className="ct-presence" data-state={state} style={{ width: size, height: size }} role="img" aria-label={`CENTROPY ${state.replaceAll("_", " ").toLowerCase()}`}>
    {animated && allowed && visible ? <Suspense fallback={<span className="ct-presence__fallback" aria-hidden />}><LiquidGlassOrb state={VISUAL_STATE[state]} size={size} intensity={state === "IDLE" || state === "COMPLETED" ? .72 : 1.1} /></Suspense> : <span className="ct-presence__fallback" aria-hidden />}
  </span>
}
