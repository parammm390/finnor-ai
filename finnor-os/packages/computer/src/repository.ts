import { createHash } from "node:crypto";
import {
  actionLog,
  businessEffects,
  computerArtifacts,
  computerRuns,
  computerSteps,
  domainActions,
  jobs,
  reconciliationCases,
  ingestIntegrationEventTx,
  reconcileWorkStatus,
  tenantSettings,
  withTenant,
  workObjectiveSteps,
} from "@finnor/db";
import { resolveComputerAuthProfile, type ResolvedComputerAuthProfile } from "@finnor/security";
import type {
  ComputerArtifactView,
  ComputerRunLimits,
  ComputerRunStatus,
  ComputerRunView,
  ComputerStepView,
  ComputerTaskInput,
} from "@finnor/shared-types";
import type { ToolRuntimeContext } from "@finnor/tools";
import { finalizeLatestReceiptForAction } from "@finnor/workflow-runtime";
import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import { deriveComputerOriginPolicy } from "./origins";
import { assertNoComputerSecrets, redactComputerValue } from "./redaction";
import type { ComputerProviderSession, ComputerRunTerminal } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL: readonly ComputerRunStatus[] = ["succeeded", "blocked", "failed", "timed_out", "cancelled"];

type ComputerRunRow = typeof computerRuns.$inferSelect;
type ComputerStepRow = typeof computerSteps.$inferSelect;
type ComputerArtifactRow = typeof computerArtifacts.$inferSelect;

export interface QueuedComputerRun {
  run: ComputerRunView;
  created: boolean;
}

export interface ComputerRunInternal extends ComputerRunRow {
  taskInput: ComputerTaskInput;
}

