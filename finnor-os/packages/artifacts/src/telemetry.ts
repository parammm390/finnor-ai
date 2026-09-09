import { logWithTrace } from "@finnor/tools";

/**
 * Artifact telemetry uses the repository's existing structured log pipeline. Each
 * event is a single numeric sample and carries identifiers only; artifact bytes,
 * extracted text, formulas, provider URLs, and tokens are never accepted here.
 */
export const ARTIFACT_METRICS = [
  "artifact_materializations_total",
  "artifact_materialization_latency",
  "artifact_parse_latency",
  "artifact_parse_failures",
  "artifact_bytes",
  "artifact_ir_bytes",
  "artifact_unsupported_features",
  "artifact_versions_created",
  "artifact_diffs",
  "artifact_operations",
  "artifact_operation_failures",
  "artifact_publish_attempts",
  "artifact_publish_conflicts",
  "artifact_publish_verification_failures",
  "artifact_provider_normalizations",
  "artifact_excel_recalc_latency",
  "artifact_excel_recalc_failures",
  "artifact_stale_calculation_count",
  "artifact_unresolved_source_binding_count",
] as const;

export type ArtifactMetric = typeof ARTIFACT_METRICS[number];
export type ArtifactMetricUnit = "count" | "milliseconds" | "bytes";

export interface ArtifactMetricContext {
  tenantId?: string;
  traceId?: string;
  documentId?: string;
  versionId?: string;
  format?: string;
}

export function recordArtifactMetric(
  context: ArtifactMetricContext,
  metric: ArtifactMetric,
  value: number,
  unit: ArtifactMetricUnit,
): void {
  if (!Number.isFinite(value) || value < 0) return;
  logWithTrace({
    tenantId: context.tenantId,
    traceId: context.traceId,
    subsystem: "artifact_os",
    documentId: context.documentId,
    versionId: context.versionId,
    format: context.format,
  }).info({ event: "artifact_metric", metric, value, unit }, "Artifact OS metric sample");
}
