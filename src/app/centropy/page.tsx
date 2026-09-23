import type { Metadata } from "next"
import PersonalizedHome from "@/components/centropy/PersonalizedHome"

export const metadata: Metadata = {
  title: "Home — Centropy",
  description: "Server-ranked decisions, evidence gaps, risks, closing blockers, Work, and verified outcomes.",
}

export default function CentropyPage() {
  return <PersonalizedHome />
}
