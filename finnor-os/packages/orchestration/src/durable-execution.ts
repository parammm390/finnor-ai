// Persistent-worker execution of one immutable Business Effect. The API-side half of
// this contract lives in runtime-bridge.ts; no consequential plugin call belongs in
// an approval request after authorization commits.

import {
  actionLog,
  businessEffects,
  commands,
  domainActions,
  domainPolicyRevisions,
  integrationOperations,
  reconcileWorkStatus,
  transitionWork,
  withTenant,
  workflowRuns,
  workflowSteps,
} from "@finnor/db";
import { revalidateActionExecution } from "@finnor/authority";
import {
  ScopedToolRegistry,
  createDefaultRegistry,
  type ToolRegistry,
} from "@finnor/tools";
import {
  advanceWorkflow,
  awaitStepObservation,
  completeStep,
  failStep,
  openReconciliationCase,
} from "@finnor/workflow-runtime";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { BusinessEffectSet, DomainAction, DraftAction, ExecutionResult, ErrorKind } from "@finnor/shared-types";
import { createDefaultPluginRegistry } from "./plugin-registry";
import {
  BusinessEffectBoundaryError,
  recordBusinessEffectOutcome,
  verifyBusinessEffectPreconditions,
} from "./compiler";
import { classifyExecutionFailure } from "./runtime-bridge";
import { appendEpisode } from "@finnor/memory";
import { advanceWorkflowForActionRequired } from "./workflow";
import { emitInstructionEvent } from "./instruction-trace";
import { resumeObjectiveForAction } from "./objective-loop";
import { demoteAutonomyForWorkRegression, evaluateEffectAutonomy } from "./autonomy";
import { redactStructured, redactText } from "@finnor/security";

class DurableExecutionBlocked extends Error {
  constructor(readonly reason: string, readonly afterPossibleEffect = false) {
    super(reason);
    this.name = "DurableExecutionBlocked";
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Persist business evidence without leaking contact fields, while retaining opaque
 * canonical/provider identifiers required by later DAG steps and reconciliation.
 * An `...Id` value is an operational key, not the customer data behind that key. */
function redactExecutionOutput<T>(value: T): T {
  const redacted = redactStructured(value);
  const restoreOpaqueIds = (original: unknown, safe: unknown): unknown => {
    if (Array.isArray(original) && Array.isArray(safe)) return original.map((entry, index) => restoreOpaqueIds(entry, safe[index]));
    if (original && safe && typeof original === "object" && typeof safe === "object") {
      return Object.fromEntries(Object.entries(original as Record<string, unknown>).map(([key, entry]) => {
        const safeEntry = (safe as Record<string, unknown>)[key];
        if ((key === "id" || /Id$/.test(key)) && typeof entry === "string") return [key, entry];
        return [key, restoreOpaqueIds(entry, safeEntry)];
      }));
    }
    return safe;
  };
  return restoreOpaqueIds(value, redacted) as T;
}

async function assertMaterialPolicyStillValid(tenantId: string, effect: BusinessEffectSet): Promise<void> {
  if (!effect.authority.policyId || !effect.authority.policyVersion) return;
  const rows = await withTenant(tenantId, async (db) => {
    const [authorized] = await db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, tenantId),
      eq(domainPolicyRevisions.policyId, effect.authority.policyId!),
      eq(domainPolicyRevisions.version, effect.authority.policyVersion!),
    )).limit(1);
    const [current] = await db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, tenantId),
      eq(domainPolicyRevisions.policyId, effect.authority.policyId!),
      lte(domainPolicyRevisions.effectiveFrom, new Date()),
    )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)).limit(1);
    return { authorized, current };
  });
  if (!rows.authorized || !rows.current) throw new DurableExecutionBlocked("The authorized policy revision is no longer available");
  if (rows.authorized.version === rows.current.version) return;
  const material = stable(rows.authorized.policy) !== stable(rows.current.policy)
    || rows.authorized.requiresConfirmation !== rows.current.requiresConfirmation
    || rows.authorized.modelProvider !== rows.current.modelProvider;
  // Confirmation wording and timeout are deliberately not execution eligibility.
  if (material) throw new DurableExecutionBlocked("A material policy revision changed after authorization; renewed approval is required");
}

