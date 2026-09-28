"use client"

import { useEffect, useRef, useState } from "react"
import { motion, useReducedMotion } from "framer-motion"

export interface CanvasSection {
  id: string
  title: string
  type: string
}

export function canvasSectionDomId(id: string): string {
  return `canvas-${id.replaceAll(":", "-")}`
}

// Adapts Rewamp UI's morphing tab navigation to real Canvas sections and the CENTROPY palette.
export function CanvasSectionNav({ sections }: { sections: CanvasSection[] }) {
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "")
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const reducedMotion = useReducedMotion()
  const sectionIds = sections.map((section) => section.id).join("|")

  useEffect(() => {
    const canvas = document.querySelector<HTMLElement>(".ct-canvas")
    if (!canvas || !sections.length) return
    let frame = 0
    const update = () => {
      frame = 0
      if (!canvas.clientHeight) return
      const nav = canvas.querySelector<HTMLElement>(".ct-canvas-nav")
      const edge = (nav?.getBoundingClientRect().bottom ?? canvas.getBoundingClientRect().top + 115) + Math.min(150, canvas.clientHeight * 0.25)
      let next = sections[0].id
      for (const section of sections) {
        const element = document.getElementById(canvasSectionDomId(section.id))
        if (element && element.getBoundingClientRect().top <= edge) next = section.id
      }
      setActiveId(next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    canvas.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    const resize = new ResizeObserver(schedule)
    resize.observe(canvas)
    return () => { canvas.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); resize.disconnect(); if (frame) cancelAnimationFrame(frame) }
    // Section identity controls the observer; title changes do not require a new listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionIds])

  useEffect(() => {
    const active = activeRef.current
    const track = active?.parentElement
    if (!active || !track) return
    const center = () => {
      if (!track.clientWidth) return
      const buttonRect = active.getBoundingClientRect()
      const trackRect = track.getBoundingClientRect()
      const delta = buttonRect.left + buttonRect.width / 2 - trackRect.left - trackRect.width / 2
      track.scrollBy({ left: delta, behavior: reducedMotion ? "auto" : "smooth" })
    }
    center()
    const resize = new ResizeObserver(center)
    resize.observe(track)
    return () => resize.disconnect()
  }, [activeId, reducedMotion])

  if (!sections.length) return null

  return <nav className="ct-canvas-nav" aria-label="Canvas instruments">
    <div className="ct-canvas-nav__track">
      {sections.map((section, index) => {
        const active = section.id === activeId
        return <button
          key={section.id}
          ref={active ? activeRef : null}
          type="button"
          aria-current={active ? "location" : undefined}
          onClick={() => {
            setActiveId(section.id)
            document.getElementById(canvasSectionDomId(section.id))?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" })
          }}
        >
          {active ? <motion.span className="ct-canvas-nav__active" layoutId="centropy-canvas-active-section" transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }} aria-hidden /> : null}
          <span className="ct-canvas-nav__number">{String(index + 1).padStart(2, "0")}</span>
          <span className="ct-canvas-nav__label">{section.title}</span>
        </button>
      })}
    </div>
  </nav>
}
