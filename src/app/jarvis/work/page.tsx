import type { Metadata } from "next"
import WorkSurface from "@/components/jarvis/pe/WorkSurface"

export const metadata: Metadata = {
  title: "JARVIS — Work",
  description: "Inspect root-linked Work, plans, execution, effects, receipts, proof, and recovery without leaving the Private Equity operating context.",
}

export default function JarvisWorkPage() {
  return <WorkSurface />
}
