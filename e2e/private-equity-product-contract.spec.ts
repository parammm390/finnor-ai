import { expect, test } from "@playwright/test"

test.describe("Private Equity public and CENTROPY product contract", () => {
  test("public product declares the PE category and labels its demonstration honestly", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Private Equity decision + execution infrastructure", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(/synthetic contract walkthrough/i)).toBeVisible()
    await expect(page.getByText(/not live activity/i)).toBeVisible()
    await expect(page.getByText(/no production or investment-performance claim/i)).toBeVisible()
  })

  for (const path of ["/centropy", "/centropy/deals", "/centropy/work", "/centropy/agents"] as const) {
    test(`${path} has the exact four-surface shell and fails closed while signed out`, async ({ page }) => {
      const errors: string[] = []
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(path)
      await expect(page.getByRole("navigation", { name: "Private Equity operating surfaces" }).getByRole("link")).toHaveText(["Home", "Deals", "Work", "Agents"])
      await expect(page.locator(".pe-state h1")).toHaveText(/Decision context stays private by default|CENTROPY could not restore sign-in/)
      await expect(page.getByText("Project Northstar", { exact: true })).toHaveCount(0)
      expect(errors).toEqual([])
    })
  }

  for (const [source, destination] of [
    ["/customers", "/centropy/deals"],
    ["/schedule", "/centropy/work"],
    ["/money", "/centropy/deals"],
    ["/centropy/customers", "/centropy/deals"],
    ["/centropy/schedule", "/centropy/work"],
    ["/centropy/money", "/centropy/deals"],
    ["/centropy/bridge", "/centropy"],
    ["/centropy/classic", "/centropy"],
    ["/centropy/next", "/centropy"],
    ["/centropy/showtime", "/centropy"],
    ["/centropy/stage", "/centropy"],
  ] as const) {
    test(`redirects ${source} deterministically to ${destination}`, async ({ page }) => {
      await page.goto(source)
      await expect(page).toHaveURL(new RegExp(`${destination.replaceAll("/", "\\/")}$`))
    })
  }
})
