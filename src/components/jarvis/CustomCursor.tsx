"use client"

// High-contrast cursor for the JARVIS console. It shares the same electric-blue
// treatment as the public site so the pointer never changes identity between routes.
// Grows over interactive elements; native cursor stays hidden only while inside the page.

import { useEffect, useRef, useState } from "react"
import { motion, useMotionValue, useSpring } from "framer-motion"

export function CustomCursor() {
  const x = useMotionValue(-100)
  const y = useMotionValue(-100)
  const springX = useSpring(x, { stiffness: 900, damping: 60, mass: 0.4 })
  const springY = useSpring(y, { stiffness: 900, damping: 60, mass: 0.4 })
  const [hoveringClickable, setHoveringClickable] = useState(false)
  const [visible, setVisible] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const raf = useRef<number | undefined>(undefined)

  useEffect(() => {
    // Pointer-precision devices only — never hijack touch.
    const fine = window.matchMedia("(pointer: fine)")
    setEnabled(fine.matches)
    if (!fine.matches) return

    const move = (e: MouseEvent) => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => {
        x.set(e.clientX)
        y.set(e.clientY)
        setVisible(true)
        const el = document.elementFromPoint(e.clientX, e.clientY)
        setHoveringClickable(Boolean(el?.closest("button, a, input, textarea, [role=button], summary, select")))
      })
    }
    const leave = () => setVisible(false)
    window.addEventListener("mousemove", move, { passive: true })
    document.documentElement.addEventListener("mouseleave", leave)
    return () => {
      window.removeEventListener("mousemove", move)
      document.documentElement.removeEventListener("mouseleave", leave)
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [x, y])

  if (!enabled) return null

  return (
    <>
      <style>{`
        .jarvis-cursor-zone, .jarvis-cursor-zone * { cursor: none !important; }
      `}</style>
      {/* outer ring */}
      <motion.div
        aria-hidden
        data-finnor-cursor="ring"
        className="pointer-events-none fixed left-0 top-0 z-[9999] rounded-full border-2 border-[#2477ff] shadow-[0_0_0_1px_rgba(255,255,255,0.92),0_0_24px_rgba(36,119,255,0.58)]"
        style={{
          x: springX,
          y: springY,
          translateX: "-50%",
          translateY: "-50%",
          opacity: visible ? 1 : 0,
        }}
        animate={{ width: hoveringClickable ? 44 : 26, height: hoveringClickable ? 44 : 26 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      />
      {/* center dot — instant, no spring, so precision never suffers */}
      <motion.div
        aria-hidden
        data-finnor-cursor="dot"
        className="pointer-events-none fixed left-0 top-0 z-[9999] rounded-full bg-[#2477ff] ring-1 ring-white shadow-[0_0_18px_rgba(36,119,255,0.75)]"
        style={{
          x,
          y,
          translateX: "-50%",
          translateY: "-50%",
          opacity: visible ? 1 : 0,
        }}
        animate={{ width: hoveringClickable ? 5 : 7, height: hoveringClickable ? 5 : 7 }}
        transition={{ duration: 0.15 }}
      />
    </>
  )
}
