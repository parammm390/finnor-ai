import { chromium } from "playwright";

const baseUrl = process.env.FINNOR_QA_URL ?? "http://127.0.0.1:3200";
const routes = [
  "/",
  "/product",
  "/capabilities",
  "/how-it-works",
  "/pricing",
  "/faq",
  "/resources",
  "/resources/operating-glossary",
  "/resources/operational-drag-estimator",
  "/resources/deployment-readiness-checklist",
  "/trust-safety",
  "/privacy",
  "/terms",
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const results = [];

for (const route of routes) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const metadata = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? "",
    openGraphTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "",
    openGraphDescription: document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? "",
    structuredData: [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => script.textContent ?? ""),
  }));
  const expectedCanonical = `https://finnorai.com${route === "/" ? "" : route}`;
  const searchableMetadata = [metadata.title, metadata.description, metadata.openGraphTitle, metadata.openGraphDescription].join(" ");
  let structuredDataValid = true;
  const parsed = [];
  try {
    for (const value of metadata.structuredData) parsed.push(JSON.parse(value));
  } catch {
    structuredDataValid = false;
  }
  const product = parsed.flatMap((entry) => entry?.["@graph"] ?? []).find((entry) => entry?.["@type"] === "Product");
  results.push({
    route,
    title: metadata.title,
    descriptionLength: metadata.description.length,
    canonical: metadata.canonical,
    structuredDataCount: parsed.length,
    passed:
      metadata.title.length > 8 &&
      metadata.description.length > 45 &&
      metadata.canonical === expectedCanonical &&
      !/public demo|missed[- ]call|dispatch ai|voice agent/i.test(searchableMetadata) &&
      structuredDataValid &&
      product?.category === "Private Equity decision + execution infrastructure" &&
      product?.offers?.price === "30000",
  });
}

await browser.close();
const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ routeCount: results.length, failedCount: failed.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
