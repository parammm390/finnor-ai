import type { IcWorkspace, UnderwritingValue, UnderwritingWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"
import type { CompanyBrainNode, CompanyBrainProjection } from "@/components/centropy/pe/contracts"
import type { LoadedConversationThread } from "../thread/thread-contract"
import { CanvasDocumentSchema, type CanvasBlock, type CanvasDocument, type CanvasEntityRef, type CanvasSourceRef, type CanvasTruthState } from "./canvas-contract"

const stateOf = (value: string): "verified" | "active" | "waiting" | "blocked" => /fail|block|reject|cancel/i.test(value) ? "blocked" : /complete|final|succeed|verif|pass/i.test(value) ? "verified" : /active|running|progress|pending|queued/i.test(value) ? "active" : "waiting"
const oneLine = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300)
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ["summary", "reason", "message", "outcome", "result", "status", "state"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim().slice(0, 300)
  }
  return null
}
const sourceRefs = (nodes: CompanyBrainNode[]): CanvasSourceRef[] => [...new Map(nodes.flatMap((node) => node.provenanceRefs).map((source) => [`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`, { owner: source.owner, table: source.table, id: source.id, ...(source.fieldPath ? { fieldPath: source.fieldPath } : {}) }])).values()]
const entityRefs = (nodes: CompanyBrainNode[]): CanvasEntityRef[] => nodes.map((node) => ({ namespace: node.ref.namespace, owner: node.ref.owner, type: node.ref.type, id: node.ref.id }))
const projectionTruth = (projection: CompanyBrainProjection, nodes: CompanyBrainNode[]): CanvasTruthState => nodes.some((node) => node.epistemicState === "CONFLICTING") ? "CONFLICTING" : projection.bounds.truncated || projection.sourceStatus.some((source) => source.status !== "complete") || projection.temporal.completeness !== "complete" ? "PARTIAL" : nodes.length ? "KNOWN" : "KNOWN_EMPTY"
const rows = (nodes: CompanyBrainNode[]) => nodes.map((node) => ({ id: `${node.ref.type}:${node.ref.id}`, label: node.label, state: node.state ?? node.epistemicState, ...(node.epistemicWarnings.length ? { detail: node.epistemicWarnings[0]?.reason ?? "Coverage caveat" } : {}) }))
const nodeLabel = (value: string) => value.replace(/^output[._]/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._]/g, " ").toLowerCase()
const financialValue = (value: UnderwritingValue) => typeof value === "object" ? Object.entries(value).map(([key, item]) => `${key}: ${item}`).join(" · ").slice(0, 300) : String(value)

