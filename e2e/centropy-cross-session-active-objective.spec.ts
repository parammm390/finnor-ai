import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test, type Browser, type Page } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Take growth down 300bps and exit at 9x."

async function signIn(page: Page): Promise<string> {
  await page.goto("/centropy/login")
  await page.getByLabel("Email").fill(email!)
  await page.getByLabel("Password").fill(password!)
  const mePromise = page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/centropy/me")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const response = await mePromise
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
  const authorization = await response.request().headerValue("authorization")
  expect(authorization).toMatch(/^Bearer /)
  return authorization!
}

async function read<T>(page: Page, authorization: string, path: string): Promise<T> {
  const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization }, timeout: 25_000 })
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true)
  return await response.json() as T
}

type Work = { work: { id: string; status: string }; objectiveLoop?: { id: string; state: string; revision: number };
  actions: Array<{ id: string; actionType: string; status: string; payload: { baseRunId?: string } }>;
  planRevisions: Array<{ id: string; status: string }>; workforceAssignments: Array<{ id: string; state: string; capability: string }> }
type Thread = { thread: { id: string; activeWorkId: string | null; activeObjectiveLoopId: string | null };
  messages: Array<{ id: string; role: string; instructionId: string | null; workId: string | null }> }

function durableIdentity(work: Work, thread: Thread) {
  return {
    workId: work.work.id, objectiveLoopId: work.objectiveLoop?.id ?? null,
    actionIds: work.actions.map((item) => item.id).sort(),
    planIds: work.planRevisions.map((item) => item.id).sort(),
    assignmentIds: work.workforceAssignments.map((item) => item.id).sort(),
    userTurns: thread.messages.filter((item) => item.role === "user" && item.workId === work.work.id)
      .map((item) => ({ id: item.id, instructionId: item.instructionId })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

test("active Atlas Objective and approval restore in a new authenticated browser session", async ({ browser }: { browser: Browser }, testInfo) => {
  test.setTimeout(240_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password, "Owner sign-in is required")
  const proofPath = testInfo.outputPath("centropy-cross-session-active-objective.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-cross-session-active-objective.png")
  const observed: Record<string, unknown> = { workId: null, threadId: null, instructionId: null, actionId: null,
    baseRunId: null, beforeIdentity: null, afterRefreshIdentity: null, afterNewSessionIdentity: null,
    firstContextClosed: false, secondContextHadNoCookies: false, sameIdentityAfterRefresh: false,
    sameIdentityAfterNewSession: false, pendingEffectRestored: false, canvasRestored: false, workforceRestored: false,
    noDuplicateWorkOrAction: false }
  const first = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } })
  let second: Awaited<ReturnType<Browser["newContext"]>> | null = null
  let screenshotPage: Page | null = null
  try {
    const page = await first.newPage()
    screenshotPage = page
    const authorization = await signIn(page)
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submittedPromise = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submittedPromise
    expect(submitted.status()).toBe(202)
    const accepted = await submitted.json() as { workId: string; threadId: string; objective?: { objectiveLoopId: string } }
    observed.workId = accepted.workId
    observed.threadId = accepted.threadId
    const readWork = (target: Page, auth: string) => read<{ work: Work }>(target, auth, `works/${accepted.workId}`).then((result) => result.work)
    await expect.poll(async () => {
      const work = await readWork(page, authorization)
      return work.objectiveLoop?.state === "awaiting_approval"
        && work.actions.some((item) => item.actionType === "create_underwriting_run" && item.status === "pending")
    }, { timeout: 110_000, intervals: [3_000, 5_000] }).toBe(true)
    const before = await readWork(page, authorization)
    const action = before.actions.find((item) => item.actionType === "create_underwriting_run" && item.status === "pending")!
    observed.actionId = action.id
    observed.baseRunId = action.payload.baseRunId ?? null
    expect(action.payload.baseRunId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(before.objectiveLoop?.id).toBe(accepted.objective?.objectiveLoopId)
    const firstThread = await read<Thread>(page, authorization, `threads/${accepted.threadId}?limit=100`)
    const beforeIdentity = durableIdentity(before, firstThread)
    observed.beforeIdentity = beforeIdentity
    expect(firstThread.thread).toMatchObject({ id: accepted.threadId, activeWorkId: accepted.workId, activeObjectiveLoopId: before.objectiveLoop?.id })
    expect(beforeIdentity.userTurns).toHaveLength(1)
    observed.instructionId = beforeIdentity.userTurns[0]!.instructionId
    expect(observed.instructionId).toMatch(/^[0-9a-f-]{36}$/i)

    await page.goto(`/centropy/investigations/${accepted.threadId}`)
    await expect(page.getByRole("region", { name: "Pending governed effects" })).toBeVisible({ timeout: 35_000 })
    await expect(page.getByRole("main", { name: "Investigation Canvas" })).toContainText("Underwriting model", { timeout: 35_000 })
    await page.reload()
    await expect(page.locator(".ct-objective__top")).toContainText("awaiting approval", { timeout: 35_000 })
    const afterRefresh = await readWork(page, authorization)
    const threadAfterRefresh = await read<Thread>(page, authorization, `threads/${accepted.threadId}?limit=100`)
    observed.afterRefreshIdentity = durableIdentity(afterRefresh, threadAfterRefresh)
    expect(observed.afterRefreshIdentity).toEqual(beforeIdentity)
    observed.sameIdentityAfterRefresh = true

    await first.close()
    observed.firstContextClosed = true
    second = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } })
    observed.secondContextHadNoCookies = (await second.storageState()).cookies.length === 0
    expect(observed.secondContextHadNoCookies).toBe(true)
    const reopened = await second.newPage()
    screenshotPage = reopened
    const secondAuthorization = await signIn(reopened)
    await reopened.goto(`/centropy/investigations/${accepted.threadId}`)
    const pending = reopened.getByRole("region", { name: "Pending governed effects" })
    await expect(pending.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 35_000 })
    await pending.getByRole("button", { name: "Review exact effect" }).click()
    await expect(pending).toContainText(action.id.slice(0, 8))
    observed.pendingEffectRestored = true
    await expect(reopened.locator(".ct-objective__top")).toContainText("awaiting approval", { timeout: 35_000 })
    await expect(reopened.getByRole("main", { name: "Investigation Canvas" })).toContainText("Underwriting model", { timeout: 35_000 })
    await expect(reopened.getByRole("main", { name: "Investigation Canvas" })).toContainText("Final outcome pending")
    observed.canvasRestored = true
    await reopened.getByRole("button", { name: "Inspect specialist assignments" }).click()
    const workforce = reopened.getByRole("region", { name: "Persisted specialist assignments" })
    await expect(workforce).toContainText("Underwriting Analyst", { timeout: 35_000 })
    await expect(workforce).toContainText("create underwriting run")
    observed.workforceRestored = true
    const after = await readWork(reopened, secondAuthorization)
    const threadAfter = await read<Thread>(reopened, secondAuthorization, `threads/${accepted.threadId}?limit=100`)
    observed.afterNewSessionIdentity = durableIdentity(after, threadAfter)
    expect(observed.afterNewSessionIdentity).toEqual(beforeIdentity)
    expect(after.work.status).toBe("awaiting_approval")
    observed.sameIdentityAfterNewSession = true
    observed.noDuplicateWorkOrAction = after.actions.length === 1 && threadAfter.messages.filter((item) => item.role === "user" && item.workId === accepted.workId).length === 1
    expect(observed.noDuplicateWorkOrAction).toBe(true)
  } finally {
    const screenshot = screenshotPage && !screenshotPage.isClosed()
      ? await screenshotPage.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null) : null
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_active_objective_cross_session",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email, input: { dealId, instruction, separateBrowserContexts: true }, observed,
      steps: ["Authenticate and submit one Deal-scoped Objective", "Wait for the real Underwriting Analyst assignment and exact pending action",
        "Record durable Thread, instruction, Work, Objective, Plan, assignment, and action IDs", "Refresh the first browser while approval is pending and compare identities",
        "Close the first browser context", "Start a new cookie-free context, authenticate again, and open the persisted Investigation without a root URL override",
        "Verify the same pending Effect, Objective, Canvas, specialist assignment, and all IDs without a duplicate"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-cross-session-active-objective.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas growth model and local stack"] },
      limitation: "Local fixture proof. It leaves the exact Effect pending for governed approval; release-host and separate-machine continuity remain open.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-cross-session-active-objective-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-cross-session-active-objective-screenshot", { path: screenshotPath, contentType: "image/png" })
    await second?.close()
    await first.close()
  }
})
