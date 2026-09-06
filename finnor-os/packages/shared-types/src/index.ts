// Shared type contracts for the Finnor AI Operating System.
// Every subsystem (orchestration, plugins, memory, tools, workers) compiles against these.

export * from "./operational-queries";
export * from "./company-graph";
export * from "./operating-context";
export * from "./operating-interaction";
export * from "./conversation-context";
export * from "./identity-access";
export * from "./universal-actions";
export * from "./computer";
export * from "./operational-delta";
export * from "./execution-projection";
export * from "./causal-replay";
export * from "./business-effects";
export * from "./objectives";
export * from "./source-truth";
export * from "./outcome-packs";
export * from "./vertical-runtime";
export * from "./retired-water";

export type Role = "owner";

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  /** Canonical employee identity. Human sessions always set this to users.id;
   * service principals deliberately leave it absent. */
  employeeId?: string;
  /** Snapshot only. Every execution boundary re-evaluates against the current
   * tenant revision before producing an effect. */
  authorityRevision?: number;
  authorityRoles?: string[];
  /** Phase 16(e): per-request trace id, generated (or forwarded from an inbound
   *  `x-correlation-id` header) in requireContext. Threaded through enqueueJob's
   *  payload and worker breadcrumbs so one instruction's effects are greppable across
   *  process boundaries — not a DB column, never persisted on its own. */
  correlationId?: string;
}

export type AuthorityRisk = "low" | "medium" | "high";
export type AuthorityOperation = "query" | "action" | "approval" | "execution" | "durable_operation";
export type AuthorityOutcome = "allowed" | "denied" | "approval_required";

export interface AuthorityResource {
  type: string;
  id?: string;
}

export interface AuthorityRequest {
  operation: AuthorityOperation;
  capability: string;
  resource?: AuthorityResource;
  /** Exact resources for a cohort/batch. Every member must be in scope. */
  resources?: AuthorityResource[];
  amountUsd?: number;
  risk: AuthorityRisk;
  policyRequiresApproval?: boolean;
  workId?: string;
  domainActionId?: string;
  operationId?: string;
  /** Canonical semantic intent evaluated at the boundary. Absent only for reads and
   * historical callers that predate the Business Effect kernel. */
  businessEffectId?: string;
  businessEffectHash?: string;
}

export interface AuthorityDecision {
  id: string;
  tenantId: string;
  employeeId: string | null;
  authorityRevision: number;
  operation: AuthorityOperation;
  capability: string;
  resourceType: string;
  resourceId: string | null;
  amountUsd: number | null;
  risk: AuthorityRisk;
  outcome: AuthorityOutcome;
  reasonCode: string;
  approvalChainId: string | null;
  eligibleApproverIds: string[];
  evidence: Record<string, unknown>;
  businessEffectId?: string | null;
  businessEffectHash?: string | null;
}

/** B1.T1: the shape of every 'jarvis_events' Postgres NOTIFY payload — IDs only, never
 *  the row's own data (see packages/db/migrations/0037's own comment on why). Shared
 *  by apps/worker/src/sse/listener.ts (the LISTEN side) and packages/projections (the
 *  CQRS projector), so both sides of that channel agree on one type. */
export interface JarvisEvent {
  tenantId: string;
  kind: string;
  id: string;
  ts: string;
}

export type DomainActionStatus =
  | "draft"
  | "pending" // awaiting human confirmation — the gate
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "needs_human_review"
  | "blocked_integration_unavailable";

export interface DomainAction {
  id: string;
  tenantId: string;
  actionType: string;
  payload: Record<string, unknown>;
  policyId: string | null;
  policyVersion?: number | null;
  status: DomainActionStatus;
  createdAt: string;
  /** Upgrade 2: stable parent for the complete instruction lifecycle. Nullable on
   * historical/system-authored actions that did not originate from a user Work. */
  workId?: string | null;
  plannerAttemptId?: string | null;
  initiatedBy?: string | null;
  authorityDecisionId?: string | null;
  authorityRevision?: number | null;
  authorityContext?: Record<string, unknown>;
  /** Upgrade 9: the one bounded objective iteration that selected this action. */
  objectiveStepId?: string | null;
  /** Why the LLM planner chose this action_type/payload — optional (only the LLM
   *  planner path sets it; draftKnownAction/system-originated actions have no LLM
   *  reasoning to report). Not a DB column — carried through to the "planned"
   *  action_log episode for the learning/feedback pillar, never queried directly. */
  reasoning?: string;
  /** Phase 6 typed plan compiler (§6) output — absent on rows created before this
   *  phase or by a path that bypasses the compiler. See packages/orchestration/src/compiler.ts. */
  groundedPayload?: Array<{ field: string; status: "verified" | "not_found" | "unverifiable" }> | null;
  compiledGraph?: { kind: "workflow" | "single_action"; commandType: string; requiresConfirmation: boolean; autoApprove: boolean } | null;
  /** Phase 16(e): carried from TenantContext.correlationId when a ctx is available
   *  (handleInstruction). Not a DB column — in-memory only, so draftKnownAction/
   *  runAction paths (no ctx) simply leave it undefined; enqueueJob falls back to the
   *  job's own id in that case (see queue.ts). */
  correlationId?: string;
  /** §3.6: who approved this action (ctx.userId from the confirm route, or a voice
   *  session id) — stamped by runAction() right after decide()'s conditional status
   *  transition wins. Not a DB column, mirrors correlationId's convention — threads
   *  through to DecisionReceipt.approval.approvedBy via DraftAction.approvedBy below.
   *  A system-drafted action that auto-runs with no human gate (requiresConfirmation:
   *  false) simply leaves this undefined, which is honest — nobody approved it, it
   *  was allowed to run unattended by policy. */
  approvedBy?: string;
  /** Frozen canonical semantic intent. Nullable for reads and historical actions. */
  businessEffectId?: string | null;
}

