import { jarvisClient, type ActivityPage, type CausalReplayProjection, type ExecutionProjection, type Household360Projection, type HouseholdResource, type InvoiceResource, type Vitals, type WorkCaseProjection, type WorkforceStatusProjection } from "@/lib/jarvis-client"
import { jarvisGet, jarvisPost } from "./api"
import type {
  CashCollections,
  CommsRow,
  DataQuality,
  EventRow,
  FollowUpDebt,
  Insights,
  IntegrationsStatus,
  PipelineHealth,
  ReliabilityMetrics,
  ServiceDue,
  SetupStatus,
  SlaBreaches,
  StatsResponse,
  StockRisk,
  TechnicianLoad,
  WorkflowRun,
  PendingAction,
} from "./data-core"
import type { MapData } from "../panels/DispatchMap"
import type { OperationalQueryExecution, OperationalQueryResult } from "../workspaces/contracts"
import type { ProjectionDefinition } from "./business-projection-cache"

export type BusinessScene = "customer" | "schedule" | "money" | "work" | "inventory" | "computer"
export interface BusinessWorldProjection {
  version: 1
  scene: BusinessScene
  objects: Array<{ entityType: string; entityId: string; label: string | null; status: string | null; occurredAt: string | null; provenance: { kind: "canonical_postgres"; table: string }; relatedWork: Array<{ entityType: string; entityId: string }>; interactionEligible: boolean }>
  relationships: Array<{ from: { entityType: string; entityId: string }; relationship: string; to: { entityType: string; entityId: string }; source: { table: string; column: string } }>
  truncated: boolean
  limits: { objects: number; relationships: number }
  source: { kind: "canonical_postgres"; tables: string[] }
  asOf: string
}

export const PROJECTION_FRESHNESS = {
  immediate: 8_000,
  active: 15_000,
  medium: 30_000,
  slow: 90_000,
  sanity: 180_000,
  detail: 60_000,
} as const

export interface TechnicianDay {
  workOrders: Array<{ id: string; type: string; status: "draft" | "scheduled" | "in_progress" | "completed" | "canceled"; scheduledAt: string | null; address: string; householdId: string }>
  visits: Array<{ id: string; type: string; scheduledAt: string | null; completedAt: string | null; notes: string | null; address: string; householdId: string }>
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
}

function stableRequestKey(value: Record<string, unknown>): string {
  return JSON.stringify(stableValue(value))
}