export interface ComputerRunBundle {
  run: ComputerRunView;
  steps: ComputerStepView[];
  artifacts: ComputerArtifactView[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(",")}}`;
}

function int(value: unknown, fallback: number, min: number, maxValue: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), maxValue) : fallback;
}

function limitsFromConfig(value: unknown): ComputerRunLimits & { enabled: boolean; provider: string } {
  const config = record(value);
  return {
    enabled: config.enabled === true,
    provider: typeof config.provider === "string" ? config.provider : "steel",
    maxSteps: int(config.maxSteps, 30, 1, 100),
    timeoutMs: int(config.timeoutMs, 300_000, 10_000, 1_800_000),
    maxProviderCredits: int(config.maxProviderCredits, 10, 1, 10_000),
    maxScreenshots: int(config.maxScreenshots, 10, 0, 100),
    maxArtifacts: int(config.maxArtifacts, 20, 1, 200),
    // The artifact table has the same 10 MiB hard ceiling. Clamp configuration at
    // the durable boundary so a tenant cannot authorize bytes the database refuses.
    maxDownloadBytes: int(config.maxDownloadBytes, 10_485_760, 0, 10_485_760),
    maxUploadBytes: int(config.maxUploadBytes, 0, 0, 10_485_760),
    maxOutputBytes: int(config.maxOutputBytes, 131_072, 1_024, 1_048_576),
  };
}

function taskInput(row: ComputerRunRow): ComputerTaskInput {
  return {
    application: row.application,
    authProfileRef: row.authProfileRef,
    task: row.task,
    target: row.target as ComputerTaskInput["target"],
    mode: row.mode as ComputerTaskInput["mode"],
    successCriteria: Array.isArray(record(row.result)._successCriteria)
      ? record(row.result)._successCriteria as string[]
      : [],
    ...(row.authorizedEffect ? { authorizedEffect: row.authorizedEffect as ComputerTaskInput["authorizedEffect"] } : {}),
  };
}

function runView(row: ComputerRunRow): ComputerRunView {
  return {
    id: row.id,
    domainActionId: row.domainActionId,
    workId: row.workId ?? null,
    objectiveLoopId: row.objectiveLoopId ?? null,
    actorId: row.actorId,
    application: row.application,
    authProfileRef: row.authProfileRef,
    provider: row.provider,
    status: row.status as ComputerRunStatus,
    mode: row.mode as ComputerTaskInput["mode"],
    task: row.task,
    target: row.target as ComputerTaskInput["target"],
    limits: row.limits as unknown as ComputerRunLimits,
    result: row.result ? record(row.result) : null,
    failureCode: row.failureCode ?? null,
    blockReason: row.blockReason ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stepView(row: ComputerStepRow): ComputerStepView {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    phase: row.phase as ComputerRunStatus,
    operation: row.operation,
    status: row.status as ComputerStepView["status"],
    summary: row.summary,
    pageUrl: row.pageUrl ?? null,
    detail: record(row.detail),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function artifactView(row: ComputerArtifactRow): ComputerArtifactView {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId ?? null,
    kind: row.kind as ComputerArtifactView["kind"],
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    metadata: record(row.metadata),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Queue boundary called by computer_task after the normal action approval gate. It
 * resolves the governed profile before any session exists and atomically creates the
 * run plus persistent worker job. */
export async function queueComputerRun(
  input: ComputerTaskInput,
  runtime: Readonly<ToolRuntimeContext> | undefined,
): Promise<QueuedComputerRun> {
  const tenantId = runtime?.tenantId;
  const domainActionId = runtime?.domainActionId;
  const actorId = runtime?.actorId;
  if (!tenantId || !domainActionId || !actorId || !UUID.test(actorId)) {
    throw new Error("Computer execution requires a canonical tenant, DomainAction, and employee actor");
  }
  const loaded = await withTenant(tenantId, async (db) => {
    const [action] = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, domainActionId))).limit(1);
    const [settings] = await db.select({ computerConfig: tenantSettings.computerConfig }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
    let objectiveLoopId: string | null = null;
    if (action?.objectiveStepId) {
      const [step] = await db.select({ objectiveLoopId: workObjectiveSteps.objectiveLoopId }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, action.objectiveStepId))).limit(1);
      objectiveLoopId = step?.objectiveLoopId ?? null;
    }
    return { action, settings, objectiveLoopId };
  }, actorId);
  if (!loaded.action || loaded.action.actionType !== "computer_task" || loaded.action.status !== "executing") {
    throw new Error("Computer execution refused: the audited action is not executing");
  }
  if (loaded.action.initiatedBy !== actorId) throw new Error("Computer execution actor does not match the originating DomainAction");
  if (canonical(record(loaded.action.payload)) !== canonical(input)) {
    throw new Error("Computer execution input does not match the immutable DomainAction task envelope");
  }
  let governedEffect: typeof businessEffects.$inferSelect | null = null;
  if (input.mode === "WRITE") {
    if (!loaded.action.businessEffectId) {
      throw new Error("Computer WRITE refused: no exact frozen Business Effect is bound to the action runtime");
    }
    const [foundEffect] = await withTenant(tenantId, (db) => db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, loaded.action!.businessEffectId!))).limit(1), actorId);
    governedEffect = foundEffect ?? null;
    if (!governedEffect || !["authorized", "executing"].includes(governedEffect.status)) {
      throw new Error("Computer WRITE refused: Business Effect authorization is missing, stale, or mismatched");
    }
    // Runtime refs are a second anti-confusion assertion when the normal scoped tool
    // path supplies them. The immutable DomainAction -> BusinessEffect edge remains
    // the canonical source for crash recovery and direct durable-queue callers.
    if ((runtime?.businessEffectId || runtime?.businessEffectHash)
      && (runtime.businessEffectId !== governedEffect.id || runtime.businessEffectHash !== governedEffect.semanticHash)) {
      throw new Error("Computer WRITE refused: runtime Business Effect does not match the canonical action effect");
    }
  }
  const config = limitsFromConfig(loaded.settings?.computerConfig);
  if (!config.enabled) throw new Error("Computer execution is disabled for this tenant");
  if (config.provider !== "steel") throw new Error("The configured computer provider is unavailable in Phase 3");

  const access = await resolveComputerAuthProfile(tenantId, actorId, input.application, "computer_task", input.authProfileRef);
  const origins = deriveComputerOriginPolicy(access.accountMetadata, access.restrictions);
  const limits: ComputerRunLimits = {
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    maxProviderCredits: config.maxProviderCredits,
    maxScreenshots: config.maxScreenshots,
    maxArtifacts: config.maxArtifacts,
    maxDownloadBytes: config.maxDownloadBytes,
    maxUploadBytes: config.maxUploadBytes,
    maxOutputBytes: config.maxOutputBytes,
  };
  const safeEnvelope = { task: input.task, target: input.target, authorizedEffect: input.authorizedEffect ?? null, limits };
  assertNoComputerSecrets(safeEnvelope);

  return withTenant(tenantId, async (db) => {
    const [existing] = await db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.domainActionId, domainActionId))).limit(1);
    if (existing) return { run: runView(existing), created: false };
    const [created] = await db.insert(computerRuns).values({
      tenantId,
      domainActionId,
      businessEffectId: governedEffect?.id ?? null,
      workId: loaded.action!.workId,
      objectiveLoopId: loaded.objectiveLoopId,
      actorId,
      applicationAccountId: access.applicationAccountId,
      authProfileId: access.profileId,
      authProfileRef: access.authProfileRef,
      application: access.application,
      provider: config.provider,
      status: "queued",
      mode: input.mode,
      task: input.task,
      target: input.target,
      authorizedEffect: input.authorizedEffect ?? null,
      allowedOrigins: [...origins.allowedOrigins],
      authOrigins: [...origins.authOrigins],
      limits,
      deadlineAt: new Date(Date.now() + limits.timeoutMs),
      lastHeartbeatAt: new Date(),
      // Criteria are not a result; storing them temporarily here would make a queued
      // run look successful. The worker reloads them from the immutable action payload.
      result: null,
      effectStatus: input.mode === "WRITE" ? "pending" : "none",
    }).onConflictDoNothing({ target: computerRuns.domainActionId }).returning();
    if (!created) {
      const [raced] = await db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.domainActionId, domainActionId))).limit(1);
      if (!raced) throw new Error("Computer run could not be created");
      return { run: runView(raced), created: false };
    }
    await db.insert(computerSteps).values({
      tenantId, runId: created.id, seq: 1, phase: "queued", operation: "queue",
      status: "succeeded", summary: "Queued governed computer task", detail: {}, completedAt: new Date(),
    });
    await db.insert(jobs).values({
      tenantId,
      type: "run_computer_task",
      payload: { tenantId, runId: created.id },
      idempotencyKey: `computer-run:${created.id}`,
      lane: "interactive",
      priority: 50,
      maxAttempts: 5,
    }).onConflictDoNothing({ target: jobs.idempotencyKey });
    return { run: runView(created), created: true };
  }, actorId);
}

export async function resolveComputerRunAuth(run: ComputerRunInternal): Promise<ResolvedComputerAuthProfile> {
  return resolveComputerAuthProfile(run.tenantId, run.actorId, run.application, "computer_task", run.authProfileRef);
}

export async function getComputerRunInternal(tenantId: string, runId: string): Promise<ComputerRunInternal | null> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))).limit(1));
  if (!row) return null;
  const [action] = await withTenant(tenantId, (db) => db.select({ payload: domainActions.payload }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, row.domainActionId))).limit(1));
  const payload = record(action?.payload);
  return {
    ...row,
    taskInput: {
      ...taskInput(row),
      successCriteria: Array.isArray(payload.successCriteria) ? payload.successCriteria.filter((item): item is string => typeof item === "string") : [],
    },
  };
}

export async function getComputerRunBundle(tenantId: string, runId: string): Promise<ComputerRunBundle | null> {
  return withTenant(tenantId, async (db) => {
    const [run] = await db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))).limit(1);
    if (!run) return null;
    const steps = await db.select().from(computerSteps).where(and(eq(computerSteps.tenantId, tenantId), eq(computerSteps.runId, runId))).orderBy(asc(computerSteps.seq));
    const artifacts = await db.select().from(computerArtifacts).where(and(eq(computerArtifacts.tenantId, tenantId), eq(computerArtifacts.runId, runId))).orderBy(asc(computerArtifacts.createdAt));
    return { run: runView(run), steps: steps.map(stepView), artifacts: artifacts.map(artifactView) };
  });
}

export async function listActiveComputerRuns(tenantId: string, limit = 20): Promise<ComputerRunView[]> {
  const rows = await withTenant(tenantId, (db) => db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), sql`${computerRuns.status} NOT IN ('succeeded','blocked','failed','timed_out','cancelled')`)).orderBy(desc(computerRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 100)));
  return rows.map(runView);
}

export async function transitionComputerRun(
  tenantId: string,
  runId: string,
  status: ComputerRunStatus,
  patch: Partial<Pick<ComputerRunRow, "providerSessionRef" | "result" | "failureCode" | "blockReason" | "effectStatus" | "effectOperationKey">> = {},
): Promise<ComputerRunInternal> {
  const terminal = TERMINAL.includes(status);
  const [row] = await withTenant(tenantId, (db) => db.update(computerRuns).set({
    status,
    ...patch,
    ...(status === "authorizing" ? { startedAt: new Date() } : {}),
    ...(terminal ? { finishedAt: new Date() } : {}),
    ...(!terminal ? { lastHeartbeatAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))).returning());
  if (!row) throw new Error("Computer run not found");
  // successCriteria live in the immutable DomainAction payload. Always reload the
  // complete task envelope after a transition instead of silently dropping them.
  const reloaded = await getComputerRunInternal(tenantId, runId);
  if (!reloaded) throw new Error("Computer run disappeared after transition");
  return reloaded;
}

export async function persistComputerSession(tenantId: string, runId: string, session: ComputerProviderSession): Promise<void> {
  await withTenant(tenantId, (db) => db.update(computerRuns).set({ providerSessionRef: session.sessionRef, lastHeartbeatAt: new Date(), updatedAt: new Date() }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))));
}

export async function markComputerSessionReleased(tenantId: string, runId: string): Promise<void> {
  await withTenant(tenantId, (db) => db.update(computerRuns).set({ providerSessionRef: null, sessionReleasedAt: new Date(), cleanupAttemptedAt: new Date(), cleanupFailureCode: null, updatedAt: new Date() }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))));
}

export async function markComputerSessionCleanupFailed(tenantId: string, runId: string, code = "provider_cleanup_failed"): Promise<void> {
  await withTenant(tenantId, (db) => db.update(computerRuns).set({ cleanupAttemptedAt: new Date(), cleanupFailureCode: code.slice(0, 120), updatedAt: new Date() }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))));
}

export async function beginComputerStep(params: {
  tenantId: string;
  runId: string;
  phase: ComputerRunStatus;
  operation: string;
  summary: string;
  pageUrl?: string;
  detail?: Record<string, unknown>;
  effectCandidateHash?: string;
  authorityDecisionId?: string;
}): Promise<ComputerStepRow> {
  const detail = redactComputerValue(params.detail ?? {}) as Record<string, unknown>;
  assertNoComputerSecrets(detail);
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${computerRuns} WHERE ${computerRuns.tenantId}=${params.tenantId} AND ${computerRuns.id}=${params.runId} FOR UPDATE`);
    const [latest] = await db.select({ value: max(computerSteps.seq) }).from(computerSteps).where(and(eq(computerSteps.tenantId, params.tenantId), eq(computerSteps.runId, params.runId)));
    const [step] = await db.insert(computerSteps).values({
      tenantId: params.tenantId,
      runId: params.runId,
      seq: (latest?.value ?? 0) + 1,
      phase: params.phase,
      operation: params.operation.slice(0, 120),
      status: "started",
      summary: params.summary.slice(0, 1000),
      pageUrl: params.pageUrl,
      detail,
      effectCandidateHash: params.effectCandidateHash,
      authorityDecisionId: params.authorityDecisionId,
    }).returning();
    if (!step) throw new Error("Computer step could not be persisted");
    return step;
  });
}

