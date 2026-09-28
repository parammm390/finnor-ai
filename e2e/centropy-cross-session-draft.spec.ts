import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test, type Browser, type Page } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_DECK_WORK_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function signIn(page: Page): Promise<string> {
  await page.goto("/centropy/login")
  await page.getByLabel("Email").fill(email!)
  await page.getByLabel("Password").fill(password!)
  const mePromise = page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/centropy/me")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const response = await mePromise
  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ tenantId, role: "owner" })
  const authorization = await response.request().headerValue("authorization")
  expect(authorization).toMatch(/^Bearer /)
  return authorization!
}

async function read<T>(page: Page, authorization: string, path: string): Promise<T> {
  const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization }, timeout: 20_000 })
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true)
  return await response.json() as T
}

type Work = {
  work: { id: string; status: string; finalOutcome?: { response?: { threadId?: string } } };
  objectiveLoop?: { id: string };
  actions: Array<{ id: string; actionType: string; status: string }>;
  businessEffects: Array<{ id: string; domainActionId: string | null; status: string; observedResult?: { entity?: { entityType?: string }; canonicalState?: { dealId?: string; entityId?: string; documentId?: string; documentVersionId?: string; draftKind?: string } } }>;
  receipts: Array<{ id: string; domainActionId: string | null; finalizedAt: string | null; failure: unknown }>;
}
type Thread = { thread: { id: string; activeWorkId: string | null; activeObjectiveLoopId: string | null }; messages: Array<{ id: string; role: string; instructionId: string | null; workId: string | null }> }

function identity(work: Work, thread: Thread) {
  return {
    objectiveLoopId: work.objectiveLoop?.id ?? null,
    actionIds: work.actions.map((item) => item.id).sort(),
    effectIds: work.businessEffects.map((item) => item.id).sort(),
    receiptIds: work.receipts.map((item) => item.id).sort(),
    userTurns: thread.messages.filter((item) => item.role === "user" && item.workId === work.work.id)
      .map((item) => ({ id: item.id, instructionId: item.instructionId })).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

test("an IC draft and its Work reopen in a separate authenticated browser session", async ({ browser }: { browser: Browser }, testInfo) => {
  test.setTimeout(180_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId || !UUID.test(workId), "Owner credentials and a completed deck Work are required")
  const proofPath = testInfo.outputPath("centropy-cross-session-draft.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-cross-session-draft.png")
  const observed: Record<string, unknown> = { workId, threadId: null, actionId: null, documentId: null, versionId: null,
    firstSessionClosed: false, secondSessionHadNoCookies: false, sameIdentity: false, canvasDraftVisible: false,
    exactSlidesVisible: false, overflowPx: null, firstWorkStatus: null, secondWorkStatus: null }
  let first = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: baseUrl })
  let second: Awaited<ReturnType<Browser["newContext"]>> | null = null
  let screenshotPage: Page | null = null
  try {
    const firstPage = await first.newPage()
    screenshotPage = firstPage
    const firstAuth = await signIn(firstPage)
    const before = (await read<{ work: Work }>(firstPage, firstAuth, `works/${workId}`)).work
    expect(before.work.id).toBe(workId)
    const threadId = before.work.finalOutcome?.response?.threadId
    expect(threadId).toMatch(UUID)
    observed.threadId = threadId
    const action = before.actions.find((item) => item.actionType === "create_ic_deck_draft" && item.status === "completed")
    const effect = before.businessEffects.find((item) => item.domainActionId === action?.id && item.status === "verified")
    const receipt = before.receipts.find((item) => item.domainActionId === action?.id && item.finalizedAt && !item.failure)
    expect(action?.id).toMatch(UUID)
    expect(effect?.observedResult?.entity?.entityType).toBe("pe_document_link")
    expect(receipt).toBeTruthy()
    const link = effect!.observedResult!.canonicalState!
    expect(link).toMatchObject({ dealId, draftKind: "IC_DECK_DRAFT" })
    expect(link.entityId).toMatch(UUID)
    expect(link.documentId).toMatch(UUID)
    expect(link.documentVersionId).toMatch(UUID)
    observed.actionId = action!.id
    observed.documentId = link.documentId
    observed.versionId = link.documentVersionId
    observed.firstWorkStatus = before.work.status
    const firstThread = await read<Thread>(firstPage, firstAuth, `threads/${threadId}?limit=100`)
    expect(firstThread.thread.id).toBe(threadId)
    const beforeIdentity = identity(before, firstThread)
    expect(beforeIdentity.userTurns).toHaveLength(1)

    await first.close()
    observed.firstSessionClosed = true
    second = await browser.newContext({ viewport: { width: 1440, height: 1000 }, baseURL: baseUrl })
    observed.secondSessionHadNoCookies = (await second.storageState()).cookies.length === 0
    expect(observed.secondSessionHadNoCookies).toBe(true)
    const reopened = await second.newPage()
    screenshotPage = reopened
    const secondAuth = await signIn(reopened)
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await reopened.goto(`/centropy/investigations/${threadId}?root=${root}`)
    const card = reopened.getByLabel("Work-created IC deck draft")
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText(String(link.documentId))
    await expect(card).toContainText(String(link.documentVersionId))
    observed.canvasDraftVisible = true
    await card.getByRole("button", { name: "Open Work draft" }).click()
    await expect(reopened.getByRole("heading", { name: "Presentation slides" })).toBeVisible({ timeout: 30_000 })
    await expect(reopened.locator(".ct-artifact__intro")).toContainText(`Document ${link.documentId} · version ${link.documentVersionId}`)
    observed.exactSlidesVisible = true
    await reopened.getByRole("button", { name: "Back to Investigation Canvas" }).click()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.scrollIntoViewIfNeeded()
    const after = (await read<{ work: Work }>(reopened, secondAuth, `works/${workId}`)).work
    const secondThread = await read<Thread>(reopened, secondAuth, `threads/${threadId}?limit=100`)
    expect(identity(after, secondThread)).toEqual(beforeIdentity)
    observed.sameIdentity = true
    observed.secondWorkStatus = after.work.status
    const overflow = await reopened.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    observed.overflowPx = overflow
  } finally {
    const screenshot = screenshotPage && !screenshotPage.isClosed()
      ? await screenshotPage.screenshot({ path: screenshotPath, animations: "disabled" }).catch(() => null) : null
    const proof = { schema: "finnor.centropy.e2e-proof/v1", flow: "ic_deck_cross_session", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, dealId, separateBrowserContexts: true }, observed,
      steps: ["Sign in and record the exact Work, Objective, action, effect, receipt, and user turn identities", "Close the first browser context", "Open a new context with no cookies and sign in as the same owner", "Open the Investigation from its saved URL without an IC case override", "Open the exact Work-created PPTX version and compare durable IDs without creating new records"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: `CENTROPY_DISPOSABLE_E2E=1 CENTROPY_DECK_WORK_ID=${workId} PLAYWRIGHT_BASE_URL=${baseUrl} npx playwright test e2e/centropy-cross-session-draft.spec.ts --project=${testInfo.project.name}`, requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "the recorded disposable Work and Artifact fixture"] } }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-cross-session-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-cross-session-screenshot", { path: screenshotPath, contentType: "image/png" })
    await second?.close()
    await first.close()
  }
})
