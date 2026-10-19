"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

/** Admit effects at first view, then retain the instance and its entered drafts. */
export function CanvasInstrument({ children }: { children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    if (opened) return
    if (typeof IntersectionObserver === "undefined") {
      setOpened(true)
      return
    }
    const target = element.current
    if (!target) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect()
        setOpened(true)
      }
    }, { rootMargin: "200px" })
    observer.observe(target)
    return () => observer.disconnect()
  }, [opened])

  return <div ref={element} style={{ minHeight: 240 }} aria-busy={!opened}>
    {opened ? children : <p role="status">Opening instrument…</p>}
  </div>
}
