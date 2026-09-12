import { expect, test, type Page } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD

test.describe("Phase 8 public and JARVIS cutover", () => {
  test("public product declares the PE category and labels its demonstration honestly", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Private Equity decision + execution infrastructure", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/synthetic contract walkthrough/i)).toBeVisible()
    await expect(page.getByText(/not live activity/i)).toBeVisible()
    await expect(page.getByText(/no production or investment-performance claim/i)).toBeVisible()
  })

  for (const path of ["/jarvis", "/jarvis/deals", "/jarvis/work", "/jarvis/agents"] as const) {
    test(`${path} has the exact four-surface shell and fails closed while signed out`, async ({ page }) => {
      const errors: string[] = []
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(path)
      await expect(page.getByRole("navigation", { name: "Private Equity operating surfaces" }).getByRole("link")).toHaveText(["Home", "Deals", "Work", "Agents"])
      await expect(page.locator(".pe-state h1")).toHaveText(/Decision context stays private by default|JARVIS could not restore sign-in/)
      await expect(page.getByText("Project Northstar", { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }

  for (const [source, destination] of [
    ["/customers", "/jarvis/deals"],
    ["/schedule", "/jarvis/work"],
    ["/money", "/jarvis/deals"],
    ["/jarvis/customers", "/jarvis/deals"],
    ["/jarvis/schedule", "/jarvis/work"],
    ["/jarvis/money", "/jarvis/deals"],
    ["/jarvis/bridge", "/jarvis"],
    ["/jarvis/classic", "/jarvis"],
    ["/jarvis/next", "/jarvis"],
    ["/jarvis/showtime", "/jarvis"],
    ["/jarvis/stage", "/jarvis"],
  ] as const) {
    test(`redirects ${source} deterministically to ${destination}`, async ({ page }) => {
      await page.goto(source)
      await expect(page).toHaveURL(new RegExp(`${destination.replaceAll("/", "\\/")}$`))
    })
  }
})

async function signIn(page: Page) {
  await page.goto("/jarvis/login")
  await page.getByPlaceholder(/you@example.com/i).fill(email!)
  await page.getByPlaceholder(/•+/i).fill(password!)
  await page.getByRole("button", { name: /sign in/i }).click()
  await page.waitForURL("**/jarvis", { timeout: 60_000 })
}

async function selectDealRoot(page: Page) {
  await page.goto("/jarvis/deals")
  const dealRoot = page.locator(".pe-root-picker__list button").filter({ hasText: /Deal ·/ }).first()
  await expect(dealRoot, "the dedicated Phase 8 test tenant needs a canonical Deal root").toBeVisible({ timeout: 30_000 })
  await dealRoot.click()
  await expect(page.getByRole("heading", { name: "Company Brain", exact: true })).toBeVisible({ timeout: 30_000 })
}

async function inspectFirstNode(page: Page, lens: string, typeLabel: RegExp) {
  await page.getByRole("tab", { name: lens, exact: true }).click()
  const node = page.locator(".pe-brain-node").filter({ hasText: typeLabel }).first()
  await expect(node).toBeVisible({ timeout: 20_000 })
  await node.click()
  await expect(page.locator(".pe-inspector").getByText(typeLabel).first()).toBeVisible()
}

test.describe("Phase 8 authenticated exact inspection", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(120_000)
  test.skip(!email || !password, "TEST_OWNER_EMAIL and TEST_OWNER_PASSWORD are required; authenticated tenant truth is never faked")

  test.beforeEach(async ({ page }) => signIn(page))

  test("inspects Deal, Evidence, IC, Work, and DecisionReceipt objects through typed targets", async ({ page }) => {
    await selectDealRoot(page)
    await inspectFirstNode(page, "Overview", /Pe Deal/)
    await inspectFirstNode(page, "Evidence & Documents", /Evidence (Source|Version)/)
    await inspectFirstNode(page, "IC", /Pe Ic (Case|Question|Recommendation|Vote|Dissent|Condition)/)
    await inspectFirstNode(page, "Work", /^Work|Work\b/)
    await inspectFirstNode(page, "Work", /Decision Receipt/)
  })

  test("opens persisted provenance, history, evidence, and decision lineage", async ({ page }) => {
    await selectDealRoot(page)
    await inspectFirstNode(page, "Overview", /Pe Deal/)
    for (const tab of ["Provenance", "History", "Evidence", "Decision"] as const) {
      await page.getByRole("button", { name: tab, exact: true }).click()
      await expect(page.locator(".pe-inspector__body")).toBeVisible()
      await expect(page.locator(".pe-inspector__loading")).toHaveCount(0, { timeout: 30_000 })
    }
  })

  test("preserves one canonical PE context across Deals, Work, and Agents", async ({ page }) => {
    await selectDealRoot(page)
    const rootType = new URL(page.url()).searchParams.get("rootType")
    const rootId = new URL(page.url()).searchParams.get("rootId")
    expect(rootType).toBe("pe_deal")
    expect(rootId).toMatch(/^[0-9a-f-]{36}$/i)
    for (const label of ["Work", "Agents"] as const) {
      await page.getByRole("link", { name: label, exact: true }).click()
      const current = new URL(page.url())
      expect(current.searchParams.get("rootType")).toBe(rootType)
      expect(current.searchParams.get("rootId")).toBe(rootId)
    }
  })
})
