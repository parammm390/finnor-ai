import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const expectedActions = [
  "create_underwriting_run", "open_ic_case", "begin_ic_preparation", "create_ic_memo_draft",
  "select_ic_memo_version", "prepare_ic_recommendation", "request_ic_memo_review",
]

test("Atlas IC Work completes with an exact verified review citation", async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId, "Owner credentials and the prepared Atlas Work are required")
  const proofPath = testInfo.outputPath("centropy-ic-terminal-completion.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-ic-terminal-completion.png")
  const resultScreenshotPath = testInfo.outputPath("centropy-ic-verified-result.png")
  const observed: Record<string, unknown> = { workId, beforeState: null, afterState: null, workStatus: null, caseId: null,
    threadId: null, reviewEffectId: null, evidenceRefs: null, actionIds: null, effectStatuses: null, receiptCount: null,
    planCompletionProof: null, reloadState: null, restoredResult: null, restoredIcCaseRead: null, controlResponse: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await mePromise
    expect(meResponse.status()).toBe(200)
    const me = await meResponse.json() as { tenantId?: string; role?: string }
    expect(me).toMatchObject({ tenantId, role: "owner" })
    const authorization = await meResponse.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const headers = { authorization: authorization! }
    type Action = { id: string; actionType: string; status: string }
    type Effect = { id: string; domainActionId: string; status: string; verification?: { state?: string }; observedResult?: { entity?: { entityType?: string; entityId?: string }; canonicalState?: { id?: string; dealId?: string } } }
    type Aggregate = {
      work: { status: string; finalOutcome?: { response?: { threadId?: string } } }
      objectiveLoop?: { state: string; reason?: string; successVerification?: {
        state?: string; evidence?: Array<{ kind: string; businessEffectId?: string }>;
        results?: Array<{ kind: string; satisfied: boolean; evidenceRefs?: Array<{ type: string; id: string }> }>
      } }
      actions: Action[]; businessEffects: Effect[]
      receipts: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>
      planRevisions: Array<{ status: string; completionProof?: { verified?: boolean; evidenceRefs?: Array<{ type: string; id: string }> } }>
    }
    const readWork = async (): Promise<Aggregate> => {
      const response = await page.request.get(`/api/centropy/works/${workId}`, { headers, timeout: 30_000 })
      expect(response.ok(), `Work read: ${response.status()} ${await response.text()}`).toBe(true)
      return (await response.json() as { work: Aggregate }).work
    }
    const before = await readWork()
    const actions = before.actions.filter((action) => expectedActions.includes(action.actionType))
    expect(actions.map((action) => action.actionType)).toEqual(expectedActions)
    expect(actions.every((action) => action.status === "completed")).toBe(true)
    const actionIds = actions.map((action) => action.id).sort()
    const review = actions.find((action) => action.actionType === "request_ic_memo_review")!
    const reviewEffect = before.businessEffects.find((effect) => effect.domainActionId === review.id)
    expect(reviewEffect).toMatchObject({ status: "verified", verification: { state: "verified" } })
    expect(before.businessEffects.filter((effect) => actionIds.includes(effect.domainActionId)).length).toBe(7)
    expect(before.businessEffects.filter((effect) => actionIds.includes(effect.domainActionId)).every((effect) => effect.status === "verified")).toBe(true)
    expect(before.receipts.filter((receipt) => actionIds.includes(receipt.domainActionId ?? "") && receipt.finalizedAt && !receipt.failure).length).toBe(7)
    observed.beforeState = before.objectiveLoop?.state ?? null
    observed.reviewEffectId = reviewEffect?.id ?? null
    observed.actionIds = actionIds
    const openCaseAction = actions.find((action) => action.actionType === "open_ic_case")!
    const openCaseEffect = before.businessEffects.find((effect) => effect.domainActionId === openCaseAction.id)
    expect(openCaseEffect?.observedResult?.entity?.entityType).toBe("pe_ic_case")
    expect(openCaseEffect?.observedResult?.canonicalState?.dealId).toBe(dealId)
    observed.caseId = openCaseEffect?.observedResult?.entity?.entityId ?? null
    observed.threadId = process.env.CENTROPY_THREAD_ID ?? before.work.finalOutcome?.response?.threadId ?? null
    expect(observed.caseId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(observed.threadId).toMatch(/^[0-9a-f-]{36}$/i)
    const caseId = String(observed.caseId)
    const readCase = async () => {
      const response = await page.request.get(`/api/centropy/private-equity/ic/cases/${caseId}`, { headers, timeout: 30_000 })
      expect(response.ok(), `IC case read: ${response.status()} ${await response.text()}`).toBe(true)
      return (await response.json() as { case: { state: string; currentMemoId: string; currentRecommendationId: string } }).case
    }
    const icCase = await readCase()
    expect(icCase.state).toBe("READY_FOR_REVIEW")
    expect(icCase.currentMemoId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(icCase.currentRecommendationId).toMatch(/^[0-9a-f-]{36}$/i)
    if (before.objectiveLoop?.state !== "completed") {
      expect(["continue", "blocked"]).toContain(before.objectiveLoop?.state)
      const response = await page.request.post(`/api/centropy/works/${workId}/objective`, { headers, data: { command: "continue" }, timeout: 30_000 })
      observed.controlResponse = response.status()
      expect(response.status(), `Governed continue: ${await response.text()}`).toBe(202)
    }
    await expect.poll(async () => {
      const current = await readWork().catch(() => null)
      observed.afterState = current?.objectiveLoop?.state ?? null
      observed.workStatus = current?.work.status ?? null
      if (["blocked", "failed"].includes(current?.objectiveLoop?.state ?? "")) {
        throw new Error(`Objective stopped: ${current?.objectiveLoop?.reason ?? "no reason"}`)
      }
      return current?.objectiveLoop?.state ?? null
    }, { timeout: 240_000, intervals: [1_000, 2_000, 4_000] }).toBe("completed")
    const after = await readWork()
    expect(after.work.status).toBe("completed")
    expect(after.actions.map((action) => action.id).sort()).toEqual(actionIds)
    expect(after.businessEffects.every((effect) => effect.status === "verified")).toBe(true)
    expect(after.receipts.filter((receipt) => receipt.finalizedAt && !receipt.failure).length).toBe(7)
    expect(after.objectiveLoop?.successVerification?.state).toBe("verified")
    expect(after.objectiveLoop?.successVerification?.evidence?.some((item) =>
      item.kind === "business_effect" && item.businessEffectId === reviewEffect?.id)).toBe(true)
    const decisionEvidence = after.objectiveLoop?.successVerification?.results?.find((result) => result.kind === "decision_evidence")
    expect(decisionEvidence?.satisfied).toBe(true)
    const refs = decisionEvidence?.evidenceRefs ?? []
    expect(refs.some((ref) => ref.type === "business_effect" && ref.id === reviewEffect?.id)).toBe(true)
    const completedPlan = after.planRevisions.find((plan) => plan.status === "completed")
    expect(completedPlan?.completionProof?.verified).toBe(true)
    expect(completedPlan?.completionProof?.evidenceRefs?.some((ref) => ref.type === "business_effect" && ref.id === reviewEffect?.id)).toBe(true)
    observed.evidenceRefs = refs
    observed.effectStatuses = after.businessEffects.map((effect) => ({ id: effect.id, status: effect.status }))
    observed.receiptCount = after.receipts.filter((receipt) => receipt.finalizedAt && !receipt.failure).length
    observed.planCompletionProof = completedPlan?.completionProof ?? null
    const restoredIcReads: string[] = []
    page.on("response", (response) => {
      if (response.request().method() === "GET" && new URL(response.url()).pathname.includes("/private-equity/ic/cases/")) restoredIcReads.push(new URL(response.url()).pathname)
    })
    await page.goto(`/centropy/investigations/${observed.threadId}`)
    await page.reload()
    const verifiedResult = page.getByRole("region", { name: "Verified Objective result" })
    await expect(verifiedResult.getByRole("heading", { name: "IC preparation completed" })).toBeVisible({ timeout: 30_000 })
    await expect(verifiedResult.getByText("IC case · READY FOR REVIEW")).toBeVisible({ timeout: 30_000 })
    await expect(verifiedResult.getByText("Current recommendation: continue diligence.")).toBeVisible()
    await expect(verifiedResult.getByText("Selected memo is recorded on this IC case.")).toBeVisible()
    await expect.poll(() => restoredIcReads.some((url) => url.endsWith(`/private-equity/ic/cases/${caseId}`))).toBe(true)
    observed.restoredResult = await verifiedResult.innerText()
    observed.restoredIcCaseRead = caseId
    const restored = await readCase()
    expect(restored).toMatchObject(icCase)
    observed.reloadState = restored.state
  } finally {
    const resultScreenshot = await page.getByRole("region", { name: "Verified Objective result" }).screenshot({ path: resultScreenshotPath, animations: "disabled" }).catch(() => null)
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_ic_terminal_completion", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, dealId, threadId: observed.threadId, disposableFixture: true }, observed,
      steps: ["Sign in as the fixture owner", "Verify seven completed actions, exact Business Effects, finalized receipts, and READY_FOR_REVIEW IC case",
        "Governedly continue the same Work if it has not completed", "Wait for completed Objective and Work", "Verify the completion proof cites the exact review Business Effect",
        "Verify no duplicate actions", "Reopen the Investigation without an IC case URL override, reload it, and observe the final verified result, recommendation, memo, and exact Work-linked case"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      resultScreenshotSha256: resultScreenshot ? createHash("sha256").update(resultScreenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<prepared disposable Atlas Work> CENTROPY_THREAD_ID=<persisted investigation thread> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-ic-terminal-completion.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "local frontend, API, worker, and disposable DB fixture"] },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-ic-terminal-completion-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-ic-terminal-completion-screenshot", { path: screenshotPath, contentType: "image/png" })
    if (resultScreenshot) await testInfo.attach("centropy-ic-verified-result-screenshot", { path: resultScreenshotPath, contentType: "image/png" })
  }
})
