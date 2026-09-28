import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { chromium, expect, test, type Page } from "@playwright/test"

const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Challenge Atlas's revenue assumptions and prepare tomorrow's IC case."
const resumeWorkId = process.env.CENTROPY_RESUME_WORK_ID
const resumeThreadId = process.env.CENTROPY_RESUME_THREAD_ID
const sequence = resumeWorkId ? ["create_underwriting_run", "select_ic_underwriting_run", "create_ic_memo_draft",
  "select_ic_memo_version", "prepare_ic_recommendation", "request_ic_memo_review"] : ["create_underwriting_run", "open_ic_case", "begin_ic_preparation", "create_ic_memo_draft",
  "select_ic_memo_version", "prepare_ic_recommendation", "request_ic_memo_review"]
type Action = { id: string; actionType: string; status: string; payload: Record<string, unknown> }
type Effect = { id: string; domainActionId: string; status: string; verification?: { state: string };
  observedResult?: { entity?: { entityId: string; entityType: string }; canonicalState?: Record<string, unknown> } }
type Work = { work: { id: string; status: string }; objectiveLoop?: { id: string; state: string; reason?: string; successVerification?: { state: string } };
  actions: Action[]; businessEffects: Effect[]; receipts: Array<{ id: string; domainActionId: string; finalizedAt: string | null; failure: unknown }>;
  planRevisions: Array<{ id: string; status: string; completionProof?: { verified: boolean; evidenceRefs: Array<{ type: string; id: string }> } }>;
  workforceAssignments: Array<{ id: string; state: string; capability: string; agentProfileId: string }>;
  queryExecutions: Array<{ id: string; intent: string; status: string }> }
type Thread = { thread: { id: string; activeWorkId: string | null }; messages: Array<{ id: string; role: string; originalText: string; instructionId: string | null; workId: string | null }> }