/** Revalidate the immutable authorization boundary immediately before a later child
 * workflow step mutates state. A parent worker may have authorized and dispatched the
 * child minutes earlier, so revocation, material policy drift, and stale canonical
 * preconditions must all be checked again at the child's own effect boundary. */
export async function revalidateAuthorizedEffectEligibility(
  tenantId: string,
  domainActionId: string,
  businessEffectId: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const [effectRow] = await withTenant(tenantId, (db) => db.select().from(businessEffects).where(and(
    eq(businessEffects.tenantId, tenantId),
    eq(businessEffects.id, businessEffectId),
    eq(businessEffects.domainActionId, domainActionId),
  )).limit(1));
  if (!effectRow) return { allowed: false, reason: "The authorized Business Effect is not tenant/action consistent" };
  const effect = effectRow.effect as BusinessEffectSet;
  if (effect.id !== effectRow.id || effect.semanticHash !== effectRow.semanticHash || effect.source.domainActionId !== domainActionId) {
    return { allowed: false, reason: "The persisted Business Effect no longer matches its immutable authorization identity" };
  }
  const authority = await revalidateActionExecution(tenantId, domainActionId);
  if (authority.outcome !== "allowed") return { allowed: false, reason: `Authority invalidated: ${authority.reasonCode}` };
  try {
    const { actionRow, humanApproval } = await withTenant(tenantId, async (db) => {
      const [row] = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, domainActionId))).limit(1);
      const [approval] = await db.select({ id: actionLog.id }).from(actionLog).where(and(eq(actionLog.tenantId, tenantId), eq(actionLog.domainActionId, domainActionId), eq(actionLog.step, "confirmed"))).limit(1);
      return { actionRow: row, humanApproval: approval };
    });
    if (!actionRow) throw new DurableExecutionBlocked("The authorized action disappeared before effect execution");
    const autonomy = await evaluateEffectAutonomy({
      action: {
        id: actionRow.id,
        tenantId: actionRow.tenantId,
        actionType: actionRow.actionType,
        payload: actionRow.payload as Record<string, unknown>,
        policyId: actionRow.policyId,
        policyVersion: actionRow.policyVersion,
        status: actionRow.status,
        createdAt: actionRow.createdAt.toISOString(),
        workId: actionRow.workId,
        plannerAttemptId: actionRow.plannerAttemptId,
        initiatedBy: actionRow.initiatedBy,
        authorityDecisionId: actionRow.authorityDecisionId,
        authorityRevision: actionRow.authorityRevision,
        authorityContext: actionRow.authorityContext as Record<string, unknown>,
        objectiveStepId: actionRow.objectiveStepId,
        businessEffectId: actionRow.businessEffectId,
      },
      effect,
      authority,
    });
    if (!humanApproval && autonomy.mode === "autopilot" && autonomy.outcome !== "autopilot_allowed") {
      throw new DurableExecutionBlocked(`Autopilot grant invalidated before effect execution: ${autonomy.reasonCodes.join(", ")}`);
    }
    await assertMaterialPolicyStillValid(tenantId, effect);
    await verifyBusinessEffectPreconditions(tenantId, effect);
    return { allowed: true };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : "Execution eligibility changed after authorization" };
  }
}

interface LoadedExecution {
  action: typeof domainActions.$inferSelect;
  effectRow: typeof businessEffects.$inferSelect;
  effect: BusinessEffectSet;
  command: typeof commands.$inferSelect;
  run: typeof workflowRuns.$inferSelect;
  step: typeof workflowSteps.$inferSelect;
}

