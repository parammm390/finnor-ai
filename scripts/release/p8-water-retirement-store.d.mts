import type { Client } from "pg"

export type WaterOperationalCensus = {
  tenantIds: string[]
  byStatus: Record<string, Record<string, number>>
  live: {
    nonterminalWork: number
    activeDomainActions: number
    queuedOrRunningJobs: number
    scheduledJobs: number
    activeWorkflowRuns: number
    activeWorkflowSteps: number
    activeOutboxEvents: number
    activeBusinessEffects: number
    scheduledObjectiveLoops: number
    activeEventWaits: number
    openConversations: number
    openCalls: number
  }
  historicalCommunications: {
    calls: number
    messages: number
    sandboxOutbox: number
  }
  legacyCanonical: {
    verticals: Record<string, boolean>
    activeTruthRows: number
    attachableWaterTruthRows: number
    activeWaterPolicies: number
    enabledTenantModes: number
  }
}

export type WaterFixtureDrain = {
  actions: {
    terminalized: number
    rejected: number
    failed: number
    audit_rows: number
  }
  effects: number
  objectives: number
  jobs: number
  works: { cancelled: number; audit_rows: number }
}

export function readWaterOperationalCensus(
  client: Client,
  options?: { tenantIds?: string[] },
): Promise<WaterOperationalCensus>

export function drainAuditedWaterFixtures(
  client: Client,
  options: {
    actor: string
    authorizationRef: string
    releaseSha: string
    tenantIds?: string[]
  },
): Promise<WaterFixtureDrain>

export function writeTenantDispositions(
  client: Client,
  options: { actor: string; authorizationRef: string },
): Promise<void>
