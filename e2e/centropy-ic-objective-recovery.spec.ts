import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const workId = process.env.CENTROPY_WORK_ID
const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD

test("recover the exact IC Objective without replaying verified effects", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!workId || !email || !password, "Fixture owner and Work are required")
  const proofPath = testInfo.outputPath("centropy-ic-objective-recovery.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-ic-objective-recovery.png")
  const observed: Record<string, unknown> = { workId, statusBefore: null, statusAfter: null, revisionBefore: null, revisionAfter: null, originalActionIds: [], actionIdsAfter: [], originalEffectIds: [], effectIdsAfter: [], plannerAttemptAfter: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    const actor = await me.json() as { role?: string }
    expect(actor.role).toBe("owner")
    const authorization = await me.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const headers = { authorization: authorization! }
    const read = async () => {
      const response = await page.request.get(`/api/centropy/works/${workId}`, { headers, timeout: 20_000 })
      expect(response.ok()).toBe(true)
      return (await response.json() as { work: {
        work: { status: string; finalOutcome?: { response?: { threadId?: string } } };
        objectiveLoop?: { revision?: number };
        actions: Array<{ id: string; actionType: string; status: string }>;
        businessEffects: Array<{ id: string; status: string }>;
        plannerAttempts?: Array<{ attempt: number }>;
      } }).work
    }
    const before = await read()
    expect(["recovery", "executing"]).toContain(before.work.status)
    const actionIds = before.actions.map((item) => item.id).sort()
    const effectIds = before.businessEffects.map((item) => item.id).sort()
    expect(before.actions.filter((item) => ["create_underwriting_run", "open_ic_case", "begin_ic_preparation"].includes(item.actionType) && item.status === "completed")).toHaveLength(3)
    expect(before.businessEffects.every((item) => item.status === "verified")).toBe(true)
    observed.statusBefore = before.work.status
    observed.revisionBefore = before.objectiveLoop?.revision ?? null
    observed.originalActionIds = actionIds
    observed.originalEffectIds = effectIds

    const controlled = await page.request.post(`/api/centropy/works/${workId}/objective`, { headers, data: { command: "continue" }, timeout: 25_000 })
    expect(controlled.status()).toBe(202)
    const response = await controlled.json() as { objective?: { revision?: number; state?: string } }
    expect(response.objective?.state).toBe("continue")
    expect(response.objective?.revision).toBeGreaterThan(before.objectiveLoop?.revision ?? 0)
    observed.revisionAfter = response.objective?.revision ?? null

    await expect.poll(async () => {
      const current = await read().catch(() => null)
      observed.statusAfter = current?.work.status ?? null
      observed.plannerAttemptAfter = Math.max(0, ...(current?.plannerAttempts ?? []).map((item) => item.attempt))
      return Number(observed.plannerAttemptAfter) > Math.max(0, ...(before.plannerAttempts ?? []).map((item) => item.attempt))
    }, { timeout: 120_000, intervals: [2_000, 4_000] }).toBe(true)
    const after = await read()
    observed.actionIdsAfter = after.actions.map((item) => item.id).sort()
    observed.effectIdsAfter = after.businessEffects.map((item) => item.id).sort()
    expect(observed.actionIdsAfter).toEqual(actionIds)
    expect(observed.effectIdsAfter).toEqual(effectIds)
    const threadId = before.work.finalOutcome?.response?.threadId
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
    await page.goto(`/centropy/investigations/${threadId}`)
    await expect(page.getByRole("region", { name: "CENTROPY conversation" })).toBeVisible()
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({
      schema: "finnor.centropy.e2e-proof/v1", flow: "ic_objective_recovery_after_worker_loss", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId }, observed,
      steps: ["Sign in as the fixture owner", "Record verified action and effect IDs before recovery", "Continue the exact Objective through its governed control API", "Observe a new planner attempt and unchanged verified effect IDs", "Reopen the persisted Investigation"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<fixture Work with an orphaned Objective planner attempt> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-ic-objective-recovery.spec.ts --project=desktop-chromium", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Work with a dead-letter Objective job after a lost worker lease"] },
    }, null, 2))
  }
})
