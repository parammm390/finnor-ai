import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const threadId = process.env.CENTROPY_THREAD_ID
const baseRunId = process.env.CENTROPY_GROWTH_BASE_RUN_ID
const dealId = "90000000-0000-4000-8000-000000000001"
const investmentCaseId = "90000000-0000-4000-8000-000000000002"
const period = "P001:2027-01-01:2027-12-31"

/** Failure modes covered: absent growth node/basis, wrong basis-point arithmetic, wrong exit multiple, changed base Run,
 * missing Scenario/Run, invalid model result, unrelated diff/lineage, stale Canvas, and lost branch after reload. */
test("Atlas growth falls exactly 300bps and exit rises to 9x in one persisted branch", async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !threadId || !baseRunId, "Owner, Atlas Investigation, and exact growth base Run are required")
  const proofPath = testInfo.outputPath("centropy-growth-300bps.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-growth-300bps.png")
  const observed: Record<string, unknown> = { baseRunId, baseGrowth: null, downsideGrowth: null, growthDeltaBps: null,
    baseExitMultiple: null, downsideExitMultiple: null, scenarioId: null, branchRunId: null, branchStatus: null,
    baseHashAfter: null, changedInputs: null, changedOutputs: null, revenueDelta: null, exitValueDelta: null,
    revenueLineage: null, exitLineage: null, canvasComparison: false, restoredBranch: false, horizontalOverflow: null }
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
      const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization: authorization! }, timeout: 20_000 })
      expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
      return await response.json() as T
    }
    type Run = { id: string; modelVersionId: string; scenarioId: string | null; inputHash: string; status: string; validity: string;
      inputSnapshot: { values: Record<string, { value: unknown; truthClass: string }> }; result: { outputs: Record<string, { value: unknown }> } }
    type Workspace = { investmentCase: { id: string; dealId: string }; scenarios: Array<{ id: string; definition: { overrides: Array<{ nodeId: string; value: unknown }> } }>; runs: Run[] }
    const before = await get<Workspace>(`investment-cases/${investmentCaseId}/underwriting`)
    expect(before.investmentCase).toMatchObject({ id: investmentCaseId, dealId })
    const base = before.runs.find((run) => run.id === baseRunId && !run.scenarioId)
    expect(base?.status).toBe("SUCCEEDED")
    expect(base?.validity).toBe("VALID")
    expect(base?.inputSnapshot.values["operating.revenue_growth"]?.value).toEqual({ [period]: "0.1" })
    expect(base?.inputSnapshot.values["exit.multiple"]?.value).toBe("5")
    expect(base?.result.outputs["output.forecast.revenue"]?.value).toEqual({ [period]: "110" })
    observed.baseGrowth = base?.inputSnapshot.values["operating.revenue_growth"]?.value
    observed.baseExitMultiple = base?.inputSnapshot.values["exit.multiple"]?.value

    await page.goto(`/centropy/investigations/${threadId}`)
    await page.getByRole("button", { name: "Open scenario laboratory" }).click()
    const lab = page.getByRole("region", { name: "Underwriting scenario laboratory" })
    await lab.getByLabel("Base run").selectOption(baseRunId!)
    await lab.getByRole("combobox", { name: "Input", exact: true }).selectOption("operating.revenue_growth")
    await lab.getByLabel("Proposed value · 2027-01-01 to 2027-12-31").fill("0.07")
    await lab.getByRole("button", { name: "Add input to branch" }).click()
    await lab.getByRole("combobox", { name: "Input", exact: true }).selectOption("exit.multiple")
    await lab.getByLabel("Proposed value · decimal").fill("9")
    await lab.getByLabel("Scenario name").fill("Atlas growth down 300bps and exit 9x")
    await lab.getByLabel("Reason").fill("Disposable Atlas growth model: 10.00% minus 300 basis points equals 7.00%; exit multiple 5x to 9x.")
    await lab.getByRole("button", { name: "Review exact changes" }).click()
    await expect(lab).toContainText("2 changed model inputs")
    const scenarioPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/underwriting/scenarios")
    const runPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/underwriting/runs")
    await lab.getByRole("button", { name: "Record scenario and run model" }).click()
    const scenarioResponse = await scenarioPromise
    expect(scenarioResponse.status()).toBe(201)
    const scenarioId = (await scenarioResponse.json() as { id: string }).id
    const runResponse = await runPromise
    expect(runResponse.ok(), `Run: ${runResponse.status()} ${await runResponse.text()}`).toBe(true)
    const branchRunId = (await runResponse.json() as { id: string }).id
    observed.scenarioId = scenarioId
    observed.branchRunId = branchRunId
    const after = await get<Workspace>(`investment-cases/${investmentCaseId}/underwriting`)
    const branch = after.runs.find((run) => run.id === branchRunId)
    expect(branch).toMatchObject({ scenarioId, modelVersionId: base?.modelVersionId, status: "SUCCEEDED", validity: "VALID" })
    const scenario = after.scenarios.find((item) => item.id === scenarioId)
    expect(scenario?.definition.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "operating.revenue_growth", value: { [period]: "0.07" } }),
      expect.objectContaining({ nodeId: "exit.multiple", value: "9" }),
    ]))
    expect(scenario?.definition.overrides).toHaveLength(2)
    expect(branch?.inputSnapshot.values["operating.revenue_growth"]).toMatchObject({ value: { [period]: "0.07" }, truthClass: "SCENARIO_OVERRIDE" })
    expect(branch?.inputSnapshot.values["exit.multiple"]).toMatchObject({ value: "9", truthClass: "SCENARIO_OVERRIDE" })
    const bps = Math.round(Number((base?.inputSnapshot.values["operating.revenue_growth"]?.value as Record<string, string>)[period]) * 10_000)
      - Math.round(Number((branch?.inputSnapshot.values["operating.revenue_growth"]?.value as Record<string, string>)[period]) * 10_000)
    expect(bps).toBe(300)
    observed.growthDeltaBps = -bps
    observed.downsideGrowth = branch?.inputSnapshot.values["operating.revenue_growth"]?.value
    observed.downsideExitMultiple = branch?.inputSnapshot.values["exit.multiple"]?.value
    observed.branchStatus = `${branch?.status}/${branch?.validity}`
    const unchangedBase = after.runs.find((run) => run.id === baseRunId)
    expect(unchangedBase?.inputHash).toBe(base?.inputHash)
    observed.baseHashAfter = unchangedBase?.inputHash
    const diff = await get<{ changedInputs: Record<string, unknown>; changedOutputs: Record<string, { left: unknown; right: unknown }>; causalAttribution: string; causalChangedInputsByOutput: Record<string, string[]> }>(`underwriting/runs/diff?left=${baseRunId}&right=${branchRunId}`)
    expect(Object.keys(diff.changedInputs).sort()).toEqual(["exit.multiple", "operating.revenue_growth"])
    expect(diff.causalAttribution).toBe("DEPENDENCY_GRAPH")
    expect(diff.changedOutputs["output.forecast.revenue"]).toMatchObject({ left: { [period]: "110" }, right: { [period]: "107" } })
    expect(diff.causalChangedInputsByOutput["output.forecast.revenue"]).toContain("operating.revenue_growth")
    expect(diff.causalChangedInputsByOutput["output.exit.enterprise_value"]).toEqual(expect.arrayContaining(["operating.revenue_growth", "exit.multiple"]))
    const explain = async (nodeId: string) => get<{ nodeId: string; value: unknown; dependencies: unknown[] }>(`underwriting/runs/${branchRunId}/explain?nodeId=${nodeId}`)
    const revenueLineage = await explain("output.forecast.revenue")
    const exitLineage = await explain("output.exit.enterprise_value")
    expect(JSON.stringify(revenueLineage)).toContain("operating.revenue_growth")
    expect(JSON.stringify(exitLineage)).toContain("exit.multiple")
    observed.changedInputs = Object.keys(diff.changedInputs).sort()
    observed.changedOutputs = Object.keys(diff.changedOutputs).sort()
    observed.revenueDelta = diff.changedOutputs["output.forecast.revenue"]
    observed.exitValueDelta = diff.changedOutputs["output.exit.enterprise_value"]
    observed.revenueLineage = { nodeId: revenueLineage.nodeId, value: revenueLineage.value }
    observed.exitLineage = { nodeId: exitLineage.nodeId, value: exitLineage.value }
    await expect(lab.getByLabel("Persisted branch")).toContainText("Atlas growth down 300bps and exit 9x")
    await expect(lab.locator(".ct-scenario-lab__outputs")).toContainText("forecast revenue")
    observed.canvasComparison = true
    await page.reload()
    await page.getByRole("button", { name: "Open scenario laboratory" }).click()
    const restored = page.getByRole("region", { name: "Underwriting scenario laboratory" })
    await restored.getByLabel("Base run").selectOption(baseRunId!)
    await expect(restored.getByLabel("Persisted branch")).toContainText("Atlas growth down 300bps and exit 9x")
    observed.restoredBranch = true
    observed.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(observed.horizontalOverflow).toBe(0)
  } finally {
    const screenshot = await page.locator(".ct-scenario-lab__pair").screenshot({ path: screenshotPath, animations: "disabled", timeout: 10_000 })
      .catch(() => page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null))
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_growth_down_300bps_exit_9x", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { threadId, investmentCaseId, baseRunId, instruction: "Take growth down 300bps and exit at 9x.", disposableFixture: true }, observed,
      steps: ["Sign in as owner", "Read a valid base Run with a real 10% revenue-growth input and 5x exit", "Stage one Scenario with 7% growth and 9x exit in Canvas", "Persist a valid Run", "Verify exact -300bps, unchanged base, input/output diff and causal lineage", "Reload and restore the branch"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_THREAD_ID=<Atlas Investigation> CENTROPY_GROWTH_BASE_RUN_ID=<seeded growth base Run> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-growth-300bps.spec.ts --project=desktop-chromium", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "local frontend, API, worker, and disposable DB fixture", "DATABASE_URL=local disposable fixture for seed-centropy-growth-model.ts"] },
      limitation: "This certifies the exact financial manipulation in a synthetic local growth model through Canvas. It does not certify natural-language planning or the configured release host.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-growth-300bps-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-growth-300bps-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
