import { logWithTrace } from "@finnor/tools";

export const UNDERWRITING_METRICS = [
  "underwriting_runs_total",
  "underwriting_run_latency",
  "underwriting_run_failures",
  "underwriting_invalid_runs",
  "underwriting_missing_inputs",
  "underwriting_conflicting_inputs",
  "underwriting_stale_inputs",
  "underwriting_model_compile_failures",
  "underwriting_model_nodes",
  "underwriting_solver_iterations",
  "underwriting_solver_nonconvergence",
  "underwriting_sensitivity_runs",
  "underwriting_sensitivity_cells",
  "underwriting_sensitivity_failures",
  "underwriting_artifact_projections",
  "underwriting_artifact_mismatches",
  "underwriting_excel_stale_comparisons",
  "underwriting_result_hash_mismatches",
] as const;

export type UnderwritingMetric = (typeof UNDERWRITING_METRICS)[number];

export interface UnderwritingMetricContext {
  tenantId?: string;
  traceId?: string;
  investmentCaseId?: string;
  modelVersionId?: string;
  runId?: string;
}

/** Metadata-only metric sample; financial values and source content are excluded. */
export function recordUnderwritingMetric(
  context: UnderwritingMetricContext,
  metric: UnderwritingMetric,
  value: number,
  unit: "count" | "milliseconds",
): void {
  if (!Number.isFinite(value) || value < 0) return;
  logWithTrace({
    tenantId: context.tenantId,
    traceId: context.traceId,
    subsystem: "pe_underwriting",
    investmentCaseId: context.investmentCaseId,
    modelVersionId: context.modelVersionId,
    runId: context.runId,
  }).info({ event: "underwriting_metric", metric, value, unit }, "PE underwriting metric sample");
}
