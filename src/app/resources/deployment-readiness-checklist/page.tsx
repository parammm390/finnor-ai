import type { Metadata } from "next";
import { PrivateEquityResource } from "@/components/resources/PrivateEquityResource";

export const metadata: Metadata = {
  title: "FINNOR Deployment Readiness Checklist",
  description: "Map and certify FINNOR across canonical PE truth, tenant isolation, decision lineage, Work, Authority, runtime truth, recovery, evidence, and activation.",
  alternates: { canonical: "https://finnorai.com/resources/deployment-readiness-checklist" },
  openGraph: {
    title: "FINNOR Deployment Readiness Checklist",
    description: "The decisions required to configure, test and activate a company-specific FINNOR operating system.",
    url: "https://finnorai.com/resources/deployment-readiness-checklist",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR deployment readiness checklist" }],
  },
};

export default function DeploymentReadinessChecklistPage() {
  return <PrivateEquityResource kind="readiness" />;
}
