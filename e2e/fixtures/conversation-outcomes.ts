import type { BrowserContext } from "@playwright/test"
import type { WorkAggregateView } from "../../src/components/centropy/product/contracts"
import type { LoadedConversationThread } from "../../src/components/centropy/thread/thread-contract"

// Synthetic interaction evidence only. No real auth, tenant, worker, or economic result.
export const FIXTURE_ORIGIN = "http://127.0.0.1:3000"
export const at = "2026-11-25T05:00:00.000Z"
export const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
export const objective = "Prepare the Project Cedar IC downside case, identify missing evidence, and draft a request to the deal lead. Do not send until I review."
export const objectiveReply = "The downside case is 1.6x MOIC at a 15% EBITDA decline. Customer retention evidence is missing. I drafted a request for your review; nothing has been sent."
export const greetingReply = "Hello! What would you like to discuss?"
export const plainReply = "MOIC means multiple on invested capital."
export const followupReply = "You’re welcome. Nothing else has been sent."
const hash = "a".repeat(64)
export const effect = {
  semanticHash: hash, operation: { name: "send_email", class: "communication" },
  targets: [{ type: "deal_lead", id: id(90) }],
  delta: { operation: "send", values: { recipient: "cedar-lead@example.invalid", subject: "Project Cedar retention evidence", body: "Please provide the FY26 cohort retention schedule.", provider: "fixture_mail" } },
  before: [{ target: { type: "deal_lead", id: id(90) }, values: { status: "not_contacted" } }],
  expected: { observation: "Message delivery receipt for the evidence request" },
  authority: { capability: "owner_review_required", risk: "external_communication" },
  approval: { summary: "Owner must review exact recipient, subject and body" },
  reversibility: { classification: "irreversible_after_delivery" },
}
export const pendingAction = {
  id: id(30), workId: id(20), actionType: "send_email", status: "pending",
  summary: "Request Cedar retention evidence", createdAt: at, groundedPayload: {},
  predicted: { summary: "Deal lead receives evidence request" }, businessEffect: effect,
  businessEffectStatus: "compiled", canCurrentEmployeeApprove: true, critic: null,
  receipt: { id: id(31), objective, evidence: {}, policyApplied: { reason: "Owner approval required" }, riskTier: "external", createdAt: at },
}

function aggregate(n: number, status = "completed"): WorkAggregateView {
  return {
    read: { limit: 100, complete: true, truncatedTables: [] },
    work: { id: id(n), status, initialInstruction: n === 20 ? objective : `Fixture ${n}: assess Cedar evidence`, executionModel: "objective", currentOwnerId: id(1), assignedTo: id(1), createdAt: at, updatedAt: at, failure: null, recovery: null, finalOutcome: null },
    planRevisions: [], actions: [], businessEffects: [], objectiveSteps: [],
    queryExecutions: [], eventWaits: [], receipts: [],
  }
}
function thread(n: number, title: string, workId: string | null = null): LoadedConversationThread {
  return {
    thread: { id: id(n), title, summary: null, revision: 1, activeWorkId: workId, activeObjectiveLoopId: null, lastActivityAt: at, createdAt: at, summaryThroughSequence: 0, activeReferences: [], unresolvedReferences: [], outcomeRefs: [] },
    messages: [],
  }
}
function append(target: LoadedConversationThread, text: string, reply: string, workId: string | null, meaningful: boolean, instructionId: string | null = null) {
  for (const role of ["user", "assistant"] as const) target.messages.push({
    id: id(1000 + Number(target.thread.id.slice(-12)) * 100 + target.messages.length),
    threadId: target.thread.id, sequence: target.messages.length + 1, role, channel: "text",
    originalText: role === "user" ? text : reply, instructionId, workId, workInputId: null,
    resolutionSnapshot: null, resolutionProvenance: [], companyTruthSnapshot: null,
    outcomeRefs: role === "assistant" && meaningful ? [{ kind: "domain_action", id: id(30) }] : [], createdAt: at,
  })
}

