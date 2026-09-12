import type { Metadata } from "next";

import FinnorHome from "@/components/rebuild/FinnorHome";

export const metadata: Metadata = {
  title: {
    absolute: "FINNOR | Private Equity Decision + Execution Infrastructure",
  },
  description:
    "FINNOR connects canonical deal truth, underwriting lineage, IC governance, Work, governed execution, evidence, receipts, and governed AI workers. JARVIS is the owner operating surface.",
  alternates: {
    canonical: "https://finnorai.com/",
  },
  openGraph: {
    title: "Private Equity Decision + Execution Infrastructure | FINNOR",
    description:
      "Inspect the object, its evidence, the decision lineage, and the Work it creates.",
    url: "https://finnorai.com/",
    images: [
      {
        url: "https://finnorai.com/og-image.svg",
        width: 1200,
        height: 630,
        alt: "FINNOR Private Equity decision and execution infrastructure",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Private Equity Decision + Execution Infrastructure | FINNOR",
    description:
      "Canonical deal truth, underwriting lineage, IC governance, governed execution, evidence, receipts, and governed AI workers.",
    images: ["https://finnorai.com/og-image.svg"],
  },
};

export default function Home() {
  return <FinnorHome />;
}
