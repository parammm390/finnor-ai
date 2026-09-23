"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"
import dynamic from "next/dynamic"

// Keep the marketing-only visual stack out of the operational CENTROPY route
// graph. The pathname guard below prevents it from rendering, but static imports
// would still make the browser download those client chunks on /centropy.
const MarketingChrome = dynamic(() => import("./MarketingChrome").then((module) => module.MarketingChrome), { ssr: false })

/** Marketing chrome owns the public site; CENTROPY owns its own atmosphere,
 * scroll containers, and action surfaces. */
export default function GlobalChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  if (pathname?.startsWith("/centropy")) return <>{children}</>

  return <MarketingChrome>{children}</MarketingChrome>
}
