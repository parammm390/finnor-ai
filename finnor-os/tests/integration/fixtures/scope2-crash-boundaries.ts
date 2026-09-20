export type CrashCheckpoint = "pre_commit_rollback" | "post_commit_durable";

export interface Scope2CrashBoundary {
  id: string;
  checkpoint?: CrashCheckpoint;
  semanticEvidence: string;
  disposition: "ACTIVE_SIGKILL" | "RETIRED_NOT_REACHABLE" | "UNSUPPORTED_FAIL_CLOSED";
}

/** Exact Phase-2 crash list. Every active row receives its own real child-process
 * SIGKILL transaction probe; high-risk runtime/provider rows additionally have deep
 * end-to-end SIGKILL scenarios in scope2-crash-matrix.test.ts. */
export const SCOPE2_CRASH_BOUNDARIES = [
  { id: "command-authorization-before-transaction-commit", checkpoint: "pre_commit_rollback", semanticEvidence: "deep:command-pre-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "command-run-step-before-first-job-commit", checkpoint: "pre_commit_rollback", semanticEvidence: "deep:command-pre-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "job-claimed-before-handler-start", checkpoint: "post_commit_durable", semanticEvidence: "queue lease recovery + job_delivery_attempt history", disposition: "ACTIVE_SIGKILL" },
  { id: "job-handler-running-before-step-claim", checkpoint: "post_commit_durable", semanticEvidence: "queue redelivery + protocol-compatible preclaim", disposition: "ACTIVE_SIGKILL" },
  { id: "step-claim-committed", checkpoint: "post_commit_durable", semanticEvidence: "deep:step-claim-post-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "decision-receipt-opened", checkpoint: "post_commit_durable", semanticEvidence: "deep:step-claim-post-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "step-claim-before-authority-revalidation", checkpoint: "post_commit_durable", semanticEvidence: "durable execution revalidation test", disposition: "ACTIVE_SIGKILL" },
  { id: "after-authority-revalidation", checkpoint: "post_commit_durable", semanticEvidence: "durable execution revalidation test", disposition: "ACTIVE_SIGKILL" },
  { id: "before-effect-commit-point", checkpoint: "pre_commit_rollback", semanticEvidence: "transaction rollback + safe redelivery", disposition: "ACTIVE_SIGKILL" },
  { id: "immediately-after-effect-commit-point", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-prepared", disposition: "ACTIVE_SIGKILL" },
  { id: "before-first-provider-byte-may-leave", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-prepared", disposition: "ACTIVE_SIGKILL" },
  { id: "during-provider-request", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-possible-egress", disposition: "ACTIVE_SIGKILL" },
  { id: "provider-accepted-response-lost", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-response-before-persist", disposition: "ACTIVE_SIGKILL" },
  { id: "provider-response-before-operation-result-persisted", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-response-before-persist", disposition: "ACTIVE_SIGKILL" },
  { id: "operation-result-before-business-effect-observation", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-ack-post-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "provider-ack-before-readback-scheduled", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-ack-post-commit; atomic ACK/result/job transaction", disposition: "ACTIVE_SIGKILL" },
  { id: "readback-job-scheduled-before-worker-crash", checkpoint: "post_commit_durable", semanticEvidence: "deep:provider-ack-post-commit", disposition: "ACTIVE_SIGKILL" },
  { id: "observation-fetched-before-verification-persistence", checkpoint: "post_commit_durable", semanticEvidence: "external observation transaction rollback/monotonic tests", disposition: "ACTIVE_SIGKILL" },
  { id: "verification-persisted-before-step-completion", checkpoint: "post_commit_durable", semanticEvidence: "observation settlement idempotency tests", disposition: "ACTIVE_SIGKILL" },
  { id: "step-completion-before-workflow-advancement", checkpoint: "post_commit_durable", semanticEvidence: "deep:advance-mid-multi-step", disposition: "ACTIVE_SIGKILL" },
  { id: "workflow-advancement-before-work-reconciliation", checkpoint: "post_commit_durable", semanticEvidence: "deep:advance-mid-multi-step + watchdog orphan healing", disposition: "ACTIVE_SIGKILL" },
  { id: "work-reconciliation-before-objective-resume", checkpoint: "post_commit_durable", semanticEvidence: "Scope-1 objective resume idempotency", disposition: "ACTIVE_SIGKILL" },
  { id: "outbox-producer-state-before-relay", semanticEvidence: "0137 retirement guard + zero production producers", disposition: "RETIRED_NOT_REACHABLE" },
  { id: "outbox-destination-accepted-before-delivered", semanticEvidence: "relay/destination path retired; no fabricated delivery", disposition: "RETIRED_NOT_REACHABLE" },
  { id: "inbox-event-persisted-before-wait-match", checkpoint: "post_commit_durable", semanticEvidence: "inbox/integration-event dedupe and wait matching tests", disposition: "ACTIVE_SIGKILL" },
  { id: "wait-satisfied-before-wake-job-or-claim", checkpoint: "post_commit_durable", semanticEvidence: "deadline/event race and durable wake tests", disposition: "ACTIVE_SIGKILL" },
  { id: "wake-claim-before-objective-iteration", checkpoint: "post_commit_durable", semanticEvidence: "duplicate wake storm / one continuation", disposition: "ACTIVE_SIGKILL" },
  { id: "deadline-event-race", checkpoint: "post_commit_durable", semanticEvidence: "deadline/event race has one terminal winner", disposition: "ACTIVE_SIGKILL" },
  { id: "reconciliation-evidence-before-settlement", checkpoint: "post_commit_durable", semanticEvidence: "evidence-bearing version-fenced resolution tests", disposition: "ACTIVE_SIGKILL" },
  { id: "reconciliation-settlement-before-controller-resume", checkpoint: "post_commit_durable", semanticEvidence: "reconciliation idempotency + aggregate resume tests", disposition: "ACTIVE_SIGKILL" },
  { id: "dlq-replay-before-redrive-persistence", checkpoint: "pre_commit_rollback", semanticEvidence: "atomic authorized operator-control/redrive tests", disposition: "ACTIVE_SIGKILL" },
  { id: "compensation-commit-point", semanticEvidence: "unsupported compensation fails closed; no production-reachable inverse", disposition: "UNSUPPORTED_FAIL_CLOSED" },
] as const satisfies readonly Scope2CrashBoundary[];