export interface DomainPolicy {
  id: string;
  tenantId: string;
  actionType: string;
  /** The actual business rule — decision tree / rule set / prompt template. Config, never code. */
  policy: Record<string, unknown>;
  requiresConfirmation: boolean;
  confirmationTemplate: string | null;
  /** Optional per-action-type model provider override (config, not code). */
  modelProvider?: string;
  /** §2.8: hours a gated action may sit "pending" before scan_approval_expiry
   *  escalates it to needs_human_review. Unset/null means the application default
   *  (24h) applies. */
  confirmationTimeoutHours?: number | null;
  /** §3.1: what decision_receipts.policy_applied.version cites — bumped whenever this
   *  row's config changes. Defaults to 1 on every new row (migration 0023). */
  version: number;
}

/** Phase 8: how much extra reasoning depth a drafted action gets before it's
 *  inserted — "low" skips repair entirely (nothing to re-check when no human gate
 *  applies), "medium" gets Phase 7's single repair pass, "high" additionally
 *  generates and scores a second candidate before repair. */
export type ReasoningTier = "low" | "medium" | "high";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** B2.T2: an explicitly non-mutating forecast produced before an action reaches the
 * confirmation gate. It is a prediction, never evidence that an effect happened. */
export interface SimulationResult {
  mode: "schema" | "dry_run";
  summary: string;
  predicted: Record<string, unknown>;
}

export interface DraftAction {
  actionType: string;
  /** Plain-language summary shown in the Confirmation Queue. Never a stack trace. */
  summary: string;
  payload: Record<string, unknown>;
  requiresConfirmation: boolean;
  /** §2.4: stamped onto the draft by the executor (GatedExecutor/graph nodes) right
   *  after plugin.draft() returns, from the originating DomainAction/TenantContext —
   *  finishes the Phase-16(e) correlationId thread into any submitCommand() call a
   *  plugin's execute() makes. Plugins never set this themselves. */
  correlationId?: string;
  /** §3.6: mirrors DomainAction.approvedBy — stamped by GatedExecutor/graph nodes
   *  alongside correlationId, right after plugin.draft() returns, so any
   *  submitCommand() a plugin's own execute() calls can cite requestedBy. */
  approvedBy?: string;
  /** Durable worker-stamped authorization provenance for child workflow commands. */
  authorityDecisionId?: string;
  authorityRevision?: number;
  /** B2.T6: executor-stamped provenance for an async workflow command. */
  domainActionId?: string;
  /** Executor-compiled trusted contract; plugins may reference but never author it. */
  businessEffect?: import("./business-effects").BusinessEffectSet;
}

export type ExecutionStatus =
  | "success"
  | "failure"
  | "not_implemented"
  | "integration_unavailable";

export interface ExecutionResult {
  status: ExecutionStatus;
  output: Record<string, unknown>;
  /** Plain-language error, safe to show a dealer owner. */
  error?: string;
  /** What the executor expected to happen — Reflection compares this to observed outcome. */
  expected?: Record<string, unknown>;
  /** A4.T1: classifies a non-success outcome so Reflection can decide retry-vs-escalate
   *  by KIND, not by blindly retrying every failure once. A plugin (or a thrown
   *  IntegrationError caught in runtime-bridge.ts) may set this directly; otherwise
   *  runtime-bridge's classifyFailure() derives one from `status` before this result is
   *  returned. Undefined only for a `status: "success"` result, which Reflection never
   *  inspects this field for. */
  errorKind?: ErrorKind;
}

export type ReflectionDecision = "accept" | "retry" | "escalate";

export interface ReflectionOutcome {
  matched: boolean;
  decision: ReflectionDecision;
  detail: string;
}

