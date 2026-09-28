import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import type {} from "../scripts/centropy/renderer-performance.fixture"

// Failure modes and scope were recorded before this isolated renderer harness.
// These authored UNKNOWN inputs measure the actual components without inventing
// a business Work, provider observation, financial result, or active agent.
test("large authored inputs and Orb gating produce repeatable renderer measurements", async ({ page }, info) => {
  test.setTimeout(120_000)
  const inputsPath = ".centropy-certification/renderer-performance/inputs.json"
  const inputsBytes = await readFile(inputsPath)
  const inputs = JSON.parse(inputsBytes.toString())
  expect(inputs).toMatchObject({ authored: true, noBusinessAssertions: true, serverMode: "isolated_production_components_esbuild" })
  const errors: string[] = []
  const observations: Record<string, unknown> = { viewport: page.viewportSize(), inputs, inputsSha256: createHash("sha256").update(inputsBytes).digest("hex"), modes: {}, screenshots: [] }
  const screenshots = observations.screenshots as unknown[]
  let verified = false
  page.on("pageerror", (error) => errors.push(error.message))
  const ready = async (mode: string) => {
    await expect.poll(() => page.evaluate(() => ({ ready: window.__centropyBench.ready, mode: window.__centropyBench.mode }))).toEqual({ ready: true, mode })
  }
  const measure = async (mode: string) => {
    const observed = await page.evaluate((key) => ({ renderToTwoFramesMs: window.__centropyBench.timings[key], longTasksMs: [...window.__centropyBench.longTasks], longTaskSupported: window.__centropyBench.longTaskSupported, domElements: document.querySelectorAll("*").length, viewport: innerWidth, pageWidth: document.documentElement.scrollWidth }), mode)
    expect(observed.renderToTwoFramesMs).toBeGreaterThan(0)
    expect(observed.pageWidth).toBeLessThanOrEqual(observed.viewport)
    ;(observations.modes as Record<string, unknown>)[mode] = observed
    const path = info.outputPath(`${mode}.png`)
    const bytes = await page.screenshot({ path, animations: "disabled", fullPage: false })
    screenshots.push({ mode, path: path.split("/").pop(), sha256: createHash("sha256").update(bytes).digest("hex") })
  }
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("http://127.0.0.1:3339")
    await ready("blocks")
    await expect(page.locator(".ct-canvas-block")).toHaveCount(20)
    await expect(page.getByRole("heading", { name: "Authored UNKNOWN block 20", exact: true })).toBeAttached()
    await page.getByRole("heading", { name: "Authored UNKNOWN block 20", exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole("heading", { name: "Authored UNKNOWN block 20", exact: true })).toBeVisible()
    await measure("blocks")
    await page.getByRole("button", { name: "Large underwriting table", exact: true }).click()
    await ready("underwriting")
    await page.getByText("Inspect all 1000 persisted outputs", { exact: true }).click()
    const table = page.getByRole("table", { name: "Persisted underwriting outputs" })
    await expect(table.getByRole("row")).toHaveCount(1001)
    await table.getByText("Authored UNKNOWN output 1000", { exact: true }).scrollIntoViewIfNeeded()
    await expect(table.getByText("Authored UNKNOWN output 1000", { exact: true })).toBeVisible()
    await measure("underwriting")
    await page.getByRole("button", { name: "Large relationship view", exact: true }).click()
    await ready("relationships")
    await expect(page.locator(".ct-world__detail-count")).toContainText("10000 objects · 20000 links")
    await expect(page.locator(".ct-world__related")).toHaveCount(60)
    await expect(page.getByText("Showing the first 60 of 9999 linked objects.", { exact: false })).toBeVisible()
    await measure("relationships")
    await page.getByRole("button", { name: "Orb active", exact: true }).click()
    await ready("orb")
    await page.getByRole("img", { name: "CENTROPY working" }).scrollIntoViewIfNeeded()
    const mobile = (page.viewportSize()?.width ?? 1440) <= 780
    if (mobile) await expect(page.locator(".pw-liquid-orb")).toHaveCount(0)
    else await expect(page.locator(".pw-liquid-orb")).toHaveCount(1)
    observations.orb = { mobile, webglComponentMounted: !mobile, supported: mobile ? null : await page.locator(".pw-liquid-orb").getAttribute("data-supported"), frameIntervalsMs: await page.evaluate(() => new Promise<number[]>((resolve) => { const frames: number[] = []; let prior = performance.now(); const start = prior; const sample = (now: number) => { frames.push(now - prior); prior = now; if (now - start >= 1500) resolve(frames); else requestAnimationFrame(sample) }; requestAnimationFrame(sample) })) }
    await measure("orb")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(page.locator(".pw-liquid-orb")).toHaveCount(0)
    await expect(page.locator(".ct-presence__fallback")).toBeVisible()
    observations.reducedMotion = { webglComponentMounted: false, staticFallbackVisible: true }
    if (!mobile) {
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await expect(page.locator(".pw-liquid-orb")).toHaveCount(1)
      await page.locator(".ct-presence").evaluate((element) => { (element as HTMLElement).style.marginTop = "200vh" })
      await expect(page.locator(".pw-liquid-orb")).toHaveCount(0)
      observations.offscreen = { webglComponentMounted: false }
    }
    observations.resources = await page.evaluate(() => { const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[]; return { transferredBytes: entries.reduce((n, e) => n + e.transferSize, 0), decodedBytes: entries.reduce((n, e) => n + e.decodedBodySize, 0), scripts: entries.filter((e) => e.initiatorType === "script").map((e) => ({ name: new URL(e.name).pathname, bytes: e.decodedBodySize })) } })
    observations.userAgent = await page.evaluate(() => navigator.userAgent)
    observations.runtimeErrors = errors
    expect(errors).toEqual([])
    verified = true
  } finally {
    observations.runtimeErrors = errors
    const proof = info.outputPath("renderer-performance.proof.json")
    await writeFile(proof, JSON.stringify({ schema: "centropy.renderer-performance-proof/v1", result: verified ? "PASS" : "INCOMPLETE", capturedAt: new Date().toISOString(), inputs: inputsPath, observed: observations, steps: ["Mount and scroll all 20 validated Canvas blocks", "Open and reach the last of 1,000 actual underwriting renderer rows", "Render 10,000 authored objects and 20,000 authored links with the disclosed 60-row display bound", "Measure the actual Orb component with browser frame intervals", "Verify reduced-motion, mobile and offscreen component gating"], limitations: ["Authored UNKNOWN UI inputs; no backend load or financial calculation is claimed", "Isolated esbuild production-mode component bundle, not the deployed Next.js bundle", "Browser frame intervals measure this host only; GPU support is recorded rather than assumed", "Actual business agent trace and authenticated product routes are certified separately"], reproduce: { server: "node scripts/centropy/start-renderer-performance.mjs", test: "PLAYWRIGHT_BASE_URL=http://127.0.0.1:3339 npx playwright test e2e/centropy-renderer-performance.spec.ts --workers=1" } }, null, 2) + "\n")
    await info.attach("renderer-performance-proof", { path: proof, contentType: "application/json" })
  }
})
