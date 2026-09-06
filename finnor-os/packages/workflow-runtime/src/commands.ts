// submitCommand(): the entry point into the durable execution runtime. A command is
// created already-approved (approval happens upstream, e.g. an existing domain_action
// gate) — this table exists to give every workflow_run a stable, idempotent parent.

import { commands, workflowRuns, workflowSteps, domainActions, jobs, type Db } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { workflowStepJobKey } from "./job-identity";
import { isRetiredWaterAction, isRetiredWaterWorkflow, RetiredVerticalError } from "@finnor/shared-types";

export interface StepDefinition {
  stepType: string;
  payload: Record<string, unknown>;
}

export interface SubmitCommandParams {
  tenantId: string;
  commandType: string;
  payload: Record<string, unknown>;
  workflowType: string;
  steps: StepDefinition[];
  idempotencyKey?: string;
  requestedBy?: string;
  /** §2.4: forwarded from the originating DomainAction/TenantContext (Phase 16(e)) —
   *  carried onto both the command and every one of its steps so a receipt can read it
   *  with no join. */
  correlationId?: string;
  /** §2.8: the originating domain_action id, for single-action commands the §2.5
   *  runtime bridge submits — carried onto every step so its receipt can be looked up
   *  by domain_action_id, not just workflow_step_id. Left undefined for genuine
   *  multi-step workflow-kind commands, which have no single originating action. */
  domainActionId?: string;
  businessEffectId?: string;
  authorizedEffectHash?: string;
  authorityDecisionId?: string;
  authorityRevision?: number;
  policyId?: string;
  policyVersion?: number;
  executionClass?: string;
  authorizedAt?: Date;
  workId?: string;
  /** The normal command contract queues its first step in the same transaction as
   * the command. Tests/admin importers may opt out only when intentionally creating
   * a paused graph that another transaction will drive. */
  enqueueFirstStep?: boolean;
}

export interface SubmitCommandResult {
  commandId: string;
  workflowRunId: string;
  stepIds: string[];
  alreadyExisted: boolean;
}

async function enqueueFirstStepTx(db: Db, tenantId: string, stepId: string, dispatchGeneration: number, correlationId?: string): Promise<void> {
  const payload = correlationId
    ? { tenantId, workflowStepId: stepId, workflowStepGeneration: dispatchGeneration, _correlationId: correlationId }
    : { tenantId, workflowStepId: stepId, workflowStepGeneration: dispatchGeneration };
  await db.insert(jobs).values({
    type: "run_workflow_step",
    payload,
    idempotencyKey: workflowStepJobKey(tenantId, stepId, dispatchGeneration),
    lane: "interactive",
    priority: 100,
  }).onConflictDoNothing({ target: jobs.idempotencyKey });
}

export async function submitCommand(db: Db, params: SubmitCommandParams): Promise<SubmitCommandResult> {
  if (
    isRetiredWaterAction(params.commandType)
    || isRetiredWaterWorkflow(params.workflowType)
    || params.steps.some((step) => isRetiredWaterAction(step.stepType))
  ) {
    throw new RetiredVerticalError("water");
  }
  const [originAction] = !params.workId && params.domainActionId
    ? await db.select({ workId: domainActions.workId }).from(domainActions).where(and(eq(domainActions.tenantId, params.tenantId), eq(domainActions.id, params.domainActionId))).limit(1)
    : [];
  const workId = params.workId ?? originAction?.workId ?? null;
  if (params.idempotencyKey) {
    const [existingCommand] = await db
      .select()
      .from(commands)
      .where(and(eq(commands.tenantId, params.tenantId), eq(commands.idempotencyKey, params.idempotencyKey)));
    if (existingCommand) {
      if ((params.businessEffectId ?? null) !== (existingCommand.businessEffectId ?? null)
          || (params.authorizedEffectHash ?? null) !== (existingCommand.authorizedEffectHash ?? null)) {
        throw new Error("Command idempotency conflict: durable authorization is bound to a different Business Effect");
      }
      const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.commandId, existingCommand.id));
      if (!run) throw new Error("Durable command exists without its workflow run");
      if (run && workId && !run.workId) await db.update(workflowRuns).set({ workId }).where(eq(workflowRuns.id, run.id));
      const steps = run ? await db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, run.id)) : [];
      const first = steps.sort((a, b) => a.sequence - b.sequence)[0];
      if (first && first.status === "pending" && params.enqueueFirstStep !== false) {
        await enqueueFirstStepTx(db, params.tenantId, first.id, first.dispatchGeneration, params.correlationId);
      }
      return {
        commandId: existingCommand.id,
        workflowRunId: run?.id ?? "",
        stepIds: steps.map((s) => s.id),
        alreadyExisted: true,
      };
    }
  }

  const commandValues = {
      tenantId: params.tenantId,
      commandType: params.commandType,
      payload: params.payload,
      idempotencyKey: params.idempotencyKey ?? null,
      requestedBy: params.requestedBy ?? null,
      correlationId: params.correlationId ?? null,
      businessEffectId: params.businessEffectId ?? null,
      authorizedEffectHash: params.authorizedEffectHash ?? null,
      authorityDecisionId: params.authorityDecisionId ?? null,
      authorityRevision: params.authorityRevision ?? null,
      policyId: params.policyId ?? null,
      policyVersion: params.policyVersion ?? null,
      executionClass: params.executionClass ?? null,
      authorizedAt: params.authorizedAt ?? new Date(),
      status: "approved",
    } as const;
  const insertedCommands = params.idempotencyKey
    ? await db.insert(commands).values(commandValues)
        .onConflictDoNothing({ target: [commands.tenantId, commands.idempotencyKey] })
        .returning()
    : await db.insert(commands).values(commandValues).returning();
  const command = insertedCommands[0];
  // Two authorization transactions may both miss the optimistic SELECT above. The
  // unique key is the arbiter; once ON CONFLICT waits for the winner, a new READ
  // COMMITTED statement can safely load and return that winner's complete graph.
  if (!command) return submitCommand(db, params);

  const [run] = await db
    .insert(workflowRuns)
    .values({ tenantId: params.tenantId, commandId: command!.id, workId, workflowType: params.workflowType, status: "running" })
    .returning();

  const stepRows = await db
    .insert(workflowSteps)
    .values(
      params.steps.map((s, i) => ({
        tenantId: params.tenantId,
        workflowRunId: run!.id,
        stepType: s.stepType,
        sequence: i,
        payload: s.payload,
        idempotencyKey: `${run!.id}:${i}`,
        correlationId: params.correlationId ?? null,
        domainActionId: params.domainActionId ?? null,
        businessEffectId: params.businessEffectId ?? null,
      })),
    )
    .returning();

  await db.update(commands).set({ status: "running", updatedAt: new Date() }).where(eq(commands.id, command!.id));

  if (stepRows[0] && params.enqueueFirstStep !== false) {
    // This insert uses the caller's Db transaction. A committed command can never
    // exist without its executable first job, and a rolled-back approval leaves
    // neither command nor job behind.
    await enqueueFirstStepTx(db, params.tenantId, stepRows[0].id, stepRows[0].dispatchGeneration, params.correlationId);
  }

  return {
    commandId: command!.id,
    workflowRunId: run!.id,
    stepIds: stepRows.map((s) => s.id),
    alreadyExisted: false,
  };
}