export async function installOutcomeFixtures(context: BrowserContext) {
  const requests: Array<{ method: string; path: string; disposition: string; body?: unknown }> = []
  const unexpected: string[] = []
  const works = new Map<string, WorkAggregateView>()
  const primary = aggregate(20, "waiting_approval")
  primary.actions = [{ id: id(30), actionType: "send_email", status: "pending", planRevisionId: null, planNodeId: null, groundedPayload: {}, predictedReceipt: {}, createdAt: at }]
  primary.businessEffects = [{ id: id(32), domainActionId: id(30), status: "compiled", effect, observedResult: null, verification: null, semanticHash: hash }]
  works.set(id(20), primary)
  for (const n of [21, 22, 23, 24]) {
    const work = aggregate(n, n === 23 ? "failed" : "completed")
    work.work.finalOutcome = "Cedar evidence assessment recorded."
    work.planRevisions = [{ id: id(100 + n), revision: 1, parentRevisionId: null, reason: "Fixture evidence assessment", status: "completed", goalSpec: {}, constraintSet: {}, planningSnapshot: {}, validation: {}, planGraph: {}, score: {}, graphHash: hash, semanticHash: hash, completionProof: { verified: true }, selectedAt: at, completedAt: at }]
    work.receipts = [{ id: id(200 + n), domainActionId: null, actualResult: "Action receipt finalized", failure: null, finalizedAt: at }]
    if (n === 22) work.planRevisions = [] // A receipt alone cannot certify Work.
    if (n === 23) work.work.failure = { message: "Evidence provider unavailable; assessment incomplete" }
    if (n === 24) work.read = { limit: 100, complete: false, truncatedTables: ["businessEffects"] }
    works.set(id(n), work)
  }
  const threads = new Map<string, LoadedConversationThread>()
  const labels = ["Cedar decision", "Verified assessment", "Receipt only", "Failed assessment", "Partial assessment", "Unrelated plain conversation"]
  labels.forEach((label, index) => {
    const n = 10 + index
    const w = index < 5 ? id(20 + index) : null
    const loaded = thread(n, label, w)
    append(loaded, index === 0 ? objective : `Open ${label}`, index === 0 ? objectiveReply : index === 5 ? "This unrelated conversation has no linked Work." : `${label} is recorded.`, w, index < 5)
    threads.set(id(n), loaded)
  })
  const sourceWork = aggregate(25)
  sourceWork.work.executionModel = "instruction"
  sourceWork.work.finalOutcome = { kind: "answer", answer: { kind: "answer", readOnly: true, spokenSummary: "Cedar FY25 EBITDA differs by USD 2 million between source documents.", display: { title: "Cedar historical document comparison" } } }
  sourceWork.documentReview = {
    status: "reviewed", coverage: "registered_sources", documentsReviewed: 2, comparableGroups: 1, gaps: [],
    findings: [{ metric: "EBITDA", periodStart: "2025-01-01T00:00:00.000Z", periodEnd: "2025-12-31T00:00:00.000Z", currency: "USD", unit: "million", frequency: "annual", calendar: "calendar_year", consolidation: "consolidated", instrument: "UNSPECIFIED", spread: "2",
      assertions: [20, 22].map((value, i) => ({ value: String(value), source: { documentId: id(400 + i), versionId: id(410 + i), sha256: hash, title: i ? "Cedar lender report" : "Cedar management accounts", anchor: { page: i + 4, quote: `FY25 EBITDA USD ${value} million` } } })) }],
  }
  works.set(id(25), sourceWork)
  const historical = thread(16, "Historical document answer", id(20))
  append(historical, "Compare the Cedar FY25 documents", "Cedar FY25 EBITDA differs by USD 2 million between source documents.", id(25), false)
  append(historical, objective, objectiveReply, id(20), true)
  threads.set(id(16), historical)
  const orphanFailed = thread(17, "Failed Work without assistant", id(23))
  append(orphanFailed, "Assess Cedar evidence", "unused", id(23), false)
  orphanFailed.messages.pop()
  threads.set(id(17), orphanFailed)
  const orphanApproval = thread(18, "Approval without owning assistant", id(20))
  append(orphanApproval, objective, "Hello! This plain reply does not own the pending Work.", id(20), false)
  threads.set(id(18), orphanApproval)
  const icWork = structuredClone(works.get(id(21))!)
  icWork.work.id = id(26)
  icWork.work.initialInstruction = "Prepare the Cedar IC memo for review"
  icWork.work.finalOutcome = { kind: "objective", objectiveLoopId: id(260), successVerification: { state: "verified", evidence: [{ kind: "business_effect", businessEffectId: id(262) }] } }
  icWork.inputs = [{ id: id(263), contextSnapshot: { businessRoot: { entityType: "pe_deal", entityId: id(270) } } }]
  icWork.actions = [{ id: id(261), actionType: "request_ic_memo_review", status: "completed", planRevisionId: null, planNodeId: null, groundedPayload: {}, predictedReceipt: {}, createdAt: at }]
  icWork.businessEffects = [{ id: id(262), domainActionId: id(261), status: "verified", effect: null, observedResult: { entity: { entityType: "pe_ic_case", entityId: id(271) }, canonicalState: { id: id(271), dealId: id(270), state: "READY_FOR_REVIEW" } }, verification: { state: "verified" }, semanticHash: hash }]
  icWork.receipts = [{ id: id(264), domainActionId: id(261), actualResult: "Review requested", failure: null, finalizedAt: at }]
  icWork.planRevisions[0].completionProof = { verified: true, evidenceRefs: [{ type: "business_effect", id: id(262) }] }
  works.set(id(26), icWork)
  const icThread = thread(19, "Verified IC review", id(26))
  append(icThread, "Prepare the Cedar IC memo for review", "The exact IC memo review is recorded.", id(26), true)
  threads.set(id(19), icThread)
  let created = 50
  let failPrimaryReads = false
  await context.addInitScript(({ origin, userId }) => {
    if (location.origin !== origin) return
    const now = Math.floor(Date.now() / 1000)
    const token = `${btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${btoa(JSON.stringify({ sub: userId, exp: now + 86400, role: "authenticated" }))}.fixture-signature`
    localStorage.setItem("sb-outcomes-fixture-auth-token", JSON.stringify({
      access_token: token, refresh_token: "fixture-refresh", token_type: "bearer",
      expires_in: 86400, expires_at: now + 86400,
      user: { id: userId, aud: "authenticated", role: "authenticated", email: "fixture-owner@example.invalid", app_metadata: {}, user_metadata: {}, created_at: "2026-11-25T05:00:00.000Z" },
    }))
  }, { origin: FIXTURE_ORIGIN, userId: id(1) })
  await context.routeWebSocket(/.*/, ws => {
    const url = new URL(ws.url())
    if (url.hostname === "127.0.0.1" && url.port === "3000" && url.pathname.includes("_next")) ws.connectToServer()
    else { unexpected.push(`websocket ${url.origin}${url.pathname}`); ws.close() }
  })
  await context.route("**/*", async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api\/centropy\//, "")
    const method = request.method()
    const log = { method, path: `${url.origin}${url.pathname}`, disposition: "intercepted", ...(request.postData() ? { body: request.postDataJSON() } : {}) }
    if (url.origin !== FIXTURE_ORIGIN) {
      if (url.origin === "https://outcomes-fixture.invalid" && url.pathname === "/auth/v1/user") {
        requests.push({ ...log, disposition: "intercepted-auth-probe" })
        return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Synthetic auth boundary probe; no outbound call"}' })
      }
      requests.push({ ...log, disposition: "blocked-external" })
      unexpected.push(`${method} ${url.origin}${url.pathname}`)
      return route.abort("blockedbyclient")
    }
    if (!url.pathname.startsWith("/api/") && method === "GET") return route.continue()
    requests.push(log)
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
    if (url.pathname === "/api/__fixture_boundary_probe__") return json({ intercepted: true, method })
    if (method === "GET") {
      if (path === "me") return json({ userId: id(1), role: "owner", employeeId: id(1), tenantId: id(2), authority: null })
      if (path === "user-prefs") return json({ prefs: { density: "comfortable" } })
      if (path === "threads") return json({ threads: [...threads.values()].map(x => x.thread), nextCursor: null })
      if (/^threads\/[^/]+\/canvas$/.test(path)) return json({ state: null })
      if (/^threads\/[^/]+$/.test(path)) return json(threads.get(path.split("/")[1]) ?? {}, threads.has(path.split("/")[1]) ? 200 : 404)
      if (/^works\/[^/]+$/.test(path)) {
        if (failPrimaryReads && path === `works/${id(20)}`) return json({ error: "Fixture Work source offline" }, 503)
        return json({ work: works.get(path.split("/")[1]) ?? aggregate(29) })
      }
      if (path === "works") return json({ works: [primary.work] })
      if (path === "read-models/attention") return json({ data: { items: [{ id: "cedar-review", workId: id(20), kind: "approval", reason: "Review Cedar evidence request", nextHumanBoundary: { description: "Review exact recipient and message before release" } }], sourceStatus: { status: "complete" } } })
      if (path === "actions/pending") return json({ actions: [pendingAction, { ...pendingAction, id: id(99), workId: id(999), summary: "FOREIGN WORK — MUST NOT APPEAR" }], page: { limit: 100, hasMore: false, complete: true, nextCursor: null } })
      if (path === "stream") return route.fulfill({ contentType: "text/event-stream", body: `id: 1\ndata: ${JSON.stringify({ seq: 1, phase: "completed", payload: {}, createdAt: at })}\n\n` })
      if (path.endsWith("/events")) return json({ events: [], nextCursor: null })
      if (path === "organization/transformation-programs/read") return json({ error: "No fixture programme" }, 404)
      if (path === "organization/transformation-programs/offers") return json({ access: "PARTICIPANT", offers: [], parentPrivateDataDisclosed: false })
      if (path === "organization/transformation-programs/packets") return json({ access: "ORIGINAL_CONTROL_RECIPIENT", packets: [], parentPrivateDataDisclosed: false, unavailablePacketCount: 0, approvalGranted: false, externalEffectDispatched: false })
      if (path === "organization/transformation-programs/input") return json({ workId: url.searchParams.get("workId"), originalInput: null, executionAuthorityGranted: false })
      if (path === "workforce/execution-programs") return json({ workId: url.searchParams.get("workId"), complete: true, data: [], originalInput: null })
      if (path === `private-equity/ic/cases/${id(271)}`) return json({
        viewer: { employeeId: id(1) }, case: { id: id(271), dealId: id(270), investmentCaseId: id(272), state: "READY_FOR_REVIEW", version: 1, voteSetVersion: 1, votingBasisVersion: null, currentRecommendationId: null, currentMemoId: null, primaryUnderwritingRunId: null },
        investmentCase: { id: id(272), title: "Cedar IC review" }, committee: { config: {}, members: [] },
        memo: null, deck: null, artifacts: { memo: null, deck: null }, underwriting: null,
        questions: [], recommendations: [], currentRecommendation: null, votes: [], dissents: [], conditions: [], decisionProposal: null, decision: null, decisionProof: null,
        readiness: { votingEligible: false, decisionEligible: false, blockers: ["No committee authority in fixture"], aggregation: null }, controls: {}, controlBlockers: {}, asOf: at,
      })
    }
    if (method === "POST" && path === "company-brain/application-projection") return json({
      schema: "finnor.x2.work-projection.v1", tenantId: id(2), principalId: id(1),
      workId: request.postDataJSON().workId, root: request.postDataJSON().root, sessions: [],
    })
    if (method === "POST" && path === "company-brain/projection") return json({
      root: request.postDataJSON().root, asOf: at, nodes: [], edges: [],
      temporal: { support: "current", completeness: "complete", baseline: null, reasons: [] },
      sourceStatus: [], bounds: { nodes: 0, edges: 0, truncated: false, maxNodes: 100, maxEdges: 100 },
    })
    if (method === "POST" && path === "company-brain/institution-read") return json({ sources: { workId: request.postDataJSON().workId, workInputId: null, grants: [], request: null }, programme: null })
    if (method === "POST" && path === "company-brain/roots") return json({ results: [] })
    if (method === "POST" && path === "threads") {
      const body = request.postDataJSON()
      if (body.workId) return json({ thread: threads.get(id(10))!.thread })
      const loaded = thread(created++, "Fixture conversation")
      threads.set(loaded.thread.id, loaded)
      return json({ thread: loaded.thread })
    }
    if (method === "POST" && path === "actions") {
      const body = request.postDataJSON()
      const loaded = threads.get(body.threadId)!
      const isObjective = /Prepare the Project Cedar/.test(body.instruction)
      const sameWork = /same work/i.test(body.instruction)
      const isPlain = /MOIC/i.test(body.instruction) && !isObjective
      const workId = isObjective || sameWork ? id(20) : id(29)
      if (!works.has(workId)) works.set(workId, { ...aggregate(29), work: { ...aggregate(29).work, executionModel: "instruction" } })
      loaded.thread.activeWorkId = workId
      append(loaded, body.instruction, isObjective ? objectiveReply : sameWork ? followupReply : isPlain ? plainReply : greetingReply, workId, isObjective, body.instructionId)
      return json({ instructionId: body.instructionId, threadId: body.threadId, workId })
    }
    unexpected.push(`${method} ${path}`)
    log.disposition = "blocked-unhandled"
    return json({ error: `Unconfigured isolated fixture: ${method} ${path}` }, 501)
  })
  return { requests, unexpected, works, threads, stalePrimary() { failPrimaryReads = true } }
}
