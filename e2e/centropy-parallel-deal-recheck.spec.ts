import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Recheck the entire deal before IC."
const intents = ["pe_world_state", "open_findings", "open_deal_risks"]

test("Atlas whole-deal recheck uses independent governed specialist reads", async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(new URL(baseUrl).hostname), "Disposable localhost fixture only")
  test.skip(!email || !password, "Owner sign-in is required")
  await awaitFixtureRateWindow(testInfo)
  const proofPath = testInfo.outputPath("centropy-parallel-deal-recheck.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-parallel-deal-recheck.png")
  const observed: Record<string, unknown> = { workId: null, threadId: null, objectiveLoopId: null,
    workStatus: null, objectiveState: null, planId: null, queryNodes: null, assignments: null,
    queryExecutions: null, verification: null, completionProof: null, canvasReads: null,
    overlapPairs: null, workforceVisible: false, canvasVisible: false }
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
    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy?root=${root}`)
    await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i, { timeout: 35_000 })
    await page.getByLabel("Message CENTROPY").fill(instruction)
    const submitPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/centropy/actions")
    await page.getByRole("button", { name: "Send instruction" }).click()
    const submitted = await submitPromise
    expect(submitted.status(), await submitted.text()).toBe(202)
    const accepted = await submitted.json() as { workId: string; threadId: string; objective?: { objectiveLoopId: string } }
    observed.workId = accepted.workId
    observed.threadId = accepted.threadId
    observed.objectiveLoopId = accepted.objective?.objectiveLoopId ?? null
    type Assignment = { id: string; capability: string; nodeKind: string; state: string; agentProfileId: string;
      startedAt: string | null; completedAt: string | null; planNodeId: string }
    type Work = { work: { status: string }; objectiveLoop?: { state: string; reason?: string; successVerification?: { state: string; results: Array<{ kind: string; satisfied: boolean; evidenceRefs: Array<{ type: string; id: string }> }> } };
      planRevisions: Array<{ id: string; status: string; planGraph: { nodes: Array<{ id: string; kind: string; request?: { intent: string }; dependsOn: string[] }> }; completionProof?: { verified?: boolean; evidenceRefs?: Array<{ type: string; id: string }> } }>;
      workforceAssignments: Assignment[]; queryExecutions: Array<{ id: string; intent: string; status: string; resultSummary: unknown }> }
    const readWork = async (): Promise<Work> => {
      const response = await page.request.get(`/api/centropy/works/${accepted.workId}`, { headers: { authorization: authorization! }, timeout: 25_000 })
      expect(response.ok(), `Work read: ${response.status()}`).toBe(true)
      return (await response.json() as { work: Work }).work
    }
    await expect.poll(async () => {
      const work = await readWork()
      observed.workStatus = work.work.status
      observed.objectiveState = work.objectiveLoop?.state ?? null
      if (["failed", "blocked", "cancelled"].includes(work.objectiveLoop?.state ?? "")) throw new Error(`Objective stopped: ${work.objectiveLoop?.reason}`)
      return work.objectiveLoop?.state ?? null
    }, { timeout: 180_000, intervals: [2_000, 4_000] }).toBe("completed")
    const work = await readWork()
    expect(work.work.status).toBe("completed")
    const plan = work.planRevisions.find((item) => item.status === "completed")
    expect(plan?.completionProof?.verified).toBe(true)
    const queryNodes = plan!.planGraph.nodes.filter((node) => node.kind === "query")
    expect(queryNodes.map((node) => node.request?.intent).sort()).toEqual([...intents].sort())
    expect(queryNodes.every((node) => node.dependsOn.length === 0)).toBe(true)
    const checkNodes = plan!.planGraph.nodes.filter((node) => node.kind === "check")
    expect(checkNodes.length).toBeGreaterThanOrEqual(3)
    expect(checkNodes.every((node) => queryNodes.every((query) => node.dependsOn.includes(query.id)))).toBe(true)
    const assignments = work.workforceAssignments.filter((item) => item.nodeKind === "query" && intents.some((intent) => item.capability === `query:${intent}`))
    expect(assignments.map((item) => item.capability).sort()).toEqual(intents.map((intent) => `query:${intent}`).sort())
    expect(assignments.every((item) => item.state === "completed" && item.startedAt && item.completedAt)).toBe(true)
    const overlaps = assignments.flatMap((left, index) => assignments.slice(index + 1).flatMap((right) =>
      Date.parse(left.startedAt!) < Date.parse(right.completedAt!) && Date.parse(right.startedAt!) < Date.parse(left.completedAt!)
        ? [[left.id, right.id]] : []))
    observed.overlapPairs = overlaps
    expect(overlaps.length, "at least two specialist assignments must actually overlap").toBeGreaterThan(0)
    const executions = work.queryExecutions.filter((item) => intents.includes(item.intent) && item.status === "succeeded")
    expect(intents.every((intent) => executions.some((item) => item.intent === intent))).toBe(true)
    const verification = work.objectiveLoop?.successVerification
    expect(verification?.state).toBe("verified")
    expect(verification?.results.filter((result) => result.kind === "canonical_query")).toHaveLength(3)
    expect(verification?.results.filter((result) => result.kind === "canonical_query").every((result) => result.satisfied)).toBe(true)
    observed.planId = plan!.id
    observed.queryNodes = queryNodes
    observed.assignments = assignments
    observed.queryExecutions = executions
    observed.verification = verification
    observed.completionProof = plan!.completionProof

    await page.goto(`/centropy/investigations/${accepted.threadId}`)
    await expect(page.locator(".ct-objective__top")).toContainText("completed", { timeout: 35_000 })
    await page.getByRole("button", { name: "Inspect specialist assignments" }).click()
    const workforce = page.getByRole("region", { name: "Persisted specialist assignments" })
    await expect(workforce).toContainText("assignments linked to this Work", { timeout: 35_000 })
    for (const intent of intents) await expect(workforce).toContainText(`query:${intent}`)
    observed.workforceVisible = true
    const canvas = page.getByRole("main", { name: "Investigation Canvas" })
    await expect(canvas).toContainText("completed canonical reads", { timeout: 35_000 })
    await expect(canvas).toContainText("open findings")
    await expect(canvas).toContainText("open deal risks")
    observed.canvasReads = await canvas.locator(".ct-work-stages").innerText()
    observed.canvasVisible = true
    await page.reload()
    await expect(page.getByRole("main", { name: "Investigation Canvas" })).toContainText("completed canonical reads", { timeout: 35_000 })
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(proofPath, JSON.stringify({ schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_parallel_deal_recheck",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email, input: { dealId, instruction }, observed,
      steps: ["Authenticate owner and submit the exact whole-Deal recheck", "Inspect the immutable PlanGraph for three independent Deal-bound canonical reads and dependent checks",
        "Wait for actual specialist assignments and verify overlapping execution intervals", "Verify the three Work-linked queries and terminal success/CompletionProof",
        "Reopen the Thread, inspect individual specialist assignments, Canvas source-read counts, and reload persistence"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: "CENTROPY_DISPOSABLE_E2E=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-parallel-deal-recheck.spec.ts --project=desktop-chromium",
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas Deal and local worker stack"] },
      limitation: "Local fixture proof. Release-host execution, operator redirection during live specialist work, and material source synthesis remain open.",
    }, null, 2) + "\n")
    await testInfo.attach("centropy-parallel-deal-recheck-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-parallel-deal-recheck-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
