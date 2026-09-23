import type { Metadata } from "next";

import CentropyHome from "@/components/rebuild/CentropyHome";

export const metadata: Metadata = {
  title: {
    absolute: "Centropy | Private Equity Decision + Execution Infrastructure",
  },
  description:
    "Centropy connects canonical deal truth, underwriting lineage, IC governance, Work, governed execution, evidence, receipts, and governed AI workers. CENTROPY is the owner operating surface.",
  alternates: {
    canonical: "https://finnorai.com/",
  },
  openGraph: {
    title: "Private Equity Decision + Execution Infrastructure | Centropy",
    description:
      "Inspect the object, its evidence, the decision lineage, and the Work it creates.",
    url: "https://finnorai.com/",
    images: [
      {
        url: "https://finnorai.com/og-image.svg",
        width: 1200,
        height: 630,
        alt: "Centropy Private Equity decision and execution infrastructure",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Private Equity Decision + Execution Infrastructure | Centropy",
    description:
      "Canonical deal truth, underwriting lineage, IC governance, governed execution, evidence, receipts, and governed AI workers.",
    images: ["https://finnorai.com/og-image.svg"],
  },
};

export default function Home() {
  return <CentropyHome />;
}
