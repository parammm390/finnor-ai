import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const period = "P001:2027-01-01:2027-12-31"

test("Atlas Canvas records two exact underwriting overrides in one immutable branch", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId, "Owner credentials and CENTROPY_WORK_ID are required")
  const screenshotPath = testInfo.outputPath("centropy-underwriting-multi-input.png")
  const proofPath = testInfo.outputPath("centropy-underwriting-multi-input.proof.json")
  const observed: Record<string, unknown> = { tenantId: null, viewportWidth: testInfo.project.use.viewport?.width ?? null, caseId: null, investmentCaseId: null, baseRunId: null, baseInputHash: null, scenarioId: null, branchRunId: null, branchValidity: null, changedInputs: null, changedOutputs: null, restoredBranch: false, horizontalOverflow: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await mePromise
    expect(meResponse.status()).toBe(200)
    const me = await meResponse.json() as { tenantId?: string; role?: string }
    expect(me.tenantId).toBe(tenantId)
    expect(me.role).toBe("owner")
    observed.tenantId = me.tenantId
    const authorization = await meResponse.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const get = async <T>(path: string): Promise<T> => {
      const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization: authorization! }, timeout: 20_000 })
      expect(response.ok(), `${path}: ${response.status()}`).toBe(true)
      return await response.json() as T
    }
    const work = await get<{ work: { work: { finalOutcome?: { response?: { threadId?: string } } }; actions?: Array<{ id?: string; actionType?: string; status?: string }>; businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }> } }>(`works/${workId}`)
    const open = work.work.actions?.find((item) => item.actionType === "open_ic_case" && item.status === "completed")
    const caseId = work.work.businessEffects?.find((item) => item.domainActionId === open?.id && item.status === "verified")?.observedResult?.entity?.entityId
    const threadId = work.work.work.finalOutcome?.response?.threadId
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.caseId = caseId
    const ic = await get<{ case: { investmentCaseId: string; dealId: string } }>(`private-equity/ic/cases/${caseId}`)
    expect(ic.case.dealId).toBe(dealId)
    const investmentCaseId = ic.case.investmentCaseId
    observed.investmentCaseId = investmentCaseId
    const workspace = await get<{ investmentCase: { id: string }; runs: Array<{ id: string; scenarioId: string | null; inputHash: string; inputSnapshot: { values: Record<string, { value: unknown }> } }> }>(`investment-cases/${investmentCaseId}/underwriting`)
    expect(workspace.investmentCase.id).toBe(investmentCaseId)
    const base = workspace.runs.find((run) => !run.scenarioId && JSON.stringify(run.inputSnapshot.values["operating.revenue_explicit"]?.value) === JSON.stringify({ [period]: "100" }) && run.inputSnapshot.values["exit.multiple"]?.value === "5")
    expect(base, "The disposable Atlas base Run must have the exact fixture inputs").toBeTruthy()
    observed.baseRunId = base!.id
    observed.baseInputHash = base!.inputHash

    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy/investigations/${threadId}?root=${root}&icCaseId=${caseId}`)
    if ((testInfo.project.use.viewport?.width ?? 1280) < 600) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    await page.getByRole("button", { name: "Open scenario laboratory" }).click()
    const lab = page.getByRole("region", { name: "Underwriting scenario laboratory" })
    await expect(lab).toBeVisible()
    await lab.getByLabel("Base run").selectOption(base!.id)
    await lab.getByRole("combobox", { name: "Input", exact: true }).selectOption("operating.revenue_explicit", { timeout: 10_000 })
    await lab.getByLabel("Proposed value · full period series as JSON").fill(JSON.stringify({ [period]: "90" }))
    await lab.getByRole("button", { name: "Add input to branch" }).click()
    await expect(lab).toContainText("Branch inputs · 1")
    await lab.getByRole("combobox", { name: "Input", exact: true }).selectOption("exit.multiple", { timeout: 10_000 })
    await lab.getByLabel("Proposed value · decimal").fill("9")
    await lab.getByLabel("Scenario name").fill("Atlas synthetic dual-input scenario")
    await lab.getByLabel("Reason").fill("Disposable fixture verifies one scenario changes revenue and exit multiple together; it does not assert a 300bps growth delta.")
    await lab.getByRole("button", { name: "Review exact changes" }).click()
    await expect(lab).toContainText("2 changed model inputs")
    const scenarioResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/underwriting/scenarios")
    const runResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/underwriting/runs")
    await lab.getByRole("button", { name: "Record scenario and run model" }).click()
    const scenarioResponse = await scenarioResponsePromise
    expect(scenarioResponse.status()).toBe(201)
    const scenario = await scenarioResponse.json() as { id: string }
    observed.scenarioId = scenario.id
    const runResponse = await runResponsePromise
    expect(runResponse.ok()).toBe(true)
    const created = await runResponse.json() as { id: string }
    observed.branchRunId = created.id
    const after = await get<{ scenarios: Array<{ id: string; definition: { overrides: Array<{ nodeId: string; value: unknown }> } }>; runs: Array<{ id: string; scenarioId: string | null; inputHash: string; status: string; validity: string; inputSnapshot: { values: Record<string, { value: unknown; truthClass: string }> } }> }>(`investment-cases/${investmentCaseId}/underwriting`)
    const recordedScenario = after.scenarios.find((item) => item.id === scenario.id)
    expect(recordedScenario?.definition.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "operating.revenue_explicit", value: { [period]: "90" } }),
      expect.objectContaining({ nodeId: "exit.multiple", value: "9" }),
    ]))
    expect(recordedScenario?.definition.overrides).toHaveLength(2)
    const branch = after.runs.find((item) => item.id === created.id)
    expect(branch?.scenarioId).toBe(scenario.id)
    expect(branch?.status).toBe("SUCCEEDED")
    expect(branch?.validity).toBe("VALID")
    expect(branch?.inputSnapshot.values["operating.revenue_explicit"]).toMatchObject({ value: { [period]: "90" }, truthClass: "SCENARIO_OVERRIDE" })
    expect(branch?.inputSnapshot.values["exit.multiple"]).toMatchObject({ value: "9", truthClass: "SCENARIO_OVERRIDE" })
    observed.branchValidity = branch?.validity ?? null
    expect(after.runs.find((item) => item.id === base!.id)?.inputHash).toBe(base!.inputHash)
    const diff = await get<{ changedInputs: Record<string, unknown>; changedOutputs: Record<string, unknown> }>(`underwriting/runs/diff?left=${base!.id}&right=${created.id}`)
    expect(Object.keys(diff.changedInputs).sort()).toEqual(["exit.multiple", "operating.revenue_explicit"])
    expect(Object.keys(diff.changedOutputs).length).toBeGreaterThan(0)
    observed.changedInputs = Object.keys(diff.changedInputs).sort()
    observed.changedOutputs = Object.keys(diff.changedOutputs)
    await expect(lab.getByLabel("Persisted branch")).toContainText("Atlas synthetic dual-input scenario")
    await page.reload()
    if ((testInfo.project.use.viewport?.width ?? 1280) < 600) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    await page.getByRole("button", { name: "Open scenario laboratory" }).click()
    const restored = page.getByRole("region", { name: "Underwriting scenario laboratory" })
    await expect(restored.getByLabel("Persisted branch")).toContainText("Atlas synthetic dual-input scenario")
    observed.restoredBranch = true
    observed.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(observed.horizontalOverflow).toBe(0)
  } finally {
    const screenshot = await page.locator(".ct-scenario-lab__pair").screenshot({ path: screenshotPath, animations: "disabled", timeout: 10_000 })
      .catch(() => page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null))
    await writeFile(proofPath, JSON.stringify({
      schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_multi_input_underwriting", capturedAt: new Date().toISOString(), baseUrl, actorEmail: email,
      input: { workId, dealId, revenueSeries: { [period]: "90" }, exitMultiple: "9" },
      steps: ["Authenticate owner in the disposable Atlas tenant", "Read exact base Run input snapshot", "Stage the complete revenue period series and a 9x exit override in Canvas", "Review and persist one two-input Scenario and Run", "Verify both input deltas, changed outputs, unchanged base hash, and full reload"],
      observed, screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: `CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<Atlas Work linked to the fixture IC case> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-underwriting-multi-input.spec.ts --project=${testInfo.project.name}`, requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas fixture with the exact one-period base Run"] },
      limitation: "This fixture has explicit one-period revenue and no revenue-growth node. The test does not claim the specified 300bps growth manipulation or release certification.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-underwriting-multi-input-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-underwriting-multi-input-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
