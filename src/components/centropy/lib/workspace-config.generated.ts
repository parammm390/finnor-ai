// GENERATED FILE — DO NOT EDIT.
// Source: finnor-os/apps/api/lib/workspace-config.ts
// Source SHA-256: 608cc5f0abaa7687b086625c78b6034e886e01d42a18c88bb7ef8affe24b806b

import { z } from "zod";

export const TENANT_EXPERIENCE_VERSION = 3 as const;

export const WorkspaceSurfaceSchema = z.enum(["home", "work", "deals", "agents"]);
export const WORKSPACE_SURFACES = WorkspaceSurfaceSchema.options;
export const ExperienceRoleSchema = z.enum(["owner"]);
export const EXPERIENCE_ROLES = ExperienceRoleSchema.options;
export const ExperienceSceneSchema = z.enum(["ready", "listening", "plan", "approval", "working", "outcome", "recovery"]);
export const EXPERIENCE_SCENES = ExperienceSceneSchema.options;

export const ExperienceMetricKeySchema = z.enum([
  "pending_approvals",
  "open_deals",
  "open_requests",
  "open_findings",
  "critical_deal_risks",
  "closing_readiness",
  "runs_in_flight",
  "stuck_runs",
]);
export const EXPERIENCE_METRIC_KEYS = ExperienceMetricKeySchema.options;

export const ExperienceQuickActionKeySchema = z.enum([
  "review_pending_approvals",
  "inspect_blocked_work",
  "review_deals",
  "review_closing_readiness",
  "review_open_requests",
]);
export const EXPERIENCE_QUICK_ACTION_KEYS = ExperienceQuickActionKeySchema.options;

export const ExperienceProjectionKeySchema = z.enum(["deal", "work", "agent"]);
export const ExperienceAttentionCategorySchema = z.enum(["approval", "work", "deal", "closing", "evidence", "risk"]);

const VocabularySchema = z.object({
  deal: z.string().trim().min(1).max(32),
  portfolioCompany: z.string().trim().min(1).max(32),
  dealParty: z.string().trim().min(1).max(32),
  workstream: z.string().trim().min(1).max(32),
  request: z.string().trim().min(1).max(32),
  deliverable: z.string().trim().min(1).max(32),
  finding: z.string().trim().min(1).max(32),
  risk: z.string().trim().min(1).max(32),
  closingCondition: z.string().trim().min(1).max(32),
  closingItem: z.string().trim().min(1).max(32),
  task: z.string().trim().min(1).max(32),
  work: z.string().trim().min(1).max(32),
}).strict();

const QuickActionSchema = z.object({
  key: ExperienceQuickActionKeySchema,
  label: z.string().trim().min(1).max(48).optional(),
}).strict();

const RoleExperienceSchema = z.object({
  startView: z.enum(["command", "deals"]),
  visibleSurfaces: z.array(WorkspaceSurfaceSchema).min(1).max(WORKSPACE_SURFACES.length),
  ready: z.object({
    primaryFocus: z.enum(["deal_execution", "closing_readiness", "assigned_work"]),
    heroMetric: ExperienceMetricKeySchema.nullable(),
    pulseMetrics: z.array(ExperienceMetricKeySchema).max(6),
    attentionCategories: z.array(ExperienceAttentionCategorySchema).min(1).max(6),
    quickActions: z.array(QuickActionSchema).max(6),
    primaryProjection: ExperienceProjectionKeySchema,
  }).strict(),
}).strict();

const ScenePreferenceSchema = z.object({
  detail: z.enum(["compact", "balanced", "detailed"]),
  emphasis: z.enum(["presence", "context", "evidence"]),
}).strict();

const ScenePreferencesSchema = z.object({
  ready: ScenePreferenceSchema,
  listening: ScenePreferenceSchema,
  plan: ScenePreferenceSchema,
  approval: ScenePreferenceSchema,
  working: ScenePreferenceSchema,
  outcome: ScenePreferenceSchema,
  recovery: ScenePreferenceSchema,
}).strict();

