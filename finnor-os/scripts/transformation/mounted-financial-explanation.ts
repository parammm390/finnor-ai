import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { open, readFile, readdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, expect as browserExpect, type Page } from "playwright/test"

const expect = browserExpect.configure({ timeout: 12_000 })

interface MountedWorkspace {
  output: string
  authOrigin: string
  apiOrigin: string
  email: string
}

interface MountedFixture extends MountedWorkspace {
  peerEmail: string
  createSiblingThread: () => Promise<string>
  instruction: string
  secondProposalStarted: Promise<void>
  releaseSecondProposal: () => void
}

async function signIn(page: Page, origin: string, email: string) {
  await page.goto(origin + "/centropy/login")
  await page.getByLabel("Email", { exact: true }).fill(email)
  await page.getByLabel("Password", { exact: true }).fill("local-disposable-no-authority")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message CENTROPY" })).toBeVisible()
}

async function withMountedWorkspace<T>(
  fixture: MountedWorkspace,
  inspect: (input: { page: Page; origin: string; steps: string[]; pageErrors: string[] }) => Promise<T>,
) {
  const repository = resolve(import.meta.dirname, "../../..")
  const paths = await readdir(repository)
  if (paths.some(path => /^\.env(?:\.development)?(?:\.local)?$/.test(path))) {
    throw new Error("Mounted acceptance requires a checkout without a Next.js environment file")
  }
  for (const origin of [fixture.authOrigin, fixture.apiOrigin]) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Disposable loopback endpoints required")
  }
  const probe = createServer()
  const port = await new Promise<number>((ready, fail) => {
    probe.once("error", fail)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(error => {
        if (error || !address || typeof address === "string") fail(error ?? new Error("Missing loopback address"))
        else ready(address.port)
      })
    })
  })
  const origin = "http://127.0.0.1:" + port
  const log = await open(resolve(fixture.output, "mounted-next.log"), "w", 0o600)
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: repository, detached: true, stdio: ["ignore", log.fd, log.fd],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NEXT_TEST_NATIVE_DIR: process.env.NEXT_TEST_NATIVE_DIR,
      NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_SUPABASE_URL: fixture.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: "disposable-publishable-not-live",
      FINNOR_OS_API_URL: fixture.apiOrigin,
    },
  })
  const exited = new Promise(resolveExit => { child.once("error", resolveExit); child.once("close", resolveExit) })
  const startedAt = Date.now()
  const steps: string[] = [], pageErrors: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let page: Page | undefined
  let status = "FAIL"
  let error: string | undefined
  try {
    const deadline = Date.now() + 75_000
    for (;;) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Disposable Next.js login route did not become ready")
      const response = await fetch(origin + "/centropy/login", { signal: AbortSignal.timeout(5_000) }).catch(() => null)
      if (response?.ok) break
      await delay(250)
    }
    browser = await chromium.launch({ headless: true, timeout: 15_000 })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(12_000)
    page.on("pageerror", failure => pageErrors.push(failure.message))
    const result = await inspect({ page, origin, steps, pageErrors })
    status = "PASS"
    return result
  } catch (failure) {
    error = String(failure)
    if (page) await writeFile(resolve(fixture.output, "mounted-failure-ax.txt"), await page.locator("body").ariaSnapshot({ timeout: 3000 }).catch(() => ""), { mode: 0o600 })
    throw failure
  } finally {
    await browser?.close()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGTERM")
      await Promise.race([exited, delay(3000)])
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL")
    }
    await log.close()
    await writeFile(resolve(fixture.output, "mounted-browser-result.json"), JSON.stringify({ status, steps, pageErrors, error, elapsedMs: Date.now() - startedAt }, null, 2) + "\n", { mode: 0o600 })
  }
}

