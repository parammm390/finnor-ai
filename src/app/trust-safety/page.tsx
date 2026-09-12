import type { Metadata } from "next";
import { PrivateEquityResource } from "@/components/resources/PrivateEquityResource";

export const metadata: Metadata = {
  title: "Trust & Safety",
  description:
    "How FINNOR preserves source-backed PE context, uncertainty, tenant isolation, authority, governed execution, recovery, evidence, receipts, and proof.",
  alternates: {
    canonical: "https://finnorai.com/trust-safety",
  },
  openGraph: {
    title: "Trust & Safety | FINNOR",
    description: "Autonomy is a policy decision: grounding, contracts, authority, recovery and evidence.",
    url: "https://finnorai.com/trust-safety",
    images: [
      {
        url: "https://finnorai.com/og-image.svg",
        width: 1200,
        height: 630,
        alt: "FINNOR JARVIS trust and safety",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Trust & Safety | FINNOR",
    description: "The authority and evidence model behind governed execution.",
    images: ["https://finnorai.com/og-image.svg"],
  },
};

export default function TrustSafetyRoute() {
  return <PrivateEquityResource kind="trust" />;
}
