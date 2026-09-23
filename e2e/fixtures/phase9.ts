import { expect, test, type Page } from "@playwright/test"

export const PHASE9_PRIMARY_ROUTES = ["/centropy", "/centropy/deals", "/centropy/work", "/centropy/agents"] as const
export const PHASE9_DEAL_SECTIONS = ["overview", "underwriting", "diligence", "ic", "evidence", "closing", "work", "activity"] as const
export const PHASE9_FOREIGN_DEAL_ID = "99999999-9999-4999-8999-999999999999"

export async function signInOwner(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/centropy/login")
  await page.getByPlaceholder(/you@example.com/i).fill(email)
  await page.getByPlaceholder(/•+/i).fill(password)
  await page.getByRole("button", { name: /sign in/i }).click()
  await page.waitForURL("**/centropy", { timeout: 60_000 })
  await expect(page.locator(".pw-global-bar")).toBeVisible()
}

export async function openDeterministicDeal(page: Page): Promise<{ dealId: string; href: string }> {
  await page.goto("/centropy/deals?sort=name")
  const first = page.locator(".pw-deal-link").first()
  await expect(first, "the Phase 9 owner fixture needs at least one canonical Deal root").toBeVisible({ timeout: 45_000 })
  const rawHref = await first.getAttribute("href")
  expect(rawHref).toBeTruthy()
  const href = new URL(rawHref!, page.url())
  const match = /^\/centropy\/deals\/([0-9a-f-]{36})\/overview$/i.exec(href.pathname)
  expect(match, "Deal href must be a dynamic canonical UUID route").toBeTruthy()
  await first.click()
  await expect(page.locator(".pw-context-header")).toBeVisible({ timeout: 30_000 })
  return { dealId: match![1]!, href: href.toString() }
}

export async function openDealSection(page: Page, section: (typeof PHASE9_DEAL_SECTIONS)[number]): Promise<void> {
  await page.locator(".pw-deal-tabs").getByRole("link", { name: new RegExp(`^${section}$`, "i") }).click()
  await expect(page).toHaveURL(new RegExp(`/centropy/deals/[0-9a-f-]{36}/${section}`))
}

export async function inspectFirstRowContaining(page: Page, text: RegExp): Promise<void> {
  const row = page.locator(".pw-deal-section tbody tr").filter({ hasText: text }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator(".pw-entity-link").first().click()
  await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
}

export async function assertInspectorLineage(page: Page): Promise<void> {
  const inspector = page.locator(".pw-inspector")
  await inspector.getByRole("button", { name: "relationships", exact: true }).click()
  await expect(inspector.locator(".pw-inspector__body")).toBeVisible()
  await inspector.getByRole("button", { name: "evidence", exact: true }).click()
  await expect(inspector.locator(".pw-skeleton")).toHaveCount(0, { timeout: 30_000 })
  await expect(inspector.locator(".pw-inspector__body")).toBeVisible()
}

export async function assertKeyboardInspector(page: Page): Promise<void> {
  const row = page.locator(".pw-attention-row").first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.focus()
  await page.keyboard.press("Space")
  await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".pw-inspector[data-open='true']"), "keyboard users must be able to return from the Inspector overlay to the active workspace").toHaveCount(0)
}

