import type { Metadata } from "next"
import { notFound } from "next/navigation"
import DealWorkspace from "@/components/centropy/product/DealWorkspace"
import { DEAL_SECTION_KEYS, type DealSectionKey } from "@/components/centropy/pe/context-routing"

export const metadata: Metadata = {
  title: "Deal Workspace — FINNOR",
  description: "A persistent source-backed Private Equity operating context.",
}

export default async function DealSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params
  if (!DEAL_SECTION_KEYS.includes(section as DealSectionKey)) notFound()
  return <DealWorkspace />
}
