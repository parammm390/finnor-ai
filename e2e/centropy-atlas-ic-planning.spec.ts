import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const dealId = "90000000-0000-4000-8000-000000000001"
const fixtureTenantId = "00000000-0000-4000-8000-000000000001"
const instruction = "Challenge Atlas's revenue assumptions and prepare tomorrow's IC case."
const existingWorkId = process.env.CENTROPY_EXISTING_WORK_ID

test("Atlas IC objective verifies underwriting and opens a governed case", async ({ page }, testInfo) => {
  test.setTimeout(480_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  const hostname = new URL(baseUrl).hostname
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(hostname), "Run only against the disposable localhost fixture")
  test.skip(!email || !password, "TEST_OWNER_EMAIL and TEST_OWNER_PASSWORD are required")

  const screenshotPath = testInfo.outputPath("centropy-atlas-ic-planning.png")
  const proofPath = testInfo.outputPath("centropy-atlas-ic-planning.proof.json")
  const observed: Record<string, unknown> = {
    signIn: false,
    authenticatedTenantId: null,
    selectedDealId: dealId,
    submissionStatus: null,
    workId: null,
    objectiveLoopId: null,
    planRevisionCount: 0,
    selectedCandidate: null,
    queryExecutionCount: 0,
    dealGraphReadStatus: null,
    dealGraphWorker: null,
    completedChecks: 0,
    groundedModelVersionCount: 0,
    groundedRevenueInputCount: 0,
    underwritingActionStatus: null,
    underwritingActionId: null,
    baseRunId: null,
    scenarioRunId: null,
    scenarioRunStatus: null,
    scenarioRunValidity: null,
    scenarioId: null,
    baseRunStillValid: false,
    baseRevenue: null,
    scenarioRevenue: null,
    icOpenActionId: null,
    icOpenActionStatus: null,
    icCaseId: null,
    icCaseState: null,
    icCasePrimaryRunId: null,
    icCaseReconsidersDecisionId: null,
    exactEffectConfirmed: false,
    verifiedEffectCount: 0,
    finalizedReceiptCount: 0,
    workStatus: null,
    transportRetryCount: 0,
  }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await mePromise
    expect(meResponse.status()).toBe(200)
    const me = await meResponse.json() as { tenantId?: string; role?: string }
    observed.authenticatedTenantId = me.tenantId ?? null
    expect(me.tenantId, "The browser must be connected to the disposable Atlas tenant before it submits Work").toBe(fixtureTenantId)
    expect(me.role).toBe("owner")
    await expect(page.getByRole("heading", { name: "What needs to move forward?" })).toBeVisible()
    observed.signIn = true

    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    const composer = page.locator("#centropy-instruction")
    await expect(composer).toBeVisible({ timeout: 45_000 })
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i)
    let result: { workId?: string; objective?: { objectiveLoopId?: string } }
    let authorization: string | null = null
    if (existingWorkId) {
      authorization = await meResponse.request().headerValue("authorization")
      const workResponse = await page.request.get(`/api/centropy/works/${existingWorkId}`, { headers: { authorization: authorization! } })
      expect(workResponse.status()).toBe(200)
      const body = await workResponse.json() as { work?: { objectiveLoop?: { id?: string }; work?: { finalOutcome?: { response?: { threadId?: string } } } } }
      result = { workId: existingWorkId, objective: { objectiveLoopId: body.work?.objectiveLoop?.id } }
      observed.submissionStatus = "existing_work"
      const threadId = body.work?.work?.finalOutcome?.response?.threadId
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
      await page.goto(`/centropy/investigations/${threadId}?root=${root}`)
    } else {
      await composer.fill(instruction)
      const responsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
      const requestPromise = page.waitForRequest((request) =>
        request.method() === "POST" && new URL(request.url()).pathname === "/api/centropy/actions")
      await page.getByRole("button", { name: "Send instruction" }).click()
      const [response, request] = await Promise.all([responsePromise, requestPromise])
      observed.submissionStatus = response.status()
      result = await response.json() as { workId?: string; objective?: { objectiveLoopId?: string } }
      expect(response.status()).toBe(202)
      authorization = await request.headerValue("authorization")
    }
    observed.workId = result.workId ?? null
    observed.objectiveLoopId = result.objective?.objectiveLoopId ?? null
    expect(result.workId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(result.objective?.objectiveLoopId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(authorization).toMatch(/^Bearer /)
    await expect.poll(async () => {
      const workResponse = await page.request.get(`/api/centropy/works/${result.workId}`, {
        headers: { authorization: authorization! }, timeout: 10_000,
      }).catch(() => null)
      if (!workResponse) {
        observed.transportRetryCount = Number(observed.transportRetryCount) + 1
        return false
      }
      if (!workResponse.ok()) return false
      const body = await workResponse.json() as { work?: {
        work?: { status?: string };
        planRevisions?: Array<{ candidateSummary?: { selected?: { candidateKey?: string } } }>;
        plannerAttempts?: Array<{ status?: string }>;
        queryExecutions?: Array<{ intent?: string; status?: string }>;
        workforceAssignments?: Array<{ capability?: string; state?: string; agentProfileId?: string }>;
        objectiveSteps?: Array<{ inspection?: { privateEquityIcBasis?: {
          modelVersions?: unknown[];
          recentRuns?: Array<{ revenueInput?: unknown }>;
        } } }>;
        actions?: Array<{ id?: string; actionType?: string; status?: string; payload?: { baseRunId?: string } }>;
        businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }>;
        receipts?: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      } }
      const work = body.work
      observed.workStatus = work?.work?.status ?? null
      observed.planRevisionCount = work?.planRevisions?.length ?? 0
      observed.selectedCandidate = work?.planRevisions?.at(-1)?.candidateSummary?.selected?.candidateKey ?? null
      observed.queryExecutionCount = work?.queryExecutions?.length ?? 0
      observed.dealGraphReadStatus = work?.queryExecutions?.find((row) => row.intent === "pe_world_state")?.status ?? null
      observed.dealGraphWorker = work?.workforceAssignments?.find((row) => row.capability === "query:pe_world_state")?.agentProfileId ?? null
      observed.completedChecks = work?.workforceAssignments?.filter((row) => row.capability === "check:objective_success" && row.state === "completed").length ?? 0
      const basis = work?.objectiveSteps?.find((step) => step.inspection?.privateEquityIcBasis)?.inspection?.privateEquityIcBasis
      observed.groundedModelVersionCount = basis?.modelVersions?.length ?? 0
      observed.groundedRevenueInputCount = basis?.recentRuns?.filter((run) => run.revenueInput).length ?? 0
      const underwritingAction = work?.actions?.find((action) => action.actionType === "create_underwriting_run")
      observed.underwritingActionStatus = underwritingAction?.status ?? null
      observed.underwritingActionId = underwritingAction?.id ?? null
      observed.baseRunId = underwritingAction?.payload?.baseRunId ?? null
      observed.verifiedEffectCount = work?.businessEffects?.filter((effect) => effect.domainActionId === underwritingAction?.id && effect.status === "verified").length ?? 0
      observed.finalizedReceiptCount = work?.receipts?.filter((receipt) => receipt.domainActionId === underwritingAction?.id && receipt.finalizedAt && !receipt.failure).length ?? 0
      return observed.dealGraphReadStatus === "succeeded" && Boolean(observed.dealGraphWorker)
        && Number(observed.completedChecks) >= 1 && Number(observed.groundedModelVersionCount) > 0
        && Number(observed.groundedRevenueInputCount) > 0 && observed.underwritingActionStatus === "pending"
    }, { timeout: 180_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)

    const effects = page.locator(".ct-effects")
    await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
    await effects.getByRole("button", { name: "Review exact effect" }).click()
    await expect(effects).toContainText(String(observed.underwritingActionId).slice(0, 8))
    await effects.getByRole("button", { name: "Confirm", exact: true }).click()
    await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
    const confirmationPromise = page.waitForResponse((candidate) =>
      candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/api/centropy/actions/${observed.underwritingActionId}/confirm`)
    await effects.getByRole("button", { name: "Confirm effect" }).click()
    const confirmation = await confirmationPromise
    expect(confirmation.status()).toBe(200)
    const confirmationBody = await confirmation.json() as { result?: { status?: string }; idempotent?: boolean; status?: string }
    expect(confirmationBody.result?.status === "success" || confirmationBody.idempotent === true).toBe(true)
    observed.exactEffectConfirmed = true

    await expect.poll(async () => {
      const workResponse = await page.request.get(`/api/centropy/works/${result.workId}`, {
        headers: { authorization: authorization! }, timeout: 10_000,
      }).catch(() => null)
      if (!workResponse?.ok()) return false
      const body = await workResponse.json() as { work?: {
        actions?: Array<{ id?: string; actionType?: string; status?: string }>;
        businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }>;
        receipts?: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      } }
      const action = body.work?.actions?.find((item) => item.id === observed.underwritingActionId)
      observed.underwritingActionStatus = action?.status ?? null
      observed.verifiedEffectCount = body.work?.businessEffects?.filter((effect) => effect.domainActionId === action?.id && effect.status === "verified").length ?? 0
      observed.finalizedReceiptCount = body.work?.receipts?.filter((receipt) => receipt.domainActionId === action?.id && receipt.finalizedAt && !receipt.failure).length ?? 0
      const effect = body.work?.businessEffects?.find((item) => item.domainActionId === action?.id)
      observed.scenarioRunId = effect?.observedResult?.entity?.entityId ?? null
      return action?.status === "completed" && Number(observed.verifiedEffectCount) > 0 && Number(observed.finalizedReceiptCount) > 0 && Boolean(observed.scenarioRunId)
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)

    const runResponse = await page.request.get(`/api/centropy/underwriting/runs/${observed.scenarioRunId}`, {
      headers: { authorization: authorization! }, timeout: 15_000,
    })
    expect(runResponse.ok()).toBe(true)
    const run = await runResponse.json() as {
      id?: string; status?: string; validity?: string; scenarioId?: string | null;
      workId?: string; modelVersionId?: string; inputSnapshot?: { values?: Record<string, { value?: unknown }> };
    }
    observed.scenarioRunStatus = run.status ?? null
    observed.scenarioRunValidity = run.validity ?? null
    observed.scenarioId = run.scenarioId ?? null
    expect(run.id).toBe(observed.scenarioRunId)
    expect(run.workId).toBe(result.workId)
    expect(run.status).toBe("SUCCEEDED")
    expect(run.validity).toBe("VALID")
    expect(run.scenarioId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(observed.baseRunId).toMatch(/^[0-9a-f-]{36}$/i)

    const baseResponse = await page.request.get(`/api/centropy/underwriting/runs/${observed.baseRunId}`, {
      headers: { authorization: authorization! }, timeout: 15_000,
    })
    expect(baseResponse.ok()).toBe(true)
    const base = await baseResponse.json() as {
      id?: string; status?: string; validity?: string; scenarioId?: string | null;
      modelVersionId?: string; inputSnapshot?: { values?: Record<string, { value?: unknown }> };
    }
    observed.baseRunStillValid = base.id === observed.baseRunId && base.status === "SUCCEEDED" && base.validity === "VALID" && !base.scenarioId
    expect(observed.baseRunStillValid).toBe(true)
    expect(run.modelVersionId).toBe(base.modelVersionId)
    observed.baseRevenue = base.inputSnapshot?.values?.["operating.revenue_explicit"]?.value ?? null
    observed.scenarioRevenue = run.inputSnapshot?.values?.["operating.revenue_explicit"]?.value ?? null
    expect(observed.baseRevenue).toEqual({ "P001:2027-01-01:2027-12-31": "100" })
    expect(observed.scenarioRevenue).toEqual({ "P001:2027-01-01:2027-12-31": "80" })

    await expect.poll(async () => {
      const response = await page.request.get(`/api/centropy/works/${result.workId}`, {
        headers: { authorization: authorization! }, timeout: 10_000,
      }).catch(() => null)
      if (!response?.ok()) return false
      const body = await response.json() as { work?: {
        actions?: Array<{ id?: string; actionType?: string; status?: string; payload?: { primaryUnderwritingRunId?: string; reconsidersDecisionId?: string } }>;
      } }
      const action = body.work?.actions?.find((item) => item.actionType === "open_ic_case")
      observed.icOpenActionId = action?.id ?? null
      observed.icOpenActionStatus = action?.status ?? null
      return action?.status === "pending" && action.payload?.primaryUnderwritingRunId === observed.scenarioRunId
        && Boolean(action.payload?.reconsidersDecisionId)
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)

    await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
    await effects.getByRole("button", { name: "Review exact effect" }).click()
    await expect(effects).toContainText(String(observed.icOpenActionId).slice(0, 8))
    await effects.getByRole("button", { name: "Confirm", exact: true }).click()
    await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
    const icConfirmationPromise = page.waitForResponse((candidate) =>
      candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/api/centropy/actions/${observed.icOpenActionId}/confirm`)
    await effects.getByRole("button", { name: "Confirm effect" }).click()
    const icConfirmation = await icConfirmationPromise
    expect(icConfirmation.status()).toBe(200)
    const icConfirmationBody = await icConfirmation.json() as { result?: { status?: string }; idempotent?: boolean }
    expect(icConfirmationBody.result?.status === "success" || icConfirmationBody.idempotent === true).toBe(true)

    await expect.poll(async () => {
      const response = await page.request.get(`/api/centropy/works/${result.workId}`, {
        headers: { authorization: authorization! }, timeout: 10_000,
      }).catch(() => null)
      if (!response?.ok()) return false
      const body = await response.json() as { work?: {
        actions?: Array<{ id?: string; status?: string }>;
        businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }>;
        receipts?: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      } }
      const action = body.work?.actions?.find((item) => item.id === observed.icOpenActionId)
      observed.icOpenActionStatus = action?.status ?? null
      const effect = body.work?.businessEffects?.find((item) => item.domainActionId === action?.id && item.status === "verified")
      observed.icCaseId = effect?.observedResult?.entity?.entityId ?? null
      const receipt = body.work?.receipts?.find((item) => item.domainActionId === action?.id && item.finalizedAt && !item.failure)
      return action?.status === "completed" && Boolean(observed.icCaseId) && Boolean(receipt)
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)

    const icCaseResponse = await page.request.get(`/api/centropy/private-equity/ic/cases/${observed.icCaseId}`, {
      headers: { authorization: authorization! }, timeout: 15_000,
    })
    expect(icCaseResponse.ok()).toBe(true)
    const workspace = await icCaseResponse.json() as { case?: {
      id?: string; state?: string; primaryUnderwritingRunId?: string; reconsidersDecisionId?: string;
    } }
    observed.icCaseState = workspace.case?.state ?? null
    observed.icCasePrimaryRunId = workspace.case?.primaryUnderwritingRunId ?? null
    observed.icCaseReconsidersDecisionId = workspace.case?.reconsidersDecisionId ?? null
    expect(workspace.case?.id).toBe(observed.icCaseId)
    expect(workspace.case?.state).toBe("DRAFT")
    expect(workspace.case?.primaryUnderwritingRunId).toBe(observed.scenarioRunId)
    expect(workspace.case?.reconsidersDecisionId).toMatch(/^[0-9a-f-]{36}$/i)
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1",
      flow: "atlas_ic_objective_planning",
      capturedAt: new Date().toISOString(),
      baseUrl,
      actorEmail: email,
      input: { dealId, instruction, existingWorkId: existingWorkId ?? null },
      observed,
      steps: ["Authenticate the owner and verify the disposable Atlas tenant", existingWorkId ? "Resume the exact persisted revenue/IC Objective after its planner retry" : "Submit the exact revenue/IC Objective from the selected Deal", "Observe durable planning, bounded pe_world_state specialist work, and a pending underwriting action", "Review and approve the exact underwriting effect", "Verify the fresh scenario Run, unchanged base Run, effect and receipt", "Review and approve the exact IC case creation effect", "Read back the DRAFT case pinned to the fresh Run"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: {
        command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_EXISTING_WORK_ID=<optional persisted Work pending underwriting> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-atlas-ic-planning.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "fresh disposable Atlas fixture on localhost with no active IC case", "repository migrations through 0144 applied to the disposable database", "local frontend, API, and worker connected to that same database"],
      },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-atlas-ic-planning-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-atlas-ic-planning-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
