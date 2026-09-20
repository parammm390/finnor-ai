// Shared handler factory for the 5 run-control routes (§2.7) — pause/resume/cancel/
// retry/escalate all share the same auth gate, body validation, and result→status
// mapping; only which @finnor/workflow-runtime function gets called differs.

import { z } from "zod";
import type { RunControlResult } from "@finnor/workflow-runtime";
import { requireContext, authorizeRuntimeControl, errorResponse } from "./auth";

const BodySchema = z.object({ expectedVersion: z.number().int().nonnegative() });

const STATUS_BY_REASON: Record<string, number> = {
  not_found: 404,
  version_conflict: 409,
  illegal_transition: 409,
};

type RunControlFn = (tenantId: string, runId: string, expectedVersion: number, requestedBy: string, authorityDecisionId?: string) => Promise<RunControlResult>;

export function makeRunControlRoute(fn: RunControlFn) {
  return async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
      const { id } = await params;
      const ctx = await requireContext(req);
      // Run controls are an owner-level operational lever over a live business
      // process — same canApprove(ctx, "*") gate as the DLQ routes, not a per-action
      // RBAC check (a run isn't a single action_type).
      const authority = await authorizeRuntimeControl(ctx, "workflow_run", id);
      if (authority.outcome !== "allowed") {
        return Response.json({ error: `Your role (${ctx.role}) cannot control workflow runs` }, { status: 403 });
      }
      const body = BodySchema.safeParse(await req.json().catch(() => ({})));
      if (!body.success) {
        return Response.json({ error: "Invalid body — expectedVersion (number) is required" }, { status: 400 });
      }
      const result = await fn(ctx.tenantId, id, body.data.expectedVersion, ctx.userId, authority.id);
      if (!result.ok) {
        return Response.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] ?? 409 });
      }
      return Response.json({ run: result.run });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
