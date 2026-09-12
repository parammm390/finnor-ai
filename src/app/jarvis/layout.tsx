import type { ReactNode } from "react"
import { JarvisProviders } from "./providers"

// Phase 8 mounts one authenticated Workspace V3 and one typed PE operating-context
// resolver across every active JARVIS surface. Product data remains server-owned.
export default function JarvisLayout({ children }: { children: ReactNode }) {
  return <JarvisProviders>{children}</JarvisProviders>
}
