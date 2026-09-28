import { redirect } from "next/navigation"
import { legacyWorldHref } from "@/components/centropy/shell/legacy-link"

export default async function LegacyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(legacyWorldHref(await searchParams))
}
