import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const actionSequence = ["create_ic_memo_draft", "select_ic_memo_version", "prepare_ic_recommendation", "request_ic_memo_review"] as const

test("Atlas Work prepares a sourced IC memo and verified recommendation", async ({ page }, testInfo) => {
  test.setTimeout(600_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId, "Owner credentials and an existing Atlas Work are required")
  const proofPath = testInfo.outputPath("centropy-ic-memo-recommendation.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-ic-memo-recommendation.png")
  const observed: Record<string, unknown> = { workId, caseId: null, threadId: null, actions: {}, sourceText: null, memoVersionId: null, recommendationId: null, caseState: null, objectiveState: null, workStatus: null, reloadState: null, sourceRetryCount: 0 }
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
    const get = async <T>(path: string): Promise<T> => {
      const response = await page.request.get(`/api/centropy/${path}`, { headers, timeout: 25_000 })
      expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
      return await response.json() as T
    }
    type Action = { id: string; actionType: string; status: string }
    type Effect = { domainActionId: string; status: string; observedResult?: { entity?: { entityId?: string }; canonicalState?: { documentId?: string; documentVersionId?: string; sourceCompleteness?: string } } }
    type Work = { work: { status: string; finalOutcome?: { response?: { threadId?: string } } }; objectiveLoop?: { state?: string; reason?: string; maxSteps?: number };
      actions: Action[]; businessEffects: Effect[]; receipts: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }> }
    const readWork = async (): Promise<Work> => (await get<{ work: Work }>(`works/${workId}`)).work
    const before = await readWork()
    expect(["blocked", "failed", "awaiting_approval"]).toContain(before.objectiveLoop?.state)
    expect(before.objectiveLoop?.maxSteps).toBeGreaterThan(0)
    const opened = before.actions.find((action) => action.actionType === "open_ic_case" && action.status === "completed")
    const caseId = before.businessEffects.find((effect) => effect.domainActionId === opened?.id && effect.status === "verified")?.observedResult?.entity?.entityId
    const threadId = before.work.finalOutcome?.response?.threadId
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.caseId = caseId
    observed.threadId = threadId
    const originalActionIds = before.actions.map((action) => action.id).sort()
    const originalEffectIds = before.businessEffects.map((effect) => effect.domainActionId).sort()
    const caseBefore = await get<{ case: { state: string; version: number; currentMemoId: string | null } }>(`private-equity/ic/cases/${caseId}`)
    expect(caseBefore.case.state).toBe("PREPARING")
    const failedSelection = before.actions.find((action) => action.actionType === "select_ic_memo_version" && action.status === "failed")
    if (caseBefore.case.currentMemoId) {
      const selected = before.actions.find((action) => action.actionType === "select_ic_memo_version"
        && action.id === caseBefore.case.currentMemoId && action.status === "completed")
      expect([failedSelection?.id, selected?.id]).toContain(caseBefore.case.currentMemoId)
      if (failedSelection) expect(before.businessEffects.find((effect) => effect.domainActionId === failedSelection.id)?.status).toBe("failed")
    }
    observed.failedSelectionId = failedSelection?.id ?? null

    const workforce = await get<{ data: { workers: Array<{ id: string; key: string; name: string; profileStatus: string; activeRevision: {
      modelRoute: { provider: string; model: string | null; purpose: string }; capabilityGrants: Array<{ kind: string; capability: string }>;
      maxConcurrentAssignments: number; autonomyLimits: Record<string, unknown>; planningHints: Record<string, unknown>
    } | null }> } }>("workforce/profiles")
    const preparation = workforce.data.workers.find((worker) => worker.key === "ic-preparation-analyst")
    expect(preparation?.activeRevision).not.toBeNull()
    const preparationRevision = preparation!.activeRevision!
    const preparationGrants = preparationRevision.capabilityGrants.filter((grant) =>
      grant.kind !== "action" || grant.capability === "request_ic_memo_review"
        || !actionSequence.some((action) => action === grant.capability))
    if (!preparationGrants.some((grant) => grant.kind === "action" && grant.capability === "request_ic_memo_review")) {
      preparationGrants.push({ kind: "action", capability: "request_ic_memo_review" })
    }
    if (JSON.stringify(preparationGrants) !== JSON.stringify(preparationRevision.capabilityGrants)) {
      const response = await page.request.post("/api/centropy/workforce/profiles", {
        headers,
        data: { profileId: preparation!.id, key: preparation!.key, name: preparation!.name,
          status: preparation!.profileStatus, modelRoute: preparationRevision.modelRoute,
          capabilityGrants: preparationGrants, maxConcurrentAssignments: preparationRevision.maxConcurrentAssignments,
          autonomyLimits: preparationRevision.autonomyLimits, planningHints: preparationRevision.planningHints }, timeout: 25_000,
      })
      expect(response.status(), `bounded IC preparation profile: ${await response.text()}`).toBe(200)
    }
    const agent = workforce.data.workers.find((worker) => worker.key === "ic-memo-analyst")
    const missing = actionSequence.filter((action) => !agent?.activeRevision?.capabilityGrants.some((grant) => grant.kind === "action" && grant.capability === action))
    if (!agent || missing.length) {
      const revision = agent?.activeRevision
      const response = await page.request.post("/api/centropy/workforce/profiles", {
        headers,
        data: { ...(agent ? { profileId: agent.id } : {}), key: "ic-memo-analyst", name: "IC Memo Analyst", status: "enabled",
          modelRoute: revision?.modelRoute ?? { provider: "orchestration_runtime", model: null, purpose: "objective_execution" },
          capabilityGrants: actionSequence.map((capability) => ({ kind: "action", capability })),
          maxConcurrentAssignments: 1,
          autonomyLimits: revision?.autonomyLimits ?? { maxActions: 4, maxQueries: 1, maxReplans: 4, maxPlannerCalls: 6,
            maxWallClockMs: 900_000, maxKnownCostUsd: null, maxKnownTokens: null },
          planningHints: revision?.planningHints ?? {} }, timeout: 25_000,
      })
      expect([200, 201], `workforce grant: ${await response.text()}`).toContain(response.status())
    }
    observed.configuredAgentGrants = { profile: "ic-memo-analyst", actions: missing }
    if (before.objectiveLoop?.state !== "awaiting_approval") {
      const controlled = before.objectiveLoop?.state === "failed"
        ? await page.request.post(`/api/centropy/works/${workId}/retry`, { headers, data: { idempotencyKey: "ic-memo-recovery-grounded-recommendation" }, timeout: 25_000 })
        : await page.request.post(`/api/centropy/works/${workId}/objective`, { headers, data: { command: "continue" }, timeout: 25_000 })
      expect(controlled.status(), `recover: ${await controlled.text()}`).toBe(202)
    }

    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    const confirm = async (actionId: string): Promise<void> => {
      await page.goto(`/centropy/investigations/${threadId}?root=${root}&icCaseId=${caseId}`)
      const effects = page.locator(".ct-effects")
      const reviewButton = effects.getByRole("button", { name: "Review exact effect" })
      try {
        await expect(reviewButton).toBeVisible({ timeout: 15_000 })
      } catch {
        observed.sourceRetryCount = Number(observed.sourceRetryCount) + 1
        await page.reload()
        await expect(reviewButton).toBeVisible({ timeout: 45_000 })
      }
      await effects.getByRole("button", { name: "Review exact effect" }).click()
      await expect(effects).toContainText(actionId.slice(0, 8))
      await effects.getByRole("button", { name: "Confirm", exact: true }).click()
      await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
      const confirmed = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/centropy/actions/${actionId}/confirm`)
      await effects.getByRole("button", { name: "Confirm effect" }).click()
      expect((await confirmed).status()).toBe(200)
    }
    for (const actionType of actionSequence) {
      let selected: Action | undefined
      await expect.poll(async () => {
        const current = await readWork().catch(() => null)
        selected = current?.actions.find((action) => action.actionType === actionType && ["pending", "completed"].includes(action.status))
        if (current?.objectiveLoop?.state === "failed" || (current?.objectiveLoop?.state === "blocked" && !selected)) {
          throw new Error(`Objective stopped before ${actionType}: ${current.objectiveLoop.reason}`)
        }
        return selected?.status ?? null
      }, { timeout: 120_000, intervals: [1_000, 2_000, 4_000] }).toMatch(/^(pending|completed)$/)
      if (selected?.status === "pending") await confirm(selected.id)
      await expect.poll(async () => {
        const current = await readWork().catch(() => null)
        const action = current?.actions.find((item) => item.id === selected?.id)
        const effect = current?.businessEffects.find((item) => item.domainActionId === selected?.id)
        const receipt = current?.receipts.find((item) => item.domainActionId === selected?.id)
        return action?.status === "completed" && effect?.status === "verified" && Boolean(receipt?.finalizedAt && !receipt.failure)
      }, { timeout: 120_000, intervals: [1_000, 2_000, 4_000] }).toBe(true)
      const current = await readWork()
      const effect = current.businessEffects.find((item) => item.domainActionId === selected!.id)!
      ;(observed.actions as Record<string, unknown>)[actionType] = { actionId: selected!.id, status: "completed", effectStatus: effect.status,
        entityId: effect.observedResult?.entity?.entityId ?? null }
      if (actionType === "create_ic_memo_draft") {
        const documentId = effect.observedResult?.canonicalState?.documentId
        const versionId = effect.observedResult?.canonicalState?.documentVersionId
        expect(documentId).toMatch(/^[0-9a-f-]{36}$/i)
        expect(versionId).toMatch(/^[0-9a-f-]{36}$/i)
        expect(effect.observedResult?.canonicalState?.sourceCompleteness).toBe("COMPLETE")
        const artifact = await get<{ kind: string; nodes: Array<{ data?: { text?: string } }> }>(`documents/${documentId}/artifact/ir/${versionId}`)
        expect(artifact.kind).toBe("docx")
        const content = artifact.nodes.filter((node) => node.data?.text).map((node) => String(node.data?.text)).join(" ")
        expect(content).toContain("Underwriting Run")
        expect(content).toContain("Sources:")
        observed.memoVersionId = versionId
        observed.sourceText = content.slice(0, 2_000)
      }
    }
    const after = await readWork()
    expect(after.actions.filter((action) => originalActionIds.includes(action.id)).map((action) => action.id).sort()).toEqual(originalActionIds)
    expect(after.businessEffects.filter((effect) => originalEffectIds.includes(effect.domainActionId)).map((effect) => effect.domainActionId).sort()).toEqual(originalEffectIds)
    const workspace = await get<{ case: { state: string; currentMemoId: string; currentRecommendationId: string; primaryUnderwritingRunId: string };
      memo?: { id: string; sourceCompleteness: string }; currentRecommendation?: { id: string; outcome: string; memoId: string; underwritingRunId: string };
      artifacts?: { memo?: { documentVersionId: string } } }>(`private-equity/ic/cases/${caseId}`)
    expect(workspace.case.state).toBe("READY_FOR_REVIEW")
    expect(workspace.memo?.sourceCompleteness).toBe("COMPLETE")
    expect(workspace.artifacts?.memo?.documentVersionId).toBe(observed.memoVersionId)
    expect(workspace.currentRecommendation).toMatchObject({ id: workspace.case.currentRecommendationId,
      outcome: "CONTINUE_DILIGENCE", memoId: workspace.case.currentMemoId,
      underwritingRunId: workspace.case.primaryUnderwritingRunId })
    observed.recommendationId = workspace.case.currentRecommendationId
    observed.caseState = workspace.case.state
    await expect.poll(async () => {
      const current = await readWork().catch(() => null)
      observed.objectiveState = current?.objectiveLoop?.state ?? null
      observed.workStatus = current?.work.status ?? null
      return current?.objectiveLoop?.state
    }, { timeout: 120_000, intervals: [2_000, 4_000] }).toMatch(/^(completed|blocked|failed)$/)
    const terminal = await readWork()
    if (failedSelection) {
      expect(terminal.businessEffects.find((effect) => effect.domainActionId === failedSelection.id)?.status).toBe("failed")
      expect(terminal.objectiveLoop?.state).not.toBe("completed")
    } else {
      expect(terminal.objectiveLoop?.state).toBe("completed")
      expect(terminal.work.status).toBe("completed")
      expect(terminal.businessEffects.every((effect) => effect.status === "verified")).toBe(true)
    }
    await page.goto(`/centropy/investigations/${threadId}?root=${root}&icCaseId=${caseId}`)
    await page.reload()
    const restored = await get<{ case: { state: string; currentMemoId: string; currentRecommendationId: string } }>(`private-equity/ic/cases/${caseId}`)
    expect(restored.case.state).toBe("READY_FOR_REVIEW")
    expect(restored.case.currentMemoId).toBe(workspace.case.currentMemoId)
    expect(restored.case.currentRecommendationId).toBe(workspace.case.currentRecommendationId)
    observed.reloadState = restored.case.state
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1", flow: observed.failedSelectionId ? "atlas_ic_memo_recommendation_recovery" : "atlas_ic_memo_recommendation_clean", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, dealId, disposableFixture: true,
        prerequisite: observed.failedSelectionId
          ? "The prior local Work had a failed memo selection and locally expanded step/action budgets. A new approved selection preserved that failed receipt. The Objective must not claim terminal success while the failed historical Business Effect remains."
          : "Fresh disposable Atlas Work with a governed PREPARING IC Case, no failed Business Effects, and repository default Objective budgets." },
      observed,
      steps: ["Authenticate the fixture owner", "Verify the prior canonical effects and PREPARING IC Case", "Verify the IC worker grants", observed.failedSelectionId ? "Recover the exact failed Work" : "Continue the exact pending Work", "Review each pending effect in the browser", "Verify immutable memo bytes and source citations", "Select the exact memo version", "Persist the risk-grounded continue-diligence Recommendation", "Request IC memo review", observed.failedSelectionId ? "Verify failed history remains visible and reload the review-ready Case" : "Verify terminal Objective and Work success and reload the review-ready Case"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<disposable Atlas Work with PREPARING IC Case> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-ic-memo-recommendation.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "local frontend, API, worker, and disposable DB fixture"] },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-ic-memo-recommendation-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-ic-memo-recommendation-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