async function loadExecution(tenantId: string, stepId: string): Promise<LoadedExecution> {
  const [loaded] = await withTenant(tenantId, (db) => db.select({
    action: domainActions,
    effectRow: businessEffects,
    command: commands,
    run: workflowRuns,
    step: workflowSteps,
  }).from(workflowSteps)
    .innerJoin(workflowRuns, and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, workflowSteps.workflowRunId)))
    .innerJoin(commands, and(eq(commands.tenantId, tenantId), eq(commands.id, workflowRuns.commandId)))
    .innerJoin(domainActions, and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, workflowSteps.domainActionId)))
    .innerJoin(businessEffects, and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, workflowSteps.businessEffectId)))
    .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId))).limit(1));
  if (!loaded) throw new DurableExecutionBlocked("The claimed step is not linked to a tenant-consistent action/effect command");
  const effect = loaded.effectRow.effect as BusinessEffectSet;
  const payload = loaded.step.payload as Record<string, unknown>;
  if (loaded.step.stepType !== "execute_authorized_effect"
      || loaded.command.authorizedEffectHash !== loaded.effectRow.semanticHash
      || payload.businessEffectHash !== loaded.effectRow.semanticHash
      || effect.semanticHash !== loaded.effectRow.semanticHash
      || effect.id !== loaded.effectRow.id
      || effect.source.domainActionId !== loaded.action.id
      || effect.source.actionType !== loaded.action.actionType) {
    throw new DurableExecutionBlocked("The durable command does not authorize this exact Business Effect");
  }
  return { ...loaded, effect };
}

type CommitClaim =
  | { kind: "execute" }
  | { kind: "replay"; result: ExecutionResult }
  | { kind: "reconcile"; reason: string };

/** Atomic effect commit point for generic plugin execution. A concurrent cancel must
 * either win before this transaction (and prevent mutation) or observe commit_started
 * and request reconciliation; there is no ambiguous approved-but-untracked window. */
