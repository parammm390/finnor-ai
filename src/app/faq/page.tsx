import type { Metadata } from "next";

import CentropyMarketingPage from "@/components/marketing/CentropyMarketingPage";
import { faqItems } from "@/content/commercial-truth";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "Direct answers about Centropy, CENTROPY, Company Brain, PE lineage, tenant isolation, authority, governed agents, deployment, and pricing.",
  alternates: { canonical: "https://finnorai.com/faq" },
  openGraph: {
    title: "FAQ | Centropy",
    description: "The product, PE truth, authority, lineage, deployment, and pricing answers behind Centropy.",
    url: "https://finnorai.com/faq",
    images: [{ url: "https://finnorai.com/og-image.svg", width: 1200, height: 630, alt: "Centropy FAQ" }],
  },
};

export default function FaqRoute() {
  return (
    <>
      <script
        id="finnor-faq-structured-data"
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: faqItems.map((item) => ({
              "@type": "Question",
              name: item.question,
              acceptedAnswer: { "@type": "Answer", text: item.answer },
            })),
          }),
        }}
      />
      <CentropyMarketingPage route="faq" />
    </>
  );
}
