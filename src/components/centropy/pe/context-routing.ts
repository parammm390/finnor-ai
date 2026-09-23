import {
  isCompanyBrainObjectRef,
  isInspectionTarget,
  isPeWorldRootRef,
  type CompanyBrainObjectRef,
  type InspectionTarget,
  type PeOperatingContext,
  type PeWorldRootRef,
} from "./contracts"

export const EMPTY_PE_CONTEXT: PeOperatingContext = { root: null, selectedObject: null, workId: null }
export const DEAL_SECTION_KEYS = ["overview", "underwriting", "diligence", "ic", "evidence", "closing", "work", "activity"] as const
export type DealSectionKey = (typeof DEAL_SECTION_KEYS)[number]

function parseJson(value: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

export function readPeOperatingContext(params: Pick<URLSearchParams, "get">): PeOperatingContext {
  const root = parseJson(params.get("root"))
  const selectedObject = parseJson(params.get("object"))
  const workId = params.get("workId")
  if (!isPeWorldRootRef(root)) return EMPTY_PE_CONTEXT
  return {
    root,
    selectedObject: isCompanyBrainObjectRef(selectedObject) ? selectedObject : null,
    workId: workId?.trim() || null,
  }
}

export function readInspectionTarget(params: Pick<URLSearchParams, "get">): InspectionTarget | null {
  const target = parseJson(params.get("inspect"))
  return isInspectionTarget(target) ? target : null
}

export function rootFromDealPath(pathname: string): PeWorldRootRef | null {
  const match = /^\/centropy\/deals\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i.exec(pathname)
  return match?.[1] ? { entityType: "pe_deal", entityId: match[1] } : null
}

export function dealSectionForTarget(target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): DealSectionKey {
  if (target.kind === "underwriting") return "underwriting"
  if (target.kind === "ic") return "ic"
  if (target.kind === "evidence" || target.kind === "document") return "evidence"
  if (["work", "plan_revision", "plan_node", "domain_action", "business_effect", "decision_receipt", "completion_proof", "assignment", "attention"].includes(target.kind)) return "work"
  const ref = target.kind === "brain_object" ? target.ref : target.kind === "pe_context" ? target.objectRef : subjectRef
  if (!ref) return "overview"
  if (ref.namespace === "underwriting") return "underwriting"
  if (ref.namespace === "planning" || ["work", "domain_action", "business_effect", "decision_receipt", "completion_proof", "attention", "agent_assignment"].includes(ref.type)) return "work"
  if (["document", "document_version", "evidence_source", "evidence_version", "source_observation", "source_coverage", "source_conflict", "pe_document_link", "pe_evidence_link"].includes(ref.type)) return "evidence"
  if (ref.type.startsWith("pe_ic_")) return "ic"
  if (["pe_workstream", "pe_request", "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_finding_risk_link", "pe_dependency", "pe_milestone"].includes(ref.type)) return "diligence"
  if (ref.type === "pe_closing_condition" || ref.type === "pe_closing_item") return "closing"
  return "overview"
}

export function inspectionSurface(target: InspectionTarget): "/centropy" | "/centropy/deals" | "/centropy/work" | "/centropy/agents" {
  switch (target.kind) {
    case "pe_context":
    case "underwriting":
    case "ic":
    case "document":
    case "evidence":
      return "/centropy/deals"
    case "work":
    case "plan_revision":
    case "plan_node":
    case "domain_action":
    case "business_effect":
    case "decision_receipt":
    case "completion_proof":
      return "/centropy/work"
    case "agent":
    case "assignment":
      return "/centropy/agents"
    case "attention":
    case "raw_activity":
      return "/centropy"
    case "brain_object":
      if (target.ref.namespace === "workforce") return "/centropy/agents"
      if (target.ref.namespace === "planning" || target.ref.type === "work" || target.ref.type === "domain_action" || target.ref.type === "business_effect" || target.ref.type === "decision_receipt") return "/centropy/work"
      return "/centropy/deals"
  }
}

function targetWorkId(target: InspectionTarget): string | null {
  return "workId" in target && typeof target.workId === "string" ? target.workId : null
}

function targetObject(target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): CompanyBrainObjectRef | null {
  if (target.kind === "brain_object") return target.ref
  if (target.kind === "pe_context" || target.kind === "ic") return target.objectRef ?? subjectRef ?? null
  return subjectRef ?? null
}

export function contextForInspection(context: PeOperatingContext, target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): PeOperatingContext {
  const root = target.kind === "pe_context" ? target.root : context.root
  if (!root) return EMPTY_PE_CONTEXT
  return {
    root,
    selectedObject: targetObject(target, subjectRef),
    workId: targetWorkId(target) ?? context.workId,
  }
}

export function withPeOperatingContext(href: string, context: PeOperatingContext, target?: InspectionTarget | null): string {
  const [withoutHash, hash] = href.split("#", 2)
  const [path, query] = withoutHash!.split("?", 2)
  const params = new URLSearchParams(query ?? "")
  for (const key of ["root", "object", "workId", "inspect", "inspectorTab"]) params.delete(key)
  if (context.root) params.set("root", JSON.stringify(context.root))
  if (context.selectedObject) params.set("object", JSON.stringify(context.selectedObject))
  if (context.workId) params.set("workId", context.workId)
  if (target) params.set("inspect", JSON.stringify(target))
  const suffix = params.size ? `?${params.toString()}` : ""
  return `${path}${suffix}${hash ? `#${hash}` : ""}`
}

export function inspectionHref(context: PeOperatingContext, target: InspectionTarget, subjectRef?: CompanyBrainObjectRef, currentPath?: string): string | null {
  const next = contextForInspection(context, target, subjectRef)
  if (!next.root) return null
  const surface = inspectionSurface(target)
  const path = surface === "/centropy/deals" && next.root.entityType === "pe_deal"
    ? `/centropy/deals/${next.root.entityId}/${dealSectionForTarget(target, subjectRef)}`
    : surface === "/centropy/deals" && currentPath?.startsWith("/centropy/deals/")
      ? currentPath
      : surface
  return withPeOperatingContext(path, next, target)
}

export function rootContext(root: PeWorldRootRef): PeOperatingContext {
  return { root, selectedObject: null, workId: null }
}
