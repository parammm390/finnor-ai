import { redirect, notFound } from "next/navigation"
import { legacyWorldHref } from "@/components/centropy/shell/legacy-link"
import { DEAL_SECTION_KEYS, type DealSectionKey } from "@/components/centropy/pe/context-routing"

export default async function LegacySectionPage({ params, searchParams }: { params: Promise<{ dealId: string; section: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { dealId, section } = await params
  if (!/^[0-9a-f-]{36}$/i.test(dealId) || !DEAL_SECTION_KEYS.includes(section as DealSectionKey)) notFound()
  redirect(legacyWorldHref(await searchParams, dealId))
}
