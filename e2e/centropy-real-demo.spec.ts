import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

// The §93 exact instruction, real canonical runtime, and real human approval.
// The timed wait represents the operator's review interval, never fake progress.
test("the exact sixty-second revenue and IC demo reaches a verified receipt and the same objective finishes", async ({ page }, info) => {
  test.setTimeout(360_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "Seeded controlled loopback fixture only")
  await awaitFixtureRateWindow(info)
  const instruction = "Challenge the revenue case and prepare tomorrow's IC."
  const dealId = "90000000-0000-4000-8000-000000000001"
  const observations: Record<string, unknown> = { instruction, authoredFixture: true, checkpoints: [], approvals: [], streamResponses: [] }
  const checkpoints = observations.checkpoints as unknown[]
  const approvals = observations.approvals as unknown[]
  let verified = false
  let epoch = 0
  let headers: Record<string, string> = {}
  let workId = "", threadId = "", instructionId = ""
  const elapsed = () => Date.now() - epoch
  const until = async (seconds: number) => { const remaining = seconds * 1000 - elapsed(); if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining)) }
  const capture = async (phase: string) => { const path = info.outputPath(`${phase}.png`); const bytes = await page.screenshot({ path, animations: "disabled" }); checkpoints.push({ phase, atMs: elapsed(), screenshot: path.split("/").pop(), sha256: createHash("sha256").update(bytes).digest("hex") }) }
  const getWork = async () => {
    let response = await page.request.get(`/api/centropy/works/${workId}`, { headers })
    if (response.status() === 429) { const seconds = Number(response.headers()["retry-after"]); expect(seconds).toBeGreaterThan(0); expect(seconds).toBeLessThanOrEqual(60); await new Promise((resolve) => setTimeout(resolve, seconds * 1000)); response = await page.request.get(`/api/centropy/works/${workId}`, { headers }) }
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json()).work
  }
  const approve = async (action: { id: string; actionType: string }) => {
    const effects = page.locator(".ct-effects")
    await effects.getByRole("button", { name: "Review exact effect", exact: true }).click()
    await expect(effects).toContainText(action.id.slice(0, 8))
    await effects.getByRole("button", { name: "Confirm", exact: true }).click()
    await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
    const sent = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/actions/${action.id}/confirm` && r.request().method() === "POST")
    await effects.getByRole("button", { name: "Confirm effect", exact: true }).click()
    const response = await sent
    expect(response.status(), await response.text()).toBe(200)
    approvals.push({ actionId: action.id, actionType: action.actionType, atMs: elapsed(), status: response.status() })
  }
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
    page.on("response", (response) => { if (new URL(response.url()).pathname === "/api/centropy/stream") (observations.streamResponses as unknown[]).push({ status: response.status(), type: response.headers()["content-type"], atMs: elapsed() }) })
    epoch = Date.now()
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))}`)
    await expect(page.locator(".ct-composer__context")).toContainText("Atlas")
    expect(elapsed()).toBeLessThan(5000)
    await capture("01-atlas-context")
    await until(5)
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const intake = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions" && r.request().method() === "POST")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const accepted = await intake
    expect(accepted.status(), await accepted.text()).toBeLessThan(300)
    const input = accepted.request().postDataJSON()
    const value = await accepted.json()
    expect(input.instruction).toBe(instruction)
    expect(input.instructionId).toMatch(/^[0-9a-f-]{36}$/)
    workId = value.workId; threadId = value.threadId; instructionId = input.instructionId
    expect(value.objective.objectiveLoopId).toBeTruthy()
    observations.intake = { input, response: value, acceptedAtMs: elapsed() }
    expect(elapsed()).toBeLessThan(10000)
    await expect(page.getByRole("region", { name: "Persisted instruction execution" })).toBeVisible()
    await expect(page.locator(".ct-execution__details li").first()).toBeAttached()
    await until(15)
    await page.locator(".ct-execution__details summary").click()
    observations.trace = { atMs: elapsed(), text: await page.locator(".ct-execution").innerText(), renderedSequence: await page.locator(".ct-execution__details li > span").allTextContents(), resources: await page.evaluate(() => ({ domElements: document.querySelectorAll("*").length, transferredBytes: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).reduce((n, e) => n + e.transferSize, 0) })) }
    await capture("02-real-trace")
    await until(20)
    await page.getByRole("button", { name: "Inspect specialist assignments", exact: true }).click()
    await expect(page.locator(".ct-workforce")).toBeVisible()
    await expect.poll(async () => (await getWork()).workforceAssignments.length, { timeout: 9500, intervals: [500, 1000] }).toBeGreaterThan(0)
    const current = await getWork()
    expect(elapsed()).toBeLessThan(30000)
    observations.specialists = { atMs: elapsed(), assignments: current.workforceAssignments }
    await capture("03-specialists")
    await until(30)
    await expect(page.locator('.ct-canvas-block[data-type="underwriting_summary"]')).toBeVisible()
    observations.financialAnalysis = { atMs: elapsed(), text: await page.locator('.ct-canvas-block[data-type="underwriting_summary"]').innerText() }
    await page.getByRole("button", { name: "Inspect source diagnostics", exact: true }).click()
    await expect(page.getByRole("region", { name: "Connection and evidence coverage" })).toBeVisible()
    observations.sourceContext = { atMs: elapsed(), text: await page.getByRole("region", { name: "Connection and evidence coverage" }).innerText() }
    await capture("04-financial-sources")
    await page.getByRole("button", { name: "Close source diagnostics", exact: true }).click()
    await until(40)
    const risk = page.locator('.ct-canvas-block[data-type="risk_register"]')
    await expect(risk).toBeVisible()
    const source = risk.locator(".ct-source-refs summary")
    await expect(source).toContainText("source reference")
    await source.click()
    await expect(risk.locator(".ct-source-refs li").first()).toBeVisible()
    observations.materialRisk = { atMs: elapsed(), text: await risk.innerText(), exactSources: await risk.locator(".ct-source-refs li").allTextContents() }
    await capture("05-material-risk-and-source")
    await until(48)
    const pending = (await getWork()).actions.find((action: { status: string }) => action.status === "pending")
    expect(pending).toBeTruthy()
    await page.locator(".ct-effects").getByRole("button", { name: "Review exact effect", exact: true }).click()
    await expect(page.locator(".ct-effects")).toContainText(pending.id.slice(0, 8))
    await capture("06-exact-approval-basis")
    await page.locator(".ct-effects").getByRole("button", { name: "Close details", exact: true }).click()
    expect(elapsed()).toBeLessThan(54000)
    await until(54)
    await approve(pending)
    expect(elapsed()).toBeLessThan(60000)
    await expect.poll(async () => { const work = await getWork(); return work.businessEffects.some((effect: { domainActionId: string; status: string }) => effect.domainActionId === pending.id && effect.status === "verified") && work.receipts.some((receipt: { domainActionId: string; finalizedAt: string; failure: unknown }) => receipt.domainActionId === pending.id && receipt.finalizedAt && !receipt.failure) }, { timeout: 6000, intervals: [250, 500] }).toBe(true)
    observations.firstVerifiedReceipt = { atMs: elapsed(), work: await getWork() }
    expect(elapsed()).toBeLessThan(60000)
    await capture("07-verified-receipt")
    observations.sixtySecondDemo = "PASS"
    console.info("Exact timed demo produced a verified effect and finalized receipt inside sixty seconds")
    await until(60)
    // A real network fault exercises the browser's existing poll fallback. The
    // route is aborted; no event or business response is fabricated.
    await page.route("**/api/centropy/stream?*", (route) => route.abort("connectionfailed"))
    const fallback = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/instructions/${instructionId}/events` && r.request().method() === "GET")
    await page.reload()
    const polled = await fallback
    expect(polled.status()).toBe(200)
    observations.pollFallback = { status: polled.status(), events: await polled.json(), controlledFault: "Only the browser SSE connection was aborted" }
    await page.unroute("**/api/centropy/stream?*")
    for (let count = 0; count < 10; count++) {
      const work = await getWork()
      if (work.objectiveLoop?.state === "completed") break
      if (["failed", "blocked"].includes(work.objectiveLoop?.state)) throw new Error(`Demo objective stopped: ${work.objectiveLoop.reason}`)
      const action = work.actions.find((row: { status: string }) => row.status === "pending")
      if (action) await approve(action)
      await expect.poll(async () => { const current = await getWork(); return current.objectiveLoop?.state === "completed" || current.actions.some((row: { status: string; id: string }) => row.status === "pending" && row.id !== action?.id) }, { timeout: 45_000, intervals: [1000, 2000] }).toBe(true)
    }
    const terminal = await getWork()
    expect(terminal.work.status).toBe("completed")
    expect(terminal.objectiveLoop.successVerification.state).toBe("verified")
    expect(terminal.businessEffects.every((effect: { status: string }) => effect.status === "verified")).toBe(true)
    expect(terminal.receipts.filter((receipt: { finalizedAt: string; failure: unknown }) => receipt.finalizedAt && !receipt.failure).length).toBe(terminal.actions.length)
    observations.terminal = terminal
    const persisted: Array<{ seq: number; phase: string; payload: unknown; createdAt: string }> = []
    let cursor = 0
    for (let count = 0; count < 20; count++) {
      const response = await page.request.get(`/api/centropy/instructions/${instructionId}/events?after=${cursor}`, { headers })
      expect(response.status()).toBe(200)
      const value = await response.json()
      persisted.push(...value.events)
      if (!value.page.hasMore) break
      expect(value.page.nextAfter).toBeGreaterThan(cursor)
      cursor = value.page.nextAfter
    }
    const sequences = persisted.map((event) => event.seq)
    expect(sequences.length).toBeGreaterThan(1)
    expect(sequences).toEqual([...new Set(sequences)].sort((a, b) => a - b))
    const readStream = (after: number) => page.evaluate(async ({ instructionId, authorization, after, last }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await fetch(`/api/centropy/stream?instructionId=${instructionId}`, {
          headers: { authorization, ...(after ? { "last-event-id": String(after) } : {}) },
          signal: controller.signal, cache: "no-store",
        })
        if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`)
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let body = "", buffer = ""
        const events: Array<{ seq: number; phase: string; payload: unknown; createdAt: string }> = []
        while (!events.some((event) => event.seq === last)) {
          const { value, done } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
          body += chunk; buffer += chunk
          let boundary: number
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const id = /^id: (\d+)$/m.exec(frame)
            const data = /^data: (.+)$/m.exec(frame)
            if (id && data) {
              const event = JSON.parse(data[1])
              if (event.seq !== Number(id[1])) throw new Error("SSE frame ID differs from persisted event identity")
              events.push(event)
              if (event.seq === last) break
            }
          }
        }
        return { status: response.status, type: response.headers.get("content-type"), body, events, clientClosedAtRecordedLastEvent: events.at(-1)?.seq === last }
      } finally {
        clearTimeout(timer)
        await reader?.cancel().catch(() => {})
        controller.abort()
      }
    }, { instructionId, authorization: headers.authorization, after, last: sequences.at(-1)! })
    const full = await readStream(0)
    expect(full.status).toBe(200)
    expect(full.type).toContain("text/event-stream")
    expect(full.events).toEqual(persisted)
    expect(full.clientClosedAtRecordedLastEvent).toBe(true)
    const after = sequences[Math.max(0, sequences.length - 2)]
    const resumed = await readStream(after)
    expect(resumed.status).toBe(200)
    expect(resumed.events).toEqual(persisted.filter((event) => event.seq > after))
    const resumedSequence = resumed.events.map((event) => event.seq)
    expect(resumedSequence).toEqual(sequences.filter((seq) => seq > after))
    observations.sse = { sequences, resumedAfter: after, resumedSequence, bodySha256: createHash("sha256").update(full.body).digest("hex"), clientClosedAtRecordedLastEvent: full.clientClosedAtRecordedLastEvent }
    observations.completedAtMs = elapsed()
    const thread = await page.request.get(`/api/centropy/threads/${threadId}`, { headers })
    expect(thread.status()).toBe(200)
    expect((await thread.json()).messages.filter((message: { role: string; instructionId: string }) => message.role === "user" && message.instructionId === instructionId)).toHaveLength(1)
    expect((observations.streamResponses as Array<{ status: number }>).some((row) => row.status === 200)).toBe(true)
    verified = true
  } finally {
    const path = info.outputPath("real-demo.proof.json")
    await writeFile(path, JSON.stringify({ schema: "centropy.real-demo-proof/v1", result: verified ? "PASS" : "INCOMPLETE", capturedAt: new Date().toISOString(), baseURL: info.project.use.baseURL, instruction, workId, threadId, instructionId, observed: observations, limitations: ["Controlled Atlas tenant with real canonical records and actual owner sign-in", "The first approved effect and receipt are timed inside sixty seconds; the full IC objective finishes afterward and has its own recorded time", "SSE fallback is exercised by aborting the real connection, without fabricated responses", "Real Microsoft publication remains BLOCKED_EXTERNAL"], reproduce: "PLAYWRIGHT_RECORD_VIDEO=1 node scripts/centropy/run-local-e2e.mjs e2e/centropy-real-demo.spec.ts --project=desktop-chromium --workers=1" }, null, 2) + "\n")
    await info.attach("real-demo-proof", { path, contentType: "application/json" })
  }
})
