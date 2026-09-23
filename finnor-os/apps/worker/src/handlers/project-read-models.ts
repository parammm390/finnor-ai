// project_read_models (B1.T3): the periodic backstop for the CQRS projections cache.
// The debounced dirty-refresh (packages/projections' onCentropyEventMarkProjectionsDirty,
// wired in apps/worker/src/sse-server.ts) is the fast path — this is what keeps every
// view honestly fresh even where that fast path can't reach: proposals status changes
// (migration 0037's own comment — no tenant_id column, no NOTIFY trigger possible) and
// any events missed during a LISTEN reconnect gap.

import { refreshAllViewsForTenant } from "@finnor/projections";

export const projectReadModels = async (payload: Record<string, unknown>): Promise<void> => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("project_read_models requires tenantId");
  await refreshAllViewsForTenant(tenantId);
};