async function beginEffectCommit(loaded: LoadedExecution): Promise<CommitClaim> {
  return withTenant(loaded.action.tenantId, async (db) => {
    const [current] = await db.select({
      stepStatus: workflowSteps.status,
      executionState: workflowSteps.executionState,
      runStatus: workflowRuns.status,
      commandStatus: commands.status,
      effectStatus: businessEffects.status,
      actionStatus: domainActions.status,
    }).from(workflowSteps)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowSteps.workflowRunId))
      .innerJoin(commands, eq(commands.id, workflowRuns.commandId))
      .innerJoin(domainActions, and(eq(domainActions.tenantId, loaded.action.tenantId), eq(domainActions.id, workflowSteps.domainActionId)))
      .innerJoin(businessEffects, and(eq(businessEffects.tenantId, loaded.action.tenantId), eq(businessEffects.id, workflowSteps.businessEffectId)))
      .where(and(eq(workflowSteps.tenantId, loaded.action.tenantId), eq(workflowSteps.id, loaded.step.id))).limit(1);
    if (!current || current.stepStatus !== "leased" || current.executionState !== "claimed"
        || current.runStatus !== "running" || current.commandStatus !== "running" || current.actionStatus !== "executing") {
      throw new DurableExecutionBlocked("Execution was cancelled, revoked, or no longer owns the durable claim");
    }

    const operationKey = `business-effect:${loaded.effect.semanticHash}`;
    const [inserted] = await db.insert(integrationOperations).values({
      tenantId: loaded.action.tenantId,
      workflowStepId: loaded.step.id,
      operationKey,
      capability: `action:${loaded.action.actionType}`,
      provider: "finnor_plugin_runtime",
      businessEffectId: loaded.effect.id,
      requestHash: loaded.effect.semanticHash,
      status: "running",
    }).onConflictDoNothing({ target: [integrationOperations.workflowStepId, integrationOperations.operationKey] }).returning();

    if (!inserted) {
      const [existing] = await db.select().from(integrationOperations).where(and(
        eq(integrationOperations.workflowStepId, loaded.step.id),
        eq(integrationOperations.operationKey, operationKey),
      )).limit(1);
      if (!existing || existing.requestHash !== loaded.effect.semanticHash || existing.businessEffectId !== loaded.effect.id) {
        throw new DurableExecutionBlocked("Semantic operation identity conflicts with the authorized effect", true);
      }
      if (existing.status === "succeeded") {
        return { kind: "replay", result: (existing.response ?? { status: "success", output: {} }) as unknown as ExecutionResult };
      }
      if (existing.status === "running" || existing.status === "unknown") {
        await db.update(workflowSteps).set({ executionState: "reconciling", leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(workflowSteps.tenantId, loaded.action.tenantId), eq(workflowSteps.id, loaded.step.id)));
        await db.update(businessEffects).set({ status: "reconciliation_required" })
          .where(and(eq(businessEffects.tenantId, loaded.action.tenantId), eq(businessEffects.id, loaded.effect.id)));
        await db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null })
          .where(and(eq(domainActions.tenantId, loaded.action.tenantId), eq(domainActions.id, loaded.action.id)));
        return { kind: "reconcile", reason: "A prior worker crossed the effect commit point without recording a result" };
      }
      const [reclaimed] = await db.update(integrationOperations).set({ status: "running", response: null, updatedAt: new Date() })
        .where(and(
          eq(integrationOperations.tenantId, loaded.action.tenantId),
          eq(integrationOperations.id, existing.id),
          eq(integrationOperations.status, "failed"),
        )).returning({ id: integrationOperations.id });
      if (!reclaimed) {
        // A concurrent retry won the only legal failed -> running transition.
        // This worker must not cross the provider boundary from a stale read.
        await db.update(workflowSteps).set({ executionState: "reconciling", leaseExpiresAt: null, updatedAt: new Date() })
          .where(and(eq(workflowSteps.tenantId, loaded.action.tenantId), eq(workflowSteps.id, loaded.step.id)));
        await db.update(businessEffects).set({ status: "reconciliation_required" })
          .where(and(eq(businessEffects.tenantId, loaded.action.tenantId), eq(businessEffects.id, loaded.effect.id)));
        await db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null })
          .where(and(eq(domainActions.tenantId, loaded.action.tenantId), eq(domainActions.id, loaded.action.id)));
        return { kind: "reconcile", reason: "Another worker won the failed operation retry; external outcome is unknown" };
      }
    }

    const [effectClaim] = await db.update(businessEffects).set({ status: "executing", executionStartedAt: new Date() })
      .where(and(
        eq(businessEffects.tenantId, loaded.action.tenantId),
        eq(businessEffects.id, loaded.effect.id),
        sql`${businessEffects.status} IN ('authorized','failed')`,
      )).returning({ id: businessEffects.id });
    if (!effectClaim && current.effectStatus !== "executing") {
      throw new DurableExecutionBlocked(`Business Effect is ${current.effectStatus}, not executable`, current.effectStatus === "reconciliation_required");
    }
    const [stepClaim] = await db.update(workflowSteps).set({ executionState: "commit_started", effectCommitAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(workflowSteps.tenantId, loaded.action.tenantId),
        eq(workflowSteps.id, loaded.step.id),
        eq(workflowSteps.status, "leased"),
        eq(workflowSteps.executionState, "claimed"),
      )).returning({ id: workflowSteps.id });
    if (!stepClaim) throw new DurableExecutionBlocked("Worker lost the step claim before the effect commit point");
    await db.insert(actionLog).values({
      tenantId: loaded.action.tenantId,
      domainActionId: loaded.action.id,
      step: "effect_commit_started",
      input: { workflowStepId: loaded.step.id, workerClaimed: true },
      output: { businessEffectId: loaded.effect.id, semanticHash: loaded.effect.semanticHash },
    });
    return { kind: "execute" };
  });
}

async function recordSemanticOperation(
  loaded: LoadedExecution,
  status: "succeeded" | "failed" | "unknown",
  result: ExecutionResult,
): Promise<void> {
  await withTenant(loaded.action.tenantId, (db) => db.update(integrationOperations).set({
    status,
    response: { status: result.status, output: result.output, expected: result.expected ?? null, error: result.error ?? null, errorKind: result.errorKind ?? null },
    providerAcknowledgedAt: status === "succeeded" && loaded.effect.operation.external ? new Date() : null,
    verificationStatus: status === "succeeded" && loaded.effect.operation.external ? "awaiting_observation"
      : status === "unknown" ? "unknown" : "not_required",
    updatedAt: new Date(),
  }).where(and(
    eq(integrationOperations.workflowStepId, loaded.step.id),
    eq(integrationOperations.operationKey, `business-effect:${loaded.effect.semanticHash}`),
  )));
}

