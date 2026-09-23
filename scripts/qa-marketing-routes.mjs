import { chromium } from "playwright";

const baseUrl = process.env.FINNOR_QA_URL ?? "http://127.0.0.1:3200";
const routes = [
  { path: "/" },
  { path: "/product" },
  { path: "/capabilities" },
  { path: "/how-it-works" },
  { path: "/pricing" },
  { path: "/faq" },
  { path: "/resources" },
  { path: "/resources/operating-glossary" },
  { path: "/resources/operational-drag-estimator" },
  { path: "/resources/deployment-readiness-checklist" },
  { path: "/resources/dispatch-ai-glossary", finalPath: "/resources/operating-glossary" },
  { path: "/resources/admissions-ai-glossary", finalPath: "/resources/operating-glossary" },
  { path: "/resources/missed-call-cost-calculator", finalPath: "/resources/operational-drag-estimator" },
  { path: "/resources/pilot-setup-checklist", finalPath: "/resources/deployment-readiness-checklist" },
  { path: "/trust-safety" },
  { path: "/privacy" },
  { path: "/terms" },
  { path: "/demo", finalPath: "/product" },
  { path: "/demo/lifecycle", finalPath: "/product" },
  { path: "/demo/legacy", finalPath: "/product" },
  { path: "/dashboard-demo", finalPath: "/product" },
  { path: "/customers", finalPath: "/centropy/deals" },
  { path: "/schedule", finalPath: "/centropy/work" },
  { path: "/money", finalPath: "/centropy/deals" },
  { path: "/centropy" },
  { path: "/centropy/login" },
  { path: "/centropy/reset-password" },
  { path: "/centropy/deals" },
  { path: "/centropy/work" },
  { path: "/centropy/agents" },
  { path: "/centropy/customers", finalPath: "/centropy/deals" },
  { path: "/centropy/schedule", finalPath: "/centropy/work" },
  { path: "/centropy/money", finalPath: "/centropy/deals" },
  { path: "/centropy/bridge", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/centropy/classic", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/centropy/next", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/centropy/showtime", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/centropy/stage", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/jarvis", finalPath: "/centropy" },
  { path: "/jarvis/login", finalPath: "/centropy/login" },
  { path: "/jarvis/reset-password", finalPath: "/centropy/reset-password" },
  { path: "/jarvis/deals", finalPath: "/centropy/deals" },
  { path: "/jarvis/work", finalPath: "/centropy/work" },
  { path: "/jarvis/agents", finalPath: "/centropy/agents" },
  { path: "/jarvis/customers", finalPath: "/centropy/deals" },
  { path: "/jarvis/schedule", finalPath: "/centropy/work" },
  { path: "/jarvis/money", finalPath: "/centropy/deals" },
  { path: "/jarvis/bridge", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/jarvis/classic", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/jarvis/next", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/jarvis/showtime", finalPath: "/centropy", allowedStatus: [200, 307] },
  { path: "/jarvis/stage", finalPath: "/centropy", allowedStatus: [200, 307] },
];

const viewports = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "mobile", width: 390, height: 844 },
];

const browser = await chromium.launch({ headless: true });
const results = [];

for (const viewport of viewports) {
 const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
 for (const routeConfig of routes) {
  const route = routeConfig.path;
  const page = await context.newPage();
  const runtimeErrors = [];
  const expectedAuthDenials = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const value = message.text();
    if (route.endsWith("/bridge") && (/status of 401 \(Unauthorized\)/i.test(value) || value.includes("Sign in required"))) {
      expectedAuthDenials.push(value);
      return;
    }
    runtimeErrors.push(value);
  });

  try {
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("load");
    await page.waitForTimeout(route.startsWith("/centropy") || route.startsWith("/jarvis") ? 900 : 450);
    const status = response?.status() ?? 0;
    const metrics = await page.evaluate(() => ({
      bodyLength: (document.body.textContent ?? "").trim().length,
      title: document.title,
      overlay: Boolean(document.querySelector("[data-nextjs-dialog], #webpack-dev-server-client-overlay")),
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    const allowedStatus = routeConfig.allowedStatus ?? [200];
    const isProductRoute = route.startsWith("/centropy") || route.startsWith("/jarvis");
    const minimumBodyLength = isProductRoute || status === 404 ? 10 : 120;
    results.push({
      viewport: viewport.label,
      route,
      finalPath: new URL(page.url()).pathname,
      status,
      ...metrics,
      runtimeErrors,
      expectedAuthDenials,
      passed:
        allowedStatus.includes(status) &&
        new URL(page.url()).pathname === (routeConfig.finalPath ?? route) &&
        !metrics.overlay &&
        metrics.bodyLength > minimumBodyLength &&
        metrics.horizontalOverflow <= 2 &&
        runtimeErrors.length === 0,
    });
  } catch (error) {
    results.push({ route, passed: false, error: error instanceof Error ? error.message : String(error) });
  }

  await page.close();
 }
 await context.close();
}

await browser.close();

const failed = results.filter((result) => !result.passed);
const report = process.env.FINNOR_QA_VERBOSE === "1"
  ? { routeCount: results.length, failedCount: failed.length, results }
  : { routeCount: results.length, failedCount: failed.length, failed };
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;
