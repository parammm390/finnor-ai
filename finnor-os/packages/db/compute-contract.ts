/**
 * Scope-3 durable compute contract.
 *
 * This registry is the one code-level authority used by trusted producers and
 * workers.  The database migration carries the same rows as durable policy so a
 * job is classified at INSERT time even when a producer uses Drizzle directly.
 * Payload fields are deliberately absent from ClassificationInput: untrusted
 * business input can never promote itself into a latency-sensitive class.
 */

export const WORKLOAD_CLASSES = ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];
export type JobLane = "interactive" | "batch";
export type JobRetrySafety = "pure" | "locally_idempotent" | "durably_effect_guarded" | "reconcilable" | "unsafe_legacy";
export type JobTenantScope = "tenant" | "global";
export type JobObligationKind = "required" | "coalescible";
export type JobClassificationRule = "fixed" | "trusted_lane";

export const COMPUTE_CLASSIFICATION_REVISION = 1;
export const COMPUTE_CUTOVER_EPOCH = 3;

/** Engineering scaling targets, not product SLOs or provider quotas. Keeping the
 * values in the shared compute contract prevents the worker publisher, API
 * backpressure, and operational views from silently using different thresholds. */
export const COMPUTE_CLASS_SCALE_TARGETS: Record<WorkloadClass, { ageSeconds: number; backlogPerTask: number }> = {
  REALTIME: { ageSeconds: 15, backlogPerTask: 2 },
  INTERACTIVE: { ageSeconds: 60, backlogPerTask: 4 },
  BACKGROUND: { ageSeconds: 900, backlogPerTask: 8 },
  HEAVY: { ageSeconds: 1800, backlogPerTask: 1 },
};

/** Publishers tick every 60 seconds. Two missed publications plus scheduling
 * slack is degraded/unknown, never equivalent to a zero backlog. */
export const COMPUTE_TELEMETRY_FRESHNESS_SECONDS = 150;

export interface ProductionJobContract {
  protocolVersions: readonly number[];
  retrySafety: JobRetrySafety;
  defaultClass: WorkloadClass;
  allowedClasses: readonly WorkloadClass[];
  classificationRule: JobClassificationRule;
  tenantScope: JobTenantScope;
  obligationKind: JobObligationKind;
  /** Engineering rationale persisted indirectly through policy revision + rule. */
  rationale: string;
}

const tenantFixed = (
  workloadClass: WorkloadClass,
  retrySafety: JobRetrySafety,
  rationale: string,
  options: { protocolVersions?: readonly number[]; obligationKind?: JobObligationKind } = {},
): ProductionJobContract => ({
  protocolVersions: options.protocolVersions ?? [1],
  retrySafety,
  defaultClass: workloadClass,
  allowedClasses: [workloadClass],
  classificationRule: "fixed",
  tenantScope: "tenant",
  obligationKind: options.obligationKind ?? "required",
  rationale,
});

const tenantLaneClassified = (
  retrySafety: JobRetrySafety,
  rationale: string,
): ProductionJobContract => ({
  protocolVersions: [1],
  retrySafety,
  defaultClass: "BACKGROUND",
  allowedClasses: ["BACKGROUND", "INTERACTIVE"],
  classificationRule: "trusted_lane",
  tenantScope: "tenant",
  obligationKind: "required",
  rationale,
});

