import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD

test("CENTROPY owner signs in and restores the same session after reload", async ({ page }, testInfo) => {
  test.skip(!email || !password, "TEST_OWNER_EMAIL and TEST_OWNER_PASSWORD are required")

  const observed: Record<string, unknown> = {
    signInPage: false,
    ownerMeStatus: null,
    ownerRole: null,
    authenticatedShell: false,
    restoredAfterReload: false,
  }
  const screenshotPath = testInfo.outputPath("centropy-owner-login.png")
  const proofPath = testInfo.outputPath("centropy-owner-login.proof.json")
  try {
    await page.goto("/centropy/login")
    await expect(page.getByRole("heading", { name: "Sign in to CENTROPY" })).toBeVisible()
    observed.signInPage = true

    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const meResponse = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await meResponse
    observed.ownerMeStatus = me.status()
    const body = await me.json() as { role?: string }
    observed.ownerRole = body.role ?? null
    expect(me.status()).toBe(200)
    expect(body.role).toBe("owner")
    await expect(page.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible()
    observed.authenticatedShell = true

    await page.reload()
    await expect(page.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible()
    observed.restoredAfterReload = true
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1",
      flow: "owner_sign_in_and_reload",
      capturedAt: new Date().toISOString(),
      baseUrl: testInfo.project.use.baseURL ?? null,
      actorEmail: email,
      observed,
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: {
        command: "npx playwright test e2e/centropy-owner-login.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "PLAYWRIGHT_BASE_URL or local Next server"],
      },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-owner-login-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-owner-login-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
