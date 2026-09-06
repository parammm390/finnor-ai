/** Active Core read models. Historical vertical inspection lives behind the
 * explicitly read-only causal/work replay modules; no retired projection is
 * registered here. */
import {
  actionLog,
  computerSteps,
  deadLetters,
  decisionReceipts,
  domainActions,
  failureInjections,
  readinessLog,
  reconciliationCases,
  withTenant,
  workflowRuns,
  workflowSteps,
} from "@finnor/db";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { rollingZScores } from "./anomaly-detector";

export * from "./anomaly-detector";
export * from "./holt-winters";
export * from "./failure-injection-calendar";
export * from "./operational-queries";
export * from "./party-resolver";
export * from "./party-queries";
export * from "./execution-projection";
export * from "./causal-replay";
/** Historical Work inspection only. It has no mutation or action registration. */
export * from "./work-cases";

export async function readinessAnomalies(
  tenantId: string,
): Promise<Array<{ metric: "failure_rate"; value: number; zScore: number }>> {
  const rows = await withTenant(tenantId, (db) =>
    db.select({ success: readinessLog.workflowSuccessRate }).from(readinessLog)
      .where(and(eq(readinessLog.tenantId, tenantId), isNotNull(readinessLog.workflowSuccessRate)))
      .orderBy(desc(readinessLog.logDate)).limit(60),
  );
  const values = rows.reverse().map((row) => 1 - row.success!);
  return rollingZScores(values)
    .filter((point) => point.index === values.length - 1)
    .map((point) => ({ metric: "failure_rate" as const, value: point.value, zScore: point.zScore }));
}

export interface ReliabilityMetrics {
  tenantId: string;
  windowDays: number;
  workflowSuccessRate: number | null;
  stepLatencyMs: { p50: number | null; p95: number | null; sampleSize: number };
  retryRate: number | null;
  humanInterventionRate: number | null;
  reconciliationBacklog: number;
  dlqDepth: number;
  receiptCompleteness: number | null;
  predictionAccuracy: Array<{ actionType: string; comparedFields: number; matchedFields: number; accuracy: number | null }>;
  asOf: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export async function reliability(tenantId: string, windowDays = 1): Promise<ReliabilityMetrics> {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  return withTenant(tenantId, async (db) => {
    const runRows = await db.select({ status: workflowRuns.status, count: sql<number>`count(*)::int` })
      .from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), gte(workflowRuns.createdAt, cutoff)))
      .groupBy(workflowRuns.status);
    const byStatus = Object.fromEntries(runRows.map((row) => [row.status, row.count]));
    const terminal = (byStatus.completed ?? 0) + (byStatus.failed ?? 0) + (byStatus.compensated ?? 0) + (byStatus.cancelled ?? 0);
    const completed = await db.select({ createdAt: workflowSteps.createdAt, updatedAt: workflowSteps.updatedAt })
      .from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.status, "completed"), gte(workflowSteps.createdAt, cutoff)));
    const latencies = completed.map((row) => row.updatedAt.getTime() - row.createdAt.getTime()).sort((left, right) => left - right);
    const [retry] = await db.select({
      total: sql<number>`count(*)::int`,
      retried: sql<number>`count(*) filter (where ${workflowSteps.attempts} > 1)::int`,
    }).from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      inArray(workflowSteps.status, ["completed", "failed"]),
      gte(workflowSteps.createdAt, cutoff),
    ));
    const [human] = await db.select({
      total: sql<number>`count(*)::int`,
      needsHuman: sql<number>`count(*) filter (where ${domainActions.status} = 'needs_human_review')::int`,
    }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), gte(domainActions.createdAt, cutoff)));
    const [recon] = await db.select({ count: sql<number>`count(*)::int` }).from(reconciliationCases)
      .where(and(eq(reconciliationCases.tenantId, tenantId), eq(reconciliationCases.status, "open")));
    const [dlq] = await db.select({ count: sql<number>`count(*)::int` }).from(deadLetters)
      .where(and(eq(deadLetters.tenantId, tenantId), eq(deadLetters.status, "open")));
    const [receipts] = await db.select({
      total: sql<number>`count(*)::int`,
      finalized: sql<number>`count(*) filter (where ${decisionReceipts.finalizedAt} is not null)::int`,
    }).from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantId), gte(decisionReceipts.createdAt, cutoff)));
    const predictionRows = await db.select({ actionType: domainActions.actionType, diff: domainActions.predictionDiff })
      .from(domainActions).where(and(eq(domainActions.tenantId, tenantId), isNotNull(domainActions.predictionDiff), gte(domainActions.createdAt, cutoff)));
    const aggregate = new Map<string, { comparedFields: number; matchedFields: number }>();
    for (const row of predictionRows) {
      const diff = row.diff as { compared?: number; matched?: number };
      if (!diff.compared) continue;
      const current = aggregate.get(row.actionType) ?? { comparedFields: 0, matchedFields: 0 };
      current.comparedFields += diff.compared;
      current.matchedFields += diff.matched ?? 0;
      aggregate.set(row.actionType, current);
    }
    return {
      tenantId,
      windowDays,
      workflowSuccessRate: terminal > 0 ? (byStatus.completed ?? 0) / terminal : null,
      stepLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), sampleSize: latencies.length },
      retryRate: retry!.total > 0 ? retry!.retried / retry!.total : null,
      humanInterventionRate: human!.total > 0 ? human!.needsHuman / human!.total : null,
      reconciliationBacklog: recon!.count,
      dlqDepth: dlq!.count,
      receiptCompleteness: receipts!.total > 0 ? receipts!.finalized / receipts!.total : null,
      predictionAccuracy: [...aggregate.entries()].map(([actionType, item]) => ({
        actionType,
        ...item,
        accuracy: item.comparedFields > 0 ? item.matchedFields / item.comparedFields : null,
      })),
      asOf: new Date().toISOString(),
    };
  });
}

