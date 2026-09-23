import type { ReactNode } from "react"
import { CentropyProviders } from "./providers"
import OperatingCanvas from "@/components/centropy/OperatingCanvas"

// Phase 8 mounts one authenticated Workspace V3 and one typed PE operating-context
// resolver across every active CENTROPY surface. Product data remains server-owned.
export default function CentropyLayout({ children }: { children: ReactNode }) {
  return <CentropyProviders><OperatingCanvas>{children}</OperatingCanvas></CentropyProviders>
}
