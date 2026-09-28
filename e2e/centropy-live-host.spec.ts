import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

test("the released host has exact metadata and the real owner signs in through CENTROPY", async ({ page }, info) => {
  test.setTimeout(120_000)
  test.skip(process.env.CENTROPY_LIVE_CERTIFICATION !== "1", "Explicit canonical live-host runner only")
  const expectedSha = process.env.CENTROPY_EXPECTED_RELEASE_SHA!
  const short = expectedSha.slice(0, 12)
  const observed: Record<string, unknown> = { steps: [], browserErrors: [] }
  const errors = observed.browserErrors as string[]
  page.on("pageerror", (error) => errors.push(error.message))
  let verified = false
  const checkRelease = async (url: string) => {
    const response = await page.request.get(`${url}/api/release`)
    expect(response.status()).toBe(200)
    const release = await response.json()
    expect(release).toMatchObject({ commitSha: expectedSha, buildId: `finnor-${short}`, version: `0.1.0+${short}`, environment: "production", traceable: true })
    expect(release.deploymentId).toMatch(/^dpl_/)
    return release
  }
  try {
    observed.frontendRelease = await checkRelease(process.env.PLAYWRIGHT_BASE_URL!)
    observed.apiRelease = await checkRelease(process.env.CENTROPY_LIVE_API_URL!)
    const anonymous = await page.request.get("/api/centropy/me")
    expect(anonymous.status()).toBe(401)
    observed.anonymousIdentityStatus = anonymous.status()
    await page.goto("/centropy/login")
    await page.getByLabel("Email", { exact: true }).fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password", { exact: true }).fill(process.env.TEST_OWNER_PASSWORD!)
    const identityPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const identityResponse = await identityPromise
    expect(identityResponse.status()).toBe(200)
    const identity = await identityResponse.json()
    expect(identity).toMatchObject({ role: "owner", tenantId: "00000000-0000-4000-8000-000000000001" })
    expect(identity.employeeId).toMatch(/^[0-9a-f-]{36}$/)
    observed.identity = { userId: identity.userId, employeeId: identity.employeeId, tenantId: identity.tenantId, role: identity.role }
    await expect(page.getByLabel("Message CENTROPY", { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\/centropy(?:\?|$)/)
    const authorization = (await identityResponse.request().headerValue("authorization"))!
    expect(authorization.startsWith("Bearer ")).toBe(true)
    const threads = await page.request.get("/api/centropy/threads", { headers: { authorization } })
    expect(threads.status()).toBe(200)
    observed.threadReadStatus = threads.status()
    const screenshot = info.outputPath("live-owner-signed-in.png")
    observed.screenshotSha256 = createHash("sha256").update(await page.screenshot({ path: screenshot, animations: "disabled" })).digest("hex")
    const restoredPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/centropy/me")
    await page.reload()
    const restored = await restoredPromise
    expect(restored.status()).toBe(200)
    const restoredIdentity = await restored.json()
    expect({ userId: restoredIdentity.userId, employeeId: restoredIdentity.employeeId, tenantId: restoredIdentity.tenantId, role: restoredIdentity.role }).toEqual(observed.identity)
    await expect(page.getByLabel("Message CENTROPY", { exact: true })).toBeVisible()
    observed.reloadRestoredSameIdentity = true
    expect(errors).toEqual([])
    verified = true
  } finally {
    const path = info.outputPath("live-host.proof.json")
    await writeFile(path, JSON.stringify({ schema: "centropy.live-host-proof/v1", result: verified ? "PASS_LIVE" : "INCOMPLETE", capturedAt: new Date().toISOString(), expectedSha, frontend: process.env.PLAYWRIGHT_BASE_URL, api: process.env.CENTROPY_LIVE_API_URL, observed, limitations: ["Read-only host and owner sign-in verification; no business action or external provider publication was performed", "Eleven Golden Flows have separate controlled-fixture certification; this live proof does not relabel them as eleven production business executions", "Credentials, bearer headers and browser session storage are excluded"], reproduce: `node scripts/centropy/run-live-e2e.mjs ${expectedSha}` }, null, 2) + "\n")
    await info.attach("live-host-proof", { path, contentType: "application/json" })
  }
})
