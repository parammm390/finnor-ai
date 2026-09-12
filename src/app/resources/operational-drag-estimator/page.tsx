import type { Metadata } from "next";
import { PrivateEquityResource } from "@/components/resources/PrivateEquityResource";

export const metadata: Metadata = {
  title: "Operational Drag Estimator",
  description: "Measure observed evidence reconciliation, decision handoff, and execution verification effort without inventing an ROI claim.",
  alternates: { canonical: "https://finnorai.com/resources/operational-drag-estimator" },
  openGraph: {
    title: "Operational Drag Estimator | FINNOR",
    description: "Measure coordination cost and value in motion without turning it into a fabricated revenue promise.",
    url: "https://finnorai.com/resources/operational-drag-estimator",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "FINNOR operational drag estimator" }],
  },
};

export default function OperationalDragEstimatorPage() {
  return <PrivateEquityResource kind="drag" />;
}
