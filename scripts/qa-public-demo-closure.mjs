import { chromium } from "playwright";

const baseUrl = process.env.FINNOR_QA_URL ?? "http://127.0.0.1:3200";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const publicRoutes = ["/demo", "/demo/lifecycle", "/demo/anything", "/dashboard-demo"];
// Negative-only retirement contract: these removed public demo endpoints must
// remain unreachable. Naming a retired route here does not make it executable.
const apiRoutes = [
  "/api/generate-demo",
  "/api/demo-profile",
  "/api/demo-scrape",
  "/api/demo-leads",
  "/api/demo-leads/update",
  "/api/demo/extract-intake",
  "/api/lifecycle/diagnose",
  "/api/lifecycle/water",
];
const results = [];

for (const route of publicRoutes) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  results.push({
    name: `public route ${route}`,
    status: response?.status() ?? 0,
    finalPath: new URL(page.url()).pathname,
    passed: new URL(page.url()).pathname === "/product" && (response?.status() ?? 0) === 200,
  });
}

for (const route of apiRoutes) {
  const response = await context.request.post(`${baseUrl}${route}`, {
    data: {},
    headers: { "content-type": "application/json" },
    failOnStatusCode: false,
  });
  results.push({
    name: `anonymous API ${route}`,
    status: response.status(),
    passed: response.status() === 404,
  });
}

const sitemapResponse = await context.request.get(`${baseUrl}/sitemap.xml`);
const sitemap = await sitemapResponse.text();
results.push({
  name: "sitemap excludes public demo URLs",
  passed: sitemapResponse.ok() && !sitemap.includes("/demo") && !sitemap.includes("dashboard-demo"),
});

await browser.close();
const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ checkCount: results.length, failedCount: failed.length, results }, null, 2));
if (failed.length) process.exitCode = 1;
