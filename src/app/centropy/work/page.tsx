import type { Metadata } from "next"
import WorkSurface from "@/components/centropy/pe/WorkSurface"

export const metadata: Metadata = {
  title: "Work — Centropy",
  description: "Business-facing Work with plans, execution, effects, receipts, proof, recovery, and outcomes.",
}

export default function CentropyWorkPage() {
  return <WorkSurface />
}