export interface ActivitySnapshotItem {
  source: "action_log" | "workflow_step" | "computer_step";
  id: string;
  occurredAt: string;
  detail: Record<string, unknown>;
}
export interface ActivitySnapshot { items: ActivitySnapshotItem[]; asOf: string }

export async function activitySnapshot(tenantId: string, limit = 50): Promise<ActivitySnapshot> {
  return withTenant(tenantId, async (db) => {
    const [actions, steps, computer] = await Promise.all([
      db.select().from(actionLog).where(eq(actionLog.tenantId, tenantId)).orderBy(desc(actionLog.timestamp)).limit(limit),
      db.select().from(workflowSteps).where(eq(workflowSteps.tenantId, tenantId)).orderBy(desc(workflowSteps.updatedAt)).limit(limit),
      db.select().from(computerSteps).where(eq(computerSteps.tenantId, tenantId)).orderBy(desc(computerSteps.createdAt)).limit(limit),
    ]);
    const items: ActivitySnapshotItem[] = [
      ...actions.map((row) => ({ source: "action_log" as const, id: row.id, occurredAt: row.timestamp.toISOString(), detail: { domainActionId: row.domainActionId, step: row.step, output: row.output } })),
      ...steps.map((row) => ({ source: "workflow_step" as const, id: row.id, occurredAt: row.updatedAt.toISOString(), detail: { workflowRunId: row.workflowRunId, stepType: row.stepType, status: row.status, terminalReason: row.terminalReason } })),
      ...computer.map((row) => ({ source: "computer_step" as const, id: row.id, occurredAt: row.createdAt.toISOString(), detail: { runId: row.runId, seq: row.seq, phase: row.phase, operation: row.operation, status: row.status, summary: row.summary, pageUrl: row.pageUrl } })),
    ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, limit);
    return { items, asOf: new Date().toISOString() };
  });
}

