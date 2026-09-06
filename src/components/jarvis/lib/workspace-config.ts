import { z } from "zod"

export const TENANT_EXPERIENCE_VERSION = 2 as const
export const WORKSPACE_SURFACES = ["home", "work", "customers", "schedule", "money", "agents"] as const
export type WorkspaceSurfaceKey = typeof WORKSPACE_SURFACES[number]
export type WorkspaceAccent = "cyan" | "teal" | "amber" | "violet"
export type ExperienceRole = "owner" | "dispatcher" | "technician"
export type ExperienceScene = "ready" | "listening" | "plan" | "approval" | "working" | "outcome" | "recovery"
export type ExperienceMetricKey = "pending_approvals" | "collected_usd" | "overdue_invoice_value" | "open_leads" | "runs_in_flight" | "stuck_runs" | "stock_risk_items" | "technician_load" | "assigned_work_today"
export type ExperienceQuickActionKey = "review_pending_approvals" | "review_overdue_invoices" | "inspect_blocked_work" | "review_pipeline" | "review_stock_risk" | "review_schedule" | "review_technician_load" | "open_my_day"
export type ExperienceProjectionKey = "customer" | "schedule" | "money" | "work" | "inventory" | "computer" | "assigned-day"
export type ExperienceAttentionCategory = "recovery" | "approval" | "schedule" | "money" | "customer" | "work"
export type ExperienceExtensionSlot = "ready.primary" | "ready.secondary" | "plan.context" | "approval.context" | "working.visual" | "outcome.summary" | "recovery.context" | "role.owner" | "role.dispatcher" | "role.technician" | "inspector.extra"
export type ExperienceExtensionKey = "reference.northstar-service-priority" | "reference.summit-installation-readiness"

const SurfaceSchema = z.enum(WORKSPACE_SURFACES)
const MetricSchema = z.enum(["pending_approvals", "collected_usd", "overdue_invoice_value", "open_leads", "runs_in_flight", "stuck_runs", "stock_risk_items", "technician_load", "assigned_work_today"])
const QuickActionKeySchema = z.enum(["review_pending_approvals", "review_overdue_invoices", "inspect_blocked_work", "review_pipeline", "review_stock_risk", "review_schedule", "review_technician_load", "open_my_day"])
const ProjectionSchema = z.enum(["customer", "schedule", "money", "work", "inventory", "computer", "assigned-day"])
const AttentionSchema = z.enum(["recovery", "approval", "schedule", "money", "customer", "work"])

const SurfaceTerminologySchema = z.object({ home: z.string().trim().min(1).max(24), work: z.string().trim().min(1).max(24), customers: z.string().trim().min(1).max(24), schedule: z.string().trim().min(1).max(24), money: z.string().trim().min(1).max(24), agents: z.string().trim().min(1).max(24) }).strict()
const VocabularySchema = z.object({ customer: z.string().trim().min(1).max(32), homeowner: z.string().trim().min(1).max(32), account: z.string().trim().min(1).max(32), technician: z.string().trim().min(1).max(32), installer: z.string().trim().min(1).max(32), serviceVisit: z.string().trim().min(1).max(32), appointment: z.string().trim().min(1).max(32), quote: z.string().trim().min(1).max(32), proposal: z.string().trim().min(1).max(32), invoice: z.string().trim().min(1).max(32), job: z.string().trim().min(1).max(32), work: z.string().trim().min(1).max(32) }).strict()
const ExtensionSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("reference.northstar-service-priority"), config: z.object({ title: z.string().trim().min(1).max(64), emphasis: z.enum(["response", "retention", "cash"]) }).strict() }).strict(),
  z.object({ key: z.literal("reference.summit-installation-readiness"), config: z.object({ title: z.string().trim().min(1).max(64), emphasis: z.enum(["pipeline", "materials", "handoff"]) }).strict() }).strict(),
])
const ExtensionSlotsSchema = z.object({
  "ready.primary": ExtensionSchema.optional(), "ready.secondary": ExtensionSchema.optional(), "plan.context": ExtensionSchema.optional(), "approval.context": ExtensionSchema.optional(), "working.visual": ExtensionSchema.optional(), "outcome.summary": ExtensionSchema.optional(), "recovery.context": ExtensionSchema.optional(), "role.owner": ExtensionSchema.optional(), "role.dispatcher": ExtensionSchema.optional(), "role.technician": ExtensionSchema.optional(), "inspector.extra": ExtensionSchema.optional(),
}).strict()
const RoleSchema = z.object({
  startView: z.enum(["command", "schedule", "dispatch-map", "my-day"]),
  visibleSurfaces: z.array(SurfaceSchema).min(1).max(WORKSPACE_SURFACES.length),
  ready: z.object({
    primaryFocus: z.enum(["operational_attention", "cash", "dispatch", "pipeline", "service", "inventory", "assigned_work"]),
    heroMetric: MetricSchema.nullable(), pulseMetrics: z.array(MetricSchema).max(6), attentionCategories: z.array(AttentionSchema).min(1).max(6),
    quickActions: z.array(z.object({ key: QuickActionKeySchema, label: z.string().trim().min(1).max(48).optional() }).strict()).max(6),
    primaryProjection: ProjectionSchema,
  }).strict(),
}).strict()
const SceneSchema = z.object({ detail: z.enum(["compact", "balanced", "detailed"]), emphasis: z.enum(["presence", "context", "evidence"]) }).strict()

