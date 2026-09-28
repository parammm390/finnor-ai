import type { CompanyBrainObjectRef, PeWorldRootRef } from "@/components/centropy/pe/contracts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CORE_CANONICAL_TYPES: Record<string, string> = {
  document: "document",
  evidence_source: "evidence_source",
  evidence_version: "evidence_source_version",
  work: "work",
  domain_action: "domain_action",
  decision_receipt: "decision_receipt",
}

export interface OperatingEntityRef { entityType: string; entityId: string }

/** WORLD projection names are presentation types; intake requires registry types. */
export function canonicalWorldFocus(ref: CompanyBrainObjectRef | null): OperatingEntityRef | null {
  if (!ref || !UUID.test(ref.id)) return null
  const entityType = ref.namespace === "private_equity" ? ref.type
    : ref.namespace === "core" ? CORE_CANONICAL_TYPES[ref.type] : undefined
  return entityType ? { entityType, entityId: ref.id } : null
}

export function operatingSelection(root: PeWorldRootRef | null, focused: CompanyBrainObjectRef | null): {
  focusedEntity?: OperatingEntityRef
  selectedEntities: OperatingEntityRef[]
} {
  const exact = canonicalWorldFocus(focused)
  return {
    ...(exact ? { focusedEntity: exact } : {}),
    selectedEntities: exact ? [exact] : root ? [{ entityType: root.entityType, entityId: root.entityId }] : [],
  }
}
