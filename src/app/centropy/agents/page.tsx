import type { Metadata } from "next"
import AgentFleetSurface from "@/components/centropy/agents/AgentFleetSurface"

export const metadata: Metadata = {
  title: "Agents — FINNOR",
  description: "Business-shaped governed workers, assignments, human boundaries, evidence, quality, and learning.",
}

export default function AgentsPage() {
  return <AgentFleetSurface />
}
