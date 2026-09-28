import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

// Failure cases are recorded in capability-reachability-failure-modes.md before
// adding these controls: stale anchors, changed base bytes, duplicate patches,
// false calculation, unbound template versions and unchecked mission settings.
test("artifact creation, immutable spreadsheet edits, source records and owner mission settings use canonical services", async ({ page }, info) => {
  test.setTimeout(240_000)
  page.setDefaultTimeout(15_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "Authored loopback fixture only")
  await awaitFixtureRateWindow(info)
  const observed: Record<string, unknown> = { authoredInputs: { title: `Authored spreadsheet controls ${Date.now()}`, number: "123.45", formula: "SUM(1,2)" } }
  const inputs = observed.authoredInputs as { title: string; number: string; formula: string }
  let verified = false
  let headers: Record<string, string> = {}
  let originalMissionEnabled: boolean | null = null
  const record = async (region: import("@playwright/test").Locator, path: string) => {
    await region.getByRole("button", { name: "Review record change", exact: true }).click()
    await region.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST")
    await region.getByRole("button", { name: "Record reviewed change", exact: true }).click()
    return await response
  }
  const read = async (path: string) => { const r = await page.request.get(`/api/centropy/${path}`, { headers }); expect(r.status(), await r.text()).toBe(200); return await r.json() }
  const downloadHash = async (id: string, version: string) => { const r = await page.request.get(`/api/centropy/documents/${id}?versionId=${version}`, { headers }); expect(r.status()).toBe(200); return createHash("sha256").update(await r.body()).digest("hex") }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const identity = await me
    expect(identity.status()).toBe(200)
    expect(await identity.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
    headers = { authorization: (await identity.request().headerValue("authorization"))! }
    if ((page.viewportSize()?.width ?? 1440) < 780) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas", exact: true }).click()
    await page.getByText("Inspect supporting canonical records", { exact: true }).click()
    const supporting = page.getByRole("region", { name: "Supporting canonical records", exact: true })
    await expect(supporting.getByRole("combobox", { name: "Supporting record", exact: true }).locator("option")).toHaveCount(21)
    const protocolRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions/review-capability")
    await supporting.getByRole("button", { name: "Read supporting record", exact: true }).click()
    const protocol = await protocolRead
    expect(protocol.status()).toBe(200)
    expect(await protocol.json()).toMatchObject({ protocol: "effect-review-v1", prepareOnly: true, hashBoundApproval: true })
    await expect(supporting.getByRole("status")).toContainText("Owning service returned this record")
    await supporting.getByRole("combobox", { name: "Supporting record", exact: true }).selectOption("workforce/profiles")
    const profilesRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/workforce/profiles")
    await supporting.getByRole("button", { name: "Read supporting record", exact: true }).click()
    const profiles = await profilesRead
    expect(profiles.status()).toBe(200)
    observed.supportingReads = { protocol: await protocol.json(), profiles: await profiles.json(), registeredSelectors: 21 }
    await page.getByText("Inspect supporting canonical records", { exact: true }).click()
    await page.getByText("Create an artifact draft", { exact: true }).click()
    const creation = page.getByRole("region", { name: "Artifact draft creation", exact: true })
    await creation.getByLabel(/^kind/i).selectOption("xlsx")
    await creation.getByLabel(/^title/i).fill(inputs.title)
    const created = await record(creation, "/api/centropy/artifacts")
    expect(created.status(), await created.text()).toBe(201)
    const artifact = await created.json()
    const documentId = artifact.documentId, baseVersionId = artifact.version.id
    observed.created = artifact
    observed.baseHashBefore = await downloadHash(documentId, baseVersionId)
    await creation.getByRole("link", { name: "Open verified draft", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Workbook", exact: true })).toBeVisible()
    const editor = page.getByRole("region", { name: "Versioned spreadsheet editor", exact: true })
    await editor.getByRole("combobox", { name: "Value type", exact: true }).selectOption("number")
    await editor.getByLabel("New cell value", { exact: true }).fill(inputs.number)
    await editor.getByRole("button", { name: "Review exact cell change", exact: true }).click()
    const numeric = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/documents/${documentId}/artifact/patches` && r.request().method() === "POST")
    await editor.getByRole("button", { name: "Create workbook version", exact: true }).click()
    const numericResponse = await numeric
    expect(numericResponse.status(), await numericResponse.text()).toBeLessThan(300)
    const numericResult = await numericResponse.json(), numericVersionId = numericResult.version?.id ?? numericResult.versionId
    expect(numericVersionId).not.toBe(baseVersionId)
    observed.numericEdit = { input: numericResponse.request().postDataJSON(), result: numericResult }
    await expect.poll(async () => new URL(page.url()).searchParams.get("artifactVersionId")).toBe(numericVersionId)
    const numericIR = await read(`documents/${documentId}/artifact/ir/${numericVersionId}`)
    expect(numericIR.nodes.find((n: { kind: string }) => n.kind === "cell").data.value).toBe(Number(inputs.number))
    const numericFile = await page.request.get(`/api/centropy/documents/${documentId}?versionId=${numericVersionId}`, { headers })
    expect(numericFile.status()).toBe(200)
    const numericBytes = await numericFile.body(), numericPath = info.outputPath("numeric-version.xlsx")
    await writeFile(numericPath, numericBytes)
    const worksheetXml = execFileSync("unzip", ["-p", numericPath, "xl/worksheets/sheet1.xml"], { encoding: "utf8" })
    expect(worksheetXml).toContain(`<v>${inputs.number}</v>`)
    observed.exactNumericBytes = { file: "numeric-version.xlsx", sha256: createHash("sha256").update(numericBytes).digest("hex"), worksheet: "xl/worksheets/sheet1.xml", observedLiteral: inputs.number }
    await editor.getByRole("combobox", { name: "Value type", exact: true }).selectOption("formula")
    await editor.getByLabel("New cell value", { exact: true }).fill(inputs.formula)
    await editor.getByRole("button", { name: "Review exact cell change", exact: true }).click()
    const formula = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/documents/${documentId}/artifact/patches` && r.request().method() === "POST")
    await editor.getByRole("button", { name: "Create workbook version", exact: true }).click()
    const formulaResponse = await formula
    expect(formulaResponse.status(), await formulaResponse.text()).toBeLessThan(300)
    const formulaResult = await formulaResponse.json(), versionId = formulaResult.version?.id ?? formulaResult.versionId
    observed.formulaEdit = { input: formulaResponse.request().postDataJSON(), result: formulaResult }
    await expect.poll(async () => new URL(page.url()).searchParams.get("artifactVersionId")).toBe(versionId)
    const formulaIR = await read(`documents/${documentId}/artifact/ir/${versionId}`)
    const cell = formulaIR.nodes.find((n: { kind: string }) => n.kind === "cell")
    expect(cell.data).toMatchObject({ formula: inputs.formula, cached: null })
    expect(["uncalculated", "cached_stale"]).toContain(cell.data.calculation)
    const replay = await page.request.post(`/api/centropy/documents/${documentId}/artifact/patches`, { headers, data: formulaResponse.request().postDataJSON() })
    expect(replay.status()).toBeLessThan(300)
    expect((await replay.json()).versionId).toBe(versionId)
    const staleBody = { ...formulaResponse.request().postDataJSON(), operations: [{ ...formulaResponse.request().postDataJSON().operations[0], expectedHash: "0".repeat(64), formula: "SUM(1,3)" }] }
    const stale = await page.request.post(`/api/centropy/documents/${documentId}/artifact/patches`, { headers, data: staleBody })
    expect(stale.status()).toBeGreaterThanOrEqual(400)
    observed.patchReplayAndStale = { replayStatus: replay.status(), staleStatus: stale.status(), staleResult: await stale.json() }
    observed.baseHashAfter = await downloadHash(documentId, baseVersionId)
    expect(observed.baseHashAfter).toBe(observed.baseHashBefore)
    await page.reload()
    await expect(page.getByRole("heading", { name: "Workbook", exact: true })).toBeVisible()
    await expect(page.getByRole("table", { name: "Recorded worksheet cells", exact: true })).toContainText(/uncalculated|cached_stale/)
    await page.getByText("Manage exact artifact records", { exact: true }).click()
    const records = page.getByRole("region", { name: "Artifact source records", exact: true })
    await records.getByLabel("Record operation").selectOption("http.post.documents.$id.artifact.bindings")
    await records.getByLabel(/^target kind/i).selectOption("document_version")
    await records.getByLabel(/^target (?:id|reference)/i).fill(baseVersionId)
    const binding = await record(records, `/api/centropy/documents/${documentId}/artifact/bindings`)
    expect(binding.status()).toBeLessThan(300)
    observed.binding = { input: binding.request().postDataJSON(), result: await binding.json() }
    await expect(records.getByRole("status")).toContainText("Canonical readback verified")
    expect((await read(`documents/${documentId}/artifact/bindings?versionId=${versionId}`)).some((r: { anchor_id: string; target_id: string }) => r.anchor_id === cell.id && r.target_id === baseVersionId)).toBe(true)
    await records.getByLabel("Record operation").selectOption("http.post.documents.$id.artifact.lineage")
    await records.getByLabel(/^source version/i).fill(baseVersionId)
    await records.getByLabel(/^relation/i).selectOption("derived_from")
    const lineage = await record(records, `/api/centropy/documents/${documentId}/artifact/lineage`)
    expect(lineage.status()).toBeLessThan(300)
    observed.lineage = { input: lineage.request().postDataJSON(), result: await lineage.json() }
    await expect(records.getByRole("status")).toContainText("Canonical readback verified")
    await records.getByLabel("Record operation").selectOption("http.post.artifact-templates")
    const templateKey = `centropy_authored_sheet_${Date.now()}`
    await records.getByLabel(/^template key/i).fill(templateKey)
    const template = await record(records, "/api/centropy/artifact-templates")
    expect(template.status()).toBe(201)
    observed.template = { input: template.request().postDataJSON(), result: await template.json() }
    await expect(records.getByRole("status")).toContainText("Canonical readback verified")
    expect((await read("artifact-templates")).some((r: { template_key: string; version_id: string }) => r.template_key === templateKey && r.version_id === versionId)).toBe(true)
    await records.getByLabel("Record operation").selectOption("http.post.documents.$id.artifact.recalculate")
    await records.getByRole("button", { name: "Add ranges", exact: true }).click()
    await records.getByLabel(/^worksheet (?:id|reference)/i).fill(cell.data.sheetId)
    await records.getByLabel(/^address/i).fill("A1:A1")
    const calculation = await record(records, `/api/centropy/documents/${documentId}/artifact/recalculate`)
    const calculationBody = await calculation.json()
    expect(calculation.status() >= 400 || calculationBody.status === "stale").toBe(true)
    observed.calculation = { status: calculation.status(), result: calculationBody, meta: await read(`documents/${documentId}/artifact?versionId=${versionId}`) }
    expect((observed.calculation as { meta: { semantic: { calculationStatus: string } } }).meta.semantic.calculationStatus).toBe("stale")
    await expect(records).not.toContainText("Canonical readback verified")
    const missionId = "general_operator_objective"
    const beforeCatalog = await read("outcome-packs")
    const beforePack = beforeCatalog.packs.find((pack: { definition: { id: string } }) => pack.definition.id === missionId)
    originalMissionEnabled = beforePack.setting.enabled
    observed.missionBefore = beforePack
    await page.getByLabel("Account menu").click()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await settings.getByRole("combobox", { name: "Record area", exact: true }).selectOption("autonomy")
    await settings.getByRole("combobox", { name: "Record operation", exact: true }).selectOption("http.post.outcome-packs.control")
    await settings.getByLabel(/^pack (?:id|reference)/i).selectOption(missionId)
    await settings.getByRole("checkbox", { name: /^enabled/i }).setChecked(!originalMissionEnabled)
    await settings.getByLabel(/^reason/i).fill("Authored disposable owner mission setting verification")
    const mission = await record(settings, "/api/centropy/outcome-packs/control")
    expect(mission.status(), await mission.text()).toBe(200)
    await expect(settings.getByRole("status")).toContainText("Canonical readback verified")
    const afterPack = (await read("outcome-packs")).packs.find((pack: { definition: { id: string } }) => pack.definition.id === missionId)
    expect(afterPack.setting.enabled).toBe(!originalMissionEnabled)
    expect(afterPack.readiness.state).toBe(beforePack.readiness.state)
    observed.missionChange = { input: mission.request().postDataJSON(), response: await mission.json(), readback: afterPack }
    await page.keyboard.press("Escape")
    await expect(settings).not.toBeVisible()
    const screenshot = info.outputPath("artifact-controls.png")
    const bytes = await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" })
    observed.screenshotSha256 = createHash("sha256").update(bytes).digest("hex")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
    const require = createRequire(`${process.cwd()}/package.json`)
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") })
    const accessibility = await page.evaluate(async () => (window as typeof window & { axe: { run: (a: unknown, b: unknown) => Promise<{ violations: unknown[] }> } }).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }))
    expect(accessibility.violations).toEqual([])
    observed.accessibility = accessibility
    verified = true
  } finally {
    if (headers.authorization && originalMissionEnabled !== null) {
      const restored = await page.request.post("/api/centropy/outcome-packs/control", { headers, data: { packId: "general_operator_objective", enabled: originalMissionEnabled, reason: "Restore the initial enabled state after authored browser verification" } }).catch(() => null)
      observed.missionEnabledRestored = restored?.status() === 200
      if (verified) expect(observed.missionEnabledRestored).toBe(true)
    }
    const path = info.outputPath("artifact-controls.proof.json")
    await writeFile(path, JSON.stringify({ schema: "centropy.artifact-controls-proof/v1", result: verified ? "PASS" : "INCOMPLETE", capturedAt: new Date().toISOString(), viewport: page.viewportSize(), observed, limitations: ["Authored disposable blank workbook and exact manually supplied values/formula", "No local formula result, live Excel, provider publication or firm-approved template is claimed"], reproduce: "node scripts/centropy/run-local-e2e.mjs e2e/centropy-artifact-controls.spec.ts --workers=1" }, null, 2) + "\n")
    await info.attach("artifact-controls-proof", { path, contentType: "application/json" })
  }
})