const METRIC_ROLES: Record<ExperienceMetricKey, ReadonlySet<ExperienceRole>> = {
  pending_approvals: new Set(["owner", "dispatcher"]), collected_usd: new Set(["owner"]), overdue_invoice_value: new Set(["owner"]), open_leads: new Set(["owner"]), runs_in_flight: new Set(["owner", "dispatcher"]), stuck_runs: new Set(["owner", "dispatcher"]), stock_risk_items: new Set(["owner"]), technician_load: new Set(["owner", "dispatcher"]), assigned_work_today: new Set(["owner", "technician"]),
}
const QUICK_ACTION_ROLES: Record<ExperienceQuickActionKey, ReadonlySet<ExperienceRole>> = {
  review_pending_approvals: new Set(["owner", "dispatcher"]), review_overdue_invoices: new Set(["owner"]), inspect_blocked_work: new Set(["owner", "dispatcher"]), review_pipeline: new Set(["owner"]), review_stock_risk: new Set(["owner"]), review_schedule: new Set(["owner", "dispatcher"]), review_technician_load: new Set(["owner", "dispatcher"]), open_my_day: new Set(["technician"]),
}
const ROLE_START_VIEWS: Record<ExperienceRole, ReadonlySet<string>> = { owner: new Set(["command"]), dispatcher: new Set(["schedule", "dispatch-map"]), technician: new Set(["my-day"]) }
const ROLE_PROJECTIONS: Record<ExperienceRole, ReadonlySet<ExperienceProjectionKey>> = { owner: new Set(["customer", "schedule", "money", "work", "inventory", "computer"]), dispatcher: new Set(["customer", "schedule", "work"]), technician: new Set(["assigned-day"]) }
const EXTENSION_SLOTS: Record<ExperienceExtensionKey, ReadonlySet<ExperienceExtensionSlot>> = {
  "reference.northstar-service-priority": new Set(["ready.primary", "role.owner", "role.dispatcher"]),
  "reference.summit-installation-readiness": new Set(["ready.primary", "ready.secondary", "role.owner", "outcome.summary"]),
}

/** Presentation-safe browser mirror of the canonical server schema in
 * finnor-os/apps/api/lib/workspace-config.ts. The server remains authoritative;
 * this second parse prevents malformed transport data from crashing the shell. */
