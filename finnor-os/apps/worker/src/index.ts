// Worker service (§16): one process, multiple job-type handlers registered by string key.

import "dotenv/config";

import { initObservability, getLogger, applyEmulatorFaultsFromEnv } from "@finnor/tools";
import { ensureSecretsLoaded } from "@finnor/security";
import { JobQueue } from "./queue";
import { reconciliation } from "./handlers/reconciliation";
import { processInstruction } from "./handlers/process-instruction";
import { runWorkflowStep } from "./handlers/run-workflow-step";
import { criticReview } from "./handlers/critic-review";
import { learningDigest } from "./handlers/learning-digest";
import { scanApprovalExpiry } from "./handlers/scan-approval-expiry";
import { scanReliabilityAlerts } from "./handlers/scan-reliability-alerts";
import { scanIntegrationHealth } from "./handlers/scan-integration-health";
import { scanWatchdog } from "./handlers/scan-watchdog";
import { scanDlqTriage } from "./handlers/scan-dlq-triage";
import { dailyScorecard } from "./handlers/daily-scorecard";
import { projectReadModels } from "./handlers/project-read-models";
import { repairPlanAfterTerminalFailure } from "./handlers/repair-plan-after-terminal-failure";
import { purgeRetention } from "./handlers/purge-retention";
import { startScheduler, type ScheduledScan } from "./scheduler";
import { initializeWorkerTaskIdentity, startHeartbeat } from "./heartbeat";
import { startSseServer } from "./sse-server";
import { recoverObjectives, runObjectiveIteration } from "./handlers/run-objective-iteration";
import { runWorkforceAssignment } from "./handlers/run-workforce-assignment";
import { recoverComputerTasks, runComputerTask } from "./handlers/run-computer-task";
import { processWorkEventWaitDeadlineHandler } from "./handlers/process-work-event-wait-deadline";
import { scanConnectionHealth } from "./handlers/scan-connection-health";
import { releaseProbe } from "./handlers/release-probe";
import { syncSource, syncSources } from "./handlers/sync-source";
import { observeExternalEffectHandler } from "./handlers/observe-external-effect";
import { maintainIntegrationSubscriptions } from "./handlers/maintain-integration-subscriptions";
import { materializeArtifactVersion } from "./handlers/materialize-artifact-version";
import { processEpistemicChange, recoverEpistemicChanges, refreshEpistemicGraph, scanEpistemicFreshness } from "./handlers/epistemic-impact";
import { PRODUCTION_JOB_CONTRACTS } from "./job-contracts";
import { getPool, parseWorkloadClass, startComputeControlLeadership, type WorkloadClass } from "@finnor/db";
import { startClassHealthServer } from "./class-health";
import { startComputeTelemetry } from "./telemetry";
import { installWorkerDrainSignals } from "./drain-signals";

