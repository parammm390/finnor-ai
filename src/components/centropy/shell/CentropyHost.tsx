"use client"

import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { CentropyWorkspace } from "./CentropyWorkspace"

export function CentropyHost({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (pathname === "/centropy/login" || pathname === "/centropy/reset-password") return children
  // Consume the server page so compatibility redirects and notFound execute.
  // CENTROPY pages contain route logic only; the workspace owns presentation.
  return <>{children}<CentropyWorkspace /></>
}
