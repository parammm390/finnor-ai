import { notFound } from "next/navigation"
import { TenantExperienceFixture } from "@/components/jarvis/experience/TenantExperienceFixture"
import northstar from "../../../../../../finnor-os/docs/reference-tenants/northstar-service.reference.json"
import summit from "../../../../../../finnor-os/docs/reference-tenants/summit-installations.reference.json"

const MANIFESTS = { northstar, summit } as const

export const dynamicParams = false
export function generateStaticParams() { return Object.keys(MANIFESTS).map((client) => ({ client })) }

export default function TenantExperienceFixturePage({ params }: { params: { client: string } }) {
  if (process.env.NEXT_PUBLIC_JARVIS_NEXT !== "1") notFound()
  const manifest = MANIFESTS[params.client as keyof typeof MANIFESTS]
  if (!manifest) notFound()
  return <TenantExperienceFixture client={params.client} configs={{ northstar: northstar.workspaceConfig, summit: summit.workspaceConfig }} />
}
