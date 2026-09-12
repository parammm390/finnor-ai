import type { Metadata } from "next";

import FinnorMarketingPage from "@/components/marketing/FinnorMarketingPage";

export const metadata: Metadata = {
  title: "Capabilities",
  description:
    "See how FINNOR connects deal truth, underwriting lineage, IC governance, Work and planning, governed execution, evidence, receipts, and governed AI workers.",
  alternates: { canonical: "https://finnorai.com/capabilities" },
  openGraph: {
    title: "Capabilities | FINNOR",
    description: "Source-backed PE objects, exact lineage, authority boundaries, execution, recovery, proof, and bounded agents.",
    url: "https://finnorai.com/capabilities",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR Private Equity capabilities" }],
  },
};

export default function CapabilitiesRoute() {
  return <FinnorMarketingPage route="capabilities" />;
}
