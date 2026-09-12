import type { Metadata } from "next";
import { PrivateEquityResource } from "@/components/resources/PrivateEquityResource";

export const metadata: Metadata = {
  title: "FINNOR Operating Glossary",
  description: "Plain-language definitions for Company Brain, PE roots, epistemic state, underwriting and decision lineage, Work, Authority, evidence, receipts, proof, and governed agents.",
  alternates: { canonical: "https://finnorai.com/resources/operating-glossary" },
  openGraph: {
    title: "FINNOR Operating Glossary",
    description: "The exact language behind FINNOR Private Equity decision and execution infrastructure.",
    url: "https://finnorai.com/resources/operating-glossary",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR operating and execution glossary" }],
  },
};

export default function OperatingGlossaryPage() {
  return <PrivateEquityResource kind="glossary" />;
}