// Retrieval-based pattern context (Phase 9) — real, queryable historical signals fed
// to the planner as soft context, never a source of new facts to invent into a
// payload. Call this "pattern context" or "retrieval" everywhere, never "learning":
// nothing here is fine-tuned or trained, it's a live aggregate query over existing
// rows, same honesty standard as every other memory source in this file.
// Phase 12 (loop closure) — undigested scan_findings surfaced as soft context, same
// honesty rule as the rest of this interface: informs the planner, never instructs it.
export interface ScanSignal {
  scanType: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  ageHours: number;
}

export interface PatternContext {
  scanSignals: ScanSignal[]; // tenant-wide, newest 10, [] if none open
}

export interface MemorySnapshot {
  shortTerm: Record<string, unknown> | null;
  longTerm: Record<string, unknown> | null;
  semantic: Array<{
    id?: string;
    chunk: string;
    sourceDocId: string | null;
    similarity: number;
    relevanceScore?: number;
    sourceKind?: string;
    occurredAt?: string;
    entityRefs?: unknown[];
    provenance?: Record<string, unknown>;
  }>;
  episodic: Array<Record<string, unknown>>;
  patterns: PatternContext | null;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "dead_letter" | "quarantined";

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
}

/** Literal marker for values that require real-world input. Never a guess. */
export const PLACEHOLDER_NEEDS_REAL_VALUE = "PLACEHOLDER_NEEDS_REAL_VALUE";

// ---------------------------------------------------------------------------
// Phase 2 (JARVIS 95% MAESTRO PACK §0.3.2, §2.2): the one error taxonomy every retry
// path keys off. Existing call sites (e.g. packages/tools/src/errors.ts's
// IntegrationError) extend this rather than re-declaring their own — a string-matched
// error kind is exactly the failure mode this type exists to rule out.
// ---------------------------------------------------------------------------
// A4.T1: added `needs_human` (the system worked correctly but hit a business
// decision only a person can make — distinct from `auth`/`validation`, which are
// system-detected defects) and `config` (the system correctly refused to proceed
// because of its OWN configuration/policy state — e.g. a budget cap or a missing
// setting — never a provider or a data problem; see B5's "honest CONFIG receipt"
// precedent in the plan). The original 6 kinds are unchanged — this only fills the
// two gaps the plan's RETRYABLE|TERMINAL|NEEDS_HUMAN|CONFIG list named that this
// finer-grained taxonomy didn't already cover.
export type ErrorKind = "retryable" | "terminal" | "conflict" | "auth" | "validation" | "provider_down" | "needs_human" | "config" | "unknown_outcome";

export interface TypedError {
  kind: ErrorKind;
  cause: string;
  context?: Record<string, unknown>;
}

// Versioned event envelope (§2.2): every inbox/outbox message is one of these. A
// consumer that doesn't recognize `version`'s major rejects the envelope into
// dead_letters instead of guessing at an unknown payload shape (see
// packages/workflow-runtime/src/envelope.ts for the runtime check).
export interface EventEnvelope<TPayload = Record<string, unknown>> {
  type: string;
  version: number;
  tenantId: string;
  occurredAt: string;
  payload: TPayload;
}

/** One piece of evidence a DecisionReceipt cites — a real row/call this decision relied
 *  on, never an invented justification. */
export interface ReceiptEvidence {
  source: string;
  ref: string;
  timestamp: string;
}

export interface ReceiptApproval {
  required: boolean;
  approvedBy?: string;
  at?: string;
}

export interface ReceiptFailure {
  errorKind: ErrorKind;
  message: string;
  recoveryPath: string;
}

/** Phase 2 (§2.2): the record every executed action must be queryable as — "what did I
 *  intend, what evidence did I use, what policy allowed it, who approved it, what
 *  actually happened, how do we recover" in one row. Created at proposal time
 *  (expectedResult/actualResult null, finalizedAt null), finalized in place at
 *  completion — never a second row per retry. */
export interface DecisionReceipt {
  id: string;
  tenantId: string;
  objective: string;
  evidence: ReceiptEvidence[];
  policyApplied: { id: string; version: number } | null;
  riskTier: "low" | "medium" | "high";
  proposedAction: Record<string, unknown>;
  approval: ReceiptApproval;
  expectedResult: Record<string, unknown> | null;
  actualResult: Record<string, unknown> | null;
  failure: ReceiptFailure | null;
  correlationId: string | null;
  workflowRunId: string | null;
  stepId: string | null;
  createdAt: string;
  finalizedAt: string | null;
  businessEffectId?: string | null;
  intendedEffectHash?: string | null;
  authorizedEffectHash?: string | null;
  executedEffectHash?: string | null;
  verification?: import("./business-effects").BusinessEffectVerification | null;
  recoveryEffectId?: string | null;
}