/** Compose presentation from canonical records. No business fact is persisted in browser state. */
export function composeCanvasDocument(params: { thread: LoadedConversationThread["thread"]; work: WorkAggregateView | null; projection: CompanyBrainProjection | null; underwriting?: UnderwritingWorkspace | null; ic?: IcWorkspace | null; builtAt?: string }): CanvasDocument {
  const { thread, work, projection, underwriting, ic } = params
  const builtAt = params.builtAt ?? new Date().toISOString()
  const blocks: CanvasBlock[] = []
  if (work) {
    const asOf = work.work.updatedAt
    const latestPlan = work.planRevisions[0]
    const receipt = work.receipts.find((item) => item.finalizedAt) ?? work.receipts[0]
    const completedReads = work.queryExecutions.filter((query) => query.status === "succeeded")
    const failedReads = work.queryExecutions.filter((query) => query.status === "failed")
    const verified = Boolean(latestPlan?.completionProof && typeof latestPlan.completionProof === "object" && !Array.isArray(latestPlan.completionProof) && (latestPlan.completionProof as Record<string, unknown>).verified === true)
    blocks.push({
      id: `work:${work.work.id}`, type: "work_execution", schemaVersion: 1, sourceKind: "work", title: "Work and verification", payload: {
        objective: work.work.initialInstruction, status: work.work.status,
        stages: [
          { id: "objective", label: work.work.executionModel === "objective" ? "Objective" : "Instruction", state: "verified", detail: work.work.executionModel === "objective" ? "Captured as durable Work" : "Linked to durable Work" },
          { id: "plan", label: "Work Plan", state: latestPlan ? stateOf(latestPlan.status) === "blocked" ? "blocked" : "verified" : "waiting", detail: latestPlan ? `Revision ${latestPlan.revision} · ${latestPlan.reason}` : "No selected Work Plan revision" },
          { id: "execution", label: "Work execution",
            state: work.actions.some((item) => stateOf(item.status) === "blocked") || failedReads.length ? "blocked"
              : work.work.status === "completed" && (work.actions.length || completedReads.length) ? "verified"
                : work.actions.length || completedReads.length ? "active" : "waiting",
            detail: `${work.actions.length} recorded Work action${work.actions.length === 1 ? "" : "s"} · ${completedReads.length} completed canonical read${completedReads.length === 1 ? "" : "s"}${completedReads.length ? ` (${[...new Set(completedReads.map((query) => query.intent.replaceAll("_", " ")))].join(", ")})` : ""} · ${work.businessEffects.length} observed business effect${work.businessEffects.length === 1 ? "" : "s"}` },
          { id: "verification", label: "Verification", state: verified || Boolean(receipt?.finalizedAt && !receipt.failure) ? "verified" : receipt?.failure ? "blocked" : receipt ? "active" : "waiting", detail: verified ? "Completion proof verified" : receipt?.finalizedAt ? "Finalized receipt recorded" : receipt ? "Receipt pending finalization" : "No finalized receipt" },
          { id: "outcome", label: "Outcome",
            state: work.work.failure || ["failed", "cancelled"].includes(work.work.status) ? "blocked"
              : work.work.status === "completed" && work.work.finalOutcome ? "verified" : "waiting",
            detail: work.work.failure ? "Failure outcome recorded"
              : work.work.status === "completed" && work.work.finalOutcome ? oneLine(work.work.finalOutcome) ?? "Structured outcome persisted"
                : "Final outcome pending", },
        ],
        finalOutcome: oneLine(work.work.finalOutcome), failure: oneLine(work.work.failure),
      },
      entityRefs: [], sourceRefs: work.queryExecutions.map((query) => ({ owner: "Work", table: "work_query_executions", id: query.id })),
      workRefs: [{ workId: work.work.id, recordType: "work" }, ...work.queryExecutions.map((query) => ({ workId: work.work.id, recordType: "work_query_execution", recordId: query.id }))],
      truthState: "KNOWN", asOf, createdAt: work.work.createdAt, updatedAt: asOf,
    })
    if (receipt) blocks.push({ id: `receipt:${receipt.id}`, type: "decision_receipt", schemaVersion: 1, sourceKind: "work", title: "Decision receipt", payload: { status: receipt.failure ? "Failed" : receipt.finalizedAt ? "Finalized" : "Pending", result: oneLine(receipt.actualResult) ?? (receipt.actualResult ? "Structured result recorded" : "No actual result recorded"), finalizedAt: receipt.finalizedAt, failure: oneLine(receipt.failure) }, entityRefs: [], sourceRefs: [], workRefs: [{ workId: work.work.id, recordType: "decision_receipt", recordId: receipt.id }], truthState: receipt.finalizedAt ? "KNOWN" : "PARTIAL", asOf: receipt.finalizedAt ?? asOf, createdAt: asOf, updatedAt: receipt.finalizedAt ?? asOf })
  }
  if (projection) {
    const nodes = projection.nodes
    const companyEdge=projection.edges.find(edge=>edge.fromRef.id===projection.root.entityId&&["deal_company","opportunity_company"].includes(edge.relationship))
    const programRoot=companyEdge&&/^[0-9a-f-]{36}$/i.test(companyEdge.toRef.id)?{entityType:"external_organization",entityId:companyEdge.toRef.id}:projection.root
    if(programRoot.entityType==="external_organization"){blocks.push({id:"interface-synthesis:"+programRoot.entityId,type:"interface_synthesis",schemaVersion:1,sourceKind:"company_brain",title:"Interface acquisition",payload:{root:programRoot,workId:work?.work.id??thread.activeWorkId??null,threadId:thread.id},entityRefs:[],sourceRefs:companyEdge?[{owner:companyEdge.sourceRef.owner,table:companyEdge.sourceRef.table,id:companyEdge.sourceRef.id}]:[],workRefs:work?[{workId:work.work.id,recordType:"interface_capability"}]:[],truthState:"UNKNOWN",asOf:projection.asOf,createdAt:projection.asOf,updatedAt:projection.asOf})}
    if(programRoot.entityType==="external_organization"){blocks.push({id:"program-synthesis:"+programRoot.entityId,type:"program_synthesis",schemaVersion:1,sourceKind:"company_brain",title:"Analytical method",payload:{root:programRoot,workId:work?.work.id??thread.activeWorkId??null,threadId:thread.id},entityRefs:[],sourceRefs:companyEdge?[{owner:companyEdge.sourceRef.owner,table:companyEdge.sourceRef.table,id:companyEdge.sourceRef.id}]:[],workRefs:work?[{workId:work.work.id,recordType:"harness_program"}]:[],truthState:"UNKNOWN",asOf:projection.asOf,createdAt:projection.asOf,updatedAt:projection.asOf})}
    if(programRoot.entityType==="external_organization"){blocks.push({id:"compute-search:"+programRoot.entityId,type:"compute_search",schemaVersion:1,sourceKind:"company_brain",title:"Allocated computation",payload:{root:programRoot,workId:work?.work.id??thread.activeWorkId??null,threadId:thread.id},entityRefs:[],sourceRefs:companyEdge?[{owner:companyEdge.sourceRef.owner,table:companyEdge.sourceRef.table,id:companyEdge.sourceRef.id}]:[],workRefs:work?[{workId:work.work.id,recordType:"compute_search"}]:[],truthState:"UNKNOWN",asOf:projection.asOf,createdAt:projection.asOf,updatedAt:projection.asOf})}
    if(programRoot.entityType==="external_organization"){blocks.push({id:"deliberation:"+programRoot.entityId,type:"deliberation_policy",schemaVersion:1,sourceKind:"company_brain",title:"Deliberation",payload:{root:programRoot,workId:work?.work.id??thread.activeWorkId??null,threadId:thread.id},entityRefs:[],sourceRefs:companyEdge?[{owner:companyEdge.sourceRef.owner,table:companyEdge.sourceRef.table,id:companyEdge.sourceRef.id}]:[],workRefs:work?[{workId:work.work.id,recordType:"deliberation_policy"}]:[],truthState:"UNKNOWN",asOf:projection.asOf,createdAt:projection.asOf,updatedAt:projection.asOf})}
    if(companyEdge&&/^[0-9a-f-]{36}$/i.test(companyEdge.toRef.id)){blocks.push({id:"evidence-execution:"+companyEdge.toRef.id,type:"evidence_execution",schemaVersion:1,sourceKind:"company_brain",title:"Evidence calculations",payload:{root:{entityType:"external_organization",entityId:companyEdge.toRef.id},workId:work?.work.id??null},entityRefs:[],sourceRefs:[{owner:companyEdge.sourceRef.owner,table:companyEdge.sourceRef.table,id:companyEdge.sourceRef.id}],workRefs:[],truthState:"UNKNOWN",asOf:projection.asOf,createdAt:projection.asOf,updatedAt:projection.asOf})}
    const select = (...types: string[]) => nodes.filter((node) => types.includes(node.type))
    const conditions = select("pe_closing_condition", "pe_closing_item")
    const risks = select("pe_deal_risk", "pe_finding")
    const questions = select("pe_ic_question", "pe_ic_dissent")
    const decisions = select("pe_ic_decision_proposal", "pe_ic_decision", "pe_decision")
    const evidence = select("pe_evidence_link", "evidence_source", "source_coverage", "source_conflict")
    const isClosing = /clos|readiness|terminal/i.test(thread.title ?? "") || conditions.length > 0
    const makeBlock = (id: string, type: CanvasBlock["type"], title: string, group: CompanyBrainNode[], payload: CanvasBlock["payload"]): CanvasBlock => ({ id, type, schemaVersion: 1, sourceKind: "company_brain", title, payload, entityRefs: entityRefs(group), sourceRefs: sourceRefs(group), workRefs: group.flatMap((node) => node.workRefs.map((ref) => ({ workId: ref.workId, recordType: "company_brain" }))), truthState: projectionTruth(projection, group), asOf: projection.asOf, createdAt: projection.asOf, updatedAt: projection.asOf } as CanvasBlock)
    if (isClosing) blocks.push(makeBlock("closing", "closing_readiness", "Closing conditions", conditions, { conditions: rows(conditions), openRisks: risks.filter((node) => !/clos|resolv|complete|final/i.test(node.state ?? "")).length, sourceCoverage: projection.sourceStatus.every((source) => source.status === "complete") ? "Complete for supported sources" : "Partial source coverage" }))
    if (risks.length) blocks.push(makeBlock("risks", "risk_register", "Risks and findings", risks, { risks: rows(risks) }))
    if (questions.length || decisions.length) blocks.push(makeBlock("ic", "ic_readiness", "Investment committee", [...questions, ...decisions], { questions: rows(questions), decisions: rows(decisions) }))
    if (evidence.length) blocks.push(makeBlock("evidence", "evidence_matrix", "Evidence and source coverage", evidence, { items: rows(evidence), conflicts: evidence.filter((node) => node.type === "source_conflict").length }))
  }
  if (underwriting) {
    const run = underwriting.runs.filter((candidate) => !candidate.sensitivityCell).sort((left, right) => Date.parse(right.computedAt) - Date.parse(left.computedAt))[0] ?? null
    const version = underwriting.modelVersions.find((item) => item.id === run?.modelVersionId) ?? null
    const model = underwriting.models.find((item) => item.id === version?.modelId) ?? null
    const scenario = underwriting.scenarios.find((item) => item.id === run?.scenarioId) ?? null
    const caseNodes = projection?.nodes.filter((node) => node.ref.id === underwriting.investmentCase.id || node.ref.id === run?.id) ?? []
    blocks.push({
      id: `underwriting:${underwriting.investmentCase.id}`, type: "underwriting_summary", schemaVersion: 1, sourceKind: "underwriting", title: "Underwriting model", payload: {
        investmentCaseTitle: underwriting.investmentCase.title,
        modelName: model?.name ?? "Model name unavailable", modelVersion: version?.versionKey ?? null,
        scenarioName: scenario?.name ?? (run?.scenarioId ? "Scenario name unavailable" : "Base case"),
        runId: run?.id ?? null, status: run?.status ?? (underwriting.invalidatedRuns?.length?"INVALIDATED":"NO RUN"), validity: run?.validity ?? "UNKNOWN",
        outputs: run?.result ? Object.entries(run.result.outputs).map(([nodeId, output]) => ({ nodeId, label: nodeLabel(nodeId), value: financialValue(output.value), unit: output.currency ? `${output.currency} · ${output.unit}` : output.unit, truthClass: output.truthClass })) : [],
        failedChecks: run?.result?.checks.filter((check) => !check.passed).map((check) => ({ nodeId: check.nodeId, code: check.code, message: check.message, severity: check.severity })) ?? [],
      },
      entityRefs: entityRefs(caseNodes), sourceRefs: sourceRefs(caseNodes), workRefs: run?.workId ? [{ workId: run.workId, recordType: "underwriting_run", recordId: run.id }] : [],
      truthState: !run&&underwriting.invalidatedRuns?.length?"STALE":run ? "KNOWN" : "KNOWN_EMPTY", asOf: run?.computedAt ?? underwriting.investmentCase.updatedAt, createdAt: underwriting.investmentCase.createdAt, updatedAt: run?.computedAt ?? underwriting.investmentCase.updatedAt,
    })
  }
  if (ic) {
    const icRecordIds = new Set([ic.case.id, ...ic.questions.map((row) => row.id), ...ic.votes.map((row) => row.id), ...ic.dissents.map((row) => row.id), ...ic.conditions.map((row) => row.id)])
    const icNodes = projection?.nodes.filter((node) => icRecordIds.has(node.ref.id)) ?? []
    const quorum = ic.readiness.aggregation?.quorum ?? null
    blocks.push({
      id: `ic-governance:${ic.case.id}`, type: "ic_governance", schemaVersion: 1, sourceKind: "ic", title: "Committee governance", payload: {
        caseTitle: ic.investmentCase.title ?? "Investment committee case", caseState: ic.case.state,
        terminalDecision: Boolean(ic.decision) || ["DECIDED", "CLOSED"].includes(ic.case.state.toUpperCase()),
        votingEligible: ic.readiness.votingEligible, decisionEligible: ic.readiness.decisionEligible,
        blockers: ic.readiness.blockers,
        quorum: quorum ? { status: quorum.status, actual: quorum.actual, required: quorum.required } : null,
        questions: ic.questions.map((question) => ({ id: `pe_ic_question:${question.id}`, label: question.question ?? "Recorded question", state: question.state ?? "UNKNOWN", ...(question.answer ? { detail: question.answer } : {}) })),
        votes: ic.votes.length, dissents: ic.dissents.length, conditions: ic.conditions.length,
        decision: ic.decision ? [ic.decision.decision, ic.decision.state].filter(Boolean).join(" · ") || "Recorded Decision" : null,
      },
      entityRefs: entityRefs(icNodes), sourceRefs: sourceRefs(icNodes), workRefs: [], truthState: "KNOWN", asOf: ic.asOf, createdAt: ic.asOf, updatedAt: ic.asOf,
    })
  }
  const newestUnderwritingRun = underwriting?.runs.reduce((newest, run) => !newest || Date.parse(run.computedAt) > Date.parse(newest.computedAt) ? run : newest, null as UnderwritingWorkspace["runs"][number] | null) ?? null
  const canonicalSignature = `${thread.revision}:${work?.work.id ?? "none"}:${work?.work.updatedAt ?? "none"}:${projection?.root.entityId ?? "none"}:${projection?.asOf ?? "none"}:${underwriting?.runs.length ?? "unavailable"}:${newestUnderwritingRun?.resultHash ?? underwriting?.investmentCase.updatedAt ?? "none"}:${ic?.case.version ?? "none"}:${ic?.case.voteSetVersion ?? "none"}`
  return CanvasDocumentSchema.parse({ schemaVersion: 1, threadId: thread.id, title: thread.title ?? "Investigation", revision: { uiRevision: thread.revision, canonicalSignature, builtAt }, layout: { mode: "document", blockIds: blocks.map((block) => block.id) }, blocks })
}
