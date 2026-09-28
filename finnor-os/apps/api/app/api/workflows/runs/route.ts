// GET /api/workflows/runs — live view of the durable workflow-runtime's in-flight
// (and recent terminal) runs, with their steps, for the console's mission-control
// panel. workflow_runs/workflow_steps are the Phase 2 durable execution scaffolding —
// distinct from workflow_states (the 2-workflow business-stage tracker served by
// resources/[kind]?kind=workflows).

import { withTenant, workflowRuns, workflowSteps } from "@finnor/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../lib/auth";
import { isRunPastWatchdogDeadline } from "@finnor/workflow-runtime";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status");

    const runs = await withTenant(ctx.tenantId, async (db) => {
      const runRows = statusFilter
        ? await db
            .select()
            .from(workflowRuns)
            .where(and(eq(workflowRuns.tenantId, ctx.tenantId), eq(workflowRuns.status, statusFilter as "running")))
            .orderBy(desc(workflowRuns.updatedAt))
            .limit(20)
        : await (async () => {
            const running = await db
              .select()
              .from(workflowRuns)
              .where(and(eq(workflowRuns.tenantId, ctx.tenantId), eq(workflowRuns.status, "running")))
              .orderBy(desc(workflowRuns.updatedAt));
            const terminal = await db
              .select()
              .from(workflowRuns)
              .where(and(eq(workflowRuns.tenantId, ctx.tenantId), inArray(workflowRuns.status, ["completed", "failed", "compensating", "compensated", "paused", "cancelled", "escalated"])))
              .orderBy(desc(workflowRuns.updatedAt))
              .limit(20);
            return [...running, ...terminal];
          })();

      if (runRows.length === 0) return [];

      const runIds = runRows.map((r) => r.id);
      const stepRows = await db
        .select()
        .from(workflowSteps)
        .where(inArray(workflowSteps.workflowRunId, runIds))
        .orderBy(asc(workflowSteps.sequence));

      const stepsByRun = new Map<string, typeof stepRows>();
      for (const step of stepRows) {
        const list = stepsByRun.get(step.workflowRunId) ?? [];
        list.push(step);
        stepsByRun.set(step.workflowRunId, list);
      }

      return runRows.map((r) => ({
        id: r.id,
        workId: r.workId,
        workflowType: r.workflowType,
        status: r.status,
        // This is the same pure threshold the watchdog scan uses. Findings are sent
        // to Sentry rather than persisted, so re-evaluating it here is the only
        // truthful way to badge a currently stuck run without inventing a database
        // flag that does not exist.
        watchdogFlagged: r.status === "running" && isRunPastWatchdogDeadline(r),
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        steps: (stepsByRun.get(r.id) ?? []).map((s) => ({
          id: s.id,
          stepType: s.stepType,
          sequence: s.sequence,
          status: s.status,
          attempts: s.attempts,
          terminalReason: s.terminalReason,
          domainActionId: s.domainActionId,
          updatedAt: s.updatedAt,
        })),
      }));
    });

    return Response.json({ runs });
  } catch (err) {
    return errorResponse(err);
  }
}
