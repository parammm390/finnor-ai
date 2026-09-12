import type { Metadata } from "next";
import { IBM_Plex_Mono, Manrope, Outfit } from "next/font/google";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

import GlobalChrome from "@/components/layout/GlobalChrome";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: "500",
  display: "swap",
});

const satoshi = localFont({
  src: [
    { path: "../../public/fonts/Satoshi-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../public/fonts/Satoshi-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../public/fonts/Satoshi-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-satoshi",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://finnorai.com"),
  applicationName: "FINNOR",
  title: {
    default: "FINNOR | Private Equity Decision + Execution Infrastructure",
    template: "%s | FINNOR",
  },
  description:
    "FINNOR connects canonical deal truth, underwriting lineage, IC governance, Work and planning, governed execution, evidence and receipts, and a governed AI workforce.",
  keywords: [
    "private equity decision infrastructure",
    "private equity execution infrastructure",
    "deal truth",
    "underwriting lineage",
    "investment committee governance",
    "private equity workflow",
    "governed AI workforce",
    "JARVIS command surface",
    "FINNOR",
  ],
  authors: [{ name: "FINNOR", url: "https://finnorai.com" }],
  creator: "FINNOR",
  publisher: "FINNOR",
  category: "Business software",
  alternates: {
    canonical: "https://finnorai.com/",
  },
  openGraph: {
    title: "FINNOR | Private Equity Decision + Execution Infrastructure",
    description:
      "Canonical deal truth, underwriting lineage, IC governance, governed execution, evidence, receipts, and governed AI workers in one inspectable operating surface.",
    url: "https://finnorai.com/",
    siteName: "FINNOR",
    images: [
      {
        url: "/og-image.svg",
        width: 1200,
        height: 630,
        alt: "FINNOR Private Equity decision and execution infrastructure",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "FINNOR | Private Equity Decision + Execution Infrastructure",
    description:
      "Connect deal truth, underwriting, IC decisions, governed Work, evidence, receipts, and AI workers without losing lineage or authority.",
    images: ["/og-image.svg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${manrope.variable} ${outfit.variable} ${satoshi.variable} ${plexMono.variable} ${GeistSans.variable} ${GeistMono.variable} ${manrope.className} antialiased`}>
        <script
          id="finnor-structured-data"
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": "https://finnorai.com/#organization",
                  name: "FINNOR",
                  alternateName: ["FINNOR", "Finnor"],
                  url: "https://finnorai.com",
                  email: "param@finnorai.com",
                  description:
                    "FINNOR builds Private Equity decision and execution infrastructure around canonical deal truth, underwriting lineage, IC governance, Work, evidence, and governed AI workers.",
                  sameAs: ["https://www.linkedin.com/in/param-dave16"],
                },
                {
                  "@type": "WebSite",
                  "@id": "https://finnorai.com/#website",
                  url: "https://finnorai.com",
                  name: "FINNOR",
                  alternateName: "FINNOR",
                  publisher: { "@id": "https://finnorai.com/#organization" },
                  inLanguage: "en-US",
                },
                {
                  "@type": "WebPage",
                  "@id": "https://finnorai.com/#webpage",
                  url: "https://finnorai.com",
                  name: "FINNOR | Private Equity Decision + Execution Infrastructure",
                  description:
                    "FINNOR connects source-backed PE objects, underwriting lineage, investment committee governance, Work and planning, authority, evidence, receipts, and governed agents.",
                  isPartOf: { "@id": "https://finnorai.com/#website" },
                  about: { "@id": "https://finnorai.com/#organization" },
                  inLanguage: "en-US",
                },
                {
                  "@type": "Product",
                  "@id": "https://finnorai.com/#product",
                  name: "FINNOR",
                  category: "Private Equity decision + execution infrastructure",
                  description:
                    "Source-backed infrastructure joining canonical deal truth, underwriting lineage, IC governance, Work and planning, governed execution, evidence, receipts, and governed AI workers.",
                  brand: { "@id": "https://finnorai.com/#organization" },
                  audience: {
                    "@type": "BusinessAudience",
                    audienceType: "Private equity investment and operating teams",
                  },
                  offers: {
                    "@type": "Offer",
                    priceCurrency: "USD",
                    price: "30000",
                    description: "Production deployments start around $30,000; final pricing depends on implementation scope and ongoing operating and support requirements.",
                    url: "https://finnorai.com/pricing",
                    availability: "https://schema.org/InStock",
                  },
                },
                {
                  "@type": "SoftwareApplication",
                  "@id": "https://finnorai.com/#jarvis",
                  name: "JARVIS",
                  applicationCategory: "BusinessApplication",
                  operatingSystem: "Cloud",
                  url: "https://finnorai.com",
                  description:
                    "The command and work surface for FINNOR deployments, used to understand, direct, approve and inspect operational work.",
                  isPartOf: { "@id": "https://finnorai.com/#product" },
                },
              ],
            }),
          }}
        />
        <GlobalChrome>{children}</GlobalChrome>
      </body>
    </html>
  );
}
