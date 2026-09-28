import { redirect, notFound } from "next/navigation"
import { legacyWorldHref } from "@/components/centropy/shell/legacy-link"

export default async function LegacyDealPage({ params, searchParams }: { params: Promise<{ dealId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { dealId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(dealId)) notFound()
  redirect(legacyWorldHref(await searchParams, dealId))
}
