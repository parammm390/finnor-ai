"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

/** Admit effects at first view, then retain the instance and its entered drafts. */
export function CanvasInstrument({ children, selected=false }: { children: ReactNode; selected?:boolean }) {
  const element = useRef<HTMLDivElement>(null)
  const [opened, setOpened] = useState(selected)

  useEffect(() => {
    if (opened) return
    if (selected) { setOpened(true); return }
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
  }, [opened,selected])

  return <div ref={element} style={{ minHeight: 240 }} aria-busy={!opened&&!selected}>
    {opened||selected ? children : <p role="status">Opening instrument…</p>}
  </div>
}
