import type { Metadata } from "next";

import FinnorMarketingPage from "@/components/marketing/FinnorMarketingPage";

export const metadata: Metadata = {
  title: "Pricing | Scoped FINNOR Deployment",
  description:
    "Scope a FINNOR deployment by PE sources, underwriting and IC coverage, Work, integrations, authority, workspace engineering, reliability, and support. Production starts around $30,000.",
  alternates: { canonical: "https://finnorai.com/pricing" },
  openGraph: {
    title: "Pricing | FINNOR",
    description: "Price the real PE operating boundary—sources, lineage, authority, execution, proof, and support. Production starts around $30,000.",
    url: "https://finnorai.com/pricing",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR scoped deployment pricing" }],
  },
};

export default function PricingRoute() {
  return <FinnorMarketingPage route="pricing" />;
}
