import type { Metadata } from "next";

import FinnorMarketingPage from "@/components/marketing/FinnorMarketingPage";

export const metadata: Metadata = {
  title: "How It Works | From PE Truth to Verified Execution",
  description:
    "See how FINNOR maps PE truth and sources, binds authority, configures JARVIS, certifies failure and recovery paths, and gates production activation.",
  alternates: { canonical: "https://finnorai.com/how-it-works" },
  openGraph: {
    title: "How It Works | FINNOR",
    description: "Truth census, authority mapping, workspace configuration, certification, and gated production activation inside JARVIS.",
    url: "https://finnorai.com/how-it-works",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR governed execution flow" }],
  },
};

export default function HowItWorksRoute() {
  return <FinnorMarketingPage route="how-it-works" />;
}
