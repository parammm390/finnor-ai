"use client"

import type { ReactNode } from "react"
import { Suspense } from "react"
import { CentropyAuthProvider } from "@/components/centropy/lib/centropy-auth"
import { WorkspaceConfigProvider } from "@/components/centropy/WorkspaceConfigProvider"
import { PeOperatingContextProvider } from "@/components/centropy/pe/PeOperatingContextProvider"
import { PeProductDataProvider } from "@/components/centropy/product/ProductDataProvider"

export function CentropyProviders({ children }: { children: ReactNode }) {
  return (
    <CentropyAuthProvider>
      <WorkspaceConfigProvider>
        <Suspense fallback={<div className="min-h-screen bg-[#05080d]" aria-label="Loading CENTROPY context" />}>
          <PeOperatingContextProvider>
            <PeProductDataProvider>{children}</PeProductDataProvider>
          </PeOperatingContextProvider>
        </Suspense>
      </WorkspaceConfigProvider>
    </CentropyAuthProvider>
  )
}
