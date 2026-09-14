import type { Metadata } from "next"
import WorkSurface from "@/components/jarvis/pe/WorkSurface"

export const metadata: Metadata = {
  title: "Work — FINNOR",
  description: "Business-facing Work with plans, execution, effects, receipts, proof, recovery, and outcomes.",
}

export default function JarvisWorkPage() {
  return <WorkSurface />
}
