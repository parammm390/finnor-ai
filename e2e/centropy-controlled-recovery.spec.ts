import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

const finnorRequire = createRequire(resolve(process.cwd(), "finnor-os/package.json"))
const PgClient = finnorRequire("pg").Client as new (options: { connectionString: string }) => {
  connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void>
}
const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const adminUrl = process.env.CENTROPY_RECOVERY_ADMIN_DATABASE_URL
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Recheck the entire deal before IC."

async function setHistoryReadPermission(allowed: boolean) {
  const sql = `${allowed ? "GRANT" : "REVOKE"} SELECT ON finnor_os.canonical_history_coverage ${allowed ? "TO" : "FROM"} finnor_app`
  const client = new PgClient({ connectionString: adminUrl! })
  await client.connect()
  try { await client.query(sql) } finally { await client.end() }
}

test("recover a partially completed Atlas recheck after a controlled canonical-read outage", async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !adminUrl || !/^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:55441\/finnor$/.test(adminUrl), "A guarded disposable local admin database URL and owner sign-in are required")
  await awaitFixtureRateWindow(testInfo)
  const proofPath = testInfo.outputPath("centropy-controlled-recovery.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-controlled-recovery.png")
  const observed: Record<string, unknown> = { workId: null, threadId: null, failedState: null, recoveredState: null,
    completedQueriesBefore: null, failedQueriesBefore: null, completedQueriesAfter: null,
    businessEffectsBefore: null, businessEffectsAfter: null, receiptsBefore: null, receiptsAfter: null,
    recoveryControl: null, preservedExecutionIds: null, failureVisible: false, finalVisible: false }
  let faultActive = false
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
    const authorization = await me.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const root = { entityType: "pe_deal", entityId: dealId }
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify(root))}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await setHistoryReadPermission(false)
    faultActive = true
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    expect(submitted.status()).toBe(202)
    const accepted = await submitted.json() as { workId: string; threadId: string }
    observed.workId = accepted.workId
    observed.threadId = accepted.threadId
    type Work = { work: { status: string }; objectiveLoop?: { state: string; reason?: string };
      queryExecutions: Array<{ id: string; intent: string; status: string }>;
      businessEffects: Array<{ id: string; status: string }>;
      receipts: Array<{ id: string; finalizedAt: string | null }>;
      planRevisions: Array<{ status: string; completionProof?: { verified?: boolean } }> }
    const readWork = async (): Promise<Work> => {
      const response = await page.request.get(`/api/centropy/works/${accepted.workId}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.ok(), `Work read: ${response.status()}`).toBe(true)
      return (await response.json() as { work: Work }).work
    }
    await expect.poll(async () => {
      const work = await readWork()
      observed.failedState = { work: work.work.status, objective: work.objectiveLoop?.state, reason: work.objectiveLoop?.reason }
      return ["failed", "blocked"].includes(work.objectiveLoop?.state ?? "") || work.work.status === "failed"
    }, { timeout: 180_000, intervals: [1_000, 2_000] }).toBe(true)
    const before = await readWork()
    const completed = before.queryExecutions.filter((item) => item.status === "succeeded" && ["open_findings", "open_deal_risks"].includes(item.intent))
    const failed = before.queryExecutions.filter((item) => item.status === "failed" && item.intent === "pe_world_state")
    expect(completed.length).toBeGreaterThan(0)
    expect(failed.length).toBeGreaterThan(0)
    observed.completedQueriesBefore = completed
    observed.failedQueriesBefore = failed
    observed.businessEffectsBefore = before.businessEffects
    observed.receiptsBefore = before.receipts

    await page.goto(`/centropy/investigations/${accepted.threadId}`)
    await expect(page.getByRole("region", { name: "CENTROPY conversation" })).toBeVisible()
    await expect(page.locator(".ct-objective__top")).toContainText(/failed|blocked/, { timeout: 35_000 })
    observed.failureVisible = true
    await setHistoryReadPermission(true)
    faultActive = false
    if (before.work.status === "failed" || before.work.status === "recovery") {
      const retry = await page.request.post(`/api/centropy/works/${accepted.workId}/retry`, {
        headers: { authorization: authorization! }, data: { idempotencyKey: `controlled-canonical-outage-${accepted.workId}` }, timeout: 25_000,
      })
      expect(retry.status()).toBe(202)
      observed.recoveryControl = "work_retry"
    } else {
      const continued = await page.request.post(`/api/centropy/works/${accepted.workId}/objective`, {
        headers: { authorization: authorization! }, data: { command: "continue" }, timeout: 25_000,
      })
      expect(continued.status()).toBe(202)
      observed.recoveryControl = "objective_continue"
    }
    await expect.poll(async () => { const work = await readWork(); observed.recoveredState = { work: work.work.status, objective: work.objectiveLoop?.state }; return work.objectiveLoop?.state },
      { timeout: 160_000, intervals: [2_000, 4_000] }).toBe("completed")
    const after = await readWork()
    expect(after.work.status).toBe("completed")
    expect(after.planRevisions.some((plan) => plan.status === "completed" && plan.completionProof?.verified)).toBe(true)
    expect(after.queryExecutions.some((item) => item.status === "succeeded" && item.intent === "pe_world_state")).toBe(true)
    const afterIds = new Set(after.queryExecutions.map((item) => item.id))
    expect(completed.every((item) => afterIds.has(item.id))).toBe(true)
    expect(after.businessEffects.map((item) => item.id).sort()).toEqual(before.businessEffects.map((item) => item.id).sort())
    expect(after.receipts.map((item) => item.id).sort()).toEqual(before.receipts.map((item) => item.id).sort())
    observed.completedQueriesAfter = after.queryExecutions.filter((item) => item.status === "succeeded")
    observed.businessEffectsAfter = after.businessEffects
    observed.receiptsAfter = after.receipts
    observed.preservedExecutionIds = completed.map((item) => item.id)
    await page.reload()
    await expect(page.locator(".ct-objective__top")).toContainText("completed", { timeout: 35_000 })
    observed.finalVisible = true
  } finally {
    if (faultActive) await setHistoryReadPermission(true)
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_controlled_canonical_read_recovery",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email, input: { dealId, instruction, failure: "revoke the disposable app-role canonical history-coverage read, then restore" }, observed,
      steps: ["Authenticate owner and load Atlas Deal", "Revoke one disposable app-role canonical read and submit the whole-Deal Objective", "Observe completed sibling reads and failed PE world read plus visible failure", "Restore the read grant and use the real Work retry or Objective continue control", "Verify preserved completed query IDs, successful missing read, terminal Plan proof, and reloaded UI"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_RECOVERY_ADMIN_DATABASE_URL=postgres://<disposable-admin>@127.0.0.1:55441/finnor PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-controlled-recovery.spec.ts --project=desktop-chromium --workers=1", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas database and worker"] },
      limitation: "This controlled local outage exercises partial canonical reads. It creates no external Business Effect, so a once-only external side-effect recovery still requires a separate proof. The test never runs against a non-local database.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-controlled-recovery-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-controlled-recovery-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
