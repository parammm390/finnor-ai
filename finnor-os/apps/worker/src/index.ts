// Worker service (§16): one process, multiple job-type handlers registered by string key.

import "dotenv/config";

import { initObservability, getLogger, applyEmulatorFaultsFromEnv } from "@finnor/tools";
import { ensureSecretsLoaded } from "@finnor/security";
import { JobQueue } from "./queue";
import { reconciliation } from "./handlers/reconciliation";
import { processInstruction } from "./handlers/process-instruction";
import { voiceConfirmRequest } from "./handlers/voice-confirm-request";
import { voiceNotifyFailure } from "./handlers/voice-notify-failure";
import { runWorkflowStep } from "./handlers/run-workflow-step";
import { relayOutboxEventsHandler } from "./handlers/relay-outbox-events";
import { criticReview } from "./handlers/critic-review";
import { learningDigest } from "./handlers/learning-digest";
import { scanApprovalExpiry } from "./handlers/scan-approval-expiry";
import { scanReliabilityAlerts } from "./handlers/scan-reliability-alerts";
import { scanIntegrationHealth } from "./handlers/scan-integration-health";
import { scanWatchdog } from "./handlers/scan-watchdog";
import { scanDlqTriage } from "./handlers/scan-dlq-triage";
import { backupDb } from "./handlers/backup-db";
import { dailyScorecard } from "./handlers/daily-scorecard";
import { projectReadModels } from "./handlers/project-read-models";
import { repairPlanAfterTerminalFailure } from "./handlers/repair-plan-after-terminal-failure";
import { sendPushNotification } from "./handlers/send-push-notification";
import { purgeRetention } from "./handlers/purge-retention";
import { sendResendEmailJob } from "./handlers/send-resend-email";
import { startScheduler, startGlobalScheduler, type ScheduledScan } from "./scheduler";
import { startHeartbeat } from "./heartbeat";
import { startSseServer } from "./sse-server";
import { recoverObjectives, runObjectiveIteration } from "./handlers/run-objective-iteration";
import { recoverComputerTasks, runComputerTask } from "./handlers/run-computer-task";
import { processWorkEventWaitDeadlineHandler } from "./handlers/process-work-event-wait-deadline";
import { scanConnectionHealth } from "./handlers/scan-connection-health";
import { releaseProbe } from "./handlers/release-probe";
import { syncSource, syncSources } from "./handlers/sync-source";
import { observeExternalEffectHandler } from "./handlers/observe-external-effect";

export function createWorker(): JobQueue {
  const queue = new JobQueue();
  queue.register("reconciliation", reconciliation);
  queue.register("process_instruction", processInstruction);
  queue.register("voice_confirm_request", voiceConfirmRequest);
  queue.register("voice_notify_failure", voiceNotifyFailure);
  queue.register("run_workflow_step", runWorkflowStep);
  queue.register("relay_outbox_events", relayOutboxEventsHandler);
  queue.register("critic_review", criticReview);
  queue.register("learning_digest", learningDigest);
  queue.register("scan_approval_expiry", scanApprovalExpiry);
  queue.register("scan_reliability_alerts", scanReliabilityAlerts);
  queue.register("scan_integration_health", scanIntegrationHealth);
  queue.register("scan_watchdog", scanWatchdog);
  queue.register("scan_dlq_triage", scanDlqTriage);
  queue.register("backup_db", backupDb);
  queue.register("daily_scorecard", dailyScorecard);
  queue.register("project_read_models", projectReadModels);
  queue.register("repair_plan_after_terminal_failure", repairPlanAfterTerminalFailure);
  queue.register("send_push_notification", sendPushNotification);
  queue.register("purge_retention", purgeRetention);
  queue.register("send_resend_email", sendResendEmailJob);
  queue.register("run_objective_iteration", runObjectiveIteration);
  queue.register("recover_objectives", recoverObjectives);
  queue.register("run_computer_task", runComputerTask);
  queue.register("recover_computer_tasks", recoverComputerTasks);
  queue.register("process_work_event_wait_deadline", processWorkEventWaitDeadlineHandler);
  queue.register("scan_connection_health", scanConnectionHealth);
  queue.register("release_probe", releaseProbe);
  queue.register("sync_sources", syncSources);
  queue.register("sync_source", syncSource);
  queue.register("observe_external_effect", observeExternalEffectHandler);
  return queue;
}

