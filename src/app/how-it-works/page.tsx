import type { Metadata } from "next";

import CentropyMarketingPage from "@/components/marketing/CentropyMarketingPage";

export const metadata: Metadata = {
  title: "How It Works | From PE Truth to Verified Execution",
  description:
    "See how Centropy maps PE truth and sources, binds authority, configures CENTROPY, certifies failure and recovery paths, and gates production activation.",
  alternates: { canonical: "https://finnorai.com/how-it-works" },
  openGraph: {
    title: "How It Works | Centropy",
    description: "Truth census, authority mapping, workspace configuration, certification, and gated production activation inside CENTROPY.",
    url: "https://finnorai.com/how-it-works",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "Centropy governed execution flow" }],
  },
};

export default function HowItWorksRoute() {
  return <CentropyMarketingPage route="how-it-works" />;
}
