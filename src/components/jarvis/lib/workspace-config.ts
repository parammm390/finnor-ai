export * from "./workspace-config.generated"

import type {
  ExperienceScene,
  TenantWorkspaceConfig,
  WorkspaceSurfaceKey,
} from "./workspace-config.generated"

export function orderedWorkspaceItems<T extends { key: WorkspaceSurfaceKey }>(
  items: T[],
  config: TenantWorkspaceConfig,
  role?: "owner",
): T[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const roleSurfaces = role ? new Set(config.roles.owner.visibleSurfaces) : null
  return config.navigationPriority.flatMap((key) => (
    config.enabledSurfaces.includes(key)
      && (!roleSurfaces || roleSurfaces.has(key))
      && byKey.has(key)
      ? [byKey.get(key)!]
      : []
  ))
}

export function inspectorFieldVisible(label: string, config: TenantWorkspaceConfig): boolean {
  const normalized = label.toLocaleLowerCase()
  if (!config.visibility.policy && normalized.includes("policy")) return false
  if (!config.visibility.authority && (normalized.includes("authority") || normalized.includes("permission"))) return false
  return true
}

const CANONICAL_VOCABULARY_KEYS: Record<string, keyof TenantWorkspaceConfig["vocabulary"]> = {
  deal: "deal",
  portfolio_company: "portfolioCompany",
  deal_party: "dealParty",
  workstream: "workstream",
  request: "request",
  deliverable: "deliverable",
  finding: "finding",
  risk: "risk",
  closing_condition: "closingCondition",
  closing_item: "closingItem",
  task: "task",
  work: "work",
}

/** Presentation-only label lookup. Canonical IDs and entity types never change. */
export function vocabularyLabel(canonical: string, config: TenantWorkspaceConfig): string {
  const key = CANONICAL_VOCABULARY_KEYS[canonical]
  return key
    ? config.vocabulary[key]
    : canonical.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

export function effectiveMotionPreference(
  configured: TenantWorkspaceConfig["brand"]["motion"],
  reducedMotion: boolean,
): "reduced" | TenantWorkspaceConfig["brand"]["motion"] {
  return reducedMotion ? "reduced" : configured
}

/** V3 has no tenant extension slots. Kept as a presentation helper for scenes. */
export function sceneSlot(_scene: ExperienceScene): null {
  return null
}
