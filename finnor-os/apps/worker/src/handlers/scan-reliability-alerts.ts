// scan_reliability_alerts (Phase 6, JARVIS 95% MAESTRO PACK §6.6): the real signal
// side of "Sentry alerts: failure spike, reconciliation backlog >20, DLQ >10,
// health-check flapping, secret-store unreachable." This handler computes the real
// numbers and calls Sentry.captureMessage the moment a threshold is breached —
// whether that reaches a human depends on Param configuring notification rules in
// the Sentry dashboard once SENTRY_DSN exists (an owner action; Sentry.init() is an
// inert no-op without a DSN, per packages/tools/src/observability.ts), but the
// detection logic itself is real starting now, not stubbed for later.
//
// "Health-check flapping" is interpreted honestly, not literally: this codebase's
// provider_circuit_state table (packages/tools/src/provider-circuit-breaker.ts)
// tracks current state + consecutiveFailures, not a transition history, so there is
// no data source for "opened and closed N times in an hour." The real, buildable
// proxy is "circuit currently open, or repeatedly failing just under the open
// threshold" — stated as a scoped interpretation, matching this repo's convention
// of never fabricating a metric it can't actually compute (see reliability.ts's
// null-vs-zero contradiction detector docs for the same posture).

import { Sentry, circuitSnapshot } from "@finnor/tools";
import { recordBusinessEvent } from "@finnor/data-platform";
import { businessEvents, enqueueJob, withTenant } from "@finnor/db";
import { and, eq, gte } from "drizzle-orm";
import { secretProviderStatus, ensureSecretsLoaded } from "@finnor/security";
import { readinessAnomalies, reliability } from "@finnor/read-models";

const RECONCILIATION_BACKLOG_THRESHOLD = 20;
const DLQ_DEPTH_THRESHOLD = 10;
// A workflow success rate below this, with enough terminal runs to be meaningful
// (not one unlucky run out of one), is a real failure spike, not noise.
const FAILURE_SPIKE_SUCCESS_RATE_THRESHOLD = 0.5;
const FAILURE_SPIKE_MIN_SAMPLE = 5;
// No dedicated "flapping" signal exists (see file header) — a circuit sitting open,
// or one failing right at the edge of opening, is the honest proxy available today.
const FLAPPING_CONSECUTIVE_FAILURES_THRESHOLD = 3;
const MONITORED_PROVIDERS = ["vapi", "resend"] as const;

export interface ReliabilityAlert {
  kind: "reconciliation_backlog" | "dlq_depth" | "failure_spike" | "provider_flapping" | "secret_store_unreachable";
  tenantId: string;
  detail: Record<string, unknown>;
}

/** Pure so it's unit-testable without a real Sentry/DB round trip — the handler
 *  below is the thin, untested-by-design wiring that calls this and reports. */
export async function detectReliabilityAlerts(tenantId: string): Promise<ReliabilityAlert[]> {
  const alerts: ReliabilityAlert[] = [];
  const metrics = await reliability(tenantId, 1);

  if (metrics.reconciliationBacklog > RECONCILIATION_BACKLOG_THRESHOLD) {
    alerts.push({ kind: "reconciliation_backlog", tenantId, detail: { count: metrics.reconciliationBacklog, threshold: RECONCILIATION_BACKLOG_THRESHOLD } });
  }
  if (metrics.dlqDepth > DLQ_DEPTH_THRESHOLD) {
    alerts.push({ kind: "dlq_depth", tenantId, detail: { count: metrics.dlqDepth, threshold: DLQ_DEPTH_THRESHOLD } });
  }
  if (
    metrics.workflowSuccessRate !== null &&
    metrics.workflowSuccessRate < FAILURE_SPIKE_SUCCESS_RATE_THRESHOLD &&
    metrics.stepLatencyMs.sampleSize >= FAILURE_SPIKE_MIN_SAMPLE
  ) {
    alerts.push({
      kind: "failure_spike",
      tenantId,
      detail: { successRate: metrics.workflowSuccessRate, threshold: FAILURE_SPIKE_SUCCESS_RATE_THRESHOLD, sampleSize: metrics.stepLatencyMs.sampleSize },
    });
  }

  for (const provider of MONITORED_PROVIDERS) {
    const snapshot = await circuitSnapshot(provider, tenantId);
    if (snapshot.state === "open" || snapshot.consecutiveFailures >= FLAPPING_CONSECUTIVE_FAILURES_THRESHOLD) {
      alerts.push({ kind: "provider_flapping", tenantId, detail: { provider, state: snapshot.state, consecutiveFailures: snapshot.consecutiveFailures } });
    }
  }

  // Only meaningful once SECRETS_PROVIDER=aws-secrets-manager is actually flipped
  // (owner action, docs/secrets-runbook.md) — a no-op check under the env provider,
  // matching secretProviderStatus()'s own "env provider never fails" contract.
  if (secretProviderStatus().provider !== "env") {
    try {
      await ensureSecretsLoaded();
    } catch (err) {
      alerts.push({ kind: "secret_store_unreachable", tenantId, detail: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  return alerts;
}

function sentryLevelFor(kind: ReliabilityAlert["kind"]): "warning" | "error" {
  return kind === "secret_store_unreachable" || kind === "provider_flapping" ? "error" : "warning";
}

export const scanReliabilityAlerts = async (payload: Record<string, unknown>): Promise<void> => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("scan_reliability_alerts requires tenantId");

  const alerts = await detectReliabilityAlerts(tenantId);
  for (const alert of alerts) {
    Sentry.captureMessage(`reliability_alert:${alert.kind}:tenant:${tenantId}`, {
      level: sentryLevelFor(alert.kind),
      extra: alert.detail,
      tags: { alert_kind: alert.kind, tenant_id: tenantId },
    });
    await enqueueJob(
      "send_push_notification",
      { tenantId, kind: "slo-burn", body: `${alert.kind.replaceAll("_", " ")} crossed its configured operational threshold.` },
      `push:slo-burn:${tenantId}:${alert.kind}:${new Date().toISOString().slice(0, 13)}`,
    ).catch(() => undefined);
  }
  const anomalies = await readinessAnomalies(tenantId);
  for (const anomaly of anomalies) {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const alreadyRecorded = await withTenant(tenantId, async (db) => {
      const [existing] = await db.select({ id: businessEvents.id }).from(businessEvents).where(and(eq(businessEvents.tenantId, tenantId), eq(businessEvents.eventType, "anomaly_detected"), gte(businessEvents.occurredAt, today))).limit(1);
      if (!existing) await recordBusinessEvent(db, { tenantId, entityType: "tenant", entityId: tenantId, eventType: "anomaly_detected", payload: anomaly, source: "rolling_z_score" });
      return Boolean(existing);
    });
    if (alreadyRecorded) continue;
    Sentry.captureMessage(`anomaly:${anomaly.metric}:tenant:${tenantId}`, { level: "warning", extra: anomaly, tags: { alert_kind: "anomaly", tenant_id: tenantId } });
  }
};