export const TenantExperienceManifestV2Schema = z.object({
  version: z.literal(TENANT_EXPERIENCE_VERSION),
  enabledSurfaces: z.array(SurfaceSchema).min(1).max(WORKSPACE_SURFACES.length),
  terminology: SurfaceTerminologySchema,
  vocabulary: VocabularySchema,
  voiceEnabled: z.boolean(),
  navigationPriority: z.array(SurfaceSchema).length(WORKSPACE_SURFACES.length),
  brand: z.object({ accent: z.enum(["cyan", "teal", "amber", "violet"]), surfaceTone: z.enum(["ink", "slate", "sand"]), radius: z.enum(["precise", "soft"]), density: z.enum(["compact", "balanced", "spacious"]), typography: z.enum(["system", "editorial", "technical"]), motion: z.enum(["restrained", "standard", "expressive"]), mark: z.string().trim().min(1).max(3), logoAssetKey: z.enum(["finnor", "reference-northstar", "reference-summit"]) }).strict(),
  visibility: z.object({ policy: z.boolean(), authority: z.boolean() }).strict(),
  roles: z.object({ owner: RoleSchema, dispatcher: RoleSchema, technician: RoleSchema }).strict(),
  scenes: z.object({ ready: SceneSchema, listening: SceneSchema, plan: SceneSchema, approval: SceneSchema, working: SceneSchema, outcome: SceneSchema, recovery: SceneSchema }).strict(),
  extensions: ExtensionSlotsSchema,
}).strict().superRefine((value, ctx) => {
  if (!value.enabledSurfaces.includes("home")) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledSurfaces"], message: "Home must remain enabled" })
  if (new Set(value.enabledSurfaces).size !== value.enabledSurfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledSurfaces"], message: "Enabled surfaces must be unique" })
  if (new Set(value.navigationPriority).size !== WORKSPACE_SURFACES.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["navigationPriority"], message: "Navigation priority must contain every surface" })
  for (const role of ["owner", "dispatcher", "technician"] as const) {
    const roleConfig = value.roles[role]
    const surfaces = roleConfig.visibleSurfaces
    if (!surfaces.includes("home") || surfaces.some((surface) => !value.enabledSurfaces.includes(surface))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "visibleSurfaces"], message: "Invalid role surface visibility" })
    if (new Set(surfaces).size !== surfaces.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "visibleSurfaces"], message: "Role surfaces must be unique" })
    if (!ROLE_START_VIEWS[role].has(roleConfig.startView)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "startView"], message: "Unsupported role start view" })
    const metrics = [roleConfig.ready.heroMetric, ...roleConfig.ready.pulseMetrics].filter((metric): metric is ExperienceMetricKey => metric !== null)
    if (new Set(roleConfig.ready.pulseMetrics).size !== roleConfig.ready.pulseMetrics.length || metrics.some((metric) => !METRIC_ROLES[metric].has(role))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "ready", "pulseMetrics"], message: "Invalid role metric registry selection" })
    if (new Set(roleConfig.ready.quickActions.map((action) => action.key)).size !== roleConfig.ready.quickActions.length || roleConfig.ready.quickActions.some((action) => !QUICK_ACTION_ROLES[action.key].has(role))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "ready", "quickActions"], message: "Invalid role quick-action registry selection" })
    if (new Set(roleConfig.ready.attentionCategories).size !== roleConfig.ready.attentionCategories.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "ready", "attentionCategories"], message: "Attention categories must be unique" })
    if (!ROLE_PROJECTIONS[role].has(roleConfig.ready.primaryProjection)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", role, "ready", "primaryProjection"], message: "Invalid role projection" })
  }
  for (const [slot, extension] of Object.entries(value.extensions) as Array<[ExperienceExtensionSlot, TenantExtensionConfig | undefined]>) {
    if (extension && !EXTENSION_SLOTS[extension.key].has(slot)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["extensions", slot], message: "Extension is not registered for this slot" })
  }
})

export type TenantExperienceManifestV2 = z.infer<typeof TenantExperienceManifestV2Schema>
export type TenantWorkspaceConfig = TenantExperienceManifestV2
export type TenantExtensionConfig = z.infer<typeof ExtensionSchema>

export const DEFAULT_TENANT_WORKSPACE_CONFIG: TenantWorkspaceConfig = {
  version: 2,
  enabledSurfaces: [...WORKSPACE_SURFACES],
  terminology: { home: "Home", work: "Work", customers: "Customers", schedule: "Schedule", money: "Money", agents: "Agents" },
  vocabulary: { customer: "Customer", homeowner: "Homeowner", account: "Account", technician: "Technician", installer: "Installer", serviceVisit: "Service Visit", appointment: "Appointment", quote: "Quote", proposal: "Proposal", invoice: "Invoice", job: "Job", work: "Work" },
  voiceEnabled: true,
  navigationPriority: [...WORKSPACE_SURFACES],
  brand: { accent: "cyan", surfaceTone: "ink", radius: "soft", density: "balanced", typography: "system", motion: "standard", mark: "F", logoAssetKey: "finnor" },
  visibility: { policy: true, authority: true },
  roles: {
    owner: { startView: "command", visibleSurfaces: [...WORKSPACE_SURFACES], ready: { primaryFocus: "operational_attention", heroMetric: "pending_approvals", pulseMetrics: ["pending_approvals", "collected_usd", "overdue_invoice_value", "open_leads", "runs_in_flight"], attentionCategories: ["recovery", "approval", "schedule", "money", "customer", "work"], quickActions: [{ key: "inspect_blocked_work" }, { key: "review_overdue_invoices" }, { key: "review_pending_approvals" }], primaryProjection: "work" } },
    dispatcher: { startView: "schedule", visibleSurfaces: ["home", "work", "customers", "schedule", "agents"], ready: { primaryFocus: "dispatch", heroMetric: "technician_load", pulseMetrics: ["technician_load", "pending_approvals", "runs_in_flight", "stuck_runs"], attentionCategories: ["recovery", "approval", "schedule", "customer", "work"], quickActions: [{ key: "review_schedule" }, { key: "review_technician_load" }, { key: "inspect_blocked_work" }], primaryProjection: "schedule" } },
    technician: { startView: "my-day", visibleSurfaces: ["home", "work", "customers", "schedule"], ready: { primaryFocus: "assigned_work", heroMetric: "assigned_work_today", pulseMetrics: ["assigned_work_today"], attentionCategories: ["recovery", "schedule", "customer", "work"], quickActions: [{ key: "open_my_day" }], primaryProjection: "assigned-day" } },
  },
  scenes: { ready: { detail: "balanced", emphasis: "presence" }, listening: { detail: "compact", emphasis: "presence" }, plan: { detail: "balanced", emphasis: "context" }, approval: { detail: "detailed", emphasis: "evidence" }, working: { detail: "balanced", emphasis: "evidence" }, outcome: { detail: "detailed", emphasis: "evidence" }, recovery: { detail: "detailed", emphasis: "context" } },
  extensions: {},
}