async function assertNoDeadControls(page: Page): Promise<void> {
  const dead = await page.locator("a:visible, button:visible").evaluateAll((elements) => elements.flatMap((element, index) => {
    const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].find((value) => value?.trim())?.trim() ?? ""
    if (!label) return [`${element.tagName.toLocaleLowerCase()}[${index}] has no accessible action label`]
    if (element instanceof HTMLAnchorElement && (!element.getAttribute("href") || /^\s*(?:#|javascript:)/i.test(element.getAttribute("href") ?? ""))) return [`link “${label}” has no deterministic href`]
    return []
  }))
  expect(dead, "every visible journey control must expose an action and every link must have a deterministic href").toEqual([])
}

function requestRootId(pageUrl: string): string | null {
  const root = new URL(pageUrl).searchParams.get("root")
  if (!root) return null
  try {
    const parsed = JSON.parse(root) as { entityId?: unknown }
    return typeof parsed.entityId === "string" ? parsed.entityId : null
  } catch {
    return null
  }
}

export async function certifyRequiredJourneyDimensions(page: Page, dealId: string): Promise<void> {
  await test.step("deep linking + loading", async () => {
    const deepLink = page.url()
    const before = new URL(deepLink)
    expect(requestRootId(deepLink)).toBe(dealId)
    expect(before.searchParams.get("inspect"), "journey endpoint must preserve the exact InspectionTarget").toBeTruthy()
    await page.route("**/api/centropy/company-brain/projection", async (route) => {
      const body = route.request().postDataJSON() as { root?: { entityId?: string } }
      if (body.root?.entityId === dealId) await new Promise((resolve) => setTimeout(resolve, 450))
      try {
        await route.continue()
      } catch (error) {
        // A client-side navigation may cancel a delayed duplicate projection after
        // the response that rendered the scoped skeleton has already won. That is a
        // normal browser cancellation, not a product failure or an unhandled route.
        if (!(error instanceof Error) || !/Route is already handled|Target page, context or browser has been closed/i.test(error.message)) throw error
      }
    })
    await page.goto(deepLink, { waitUntil: "domcontentloaded" })
    await expect(page.locator(".pw-skeleton").first(), "a scoped authenticated loading state must render without replacing the shell").toBeVisible({ timeout: 3_000 })
    await expect(page.locator(".pw-global-bar")).toBeVisible()
    const objectTree = page.locator(".pw-object-tree")
    const contextToggle = page.getByRole("button", { name: "Open workspace context" })
    if (!(await objectTree.isVisible()) && await contextToggle.isVisible()) {
      await contextToggle.click()
      await expect(page.getByRole("button", { name: "Close workspace context" })).toHaveAttribute("aria-expanded", "true")
    }
    await expect(objectTree, "the canonical Deal object tree must remain reachable at every certified viewport").toBeVisible({ timeout: 30_000 })
    const contextClose = page.getByRole("button", { name: "Close workspace context" })
    if (await contextClose.isVisible()) await contextClose.click()
    expect(requestRootId(page.url())).toBe(dealId)
    expect(new URL(page.url()).searchParams.get("inspect")).toBe(before.searchParams.get("inspect"))
    await page.unroute("**/api/centropy/company-brain/projection")
  })

  await test.step("inspector + lineage", async () => {
    const inspector = page.locator(".pw-inspector[data-open='true']")
    await expect(inspector).toBeVisible()
    await assertInspectorLineage(page)
    await expect(inspector.locator(".pw-inspector__body .pw-lineage-edge, .pw-inspector__body .pw-entity-link, .pw-inspector__body .pw-no-link").first()).toBeVisible()
  })

  await test.step("authority", async () => {
    const inspector = page.locator(".pw-inspector")
    await inspector.getByRole("button", { name: "authority", exact: true }).click()
    await expect(inspector.locator(".pw-inspector__body")).toContainText("Selection grants no authority")
  })

  await test.step("back / forward reconstruct inspector state", async () => {
    const inspector = page.locator(".pw-inspector")
    await inspector.getByRole("button", { name: "technical", exact: true }).click()
    await expect(page).toHaveURL(/inspectorTab=technical/)
    await page.goBack()
    await expect(inspector.getByRole("button", { name: "authority", exact: true })).toHaveAttribute("aria-current", "page")
    await page.goForward()
    await expect(inspector.getByRole("button", { name: "technical", exact: true })).toHaveAttribute("aria-current", "page")
  })

  await test.step("keyboard", async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K")
    const command = page.locator(".pw-command[role='dialog']")
    await expect(command).toBeVisible()
    await expect(command).toContainText(/CENTROPY COMMAND LAYER/i)
    await expect(command).toContainText(/PE context/i)
    await page.keyboard.press("Escape")
    await expect(command).toHaveCount(0)
  })

  await test.step("stale + failure + recovery", async () => {
    await page.goto(`/centropy/deals/${dealId}/overview`)
    await expect(page.locator(".pw-context-header")).toBeVisible({ timeout: 30_000 })
    let failProjection = true
    await page.route("**/api/centropy/company-brain/projection", async (route) => {
      if (failProjection) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "deterministic source outage" }) })
      else await route.continue()
    })
    const health = page.locator(".pw-source-health")
    if (!(await health.getAttribute("open"))) await health.locator(":scope > summary").click()
    await health.locator(".pw-source-health__panel").getByRole("button", { name: /Refresh/ }).click()
    await expect(page.getByText("Showing stale Deal data")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".pw-context-header"), "cached verified content must survive a source failure").toBeVisible()
    failProjection = false
    await page.locator(".pw-deal-workspace > .pw-error-state").getByRole("button", { name: /Retry/ }).click()
    await expect(page.getByText("Showing stale Deal data")).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator(".pw-context-header")).toBeVisible()
    await page.unroute("**/api/centropy/company-brain/projection")
  })

  await test.step("tenant isolation", async () => {
    await page.goto(`/centropy/deals/${PHASE9_FOREIGN_DEAL_ID}/overview`)
    await expect(page.getByText(/Deal context is not represented|Deal workspace unavailable|Operating context rejected/i).first()).toBeVisible({ timeout: 30_000 })
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/centropy/deals/${dealId}/overview`))
    await expect(page.locator(".pw-context-header")).toBeVisible({ timeout: 30_000 })
  })

  await test.step("zero dead clicks", async () => {
    await assertNoDeadControls(page)
  })
}