export async function verifyMountedFinancialExplanation(fixture: MountedFixture) {
  let releaseList = () => {}
  return withMountedWorkspace(fixture, async ({ page, origin, steps, pageErrors }) => {
    try {
      let listStarted = () => {}
      const listRequest = new Promise<void>(ready => { listStarted = ready })
      const listGate = new Promise<void>(release => { releaseList = release })
      await page.route(url => url.origin === origin && url.pathname === "/api/centropy/threads" && url.searchParams.has("limit"), async route => {
        listStarted()
        await listGate
        await route.continue()
      }, { times: 1 })
      await signIn(page, origin, fixture.email)
      const recent = page.getByRole("region", { name: "Recent Investigations" })
      await Promise.race([listRequest, delay(10_000).then(() => { throw new Error("Recent list did not start") })])
      await expect(recent.getByRole("status")).toHaveText("Loading your Investigations…")
      await expect(recent.getByText(/No Investigations yet/)).toHaveCount(0)
      await page.screenshot({ path: resolve(fixture.output, "mounted-loading.png") })
      releaseList()
      await expect(recent.getByText(/No Investigations yet/)).toBeVisible()
      steps.push("signed in and observed loading before actual empty history")

      const answers = page.getByRole("article", { name: "Answer and supporting calculations" })
      const figures = ["USD 160,000,000", "USD 100,000,000", "USD 105,000,000", "USD 144,000,000", "USD 84,000,000", "USD 89,000,000", "USD 16,000,000"]
      const actionResponse = () => page.waitForResponse(response => response.url() === origin + "/api/centropy/actions" && response.request().method() === "POST")
      const submit = async () => {
        await page.getByRole("textbox", { name: "Message CENTROPY" }).fill(fixture.instruction)
        await page.getByRole("button", { name: "Send instruction" }).click()
      }
      const received = actionResponse()
      await submit()
      const raw = await received
      const request = raw.request().postDataJSON()
      const response = { status: raw.status(), body: await raw.json() }
      expect(request.instruction).toBe(fixture.instruction)
      expect(response.status).toBe(201)
      expect(response.body.objective).toBeUndefined()
      await expect(answers.getByRole("cell")).toHaveText(figures)
      await page.screenshot({ path: resolve(fixture.output, "mounted-answer.png") })
      await answers.getByText("Inspect formulas and exact values", { exact: true }).click()
      await answers.getByText("Inspect supplied sources", { exact: true }).click()
      await expect(answers.getByText("Exact value: 160000000 USD", { exact: true })).toBeVisible()
      await expect(answers.getByText("Source B: FY2025 EBITDA USD 18 million.", { exact: true })).toBeVisible()
      await page.screenshot({ path: resolve(fixture.output, "mounted-sources.png") })
      await writeFile(resolve(fixture.output, "mounted-answer-ax.txt"), await answers.ariaSnapshot(), { mode: 0o600 })
      steps.push("submitted original FIN-01 and inspected seven calculations and sources")

      const answerPath = "/centropy/investigations/" + response.body.threadId
      await expect(page).toHaveURL(origin + answerPath)
      await answers.getByRole("button", { name: "Inspect Work history" }).click()
      await expect(answers).toHaveCount(0)
      await page.getByRole("button", { name: "Back to answer" }).click()
      await expect(answers.getByRole("cell")).toHaveText(figures)
      await page.reload()
      await expect(answers.getByRole("cell")).toHaveText(figures)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas", exact: true }).click()
      await expect(answers.getByRole("cell").first()).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      await page.screenshot({ path: resolve(fixture.output, "mounted-answer-mobile.png") })
      await page.setViewportSize({ width: 1440, height: 1000 })
      steps.push("restored the persisted result after history, reload and mobile Canvas switch")

      const siblingThreadId = await fixture.createSiblingThread()
      await page.goto(origin + "/centropy/investigations/" + siblingThreadId)
      await expect(page.getByRole("heading", { name: "Cancellation rehearsal", level: 1 })).toBeVisible()
      await expect(answers).toHaveCount(0)
      const stoppedAction = actionResponse()
      await submit()
      await Promise.race([fixture.secondProposalStarted, delay(12_000).then(() => { throw new Error("The second proposal did not start") })])
      const stopResponse = page.waitForResponse(response => response.request().method() === "POST" && /\/instructions\/[^/]+\/cancel$/.test(new URL(response.url()).pathname))
      await page.getByRole("button", { name: "Stop this instruction" }).click()
      const stopped = await stopResponse
      expect(stopped.status()).toBe(200)
      fixture.releaseSecondProposal()
      const settled = await stoppedAction
      const cancelled = { request: settled.request().postDataJSON(), response: { status: settled.status(), body: await settled.json() } }
      expect(cancelled.response.body.answer).toBeUndefined()
      await expect(answers).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Cancellation rehearsal", level: 1 })).toBeVisible()
      steps.push("switched Investigation and stopped an in-flight answer through its actual owner")

      await page.getByRole("button", { name: "Investigations", exact: true }).click()
      await page.getByRole("dialog", { name: "Recent Investigations" }).getByRole("button", { name: /What are the enterprise value/ }).click()
      await expect(answers.getByRole("cell")).toHaveText(figures)
      await page.getByLabel("Account menu").click()
      await page.getByRole("button", { name: "Sign out", exact: true }).click()
      await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible()
      await signIn(page, origin, fixture.peerEmail)
      await expect(answers).toHaveCount(0)
      const refusal = page.waitForResponse(read => new URL(read.url()).pathname === "/api/centropy/threads/" + response.body.threadId)
      await page.goto(origin + answerPath)
      expect((await refusal).status()).toBe(404)
      await expect(page.getByRole("alert").getByText(/conversation_thread_not_found/)).toBeVisible()
      await expect(answers).toHaveCount(0)
      await expect(page.getByText(fixture.instruction, { exact: true })).toHaveCount(0)
      steps.push("returned through history, switched principal, and observed private URL refusal")
      return { request, response, cancelled, figures, steps, pageErrors }
    } finally {
      releaseList()
      fixture.releaseSecondProposal()
    }
  })
}