// Failure modes: ephemeral conversation, duplicate intake on refresh/reopen,
// wrong Deal/model basis, ungoverned effects, unsourced memo, invented recommendation,
// unfinished Objective labeled successful, missing receipt/proof, stale Canvas.
test("one Atlas instruction completes sourced IC preparation and restores across closed browsers", async ({}, testInfo) => {
  test.setTimeout(780_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Explicit disposable localhost fixture only")
  expect(process.env.TEST_OWNER_EMAIL, "Fixture owner email").toBeTruthy()
  expect(process.env.TEST_OWNER_PASSWORD, "Fixture owner password").toBeTruthy()
  let browser = await chromium.launch()
  let page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } })
  let headers: Record<string, string> = {}
  const observed: Record<string, unknown> = { actionApprovals: [], readBackoffs: [], activeRestoration: null, completed: null }
  const steps: string[] = []
  const signIn = async (target: Page) => {
    await target.goto("/centropy/login")
    await target.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await target.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const response = target.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET", { timeout: 45_000 })
    await target.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await response
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
    headers = { authorization: (await me.request().headerValue("authorization"))! }
    expect(headers.authorization).toMatch(/^Bearer /)
    await expect(target.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible({ timeout: 30_000 })
  }
  const get = async <T,>(path: string): Promise<T> => {
    let response = await page.request.get(`/api/centropy/${path}`, { headers, timeout: 30_000 })
    if (response.status() === 429) {
      const seconds = Number(response.headers()["retry-after"])
      expect(Number.isFinite(seconds) && seconds > 0 && seconds <= 60, "Canonical bounded Retry-After").toBe(true)
      ;(observed.readBackoffs as unknown[]).push({ path, seconds, status: 429 })
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      response = await page.request.get(`/api/centropy/${path}`, { headers, timeout: 30_000 })
    }
    expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
    return await response.json() as T
  }
  let workId = "", threadId = ""
  let terminalRestoration = false, verified = false
  const work = async () => (await get<{ work: Work }>(`works/${workId}`)).work
  const identity = async () => {
    const [w, t] = await Promise.all([work(), get<Thread>(`threads/${threadId}?limit=100`)])
    return { workId: w.work.id, objectiveId: w.objectiveLoop?.id, state: w.objectiveLoop?.state,
      actionIds: w.actions.map((a) => a.id).sort(), assignmentIds: w.workforceAssignments.map((a) => a.id).sort(),
      planIds: w.planRevisions.map((p) => p.id).sort(), userTurns: t.messages.filter((m) => m.role === "user").map((m) => ({ id: m.id, instructionId: m.instructionId, workId: m.workId })) }
  }
  try {
    await signIn(page)
    steps.push("Authenticate owner through the real Supabase sign-in form")
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 30_000 })
    if (resumeWorkId) {
      expect(resumeThreadId).toBeTruthy()
      workId = resumeWorkId; threadId = resumeThreadId!
      const existing = await work()
      terminalRestoration = existing.objectiveLoop?.state === "completed"
      observed.intake = { workId, threadId, objectiveId: existing.objectiveLoop?.id, restoredExistingInstruction: true }
      if (existing.work.status === "failed") {
        await page.goto(`/centropy/investigations/${threadId}`)
        const recovery = page.getByRole("region", { name: "Work recovery", exact: true })
        await recovery.getByRole("button", { name: "Review retry", exact: true }).click({ timeout: 30_000 })
        const retried = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/works/${workId}/retry` && r.request().method() === "POST", { timeout: 30_000 })
        await recovery.getByRole("button", { name: "Retry Work", exact: true }).click({ timeout: 30_000 })
        expect((await retried).status()).toBe(202)
        steps.push("Review and claim recovery of the exact failed Work through its actual retry control; resume its same Objective")
      } else if (["blocked", "failed"].includes(existing.objectiveLoop?.state ?? "")) {
        await page.goto(`/centropy/investigations/${threadId}`)
        const continued = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/works/${workId}/objective` && r.request().method() === "POST", { timeout: 30_000 })
        await page.getByRole("region", { name: "Durable Objective controls", exact: true }).getByRole("button", { name: "Continue", exact: true }).click({ timeout: 30_000 })
        expect((await continued).status()).toBe(202)
        steps.push("Continue the recorded blocked Objective through its actual human control after the planner correction")
      }
      steps.push("Restore the one previously submitted Atlas instruction without creating a new Work or user turn")
    } else {
      await page.getByLabel("Message CENTROPY").fill(instruction)
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions" && r.request().method() === "POST", { timeout: 60_000 })
      await page.getByRole("button", { name: "Send instruction" }).click()
      const accepted = await response
      expect(accepted.status(), await accepted.text()).toBe(202)
      const intake = await accepted.json() as { workId: string; threadId: string; instructionId?: string; objective?: { objectiveLoopId: string } }
      workId = intake.workId; threadId = intake.threadId
      expect(intake.objective?.objectiveLoopId).toMatch(/^[0-9a-f-]{36}$/i)
      observed.intake = intake
      steps.push("Submit exactly one Atlas revenue/IC instruction and record the backend Work, Thread, instruction, and Objective IDs")
    }
    if (!terminalRestoration) await expect.poll(async () => {
      const w = await work()
      if (["blocked", "failed"].includes(w.objectiveLoop?.state ?? "")) throw new Error(`Objective stopped: ${w.objectiveLoop?.reason}`)
      return w.actions.some((a) => (resumeWorkId ? sequence.includes(a.actionType) : a.actionType === sequence[0]) && a.status === "pending")
    }, { timeout: 160_000, intervals: [2000, 4000] }).toBe(true)
    const before = await identity()
    expect(before.userTurns).toHaveLength(1)
    expect(before.state).toBe(terminalRestoration ? "completed" : "awaiting_approval")
    await page.goto(`/centropy/investigations/${threadId}`)
    await page.reload()
    if (!terminalRestoration) await expect(page.locator(".ct-effects").getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
    const refreshed = await identity()
    expect(refreshed).toEqual(before)
    await expect(page.getByRole("button", { name: "Open scenario laboratory" })).toBeVisible({ timeout: 30_000 })
    await browser.close()
    expect(browser.isConnected()).toBe(false)
    browser = await chromium.launch()
    expect(browser.isConnected()).toBe(true)
    page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } })
    await signIn(page)
    await page.goto(`/centropy/investigations/${threadId}`)
    if (!terminalRestoration) await expect(page.locator(".ct-effects").getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
    const reopened = await identity()
    expect(reopened).toEqual(before)
    await expect(page.getByRole("button", { name: "Open scenario laboratory" })).toBeVisible()
    observed.activeRestoration = { before, refreshed, reopened, firstBrowserClosed: true, freshBrowserLaunched: true, storedSessionReused: false }
    steps.push(`Reload during ${terminalRestoration ? "recorded terminal success" : "pending approval"}, close the entire first browser, launch a new browser with no saved session, sign in again, and compare exact persisted IDs and Canvas`)
    for (const actionType of sequence) {
      let selected: Action | undefined
      await expect.poll(async () => {
        const w = await work()
        if (["blocked", "failed"].includes(w.objectiveLoop?.state ?? "")) throw new Error(`Before ${actionType}: ${w.objectiveLoop?.reason}`)
        selected = w.actions.find((a) => a.actionType === actionType && ["pending", "completed"].includes(a.status))
        return Boolean(selected)
      }, { timeout: 120_000, intervals: [2000, 4000] }).toBe(true)
      if (selected!.status === "pending") {
        const effects = page.locator(".ct-effects")
        await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
        await effects.getByRole("button", { name: "Review exact effect" }).click()
        await expect(effects).toContainText(selected!.id.slice(0, 8))
        await effects.getByRole("button", { name: "Confirm", exact: true }).click()
        await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
        const confirm = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/actions/${selected!.id}/confirm` && r.request().method() === "POST")
        await effects.getByRole("button", { name: "Confirm effect" }).click()
        expect((await confirm).status()).toBe(200)
        ;(observed.actionApprovals as unknown[]).push({ actionType, actionId: selected!.id, confirmedBy: "fixture owner in browser" })
      }
      await expect.poll(async () => {
        const w = await work()
        const effect = w.businessEffects.find((e) => e.domainActionId === selected!.id)
        const receipt = w.receipts.find((r) => r.domainActionId === selected!.id)
        return w.actions.find((a) => a.id === selected!.id)?.status === "completed"
          && effect?.status === "verified" && Boolean(receipt?.finalizedAt && !receipt.failure)
      }, { timeout: 120_000, intervals: [2000, 4000] }).toBe(true)
      steps.push(`Approve where required and observe completed ${actionType}, verified Business Effect, and finalized receipt`)
    }
    await expect.poll(async () => (await work()).objectiveLoop?.state, { timeout: 120_000, intervals: [2000, 4000] }).toBe("completed")
    const terminal = await work()
    expect(terminal.work.status).toBe("completed")
    expect(terminal.actions.map((a) => a.actionType)).toEqual(sequence)
    expect(terminal.businessEffects).toHaveLength(sequence.length)
    expect(terminal.businessEffects.every((e) => e.status === "verified" && e.verification?.state === "verified")).toBe(true)
    expect(terminal.receipts.filter((r) => r.finalizedAt && !r.failure)).toHaveLength(sequence.length)
    expect(terminal.objectiveLoop?.successVerification?.state).toBe("verified")
    expect(terminal.queryExecutions.some((q) => q.intent === (resumeWorkId ? "closing_readiness" : "pe_world_state") && q.status === "succeeded")).toBe(true)
    expect(terminal.workforceAssignments.some((a) => a.agentProfileId && a.state === "completed")).toBe(true)
    const reviewId = terminal.actions.find((a) => a.actionType === "request_ic_memo_review")!.id
    const reviewEffectId = terminal.businessEffects.find((e) => e.domainActionId === reviewId)!.id
    const proof = terminal.planRevisions.find((p) => p.status === "completed")?.completionProof
    expect(proof?.verified).toBe(true)
    expect(proof?.evidenceRefs).toContainEqual({ type: "business_effect", id: reviewEffectId })
    const openedId = terminal.actions.find((a) => a.actionType === (resumeWorkId ? "select_ic_underwriting_run" : "open_ic_case"))!.id
    const caseId = terminal.businessEffects.find((e) => e.domainActionId === openedId)!.observedResult!.entity!.entityId
    const workspace = await get<{ case: { id: string; state: string; currentMemoId: string; currentRecommendationId: string; primaryUnderwritingRunId: string };
      memo: { id: string; sourceCompleteness: string }; currentRecommendation: { id: string; outcome: string; memoId: string; underwritingRunId: string };
      artifacts: { memo: { documentId: string; documentVersionId: string } } }>(`private-equity/ic/cases/${caseId}`)
    expect(workspace.case.state).toBe("READY_FOR_REVIEW")
    expect(workspace.memo.sourceCompleteness).toBe("COMPLETE")
    expect(workspace.currentRecommendation).toMatchObject({ id: workspace.case.currentRecommendationId, outcome: "CONTINUE_DILIGENCE",
      memoId: workspace.case.currentMemoId, underwritingRunId: workspace.case.primaryUnderwritingRunId })
    const memoEffect = terminal.businessEffects.find((e) => e.domainActionId === terminal.actions.find((a) => a.actionType === "create_ic_memo_draft")!.id)!
    const canonical = memoEffect.observedResult!.canonicalState!
    const ir = await get<{ kind: string; nodes: Array<{ data?: { text?: string } }> }>(`documents/${canonical.documentId}/artifact/ir/${canonical.documentVersionId}`)
    expect(ir.kind).toBe("docx")
    const memoText = ir.nodes.map((n) => n.data?.text ?? "").join(" ")
    expect(memoText).toContain("Sources:")
    expect(memoText).toContain("Underwriting Run")
    expect(memoText).toContain(workspace.case.primaryUnderwritingRunId)
    expect(memoText).toContain("returns gross sponsor irr:")
    expect(memoText).toContain("returns gross sponsor moic:")
    expect(memoText).not.toContain('"value":')
    observed.completed = { workId, threadId, caseId, objective: terminal.objectiveLoop, workspace, actionIds: terminal.actions.map((a) => a.id),
      effects: terminal.businessEffects, receipts: terminal.receipts, completionProof: proof, queryExecutions: terminal.queryExecutions,
      workforceAssignments: terminal.workforceAssignments, memoText }
    await page.reload()
    const result = page.getByRole("region", { name: "Verified Objective result" })
    await expect(result.getByRole("heading", { name: "IC preparation completed" })).toBeVisible({ timeout: 30_000 })
    await expect(result).toContainText("Current recommendation: continue diligence.")
    await expect(result).toContainText("Selected memo is recorded on this IC case.")
    expect((await work()).actions.map((a) => a.id)).toEqual(terminal.actions.map((a) => a.id))
    steps.push("Read immutable sourced memo, exact risk-grounded recommendation, READY_FOR_REVIEW case and verified terminal proof; reload without an IC case override and verify final Thread result")
    verified = true
  } finally {
    const screenshotPath = testInfo.outputPath("atlas-autonomous.png")
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proofPath = testInfo.outputPath("atlas-autonomous.proof.json")
    await writeFile(proofPath, JSON.stringify({ schema: "centropy.e2e-proof/v2", result: verified ? "PASS" : "INCOMPLETE", flows: terminalRestoration ? [2, 10] : [2, 9, 10], capturedAt: new Date().toISOString(),
      baseUrl, input: { instruction, dealId, fixture: "synthetic disposable Atlas with real persisted artifact bytes" }, steps, observed,
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { mode: resumeWorkId ? "restore-and-recover-existing-instruction" : "fresh-single-instruction",
        stack: "node scripts/centropy/start-certification-stack.mjs --name=<recorded-or-fresh-fixture-name> --production-build",
        command: `${resumeWorkId ? `CENTROPY_RESUME_WORK_ID=${resumeWorkId} CENTROPY_RESUME_THREAD_ID=${resumeThreadId} ` : ""}node scripts/centropy/run-local-e2e.mjs e2e/centropy-autonomous-atlas.spec.ts --project=desktop-chromium --workers=1`,
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "matching frontend/API Supabase Auth project", "configured model provider"] },
      limitation: "Local integration proof. No firm template, external publication, human IC decision, or deployed-host certification is implied." }, null, 2) + "\n")
    await testInfo.attach("atlas-autonomous-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("atlas-autonomous-screenshot", { path: screenshotPath, contentType: "image/png" })
    await browser.close()
  }
})
