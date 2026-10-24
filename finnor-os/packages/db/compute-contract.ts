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
  leaseRecovery?: "immediate_after_expiry";
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
  options: { protocolVersions?: readonly number[]; obligationKind?: JobObligationKind;
    leaseRecovery?: "immediate_after_expiry" } = {},
): ProductionJobContract => ({
  protocolVersions: options.protocolVersions ?? [1],
  retrySafety,
  ...(options.leaseRecovery ? { leaseRecovery: options.leaseRecovery } : {}),
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
  learn_strategic_response_model_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Y2 finite actor-local response learning and independent complete model-set checking; original Work, no effects or protected authority.", {leaseRecovery:"immediate_after_expiry"}),
  evaluate_strategic_response_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Y2 coupled S3 prediction and actual S4 search with independent programme checking; original episode and cumulative use limits, no effects.", {leaseRecovery:"immediate_after_expiry"}),
  construct_interaction_protocol_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Y3 bounded dynamic interaction construction, separately checked full contingent deviations and global beliefs; original episode, no protected or effect authority.", {leaseRecovery:"immediate_after_expiry"}),
  construct_economic_action_theory_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Y1 finite economic semantic construction, separately checked immutable artifacts and original Work resources; no protected or external effects.", {leaseRecovery:"immediate_after_expiry"}),
  run_economic_programme_v1: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Y1 exact internal S5 reservation-right transitions with immutable S6 origins and separate canonical S7 observation; original effects reconcile before retry."),
  identify_digital_system_v1: tenantFixed("INTERACTIVE", "durably_effect_guarded", "X4 exact original consented digital experiments and read-only possible-delivery recovery, independent checker, original resources and physical fences; no protected or production authority."),
  compile_learned_policy_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "X5 consented structural CPU learning, exact pinned native use and independent outcome evaluation under original immutable resources; no protected or production authority.", {leaseRecovery:"immediate_after_expiry"}),
  build_enterprise_application_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "X3 bounded typed compilation, checking and transactional development installation under one original allocation; no guest effects or protected admission.", {leaseRecovery:"immediate_after_expiry"}),
  run_decision_atlas_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "R7 exact named-family atlas under original episode; independent checker, retained physical costs, no effects or protected admission.", {leaseRecovery:"immediate_after_expiry"}),
  run_r1_dependency_continuation_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P7 versioned R1 dependency invalidation patch. Retains original episode, grant and S6 responsibility; no effect or fresh search budget."),
  run_certified_state_reduction_v1: tenantFixed("INTERACTIVE", "reconcilable", "R1 exact continuation reuse under the original Work/P1 episode and S5 grant; unknown physical work reconciles without automatic resubmission."),
  run_identification_plan_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "R4 finite causal acquisition-menu search and independent checking under one original S4/S5 grant; no physical acquisition retry."),
  advance_closing_programme_v1: tenantFixed("INTERACTIVE", "durably_effect_guarded", "V3 exact original-spec maintained closing controller; native S6 children and retained S5 exposure."),
  run_capital_formation_v1: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Original bounded financing programme; canonical provider identities, status-only possible-delivery recovery and independent source classification. No live admission."),
  evaluate_live_control_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Finite current native V5 consequences under the original S5/P1 grant; no reservation or effect authority.", { leaseRecovery: "immediate_after_expiry" }),
  run_application_semantics_v1: tenantFixed("INTERACTIVE", "reconcilable", "X2 exact application operations under original S5/S6 responsibility; recovery observes and never repeats possible egress."),
  run_counterexample_search_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Frozen bounded current candidate/owner search for accepted Work. No live effects or protected admission.", {leaseRecovery:"immediate_after_expiry"}),
  run_capital_program_v2: tenantFixed("INTERACTIVE", "locally_idempotent", "Bounded nonconsequential economic proposals under exact Work/Plan; no allocation or admission granted.", {protocolVersions:[2],leaseRecovery:"immediate_after_expiry"}),
  run_capital_program_r2_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "R2 complete exact finite programme search; original deadline, shared serial native grant, no effect or admission authority.", {protocolVersions:[2],leaseRecovery:"immediate_after_expiry"}),
  run_coalition_programme_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "R5 complete joint coalition/programme/grant/division search under the original shared serial native permit; no effect, consent or admission authority.", {protocolVersions:[2],leaseRecovery:"immediate_after_expiry"}),
  run_incentive_rule_synthesis_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "R3 complete finite proposed mechanism and independent checker under the original grant/deadline with accepted-child recovery; no consent, effect or admission authority.", {leaseRecovery:"immediate_after_expiry"}),
  run_procedure_induction_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P6 ordinary structural induction, no custody/admission grant."),
  run_programme_continuation_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P7 ordinary source-bound continuation under the original P1 episode; no effect or resource authority."),
  run_interface_acquisition_v1: tenantFixed("INTERACTIVE", "reconcilable", "P5 bounded disposable acquisition; possible egress retains original identity and read-only recovery."),
  run_compute_search_unit_v1: { ...tenantFixed("INTERACTIVE", "reconcilable", "P2 original-episode compute; submitted unknown attempts reconcile before retry."), protocolVersions: [1, 2] },
  run_branch_fabric_v1: tenantFixed("HEAVY", "pure", "P3 frozen registered native branch work; no live mutation replay or self-admission."),
  run_evidence_derivation_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Bounded native evidence computation for accepted Work; no protected admission."),
  advance_primary_diligence_v1: tenantFixed("INTERACTIVE", "reconcilable", "V2 original Work/mandate/grant primary acquisition; unknown requests reconcile before retry."),
  advance_bilateral_programme_v1: tenantFixed("INTERACTIVE", "reconcilable", "V1 original Work, mandate and aggregate grant; S6 physical contact and independent original-record qualification."),
  run_harness_program_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P1 bounded ordinary programme linked to canonical WorkPlanRevision; no effect authority."),
  run_x1_institution_continuation_v1: tenantFixed("INTERACTIVE", "reconcilable", "X1 owner-bound ordinary duty with gated action and independent canonical observation; no governed S6 origin."),
  run_x1_institution_compiler_v1: tenantFixed("INTERACTIVE", "reconcilable", "X1 authenticated raw-source reconstruction and original-evidence check under one original Work envelope."),
  run_x1_institution_update_v1: tenantFixed("INTERACTIVE", "reconcilable", "P7 current owner-input update under the original X1 Work episode; no replacement grant or effect authority."),
  reconciliation: tenantFixed("INTERACTIVE", "locally_idempotent", "Provider events may unblock an actively observed effect."),
  process_instruction: tenantFixed("INTERACTIVE", "locally_idempotent", "An accepted user instruction has a near-term response dependency."),
  run_workflow_step: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Scope-2 workflow execution advances accepted Work."),
  run_workflow_step_v2: tenantFixed("INTERACTIVE", "durably_effect_guarded", "Versioned Scope-2 workflow execution advances accepted Work.", { protocolVersions: [2] }),
  run_workflow_step_v3: tenantFixed("INTERACTIVE", "durably_effect_guarded", "S6 delivers exact S4 obligations through protected dispatch and read-only recovery.", { protocolVersions: [3] }),
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
