import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const priorWorkId = process.env.CENTROPY_WORK_ID
const existingDeckWorkId = process.env.CENTROPY_DECK_WORK_ID
const existingDeckThreadId = process.env.CENTROPY_DECK_THREAD_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const instruction = "Turn this into tomorrow's IC deck using our template."

test("a Work instruction creates one governed IC deck draft and a verified Deal link", async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  const hostname = new URL(baseUrl).hostname
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !priorWorkId, "Owner credentials and a prior Atlas Work are required")
  const proofPath = testInfo.outputPath("centropy-ic-deck-work-action.proof.json")
  const screenshotPath = testInfo.outputPath("centropy-ic-deck-work-action.png")
  const observed: Record<string, unknown> = {
    tenantId: null, icCaseId: null, templateKey: null, templateVersionId: null,
    agentProfileId: null, agentRevisionId: null, agentGrantConfigured: false,
    workId: null, threadId: null, actionId: null, actionStatus: null,
    plannerCandidate: null, workStatus: null, approvalStatus: null,
    pendingQueueStatus: null, pendingQueueActionFound: false,
    finalWorkStatus: null, reloadUiVisible: false, mobileOverflowPx: null,
    effectStatus: null, receiptFinalized: false, linkId: null,
    approvedEffectHash: null, approvalLogVerified: false,
    documentId: null, documentVersionId: null, sourceVersionId: null,
    documentKind: null, semanticHash: null, lineageVerified: false,
    idempotentConfirm: false, reloadVerified: false,
    canvasWorkDraftVisible: false, draftDeepLinkVerified: false, draftSlidesVisible: false, noIcCaseOverride: false, manualCreationCollapsed: false,
    activeRefreshVerified: false, activeObjectiveLoopId: null, activeInstructionId: null,
  }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/centropy/me")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const meResponse = await mePromise
    expect(meResponse.status()).toBe(200)
    const me = await meResponse.json() as { tenantId?: string; role?: string }
    expect(me.tenantId).toBe(tenantId)
    expect(me.role).toBe("owner")
    observed.tenantId = me.tenantId
    const authorization = await meResponse.request().headerValue("authorization")
    expect(authorization).toMatch(/^Bearer /)
    const get = async <T>(path: string): Promise<T> => {
      const response = await page.request.get(`/api/centropy/${path}`, { headers: { authorization: authorization! }, timeout: 20_000 })
      expect(response.ok(), `${path}: ${response.status()}`).toBe(true)
      return await response.json() as T
    }
    type Effect = { domainActionId?: string; status?: string; semanticHash?: string; observedResult?: {
      entity?: { entityType?: string; entityId?: string };
      canonicalState?: { id?: string; dealId?: string; entityId?: string; documentId?: string; documentVersionId?: string; templateVersionId?: string; templateKey?: string; draftKind?: string };
    } }
    type Work = { work: { status?: string; finalOutcome?: { response?: { threadId?: string } } }; objectiveLoop?: { id?: string };
      actions?: Array<{ id?: string; actionType?: string; status?: string; payload?: { icCaseId?: string; templateVersionId?: string } }>;
      approvals?: Array<{ domainActionId?: string; step?: string; output?: { authorizedEffectHash?: string } }>;
      businessEffects?: Effect[]; receipts?: Array<{ domainActionId?: string; finalizedAt?: string | null; failure?: unknown }>;
      planRevisions?: Array<{ candidateSummary?: { selected?: { candidateKey?: string } } }> }
    const readWork = async (id: string) => (await get<{ work: Work }>(`works/${id}`)).work
    const prior = await readWork(priorWorkId!)
    const opened = prior.actions?.find((action) => action.actionType === "open_ic_case" && action.status === "completed")
    const caseId = prior.businessEffects?.find((effect) => effect.domainActionId === opened?.id && effect.status === "verified")?.observedResult?.entity?.entityId
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.icCaseId = caseId
    const ic = await get<{ case: { id: string; dealId: string; state: string } }>(`private-equity/ic/cases/${caseId}`)
    expect(ic.case).toMatchObject({ id: caseId, dealId, state: "READY_FOR_REVIEW" })
    const templates = await get<Array<{ template_key: string; version_id: string; kind: string; status: string }>>("artifact-templates")
    const active = templates.filter((item) => item.kind === "pptx" && item.status === "active")
    expect(active).toHaveLength(1)
    const template = active[0]!
    observed.templateKey = template.template_key
    observed.templateVersionId = template.version_id
    const workforce = await get<{ data: { workers: Array<{
      id: string; key: string; name: string; profileStatus: string;
      activeRevision: { id: string; modelRoute: { provider: string; model: string | null; purpose: "objective_execution" };
        capabilityGrants: Array<{ kind: "action" | "query" | "check" | "wait"; capability: string }>;
        maxConcurrentAssignments: number; autonomyLimits: Record<string, unknown>; planningHints: Record<string, unknown> } | null;
    }> } }>("workforce/profiles")
    const agent = workforce.data.workers.find((item) => item.key === "ic-preparation-analyst")
    expect(agent?.activeRevision).not.toBeNull()
    observed.agentProfileId = agent?.id ?? null
    const current = agent!.activeRevision!
    if (!current.capabilityGrants.some((grant) => grant.kind === "action" && grant.capability === "create_ic_deck_draft")) {
      const configured = await page.request.post("/api/centropy/workforce/profiles", {
        headers: { authorization: authorization! },
        data: { profileId: agent!.id, key: agent!.key, name: agent!.name, status: agent!.profileStatus,
          modelRoute: current.modelRoute,
          capabilityGrants: [...current.capabilityGrants, { kind: "action", capability: "create_ic_deck_draft" }],
          maxConcurrentAssignments: current.maxConcurrentAssignments,
          autonomyLimits: current.autonomyLimits, planningHints: current.planningHints },
        timeout: 20_000,
      })
      expect(configured.status(), `agent configuration: ${await configured.text()}`).toBe(200)
      observed.agentGrantConfigured = true
    }
    const updatedWorkforce = await get<{ data: { workers: Array<{ key: string; activeRevision: {
      id: string; capabilityGrants: Array<{ kind: string; capability: string }> } | null }> } }>("workforce/profiles")
    const updatedAgent = updatedWorkforce.data.workers.find((item) => item.key === "ic-preparation-analyst")
    expect(updatedAgent?.activeRevision?.capabilityGrants).toEqual(expect.arrayContaining([{ kind: "action", capability: "create_ic_deck_draft" }]))
    observed.agentRevisionId = updatedAgent!.activeRevision!.id

    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    let submitted: { workId?: string; threadId?: string }
    if (existingDeckWorkId) {
      expect(existingDeckThreadId, "Reopening requires the exact recorded Thread ID").toMatch(/^[0-9a-f-]{36}$/i)
      submitted = { workId: existingDeckWorkId, threadId: existingDeckThreadId }
      const reopened = await get<{ messages: Array<{ role: string; content: string; workId?: string }> }>(`threads/${existingDeckThreadId}?limit=100`)
      expect(reopened.messages.filter((message) => message.role === "user" && message.workId === existingDeckWorkId)).toHaveLength(1)
    } else {
      await page.goto(`/centropy?root=${root}`)
      await expect(page.locator(".ct-composer__context")).toContainText(/Atlas|Deal/i)
      await page.locator("#centropy-instruction").fill(instruction)
      const responsePromise = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/centropy/actions")
      await page.getByRole("button", { name: "Send instruction" }).click()
      const response = await responsePromise
      expect(response.status()).toBe(202)
      submitted = await response.json() as { workId?: string; threadId?: string }
    }
    expect(submitted.workId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.workId = submitted.workId

    await expect.poll(async () => {
      const work = await readWork(submitted.workId!).catch(() => null)
      observed.workStatus = work?.work.status ?? null
      observed.threadId = submitted.threadId ?? work?.work.finalOutcome?.response?.threadId ?? null
      observed.plannerCandidate = work?.planRevisions?.find((item) => item.candidateSummary?.selected?.candidateKey === "grounded-ic-deck-draft")?.candidateSummary?.selected?.candidateKey
        ?? work?.planRevisions?.at(-1)?.candidateSummary?.selected?.candidateKey ?? null
      const action = work?.actions?.find((item) => item.actionType === "create_ic_deck_draft")
      observed.actionId = action?.id ?? null
      observed.actionStatus = action?.status ?? null
      return action?.status === "pending" || action?.status === "completed"
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)
    expect(observed.plannerCandidate).toBe("grounded-ic-deck-draft")
    expect(observed.threadId).toMatch(/^[0-9a-f-]{36}$/i)
    if (observed.actionStatus === "pending") {
      const queueResponse = await page.request.get("/api/centropy/actions/pending?filter=pending&limit=100", {
        headers: { authorization: authorization! }, timeout: 20_000,
      })
      observed.pendingQueueStatus = queueResponse.status()
      expect(queueResponse.ok(), `pending queue: ${await queueResponse.text()}`).toBe(true)
      const queue = await queueResponse.json() as { actions?: Array<{ id?: string }> }
      observed.pendingQueueActionFound = Boolean(queue.actions?.some((item) => item.id === observed.actionId))
      expect(observed.pendingQueueActionFound).toBe(true)
      await page.goto(`/centropy/investigations/${observed.threadId}?root=${root}`)
      const effects = page.locator(".ct-effects")
      await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
      const beforeReload = await readWork(submitted.workId!)
      const beforeThread = await get<{ messages: Array<{ id: string; role: string; instructionId: string | null; workId: string | null }> }>(`threads/${observed.threadId}?limit=100`)
      const userTurns = beforeThread.messages.filter((message) => message.role === "user" && message.workId === submitted.workId)
      expect(userTurns).toHaveLength(1)
      expect(beforeReload.objectiveLoop?.id).toMatch(/^[0-9a-f-]{36}$/i)
      observed.activeObjectiveLoopId = beforeReload.objectiveLoop!.id
      observed.activeInstructionId = userTurns[0]!.instructionId
      const actionIds = beforeReload.actions?.map((action) => action.id) ?? []
      await page.reload()
      await expect(effects.getByRole("button", { name: "Review exact effect" })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByRole("region", { name: "Persisted instruction execution" })).toBeVisible({ timeout: 30_000 })
      const afterReload = await readWork(submitted.workId!)
      const afterThread = await get<{ messages: Array<{ id: string; role: string; instructionId: string | null; workId: string | null }> }>(`threads/${observed.threadId}?limit=100`)
      expect(afterReload.objectiveLoop?.id).toBe(observed.activeObjectiveLoopId)
      expect(afterReload.actions?.map((action) => action.id)).toEqual(actionIds)
      expect(afterThread.messages.filter((message) => message.role === "user" && message.workId === submitted.workId)).toEqual(userTurns)
      observed.activeRefreshVerified = true
      await effects.getByRole("button", { name: "Review exact effect" }).click()
      await expect(effects).toContainText(String(observed.actionId).slice(0, 8))
      await effects.getByRole("button", { name: "Confirm", exact: true }).click()
      await effects.getByLabel("I reviewed the exact effect, authority, and expected observation.").check()
      const confirmed = page.waitForResponse((candidate) => candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === `/api/centropy/actions/${observed.actionId}/confirm`)
      await effects.getByRole("button", { name: "Confirm effect" }).click()
      const approval = await confirmed
      observed.approvalStatus = approval.status()
      expect(approval.status()).toBe(200)
    } else {
      await page.goto(`/centropy/investigations/${observed.threadId}?root=${root}`)
    }

    let verifiedEffect: Effect | undefined
    await expect.poll(async () => {
      const work = await readWork(submitted.workId!).catch(() => null)
      const action = work?.actions?.find((item) => item.id === observed.actionId)
      verifiedEffect = work?.businessEffects?.find((item) => item.domainActionId === observed.actionId && item.status === "verified")
      const receipt = work?.receipts?.find((item) => item.domainActionId === observed.actionId && item.finalizedAt && !item.failure)
      observed.actionStatus = action?.status ?? null
      observed.effectStatus = verifiedEffect?.status ?? null
      observed.receiptFinalized = Boolean(receipt)
      return action?.status === "completed" && Boolean(verifiedEffect && receipt)
    }, { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }).toBe(true)
    expect(verifiedEffect?.observedResult?.entity?.entityType).toBe("pe_document_link")
    const approvedWork = await readWork(submitted.workId!)
    const approvalLog = approvedWork.approvals?.find((item) => item.domainActionId === observed.actionId && item.step === "confirmed")
    expect(approvalLog?.output?.authorizedEffectHash).toBe(verifiedEffect?.semanticHash)
    observed.approvedEffectHash = approvalLog?.output?.authorizedEffectHash ?? null
    observed.approvalLogVerified = true
    const link = verifiedEffect!.observedResult!.canonicalState!
    expect(link).toMatchObject({ dealId, entityId: caseId, templateVersionId: template.version_id,
      templateKey: template.template_key, draftKind: "IC_DECK_DRAFT" })
    expect(link.documentId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(link.documentVersionId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.linkId = link.id ?? null
    observed.documentId = link.documentId
    observed.documentVersionId = link.documentVersionId
    const artifact = await get<{ document: { external_id?: string; kind?: string }; version: { id: string; source_ref?: string; byte_sha256: string };
      semantic: { kind: string; semanticHash: string; nodeCount: number }; bindings: Array<{ anchor_id: string; anchor_hash: string; target_entity_type?: string; target_kind: string; target_id: string }>;
      lineage: Array<{ source_version_id: string; target_version_id: string; relation: string }> }>(`documents/${link.documentId}/artifact?versionId=${link.documentVersionId}`)
    expect(artifact.document.external_id).toBe(observed.actionId)
    expect(artifact.version.source_ref).toBe(template.version_id)
    expect(artifact.semantic.kind).toBe("pptx")
    expect(artifact.semantic.nodeCount).toBeGreaterThan(0)
    expect(artifact.bindings.length).toBeGreaterThan(10)
    expect(artifact.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_entity_type: "pe_ic_case", target_id: caseId }),
      expect.objectContaining({ target_entity_type: "underwriting_run" }),
      expect.objectContaining({ target_entity_type: "pe_ic_recommendation" }),
      expect.objectContaining({ target_kind: "document_version" }),
    ]))
    observed.bindingCount = artifact.bindings.length
    const content = await get<{ nodes: Array<{ id: string; hash: string; kind: string; data: { text?: string } }> }>(`documents/${link.documentId}/artifact/ir/${link.documentVersionId}?limit=500`)
    const text = content.nodes.filter((node) => node.kind === "shape").map((node) => node.data.text ?? "").join("\n")
    expect(text).toContain("Atlas")
    expect(text).toContain("CONTINUE DILIGENCE")
    expect(text).toContain("80")
    if (!existingDeckWorkId) {
      expect(text).toContain("Sponsor IRR: 40.00%")
      expect(text).toContain("Sponsor MOIC: 1.4x")
      expect(text).toContain("Sponsor exit proceeds: 70 USD")
      expect(text).toContain("Exit enterprise value: 100 USD")
      expect(text).not.toContain("relationship not recorded")
      expect(text).not.toContain("not recorded (unit not recorded")
      observed.recordedModelOutputsVerified = true
    }
    expect(text).not.toContain("{{")
    for (const binding of artifact.bindings) expect(content.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: binding.anchor_id, hash: binding.anchor_hash })]))
    observed.contentVerified = true
    expect(artifact.lineage).toEqual(expect.arrayContaining([expect.objectContaining({
      source_version_id: template.version_id, target_version_id: link.documentVersionId, relation: "template_instantiation",
    })]))
    observed.sourceVersionId = artifact.version.source_ref ?? null
    observed.documentKind = artifact.semantic.kind
    observed.semanticHash = artifact.semantic.semanticHash
    observed.lineageVerified = true

    const replay = await page.request.post(`/api/centropy/actions/${observed.actionId}/confirm`, {
      headers: { authorization: authorization! }, data: {}, timeout: 20_000,
    })
    expect(replay.status()).toBe(200)
    expect(await replay.json()).toMatchObject({ status: "completed", idempotent: true })
    observed.idempotentConfirm = true
    expect(new URL(page.url()).searchParams.has("icCaseId")).toBe(false)
    observed.noIcCaseOverride = true
    if (testInfo.project.name.startsWith("mobile")) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    const workDraft = page.getByLabel("Work-created IC deck draft")
    await expect(workDraft).toBeVisible({ timeout: 30_000 })
    await expect(workDraft).toContainText(String(observed.actionId))
    await expect(workDraft).toContainText(String(observed.documentId))
    await expect(workDraft).toContainText(String(observed.documentVersionId))
    observed.canvasWorkDraftVisible = true
    await expect(page.getByRole("button", { name: "Create another draft" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Review deck creation" })).toHaveCount(0)
    observed.manualCreationCollapsed = true
    await workDraft.getByRole("button", { name: "Open Work draft" }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("artifactDocumentId")).toBe(link.documentId)
    await expect.poll(() => new URL(page.url()).searchParams.get("artifactVersionId")).toBe(link.documentVersionId)
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".ct-artifact__intro")).toContainText(`Document ${link.documentId} · version ${link.documentVersionId}`)
    observed.draftSlidesVisible = true
    await page.reload()
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(".ct-artifact__intro")).toContainText(`Document ${link.documentId} · version ${link.documentVersionId}`)
    observed.draftDeepLinkVerified = true
    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("button", { name: "Download exact version", exact: true }).click()
    const download = await downloadPromise
    const downloadPath = testInfo.outputPath("Atlas-IC.pptx")
    await download.saveAs(downloadPath)
    const downloaded = await readFile(downloadPath)
    expect(downloaded.subarray(0, 2).toString()).toBe("PK")
    const downloadHash = createHash("sha256").update(downloaded).digest("hex")
    expect(downloadHash).toBe(artifact.version.byte_sha256)
    observed.download = { file: "Atlas-IC.pptx", sha256: downloadHash, bytes: downloaded.length, versionId: link.documentVersionId }
    const editor = page.getByRole("region", { name: "Versioned presentation editor" })
    const originalText = await editor.getByLabel("Replacement text").inputValue()
    expect(originalText).toContain("Atlas")
    const replacementText = `${originalText} (working draft)`
    await editor.getByLabel("Replacement text").fill(replacementText)
    await editor.getByRole("button", { name: "Review exact slide change" }).click()
    await expect(editor).toContainText(String(link.documentVersionId))
    const patchResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/centropy/documents/${link.documentId}/artifact/patches`)
    await editor.getByRole("button", { name: "Create deck version" }).click()
    const patch = await patchResponse
    expect(patch.status()).toBe(201)
    const patchBody = await patch.json() as { version?: { id: string }; versionId?: string }
    const editedVersionId = patchBody.version?.id ?? patchBody.versionId
    expect(editedVersionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(editedVersionId).not.toBe(link.documentVersionId)
    observed.editedVersionId = editedVersionId
    const edited = await get<{ nodes: Array<{ data: { text?: string } }> }>(`documents/${link.documentId}/artifact/ir/${editedVersionId}?limit=500`)
    expect(edited.nodes.some((node) => node.data.text === replacementText)).toBe(true)
    const baseContent = await get<{ semanticHash: string; nodes: Array<{ data: { text?: string } }> }>(`documents/${link.documentId}/artifact/ir/${link.documentVersionId}?limit=500`)
    expect(baseContent.semanticHash).toBe(artifact.semantic.semanticHash)
    expect(baseContent.nodes.some((node) => node.data.text === originalText)).toBe(true)
    expect(baseContent.nodes.some((node) => node.data.text === replacementText)).toBe(false)
    const diff = await get<{ left: string; right: string; changes: Array<{ id: string; kind: string }> }>(`documents/${link.documentId}/artifact/diff?left=${link.documentVersionId}&right=${editedVersionId}`)
    expect(diff.left).toBe(link.documentVersionId)
    expect(diff.right).toBe(editedVersionId)
    expect(diff.changes.length).toBeGreaterThan(0)
    observed.editDiff = diff
    await page.reload()
    await expect(page.locator(".ct-artifact__intro")).toContainText(`version ${editedVersionId}`, { timeout: 30_000 })
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible()
    observed.editAndReloadVerified = true
    const publication = page.getByRole("region", { name: "Publish exact presentation version" })
    await expect(publication).toContainText(/No configured SharePoint folder/i, { timeout: 30_000 })
    observed.publication = "BLOCKED_EXTERNAL: no configured SharePoint folder has verified permission for this Deal"
    await page.getByRole("button", { name: "Back to Investigation Canvas" }).click()
    await expect(workDraft).toBeVisible({ timeout: 30_000 })
    if (testInfo.project.name.startsWith("mobile")) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Thread" }).click()
    await expect(page.getByRole("region", { name: "CENTROPY conversation" })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("heading", { name: instruction, exact: true }).first()).toBeVisible()
    observed.reloadUiVisible = true
    const restored = await get<{ version: { id: string }; semantic: { semanticHash: string } }>(`documents/${link.documentId}/artifact?versionId=${link.documentVersionId}`)
    expect(restored.version.id).toBe(link.documentVersionId)
    expect(restored.semantic.semanticHash).toBe(artifact.semantic.semanticHash)
    await expect.poll(async () => (await readWork(submitted.workId!)).work.status, { timeout: 120_000, intervals: [2_000] }).toBe("completed")
    const finalWork = await readWork(submitted.workId!)
    observed.finalWorkStatus = finalWork.work.status ?? null
    const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    observed.mobileOverflowPx = overflowPx
    expect(overflowPx).toBeLessThanOrEqual(0)
    observed.reloadVerified = true
    if (testInfo.project.name.startsWith("mobile")) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    await expect(workDraft).toBeVisible({ timeout: 30_000 })
    await workDraft.scrollIntoViewIfNeeded()
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1", flow: "ic_deck_work_action",
      capturedAt: new Date().toISOString(), baseUrl, actorEmail: email,
      input: { priorWorkId, existingDeckWorkId: existingDeckWorkId ?? null, existingDeckThreadId: existingDeckThreadId ?? null, dealId, instruction }, observed,
      steps: ["Sign in as fixture owner and verify tenant", "Read the exact READY_FOR_REVIEW IC case and one active PowerPoint template", "Verify the governed IC Agent capability grant and configure a new revision if this disposable fixture is stale", existingDeckWorkId ? "Load the recorded deck Work and Investigation" : "Submit the exact Golden Flow 4 instruction in the Atlas Deal Thread", "Observe the grounded planner candidate and durable DomainAction", ...(!existingDeckWorkId ? ["While approval is pending, reload the Investigation and compare the exact Objective, action IDs, user instruction, and visible persisted trace"] : []), "Review and confirm the exact effect if approval is pending", "Verify populated canonical content, exact anchor bindings, action, Business Effect, finalized receipt, canonical Deal link, template lineage, and Artifact version", "Repeat action confirmation without duplication", "Open the verified Work draft from Canvas without an IC case URL override, confirm that duplicate manual creation is collapsed, inspect its exact PPTX slides, reload its deep link, and return to the same draft card", "Verify terminal Work completion"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: { command: `CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=${priorWorkId}${existingDeckWorkId ? ` CENTROPY_DECK_WORK_ID=${existingDeckWorkId} CENTROPY_DECK_THREAD_ID=${existingDeckThreadId}` : ""} PLAYWRIGHT_BASE_URL=${baseUrl} npx playwright test e2e/centropy-ic-deck-work-action.spec.ts --project=${testInfo.project.name}`, requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas fixture with one active PowerPoint template"] },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-ic-deck-work-action-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-ic-deck-work-action-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
