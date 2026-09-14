"use client"

import type { ReactNode } from "react"
import { Suspense } from "react"
import { JarvisAuthProvider } from "@/components/jarvis/lib/jarvis-auth"
import { WorkspaceConfigProvider } from "@/components/jarvis/WorkspaceConfigProvider"
import { PeOperatingContextProvider } from "@/components/jarvis/pe/PeOperatingContextProvider"
import { PeProductDataProvider } from "@/components/jarvis/product/ProductDataProvider"

export function JarvisProviders({ children }: { children: ReactNode }) {
  return (
    <JarvisAuthProvider>
      <WorkspaceConfigProvider>
        <Suspense fallback={<div className="min-h-screen bg-[#05080d]" aria-label="Loading JARVIS context" />}>
          <PeOperatingContextProvider>
            <PeProductDataProvider>{children}</PeProductDataProvider>
          </PeOperatingContextProvider>
        </Suspense>
      </WorkspaceConfigProvider>
    </JarvisAuthProvider>
  )
}
