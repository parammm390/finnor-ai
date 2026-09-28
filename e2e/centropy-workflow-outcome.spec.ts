import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { awaitFixtureRateWindow } from "./fixtures/rate-window"

test("recorded workflow recovery preserves partial evidence and a bounded shadow mission restores exact Work", async ({ page }, info) => {
  test.setTimeout(240_000)
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1", "Authored loopback fixture only")
  await awaitFixtureRateWindow(info)
  const root = process.cwd()
  const stack = JSON.parse(await readFile(".centropy-certification/atlas-final-v2/stack.json", "utf8"))
  const worker = stack.pids.worker
  const args = spawnSync("ps", ["-p", String(worker), "-o", "command="], { encoding: "utf8" }).stdout
  expect(args).toContain("apps/worker")
  process.kill(worker, "SIGSTOP")
  const require = createRequire(`${root}/finnor-os/package.json`)
  const client = new (require("pg").Client)({ connectionString: "postgres://finnor_app:finnor_app@127.0.0.1:55441/finnor" })
  await client.connect()
  const observed: Record<string, unknown> = { workerHold: { pid: worker, observedCommand: args.trim(), reason: "Prevent authored fixture job delivery while certifying run controls" } }
  let verified = false
  let headers: Record<string, string> = {}
  try {
    const seeded = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-centropy-workflow-control.ts"], { cwd: `${root}/finnor-os`, encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgres://finnor_app:finnor_app@127.0.0.1:55441/finnor" } })
    expect(seeded.status, seeded.stderr).toBe(0)
    const fixture = JSON.parse(await readFile(".centropy-certification/atlas-final-v2/workflow-control-fixture.json", "utf8"))
    observed.fixture = fixture
    console.info("Authored known failure created; starting real owner sign-in")
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(process.env.TEST_OWNER_EMAIL!)
    await page.getByLabel("Password").fill(process.env.TEST_OWNER_PASSWORD!)
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const identity = await me
    expect(identity.status()).toBe(200)
    expect(await identity.json()).toMatchObject({ tenantId: fixture.tenantId, employeeId: fixture.ownerId })
    console.info("Actual owner and tenant verified; opening recorded recovery")
    headers = { authorization: (await identity.request().headerValue("authorization"))! }
    await page.getByText("Inspect workflow recovery", { exact: true }).click()
    const desk = page.getByRole("region", { name: "Durable workflow recovery" })
    await desk.getByLabel("Exact workflow run").selectOption(fixture.workflowRunId)
    await expect(desk).toContainText(`Recorded state: failed · version ${fixture.run.version}`)
    await desk.getByLabel("Record operation").selectOption("http.post.workflows.runs.$id.retry")
    await desk.getByRole("button", { name: "Review record change", exact: true }).click()
    await desk.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
    const retried = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/workflows/runs/${fixture.workflowRunId}/retry` && r.request().method() === "POST")
    await desk.getByRole("button", { name: "Record reviewed change", exact: true }).click()
    const retry = await retried
    expect(retry.status(), await retry.text()).toBe(200)
    observed.retry = await retry.json()
    await expect(desk).toContainText(`Recorded state: running · version ${fixture.run.version + 1}`)
    const stale = await page.request.post(`/api/centropy/workflows/runs/${fixture.workflowRunId}/retry`, { headers, data: { expectedVersion: fixture.run.version } })
    expect(stale.status()).toBe(409)
    observed.staleVersionStatus = stale.status()
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenantId])
    const steps = (await client.query("SELECT id,status,execution_state,evidence,dispatch_generation FROM finnor_os.workflow_steps WHERE tenant_id=$1 AND workflow_run_id=$2 ORDER BY sequence", [fixture.tenantId, fixture.workflowRunId])).rows
    await client.query("COMMIT")
    expect(steps[0]).toMatchObject({ status: "completed", execution_state: "verified", evidence: fixture.steps.find((s: { sequence: number }) => s.sequence === 0).evidence })
    expect(steps[1]).toMatchObject({ status: "pending", execution_state: "authorized", dispatch_generation: fixture.steps.find((s: { sequence: number }) => s.sequence === 1).dispatchGeneration + 1 })
    observed.recoveredSteps = steps
    await desk.getByLabel("Record operation").selectOption("http.post.workflows.runs.$id.cancel")
    await desk.getByRole("button", { name: "Review record change", exact: true }).click()
    await desk.getByRole("checkbox", { name: "I reviewed this exact record change." }).check()
    const cancelled = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/centropy/workflows/runs/${fixture.workflowRunId}/cancel` && r.request().method() === "POST")
    await desk.getByRole("button", { name: "Record reviewed change", exact: true }).click()
    const cancel = await cancelled
    expect(cancel.status(), await cancel.text()).toBe(200)
    observed.cancel = await cancel.json()
    await expect(desk).toContainText(`Recorded state: cancelled · version ${fixture.run.version + 2}`)
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixture.tenantId])
    const receipts = (await client.query("SELECT id,objective,approval,actual_result,finalized_at FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND workflow_run_id=$2 AND workflow_step_id IS NULL ORDER BY created_at", [fixture.tenantId, fixture.workflowRunId])).rows
    await client.query("COMMIT")
    expect(receipts).toHaveLength(2)
    expect(receipts.every((r: { finalized_at: string; approval: { approvedBy: string } }) => r.finalized_at && r.approval.approvedBy === fixture.ownerId)).toBe(true)
    observed.controlReceipts = receipts
    console.info("Retry, stale-version rejection, cancellation and control receipts verified")
    process.kill(worker, "SIGCONT")
    observed.workerResumed = true

    const dealId = "90000000-0000-4000-8000-000000000001"
    await page.goto(`/centropy?root=${encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))}`)
    await page.getByRole("button", { name: "Explore bounded missions", exact: true }).click()
    const catalog = await page.request.get("/api/centropy/outcome-packs", { headers })
    expect(catalog.status()).toBe(200)
    const packs = await catalog.json()
    observed.catalog = packs
    const pack = packs.packs.find((p: { definition: { id: string } }) => p.definition.id === "deal_to_verified_closing_readiness")
    await page.getByRole("button", { name: `${pack.definition.title}`, exact: false }).click()
    await page.getByLabel("Execution mode").selectOption("shadow")
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/centropy/outcome-packs" && r.request().method() === "POST")
    await page.getByRole("button", { name: `Start for Deal ${dealId.slice(0, 8)}`, exact: true }).click()
    const response = await started
    expect(response.status(), await response.text()).toBeLessThan(300)
    const accepted = await response.json()
    const input = response.request().postDataJSON()
    expect(input).toMatchObject({ packId: "deal_to_verified_closing_readiness", input: { dealId, mode: "shadow" } })
    expect(accepted.outcomePack.workId).toBeTruthy()
    observed.mission = { input, accepted }
    console.info("Bounded shadow mission accepted; checking reload and exact replay")
    await expect(page.locator(".ct-missions__current")).toContainText("BOUND MISSION · shadow", { timeout: 30_000 })
    await page.reload()
    await expect(page.locator(".ct-missions__current")).toContainText("BOUND MISSION · shadow")
    const repeated = await page.request.post("/api/centropy/outcome-packs", { headers, data: input })
    expect(repeated.status(), await repeated.text()).toBeLessThan(300)
    expect((await repeated.json()).outcomePack.workId).toBe(accepted.outcomePack.workId)
    const stop = await page.request.post("/api/centropy/instructions/" + accepted.outcomePack.instructionId + "/cancel", { headers, data: { reason: "Authored shadow mission certification completed" } })
    expect([200, 409]).toContain(stop.status())
    observed.missionStopped = { status: stop.status(), result: await stop.json() }
    verified = true
  } finally {
    if (!observed.workerResumed) process.kill(worker, "SIGCONT")
    await client.end()
    const path = info.outputPath("workflow-outcome.proof.json")
    const screenshotPath = info.outputPath("workflow-outcome.png")
    const bytes = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    await writeFile(path, JSON.stringify({ schema: "centropy.workflow-outcome-proof/v1", result: verified ? "PASS" : "INCOMPLETE", capturedAt: new Date().toISOString(), observed, steps: ["Create an authored canonical workflow with a real local read and controlled known failure", "Sign in as the actual owner and inspect exact run/steps", "Review and retry the recorded version", "Reject a stale version and independently prove the completed step/evidence survived and failed step was redriven", "Cancel the authored fixture and independently read both finalized control receipts", "Start a bounded shadow Outcome Pack through the normal UI, restore on reload, replay exact intake and stop the fixture"], screenshotSha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null, limitations: ["Authored disposable local-read workflow; no provider effect or live business workflow completion is claimed", "Outcome Pack shadow mode does not certify autopilot eligibility or external effects"], reproduce: "node scripts/centropy/run-local-e2e.mjs e2e/centropy-workflow-outcome.spec.ts --project=desktop-chromium --workers=1" }, null, 2) + "\n")
    await info.attach("workflow-outcome-proof", { path, contentType: "application/json" })
  }
})
