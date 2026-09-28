import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Ask Sarah for the missing customer cohort file."
type Capture = { acceptedAt: string; from: string; recipients: string[]; messageId: string; mime: string; sha256: string; fixtureOnly: boolean }
const captures = async (): Promise<Capture[]> => (await readFile(".centropy-certification/atlas-temporal-clone/smtp/accepted.jsonl", "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))

test("exact Sarah instruction executes one reviewed governed email and survives action replay", async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || process.env.CENTROPY_SMTP_CANARY !== "1" || !["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Guarded localhost SMTP fixture only")
  const fixture = JSON.parse(await readFile(".centropy-certification/atlas-temporal-clone/communication-fixture.json", "utf8")) as { partyId: string; identityId: string; recipientAddress: string; senderAddress: string }
  const observed: Record<string, unknown> = { intake: null, action: null, effect: null, receipt: null, smtpAcceptance: null, duplicateReplay: null }
  const screenshotPath = testInfo.outputPath("centropy-governed-message.png")
  const proofPath = testInfo.outputPath("centropy-governed-message.proof.json")
  const before = await captures()
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const mePromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    const authorization = (await me.request().headerValue("authorization"))!
    expect(authorization).toMatch(/^Bearer /)
    const headers = { authorization }
    const profilesResponse = await page.request.get("/api/centropy/workforce/profiles?limit=100", { headers })
    expect(profilesResponse.ok()).toBe(true)
    const profiles = (await profilesResponse.json()).data.workers as Array<{ id: string; key: string }>
    const existingProfile = profiles.find((profile) => profile.key === "centropy-communication-canary")
    const configuredProfile = await page.request.post("/api/centropy/workforce/profiles", { headers, data: {
      ...(existingProfile ? { profileId: existingProfile.id } : {}), key: "centropy-communication-canary", name: "Authored local communication specialist", status: "enabled",
      capabilityGrants: [{ capability: "query:party_lookup", kind: "query" }, { capability: "send_message", kind: "action" }, { capability: "check:objective_success", kind: "check" }], maxConcurrentAssignments: 2,
      autonomyLimits: { maxActions: 1, maxQueries: 3, maxReplans: 2, maxPlannerCalls: 2, maxWallClockMs: 240_000 },
    } })
    expect(configuredProfile.ok(), await configuredProfile.text()).toBe(true)
    observed.fixtureProfile = await configuredProfile.json()
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 30_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions" && r.request().method() === "POST")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    expect([201, 202]).toContain(submitted.status())
    const intake = await submitted.json() as { workId: string; threadId: string }
    observed.intake = intake
    const readWork = async () => {
      const r = await page.request.get(`/api/centropy/works/${intake.workId}`, { headers })
      expect(r.ok(), `Work read returned ${r.status()}: ${await r.text()}`).toBe(true)
      return (await r.json()).work as { work: { status: string }; actions: Array<{ id: string; actionType: string; status: string; payload: { recipient?: { partyId: string }; channel?: string; subject?: string; body?: string } }>; businessEffects: Array<{ domainActionId: string; status: string; semanticHash: string; verification?: { state: string }; observedResult?: unknown }>; receipts: Array<{ domainActionId: string; finalizedAt: string | null; failure: unknown }> }
    }
    await expect.poll(async () => { const current = await readWork(); observed.planning = current; if (current.work.status === "failed") throw new Error("The communication Work failed before approval"); return current.actions.some((a) => a.actionType === "send_message" && a.status === "pending") }, { timeout: 70_000, intervals: [1_000, 2_000] }).toBe(true)
    const planned = await readWork()
    const action = planned.actions.find((a) => a.actionType === "send_message")!
    expect(action.payload.recipient?.partyId).toBe(fixture.partyId)
    expect(action.payload.channel).toBe("email")
    expect(action.payload.subject).toBeTruthy()
    expect(action.payload.body).toMatch(/customer.*cohort|cohort.*file/i)
    expect(planned.actions.some((a) => a.actionType === "create_task")).toBe(false)
    expect(await captures()).toHaveLength(before.length)
    observed.action = action
    await page.goto(`/centropy/investigations/${intake.threadId}`)
    const effects = page.locator(".ct-effects")
    await effects.getByRole("button", { name: "Review exact effect" }).click()
    await expect(effects).toContainText(action.payload.subject!)
    await expect(effects).toContainText(action.payload.body!)
    await effects.getByRole("button", { name: "Confirm", exact: true }).click()
    await effects.getByRole("checkbox").check()
    const confirmedPromise = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/actions/${action.id}/confirm`)
    await effects.getByRole("button", { name: "Confirm effect", exact: true }).click()
    const confirmed = await confirmedPromise
    expect(confirmed.ok(), await confirmed.text()).toBe(true)
    await expect.poll(async () => (await readWork()).actions.find((a) => a.id === action.id)?.status, { timeout: 70_000, intervals: [1_000, 2_000] }).toBe("completed")
    await expect.poll(async () => (await readWork()).businessEffects.find((e) => e.domainActionId === action.id)?.status, { timeout: 60_000, intervals: [1_000, 2_000] }).toBe("verified")
    const completed = await readWork()
    const effect = completed.businessEffects.find((e) => e.domainActionId === action.id)
    const receipt = completed.receipts.find((r) => r.domainActionId === action.id)
    expect(effect).toMatchObject({ status: "verified", verification: { state: "verified" } })
    expect(receipt?.finalizedAt).toBeTruthy()
    expect(receipt?.failure).toBeNull()
    observed.effect = effect; observed.receipt = receipt
    const accepted = await captures()
    expect(accepted).toHaveLength(before.length + 1)
    const message = accepted.at(-1)!
    expect(message.from).toBe(fixture.senderAddress)
    expect(message.recipients).toEqual([fixture.recipientAddress])
    expect(createHash("sha256").update(message.mime).digest("hex")).toBe(message.sha256)
    expect(message.mime).toMatch(/customer.*cohort|cohort.*file/i)
    observed.smtpAcceptance = message
    expect(effect!.semanticHash).toMatch(/^[a-f0-9]{64}$/)
    const replay = await page.request.post(`/api/centropy/actions/${action.id}/confirm`, { headers, data: { expectedEffectHash: effect!.semanticHash, typedConfirmation: true } })
    expect(replay.status()).toBe(200)
    expect(await replay.json()).toMatchObject({ idempotent: true, status: "completed" })
    expect(await captures()).toHaveLength(accepted.length)
    observed.duplicateReplay = { status: replay.status(), smtpAcceptedCountBeforeReplay: accepted.length, smtpAcceptedCountAfterReplay: (await captures()).length }
    await page.reload()
    await expect(page.getByRole("heading", { name: instruction, exact: true, level: 1 })).toBeVisible()
    const restored = await readWork()
    expect(restored.actions.filter((a) => a.actionType === "send_message").map((a) => a.id)).toEqual([action.id])
    expect(restored.businessEffects.find((e) => e.domainActionId === action.id)?.status).toBe("verified")
    expect(await captures()).toHaveLength(accepted.length)
    observed.restoration = { threadId: intake.threadId, workId: intake.workId, actionId: action.id, effectStatus: "verified", smtpAcceptedCount: accepted.length }
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "governed_sarah_communication", capturedAt: new Date().toISOString(), baseUrl, input: { dealId, instruction, fixture }, observed,
      steps: ["Sign in as the owner; submit the exact Sarah instruction", "Verify exact canonical party, email channel, subject/body, and no SMTP acceptance before approval", "Review and confirm the actual compiled effect in the Thread", "Read the completed action, verified BusinessEffect and finalized receipt; compare the loopback SMTP envelope and MIME hash", "Replay confirmation and reload; verify one action and no additional SMTP acceptance"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 CENTROPY_SMTP_CANARY=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-governed-message.spec.ts --project=desktop-chromium --workers=1", stack: "CENTROPY_TEMPORAL_CLONE=1 node scripts/centropy/start-certification-stack.mjs --name=atlas-temporal-clone --smtp-canary" },
      limitation: "Authored local Sarah party and real loopback SMTP protocol capture. Proves SMTP acceptance, not recipient delivery or a real Sarah/Gmail connection. No external mailbox is contacted.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-governed-message-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-governed-message-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
