import type { Metadata } from "next"
import AgentFleetSurface from "@/components/jarvis/agents/AgentFleetSurface"
import { BusinessWorldScene } from "@/components/jarvis/BusinessWorldScene"

export const metadata: Metadata = {
  title: "JARVIS — Agents",
  description: "Source-backed governed AI worker identities, assignments, and verified learning evidence.",
}

export default function AgentsPage() {
  return <><BusinessWorldScene scene="inventory" /><BusinessWorldScene scene="computer" /><AgentFleetSurface /></>
}
