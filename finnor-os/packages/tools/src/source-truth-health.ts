import { tenantIntegrations, withTenant } from "@finnor/db";
import { freshnessState } from "@finnor/data-platform";
import type { SourceFreshnessPolicy, SourceTruthSummary } from "@finnor/shared-types";
import { eq } from "drizzle-orm";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface TenantSourceTruthEntry extends SourceTruthSummary {
  integrationId: string;
  capability: string;
  binding: string;
  mode: string;
  syncScopes: string[];
  outcomePacks: string[];
  sourcePolicyConfigured: boolean;
  lastObservedAt?: string;
  requiredFreshnessSeconds?: number;
  blockedReason?: string;
}

export interface TenantSourceTruthReport {
  sources: TenantSourceTruthEntry[];
  outcomeCoverage: Record<string, { ready: boolean; sources: string[]; reasons: string[] }>;
  requiredOutcomePacks: string[];
  ready: boolean;
}

export async function tenantSourceTruthReport(tenantId: string, now = new Date()): Promise<TenantSourceTruthReport> {
  const historicalRows = await withTenant(tenantId, (db) => db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId)));
  // tenant_integrations also contains immutable-era Water configuration. It is
  // retained for audit, but only explicitly PE-owned source scopes participate in
  // active source-truth readiness after the cutover.
  const rows = historicalRows.filter((row) => String(row.capability) === "private_equity_source");
  const sources = rows.map((row): TenantSourceTruthEntry => {
    const policy = object(row.freshnessPolicy);
    const sourcePolicy = object(row.sourcePolicy);
    const maxAgeSeconds = typeof policy.maxAgeSeconds === "number" && policy.maxAgeSeconds > 0 ? policy.maxAgeSeconds : undefined;
    const computedFreshness = maxAgeSeconds
      ? freshnessState(row.lastSuccessfulSyncAt, {
          scope: row.capability,
          maxAgeSeconds,
          criticality: (policy.criticality === "consequential" || policy.criticality === "informational") ? policy.criticality : "operational",
          staleBehavior: (policy.staleBehavior === "allow_with_warning" || policy.staleBehavior === "refresh_then_block") ? policy.staleBehavior : "refresh_then_degrade",
        } satisfies SourceFreshnessPolicy, now)
      : row.freshnessState;
    const configured = row.mode !== "emulator" && row.binding !== "emulator";
    const authenticated = row.health !== "down" && row.health !== "unknown";
    const reachable = row.health === "ok";
    const syncInitialized = Boolean(row.syncInitializedAt);
    const blocked = !configured || row.syncStatus === "blocked" || row.reconciliationStatus === "blocked" || row.health === "down";
    const degraded = row.health === "degraded" || row.syncStatus === "degraded" || row.reconciliationStatus === "degraded"
      || computedFreshness === "stale" || computedFreshness === "expired" || row.unresolvedConflicts > 0;
    const state = blocked ? "blocked"
      : degraded ? "degraded"
        : computedFreshness === "fresh" && syncInitialized ? "fresh"
          : syncInitialized ? "synced" : "connected";
    return {
      integrationId: row.id,
      capability: row.capability,
      binding: row.binding,
      mode: row.mode,
      syncScopes: row.syncScopes,
      outcomePacks: row.outcomePacks,
      sourcePolicyConfigured: Object.keys(sourcePolicy).length > 0,
      configured,
      authenticated,
      reachable,
      syncInitialized,
      ...(row.lastSuccessfulSyncAt ? { lastSuccessfulSyncAt: row.lastSuccessfulSyncAt.toISOString() } : {}),
      ...(row.lastObservedAt ? { lastObservedAt: row.lastObservedAt.toISOString() } : {}),
      freshness: computedFreshness,
      webhook: row.webhookStatus,
      reconciliation: row.reconciliationStatus,
      ...(row.sourceLagMs !== null ? { sourceLagMs: row.sourceLagMs } : {}),
      unresolvedConflicts: row.unresolvedConflicts,
      state,
      ...(maxAgeSeconds ? { requiredFreshnessSeconds: maxAgeSeconds } : {}),
      ...(blocked ? { blockedReason: row.lastError ?? (!configured ? "BLOCKED-CONFIG: emulator is not live source truth" : "source integration blocked") } : {}),
    };
  });
  const requiredOutcomePacks = [...new Set(sources.flatMap((source) => source.outcomePacks))].sort();
  const outcomeCoverage = Object.fromEntries(requiredOutcomePacks.map((pack) => {
    const selected = sources.filter((source) => source.outcomePacks.includes(pack));
    const reasons = selected.flatMap((source) => source.state === "fresh" ? [] : [`${source.capability}/${source.binding}:${source.state}`]);
    return [pack, { ready: selected.length > 0 && reasons.length === 0, sources: selected.map((source) => source.integrationId), reasons }];
  }));
  return {
    sources,
    outcomeCoverage,
    requiredOutcomePacks,
    ready: requiredOutcomePacks.length === 0 || Object.values(outcomeCoverage).every((coverage) => coverage.ready),
  };
}
