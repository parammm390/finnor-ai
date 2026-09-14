import type { Metadata } from "next"
import DealsSurface from "@/components/jarvis/pe/DealsSurface"

export const metadata: Metadata = {
  title: "Deals — FINNOR",
  description: "A source-backed master Deal book and deep Private Equity workspace.",
}

export default function DealsPage() {
  return <DealsSurface />
}