export function createWorker(): JobQueue {
  const queue = new JobQueue();
  queue.register("reconciliation", reconciliation, PRODUCTION_JOB_CONTRACTS.reconciliation);
  queue.register("process_instruction", processInstruction, PRODUCTION_JOB_CONTRACTS.process_instruction);
  queue.register("run_workflow_step", runWorkflowStep, PRODUCTION_JOB_CONTRACTS.run_workflow_step);
  // Protocol 2 uses a new physical type so a mixed-deploy protocol-1 worker cannot
  // claim an incompatible payload merely because its old SQL ignores version fields.
  queue.register("run_workflow_step_v2", runWorkflowStep, PRODUCTION_JOB_CONTRACTS.run_workflow_step_v2);
  queue.register("critic_review", criticReview, PRODUCTION_JOB_CONTRACTS.critic_review);
  queue.register("learning_digest", learningDigest, PRODUCTION_JOB_CONTRACTS.learning_digest);
  queue.register("scan_approval_expiry", scanApprovalExpiry, PRODUCTION_JOB_CONTRACTS.scan_approval_expiry);
  queue.register("scan_reliability_alerts", scanReliabilityAlerts, PRODUCTION_JOB_CONTRACTS.scan_reliability_alerts);
  queue.register("scan_integration_health", scanIntegrationHealth, PRODUCTION_JOB_CONTRACTS.scan_integration_health);
  queue.register("scan_watchdog", scanWatchdog, PRODUCTION_JOB_CONTRACTS.scan_watchdog);
  queue.register("scan_dlq_triage", scanDlqTriage, PRODUCTION_JOB_CONTRACTS.scan_dlq_triage);
  queue.register("daily_scorecard", dailyScorecard, PRODUCTION_JOB_CONTRACTS.daily_scorecard);
  queue.register("project_read_models", projectReadModels, PRODUCTION_JOB_CONTRACTS.project_read_models);
  queue.register("repair_plan_after_terminal_failure", repairPlanAfterTerminalFailure, PRODUCTION_JOB_CONTRACTS.repair_plan_after_terminal_failure);
  queue.register("purge_retention", purgeRetention, PRODUCTION_JOB_CONTRACTS.purge_retention);
  queue.register("run_objective_iteration", runObjectiveIteration, PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
  queue.register("run_workforce_assignment", runWorkforceAssignment, PRODUCTION_JOB_CONTRACTS.run_workforce_assignment);
  queue.register("recover_objectives", recoverObjectives, PRODUCTION_JOB_CONTRACTS.recover_objectives);
  queue.register("run_computer_task", runComputerTask, PRODUCTION_JOB_CONTRACTS.run_computer_task);
  queue.register("recover_computer_tasks", recoverComputerTasks, PRODUCTION_JOB_CONTRACTS.recover_computer_tasks);
  queue.register("process_work_event_wait_deadline", processWorkEventWaitDeadlineHandler, PRODUCTION_JOB_CONTRACTS.process_work_event_wait_deadline);
  queue.register("scan_connection_health", scanConnectionHealth, PRODUCTION_JOB_CONTRACTS.scan_connection_health);
  queue.register("release_probe", releaseProbe, PRODUCTION_JOB_CONTRACTS.release_probe);
  queue.register("sync_sources", syncSources, PRODUCTION_JOB_CONTRACTS.sync_sources);
  queue.register("sync_source", syncSource, PRODUCTION_JOB_CONTRACTS.sync_source);
  queue.register("observe_external_effect", observeExternalEffectHandler, PRODUCTION_JOB_CONTRACTS.observe_external_effect);
  queue.register("maintain_integration_subscriptions", maintainIntegrationSubscriptions, PRODUCTION_JOB_CONTRACTS.maintain_integration_subscriptions);
  queue.register("materialize_artifact_version", materializeArtifactVersion, PRODUCTION_JOB_CONTRACTS.materialize_artifact_version);
  queue.register("process_epistemic_change_v2", processEpistemicChange, PRODUCTION_JOB_CONTRACTS.process_epistemic_change_v2);
  queue.register("scan_epistemic_freshness_v2", scanEpistemicFreshness, PRODUCTION_JOB_CONTRACTS.scan_epistemic_freshness_v2);
  queue.register("recover_epistemic_changes_v2", recoverEpistemicChanges, PRODUCTION_JOB_CONTRACTS.recover_epistemic_changes_v2);
  queue.register("refresh_epistemic_graph_v2", refreshEpistemicGraph, PRODUCTION_JOB_CONTRACTS.refresh_epistemic_graph_v2);
  return queue;
}

// The proactive pillar: every entry here is a real, gated-or-findings-recorded scan,
// never an unattended mutation. Intervals are the MINIMUM gap between runs, not a
// promise of exact timing — the scheduler ticks every 15 min and only actually
// enqueues once a scan's window has rolled over (see scheduler.ts's dateBucket()).
export const ACTIVE_SCHEDULED_SCANS: ScheduledScan[] = [
  { type: "recover_objectives", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "recover_computer_tasks", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_approval_expiry", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_reliability_alerts", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_integration_health", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_connection_health", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
  // The 15-minute tick only discovers scopes whose explicit per-scope recovery
  // cadence is due; actual Graph work remains bounded, leased queue work.
  { type: "sync_sources", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
  { type: "maintain_integration_subscriptions", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_watchdog", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_dlq_triage", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "learning_digest", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "purge_retention", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "daily_scorecard", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "project_read_models", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_epistemic_freshness_v2", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
  { type: "recover_epistemic_changes_v2", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "refresh_epistemic_graph_v2", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
]

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  // Phase 16(e): the worker never initialized Sentry before this — a crash here was
  // console.error or nothing (ground-truth §5). initObservability() no-ops harmlessly
  // without SENTRY_DSN, so this is safe to call unconditionally at boot.
  ensureSecretsLoaded().then(async () => {
  await initializeWorkerTaskIdentity();
  initObservability();
  const log = getLogger();
  const workloadClass: WorkloadClass | null = process.env.FINNOR_WORKLOAD_CLASS
    ? parseWorkloadClass(process.env.FINNOR_WORKLOAD_CLASS) : null;
  if (process.env.FINNOR_ENVIRONMENT === "production" && !workloadClass) {
    throw new Error("Production compute service requires FINNOR_WORKLOAD_CLASS");
  }
  if (workloadClass) {
    const cutover = await getPool().query("SELECT state FROM compute_plane_cutover WHERE singleton=true");
    if (cutover.rowCount !== 1) throw new Error("Scope-3 compute migration has not been applied");
  }
  const controller = new AbortController();
  installWorkerDrainSignals(controller);
  log.info({ event: "worker_started", workloadClass }, "[worker] started, polling canonical jobs table");
  // A3.T4: EMULATOR_FAULTS=<capability>:<mode>,... — never set in production;
  // local/CI chaos runs opt in explicitly.
  const faultedCapabilities = applyEmulatorFaultsFromEnv();
  if (faultedCapabilities.length > 0) {
    log.warn({ event: "emulator_faults_applied", capabilities: faultedCapabilities }, "[worker] EMULATOR_FAULTS applied — emulators are adversarial");
  }
  const certificationMode = process.env.FINNOR_ENVIRONMENT?.trim() === "staging" && process.env.P3_DISABLE_PROACTIVE_SCHEDULER?.trim() === "1";
  const schedulerEligible = workloadClass === "BACKGROUND" || workloadClass === null;
  const scheduler = schedulerEligible && !certificationMode
    ? startScheduler(ACTIVE_SCHEDULED_SCANS, 15 * 60_000, controller.signal)
    : null;
  const heartbeat = startHeartbeat(30_000, controller.signal, { workloadClass, ownsScheduler: () => scheduler?.isLeader() === true });
  if (workloadClass) startComputeTelemetry(workloadClass, controller.signal);
  if (certificationMode) {
    log.warn({ event: "proactive_scheduler_disabled", reason: "P3 staging certification mode" }, "[scheduler] proactive scans disabled for isolated staging certification");
  }
  // The SSE gateway shares the persistent worker process and binds only when the
  // deployment supplies PORT. Local job-loop development does not require a port.
  if (process.env.PORT && (workloadClass === "REALTIME" || workloadClass === null)) {
    const ssePort = Number(process.env.PORT);
    startSseServer(ssePort, controller.signal)
      .then(() => log.info({ port: ssePort }, "[sse] gateway listening (same process as job loop)"))
      .catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "[sse] gateway failed to start — job loop continues regardless");
      });
  }
  if (process.env.PORT && workloadClass && workloadClass !== "REALTIME") {
    void startClassHealthServer(workloadClass, Number(process.env.PORT), controller.signal)
      .catch((err) => {
        log.fatal({ err: err instanceof Error ? err.message : String(err) }, "[worker] class health endpoint failed");
        controller.abort();
      });
  }
  const queue = createWorker();
  const recoveryLeadership = startComputeControlLeadership(
    `queue-recovery:${workloadClass ?? "legacy"}`, queue.instanceId, controller.signal,
  );
  let recoveryRunning = false;
  const recoverExpired = async () => {
    if (controller.signal.aborted || !recoveryLeadership.isLeader() || recoveryRunning) return;
    recoveryRunning = true;
    try {
      const recovered = await queue.recoverExpiredRunningJobs();
      if (recovered >= 100) log.warn({ recovered, workloadClass }, "[worker] recovery batch saturated; more expired jobs remain for next bounded sweep");
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, "[worker] bounded recovery sweep failed");
    } finally {
      recoveryRunning = false;
    }
  };
  const recoveryTimer = setInterval(() => { void recoverExpired(); }, 30_000);
  controller.signal.addEventListener("abort", () => clearInterval(recoveryTimer), { once: true });
  void recoverExpired();
  const drainDeadlineMs = 110_000; // ECS StopTimeout is 120 seconds.
  queue
    .runLoop(2000, controller.signal)
    .then(async () => {
      await heartbeat.markDraining();
      process.exit(0);
    })
    .catch((err) => {
      log.fatal({ err: err instanceof Error ? err.message : String(err) }, "[worker] run loop crashed");
      process.exit(1);
    });
  controller.signal.addEventListener("abort", () => {
    setTimeout(async () => {
      log.error({ drainDeadlineMs }, "[worker] drain deadline reached; unfinished jobs remain leased for fenced recovery");
      await heartbeat.markDraining().catch(() => undefined);
      process.exit(1);
    }, drainDeadlineMs).unref();
  }, { once: true });
  }).catch((err) => {
    console.error("[worker] refused to boot: runtime configuration or managed secrets validation failed", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