export async function finishComputerStep(
  tenantId: string,
  stepId: string,
  status: "succeeded" | "blocked" | "failed",
  detail: Record<string, unknown> = {},
  pageUrl?: string,
): Promise<void> {
  const safeDetail = redactComputerValue(detail) as Record<string, unknown>;
  assertNoComputerSecrets(safeDetail);
  await withTenant(tenantId, (db) => db.update(computerSteps).set({ status, detail: safeDetail, ...(pageUrl ? { pageUrl } : {}), completedAt: new Date() }).where(and(eq(computerSteps.tenantId, tenantId), eq(computerSteps.id, stepId), eq(computerSteps.status, "started"))));
}

export async function persistComputerArtifact(params: {
  tenantId: string;
  runId: string;
  stepId?: string;
  kind: ComputerArtifactView["kind"];
  mimeType: string;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}): Promise<ComputerArtifactView> {
  const metadata = redactComputerValue(params.metadata ?? {}) as Record<string, unknown>;
  assertNoComputerSecrets(metadata);
  const [row] = await withTenant(params.tenantId, (db) => db.insert(computerArtifacts).values({
    tenantId: params.tenantId,
    runId: params.runId,
    stepId: params.stepId,
    kind: params.kind,
    mimeType: params.mimeType.slice(0, 200),
    sizeBytes: params.bytes.byteLength,
    sha256: createHash("sha256").update(params.bytes).digest("hex"),
    content: Buffer.from(params.bytes),
    metadata,
  }).returning());
  if (!row) throw new Error("Computer artifact could not be persisted");
  return artifactView(row);
}