async function blockBeforeEffect(loaded: LoadedExecution, reason: string): Promise<void> {
  await withTenant(loaded.action.tenantId, async (db) => {
    await db.update(workflowSteps).set({ status: "failed", executionState: "blocked", terminalReason: reason, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(workflowSteps.tenantId, loaded.action.tenantId), eq(workflowSteps.id, loaded.step.id), eq(workflowSteps.executionState, "claimed")));
    await db.update(businessEffects).set({ status: "cancelled" })
      .where(and(eq(businessEffects.tenantId, loaded.action.tenantId), eq(businessEffects.id, loaded.effect.id), eq(businessEffects.status, "authorized")));
    await db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null })
      .where(and(eq(domainActions.tenantId, loaded.action.tenantId), eq(domainActions.id, loaded.action.id), eq(domainActions.status, "executing")));
    await db.insert(actionLog).values({ tenantId: loaded.action.tenantId, domainActionId: loaded.action.id, step: "execution_blocked", input: { workflowStepId: loaded.step.id }, output: { reason, beforeEffect: true } });
  });
  await failStep(loaded.action.tenantId, loaded.step.id, reason, "conflict");
}

function isDeferredToChildRuntime(effect: BusinessEffectSet, result: ExecutionResult): boolean {
  return result.status === "success" && (
    result.output.pendingComputerRun === true
    || (effect.operation.class === "durable_workflow" && typeof result.output.workflowRunId === "string")
  );
}

export interface DurableExecutionDependencies {
  /** Deterministic test/failure-injection seam. Production workers omit this and use
   * the governed default registry; authorization scope is still applied below. */
  tools?: ToolRegistry;
}

