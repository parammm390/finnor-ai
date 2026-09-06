import { actionLog, domainActions, instructionSessions, workflowRuns, workflowSteps, workObjectiveLoops, works, withTenant, transitionWork } from "@finnor/db";
import { cancelRun } from "@finnor/workflow-runtime";
import { and, eq, inArray } from "drizzle-orm";
import { emitInstructionEvent } from "@finnor/orchestration";
import { canApprove, errorResponse, requireContext } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";

/** Cancels the durable instruction, not just its browser presentation. The
 * append-only cancelled event stops an in-flight planner before dispatch;
 * already-gated actions are rejected through the normal audited decision path,
 * and live workflow runs receive their ordinary optimistic cancel control. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!(await canApprove(ctx, "*"))) {
      return Response.json({ error: `Your role (${ctx.role}) cannot cancel business instructions` }, { status: 403 });
    }

    const instruction = await withTenant(ctx.tenantId, async (db) => {
      const [instruction] = await db
        .select({ id: instructionSessions.id, workId: instructionSessions.workId })
        .from(instructionSessions)
        .where(and(eq(instructionSessions.id, id), eq(instructionSessions.tenantId, ctx.tenantId)))
        .limit(1);
      if (!instruction) return null;
      const [work] = instruction.workId ? await db
        .select({ status: works.status })
        .from(works)
        .where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, instruction.workId)))
        .limit(1) : [];
      return { ...instruction, workStatus: work?.status ?? null };
    });
    if (!instruction) return Response.json({ error: "Instruction not found" }, { status: 404 });
    if (instruction.workStatus === "completed") {
      return Response.json({ error: "Completed Work cannot be cancelled", status: "completed" }, { status: 409 });
    }
    if (instruction.workStatus === "cancelled") {
      return Response.json({ status: "cancelled", duplicate: true, rejectedActions: 0, cancelledRuns: 0, inFlightActions: 0 });
    }

    // Publish the cancellation fence before taking a second snapshot. A planner
    // that finishes after this point sees the marker and must reject its drafts.
    await emitInstructionEvent(
      ctx.tenantId,
      id,
      "cancelled",
      { requestedBy: ctx.userId, source: "product", fence: true, canonical: false },
      { required: true },
    );

    const snapshot = await withTenant(ctx.tenantId, async (db) => {
      const actions = await db
        .select({ id: domainActions.id, status: domainActions.status })
        .from(domainActions)
        .where(and(
          eq(domainActions.tenantId, ctx.tenantId),
          instruction.workId ? eq(domainActions.workId, instruction.workId) : eq(domainActions.instructionId, id),
        ));
      return { instruction, actions };
    });

    const rejectableIds = snapshot.actions.filter((action) => action.status === "draft" || action.status === "approved").map((action) => action.id);
    if (rejectableIds.length > 0) {
      await withTenant(ctx.tenantId, async (db) => {
        const rejected = await db
          .update(domainActions)
          .set({ status: "rejected" })
          .where(and(eq(domainActions.tenantId, ctx.tenantId), inArray(domainActions.id, rejectableIds), inArray(domainActions.status, ["draft", "approved"])))
          .returning({ id: domainActions.id });
        if (rejected.length > 0) {
          await db.insert(actionLog).values(rejected.map((action) => ({
            tenantId: ctx.tenantId,
            domainActionId: action.id,
            step: "rejected",
            input: { by: ctx.userId, role: ctx.role, reason: "instruction_cancel" },
            output: { cancelledBeforeDispatch: true, instructionId: id },
          })));
        }
      });
    }

    const pendingIds = snapshot.actions
      .filter((action) => action.status === "pending" || action.status === "needs_human_review")
      .map((action) => action.id);
    await Promise.all(pendingIds.map((actionId) =>
      getOrchestrator().decide(actionId, ctx.tenantId, "reject", ctx.userId, {
        role: ctx.role,
        reason: "instruction_cancel",
      }),
    ));

    const actionIds = snapshot.actions.map((action) => action.id);
    const activeRuns = actionIds.length === 0 ? [] : await withTenant(ctx.tenantId, (db) =>
      db
        .selectDistinct({ id: workflowRuns.id, version: workflowRuns.version, status: workflowRuns.status })
        .from(workflowRuns)
        .innerJoin(workflowSteps, eq(workflowSteps.workflowRunId, workflowRuns.id))
        .where(and(
          eq(workflowRuns.tenantId, ctx.tenantId),
          inArray(workflowSteps.domainActionId, actionIds),
          inArray(workflowRuns.status, ["running", "paused"]),
        )),
    );
    const runResults = await Promise.all(activeRuns.map((run) => cancelRun(ctx.tenantId, run.id, run.version, ctx.userId)));
    const inFlightActions = snapshot.actions.filter((action) => action.status === "approved" || action.status === "executing").length;
    if (snapshot.instruction.workId) {
      const cancelledRuns = runResults.filter((result) => result.ok).length;
      const unresolvedActions = await withTenant(ctx.tenantId, (db) => db
        .select({ id: domainActions.id, status: domainActions.status })
        .from(domainActions)
        .where(and(
          eq(domainActions.tenantId, ctx.tenantId),
          eq(domainActions.workId, snapshot.instruction.workId!),
          inArray(domainActions.status, ["executing", "needs_human_review"]),
        )));
      const reconciliationRequired = unresolvedActions.length > 0 || runResults.some((result) => !result.ok);
      await transitionWork(ctx.tenantId, snapshot.instruction.workId, "cancelled", "cancelled", {
        instructionId: id,
        requestedBy: ctx.userId,
        rejectedActions: rejectableIds.length + pendingIds.length,
        cancelledRuns,
        inFlightActions,
        reconciliationRequired,
        unresolvedActionIds: unresolvedActions.map((action) => action.id),
      }, {
        finalOutcome: {
          kind: "cancelled",
          requestedBy: ctx.userId,
          reconciliationRequired,
          unresolvedActionIds: unresolvedActions.map((action) => action.id),
        },
      });

      // Re-read only after the terminal Work transition. startWorkObjective holds
      // the same Work row lock, so an objective either existed before cancellation
      // and is found here, or observes the cancelled Work and cannot start.
      const [objective] = await withTenant(ctx.tenantId, (db) => db
        .select({ id: workObjectiveLoops.id, state: workObjectiveLoops.state })
        .from(workObjectiveLoops)
        .where(and(eq(workObjectiveLoops.tenantId, ctx.tenantId), eq(workObjectiveLoops.workId, snapshot.instruction.workId!)))
        .limit(1));
      if (objective && objective.state !== "cancelled") {
        await getOrchestrator().controlObjective({
          tenantId: ctx.tenantId,
          workId: snapshot.instruction.workId,
          command: "cancel",
          actorId: ctx.userId,
          correlationId: ctx.correlationId,
        });
      }
      await emitInstructionEvent(ctx.tenantId, id, "cancelled", {
        requestedBy: ctx.userId,
        source: "product",
        canonical: true,
        workId: snapshot.instruction.workId,
      });
    }

    return Response.json({
      status: "cancelled",
      rejectedActions: rejectableIds.length + pendingIds.length,
      cancelledRuns: runResults.filter((result) => result.ok).length,
      inFlightActions,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