export const TenantExperienceManifestV3Schema = z.object({
  version: z.literal(TENANT_EXPERIENCE_VERSION),
  enabledSurfaces: z.array(WorkspaceSurfaceSchema).length(WORKSPACE_SURFACES.length),
  terminology: z.object({
    home: z.string().trim().min(1).max(24),
    work: z.string().trim().min(1).max(24),
    deals: z.string().trim().min(1).max(24),
    agents: z.string().trim().min(1).max(24),
  }).strict(),
  vocabulary: VocabularySchema,
  voiceEnabled: z.boolean(),
  navigationPriority: z.array(WorkspaceSurfaceSchema).length(WORKSPACE_SURFACES.length),
  brand: z.object({
    accent: z.enum(["cyan", "teal", "amber", "violet"]),
    surfaceTone: z.enum(["ink", "slate", "sand"]),
    radius: z.enum(["precise", "soft"]),
    density: z.enum(["compact", "balanced", "spacious"]),
    typography: z.enum(["system", "editorial", "technical"]),
    motion: z.enum(["restrained", "standard", "expressive"]),
    mark: z.string().trim().min(1).max(3),
    logoAssetKey: z.literal("finnor"),
  }).strict(),
  visibility: z.object({ policy: z.boolean(), authority: z.boolean() }).strict(),
  roles: z.object({ owner: RoleExperienceSchema }).strict(),
  scenes: ScenePreferencesSchema,
  extensions: z.object({}).strict(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.enabledSurfaces).size !== WORKSPACE_SURFACES.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["enabledSurfaces"], message: "Each active surface must appear exactly once" });
  }
  if (new Set(value.navigationPriority).size !== WORKSPACE_SURFACES.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["navigationPriority"], message: "Navigation priority must contain each active surface exactly once" });
  }
  if (!value.roles.owner.visibleSurfaces.includes("home")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roles", "owner", "visibleSurfaces"], message: "Home must remain visible" });
  }
});

export type TenantExperienceManifestV3 = z.infer<typeof TenantExperienceManifestV3Schema>;
export type WorkspaceConfig = TenantExperienceManifestV3;
export type TenantWorkspaceConfig = TenantExperienceManifestV3;
export type WorkspaceSurfaceKey = z.infer<typeof WorkspaceSurfaceSchema>;
export type ExperienceRole = z.infer<typeof ExperienceRoleSchema>;
export type ExperienceScene = z.infer<typeof ExperienceSceneSchema>;
export type ExperienceMetricKey = z.infer<typeof ExperienceMetricKeySchema>;
export type ExperienceQuickActionKey = z.infer<typeof ExperienceQuickActionKeySchema>;
export type ExperienceProjectionKey = z.infer<typeof ExperienceProjectionKeySchema>;
export type ExperienceAttentionCategory = z.infer<typeof ExperienceAttentionCategorySchema>;

export const DEFAULT_WORKSPACE_CONFIG: TenantExperienceManifestV3 = {
  version: 3,
  enabledSurfaces: ["home", "work", "deals", "agents"],
  terminology: { home: "Home", work: "Work", deals: "Deals", agents: "Agents" },
  vocabulary: {
    deal: "deal",
    portfolioCompany: "portfolio company",
    dealParty: "deal party",
    workstream: "workstream",
    request: "request",
    deliverable: "deliverable",
    finding: "finding",
    risk: "risk",
    closingCondition: "closing condition",
    closingItem: "closing item",
    task: "task",
    work: "work",
  },
  voiceEnabled: true,
  navigationPriority: ["home", "deals", "work", "agents"],
  brand: { accent: "cyan", surfaceTone: "ink", radius: "precise", density: "balanced", typography: "system", motion: "restrained", mark: "F", logoAssetKey: "finnor" },
  visibility: { policy: true, authority: true },
  roles: {
    owner: {
      startView: "command",
      visibleSurfaces: ["home", "work", "deals", "agents"],
      ready: {
        primaryFocus: "deal_execution",
        heroMetric: "closing_readiness",
        pulseMetrics: ["open_deals", "open_requests", "critical_deal_risks", "pending_approvals"],
        attentionCategories: ["deal", "closing", "risk", "approval", "work"],
        quickActions: [
          { key: "review_closing_readiness" },
          { key: "review_open_requests" },
          { key: "review_pending_approvals" },
          { key: "inspect_blocked_work" },
        ],
        primaryProjection: "deal",
      },
    },
  },
  scenes: Object.fromEntries(["ready", "listening", "plan", "approval", "working", "outcome", "recovery"].map((key) => [key, { detail: "balanced", emphasis: "evidence" }])) as TenantExperienceManifestV3["scenes"],
  extensions: {},
};

export const DEFAULT_TENANT_WORKSPACE_CONFIG = DEFAULT_WORKSPACE_CONFIG;

export const WorkspaceConfigSchema = TenantExperienceManifestV3Schema;

export function normalizeWorkspaceConfig(value: unknown): TenantExperienceManifestV3 {
  const parsed = WorkspaceConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_WORKSPACE_CONFIG;
}

export const WORKSPACE_CONTRACT_SOURCE = "finnor-os/apps/api/lib/workspace-config.ts" as const;
export const WORKSPACE_CONTRACT_SHA256 = "608cc5f0abaa7687b086625c78b6034e886e01d42a18c88bb7ef8affe24b806b" as const;