export async function requestComputerCancellation(tenantId: string, runId: string): Promise<ComputerRunView | null> {
  const [row] = await withTenant(tenantId, (db) => db.update(computerRuns).set({ cancellationRequestedAt: new Date(), updatedAt: new Date() }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId), sql`${computerRuns.status} NOT IN ('succeeded','blocked','failed','timed_out','cancelled')`)).returning());
  return row ? runView(row) : null;
}

export async function computerCancellationRequested(tenantId: string, runId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (db) => db.select({ cancellationRequestedAt: computerRuns.cancellationRequestedAt }).from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))).limit(1));
  return Boolean(row?.cancellationRequestedAt);
}

export async function finalizeComputerRun(tenantId: string, runId: string, terminal: ComputerRunTerminal): Promise<void> {
  const current = await getComputerRunInternal(tenantId, runId);
  if (!current || TERMINAL.includes(current.status as ComputerRunStatus)) return;
  const safeResult = terminal.status === "succeeded" ? redactComputerValue(terminal.result) as Record<string, unknown> : null;
  if (safeResult) assertNoComputerSecrets(safeResult);
  const finalized = await withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 904))`);
    await db.execute(sql`SELECT id FROM ${computerRuns} WHERE ${computerRuns.tenantId}=${tenantId} AND ${computerRuns.id}=${runId} FOR UPDATE`);
    const [locked] = await db.select().from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId))).limit(1);
    if (!locked || TERMINAL.includes(locked.status as ComputerRunStatus)) return null;
    await db.update(computerRuns).set({
      status: terminal.status,
      result: safeResult,
      failureCode: terminal.status === "succeeded" ? null : terminal.code,
      blockReason: terminal.status === "succeeded" ? null : terminal.reason.slice(0, 2000),
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.id, runId), sql`${computerRuns.status} NOT IN ('succeeded','blocked','failed','timed_out','cancelled')`));
    const actionStatus = terminal.status === "succeeded" ? "completed" : terminal.status === "blocked" ? "needs_human_review" : "failed";
    await db.update(domainActions).set({ status: actionStatus, executionStartedAt: null }).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, locked.domainActionId)));
    await db.insert(actionLog).values({
      tenantId,
      domainActionId: locked.domainActionId,
      step: "computer_terminal",
      input: { runId },
      output: terminal.status === "succeeded"
        ? { status: terminal.status, result: safeResult }
        : { status: terminal.status, code: terminal.code, reason: terminal.reason.slice(0, 1000) },
    });
    await ingestIntegrationEventTx(db, {
      tenantId,
      source: "computer_runtime",
      provider: locked.provider,
      sourceEventId: `computer-run:${locked.id}:terminal`,
      eventType: "computer.run.terminal",
      occurredAt: new Date(),
      party: { type: "employee", id: locked.actorId },
      resource: { type: "computer_run", id: locked.id },
      workId: locked.workId,
      computerRunId: locked.id,
      domainActionId: locked.domainActionId,
      applicationRef: locked.application,
      correlationId: locked.workId ?? locked.id,
      payload: terminal.status === "succeeded"
        ? { status: terminal.status, resultAvailable: safeResult !== null }
        : { status: terminal.status, failureCode: terminal.code, blockReason: terminal.reason.slice(0, 1000) },
      evidenceRefs: [{ type: "computer_run", id: locked.id }],
      trustClass: "trusted_runtime",
    });
    if (locked.businessEffectId) {
      const [effectRow] = await db.select({ semanticHash: businessEffects.semanticHash }).from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, locked.businessEffectId))).limit(1);
      const unknown = locked.effectStatus === "unknown" || terminal.status === "timed_out";
      const verified = terminal.status === "succeeded" && locked.effectStatus === "succeeded";
      const verification = {
        state: verified ? "verified" as const : unknown ? "reconciliation_required" as const : "unverified" as const,
        basis: verified ? "Computer runtime re-observed the exact authorized effect" : unknown ? "Computer effect outcome is unknown and requires reconciliation" : `Computer run ended ${terminal.status}`,
        checkedAt: new Date().toISOString(),
        observed: terminal.status === "succeeded" ? safeResult ?? {} : { status: terminal.status, code: terminal.code },
      };
      await db.update(businessEffects).set({ status: verified ? "verified" : unknown ? "reconciliation_required" : "failed", observedResult: verification.observed, verification, observedAt: new Date() }).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, locked.businessEffectId)));
      if (unknown) {
        const [existingCase] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, tenantId), eq(reconciliationCases.businessEffectId, locked.businessEffectId), eq(reconciliationCases.status, "open"))).limit(1);
        if (!existingCase) await db.insert(reconciliationCases).values({ tenantId, businessEffectId: locked.businessEffectId, caseType: "unknown_delivery", details: { computerRunId: locked.id, domainActionId: locked.domainActionId, effectStatus: locked.effectStatus } });
      }
      return { workId: locked.workId, domainActionId: locked.domainActionId, effectStatus: locked.effectStatus, businessEffectId: locked.businessEffectId, effectHash: effectRow?.semanticHash ?? null, verification };
    }
    return { workId: locked.workId, domainActionId: locked.domainActionId, effectStatus: locked.effectStatus, businessEffectId: null, effectHash: null, verification: null };
  }, current.actorId);
  if (finalized) {
    const evidence = [{ source: "computer_run", ref: runId, timestamp: new Date().toISOString() }];
    await finalizeLatestReceiptForAction(
      tenantId,
      finalized.domainActionId,
      terminal.status === "succeeded"
        ? { actualResult: { status: terminal.status, computerRunId: runId, result: safeResult }, evidence, executedEffectHash: finalized.effectHash ?? undefined, effectVerification: finalized.verification ?? undefined }
        : { failure: {
            errorKind: finalized.effectStatus === "unknown" || terminal.status === "timed_out" ? "unknown_outcome" : terminal.status === "blocked" ? "needs_human" : "terminal",
            message: terminal.reason.slice(0, 2_000),
            recoveryPath: finalized.effectStatus === "unknown" || terminal.status === "timed_out"
              ? "Reconcile the external application state before authorizing another attempt."
              : terminal.status === "blocked"
                ? "Resolve the recorded computer block and obtain any required authority before another attempt."
                : "Review the durable computer evidence before choosing a legal recovery transition.",
          }, evidence, executedEffectHash: finalized.effectHash ?? undefined, effectVerification: finalized.verification ?? undefined },
    ).catch((error) => console.error(`[decision_receipts] failed to settle computer receipt for run ${runId}`, error));
    if (finalized.workId) await reconcileWorkStatus(tenantId, finalized.workId);
  }
}

export async function countComputerArtifacts(tenantId: string, runId: string): Promise<{ total: number; screenshots: number }> {
  const rows = await withTenant(tenantId, (db) => db.select({ kind: computerArtifacts.kind }).from(computerArtifacts).where(and(eq(computerArtifacts.tenantId, tenantId), eq(computerArtifacts.runId, runId))));
  return { total: rows.length, screenshots: rows.filter((row) => row.kind === "screenshot").length };
}

export async function recoverComputerRunJobs(tenantId: string): Promise<{ queued: number; orphanSessions: Array<{ runId: string; sessionRef: string }> }> {
  const expired = await withTenant(tenantId, (db) => db.select({ id: computerRuns.id }).from(computerRuns).where(and(
    eq(computerRuns.tenantId, tenantId),
    sql`${computerRuns.status} NOT IN ('succeeded','blocked','failed','timed_out','cancelled')`,
    sql`coalesce(${computerRuns.deadlineAt},${computerRuns.createdAt}+(coalesce((${computerRuns.limits}->>'timeoutMs')::integer,300000)||' milliseconds')::interval)<=now()`,
  )));
  for (const run of expired) {
    await finalizeComputerRun(tenantId, run.id, { status: "timed_out", code: "hard_deadline", reason: "Computer run exceeded its durable hard deadline during worker recovery" });
  }
  return withTenant(tenantId, async (db) => {
    const active = await db.select().from(computerRuns).where(and(
      eq(computerRuns.tenantId, tenantId),
      sql`${computerRuns.status} NOT IN ('succeeded','blocked','failed','timed_out','cancelled')`,
    ));
    let queued = 0;
    for (const run of active) {
      // Serialize competing recovery scans for this run before checking/inserting.
      await db.execute(sql`SELECT id FROM ${computerRuns} WHERE ${computerRuns.tenantId}=${tenantId} AND ${computerRuns.id}=${run.id} FOR UPDATE`);
      const [pending] = await db.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.type, "run_computer_task"),
        sql`${jobs.payload}->>'runId'=${run.id}`,
        sql`${jobs.status} IN ('queued','running')`,
      )).limit(1);
      if (pending) continue;
      await db.insert(jobs).values({
        tenantId,
        type: "run_computer_task",
        payload: { tenantId, runId: run.id, recovery: true },
        // A completed recovery job must not suppress a later repair attempt. The
        // row lock above prevents concurrent scans from creating duplicates.
        idempotencyKey: `computer-recovery:${run.id}:${Date.now()}`,
        lane: "interactive",
        priority: 50,
        maxAttempts: 5,
      });
      queued += 1;
    }
    const orphanRows = await db.select({ runId: computerRuns.id, sessionRef: computerRuns.providerSessionRef }).from(computerRuns).where(and(
      eq(computerRuns.tenantId, tenantId),
      sql`${computerRuns.status} IN ('succeeded','blocked','failed','timed_out','cancelled')`,
      sql`${computerRuns.providerSessionRef} IS NOT NULL`,
    ));
    return {
      queued,
      // This credential-sensitive list is worker-internal and must never be used as
      // an API/activity projection.
      orphanSessions: orphanRows.flatMap((row) => row.sessionRef ? [{ runId: row.runId, sessionRef: row.sessionRef }] : []),
    };
  });
}
