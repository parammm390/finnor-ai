"use client"

import { useRef, type ReactNode } from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger, useGSAP)

export function PeSurfaceMotion({ children }: { children: ReactNode }) {
  const scope = useRef<HTMLDivElement>(null)
  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from("[data-pe-hero-enter]", { autoAlpha: 0, y: 22, duration: 0.72, stagger: 0.07, ease: "power3.out" })
      gsap.utils.toArray<HTMLElement>(".pe-scale-reveal", scope.current).forEach((element) => {
        gsap.fromTo(element, { autoAlpha: 0.42, scale: 0.965 }, { autoAlpha: 1, scale: 1, ease: "none", scrollTrigger: { trigger: element, start: "top 92%", end: "top 60%", scrub: 0.65 } })
      })
    })
    media.add("(min-width: 1180px) and (prefers-reduced-motion: no-preference)", () => {
      const zone = scope.current?.querySelector<HTMLElement>("[data-pe-pin-zone]")
      const inspector = zone?.querySelector<HTMLElement>("[data-pe-pin-inspector]")
      if (zone && inspector) ScrollTrigger.create({ trigger: zone, pin: inspector, start: "top 92px", end: "bottom bottom-=32", pinSpacing: false })
    })
    return () => media.revert()
  }, { scope })
  return <div ref={scope}>{children}</div>
}