export const businessProjections = {
  health: (): ProjectionDefinition<unknown> => ({ key: ["system", "health"], owner: "boot", staleMs: PROJECTION_FRESHNESS.sanity, tags: ["system"], load: () => jarvisGet("health") }),
  stats: (): ProjectionDefinition<StatsResponse> => ({ key: ["core", "stats"], owner: "data-core.fast", staleMs: PROJECTION_FRESHNESS.immediate, pollMs: 10_000, tags: ["system", "actions", "work"], load: jarvisClient.stats }),
  pendingActions: (filter: "pending" | "blocked"): ProjectionDefinition<PendingAction[]> => ({ key: ["actions", filter], owner: "data-core.fast", staleMs: PROJECTION_FRESHNESS.immediate, pollMs: 10_000, tags: ["actions", "approvals", "work"], load: async () => (await jarvisClient.pendingActions(filter)).actions }),
  workflowRuns: (status?: string): ProjectionDefinition<WorkflowRun[]> => ({ key: ["workflows", status ?? "all"], owner: status ? "data-core.fast" : "data-core.medium", staleMs: status ? PROJECTION_FRESHNESS.immediate : PROJECTION_FRESHNESS.medium, pollMs: status ? 10_000 : 30_000, tags: ["workflows", "work", "receipts"], load: async () => (await jarvisClient.workflowRuns(status)).runs }),
  events: (): ProjectionDefinition<EventRow[]> => ({ key: ["events", "recent"], owner: "data-core.medium", staleMs: PROJECTION_FRESHNESS.medium, pollMs: 30_000, tags: ["events", "activity", "work"], load: async () => (await jarvisClient.events()).events }),
  comms: (): ProjectionDefinition<CommsRow[]> => ({
    key: ["comms", "recent"], owner: "data-core.medium", staleMs: PROJECTION_FRESHNESS.medium, pollMs: 30_000, tags: ["comms", "customers", "activity"],
    load: async () => {
      const value = await jarvisClient.comms()
      return [
        ...value.outbox.map((row) => ({ id: row.id, channel: row.channel, content: row.content, createdAt: row.createdAt, toNumber: row.toNumber, simulated: row.simulated })),
        ...value.communications.map((row) => ({ id: row.id, channel: row.channel, content: row.content, createdAt: row.timestamp, direction: row.direction, household: row.household })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    },
  }),
  pipelineHealth: (): ProjectionDefinition<PipelineHealth> => ({ key: ["read-model", "pipeline-health"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["work", "customers", "queries"], load: async () => (await jarvisClient.readModel("pipeline-health")).data }),
  cashCollections: (): ProjectionDefinition<CashCollections> => ({ key: ["read-model", "cash-collections"], owner: "money", staleMs: PROJECTION_FRESHNESS.active, pollMs: 20_000, tags: ["money", "customers", "work", "queries"], load: async () => (await jarvisClient.cashCollections()).data }),
  slaBreaches: (): ProjectionDefinition<SlaBreaches> => ({ key: ["read-model", "sla-breaches"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["workflows", "work", "system"], load: async () => (await jarvisClient.readModel("sla-breaches")).data }),
  stockRisk: (): ProjectionDefinition<StockRisk> => ({ key: ["read-model", "stock-risk"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["inventory", "work", "queries"], load: async () => (await jarvisClient.readModel("stock-risk")).data }),
  followUpDebt: (): ProjectionDefinition<FollowUpDebt> => ({ key: ["read-model", "follow-up-debt"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["customers", "work", "queries"], load: async () => (await jarvisClient.readModel("follow-up-debt")).data }),
  technicianLoad: (): ProjectionDefinition<TechnicianLoad> => ({ key: ["read-model", "technician-load"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["schedule", "work", "queries"], load: async () => (await jarvisClient.readModel("technician-load")).data }),
  serviceDue: (): ProjectionDefinition<ServiceDue> => ({ key: ["read-model", "service-due"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["customers", "schedule", "work", "queries"], load: async () => (await jarvisClient.readModel("service-due")).data }),
  dataQuality: (): ProjectionDefinition<DataQuality> => ({ key: ["read-model", "data-quality"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["work", "system"], load: async () => (await jarvisClient.readModel("data-quality")).data }),
  insights: (): ProjectionDefinition<Insights> => ({ key: ["insights"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["actions", "workflows", "queries"], load: jarvisClient.insights }),
  reliability: (): ProjectionDefinition<ReliabilityMetrics> => ({ key: ["read-model", "reliability"], owner: "data-core.slow", staleMs: PROJECTION_FRESHNESS.slow, pollMs: 90_000, tags: ["system", "workflows"], load: async () => (await jarvisClient.readModel("reliability")).data }),
  setupStatus: (): ProjectionDefinition<SetupStatus> => ({ key: ["system", "setup"], owner: "data-core.sanity", staleMs: PROJECTION_FRESHNESS.sanity, pollMs: 180_000, tags: ["system", "agents"], load: jarvisClient.setupStatus }),
  integrationsStatus: (): ProjectionDefinition<IntegrationsStatus> => ({ key: ["system", "integrations"], owner: "agents", staleMs: PROJECTION_FRESHNESS.sanity, pollMs: 180_000, tags: ["system", "agents"], load: jarvisClient.integrationsStatus }),
  workCases: (): ProjectionDefinition<WorkCaseProjection[]> => ({ key: ["read-model", "work-cases"], owner: "work", staleMs: PROJECTION_FRESHNESS.active, pollMs: 15_000, fallbackPollMs: 2_000, tags: ["work", "actions", "approvals", "workflows", "receipts", "customers", "schedule", "money", "agents", "queries"], load: async () => (await jarvisClient.workCases()).data }),
  workforceStatus: (): ProjectionDefinition<WorkforceStatusProjection> => ({ key: ["read-model", "workforce-status"], owner: "agents", staleMs: PROJECTION_FRESHNESS.active, pollMs: 15_000, fallbackPollMs: 2_000, tags: ["agents", "work", "actions", "queries"], load: async () => (await jarvisClient.readModel("workforce-status")).data }),
  workExecution: (workId: string): ProjectionDefinition<ExecutionProjection> => ({
    key: ["work-execution", workId],
    owner: "work.execution",
    staleMs: PROJECTION_FRESHNESS.active,
    // Phase 2 realtime invalidation is primary; this is one selected-Work sanity
    // refresh, not a polling loop per action/computer step.
    pollMs: PROJECTION_FRESHNESS.sanity,
    fallbackPollMs: 2_000,
    tags: ["work", "actions", "approvals", "workflows", "receipts", "computer", "activity"],
    load: async () => (await jarvisClient.workExecution(workId)).execution,
  }),
  workReplay: (workId: string): ProjectionDefinition<CausalReplayProjection> => ({
    key: ["work-replay", workId],
    owner: "work.replay",
    staleMs: PROJECTION_FRESHNESS.detail,
    pollMs: PROJECTION_FRESHNESS.sanity,
    fallbackPollMs: 2_000,
    tags: ["work", "actions", "approvals", "workflows", "receipts", "computer", "activity"],
    load: async () => (await jarvisClient.workReplay(workId)).replay,
  }),
  households: (): ProjectionDefinition<HouseholdResource[]> => ({ key: ["resources", "households"], owner: "customers", staleMs: PROJECTION_FRESHNESS.medium, pollMs: 30_000, tags: ["customers", "work", "queries"], load: async () => (await jarvisClient.households()).rows }),
  household360: (householdId: string): ProjectionDefinition<Household360Projection> => ({ key: ["read-model", "household-360", householdId], owner: "customers.detail", staleMs: PROJECTION_FRESHNESS.detail, pollMs: 30_000, tags: ["customers", "money", "schedule", "work", "receipts", "queries"], load: async () => (await jarvisClient.household360(householdId)).data }),
  invoices: (): ProjectionDefinition<InvoiceResource[]> => ({ key: ["resources", "invoices"], owner: "money", staleMs: PROJECTION_FRESHNESS.active, pollMs: 20_000, tags: ["money", "customers", "work", "queries"], load: async () => (await jarvisClient.invoices()).rows }),
  dispatchMap: (date: string): ProjectionDefinition<MapData> => ({ key: ["schedule", "dispatch-map", date], owner: "schedule", staleMs: PROJECTION_FRESHNESS.active, pollMs: 15_000, tags: ["schedule", "customers", "work", "queries"], load: () => jarvisGet<MapData>("dispatch/map", { date }) }),
  technicianDay: (): ProjectionDefinition<TechnicianDay> => ({ key: ["schedule", "technician-day"], owner: "schedule.my-day", staleMs: PROJECTION_FRESHNESS.active, pollMs: 15_000, tags: ["schedule", "customers", "work", "queries"], load: () => jarvisGet<TechnicianDay>("technician/my-day") }),
  activity: (): ProjectionDefinition<ActivityPage> => ({ key: ["activity", "latest"], owner: "jarvis.activity", staleMs: PROJECTION_FRESHNESS.immediate, pollMs: 5_000, tags: ["activity", "actions", "workflows", "work", "customers"], load: () => jarvisClient.activity({ limit: 40 }) }),
  vitals: (): ProjectionDefinition<Vitals> => ({ key: ["system", "vitals"], owner: "jarvis.vitals", staleMs: PROJECTION_FRESHNESS.immediate, pollMs: 5_000, tags: ["system", "workflows"], load: jarvisClient.vitals }),
  businessWorld: (scene: BusinessScene): ProjectionDefinition<BusinessWorldProjection> => ({
    key: ["business-world", scene], owner: `scene.${scene}`, staleMs: PROJECTION_FRESHNESS.active, pollMs: 60_000,
    tags: [scene === "customer" ? "customers" : scene === "computer" ? "computer" : scene, "work", "queries"],
    load: async () => (await jarvisGet<{ data: BusinessWorldProjection }>("business-world", { scene })).data,
  }),
  resource: (kind: string): ProjectionDefinition<Record<string, unknown>[]> => ({ key: ["resources", kind], owner: `deep-view.${kind}`, staleMs: PROJECTION_FRESHNESS.medium, pollMs: 30_000, tags: kind === "households" ? ["customers", "work", "queries"] : kind === "invoices" ? ["money", "customers", "work", "queries"] : kind === "inventory" ? ["inventory", "work", "queries"] : kind === "visits" ? ["schedule", "customers", "work", "queries"] : ["work", "queries"], load: async () => (await jarvisGet<{ rows: Record<string, unknown>[] }>(`resources/${kind}`)).rows }),
  operationalQuery: (execution: OperationalQueryExecution): ProjectionDefinition<OperationalQueryExecution> => ({
    key: ["operational-query", execution.result.intent, stableRequestKey(execution.request)],
    owner: "adaptive-workspace",
    staleMs: PROJECTION_FRESHNESS.medium,
    tags: ["queries", execution.result.intent.startsWith("customer") ? "customers" : execution.result.intent === "schedule_range" ? "schedule" : execution.result.intent === "money_summary" ? "money" : execution.result.intent === "agent_activity" ? "agents" : "work"],
    load: async () => {
      const value = await jarvisPost<{ request: OperationalQueryExecution["request"]; result: OperationalQueryResult; execution: OperationalQueryExecution["metadata"] }>("queries", execution.request)
      return { request: value.request, result: value.result, metadata: value.execution }
    },
  }),
}
