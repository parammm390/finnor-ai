import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const threadId = process.env.CENTROPY_THREAD_ID
const baseRunId = process.env.CENTROPY_GROWTH_BASE_RUN_ID
const dealId = "90000000-0000-4000-8000-000000000001"
const period = "P001:2027-01-01:2027-12-31"

test("exact Atlas growth Objective reaches verified terminal Work after governed approval", async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId || !threadId || !baseRunId, "Prepared local Work and owner sign-in required")
  const proofPath = testInfo.outputPath("centropy-growth-objective-terminal.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-growth-objective-terminal.png")
  const resultScreenshotPath = testInfo.outputPath("centropy-growth-verified-result.png")
  const observed: Record<string, unknown> = { workId, threadId, before: null, approvalStatus: null, actionId: null,
    effectId: null, receiptId: null, scenarioId: null, branchRunId: null, objectiveState: null, workStatus: null,
    successVerification: null, planCompletionProof: null, baseHash: null, baseHashAfter: null,
    growthDeltaBps: null, exitMultiple: null, changedInputs: null, changedOutputs: null,
    scenarioIdsBefore: null, newScenario: false, restored: false, canvasRestored: false }
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
    const get = async <T,>(path: string): Promise<T> => {
      const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
      return await response.json() as T
    }
    type Work = { work: { id: string; status: string }; objectiveLoop?: { state: string; reason?: string; successVerification?: { state: string; results: Array<{ kind: string; satisfied: boolean; evidenceRefs: Array<{ type: string; id: string }> }> } };
      actions: Array<{ id: string; actionType: string; status: string; payload: { investmentCaseId?: string; baseRunId?: string; scenario?: { overrides?: Array<{ nodeId: string; value: unknown }> } } }>;
      businessEffects: Array<{ id: string; domainActionId: string; status: string; observedResult?: { entity?: { entityId?: string } } }>;
      receipts: Array<{ id: string; domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      planRevisions: Array<{ status: string; completionProof?: { verified?: boolean; evidenceRefs?: Array<{ type: string; id: string }> } }> }
    const readWork = async () => (await get<{ work: Work }>(`works/${workId}`)).work
    const baseBefore = await get<{ id: string; inputHash: string; scenarioId: string | null; status: string; validity: string; inputSnapshot: { values: Record<string, { value: unknown }> } }>(`underwriting/runs/${baseRunId}`)
    expect(baseBefore).toMatchObject({ id: baseRunId, scenarioId: null, status: "SUCCEEDED", validity: "VALID" })
    expect(baseBefore.inputSnapshot.values["operating.revenue_growth"]?.value).toEqual({ [period]: "0.1" })
    observed.baseHash = baseBefore.inputHash
    const before = await readWork()
    const action = before.actions.find((item) => item.actionType === "create_underwriting_run")
    expect(action?.payload).toMatchObject({ baseRunId, scenario: { overrides: expect.arrayContaining([
      { nodeId: "operating.revenue_growth", value: { [period]: "0.07" }, reason: expect.any(String) },
      { nodeId: "exit.multiple", value: "9", reason: expect.any(String) },
    ]) } })
    expect(action?.payload.scenario?.overrides).toHaveLength(2)
    const investmentCaseId = action?.payload.investmentCaseId
    expect(investmentCaseId).toMatch(/^[0-9a-f-]{36}$/i)
    const workspaceBefore = await get<{ scenarios: Array<{ id: string }> }>(`investment-cases/${investmentCaseId}/underwriting`)
    const scenarioIdsBefore = workspaceBefore.scenarios.map((item) => item.id)
    observed.scenarioIdsBefore = scenarioIdsBefore
    observed.actionId = action?.id ?? null
    observed.before = { actionStatus: action?.status, objectiveState: before.objectiveLoop?.state, workStatus: before.work.status }
    if (action?.status === "pending") {
      await page.goto(`/centropy/investigations/${threadId}`)
      const effects = page.getByRole("region", { name: "Pending governed effects" })
      await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 35_000 })
      await effects.getByRole("button", { name: "Review exact effect" }).click()
      await expect(effects).toContainText(action.id.slice(0, 8))
      await expect(effects.getByText("Exact scenario values")).toBeVisible()
      await expect(effects.locator(".ct-effects__structured").first()).toContainText("operating.revenue_growth")
      await effects.getByRole("button", { name: "Confirm", exact: true }).click()
      await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
      const confirmationPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/actions/${action.id}/confirm`)
      await effects.getByRole("button", { name: "Confirm effect" }).click()
      observed.approvalStatus = (await confirmationPromise).status()
      expect(observed.approvalStatus).toBe(200)
    } else expect(action?.status).toBe("completed")
    await expect.poll(async () => {
      const work = await readWork()
      observed.objectiveState = work.objectiveLoop?.state ?? null
      observed.workStatus = work.work.status
      if (["failed", "blocked"].includes(work.objectiveLoop?.state ?? "")) throw new Error(`Objective stopped: ${work.objectiveLoop?.reason}`)
      return work.objectiveLoop?.state ?? null
    }, { timeout: 240_000, intervals: [1_000, 2_000, 4_000] }).toBe("completed")
    const after = await readWork()
    expect(after.work.status).toBe("completed")
    expect(after.actions.filter((item) => item.actionType === "create_underwriting_run")).toHaveLength(1)
    expect(after.actions.find((item) => item.id === action?.id)?.status).toBe("completed")
    const effect = after.businessEffects.find((item) => item.domainActionId === action?.id)
    const receipt = after.receipts.find((item) => item.domainActionId === action?.id)
    expect(effect?.status).toBe("verified")
    expect(receipt?.finalizedAt).toBeTruthy()
    expect(receipt?.failure).toBeFalsy()
    expect(after.objectiveLoop?.successVerification?.state).toBe("verified")
    const exact = after.objectiveLoop?.successVerification?.results.find((result) => result.kind === "private_equity_underwriting_scenario")
    expect(exact?.satisfied).toBe(true)
    expect(exact?.evidenceRefs).toEqual(expect.arrayContaining([
      { type: "underwriting_run", id: baseRunId },
      { type: "business_effect", id: effect?.id },
    ]))
    const plan = after.planRevisions.find((item) => item.status === "completed")
    expect(plan?.completionProof?.verified).toBe(true)
    expect(plan?.completionProof?.evidenceRefs).toEqual(expect.arrayContaining([{ type: "business_effect", id: effect?.id }]))
    const branchRunId = effect?.observedResult?.entity?.entityId
    expect(branchRunId).toMatch(/^[0-9a-f-]{36}$/i)
    const branch = await get<{ id: string; scenarioId: string; status: string; validity: string; inputSnapshot: { values: Record<string, { value: unknown }> } }>(`underwriting/runs/${branchRunId}`)
    expect(branch).toMatchObject({ id: branchRunId, status: "SUCCEEDED", validity: "VALID" })
    expect(scenarioIdsBefore).not.toContain(branch.scenarioId)
    observed.newScenario = true
    expect(branch.inputSnapshot.values["operating.revenue_growth"]?.value).toEqual({ [period]: "0.07" })
    expect(branch.inputSnapshot.values["exit.multiple"]?.value).toBe("9")
    const baseAfter = await get<typeof baseBefore>(`underwriting/runs/${baseRunId}`)
    expect(baseAfter.inputHash).toBe(baseBefore.inputHash)
    const diff = await get<{ changedInputs: Record<string, unknown>; changedOutputs: Record<string, unknown> }>(`underwriting/runs/diff?left=${baseRunId}&right=${branchRunId}`)
    expect(Object.keys(diff.changedInputs).sort()).toEqual(["exit.multiple", "operating.revenue_growth"])
    expect(Object.keys(diff.changedOutputs).length).toBeGreaterThan(0)
    observed.effectId = effect?.id ?? null
    observed.receiptId = receipt?.id ?? null
    observed.scenarioId = branch.scenarioId
    observed.branchRunId = branchRunId
    observed.successVerification = after.objectiveLoop?.successVerification ?? null
    observed.planCompletionProof = plan?.completionProof ?? null
    observed.baseHashAfter = baseAfter.inputHash
    observed.growthDeltaBps = -300
    observed.exitMultiple = branch.inputSnapshot.values["exit.multiple"]?.value
    observed.changedInputs = Object.keys(diff.changedInputs).sort()
    observed.changedOutputs = Object.keys(diff.changedOutputs).sort()
    await page.goto(`/centropy/investigations/${threadId}`)
    await page.reload()
    await expect(page.locator(".ct-objective__top")).toContainText("completed", { timeout: 30_000 })
    const result = page.getByRole("region", { name: "Verified underwriting result" })
    await expect(result.getByRole("heading", { name: "Growth scenario completed" })).toBeVisible({ timeout: 30_000 })
    await expect(result).toContainText("0.1 → 0.07 (−300bps)")
    await expect(result).toContainText("5x → 9x")
    await page.getByRole("button", { name: "Open scenario laboratory" }).click()
    const lab = page.getByRole("region", { name: "Underwriting scenario laboratory" })
    await expect(lab.getByLabel("Persisted branch").locator(`option[value="${branchRunId}"]`)).toHaveCount(1)
    await lab.getByLabel("Persisted branch").selectOption(branchRunId!)
    await expect(lab.locator(".ct-scenario-lab__outputs")).toContainText("forecast revenue")
    observed.canvasRestored = true
    observed.restored = true
  } finally {
    const resultScreenshot = await page.getByRole("region", { name: "Verified underwriting result" }).screenshot({ path: resultScreenshotPath, animations: "disabled" }).catch(() => null)
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_growth_objective_terminal", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, threadId, baseRunId, instruction: "Take growth down 300bps and exit at 9x.", disposableFixture: true }, observed,
      steps: ["Authenticate owner", "Read exact pending Work action and immutable growth-model base", "Review and confirm its frozen Business Effect", "Wait for completed Objective and Work", "Verify exact success condition, effect, receipt, Scenario, valid Run, unchanged base, diff, CompletionProof, and reload"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      resultScreenshotSha256: resultScreenshot ? createHash("sha256").update(resultScreenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<prepared growth Work> CENTROPY_THREAD_ID=<persisted Investigation> CENTROPY_GROWTH_BASE_RUN_ID=<growth base Run> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-growth-objective-terminal.spec.ts --project=desktop-chromium", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "local disposable Atlas fixture"] },
      limitation: "Synthetic local proof. Configured release host certification remains open.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-growth-objective-terminal-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-growth-objective-terminal-screenshot", { path: screenshotPath, contentType: "image/png" })
    if (resultScreenshot) await testInfo.attach("centropy-growth-verified-result-screenshot", { path: resultScreenshotPath, contentType: "image/png" })
  }
})
