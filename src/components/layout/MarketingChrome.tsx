"use client"

import type { ReactNode } from "react"
import dynamic from "next/dynamic"
import ScrollProgress from "@/components/ui/scroll-progress"
import SmoothScroll from "@/components/ui/smooth-scroll"
import CustomCursor from "@/components/ui/custom-cursor"
import ParticleNetwork from "@/components/ui/particle-network"
import GrainOverlay from "@/components/ui/grain-overlay"
import MarketingPageTransition from "@/components/ui/marketing-page-transition"

const CentropyAIConcierge = dynamic(
  () => import("@/components/ai-concierge/CentropyAIConcierge").then((module) => module.CentropyAIConcierge),
  { ssr: false },
)

export function MarketingChrome({ children }: { children: ReactNode }) {
  return (
    <SmoothScroll>
      <ParticleNetwork />
      <CustomCursor />
      <ScrollProgress />
      <GrainOverlay />
      <MarketingPageTransition>{children}</MarketingPageTransition>
      <CentropyAIConcierge />
    </SmoothScroll>
  )
}
