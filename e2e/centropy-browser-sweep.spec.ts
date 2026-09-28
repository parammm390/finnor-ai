import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

test.beforeEach(async ({}, info) => { test.setTimeout(240_000); await awaitFixtureRateWindow(info) })

const require = createRequire(resolve(process.cwd(), "package.json"))
const proofSource = process.env.CENTROPY_ATLAS_PROOF ?? "docs/centropy/evidence/release-candidate-atlas-fresh-terminal/summary.json"
const dealId = "90000000-0000-4000-8000-000000000001"

test("restored Atlas instruments, sources, replay, artifacts and WORLD remain accessible at every viewport", async ({ page }, info) => {
  test.setTimeout(180_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "A seeded, disposable Atlas candidate is required")
  const source = JSON.parse(await readFile(proofSource, "utf8"))
  const sourceBytes = await readFile(join(dirname(proofSource), "atlas-autonomous.proof.json"))
  expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(source.proofSha256)
  const stack = JSON.parse(await readFile(".centropy-certification/atlas-final-v2/stack.json", "utf8"))
  const observations: Record<string, unknown> = { viewport: page.viewportSize(), sourceProof: source.proofSha256, serverMode: stack.serverMode, reducedMotion: true, timingMs: {}, accessibility: {}, screenshots: [] }
  const timings = observations.timingMs as Record<string, number>
  const accessibility = observations.accessibility as Record<string, unknown>
  const screenshots = observations.screenshots as Array<{ state: string; path: string; sha256: string }>
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const mobile = (page.viewportSize()?.width ?? 1440) < 780
  let verified = false
  const authenticateRead = async (response: import("@playwright/test").Response) => {
    let current = response
    if (current.status() === 429) {
      const seconds = Number(current.headers()["retry-after"])
      expect(Number.isFinite(seconds) && seconds > 0 && seconds <= 60).toBe(true)
      const backoffs = observations.rateLimitBackoffs as unknown[] | undefined
      observations.rateLimitBackoffs = [...(backoffs ?? []), { path: new URL(current.url()).pathname, seconds }]
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      const retry = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET")
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      current = await retry
    }
    expect(current.status(), await current.text()).toBe(200)
    return current
  }
  const navigate = async (url: string, reload = false) => {
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET")
    if (reload) await page.reload(); else await page.goto(url)
    await authenticateRead(await me)
  }
  const capture = async (state: string) => {
    const path = info.outputPath(`${state}.png`)
    const bytes = await page.screenshot({ path, fullPage: true, animations: "disabled" })
    screenshots.push({ state, path: path.split("/").pop()!, sha256: createHash("sha256").update(bytes).digest("hex") })
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
    expect(dimensions.root, `${state}: horizontal page overflow`).toBeLessThanOrEqual(dimensions.viewport)
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport)
  }
  const audit = async (state: string) => {
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
    const result = await page.evaluate(async () => (window as typeof window & { axe: { run: (a: unknown, b: unknown) => Promise<{ violations: unknown[]; incomplete: unknown[]; passes: unknown[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }))
    accessibility[state] = { violations: result.violations, incomplete: result.incomplete, passes: result.passes.length }
    expect(result.violations, `${state}: WCAG automated violations`).toEqual([])
  }
  const canvas = async () => { if (mobile) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas", exact: true }).click() }
  const thread = async () => { if (mobile) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Thread", exact: true }).click() }
  try {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await authenticateRead(await me)
    const headers = { authorization: (await meResponse.request().headerValue("authorization"))! }
    await expect(page.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible()
    const initial = Date.now()
    await navigate("/centropy")
    await expect(page.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible()
    timings.initialAuthenticatedHome = Date.now() - initial
    observations.initialResources = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      return { transferredBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0), decodedBytes: resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0), scriptCount: resources.filter((entry) => entry.initiatorType === "script").length }
    })
    const opened = Date.now()
    await navigate(`/centropy/investigations/${source.threadId}`)
    await expect(page.getByRole("heading", { name: "IC preparation completed", exact: true })).toBeVisible({ timeout: 30_000 })
    timings.openInvestigation = Date.now() - opened
    if (mobile) await expect(page.getByRole("main", { name: "Investigation Canvas" })).not.toBeVisible()
    const toolbarButtons = await page.locator(".ct-composer footer button").evaluateAll((buttons) => buttons.map((button) => { const box = button.getBoundingClientRect(); return { label: button.getAttribute("aria-label") ?? button.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom } }))
    for (let index = 0; index < toolbarButtons.length; index++) for (const other of toolbarButtons.slice(index + 1)) {
      const button = toolbarButtons[index]
      expect(button.left < other.right && button.right > other.left && button.top < other.bottom && button.bottom > other.top, `Composer controls overlap: ${button.label} / ${other.label}`).toBe(false)
    }
    observations.composerControlBounds = toolbarButtons
    await audit("thread")
    await capture("thread")
    await canvas()
    await expect(page.getByRole("heading", { name: "Work and verification", exact: true })).toBeVisible()
    await expect(page.locator('.ct-canvas-block[data-type="underwriting_summary"]')).toBeVisible()
    observations.blockCount = await page.locator(".ct-canvas-block").count()
    await audit("canvas")
    await capture("canvas")
    await page.getByRole("button", { name: "Inspect source diagnostics", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Connection and evidence coverage" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Connection and evidence coverage" })).toContainText("No Microsoft Graph connection")
    await capture("sources")
    await page.getByRole("button", { name: "Close source diagnostics", exact: true }).click()
    await page.getByRole("button", { name: "Why did this happen?", exact: false }).click()
    await expect(page.getByRole("heading", { name: "Why did this happen?", exact: true })).toBeVisible()
    await expect(page.locator(".ct-replay__meta")).toContainText("missing links", { timeout: 30_000 })
    observations.replay = await page.locator(".ct-replay__meta").innerText()
    await audit("replay")
    await capture("replay")
    await expect(page).toHaveURL(new RegExp(`replayWorkId=${source.workId}`))
    const replayBefore = await page.locator(".ct-replay__meta").innerText()
    await navigate("", true)
    await expect(page.locator(".ct-replay__meta")).toContainText("missing links", { timeout: 30_000 })
    expect((await page.locator(".ct-replay__meta").innerText()).split("As of")[0]).toBe(replayBefore.split("As of")[0])
    observations.replayRestored = true
    await page.getByRole("button", { name: "Missing links", exact: true }).click()
    observations.replayGaps = await page.locator(".ct-replay__gaps").innerText()
    await page.getByRole("button", { name: "Canvas", exact: true }).filter({ has: page.locator('svg') }).click()
    const current = await page.request.get(`/api/centropy/works/${source.workId}`, { headers })
    expect(current.status()).toBe(200)
    const work = (await current.json()).work
    expect(work.work.status).toBe("completed")
    expect(work.objectiveLoop.successVerification.state).toBe("verified")
    const memoAction = work.actions.find((action: { actionType: string }) => action.actionType === "create_ic_memo_draft")
    expect(memoAction).toBeTruthy()
    const memoEffect = work.businessEffects.find((effect: { domainActionId: string }) => effect.domainActionId === memoAction.id)
    expect(memoEffect.status).toBe("verified")
    const version = memoEffect.observedResult.canonicalState
    const preview = Date.now()
    await navigate(`/centropy/investigations/${source.threadId}?artifactMode=draft&artifactDocumentId=${version.documentId}&artifactVersionId=${version.documentVersionId}`)
    await expect(page.getByRole("heading", { name: "Document structure", exact: true })).toBeVisible({ timeout: 30_000 })
    timings.artifactPreview = Date.now() - preview
    observations.artifactVersion = version.documentVersionId
    await audit("artifact")
    await capture("artifact")
    await navigate("", true)
    await expect(page.getByRole("heading", { name: "Document structure", exact: true })).toBeVisible()
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    const relationship = Date.now()
    await navigate(`/centropy/world?root=${root}&threadId=${source.threadId}`)
    await expect(page.locator(".ct-world__header").getByRole("heading", { level: 2 })).toBeVisible()
    await page.getByRole("button", { name: "Relationships", exact: true }).click()
    await expect(page.locator(".ct-world__detail-count")).toContainText("objects")
    timings.relationshipView = Date.now() - relationship
    observations.relationships = await page.locator(".ct-world__detail-count").innerText()
    await audit("world")
    await capture("world")
    await thread()
    await page.getByRole("button", { name: "Investigations", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Recent Investigations" })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole("button", { name: "Investigations", exact: true })).toBeFocused()
    expect(errors).toEqual([])
    observations.keyboardDialog = "focus entered, Escape dismissed, opener regained focus"
    observations.runtimeErrors = errors
    verified = true
  } finally {
    const path = info.outputPath("sweep.proof.json")
    await writeFile(path, JSON.stringify({ schema: "centropy.e2e-proof/v2", result: verified ? "PASS" : "INCOMPLETE", capturedAt: new Date().toISOString(), baseURL: info.project.use.baseURL,
      steps: ["Sign in as fixture owner", "Reopen verified Atlas Investigation under reduced motion", "Inspect Thread, Canvas and exact source diagnostics", "Read declared causal replay and representation gaps", "Open immutable memo version and reload its draft URL", "Read WORLD relationship projection", "Exercise native Investigation dialog by keyboard"],
      observed: observations, limitation: "Automated WCAG checks supplement keyboard and visual review. Timings identify the actual server mode; this test does not certify unexercised large synthetic block counts.",
      reproduce: "CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test e2e/centropy-browser-sweep.spec.ts --workers=1" }, null, 2))
    await info.attach("browser-sweep-proof", { path, contentType: "application/json" })
  }
})