export function verifyMountedCommitteeMemo(fixture: MountedWorkspace & {
  threadId: string
  dealId: string
  caseId: string
  documentId: string
  versionId: string
  byteSha256: string
  archiveSource: () => Promise<void>
}) {
  return withMountedWorkspace(fixture, async ({ page, origin, steps, pageErrors }) => {
    await signIn(page, origin, fixture.email)
    const query = new URLSearchParams({
      root: JSON.stringify({ entityType: "pe_deal", entityId: fixture.dealId }),
      icCaseId: fixture.caseId,
    })
    await page.goto(`${origin}/centropy/investigations/${fixture.threadId}?${query}`)
    const committee = page.getByRole("navigation", { name: "Canvas instruments" })
      .getByRole("button", { name: /Committee governance/ })
    await committee.click()
    const pinned = page.getByRole("button", { name: `Open memo, pinned version ${fixture.versionId}` })
    await expect(page.getByText("Source evidence is conflicting.", { exact: false })).toBeVisible()
    await expect(pinned).toBeVisible()
    steps.push("loaded the selected Committee case and observed its conflicting source status")
    await pinned.click()
    const paragraphs = page.locator(".ct-artifact__document")
    await expect(paragraphs.getByText(/Underwriting alternatives for disputed EBITDA/)).toBeVisible()
    await expect(paragraphs.getByText(/Enterprise value USD 160,000,000/)).toBeVisible()
    await expect(paragraphs.getByText(/Enterprise value USD 144,000,000/)).toBeVisible()
    await expect(page.getByLabel("Artifact version", { exact: true })).toHaveValue(fixture.versionId)
    await paragraphs.getByText(/Underwriting alternatives for disputed EBITDA/).scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(fixture.output, "mounted-committee-memo.png") })
    const downloadBlobs = await page.evaluateHandle(() => {
      const blobs = new Map<string, Blob>()
      const create = URL.createObjectURL
      URL.createObjectURL = blob => {
        const url = create.call(URL, blob)
        if (blob instanceof Blob) blobs.set(url, blob)
        return url
      }
      return { blobs, restore: () => { URL.createObjectURL = create } }
    })
    const pendingResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return response.request().method() === "GET" && url.origin === origin
        && url.pathname === `/api/centropy/documents/${fixture.documentId}`
        && url.searchParams.get("versionId") === fixture.versionId
    })
    const pendingDownload = page.waitForEvent("download")
    await page.getByRole("button", { name: "Download exact version" }).click()
    const [response, download] = await Promise.all([pendingResponse, pendingDownload])
    expect(response.status()).toBe(200)
    expect(download.suggestedFilename()).toMatch(/\.docx$/)
    const payload = Buffer.from(await downloadBlobs.evaluate(async ({ blobs, restore }, url) => {
      restore()
      const blob = blobs.get(url)
      if (!blob) throw new Error("The browser download did not use the observed artifact bytes")
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, download.url()))
    const browserBlobSha256 = createHash("sha256").update(payload).digest("hex")
    expect(browserBlobSha256).toBe(fixture.byteSha256)
    await writeFile(resolve(fixture.output, "mounted-download-payload.docx"), payload, { mode: 0o600 })
    const nativePath = resolve(fixture.output, "mounted-committee-memo.docx")
    const nativeSaveError = await download.saveAs(nativePath).then(() => null, error => String(error))
    if (!nativeSaveError) expect(createHash("sha256").update(await readFile(nativePath)).digest("hex")).toBe(fixture.byteSha256)
    await writeFile(resolve(fixture.output, "mounted-download.json"), JSON.stringify({
      documentId: fixture.documentId, versionId: fixture.versionId, browserBlobSha256,
      fileName: download.suggestedFilename(), nativeSaveError,
    }, null, 2) + "\n", { mode: 0o600 })
    steps.push("opened the pinned artifact, inspected both alternatives, and verified the bytes handed to the browser download")
    await page.reload()
    await committee.click()
    await expect(pinned).toBeVisible()
    steps.push("reloaded the Investigation and restored the same pinned memo")
    await fixture.archiveSource()
    await page.reload()
    await committee.click()
    await expect(page.getByText("The pinned memo is unavailable in this workspace.", { exact: true })).toBeVisible()
    await expect(pinned).toHaveCount(0)
    await expect(paragraphs).toHaveCount(0)
    await page.screenshot({ path: resolve(fixture.output, "mounted-memo-unavailable.png") })
    expect(pageErrors).toEqual([])
    steps.push("reloaded after source archival and observed the pinned memo become unavailable")
    return { steps, pageErrors }
  })
}

