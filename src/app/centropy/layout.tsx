import type { ReactNode } from "react"
import { Suspense } from "react"
import { CentropyAuthProvider } from "@/components/centropy/lib/centropy-auth"
import { CentropyHost } from "@/components/centropy/shell/CentropyHost"

export default function CentropyLayout({ children }: { children: ReactNode }) {
  return <CentropyAuthProvider><Suspense fallback={<div style={{ minHeight: "100vh", background: "#03070c" }} />}><CentropyHost>{children}</CentropyHost></Suspense></CentropyAuthProvider>
}
