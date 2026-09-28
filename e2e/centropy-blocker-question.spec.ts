import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Why is Atlas blocked?"

test("Golden Flow 1 answers from canonical blockers and opens their exact WORLD source", async ({ page }, info) => {
  test.setTimeout(120_000)
  const url = String(info.project.use.baseURL)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Disposable Atlas fixture only")
  const observed: Record<string, unknown> = {}
  const started = Date.now()
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const signed = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me" && r.request().method() === "GET")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await signed
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
    const authorization = await me.request().headerValue("authorization")
    const read = async <T>(path: string): Promise<T> => {
      const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.status(), path).toBe(200)
      return response.json() as Promise<T>
    }
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    await expect(page.locator(".ct-composer__context")).toContainText("Atlas", { timeout: 30_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/actions" && r.request().method() === "POST")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const response = await submitted
    expect(response.status()).toBe(201)
    const intake = await response.json() as { workId: string; threadId: string }
    observed.intake = intake
    const work = (await read<{ work: { work: { status: string }; objectiveLoop: unknown; actions: unknown[]; businessEffects: unknown[]; queryExecutions: Array<{ status: string; intent: string; request: { dealId?: string } }> } }>(`works/${intake.workId}`)).work
    expect(work.work.status).toBe("completed")
    expect(work.objectiveLoop).toBeNull()
    expect(work.actions).toEqual([])
    expect(work.businessEffects).toEqual([])
    expect(work.queryExecutions).toEqual(expect.arrayContaining([expect.objectContaining({ intent: "closing_readiness", status: "succeeded", request: expect.objectContaining({ dealId }) })]))
    observed.canonicalRead = work.queryExecutions
    await expect(page.locator('.ct-turn[data-role="assistant"]').last()).toContainText("Recorded blockers", { timeout: 30_000 })
    const answer = await page.locator('.ct-turn[data-role="assistant"]').last().innerText()
    expect(answer).toMatch(/not ready to close|closing blocker/i)
    observed.answer = answer
    await expect(page.getByRole("button", { name: /Review Command|Execute command/i })).toHaveCount(0)
    const mobile = info.project.name.startsWith("mobile")
    if (mobile) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas", exact: true }).click()
    const blockers = page.locator('.ct-canvas-block[data-type="closing_readiness"]')
    await expect(blockers).toBeVisible({ timeout: 30_000 })
    const inspect = blockers.getByRole("button", { name: /^Inspect .* in WORLD$/ }).first()
    const sourceLabel = (await inspect.getAttribute("aria-label"))!.replace(/^Inspect /, "").replace(/ in WORLD$/, "")
    expect(answer).toContain(sourceLabel)
    observed.blocker = sourceLabel
    await inspect.click()
    await expect(page.locator(".ct-world__header")).toBeVisible({ timeout: 30_000 })
    expect(page.url()).toContain("90000000-0000-4000-8000-000000000011")
    observed.sourceUrl = page.url()
    await page.reload()
    await expect(page.locator(".ct-world__header")).toBeVisible({ timeout: 30_000 })
    expect(page.url()).toContain("90000000-0000-4000-8000-000000000011")
    const thread = await read<{ messages: Array<{ role: string; workId: string }> }>(`threads/${intake.threadId}?limit=100`)
    expect(thread.messages.filter((m) => m.role === "user" && m.workId === intake.workId)).toHaveLength(1)
    observed.noDuplicateUserTurn = true
    observed.elapsedMs = Date.now() - started
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
  } finally {
    const path = info.outputPath("blocker.png")
    const screenshot = await page.screenshot({ path, fullPage: true, animations: "disabled" })
    await writeFile(info.outputPath("blocker.proof.json"), JSON.stringify({ schema: "centropy.e2e-proof/v2", flow: "golden_flow_1", result: info.status,
      capturedAt: new Date().toISOString(), input: { instruction, dealId, baseURL: url }, observed,
      steps: ["Sign in as the fixture owner", "Ask the exact Atlas blocking question", "Verify the canonical closing-readiness query, completed Work, and absence of Objective/actions/effects", "Compare the named Thread blocker with the canonical Canvas record", "Open its exact WORLD source and reload", "Check persisted instruction uniqueness and viewport overflow"],
      screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
      reproduce: `CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=${url} npx playwright test e2e/centropy-blocker-question.spec.ts --project=${info.project.name} --workers=1`,
    }, null, 2) + "\n")
  }
})
