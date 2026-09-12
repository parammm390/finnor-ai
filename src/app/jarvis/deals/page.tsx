import type { Metadata } from "next"
import DealsSurface from "@/components/jarvis/pe/DealsSurface"

export const metadata: Metadata = {
  title: "JARVIS — Deals and Company Brain",
  description: "Inspect source-backed Private Equity objects, evidence, underwriting, IC governance, Work, and Activity in one Company Brain projection.",
}

export default function DealsPage() {
  return <DealsSurface />
}
