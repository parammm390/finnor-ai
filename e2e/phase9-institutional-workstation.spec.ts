import { expect, test } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { WorkAggregateView } from "../src/components/centropy/product/contracts"
import { assertInspectorLineage, assertKeyboardInspector, certifyRequiredJourneyDimensions, openDealSection, openDeterministicDeal, PHASE9_DEAL_SECTIONS, PHASE9_PRIMARY_ROUTES, signInOwner } from "./fixtures/phase9"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD

test.describe("Phase 9 institutional workstation boundary", () => {
  for (const path of PHASE9_PRIMARY_ROUTES) {
    test(`${path} keeps one persistent signed-out product shell`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator(".pw-global-bar")).toBeVisible()
      await expect(page.getByRole("navigation", { name: "Private Equity operating surfaces" }).getByRole("link")).toHaveText(["Home", "Deals", "Work", "Agents"])
      await expect(page.getByRole("heading", { name: "Decision context stays private by default." })).toBeVisible()
      await expect(page.getByText(/sample deal|sample work|project northstar/i)).toHaveCount(0)
    })
  }
})

test.describe("Phase 9 backend-backed certification", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(180_000)
  test.skip(!email || !password, "TEST_OWNER_EMAIL and TEST_OWNER_PASSWORD are required; PE product truth is never intercepted or faked")

  test.beforeEach(async ({ page }) => signInOwner(page, email!, password!))

  test("A · Home attention → Deal → Finding → Evidence → Risk → Work → verified outcome", async ({ page }) => {
    await expect(page.getByRole("table", { name: "Ranked attention" })).toBeVisible({ timeout: 45_000 })
    await assertKeyboardInspector(page)
    await page.locator(".pw-attention-row").first().locator("td:nth-child(2) .pw-entity-link").click()
    await expect(page).toHaveURL(/\/centropy\/deals\/[0-9a-f-]{36}\/overview/)
    const dealId = /\/centropy\/deals\/([0-9a-f-]{36})\/overview/i.exec(new URL(page.url()).pathname)?.[1]
    expect(dealId).toBeTruthy()
    await openDealSection(page, "diligence")
    await page.locator(".pw-deal-section tbody tr").filter({ hasText: /Finding/i }).first().locator(".pw-entity-link").first().click()
    await assertInspectorLineage(page)
    const inspector = page.locator(".pw-inspector[data-open='true']")
    await inspector.getByRole("button", { name: "relationships", exact: true }).click()
    const riskEdge = inspector.locator(".pw-lineage-edge").filter({ hasText: /finding risk/i }).first()
    await expect(riskEdge, "Finding must traverse to its persisted linked Risk inside the universal Inspector").toBeVisible()
    await riskEdge.locator(".pw-entity-link").last().click()
    await expect(inspector.locator(".pw-inspector__header")).toContainText(/deal risk/i)
    await page.keyboard.press("Escape")
    await expect(page.locator(".pw-inspector[data-open='true']")).toHaveCount(0)
    await openDealSection(page, "work")
    await page.locator(".pw-deal-section").getByRole("link", { name: /Open Work/i }).first().click()
    await expect(page).toHaveURL(/\/centropy\/work/)
    await expect(page.getByText("Persisted final outcome").or(page.getByText("No final outcome"))).toBeVisible()
    await expect(page.getByRole("table", { name: "Work semantic Activity" }).or(page.getByText(/Known empty: no Work Activity/))).toBeVisible()
    await certifyRequiredJourneyDimensions(page, dealId!)
  })

  test("B · Deal → Assumption → Underwriting output → source lineage", async ({ page }) => {
    const { dealId } = await openDeterministicDeal(page)
    await expect(page.getByRole("table", { name: "Decision and investment-case objects" })).toContainText(/Assumption/i)
    await page.getByRole("table", { name: "Decision and investment-case objects" }).locator("tr").filter({ hasText: /Assumption/i }).first().locator(".pw-entity-link").click()
    await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator(".pw-inspector[data-open='true']")).toHaveCount(0)
    await openDealSection(page, "underwriting")
    const output = page.getByRole("table", { name: "Underwriting outputs" }).locator("tbody tr").first()
    await expect(output, "the Phase 9 fixture needs a persisted P4 underwriting output").toBeVisible({ timeout: 45_000 })
    await output.getByRole("button", { name: /Explain/i }).click()
    await expect(page.getByText("Exact output lineage")).toBeVisible()
    await expect(page.locator(".pw-lineage-panel .pw-skeleton")).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
    await certifyRequiredJourneyDimensions(page, dealId)
  })

  test("C · Deal → IC Question → evidence → Recommendation → Vote/Dissent → Decision", async ({ page }) => {
    const { dealId } = await openDeterministicDeal(page)
    await openDealSection(page, "ic")
    const table = page.getByRole("table", { name: /IC questions, recommendations, votes, dissents, conditions, and Decision/ })
    await expect(table, "the Phase 9 fixture needs a governed P5 IC case").toBeVisible({ timeout: 45_000 })
    for (const label of [/question/i, /recommendation/i, /vote/i, /dissent/i, /decision/i]) await expect(table.locator("tbody tr").filter({ hasText: label }).first(), `missing structurally valid ${label} fixture`).toBeVisible()
    await table.locator("tbody tr").filter({ hasText: /question/i }).first().locator(".pw-entity-link").click()
    await assertInspectorLineage(page)
    for (const label of [/recommendation/i, /vote/i, /dissent/i, /decision/i]) {
      await page.keyboard.press("Escape")
      await expect(page.locator(".pw-inspector[data-open='true']")).toHaveCount(0)
      await table.locator("tbody tr").filter({ hasText: label }).first().locator(".pw-entity-link").click()
      await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
    }
    await certifyRequiredJourneyDimensions(page, dealId)
  })

  test("D · Deal → closing blocker → governed Work/action → verification → readiness", async ({ page }) => {
    const { dealId } = await openDeterministicDeal(page)
    await openDealSection(page, "closing")
    const readiness = page.getByRole("table", { name: "Closing readiness questions" })
    const closingObjects = page.getByRole("table", { name: "Closing conditions and items" })
    await expect(page.locator(".pw-context-header")).toContainText("1/2 terminal checks")
    await expect(readiness.locator("tbody tr").filter({ hasText: "Are all required closing items complete?" })).toContainText("1/1 represented objects are terminal")
    await expect(closingObjects.locator("tbody tr").filter({ hasText: "QoE evidence package is indexed in the closing record." })).toContainText(/VERIFIED/i)
    const blocker = closingObjects.locator("tbody tr").filter({ hasText: /OPEN|PENDING|FAILED/i }).first()
    await expect(blocker, "the Phase 9 fixture needs a non-terminal closing object").toBeVisible({ timeout: 45_000 })
    await blocker.locator(".pw-entity-link").click()
    await page.locator(".pw-inspector").getByRole("button", { name: "authority", exact: true }).click()
    await expect(page.locator(".pw-inspector__body")).toContainText(/Selection grants no authority/)
    await page.keyboard.press("Escape")
    await expect(page.locator(".pw-inspector[data-open='true']")).toHaveCount(0)
    await openDealSection(page, "work")
    const governedWork = page.getByRole("table", { name: "Deal-linked Work" }).locator("tbody tr").filter({ hasText: /Verify Atlas QoE evidence/i })
    await expect(governedWork, "closing verification must resolve to the exact root-linked governed Work").toBeVisible()
    const workResponsePromise = page.waitForResponse((response) => response.request().method() === "GET" && /\/api\/centropy\/works\/[0-9a-f-]{36}$/i.test(new URL(response.url()).pathname))
    await governedWork.getByRole("link", { name: /Open Work/i }).click()
    const workResponse = await workResponsePromise
    expect(workResponse.status(), "the UI must read the canonical P6 Work aggregate").toBe(200)
    const { work } = await workResponse.json() as { work: WorkAggregateView }
    const action = work.actions.find((item) => item.actionType === "submit_condition_evidence")
    expect(action).toMatchObject({ status: "completed" })
    expect(action?.groundedPayload).toMatchObject({ dealId, closingConditionId: expect.any(String), closingItemId: expect.any(String), evidenceVersionId: expect.any(String) })
    expect(work.businessEffects.find((item) => item.domainActionId === action?.id)).toMatchObject({ status: "verified", observedResult: { closingItemState: "verified", conditionState: "evidence_pending" } })
    expect(work.receipts.find((item) => item.domainActionId === action?.id)).toMatchObject({ actualResult: { closingItemState: "verified", conditionState: "evidence_pending" }, failure: null, finalizedAt: expect.any(String) })
    expect(work.planRevisions.some((item) => typeof item.completionProof === "object" && item.completionProof !== null && (item.completionProof as { verified?: unknown }).verified === true)).toBe(true)
    const sequence = page.getByLabel("Work business sequence")
    await expect(sequence).toContainText("1 action · 1 effect")
    await expect(sequence).toContainText("1 receipt")
    await expect(sequence).toContainText("Persisted final outcome")
    const execution = page.getByRole("table", { name: "Plan and execution" })
    await expect(execution).toContainText(/Completion proof recorded/)
    await expect(execution).toContainText(/Submit Condition Evidence/)
    await expect(execution).toContainText(/Business effect/)
    await expect(execution).toContainText(/Verification recorded/)
    await expect(execution).toContainText(/Decision receipt/)
    const workActivity = page.getByRole("table", { name: "Work semantic Activity" })
    await expect(workActivity).toContainText(/Action Completed/)
    await expect(workActivity).toContainText(/Business effect Verified/)
    await expect(workActivity).toContainText(/Decision receipt finalized/)
    await expect(workActivity).toContainText(/Completion proof verified/)
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(/\/closing/)
    await expect(page.locator(".pw-context-header")).toContainText("1/2 terminal checks")
    await expect(page.getByRole("table", { name: "Closing conditions and items" }).locator("tbody tr").filter({ hasText: "QoE evidence package is indexed in the closing record." })).toContainText(/VERIFIED/i)
    await page.goForward()
    await page.goForward()
    await expect(page).toHaveURL(/\/centropy\/work/)
    await certifyRequiredJourneyDimensions(page, dealId)
  })

  test("E · Agent → assignment → Work → execution → evidence → verified outcome", async ({ page }) => {
    const { dealId } = await openDeterministicDeal(page)
    await page.getByRole("navigation", { name: "Private Equity operating surfaces" }).getByRole("link", { name: "Agents", exact: true }).click()
    const table = page.getByRole("table", { name: "Business-shaped governed AI workforce" })
    await expect(table, "the Phase 9 fixture needs a root-linked P7 AgentProfile assignment").toBeVisible({ timeout: 45_000 })
    const row = table.locator("tbody tr").filter({ hasText: /running|waiting|completed|failed/i }).first()
    await row.locator("td:first-child .pw-entity-link").click()
    const inspector = page.locator(".pw-inspector[data-open='true']")
    await expect(inspector).toBeVisible()
    await inspector.getByRole("button", { name: "relationships", exact: true }).click()
    const assignmentEdge = inspector.locator(".pw-lineage-edge").filter({ hasText: /assignment agent/i }).first()
    await expect(assignmentEdge, "Agent must traverse to its persisted workforce assignment").toBeVisible()
    await assignmentEdge.locator(".pw-entity-link").first().click()
    await expect(inspector.locator(".pw-inspector__header")).toContainText(/agent assignment/i)
    await inspector.getByRole("button", { name: "relationships", exact: true }).click()
    const workEdge = inspector.locator(".pw-lineage-edge").filter({ hasText: /assignment work/i }).first()
    await expect(workEdge, "Assignment must traverse to its persisted canonical Work").toBeVisible()
    await workEdge.locator(".pw-entity-link").last().click()
    await expect(page).toHaveURL(/\/centropy\/work/)
    await expect(inspector.locator(".pw-inspector__header")).toContainText(/work/i)
    await expect(page.getByRole("table", { name: "Plan and execution" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("5 · Verification")).toBeVisible()
    await expect(page.getByText("6 · Outcome")).toBeVisible()
    await certifyRequiredJourneyDimensions(page, dealId)
  })

  test("governed command persists Work before representing an outcome", async ({ page }) => {
    const { dealId } = await openDeterministicDeal(page)
    await page.evaluate(() => {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: () => "90000000-0000-4000-8000-000000000090",
      })
    })
    await page.route("**/api/centropy/works/*", async (route) => {
      // Keep the real backend response, but hold it long enough to certify that
      // VERIFYING is a visible state rather than an unreachable render branch.
      await new Promise((resolve) => setTimeout(resolve, 450))
      await route.continue()
    })

    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K")
    const command = page.locator(".pw-command[role='dialog']")
    await command.locator("#pw-global-command").fill("Show company relationships?")
    await command.getByRole("button", { name: "Review command" }).click()
    await expect(command).toHaveAttribute("data-stage", "review")
    await expect(command).toContainText("May create or continue canonical Work and propose governed actions. It does not grant authority.")
    await expect(command).toContainText("Policy and Authority are evaluated by the backend at execution")
    await expect(command.getByRole("list", { name: "Governed action lifecycle" }).getByRole("listitem")).toHaveText([
      "PROPOSE",
      "REVIEW CONSEQUENCE",
      "AUTHORITY",
      "EXECUTING",
      "VERIFYING",
      "OUTCOME",
      "RECEIPT",
    ])

    const actionResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/centropy/actions"))
    const aggregateResponsePromise = page.waitForResponse((response) => response.request().method() === "GET" && /\/api\/centropy\/works\/[0-9a-f-]{36}$/i.test(new URL(response.url()).pathname))
    await command.getByRole("button", { name: "Propose to CENTROPY" }).click()
    await expect(command).toHaveAttribute("data-stage", "executing")
    const actionResponse = await actionResponsePromise
    expect([200, 201], "the command must reach real governed intake or its persisted idempotent replay").toContain(actionResponse.status())
    const actionBody = await actionResponse.json() as { workId?: string; query?: { request?: { intent?: string } } }
    expect(actionBody.workId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(actionBody.query?.request?.intent).toBe("company_context")

    await expect(command).toHaveAttribute("data-stage", "verifying")
    const aggregateResponse = await aggregateResponsePromise
    expect(aggregateResponse.url()).toContain(`/api/centropy/works/${actionBody.workId}`)
    expect(aggregateResponse.status(), "verification must reread the persisted canonical Work aggregate").toBe(200)
    const aggregateBody = await aggregateResponse.json() as { work?: { work?: { id?: string; status?: string } } }
    expect(aggregateBody.work?.work?.id).toBe(actionBody.workId)
    expect(aggregateBody.work?.work?.status).toBe("completed")

    await expect(command).toHaveAttribute("data-stage", "outcome")
    await expect(command).toContainText("Accepted; verification is not complete")
    await expect(command).toContainText("No recorded proof")
    await expect(command).not.toContainText("Verified outcome")
    await command.getByRole("button", { name: "Inspect Work" }).click()
    await expect(page.locator(".pw-inspector[data-open='true']")).toBeVisible()
    expect(new URL(page.url()).searchParams.get("root")).toContain(dealId)
    expect(new URL(page.url()).searchParams.get("inspect")).toContain(actionBody.workId!)
    await page.unroute("**/api/centropy/works/*")
  })

  test("captures desktop visual evidence for every primary route", async ({ page }, testInfo) => {
    test.setTimeout(600_000)
    test.skip(testInfo.project.name !== "desktop-chromium", "desktop visual evidence only")
    const { dealId } = await openDeterministicDeal(page)
    const root = new URL(page.url()).searchParams.get("root")
    expect(root).toBeTruthy()
    await openDealSection(page, "work")
    const workHref = await page.getByRole("link", { name: /Open Work/i }).first().getAttribute("href")
    expect(workHref, "visual evidence for Work must carry a real persisted Work selection").toBeTruthy()

    const withRoot = (path: string) => {
      const url = new URL(path, "http://phase9.local")
      url.searchParams.set("root", root!)
      return `${url.pathname}${url.search}`
    }
    const primaryRoutes = [
      { name: "home", path: withRoot("/centropy"), ready: () => page.getByRole("table", { name: "Ranked attention" }) },
      { name: "deals", path: withRoot("/centropy/deals?sort=name"), ready: () => page.getByRole("table", { name: "Firm Deal master" }) },
      { name: "work", path: workHref!, ready: () => page.getByRole("table", { name: "Plan and execution" }) },
      { name: "agents", path: withRoot("/centropy/agents"), ready: () => page.getByRole("table", { name: "Business-shaped governed AI workforce" }) },
      ...PHASE9_DEAL_SECTIONS.map((section) => ({
        name: `deal-${section}`,
        path: withRoot(`/centropy/deals/${dealId}/${section}`),
        ready: () => section === "overview" ? page.locator('[aria-label="Deal synthesis"]')
          : section === "underwriting" ? page.getByRole("table", { name: "Underwriting outputs" })
            : section === "diligence" ? page.getByRole("table", { name: "Diligence workstreams, requests, findings, risks, dependencies, and milestones" })
              : section === "ic" ? page.locator('[aria-label="IC governance state"]')
                : section === "evidence" ? page.getByRole("table", { name: "Documents, evidence, observations, coverage, and conflicts" })
                  : section === "closing" ? page.getByRole("table", { name: "Closing readiness questions" })
                    : section === "work" ? page.getByRole("table", { name: "Deal-linked Work" })
                      : page.getByRole("table", { name: "Semantic causal Activity" }),
      })),
    ]
    const evidenceDir = testInfo.outputPath("phase9-primary-routes")
    const durableEvidenceDir = join(process.cwd(), "artifacts", "phase9", "desktop")
    await mkdir(evidenceDir, { recursive: true })
    await mkdir(durableEvidenceDir, { recursive: true })
    for (const route of primaryRoutes) {
      await page.goto(route.path)
      await expect(page.locator(".pw-global-bar")).toBeVisible()
      await expect(page.locator(".pw-object-group").first().locator("b"), `${route.name} must resolve the exact Deal projection, not an intermediate empty shell`).toHaveText("1", { timeout: 45_000 })
      await expect(route.ready(), `${route.name} must contain its real source-backed primary surface before capture`).toBeVisible({ timeout: 45_000 })
      await expect(page.locator(".pw-active-workspace .pw-skeleton")).toHaveCount(0, { timeout: 45_000 })
      await expect(page.locator(".pw-active-workspace > .pw-protected-state")).toHaveCount(0)
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" })
      const artifact = join(evidenceDir, `${route.name}.png`)
      await page.screenshot({ path: artifact, fullPage: true, animations: "disabled", caret: "hide" })
      await page.screenshot({ path: join(durableEvidenceDir, `${route.name}.png`), fullPage: true, animations: "disabled", caret: "hide" })
      // Stabilize only timestamp layout/glyphs for pixel comparison. Proportional
      // clock digits can otherwise wrap a live time from two lines to three and
      // move every following table row. The unmodified, human-readable route
      // capture above remains the visual QA artifact.
      await page.locator("time").evaluateAll((elements) => {
        for (const element of elements) element.textContent = "STABLE TIMESTAMP"
      })
      await page.addStyleTag({ content: "time { color: transparent !important; text-shadow: none !important; }" })
      await expect(page).toHaveScreenshot(`${route.name}.png`, { fullPage: true, animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01 })
    }
  })
})
