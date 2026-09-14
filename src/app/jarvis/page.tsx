import type { Metadata } from "next"
import PersonalizedHome from "@/components/jarvis/PersonalizedHome"

export const metadata: Metadata = {
  title: "Home — FINNOR",
  description: "Server-ranked decisions, evidence gaps, risks, closing blockers, Work, and verified outcomes.",
}

export default function JarvisPage() {
  return <PersonalizedHome />
}
