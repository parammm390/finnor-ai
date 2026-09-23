import type { Metadata } from "next";

import CentropyMarketingPage from "@/components/marketing/CentropyMarketingPage";

export const metadata: Metadata = {
  title: "Product | PE Decision + Execution Infrastructure",
  description:
    "Centropy joins canonical deal truth, underwriting lineage, IC governance, Work, evidence, receipts, and governed AI workers in CENTROPY.",
  alternates: { canonical: "https://finnorai.com/product" },
  openGraph: {
    title: "Product | Centropy",
    description: "The source-backed Private Equity decision and execution layer behind CENTROPY.",
    url: "https://finnorai.com/product",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "Centropy Private Equity decision and execution product" }],
  },
};

export default function ProductRoute() {
  return <CentropyMarketingPage route="product" />;
}