/** Called only after workflow-runtime.claimStep has won the local lease. */
export async function executeAuthorizedEffectStep(
  tenantId: string,
  stepId: string,
  dependencies: DurableExecutionDependencies = {},
): Promise<void> {
  let loaded: LoadedExecution;
  try {
    loaded = await loadExecution(tenantId, stepId);
  } catch (error) {
    await failStep(tenantId, stepId, error instanceof Error ? error.message : "Invalid durable execution linkage", "conflict");
    return;
  }

  try {
    const authority = await revalidateActionExecution(tenantId, loaded.action.id);
    if (authority.outcome !== "allowed") throw new DurableExecutionBlocked(`Authority invalidated before execution: ${authority.reasonCode}`);
    if (loaded.command.authorityRevision && authority.authorityRevision !== loaded.command.authorityRevision) {
      // A revision change is not automatically material; evaluateAuthority above is
      // the precise test. Persist the new decision in the receipt chain but proceed
      // only when it still says allowed.
      await appendEpisode(tenantId, loaded.action.id, "authority_revision_revalidated", { authorizedRevision: loaded.command.authorityRevision }, { currentRevision: authority.authorityRevision, decisionId: authority.id, outcome: authority.outcome });
    }
    const eligibility = await revalidateAuthorizedEffectEligibility(tenantId, loaded.action.id, loaded.effect.id);
    if (!eligibility.allowed) throw new DurableExecutionBlocked(eligibility.reason);
    await assertMaterialPolicyStillValid(tenantId, loaded.effect);
    await verifyBusinessEffectPreconditions(tenantId, loaded.effect);
  } catch (error) {
    const reason = error instanceof BusinessEffectBoundaryError || error instanceof DurableExecutionBlocked
      ? error.message
      : `Execution eligibility check failed: ${error instanceof Error ? error.message : String(error)}`;
    await blockBeforeEffect(loaded, reason);
    await advanceWorkflow(tenantId, loaded.run.id);
    if (loaded.action.workId) await reconcileWorkStatus(tenantId, loaded.action.workId);
    await resumeObjectiveForAction(tenantId, loaded.action.id).catch(() => false);
    return;
  }

  let commit: CommitClaim;
  try {
    commit = await beginEffectCommit(loaded);
  } catch (error) {
    const blocked = error instanceof DurableExecutionBlocked ? error : new DurableExecutionBlocked(error instanceof Error ? error.message : String(error));
    if (blocked.afterPossibleEffect) {
      await withTenant(tenantId, async (db) => {
        await db.update(workflowSteps).set({ executionState: "reconciling", leaseExpiresAt: null }).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId)));
        await db.update(businessEffects).set({ status: "reconciliation_required" }).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, loaded.effect.id)));
        await db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null }).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, loaded.action.id)));
      });
      await openReconciliationCase(tenantId, { caseType: "unknown_delivery", relatedStepId: stepId, businessEffectId: loaded.effect.id, details: { reason: blocked.reason } });
    } else {
      // If cancellation already won, its transaction has recorded the exact terminal
      // state; do not overwrite that causal fact with a generic failure.
      const [current] = await withTenant(tenantId, (db) => db.select({ state: workflowSteps.executionState }).from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId))).limit(1));
      if (current?.state !== "cancelled_before_effect") {
        await blockBeforeEffect(loaded, blocked.reason);
        await advanceWorkflow(tenantId, loaded.run.id);
      }
    }
    if (loaded.action.workId) await reconcileWorkStatus(tenantId, loaded.action.workId);
    await resumeObjectiveForAction(tenantId, loaded.action.id).catch(() => false);
    return;
  }
  if (commit.kind === "reconcile") {
    await openReconciliationCase(tenantId, { caseType: "unknown_delivery", relatedStepId: stepId, businessEffectId: loaded.effect.id, details: { reason: commit.reason, semanticHash: loaded.effect.semanticHash } });
    await failStep(tenantId, stepId, commit.reason, "unknown_outcome");
    await advanceWorkflow(tenantId, loaded.run.id);
    if (loaded.action.workId) await reconcileWorkStatus(tenantId, loaded.action.workId);
    await resumeObjectiveForAction(tenantId, loaded.action.id).catch(() => false);
    return;
  }

  let result: ExecutionResult;
  if (commit.kind === "replay") {
    result = commit.result;
  } else {
    const plugin = createDefaultPluginRegistry().resolve(loaded.action.actionType);
    if (!plugin) {
      result = { status: "failure", output: {}, error: `No plugin handles ${loaded.action.actionType}`, errorKind: "terminal" };
    } else {
      const binding = loaded.effect.bindings[0];
      const values = structuredClone(loaded.effect.delta.values);
      const draft: DraftAction = {
        actionType: loaded.action.actionType,
        summary: loaded.effect.approval.summary,
        // Tenant identity is trusted execution-envelope context, not mutable planner
        // semantics. Existing plugins expect draft() to have stamped it; always
        // overwrite any payload value so a planner can never select another tenant.
        payload: { ...values, tenantId },
        requiresConfirmation: loaded.effect.approval.required,
        correlationId: loaded.command.correlationId ?? undefined,
        approvedBy: loaded.command.requestedBy ?? undefined,
        authorityDecisionId: loaded.command.authorityDecisionId ?? undefined,
        authorityRevision: loaded.command.authorityRevision ?? undefined,
        domainActionId: loaded.action.id,
        businessEffect: loaded.effect,
      };
      const tools = new ScopedToolRegistry(dependencies.tools ?? createDefaultRegistry(), {
        tenantId,
        domainActionId: loaded.action.id,
        actorId: loaded.action.initiatedBy ?? "system:durable-worker",
        purpose: typeof values.purpose === "string" ? values.purpose : loaded.action.actionType,
        ...(binding?.communicationIdentityId ? { communicationIdentityId: binding.communicationIdentityId } : {}),
        ...(binding?.authProfileRef ? { authProfileRef: binding.authProfileRef } : {}),
        businessEffectId: loaded.effect.id,
        businessEffectHash: loaded.effect.semanticHash,
      });
      try {
        result = await plugin.execute(draft, tools);
      } catch (error) {
        result = {
          status: "failure",
          output: {},
          error: error instanceof Error ? error.message : "Plugin execution failed",
          errorKind: (error as { kind?: ErrorKind })?.kind,
        };
      }
    }
    const classified = result.status === "success" ? null : classifyExecutionFailure(result);
    if (classified) result = { ...result, errorKind: classified.errorKind, error: classified.reason };
    result = {
      ...result,
      output: redactExecutionOutput(result.output),
      ...(result.error ? { error: redactText(result.error).value } : {}),
    };
    await recordSemanticOperation(loaded, result.status === "success" ? "succeeded" : result.errorKind === "unknown_outcome" ? "unknown" : "failed", result);
  }

  await appendEpisode(tenantId, loaded.action.id, "worker_execute", { businessEffectId: loaded.effect.id, workflowStepId: stepId }, { status: result.status, output: result.output, error: result.error ?? null, errorKind: result.errorKind ?? null });

  if (isDeferredToChildRuntime(loaded.effect, result)) {
    await withTenant(tenantId, (db) => db.update(workflowSteps).set({ executionState: "awaiting_observation" }).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId))));
    await completeStep(tenantId, stepId, { status: result.status, output: result.output, delegated: true });
    await advanceWorkflow(tenantId, loaded.run.id);
    if (loaded.action.workId) await reconcileWorkStatus(tenantId, loaded.action.workId);
    return;
  }

  const verification = await recordBusinessEffectOutcome(tenantId, loaded.effect, result);
  const awaitingExternalObservation = loaded.effect.operation.external && verification.state === "partially_verified";
  let finalStatus: DomainAction["status"] = verification.state === "divergent" || verification.state === "reconciliation_required" || result.errorKind === "unknown_outcome"
    ? "needs_human_review"
    : awaitingExternalObservation ? "executing"
      : result.status === "success" ? "completed"
      : result.status === "integration_unavailable" ? "blocked_integration_unavailable" : "failed";
  await withTenant(tenantId, async (db) => {
    await db.update(workflowSteps).set({
      executionState: verification.state === "reconciliation_required" ? "reconciling"
        : awaitingExternalObservation ? "awaiting_observation"
          : result.status === "success" ? "verified"
          : result.errorKind === "unknown_outcome" ? "failed_after_possible_effect" : "failed_before_effect",
    }).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, stepId)));
    await db.update(domainActions).set({ status: finalStatus, executionStartedAt: null })
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, loaded.action.id), eq(domainActions.status, "executing")));
  });
  if (result.status === "success") {
    if (awaitingExternalObservation) {
      await awaitStepObservation(tenantId, stepId, {
        providerAcknowledged: true,
        output: result.output,
        verification,
      });
      if (loaded.action.workId) await reconcileWorkStatus(tenantId, loaded.action.workId);
      return;
    }
    await completeStep(tenantId, stepId, { status: result.status, output: result.output, verification });
    const workflow = await advanceWorkflowForActionRequired({ tenantId, actionId: loaded.action.id, actionType: loaded.action.actionType, payload: loaded.effect.delta.values });
    if (!workflow.ok) {
      finalStatus = "needs_human_review";
      result = {
        status: "failure",
        output: { ...result.output, effectSucceeded: true, workflowAdvancementRecorded: false },
        error: "The action succeeded, but its required workflow state could not be advanced. Do not repeat the effect; reconcile the workflow state.",
        errorKind: "needs_human",
      };
      await withTenant(tenantId, (db) => db.update(workflowSteps).set({ executionState: "reconciling", updatedAt: new Date() }).where(and(
        eq(workflowSteps.tenantId, tenantId),
        eq(workflowSteps.id, stepId),
      )));
    } else if (workflow.advanced.length > 0) {
      await appendEpisode(tenantId, loaded.action.id, "workflow", {}, { advanced: workflow.advanced });
    }
  } else {
    const failure = classifyExecutionFailure(result);
    await failStep(tenantId, stepId, failure.reason, failure.errorKind);
  }
  await advanceWorkflow(tenantId, loaded.run.id);
  if (loaded.action.instructionId) {
    await emitInstructionEvent(tenantId, loaded.action.instructionId, finalStatus === "completed" ? "completed" : "failed", { actionId: loaded.action.id, status: finalStatus, durable: true }).catch(() => undefined);
  }
  if (loaded.action.workId) {
    if (finalStatus === "completed") await transitionWork(tenantId, loaded.action.workId, "executing", "action_effect_verified", { actionId: loaded.action.id, businessEffectId: loaded.effect.id, verification: verification.state });
    await reconcileWorkStatus(tenantId, loaded.action.workId);
  }
  if (loaded.action.workId && (finalStatus === "needs_human_review" || finalStatus === "failed" || verification.state === "divergent" || verification.state === "reconciliation_required")) {
    await demoteAutonomyForWorkRegression(tenantId, loaded.action.workId).catch(() => 0);
  }
  await resumeObjectiveForAction(tenantId, loaded.action.id).catch(() => false);
}
