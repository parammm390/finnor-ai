import { createHash, randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

test.beforeEach(async ({}, info) => {
  test.setTimeout(300_000)
  if (process.env.CENTROPY_DISPOSABLE_E2E !== "1") return
  await awaitFixtureRateWindow(info)
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-centropy-human-controls.ts"], {
    cwd: `${process.cwd()}/finnor-os`, encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "postgres://finnor:finnor@127.0.0.1:55441/finnor", FINNOR_TEST_MANAGED_EXTENSIONS: "omit" },
  })
  expect(seeded.status, seeded.stderr).toBe(0)
})

// Real owner sign-in, UI-authored decisions, normal Core approval, canonical
// execution/readback, exact replay and rejection boundaries. Failure modes are
// recorded in docs/centropy/capability-reachability-failure-modes.md.
test("human closing decisions require exact approval and preserve one durable action on replay", async ({ page }, info) => {
  test.setTimeout(240_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "Authored loopback fixture only")
  const fixturePath = process.env.CENTROPY_HUMAN_CONTROLS_FIXTURE ?? ".centropy-certification/atlas-final-v2/human-controls-fixture.json"
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { authored: boolean; tenantId: string; ownerId: string; dealId: string; conditionId: string; conditionVersion: number; itemId: string; itemVersion: number; documentId: string; evidenceSourceId: string; evidenceVersionId: string }
  expect(fixture.authored).toBe(true)
  expect(["localhost", "127.0.0.1"]).toContain(new URL(String(info.project.use.baseURL)).hostname)
  const require = createRequire(`${process.cwd()}/finnor-os/package.json`)
  const client = new (require("pg").Client)({ connectionString: "postgres://finnor_app:finnor_app@127.0.0.1:55441/finnor" })
  await client.connect()
  const observed: Record<string, unknown> = { decisions: [], rejectedRequests: [] }
  const steps: string[] = []
  let verified = false
  const read = async (kind: "condition" | "item") => {
    await client.query("BEGIN")
    try {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenantId])
      const row = (await client.query(kind === "condition"
        ? "SELECT id,deal_id,state,version,waiver_reason,waiver_authority_decision_id,waiver_decision_receipt_id FROM finnor_os.pe_closing_conditions WHERE tenant_id=$1 AND id=$2"
        : "SELECT id,deal_id,state,version,verified_by_employee_id,verification_source FROM finnor_os.pe_closing_items WHERE tenant_id=$1 AND id=$2", [fixture.tenantId, kind === "condition" ? fixture.conditionId : fixture.itemId])).rows[0]
      await client.query("COMMIT")
      return row
    } catch (error) { await client.query("ROLLBACK"); throw error }
  }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const mePromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ tenantId: fixture.tenantId, employeeId: fixture.ownerId, role: "owner" })
    const headers = { authorization: (await me.request().headerValue("authorization"))! }
    expect(headers.authorization).toMatch(/^Bearer /)
    steps.push("Sign in through the real owner form; independently read each disposable record through the application database role and tenant RLS")
    const work = async (id: string) => {
      const response = await page.request.get(`/api/centropy/works/${id}`, { headers })
      expect(response.status(), await response.text()).toBe(200)
      return (await response.json()).work
    }
    for (const kind of ["condition", "item"] as const) {
      const before = await read(kind)
      expect(before).toMatchObject({ state: kind === "condition" ? "open" : "ready", version: kind === "condition" ? fixture.conditionVersion : fixture.itemVersion })
      const entityId = kind === "condition" ? fixture.conditionId : fixture.itemId
      const actionType = kind === "condition" ? "waive_closing_condition" : "verify_closing_item"
      const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: fixture.dealId }))
      const object = encodeURIComponent(JSON.stringify({ namespace: "private_equity", type: kind === "condition" ? "pe_closing_condition" : "pe_closing_item", id: entityId, owner: "@finnor/private-equity" }))
      await page.goto(`/centropy/world?root=${root}&object=${object}`)
      await page.getByText("Review this human closing decision", { exact: true }).click()
      const form = page.locator("#ct-world-closing-controls")
      await expect(form.getByLabel("Record operation")).toBeVisible({ timeout: 30_000 })
      if (kind === "condition") await form.getByLabel("reason *", { exact: true }).fill("Authored disposable control certification waiver; no live business decision.")
      else {
        await form.getByLabel("verification Source", { exact: true }).fill("Authored disposable control certification source")
        await form.getByLabel("evidence Source reference", { exact: true }).fill(fixture.evidenceSourceId)
        await form.getByLabel("evidence Version reference", { exact: true }).fill(fixture.evidenceVersionId)
      }
      await form.getByRole("button", { name: "Review record change", exact: true }).click()
      expect(await read(kind)).toEqual(before)
      await form.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
      const draftPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions/human" && r.request().method() === "POST")
      await form.getByRole("button", { name: "Record reviewed change", exact: true }).click()
      const draftResponse = await draftPromise
      const input = draftResponse.request().postDataJSON()
      expect(draftResponse.status(), await draftResponse.text()).toBe(201)
      const draft = await draftResponse.json()
      expect(draft).toMatchObject({ actionType, status: "awaiting_approval" })
      expect(await read(kind)).toEqual(before)
      const pending = await work(draft.workId)
      expect(pending.actions).toHaveLength(1)
      expect(pending.actions[0]).toMatchObject({ id: draft.actionId, actionType, status: "pending" })
      if (kind === "item") expect(pending.businessEffects[0].effect.targets).toContainEqual({ kind: "party", type: "employee", id: fixture.ownerId, sourcePath: "verifierEmployeeId" })
      expect(pending.businessEffects.every((effect: { status: string }) => effect.status !== "verified")).toBe(true)
      await form.getByRole("link", { name: "Open this decision in its Investigation" }).click()
      const effects = page.locator(".ct-effects")
      await effects.getByRole("button", { name: "Review exact effect" }).click()
      await expect(effects).toContainText(draft.actionId.slice(0, 8))
      await effects.getByRole("button", { name: "Confirm", exact: true }).click()
      await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
      const confirmPromise = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/actions/${draft.actionId}/confirm` && r.request().method() === "POST")
      await effects.getByRole("button", { name: "Confirm effect" }).click()
      const confirmation = await confirmPromise
      expect(confirmation.status(), await confirmation.text()).toBe(200)
      await expect.poll(async () => {
        const current = await work(draft.workId)
        const receipt = current.receipts.find((row: { domainActionId: string }) => row.domainActionId === draft.actionId)
        if (current.actions[0]?.status === "failed") throw new Error(JSON.stringify(receipt?.failure))
        return current.work.status === "completed" && current.businessEffects[0]?.status === "verified" && Boolean(receipt?.finalizedAt && !receipt.failure)
      }, { timeout: 60_000, intervals: [1000, 2000] }).toBe(true)
      const terminal = await work(draft.workId)
      const after = await read(kind)
      expect(after).toMatchObject({ state: kind === "condition" ? "waived" : "verified", version: before.version + 1 })
      if (kind === "condition") {
        expect(after.waiver_reason).toBe(input.payload.reason)
        expect(after.waiver_authority_decision_id).toMatch(/^[0-9a-f-]{36}$/)
        expect(after.waiver_decision_receipt_id).toBe(terminal.receipts[0].id)
      } else expect(after).toMatchObject({ verified_by_employee_id: fixture.ownerId, verification_source: input.payload.verificationSource })
      const repeated = await page.request.post("/api/centropy/actions/human", { headers, data: input })
      expect(repeated.status(), await repeated.text()).toBe(200)
      const replay = await repeated.json()
      expect(replay).toMatchObject({ duplicate: true, workId: draft.workId, actionId: draft.actionId, threadId: draft.threadId })
      expect((await work(draft.workId)).actions).toHaveLength(1)
      expect(await read(kind)).toEqual(after)
      const changed = await page.request.post("/api/centropy/actions/human", { headers, data: { ...input, payload: { ...input.payload, [kind === "condition" ? "reason" : "verificationSource"]: "Different exact decision" } } })
      expect(changed.status()).toBe(409)
      expect(await read(kind)).toEqual(after)
      ;(observed.decisions as unknown[]).push({ kind, input, draft, before, after, replay, changedPayloadStatus: changed.status(), effects: terminal.businessEffects, receipts: terminal.receipts })
      steps.push(`Review ${actionType}, prove no mutation after intake, separately approve the exact effect, observe canonical state/version, verified effect and finalized receipt, then replay the exact request and reject its changed payload`)
    }
    for (const request of [
      { label: "unsupported human action", data: { actionType: "declare_deal_closed", payload: { dealId: fixture.dealId }, idempotencyKey: randomUUID() }, status: 400 },
      { label: "forged verifier identity", data: { actionType: "verify_closing_item", payload: { dealId: fixture.dealId, closingItemId: fixture.itemId, expectedVersion: fixture.itemVersion, verifierEmployeeId: randomUUID(), documentId: fixture.documentId }, idempotencyKey: randomUUID() }, status: 403 },
    ]) {
      const response = await page.request.post("/api/centropy/actions/human", { headers, data: request.data })
      expect(response.status(), await response.text()).toBe(request.status)
      ;(observed.rejectedRequests as unknown[]).push({ label: request.label, status: response.status(), error: await response.json() })
    }
    observed.overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    expect(observed.overflowPx).toBeLessThanOrEqual(1)
    verified = true
  } finally {
    await client.end()
    const screenshotPath = info.outputPath("human-closing.png")
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proofPath = info.outputPath("human-closing.proof.json")
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", result: verified ? "PASS" : "INCOMPLETE", flow: "human_closing_decisions", capturedAt: new Date().toISOString(), fixturePath, fixture, baseURL: info.project.use.baseURL, steps, observed, screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null, limitations: ["Authored disposable closing records and exact fixture-emulator evidence; no live closing decision or provider publication", "Service-principal and foreign-tenant denial are not exercised by this browser proof"], reproduce: { preparation: "Run finnor-os/scripts/seed-centropy-human-controls.ts against the named disposable stack to create fresh open/ready records", command: "node scripts/centropy/run-local-e2e.mjs e2e/centropy-human-closing.spec.ts --project=desktop-chromium --workers=1" } }, null, 2) + "\n")
    await info.attach("human-closing-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await info.attach("human-closing-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
