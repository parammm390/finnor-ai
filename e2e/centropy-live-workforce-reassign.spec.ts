import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

const finnorRequire = createRequire(resolve(process.cwd(), "finnor-os/package.json"))
const PgClient = finnorRequire("pg").Client as new (options: { connectionString: string }) => {
  connect(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}
const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const adminUrl = process.env.CENTROPY_RECOVERY_ADMIN_DATABASE_URL
const workerPid = Number(process.env.CENTROPY_LOCAL_WORKER_PID)
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Recheck the entire deal before IC."

test("show live Atlas specialist work and durably reassign one exact assignment", async ({ page }, testInfo) => {
  test.setTimeout(330_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !adminUrl || !/^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:55441\/finnor$/.test(adminUrl), "Guarded disposable database and owner sign-in required")
  test.skip(!Number.isSafeInteger(workerPid) || workerPid <= 1, "An explicit local disposable worker PID is required")
  const command = execFileSync("ps", ["-p", String(workerPid), "-o", "command="], { encoding: "utf8" }).trim()
  expect(command).toMatch(/node.*--import tsx apps\/worker\/src\/index\.ts/)
  const client = new PgClient({ connectionString: adminUrl! })
  const liveScreenshotPath = testInfo.outputPath("centropy-live-workforce.png")
  const terminalScreenshotPath = testInfo.outputPath("centropy-reassigned-workforce.png")
  await awaitFixtureRateWindow(testInfo)
  const proofPath = testInfo.outputPath("centropy-live-workforce-reassign.proof.json")
  const observed: Record<string, unknown> = { workId: null, threadId: null, pausedAssignment: null,
    liveVisible: false, reassignmentResponse: null, reassignedAssignment: null,
    successorAssignment: null, terminal: null, liveScreenshotSha256: null }
  let paused = false
  let connected = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  try {
    await client.connect(); connected = true
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
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    expect(submitted.status()).toBe(202)
    const accepted = await submitted.json() as { workId: string; threadId: string }
    observed.workId = accepted.workId; observed.threadId = accepted.threadId

    const deadline = Date.now() + 150_000
    let active: Record<string, unknown> | undefined
    while (Date.now() < deadline && !active) {
      const result = await client.query(
        "SELECT id::text, state, capability, plan_node_id, created_at::text FROM finnor_os.workforce_assignments WHERE work_id=$1::uuid AND state IN ('queued','claimed','running','waiting') ORDER BY created_at LIMIT 1",
        [accepted.workId],
      )
      active = result.rows[0]
      if (!active) await new Promise((resolve) => setTimeout(resolve, 60))
    }
    expect(active, "a real active specialist assignment must be persisted").toBeDefined()
    process.kill(workerPid, "SIGSTOP"); paused = true
    watchdog = setTimeout(() => { if (paused) { process.kill(workerPid, "SIGCONT"); paused = false } }, 60_000)
    observed.pausedAssignment = active

    const toggle = page.getByRole("button", { name: "Inspect specialist assignments" })
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    await toggle.click()
    const workforce = page.getByRole("region", { name: "Persisted specialist assignments" })
    const assignmentRow = workforce.locator("li").filter({ hasText: String(active!.plan_node_id) })
    await expect(assignmentRow).toHaveCount(1, { timeout: 20_000 })
    await expect(assignmentRow).toContainText(String(active!.capability))
    await expect(assignmentRow).toContainText(/queued|claimed|running|waiting/)
    await expect(assignmentRow.getByRole("button", { name: "Reassign specialist" })).toBeVisible()
    observed.liveVisible = true
    const liveScreenshot = await page.screenshot({ path: liveScreenshotPath, fullPage: true, animations: "disabled" })
    observed.liveScreenshotSha256 = createHash("sha256").update(liveScreenshot).digest("hex")
    await assignmentRow.getByRole("button", { name: "Reassign specialist" }).click()
    const reassignPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/workforce/assignments/${active!.id}/reassign`, { timeout: 30_000 })
    await assignmentRow.getByRole("button", { name: "Confirm reassignment" }).click()
    const reassignedResponse = await reassignPromise
    expect(reassignedResponse.status(), await reassignedResponse.text()).toBe(200)
    const reassigned = await reassignedResponse.json() as { assignment: { id: string; state: string; reassignmentReason: string } }
    expect(reassigned.assignment).toMatchObject({ id: active!.id, state: "reassigned", reassignmentReason: "OPERATOR_REQUESTED" })
    observed.reassignmentResponse = reassigned.assignment
    if (paused) { process.kill(workerPid, "SIGCONT"); paused = false }
    if (watchdog) { clearTimeout(watchdog); watchdog = null }

    const readWork = async () => {
      const response = await page.request.get(`/api/centropy/works/${accepted.workId}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.ok(), `Work read: ${response.status()}`).toBe(true)
      return (await response.json() as { work: { work: { status: string }; objectiveLoop?: { state: string };
        workforceAssignments: Array<{ id: string; state: string; previousAssignmentId: string | null; reassignmentReason: string | null; planNodeId: string }>;
        planRevisions: Array<{ status: string; completionProof?: { verified: boolean } }> } }).work
    }
    await expect.poll(async () => (await readWork()).objectiveLoop?.state, { timeout: 140_000, intervals: [2_000, 4_000] }).toBe("completed")
    const terminal = await readWork()
    expect(terminal.work.status).toBe("completed")
    expect(terminal.planRevisions.some((item) => item.status === "completed" && item.completionProof?.verified)).toBe(true)
    const original = terminal.workforceAssignments.find((item) => item.id === active!.id)
    const successor = terminal.workforceAssignments.find((item) => item.previousAssignmentId === active!.id)
    expect(original).toMatchObject({ state: "reassigned", reassignmentReason: "OPERATOR_REQUESTED" })
    expect(successor).toBeDefined()
    observed.reassignedAssignment = original
    observed.successorAssignment = successor
    observed.terminal = { work: terminal.work.status, objective: terminal.objectiveLoop?.state, verifiedPlan: true }
    await page.reload()
    await expect(page.locator(".ct-objective__top")).toContainText("completed", { timeout: 35_000 })
  } finally {
    if (paused) process.kill(workerPid, "SIGCONT")
    if (watchdog) clearTimeout(watchdog)
    if (connected) await client.end()
    const screenshot = await page.screenshot({ path: terminalScreenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_live_workforce_reassignment",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email, input: { dealId, instruction, faultControl: "briefly suspend only the named disposable worker after a persisted active assignment appears" }, observed,
      steps: ["Authenticate owner and submit exact whole-Deal recheck", "Observe a persisted active specialist assignment and briefly suspend the disposable worker", "Inspect live assignment in Thread and capture screenshot", "Use the human reassignment control against the exact assignment", "Resume worker; verify immutable reassignment, successor assignment, terminal Plan proof and reload"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_LOCAL_WORKER_PID=<disposable-worker-pid> CENTROPY_RECOVERY_ADMIN_DATABASE_URL=postgres://<disposable-admin>@127.0.0.1:55441/finnor PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-live-workforce-reassign.spec.ts --project=desktop-chromium --workers=1", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas database and worker"] },
      limitation: "Local disposable worker suspension exposes the real persisted active assignment long enough for browser verification; release-host timing and operator reassignment remain separate gates.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-live-workforce-reassign-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-reassigned-workforce-screenshot", { path: terminalScreenshotPath, contentType: "image/png" })
  }
})
