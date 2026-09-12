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

export function inspectionSurface(target: InspectionTarget): "/jarvis" | "/jarvis/deals" | "/jarvis/work" | "/jarvis/agents" {
  switch (target.kind) {
    case "pe_context":
    case "underwriting":
    case "ic":
    case "document":
    case "evidence":
      return "/jarvis/deals"
    case "work":
    case "plan_revision":
    case "plan_node":
    case "domain_action":
    case "business_effect":
    case "decision_receipt":
    case "completion_proof":
      return "/jarvis/work"
    case "agent":
    case "assignment":
      return "/jarvis/agents"
    case "attention":
    case "raw_activity":
      return "/jarvis"
    case "brain_object":
      if (target.ref.namespace === "workforce") return "/jarvis/agents"
      if (target.ref.namespace === "planning" || target.ref.type === "work" || target.ref.type === "domain_action" || target.ref.type === "business_effect" || target.ref.type === "decision_receipt") return "/jarvis/work"
      return "/jarvis/deals"
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
  for (const key of ["root", "object", "workId", "inspect"]) params.delete(key)
  if (context.root) params.set("root", JSON.stringify(context.root))
  if (context.selectedObject) params.set("object", JSON.stringify(context.selectedObject))
  if (context.workId) params.set("workId", context.workId)
  if (target) params.set("inspect", JSON.stringify(target))
  const suffix = params.size ? `?${params.toString()}` : ""
  return `${path}${suffix}${hash ? `#${hash}` : ""}`
}

export function inspectionHref(context: PeOperatingContext, target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): string | null {
  const next = contextForInspection(context, target, subjectRef)
  if (!next.root) return null
  return withPeOperatingContext(inspectionSurface(target), next, target)
}

export function rootContext(root: PeWorldRootRef): PeOperatingContext {
  return { root, selectedObject: null, workId: null }
}
