import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FINNOR — Private Equity Decision + Execution Infrastructure",
    short_name: "FINNOR",
    description:
      "Canonical deal truth, underwriting lineage, IC governance, governed execution, evidence, receipts, and governed AI workers.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8faf9",
    theme_color: "#f3f0e8",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
