import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test.afterEach(async ({ page }, info) => {
  const screenshot = await page.screenshot({ path: info.outputPath("boundary.png"), fullPage: true, animations: "disabled" })
  const path = info.outputPath("boundary.proof.json")
  await writeFile(path, JSON.stringify({ schema: "centropy.e2e-proof/v2", test: info.title, result: info.status,
    baseURL: info.project.use.baseURL, observedURL: page.url(), steps: ["Navigate the specified public or compatibility route", "Assert public labels, fail-closed workspace boundary, or exact preserved context", "Capture the resulting page"],
    screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    reproduce: "npx playwright test e2e/private-equity-product-contract.spec.ts" }, null, 2))
  await info.attach("public-boundary-proof", { path, contentType: "application/json" })
})

test.describe("Private Equity public and CENTROPY product contract", () => {
  test("public product labels its synthetic demonstration honestly", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Private Equity decision + execution infrastructure", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/synthetic contract walkthrough/i)).toBeVisible()
    await expect(page.getByText(/not live activity/i)).toBeVisible()
    await expect(page.getByText(/no production or investment-performance claim/i)).toBeVisible()
  })
  for (const path of ["/centropy", "/centropy/world", "/centropy/deals", "/centropy/work", "/centropy/agents"]) {
    test(`${path} keeps investment context private while signed out`, async ({ page }) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(path)
      await expect(page.getByRole("heading", { name: "Your investment context stays private." })).toBeVisible()
      await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible()
      await expect(page.getByRole("navigation", { name: "Private Equity operating surfaces" })).toHaveCount(0)
      await expect(page.getByText("Project Northstar", { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }
  for (const source of ["/customers", "/schedule", "/money", "/centropy/customers", "/centropy/schedule", "/centropy/money"]) {
    test(`${source} redirects into WORLD`, async ({ page }) => {
      await page.goto(source)
      await expect(page).toHaveURL(/\/centropy\/world$/)
    })
  }
  for (const source of ["bridge", "classic", "next", "showtime", "stage"]) {
    test(`retired ${source} redirects into CENTROPY`, async ({ page }) => {
      await page.goto(`/centropy/${source}`)
      await expect(page).toHaveURL(/\/centropy$/)
    })
  }
  test("an old Deal section preserves its exact institutional root", async ({ page }) => {
    const id = "90000000-0000-4000-8000-000000000001"
    await page.goto(`/centropy/deals/${id}/underwriting`)
    await expect(page).toHaveURL(/\/centropy\/world\?root=/)
    expect(JSON.parse(new URL(page.url()).searchParams.get("root")!)).toEqual({ entityType: "pe_deal", entityId: id })
  })
})
