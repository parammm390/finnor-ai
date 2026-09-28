import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { expect, test } from "@playwright/test"

const dealId = "90000000-0000-4000-8000-000000000001"
test("reviewed preference and institutional changes have canonical readback and accessible controls", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "Authored disposable tenant only")
  const observed: Record<string, unknown> = {}
  const key = `browser-benchmark-${randomUUID()}`
  const proofPath = testInfo.outputPath("centropy-human-controls.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-human-controls.png")
  let authorization: string | null = null
  let original: Record<string, unknown> | null = null
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const mePromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    authorization = await me.request().headerValue("authorization")
    const headers = { authorization: authorization! }
    original = (await (await page.request.get("/api/centropy/user-prefs", { headers })).json()).prefs
    await page.getByLabel("Account menu").click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await expect(settings).toBeVisible()
    await settings.getByLabel("Record operation").selectOption({ label: "Edit my preferences" })
    await settings.getByRole("combobox", { name: "density", exact: true }).selectOption("compact")
    await settings.getByRole("button", { name: "Review record change", exact: true }).click()
    expect((await (await page.request.get("/api/centropy/user-prefs", { headers })).json()).prefs).toEqual(original)
    await settings.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
    const putPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/user-prefs" && r.request().method() === "PUT")
    await settings.getByRole("button", { name: "Record reviewed change", exact: true }).click()
    const saved = await putPromise
    expect(saved.status()).toBe(200)
    await expect(settings).toContainText("Canonical readback verified")
    observed.preferences = (await (await page.request.get("/api/centropy/user-prefs", { headers })).json()).prefs
    expect(observed.preferences).toMatchObject({ density: "compact" })
    await page.keyboard.press("Escape")
    await expect(settings).not.toBeVisible()
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused()
    await page.reload()
    expect((await (await page.request.get("/api/centropy/user-prefs", { headers })).json()).prefs).toEqual(observed.preferences)
    await page.goto(`/centropy/world?root=${encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))}`)
    await page.getByText("Review institutional and model record changes", { exact: true }).click()
    const controls = page.locator(".ct-record-controls").filter({ hasText: "Record known identities" })
    await expect(controls.getByLabel("Record operation")).toBeVisible({ timeout: 25_000 })
    const options = await controls.getByLabel("Record operation").locator("option").allTextContents()
    expect(options).toHaveLength(27)
    observed.institutionalSelectors = options
    await controls.getByLabel("Record operation").selectOption({ label: "Create benchmark" })
    await controls.getByLabel("benchmark Key *", { exact: true }).fill(key)
    await controls.getByLabel("name *", { exact: true }).fill("Authored browser benchmark")
    await controls.getByLabel("metric Key *", { exact: true }).fill("revenue_growth")
    await controls.getByLabel("unit *", { exact: true }).fill("rate")
    await controls.getByRole("button", { name: "Review record change", exact: true }).click()
    await expect(controls).toContainText(key)
    await controls.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
    const recordedPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/private-equity/digital-twin" && r.request().method() === "POST")
    await controls.getByRole("button", { name: "Record reviewed change", exact: true }).click()
    const recorded = await recordedPromise
    expect(recorded.status(), await recorded.text()).toBe(201)
    observed.benchmark = await recorded.json()
    await expect(controls).toContainText("Owning API accepted the change")
    const response = observed.benchmark as { row: { id: string } }
    expect(response.row.id).toMatch(/^[0-9a-f-]{36}$/)
    const require = createRequire(`${process.cwd()}/finnor-os/package.json`)
    const client = new (require("pg").Client)({ connectionString: "postgres://finnor_app:finnor_app@127.0.0.1:55441/finnor" })
    await client.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.tenant_id',$1,true)", ["00000000-0000-4000-8000-000000000001"])
      observed.benchmarkReadback = (await client.query("SELECT id,benchmark_key,name,metric_key,unit FROM finnor_os.pe_benchmarks WHERE tenant_id=$1 AND id=$2", ["00000000-0000-4000-8000-000000000001", response.row.id])).rows
      await client.query("COMMIT")
    } finally { await client.end() }
    expect(JSON.stringify(observed.benchmarkReadback)).toContain(key)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    observed.overflowPx = overflow
  } finally {
    test.setTimeout(240_000)
    if (authorization && original && observed.preferences) { const restored = await page.request.put("/api/centropy/user-prefs", { headers: { authorization }, data: original }).catch(() => null); observed.preferencesRestored = restored?.ok() ?? false }
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "human_record_controls", capturedAt: new Date().toISOString(), baseUrl: testInfo.project.use.baseURL, input: { dealId, benchmarkKey: key, density: "compact", fixtureOnly: true }, observed, steps: ["Authenticate as the actual owner", "Review a preference change; verify no write before explicit attestation", "Record it, independently read it, close by keyboard and verify returned focus, then reload", "Open WORLD institutional controls and enumerate all 27 registered selectors", "Review and record an authored benchmark, then independently read its canonical Company Brain object", "Verify no viewport overflow; restore the original preferences"], screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null, reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-human-controls.spec.ts --project=desktop-chromium --workers=1" } }, null, 2) + "\n")
    await testInfo.attach("human-record-controls-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("human-record-controls-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