export function verifyMountedDocumentReview(fixture: MountedWorkspace & {
  valuationRequest: { dealId: string; instruction: string }
  archiveSource: () => Promise<void>
} & (
  { kind: "registered"; threadId: string }
  | { kind: "forecast"; spread: string; cells: string[]; vintages: string[]; briefText: string }
)) {
  return withMountedWorkspace(fixture, async ({ page, origin, steps, pageErrors }) => {
    await signIn(page, origin, fixture.email)
    const root = { entityType: "pe_deal", entityId: fixture.valuationRequest.dealId }
    const query = new URLSearchParams({ root: JSON.stringify(root) })
    await page.goto(origin + "/centropy?" + query)
    const submitted = page.waitForResponse(response =>
      response.url() === origin + "/api/centropy/actions" && response.request().method() === "POST")
    await page.getByRole("textbox", { name: "Message CENTROPY" }).fill(fixture.valuationRequest.instruction)
    await page.getByRole("button", { name: "Send instruction" }).click()
    const accepted = await submitted
    expect(accepted.status()).toBe(201)
    expect(accepted.request().postDataJSON()).toMatchObject({
      instruction: fixture.valuationRequest.instruction, activeContext: { businessRoot: root },
    })
    const { workId, threadId, objective, planned } = await accepted.json()
    expect(objective).toBeUndefined()
    expect(planned).toEqual([])
    const valuationPath = "/centropy/investigations/" + threadId
    await expect(page).toHaveURL(url => url.pathname === valuationPath)
    steps.push("submitted the valuation from the composer with the exact Deal selected")
    const valuation = page.getByRole("region", { name: "Valuation impact" })
    const spread = fixture.kind === "forecast" ? fixture.spread : "USD 16,000,000"
    await expect(valuation.getByText(spread, { exact: true })).toBeVisible()
    await expect(valuation.getByRole("cell")).toHaveText(fixture.kind === "forecast" ? fixture.cells : [
      "USD 144,000,000", "USD 84,000,000", "USD 89,000,000",
      "USD 160,000,000", "USD 100,000,000", "USD 105,000,000",
    ])
    await page.screenshot({ path: resolve(fixture.output, "mounted-valuation.png") })
    if (fixture.kind === "forecast") {
      await expect(valuation.getByRole("rowheader")).toHaveText(fixture.vintages)
      await valuation.getByText("Inspect exact forecast sources", { exact: true }).click()
      await expect(valuation.getByText(/Adjusted EBITDA.*\$157/)).toBeVisible()
      await writeFile(resolve(fixture.output, "mounted-forecast-ax.txt"), await valuation.ariaSnapshot(), { mode: 0o600 })
    }
    const downloading = page.waitForEvent("download")
    await valuation.getByRole("button", { name: "Download diligence brief" }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe("finnor-valuation-diligence-brief.md")
    const file = resolve(fixture.output, download.suggestedFilename())
    await download.saveAs(file)
    const brief = await readFile(file, "utf8")
    if (fixture.kind === "forecast") {
      const omitDate = (text: string) => text.replace(/^Review recorded on \d{4}-\d{2}-\d{2}\.$/m, "")
      expect(omitDate(brief)).toBe(omitDate(fixture.briefText))
    } else {
      for (const text of ["USD 16,000,000", "USD 89,000,000", "USD 105,000,000", "Financials!C2", "page 1", "Evidence needed to close the difference"]) {
        expect(brief).toContain(text)
      }
    }
    await page.reload()
    await expect(valuation.getByText(spread, { exact: true })).toBeVisible()
    steps.push("restored the conditional valuation and downloaded the source-cited brief through the authenticated workspace")
    if (fixture.kind === "registered") {
      await page.goto(origin + "/centropy/investigations/" + fixture.threadId)
      const finding = page.getByRole("region", { name: "EBITDA disagreement" })
      await expect(finding.getByRole("rowheader")).toHaveText(["Quality of earnings · page 1", "Management financials · Financials!C2"])
      await expect(finding.getByRole("cell")).toHaveText(["USD 18,000,000", "USD 20,000,000"])
      await expect(finding.getByText(/Spread USD 2,000,000/)).toBeVisible()
      await page.screenshot({ path: resolve(fixture.output, "mounted-document-review.png") })
      await finding.getByText("Inspect exact document versions", { exact: true }).click()
      await expect(finding.getByText(/\|EBITDA\|18000000\|/)).toBeVisible()
      await writeFile(resolve(fixture.output, "mounted-document-review-ax.txt"), await finding.ariaSnapshot(), { mode: 0o600 })
      steps.push("signed in, restored the comparison and inspected exact workbook and PDF sources")
      await fixture.archiveSource()
      await page.reload()
      await expect(page.getByText(/The source versions or coverage have changed/)).toBeVisible()
      await expect(finding).toHaveCount(0)
      await expect(page.getByText("USD 18,000,000", { exact: true })).toHaveCount(0)
      await page.goto(origin + valuationPath)
    } else {
      await fixture.archiveSource()
      await page.reload()
      await expect(valuation).toHaveCount(0)
    }
    await expect(page.getByText(/The source versions or coverage have changed/)).toBeVisible()
    await expect(page.getByRole("button", { name: "Download diligence brief" })).toHaveCount(0)
    expect(pageErrors).toEqual([])
    steps.push("reloaded after an actual source archive and observed stale guidance without the old figures")
    return { steps, pageErrors, downloadedBrief: file, valuationWorkId: workId }
  })
}
