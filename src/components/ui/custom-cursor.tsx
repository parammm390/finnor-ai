"use client"

import { useEffect, useRef, useState } from "react"

type CursorVariant = "default" | "hover" | "text" | "pressed"

export default function CustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = useState(false)
  const [variant, setVariant] = useState<CursorVariant>("default")

  useEffect(() => {
    // CENTROPY supplies its own high-contrast cursor.  Keeping this site-wide
    // cursor out of that route prevents two cursors (including the dark one)
    // from competing for visibility in the command center.
    if (window.location.pathname.startsWith("/centropy")) {
      document.documentElement.removeAttribute("data-custom-cursor")
      return
    }

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const canEnable = finePointer.matches && !reducedMotion.matches

    setEnabled(canEnable)
    document.documentElement.toggleAttribute("data-custom-cursor", canEnable)

    if (!canEnable) {
      document.documentElement.removeAttribute("data-custom-cursor")
      return
    }

    let mouseX = -120
    let mouseY = -120
    let ringX = -120
    let ringY = -120
    let rafId = 0
    let dotRaf = 0

    const moveDot = () => {
      dotRaf = 0
      if (!dotRef.current) return
      dotRef.current.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0) translate(-50%, -50%)`
    }

    const animateRing = () => {
      ringX += (mouseX - ringX) * 0.32
      ringY += (mouseY - ringY) * 0.32
      if (ringRef.current) {
        ringRef.current.style.transform = `translate3d(${ringX}px, ${ringY}px, 0) translate(-50%, -50%)`
      }
      rafId = requestAnimationFrame(animateRing)
    }

    const updateVariant = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null
      if (!element) {
        setVariant("default")
        return
      }
      if (element.closest("input, textarea, [contenteditable='true'], [data-cursor='text']")) {
        setVariant("text")
      } else if (element.closest("a, button, [role='button'], [data-cursor='hover']")) {
        setVariant("hover")
      } else {
        setVariant("default")
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      mouseX = event.clientX
      mouseY = event.clientY
      updateVariant(event.target)
      if (!dotRaf) dotRaf = requestAnimationFrame(moveDot)
    }

    const handlePointerDown = () => setVariant("pressed")
    const handlePointerUp = (event: PointerEvent) => updateVariant(event.target)
    const handlePointerOut = () => setVariant("default")

    window.addEventListener("pointermove", handlePointerMove, { passive: true })
    window.addEventListener("pointerdown", handlePointerDown, { passive: true })
    window.addEventListener("pointerup", handlePointerUp, { passive: true })
    document.addEventListener("pointerleave", handlePointerOut)
    rafId = requestAnimationFrame(animateRing)

    return () => {
      cancelAnimationFrame(rafId)
      cancelAnimationFrame(dotRaf)
      document.documentElement.removeAttribute("data-custom-cursor")
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("pointerup", handlePointerUp)
      document.removeEventListener("pointerleave", handlePointerOut)
    }
  }, [])

  if (!enabled) return null

  return (
    <>
      <div
        ref={dotRef}
        data-finnor-cursor="dot"
        className="pointer-events-none fixed left-0 top-0 z-[9999] h-[6px] w-[6px] rounded-full bg-[#2477ff] ring-1 ring-white shadow-[0_0_18px_rgba(36,119,255,0.72)]"
        style={{ transform: "translate3d(-120px, -120px, 0)" }}
        aria-hidden
      />
      <div
        ref={ringRef}
        data-finnor-cursor="ring"
        className={`pointer-events-none fixed left-0 top-0 z-[9998] rounded-full border-[1.5px] border-[#2477ff] shadow-[0_0_0_1px_rgba(255,255,255,0.92),0_0_24px_rgba(36,119,255,0.42)] transition-[width,height,border-radius,background-color,opacity] duration-200 ease-out ${
          variant === "hover"
            ? "h-12 w-12 bg-[#2477ff]/15 opacity-100"
            : variant === "text"
              ? "h-8 w-[3px] rounded-none bg-[#2477ff] opacity-100"
              : variant === "pressed"
                ? "h-7 w-7 bg-[#2477ff]/25 opacity-100"
                : "h-9 w-9 bg-[#2477ff]/[0.04] opacity-100"
        }`}
        style={{ transform: "translate3d(-120px, -120px, 0)" }}
        aria-hidden
      />
    </>
  )
}