export interface ReadinessDay {
  logDate: string;
  workflowSuccessRate: number | null;
  stepLatencyP95Ms: number | null;
  retryRate: number | null;
  humanInterventionRate: number | null;
  reconciliationBacklog: number;
  dlqDepth: number;
  receiptCompleteness: number | null;
  incidentNotes: string | null;
}
export async function readinessTrend(tenantId: string, days = 30): Promise<ReadinessDay[]> {
  return withTenant(tenantId, (db) => db.select({
    logDate: readinessLog.logDate,
    workflowSuccessRate: readinessLog.workflowSuccessRate,
    stepLatencyP95Ms: readinessLog.stepLatencyP95Ms,
    retryRate: readinessLog.retryRate,
    humanInterventionRate: readinessLog.humanInterventionRate,
    reconciliationBacklog: readinessLog.reconciliationBacklog,
    dlqDepth: readinessLog.dlqDepth,
    receiptCompleteness: readinessLog.receiptCompleteness,
    incidentNotes: readinessLog.incidentNotes,
  }).from(readinessLog).where(eq(readinessLog.tenantId, tenantId)).orderBy(desc(readinessLog.logDate)).limit(days));
}

export interface ReadinessSlo {
  id: string;
  label: string;
  value: number | null;
  target: { operator: ">=" | "<=" | "<"; value: number; unit: "ratio" | "ms" | "count" | "seconds" | "minutes" } | null;
  trend30d: Array<{ logDate: string; value: number | null }>;
  errorBudgetBurn: number | null;
  unavailableReason?: string;
}

export async function readinessSloScorecard(tenantId: string): Promise<ReadinessSlo[]> {
  const trend = [...await readinessTrend(tenantId, 30)].reverse();
  const latest = trend.at(-1);
  return [
    { id: "post_approval_success", label: "Post-approval success", value: latest?.workflowSuccessRate ?? null, target: { operator: ">=", value: 0.99, unit: "ratio" }, trend30d: trend.map((row) => ({ logDate: row.logDate, value: row.workflowSuccessRate })), errorBudgetBurn: null },
    { id: "workflow_p95", label: "Workflow p95 latency", value: latest?.stepLatencyP95Ms ?? null, target: null, trend30d: trend.map((row) => ({ logDate: row.logDate, value: row.stepLatencyP95Ms })), errorBudgetBurn: null },
    { id: "dlq_depth", label: "DLQ depth", value: latest?.dlqDepth ?? null, target: { operator: "<=", value: 0, unit: "count" }, trend30d: trend.map((row) => ({ logDate: row.logDate, value: row.dlqDepth })), errorBudgetBurn: latest?.dlqDepth === 0 ? 0 : null },
  ];
}

export interface FailureInjectionRow {
  id: string;
  kind: string;
  injectedAt: string;
  detectedAt: string | null;
  recoveredAt: string | null;
  outcome: string | null;
  detail: unknown;
  receiptIds: unknown;
}
export async function failureInjectionLog(tenantId: string, limit = 50): Promise<FailureInjectionRow[]> {
  const rows = await withTenant(tenantId, (db) => db.select({
    id: failureInjections.id,
    kind: failureInjections.kind,
    injectedAt: failureInjections.injectedAt,
    detectedAt: failureInjections.detectedAt,
    recoveredAt: failureInjections.recoveredAt,
    outcome: failureInjections.outcome,
    detail: failureInjections.detail,
    receiptIds: failureInjections.receiptIds,
  }).from(failureInjections).where(eq(failureInjections.tenantId, tenantId)).orderBy(desc(failureInjections.injectedAt)).limit(limit));
  return rows.map((row) => ({
    ...row,
    injectedAt: row.injectedAt.toISOString(),
    detectedAt: row.detectedAt?.toISOString() ?? null,
    recoveredAt: row.recoveredAt?.toISOString() ?? null,
  }));
}
