import type { Metadata } from "next";

import FinnorMarketingPage from "@/components/marketing/FinnorMarketingPage";

export const metadata: Metadata = {
  title: "Product | PE Decision + Execution Infrastructure",
  description:
    "FINNOR joins canonical deal truth, underwriting lineage, IC governance, Work, evidence, receipts, and governed AI workers in JARVIS.",
  alternates: { canonical: "https://finnorai.com/product" },
  openGraph: {
    title: "Product | FINNOR",
    description: "The source-backed Private Equity decision and execution layer behind JARVIS.",
    url: "https://finnorai.com/product",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR Private Equity decision and execution product" }],
  },
};

export default function ProductRoute() {
  return <FinnorMarketingPage route="product" />;
}
