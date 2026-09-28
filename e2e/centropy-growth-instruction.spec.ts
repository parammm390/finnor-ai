import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Take growth down 300bps and exit at 9x."

test("Atlas exact growth instruction produces a grounded durable underwriting action", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password, "Owner sign-in is required")
  const proofPath = testInfo.outputPath("centropy-growth-instruction.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-growth-instruction.png")
  const observed: Record<string, unknown> = { submissionStatus: null, workId: null, threadId: null, objectiveLoopId: null,
    workStatus: null, objectiveState: null, actionId: null, actionStatus: null, actionPayload: null,
    plannerAttempts: null, objectiveSteps: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ role: "owner", tenantId: "00000000-0000-4000-8000-000000000001" })
    const authorization = await me.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    observed.submissionStatus = submitted.status()
    expect(submitted.status(), await submitted.text()).toBe(202)
    const accepted = await submitted.json() as { workId: string; threadId: string; objective?: { objectiveLoopId: string } }
    observed.workId = accepted.workId
    observed.threadId = accepted.threadId
    observed.objectiveLoopId = accepted.objective?.objectiveLoopId ?? null
    expect(accepted.workId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(accepted.threadId).toMatch(/^[0-9a-f-]{36}$/i)
    const read = async () => {
      const response = await page.request.get(`/api/centropy/works/${accepted.workId}`, { headers: { authorization: authorization! }, timeout: 20_000 })
      expect(response.ok()).toBe(true)
      return (await response.json() as { work: {
        work: { status: string }; objectiveLoop?: { state: string }; actions: Array<{ id: string; actionType: string; status: string; payload: unknown }>;
        plannerAttempts?: Array<{ status: string; failure: unknown }>; objectiveSteps: Array<{ stepNumber: number; decisionKind: string | null; failure: unknown }>
      } }).work
    }
    await expect.poll(async () => {
      const work = await read()
      observed.workStatus = work.work.status
      observed.objectiveState = work.objectiveLoop?.state ?? null
      observed.plannerAttempts = work.plannerAttempts?.map((item) => ({ status: item.status, failure: item.failure })) ?? null
      observed.objectiveSteps = work.objectiveSteps.map((item) => ({ stepNumber: item.stepNumber, decisionKind: item.decisionKind, failure: item.failure }))
      const action = work.actions.find((item) => item.actionType === "create_underwriting_run")
      observed.actionId = action?.id ?? null
      observed.actionStatus = action?.status ?? null
      observed.actionPayload = action?.payload ?? null
      if (["failed", "cancelled"].includes(work.work.status) || ["failed", "blocked"].includes(work.objectiveLoop?.state ?? "")) throw new Error(`Objective stopped: ${JSON.stringify(observed)}`)
      return Boolean(action)
    }, { timeout: 110_000, intervals: [2_000, 5_000] }).toBe(true)
    const payload = observed.actionPayload as Record<string, unknown> | null
    expect(payload?.baseRunId).toBe(process.env.CENTROPY_GROWTH_BASE_RUN_ID)
    const scenario = payload?.scenario as { overrides?: Array<{ nodeId?: string; value?: unknown }> } | undefined
    expect(scenario?.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "operating.revenue_growth", value: { "P001:2027-01-01:2027-12-31": "0.07" } }),
      expect.objectContaining({ nodeId: "exit.multiple", value: "9" }),
    ]))
    expect(scenario?.overrides).toHaveLength(2)
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_growth_natural_language_planning", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { dealId, instruction }, observed,
      steps: ["Sign in as owner", "Submit the exact growth instruction from the selected Atlas Deal", "Read the durable Work until a grounded underwriting action is staged", "Verify its base Run and both exact overrides before any approval"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_GROWTH_BASE_RUN_ID=<growth base Run> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-growth-instruction.spec.ts --project=desktop-chromium", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas growth model and local stack"] },
      limitation: "This phase checks natural-language action grounding. The separate growth-300bps E2E verifies financial execution, diff, lineage, and reload. Release certification remains open.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-growth-instruction-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-growth-instruction-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
