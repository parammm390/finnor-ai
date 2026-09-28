import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const fixtureTenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"

test("approved Atlas IC case begins preparation and survives reload", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  const hostname = new URL(baseUrl).hostname
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId, "Owner credentials and CENTROPY_WORK_ID are required")
  const proofPath = testInfo.outputPath("centropy-ic-continuation.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-ic-continuation.png")
  const observed: Record<string, unknown> = { workId, caseId: null, actionId: null, actionStatus: null, verifiedEffect: false, finalizedReceipt: false, state: null, version: null, reloadState: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await mePromise
    expect(meResponse.status()).toBe(200)
    const me = await meResponse.json() as { tenantId?: string; role?: string }
    expect(me.tenantId).toBe(fixtureTenantId)
    expect(me.role).toBe("owner")
    const authorization = await meResponse.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)

    const readWork = async () => {
      const response = await page.request.get(`/api/centropy/works/${workId}`, { headers: { authorization: authorization! }, timeout: 15_000 })
      expect(response.ok()).toBe(true)
      return (await response.json() as { work: {
        work: { status?: string; finalOutcome?: { response?: { threadId?: string } } };
        actions?: Array<{ id?: string; actionType?: string; status?: string; payload?: { icCaseId?: string } }>;
        businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }>;
        receipts?: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      } }).work
    }
    const before = await readWork()
    const opened = before.actions?.find((action) => action.actionType === "open_ic_case" && action.status === "completed")
    const caseId = before.businessEffects?.find((effect) => effect.domainActionId === opened?.id && effect.status === "verified")?.observedResult?.entity?.entityId
    const begin = before.actions?.find((action) => action.actionType === "begin_ic_preparation" && action.status === "pending")
    const threadId = before.work.finalOutcome?.response?.threadId
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(begin?.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(begin?.payload?.icCaseId).toBe(caseId)
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.caseId = caseId
    observed.actionId = begin!.id
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy/investigations/${threadId}?root=${root}&icCaseId=${caseId}`)
    const effects = page.locator(".ct-effects")
    await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
    await effects.getByRole("button", { name: "Review exact effect" }).click()
    await expect(effects).toContainText(begin!.id!.slice(0, 8))
    await effects.getByRole("button", { name: "Confirm", exact: true }).click()
    await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
    const confirmationPromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/centropy/actions/${begin!.id}/confirm`)
    await effects.getByRole("button", { name: "Confirm effect" }).click()
    const confirmation = await confirmationPromise
    expect(confirmation.status()).toBe(200)

    await expect.poll(async () => {
      const work = await readWork().catch(() => null)
      const action = work?.actions?.find((item) => item.id === begin?.id)
      observed.actionStatus = action?.status ?? null
      observed.verifiedEffect = Boolean(work?.businessEffects?.find((effect) => effect.domainActionId === begin?.id && effect.status === "verified"))
      observed.finalizedReceipt = Boolean(work?.receipts?.find((receipt) => receipt.domainActionId === begin?.id && receipt.finalizedAt && !receipt.failure))
      return observed.actionStatus === "completed" && observed.verifiedEffect && observed.finalizedReceipt
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)

    const readCase = async () => {
      const response = await page.request.get(`/api/centropy/private-equity/ic/cases/${caseId}`, { headers: { authorization: authorization! }, timeout: 15_000 })
      expect(response.ok()).toBe(true)
      return (await response.json() as { case?: { id?: string; state?: string; version?: number } }).case
    }
    const icCase = await readCase()
    expect(icCase?.id).toBe(caseId)
    expect(icCase?.state).toBe("PREPARING")
    expect(icCase?.version).toBe(2)
    observed.state = icCase?.state ?? null
    observed.version = icCase?.version ?? null
    await page.reload()
    const restored = await readCase()
    observed.reloadState = restored?.state ?? null
    expect(restored?.state).toBe("PREPARING")
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_ic_case_preparation", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, dealId }, observed,
      steps: ["Authenticate the owner and verify the disposable Atlas tenant", "Read the Work-linked DRAFT IC case and pending begin_ic_preparation action", "Review and confirm its exact effect in the browser", "Verify action completion, Business Effect and finalized receipt", "Read back PREPARING case version and confirm it survives a full reload"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<Work awaiting begin_ic_preparation approval> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-ic-continuation.spec.ts --project=desktop-chromium", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas fixture and pending begin_ic_preparation action"] },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-ic-continuation-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-ic-continuation-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
