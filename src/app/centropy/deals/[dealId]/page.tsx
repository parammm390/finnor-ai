import type { Metadata } from "next"
import DealWorkspace from "@/components/centropy/product/DealWorkspace"

export const metadata: Metadata = {
  title: "Deal Workspace — FINNOR",
  description: "Source-backed investment, underwriting, diligence, IC, evidence, closing, Work, and Activity context.",
}

export default function DealOverviewPage() {
  return <DealWorkspace />
}