const LegacyWorkspaceSchema = z.object({
  enabledSurfaces: z.array(SurfaceSchema), terminology: SurfaceTerminologySchema, voiceEnabled: z.boolean(), navigationPriority: z.array(SurfaceSchema),
  brand: z.object({ accent: z.enum(["cyan", "teal", "amber", "violet"]), radius: z.enum(["precise", "soft"]), mark: z.string().trim().min(1).max(3) }).strict(),
  visibility: z.object({ policy: z.boolean(), authority: z.boolean() }).strict(),
}).strict()

function normalizeLegacy(value: z.infer<typeof LegacyWorkspaceSchema>): TenantWorkspaceConfig | null {
  if (!value.enabledSurfaces.includes("home") || new Set(value.enabledSurfaces).size !== value.enabledSurfaces.length || new Set(value.navigationPriority).size !== WORKSPACE_SURFACES.length) return null
  const roles = Object.fromEntries((["owner", "dispatcher", "technician"] as const).map((role) => [role, { ...DEFAULT_TENANT_WORKSPACE_CONFIG.roles[role], visibleSurfaces: DEFAULT_TENANT_WORKSPACE_CONFIG.roles[role].visibleSurfaces.filter((surface) => value.enabledSurfaces.includes(surface)) }])) as TenantWorkspaceConfig["roles"]
  return { ...DEFAULT_TENANT_WORKSPACE_CONFIG, enabledSurfaces: value.enabledSurfaces, terminology: value.terminology, voiceEnabled: value.voiceEnabled, navigationPriority: value.navigationPriority, brand: { ...DEFAULT_TENANT_WORKSPACE_CONFIG.brand, ...value.brand }, visibility: value.visibility, roles }
}

export function normalizeWorkspaceConfig(value: unknown): TenantWorkspaceConfig {
  const v2 = TenantExperienceManifestV2Schema.safeParse(value)
  if (v2.success) return v2.data
  const legacy = LegacyWorkspaceSchema.safeParse(value)
  return legacy.success ? normalizeLegacy(legacy.data) ?? DEFAULT_TENANT_WORKSPACE_CONFIG : DEFAULT_TENANT_WORKSPACE_CONFIG
}

export function orderedWorkspaceItems<T extends { key: WorkspaceSurfaceKey }>(items: T[], config: TenantWorkspaceConfig, role?: ExperienceRole): T[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const roleSurfaces = role ? new Set(config.roles[role].visibleSurfaces) : null
  return config.navigationPriority.flatMap((key) => config.enabledSurfaces.includes(key) && (!roleSurfaces || roleSurfaces.has(key)) && byKey.has(key) ? [byKey.get(key)!] : [])
}

export function inspectorFieldVisible(label: string, config: TenantWorkspaceConfig): boolean {
  const normalized = label.toLocaleLowerCase()
  if (!config.visibility.policy && normalized.includes("policy")) return false
  if (!config.visibility.authority && (normalized.includes("authority") || normalized.includes("permission"))) return false
  return true
}

const CANONICAL_VOCABULARY_KEYS: Record<string, keyof TenantWorkspaceConfig["vocabulary"]> = {
  household: "customer", customer: "customer", homeowner: "homeowner", account: "account", technician: "technician", installer: "installer",
  service_visit: "serviceVisit", appointment: "appointment", quote: "quote", proposal: "proposal", invoice: "invoice", job: "job", work: "work", work_order: "job",
}

/** Presentation-only vocabulary lookup. Canonical IDs and entity types are never changed. */
export function vocabularyLabel(canonical: string, config: TenantWorkspaceConfig): string {
  const key = CANONICAL_VOCABULARY_KEYS[canonical]
  return key ? config.vocabulary[key] : canonical.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

export function effectiveMotionPreference(configured: TenantWorkspaceConfig["brand"]["motion"], reducedMotion: boolean): "reduced" | TenantWorkspaceConfig["brand"]["motion"] {
  return reducedMotion ? "reduced" : configured
}

export function sceneSlot(scene: ExperienceScene): ExperienceExtensionSlot | null {
  if (scene === "ready") return "ready.secondary"
  if (scene === "plan") return "plan.context"
  if (scene === "approval") return "approval.context"
  if (scene === "working") return "working.visual"
  if (scene === "outcome") return "outcome.summary"
  if (scene === "recovery") return "recovery.context"
  return null
}
