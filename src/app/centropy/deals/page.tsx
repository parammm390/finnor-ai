import type { Metadata } from "next"
import DealsSurface from "@/components/centropy/pe/DealsSurface"

export const metadata: Metadata = {
  title: "Deals — Centropy",
  description: "A source-backed master Deal book and deep Private Equity workspace.",
}

export default function DealsPage() {
  return <DealsSurface />
}