/** Exhaustive registry for every production handler registered by the worker. */
export const PRODUCTION_JOB_CONTRACTS = {
  reconciliation: tenantFixed("INTERACTIVE", "locally_idempotent", "Provider events may unblock an actively observed effect."),
  process_instruction: tenantFixed("INTERACTIVE", "locally_idempotent", "An accepted user instruction has a near-term response dependency."),
  run_workflow_step: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Scope-2 workflow execution advances accepted Work."),
  run_workflow_step_v2: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Versioned Scope-2 workflow execution advances accepted Work.", { protocolVersions: [2] }),
  critic_review: tenantFixed("BACKGROUND", "locally_idempotent", "The asynchronous second opinion does not gate durable action acceptance."),
  learning_digest: tenantFixed("BACKGROUND", "locally_idempotent", "Daily learning aggregation is scheduled and coalescible.", { obligationKind: "coalescible" }),
  scan_approval_expiry: tenantFixed("BACKGROUND", "locally_idempotent", "Scheduled approval hygiene has no active-session SLO.", { obligationKind: "coalescible" }),
  scan_reliability_alerts: tenantFixed("BACKGROUND", "locally_idempotent", "Scheduled reliability detection is bounded maintenance.", { obligationKind: "coalescible" }),
  scan_integration_health: tenantFixed("BACKGROUND", "locally_idempotent", "Scheduled provider health probes are maintenance.", { obligationKind: "coalescible" }),
  scan_watchdog: tenantFixed("BACKGROUND", "locally_idempotent", "Scheduled recovery discovery is maintenance.", { obligationKind: "coalescible" }),
  scan_dlq_triage: tenantFixed("BACKGROUND", "locally_idempotent", "DLQ triage is asynchronous operational maintenance.", { obligationKind: "coalescible" }),
  daily_scorecard: tenantFixed("BACKGROUND", "locally_idempotent", "Daily scorecard projection is scheduled and coalescible.", { obligationKind: "coalescible" }),
  project_read_models: tenantFixed("BACKGROUND", "locally_idempotent", "Periodic projection refresh is a backstop, not the realtime path.", { obligationKind: "coalescible" }),
  repair_plan_after_terminal_failure: tenantFixed("INTERACTIVE", "locally_idempotent", "Repair resumes already accepted Work after a terminal step."),
  purge_retention: tenantFixed("HEAVY", "locally_idempotent", "Retention performs bounded bulk deletes and scrubbing inside a transaction.", { obligationKind: "coalescible" }),
  run_objective_iteration: tenantFixed("INTERACTIVE", "locally_idempotent", "Objective iteration is the active Scope-1 controller."),
  run_workforce_assignment: tenantFixed("INTERACTIVE", "locally_idempotent", "An accepted assignment advances active Work."),
  recover_objectives: tenantFixed("BACKGROUND", "locally_idempotent", "Objective recovery is a scheduled bounded sweep.", { obligationKind: "coalescible" }),
  run_computer_task: tenantFixed("HEAVY", "durably_effect_guarded", "Browser sessions are long-lived and materially consume memory/provider capacity."),
  recover_computer_tasks: tenantFixed("BACKGROUND", "locally_idempotent", "Computer recovery discovers orphaned heavy work without running it inline.", { obligationKind: "coalescible" }),
  process_work_event_wait_deadline: tenantFixed("INTERACTIVE", "locally_idempotent", "A durable wait deadline resumes accepted Work."),
  scan_connection_health: tenantFixed("BACKGROUND", "locally_idempotent", "Connection health scanning is scheduled maintenance.", { obligationKind: "coalescible" }),
  release_probe: {
    protocolVersions: [1], retrySafety: "pure", defaultClass: "REALTIME", allowedClasses: ["REALTIME"],
    classificationRule: "fixed", tenantScope: "global", obligationKind: "coalescible",
    rationale: "The side-effect-free release probe validates the ingress-owning realtime service.",
  },
  sync_sources: tenantFixed("BACKGROUND", "locally_idempotent", "Source discovery is scheduled fan-out maintenance.", { obligationKind: "coalescible" }),
  sync_source: tenantLaneClassified("locally_idempotent", "Scheduled sync is background; a trusted controller may mark an unblock sync interactive."),
  observe_external_effect: tenantFixed("INTERACTIVE", "locally_idempotent", "Observation resolves an accepted Scope-2 effect outcome."),
  maintain_integration_subscriptions: tenantLaneClassified("reconcilable", "Routine renewal is background; a trusted setup flow may require interactive convergence."),
  materialize_artifact_version: tenantFixed("HEAVY", "durably_effect_guarded", "Artifact download/compile/upload paths have high byte and memory envelopes."),
  process_epistemic_change_v2: tenantFixed("BACKGROUND", "locally_idempotent", "Accepted version changes advance a fenced durable epistemic frontier.", { protocolVersions: [2] }),
  scan_epistemic_freshness_v2: tenantFixed("BACKGROUND", "locally_idempotent", "Indexed due-freshness discovery is bounded maintenance.", { protocolVersions: [2], obligationKind: "coalescible" }),
  recover_epistemic_changes_v2: tenantFixed("BACKGROUND", "locally_idempotent", "Recover accepted changes without a live physical delivery.", { protocolVersions: [2], obligationKind: "coalescible" }),
  refresh_epistemic_graph_v2: tenantFixed("BACKGROUND", "locally_idempotent", "Rebuild and shadow-verify a PE graph after newly relevant canonical structure.", { protocolVersions: [2], obligationKind: "coalescible" }),
} as const satisfies Record<string, ProductionJobContract>;

export type ProductionJobType = keyof typeof PRODUCTION_JOB_CONTRACTS;

export interface ClassificationInput {
  type: string;
  lane: JobLane;
}

export interface JobClassification {
  workloadClass: WorkloadClass;
  policyRevision: number;
  reason: string;
  tenantScope: JobTenantScope;
  obligationKind: JobObligationKind;
}

export function isProductionJobType(type: string): type is ProductionJobType {
  return Object.prototype.hasOwnProperty.call(PRODUCTION_JOB_CONTRACTS, type);
}

/** Pure mirror of the INSERT trigger. It is advisory for callers; the trigger is
 * the final authority and overwrites supplied classification columns. */
export function classifyTrustedJobInstance(input: ClassificationInput): JobClassification {
  if (!isProductionJobType(input.type)) {
    return {
      workloadClass: "BACKGROUND",
      policyRevision: 0,
      reason: "legacy-safe-default:unknown-job-type",
      tenantScope: "global",
      obligationKind: "required",
    };
  }
  const policy = PRODUCTION_JOB_CONTRACTS[input.type];
  const workloadClass: WorkloadClass = policy.classificationRule === "trusted_lane"
    && input.lane === "interactive"
    && policy.allowedClasses.includes("INTERACTIVE")
    ? "INTERACTIVE"
    : policy.defaultClass;
  return {
    workloadClass,
    policyRevision: COMPUTE_CLASSIFICATION_REVISION,
    reason: `policy:${input.type}:${policy.classificationRule}:${input.lane}`,
    tenantScope: policy.tenantScope,
    obligationKind: policy.obligationKind,
  };
}

export function contractsForClass(workloadClass: WorkloadClass): Array<[ProductionJobType, ProductionJobContract]> {
  return (Object.entries(PRODUCTION_JOB_CONTRACTS) as Array<[ProductionJobType, ProductionJobContract]>)
    .filter(([, contract]) => contract.allowedClasses.includes(workloadClass));
}

export function parseWorkloadClass(value: string | undefined): WorkloadClass {
  const normalized = value?.trim().toUpperCase();
  if (WORKLOAD_CLASSES.includes(normalized as WorkloadClass)) return normalized as WorkloadClass;
  throw new Error(`FINNOR_WORKLOAD_CLASS must be one of ${WORKLOAD_CLASSES.join(", ")}`);
}
