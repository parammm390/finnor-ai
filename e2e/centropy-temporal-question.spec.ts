import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "What changed since yesterday, and does it affect our recommendation?"

test("Atlas temporal question cites real evidence, model, and IC activity without inventing cause", async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password, "Owner sign-in is required")
  const proofPath = testInfo.outputPath("centropy-temporal-question.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-temporal-question.png")
  const observed: Record<string, unknown> = { workId: null, threadId: null, workStatus: null, query: null, evidenceChange: null,
    modelChange: null, recommendationChange: null, declaredRecommendationRunLink: null, threadAnswer: null }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const me = await mePromise
    expect(me.status()).toBe(200)
    expect(await me.json()).toMatchObject({ tenantId: "00000000-0000-4000-8000-000000000001", role: "owner" })
    const authorization = await me.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const root = { entityType: "pe_deal", entityId: dealId }
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify(root))}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    expect(submitted.status()).toBe(201)
    const accepted = await submitted.json() as { workId: string; threadId: string }
    observed.workId = accepted.workId
    observed.threadId = accepted.threadId
    const readWork = async () => {
      const response = await page.request.get(`/api/centropy/works/${accepted.workId}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.ok(), `Work read: ${response.status()}`).toBe(true)
      return (await response.json() as { work: { work: { status: string }; queryExecutions: Array<{ intent: string; status: string; request: Record<string, unknown>; resultSummary: unknown }> } }).work
    }
    await expect.poll(async () => { const work = await readWork(); observed.workStatus = work.work.status; return work.work.status },
      { timeout: 120_000, intervals: [1_000, 2_000] }).toBe("completed")
    const work = await readWork()
    const query = work.queryExecutions.find((item) => item.intent === "pe_world_state" && item.status === "succeeded"
      && item.request.compareWindow === "previous_24h")
    expect(query).toBeDefined()
    expect(query?.request.root).toEqual(root)
    observed.query = query
    if (process.env.CENTROPY_TEMPORAL_CLONE === "1") {
      const fixture = JSON.parse(await readFile(".centropy-certification/atlas-temporal-clone/temporal-change.json", "utf8")) as { caseId: string; baselineRecommendationId: string; currentRecommendationId: string; baselineRunId: string; currentRunId: string; evidenceVersionId: string }
      const comparisonResponse = await page.request.post("/api/centropy/queries", {
        headers: { authorization: authorization! }, data: { intent: "pe_world_state", root, compareWindow: "previous_24h" }, timeout: 30_000,
      })
      expect(comparisonResponse.status(), await comparisonResponse.text()).toBe(201)
      const comparison = await comparisonResponse.json() as { result?: { temporalReview?: Record<string, unknown> }; temporalReview?: Record<string, unknown> }
      const review = (comparison.result?.temporalReview ?? comparison.temporalReview) as {
        baselineStatus: string; basisCoverage: { status: string; reasons: string[] };
        recommendationComparisons: Array<{ caseId: string; assessment: string; baseline: { id: string; outcome: string }; current: { id: string; outcome: string }; fieldsChanged: string[] }>;
        modelComparisons: Array<{ caseId: string; baselineRunId: string; currentRunId: string; changedInputs: Record<string, unknown>; changedOutputs: Record<string, unknown> }>;
        changes: Array<{ kind: string; subject: { id: string } }>;
      }
      // Core relationship/approval metadata has no temporal owner. This must
      // stay partial while the separately versioned IC basis is complete.
      expect(review.baselineStatus).toBe("partial")
      expect(review.basisCoverage).toMatchObject({ status: "complete", reasons: [] })
      const basis = review.recommendationComparisons.find((item) => item.caseId === fixture.caseId)
      expect(basis).toMatchObject({ assessment: "changed_basis", baseline: { id: fixture.baselineRecommendationId, outcome: "CONTINUE_DILIGENCE" }, current: { id: fixture.currentRecommendationId, outcome: "CONTINUE_DILIGENCE" } })
      expect(basis?.fieldsChanged).toEqual(expect.arrayContaining(["underwritingRunId", "memoId", "rationale"]))
      const modelDiff = review.modelComparisons.find((item) => item.caseId === fixture.caseId)
      expect(modelDiff).toMatchObject({ baselineRunId: fixture.baselineRunId, currentRunId: fixture.currentRunId })
      expect(Object.keys(modelDiff!.changedInputs).length).toBeGreaterThan(0)
      expect(Object.keys(modelDiff!.changedOutputs).length).toBeGreaterThan(0)
      expect(review.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "evidence_version_recorded", subject: expect.objectContaining({ id: fixture.evidenceVersionId }) })]))
      observed.historicalComparison = { fixture, review }
    }

    const activityResponse = await page.request.post("/api/centropy/semantic-activity", {
      headers: { authorization: authorization! }, data: { root, limit: 1_000 }, timeout: 30_000,
    })
    expect(activityResponse.status(), await activityResponse.text()).toBe(200)
    const activity = await activityResponse.json() as { items: Array<{ id: string; kind: string; occurredAt: string;
      subjectRef: { id: string }; evidenceRefs: Array<{ type: string; id: string }>;
      causalRefs: Array<{ relationship: string; type: string; id: string; sourceRef: { table: string; id: string } }>;
      sourceRefs: Array<{ table: string; id: string }> }>;
      bounds: { truncated: boolean } }
    expect(activity.bounds.truncated).toBe(false)
    const evidence = activity.items.find((item) => item.kind === "evidence_version_recorded" && item.evidenceRefs.some((ref) => ref.type === "evidence_version"))
    const model = activity.items.find((item) => item.kind === "underwriting_run_completed")
    const recommendation = activity.items.find((item) => item.kind === "ic_recommendation_recorded"
      && item.causalRefs.some((ref) => ref.relationship === "underwriting_run" && ref.id === model?.subjectRef.id))
    expect(evidence).toBeDefined()
    expect(model).toBeDefined()
    expect(recommendation).toBeDefined()
    observed.evidenceChange = evidence
    observed.modelChange = model
    observed.recommendationChange = recommendation
    observed.declaredRecommendationRunLink = recommendation?.causalRefs.find((ref) => ref.relationship === "underwriting_run")

    await page.goto(`/centropy/investigations/${accepted.threadId}`)
    const answer = page.locator('.ct-turn[data-role="assistant"]').last()
    await expect(answer).toContainText("recorded Deal changes", { timeout: 35_000 })
    await expect(answer).toContainText("evidence version")
    await expect(answer).toContainText("Underwriting Run")
    await expect(answer).toContainText("IC recommendation")
    await expect(answer).toContainText("does not prove that an evidence change caused the recommendation")
    if (process.env.CENTROPY_TEMPORAL_CLONE === "1") {
      await expect(answer).toContainText("recorded Run, memo or rationale basis changed")
      await expect(answer).toContainText("changed input")
      await expect(answer).toContainText("changed output")
    }
    observed.threadAnswer = await answer.innerText()
    await page.reload()
    await expect(page.locator('.ct-turn[data-role="assistant"]').last()).toContainText("recorded Deal changes", { timeout: 35_000 })
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_temporal_recommendation_question",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email, input: { dealId, instruction }, observed,
      steps: ["Authenticate the owner and ask the exact temporal recommendation question from Atlas Deal", "Verify a completed canonical previous-24-hour Work query", "Read the canonical Deal Semantic Activity and verify evidence, Underwriting Run, and IC recommendation events with the declared Run link", "Reopen and reload the Thread answer and its explicit causal and coverage limitations"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-temporal-question.spec.ts --project=desktop-chromium --workers=1", requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "seeded disposable Atlas tenant with canonical history"] },
      limitation: process.env.CENTROPY_TEMPORAL_CLONE === "1" ? "Local authored historical fixture in a named database clone. The complete yesterday/current selected bases and exact model deltas are verified. Evidence-to-model causality is unrepresented; recommendation-to-Run linkage is canonical. This is not production history or live-host certification." : "Local synthetic fixture. The 24-hour historical baseline predates canonical history. The answer must mark partial baseline coverage. Evidence-to-model causality is unrepresented. Live-host verification remains open.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-temporal-question-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-temporal-question-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
