import type { Metadata } from "next";
import { PrivateEquityResource } from "@/components/resources/PrivateEquityResource";

export const metadata: Metadata = {
  title: "Centropy Field Notes",
  description:
    "Practical guidance for evaluating and deploying Centropy Private Equity decision and execution infrastructure.",
  alternates: {
    canonical: "https://finnorai.com/resources",
  },
  openGraph: {
    title: "Centropy Field Notes",
    description:
      "Understand the company deployment, operating scope and control model behind Centropy and CENTROPY.",
    url: "https://finnorai.com/resources",
    images: [
      {
        url: "https://finnorai.com/og-image.svg",
        width: 1200,
        height: 630,
        alt: "Centropy Private Equity decision and execution field notes",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Centropy Field Notes",
    description:
      "PE truth, decision lineage, authority, recovery, evidence, receipts, and production activation.",
    images: ["https://finnorai.com/og-image.svg"],
  },
};

export default function ResourcesPage() {
  return <PrivateEquityResource kind="hub" />;
}
