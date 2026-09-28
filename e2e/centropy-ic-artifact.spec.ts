import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const email = process.env.TEST_OWNER_EMAIL
const password = process.env.TEST_OWNER_PASSWORD
const workId = process.env.CENTROPY_WORK_ID
const tenantId = "00000000-0000-4000-8000-000000000001"
const dealId = "90000000-0000-4000-8000-000000000001"
const templateKey = "centropy_ic_local_test_v1"

test("synthetic Atlas template becomes an exact edited and selected IC deck", async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const baseUrl = String(testInfo.project.use.baseURL ?? "")
  const hostname = new URL(baseUrl).hostname
  test.skip(process.env.CENTROPY_DISPOSABLE_E2E !== "1" || !["127.0.0.1", "localhost"].includes(hostname), "Disposable localhost fixture only")
  test.skip(!email || !password || !workId, "Owner credentials and CENTROPY_WORK_ID are required")

  const screenshotPath = testInfo.outputPath("centropy-ic-artifact.png")
  const proofPath = testInfo.outputPath("centropy-ic-artifact.proof.json")
  const observed: Record<string, unknown> = {
    tenantId: null, caseId: null, caseStateBefore: null, caseVersionBefore: null,
    viewportWidth: testInfo.project.use.viewport?.width ?? null,
    templateKey, sourceVersionId: null, sourceSemanticHash: null,
    documentId: null, initialVersionId: null, initialSemanticHash: null,
    editedVersionId: null, editedSemanticHash: null, semanticChangeCount: null,
    commentId: null, reviewId: null, reviewState: null, selectedDeckVersionId: null,
    selectedDeckMemoId: null, caseStateAfter: null, caseVersionAfter: null,
    restoredExactVersion: false, publicationStatus: "not_configured_or_attempted",
  }
  try {
    await page.goto("/centropy/login")
    await page.getByLabel("Email").fill(email!)
    await page.getByLabel("Password").fill(password!)
    const mePromise = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/centropy/me")
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
    const work = await get<{ work: { work: { finalOutcome?: { response?: { threadId?: string } } }; actions?: Array<{ id?: string; actionType?: string; status?: string }>; businessEffects?: Array<{ domainActionId?: string; status?: string; observedResult?: { entity?: { entityId?: string } } }> } }>(`works/${workId}`)
    const open = work.work.actions?.find((item) => item.actionType === "open_ic_case" && item.status === "completed")
    const caseId = work.work.businessEffects?.find((item) => item.domainActionId === open?.id && item.status === "verified")?.observedResult?.entity?.entityId
    const threadId = work.work.work.finalOutcome?.response?.threadId
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/i)
    observed.caseId = caseId
    const before = await get<{ case: { id: string; state: string; version: number; dealId: string } }>(`private-equity/ic/cases/${caseId}`)
    expect(before.case.id).toBe(caseId)
    expect(before.case.dealId).toBe(dealId)
    expect(before.case.state).toBe("PREPARING")
    observed.caseStateBefore = before.case.state
    observed.caseVersionBefore = before.case.version

    const templates = await get<Array<{ template_key: string; version_id: string; kind: string; status: string }>>("artifact-templates")
    const template = templates.find((item) => item.template_key === templateKey)
    expect(template?.kind).toBe("pptx")
    expect(template?.status).toBe("active")
    observed.sourceVersionId = template?.version_id ?? null

    const root = encodeURIComponent(JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
    await page.goto(`/centropy/investigations/${threadId}?root=${root}&icCaseId=${caseId}`)
    if ((testInfo.project.use.viewport?.width ?? 1280) < 600) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    const preparation = page.getByRole("region", { name: "IC deck preparation" })
    await expect(preparation).toBeVisible({ timeout: 30_000 })
    await expect(preparation.getByLabel("Registered template")).toHaveValue(templateKey)
    await expect(preparation).toContainText(template!.version_id)
    await preparation.getByLabel("New draft title").fill("Atlas · synthetic IC deck fixture")
    await preparation.getByRole("button", { name: "Review deck creation" }).click()
    await expect(preparation).toContainText(template!.version_id)
    const createPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/artifact-templates/${templateKey}/instantiate`)
    await preparation.getByRole("button", { name: "Create exact draft" }).click()
    const createdResponse = await createPromise
    expect(createdResponse.status()).toBe(201)
    const created = await createdResponse.json() as { documentId: string; version: { id: string }; ir: { kind: string; semanticHash: string } }
    expect(created.documentId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.version.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(created.ir.kind).toBe("pptx")
    observed.documentId = created.documentId
    observed.initialVersionId = created.version.id
    await expect(preparation.getByText("Draft verified")).toBeVisible()
    const initial = await get<{ documentId: string; version: { id: string }; semantic: { kind: string; semanticHash: string; nodeCount: number }; lineage: Array<{ source_version_id: string; target_version_id: string; relation: string }> }>(`documents/${created.documentId}/artifact?versionId=${created.version.id}`)
    expect(initial.documentId).toBe(created.documentId)
    expect(initial.version.id).toBe(created.version.id)
    expect(initial.semantic.kind).toBe("pptx")
    expect(initial.semantic.nodeCount).toBeGreaterThan(0)
    expect(initial.semantic.semanticHash).toBe(created.ir.semanticHash)
    expect(initial.lineage).toEqual(expect.arrayContaining([expect.objectContaining({ source_version_id: template!.version_id, target_version_id: created.version.id, relation: "template_instantiation" })]))
    observed.sourceSemanticHash = created.ir.semanticHash
    observed.initialSemanticHash = initial.semantic.semanticHash

    await preparation.getByRole("button", { name: "Open draft" }).click()
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Versioned presentation editor" })).toBeVisible()
    const editor = page.getByRole("region", { name: "Versioned presentation editor" })
    await editor.getByLabel("Replacement text").fill("LOCAL SYNTHETIC TEST DECK · edited placeholder")
    await editor.getByRole("button", { name: "Review exact slide change" }).click()
    await expect(editor).toContainText(created.version.id)
    const patchPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/documents/${created.documentId}/artifact/patches`)
    await editor.getByRole("button", { name: "Create deck version" }).click()
    const patchResponse = await patchPromise
    expect(patchResponse.ok()).toBe(true)
    const patch = await patchResponse.json() as { version?: { id: string }; versionId?: string }
    const editedVersionId = patch.version?.id ?? patch.versionId
    expect(editedVersionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(editedVersionId).not.toBe(created.version.id)
    observed.editedVersionId = editedVersionId
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible()
    const edited = await get<{ version: { id: string }; semantic: { semanticHash: string } }>(`documents/${created.documentId}/artifact?versionId=${editedVersionId}`)
    expect(edited.version.id).toBe(editedVersionId)
    expect(edited.semantic.semanticHash).not.toBe(initial.semantic.semanticHash)
    observed.editedSemanticHash = edited.semantic.semanticHash
    const diff = await get<{ left: string; right: string; changes: unknown[] }>(`documents/${created.documentId}/artifact/diff?left=${created.version.id}&right=${editedVersionId}`)
    expect(diff.changes.length).toBeGreaterThan(0)
    observed.semanticChangeCount = diff.changes.length

    const governance = page.locator(".ct-artifact__governance-desk")
    await expect(governance).toContainText(editedVersionId!)
    await governance.getByLabel("Comment").fill("Fixture review: placeholder text was edited. No firm evidence or IC recommendation is asserted.")
    await governance.getByRole("button", { name: "Review comment" }).click()
    const commentPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/documents/${created.documentId}/artifact/comments`)
    await governance.getByRole("button", { name: "Record comment" }).click()
    const commentResponse = await commentPromise
    expect(commentResponse.ok()).toBe(true)
    const comment = await commentResponse.json() as { id: string; version_id: string }
    expect(comment.version_id).toBe(editedVersionId)
    observed.commentId = comment.id

    await governance.getByLabel("Review record").selectOption("approved")
    await governance.getByRole("button", { name: "Review action" }).click()
    const reviewPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/documents/${created.documentId}/artifact/reviews`)
    await governance.getByRole("button", { name: "Record review" }).click()
    const reviewResponse = await reviewPromise
    expect(reviewResponse.ok()).toBe(true)
    const review = await reviewResponse.json() as { id: string; version_id: string; state: string }
    expect(review.version_id).toBe(editedVersionId)
    expect(review.state).toBe("approved")
    observed.reviewId = review.id
    observed.reviewState = review.state

    const handoff = page.getByRole("region", { name: "Artifact to IC handoff" })
    await expect(handoff.getByRole("button", { name: "Review exact IC selection" })).toBeEnabled()
    await handoff.getByRole("button", { name: "Review exact IC selection" }).click()
    await expect(handoff).toContainText(review.id)
    await expect(handoff).toContainText("UNKNOWN")
    const selectPromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/centropy/private-equity/ic/cases/${caseId}/memos`)
    await handoff.getByRole("button", { name: "Select reviewed deck" }).click()
    const selectedResponse = await selectPromise
    expect(selectedResponse.ok()).toBe(true)
    const selection = await selectedResponse.json() as { memo: { id: string; documentId: string; documentVersionId: string; artifactRole: string }; case: { version: number; currentDeckId: string; state: string } }
    expect(selection.memo.documentId).toBe(created.documentId)
    expect(selection.memo.documentVersionId).toBe(editedVersionId)
    expect(selection.memo.artifactRole).toBe("DECK")
    expect(selection.case.currentDeckId).toBe(selection.memo.id)
    observed.selectedDeckVersionId = selection.memo.documentVersionId
    observed.selectedDeckMemoId = selection.memo.id
    const after = await get<{ case: { state: string; version: number }; deck?: { id: string; documentId: string; documentVersionId: string } }>(`private-equity/ic/cases/${caseId}`)
    expect(after.deck?.id).toBe(selection.memo.id)
    expect(after.deck?.documentVersionId).toBe(editedVersionId)
    expect(after.case.version).toBeGreaterThan(before.case.version)
    observed.caseStateAfter = after.case.state
    observed.caseVersionAfter = after.case.version

    await page.reload()
    if ((testInfo.project.use.viewport?.width ?? 1280) < 600) await page.getByRole("group", { name: "Workspace view" }).getByRole("button", { name: "Canvas" }).click()
    await expect(page.getByRole("heading", { name: "Presentation slides" })).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).searchParams.get("artifactVersionId")).toBe(editedVersionId)
    observed.restoredExactVersion = true
    await expect(page.getByText("This exact version is selected in IC case", { exact: false })).toBeVisible()
    if ((testInfo.project.use.viewport?.width ?? 1280) < 600) {
      observed.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(observed.horizontalOverflow).toBe(0)
    }
  } finally {
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" }).catch(() => null)
    const proof = {
      schema: "finnor.centropy.e2e-proof/v1", flow: "atlas_synthetic_ic_artifact", capturedAt: new Date().toISOString(),
      baseUrl, actorEmail: email, input: { workId, dealId, templateKey, fixtureOnly: true }, observed,
      steps: ["Authenticate the owner and verify the disposable tenant", "Read the Work-linked PREPARING IC case and exact registered template", "Review and instantiate a new draft from the source version", "Verify immutable template lineage and semantic hash", "Review and save one anchored slide edit as a new version", "Verify semantic diff, anchored comment, and exact-version Artifact review", "Review Deal-root link and select the exact deck version into IC", "Reload the draft URL and verify the exact version and IC selection"],
      screenshotSha256: screenshot ? createHash("sha256").update(screenshot).digest("hex") : null,
      reproduce: {
        command: `CENTROPY_DISPOSABLE_E2E=1 CENTROPY_WORK_ID=<Work with PREPARING Atlas IC case> PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 npx playwright test e2e/centropy-ic-artifact.spec.ts --project=${testInfo.project.name}`,
        requiredEnvironment: ["TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "disposable Atlas fixture seeded with centropy_ic_local_test_v1", "local frontend connected to its disposable API"],
      },
    }
    await writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n")
    await testInfo.attach("centropy-ic-artifact-proof", { path: proofPath, contentType: "application/json" })
    if (screenshot) await testInfo.attach("centropy-ic-artifact-screenshot", { path: screenshotPath, contentType: "image/png" })
  }
})