// The proactive pillar: every entry here is a real, gated-or-findings-recorded scan,
// never an unattended mutation. Intervals are the MINIMUM gap between runs, not a
// promise of exact timing — the scheduler ticks every 15 min and only actually
// enqueues once a scan's window has rolled over (see scheduler.ts's dateBucket()).
export const ACTIVE_SCHEDULED_SCANS: ScheduledScan[] = [
  { type: "recover_objectives", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "recover_computer_tasks", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "relay_outbox_events", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_approval_expiry", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_reliability_alerts", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_integration_health", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_connection_health", intervalHours: 1 / 4, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_watchdog", intervalHours: 1 / 6, payload: (tenantId) => ({ tenantId }) },
  { type: "scan_dlq_triage", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
  { type: "learning_digest", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "purge_retention", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "daily_scorecard", intervalHours: 24, payload: (tenantId) => ({ tenantId }) },
  { type: "project_read_models", intervalHours: 1, payload: (tenantId) => ({ tenantId }) },
]

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  // Phase 16(e): the worker never initialized Sentry before this — a crash here was
  // console.error or nothing (ground-truth §5). initObservability() no-ops harmlessly
  // without SENTRY_DSN, so this is safe to call unconditionally at boot.
  ensureSecretsLoaded().then(() => {
  initObservability();
  const log = getLogger();
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  log.info({ event: "worker_started" }, "[worker] started, polling jobs table");
  // A3.T4: EMULATOR_FAULTS=<capability>:<mode>,... — never set in production;
  // local/CI chaos runs opt in explicitly.
  const faultedCapabilities = applyEmulatorFaultsFromEnv();
  if (faultedCapabilities.length > 0) {
    log.warn({ event: "emulator_faults_applied", capabilities: faultedCapabilities }, "[worker] EMULATOR_FAULTS applied — emulators are adversarial");
  }
  startHeartbeat(30_000, controller.signal);
  const certificationMode = process.env.FINNOR_ENVIRONMENT?.trim() === "staging" && process.env.P3_DISABLE_PROACTIVE_SCHEDULER?.trim() === "1";
  if (certificationMode) {
    log.warn({ event: "proactive_scheduler_disabled", reason: "P3 staging certification mode" }, "[scheduler] proactive scans disabled for isolated staging certification");
  } else {
    startScheduler(ACTIVE_SCHEDULED_SCANS, 15 * 60_000, controller.signal);
  }
  // A4.T4: global (no tenant loop) — a DB backup isn't per-tenant data, same posture as
  // worker_heartbeat. No-ops loudly inside the handler itself until Param supplies
  // BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO.
  if (!certificationMode) startGlobalScheduler("backup_db", 6, 15 * 60_000, controller.signal);
  // The SSE gateway shares the persistent worker process and binds only when the
  // deployment supplies PORT. Local job-loop development does not require a port.
  if (process.env.PORT) {
    const ssePort = Number(process.env.PORT);
    startSseServer(ssePort, controller.signal)
      .then(() => log.info({ port: ssePort }, "[sse] gateway listening (same process as job loop)"))
      .catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "[sse] gateway failed to start — job loop continues regardless");
      });
  }
  createWorker()
    .runLoop(2000, controller.signal)
    .then(() => process.exit(0))
    .catch((err) => {
      log.fatal({ err: err instanceof Error ? err.message : String(err) }, "[worker] run loop crashed");
      process.exit(1);
    });
  }).catch((err) => {
    console.error("[worker] refused to boot: managed secrets validation failed", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
