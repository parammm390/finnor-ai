import { domainActions, withTenant } from "@finnor/db";
import { appendEpisode } from "@finnor/memory";
import { isRetiredWaterAction, RetiredVerticalError } from "@finnor/shared-types";
import { and, eq } from "drizzle-orm";

export type RequiredWorkflowAdvancement =
  | { ok: true; advanced: Array<{ workflow: string; subjectId: string; toState: string }> }
  | { ok: false; error: string };

/**
 * Phase 5 retires the Water-specific business-state workflows. Active Core and
 * Private Equity actions execute through the durable BusinessEffect graph and do
 * not project into those historical state machines.
 */
export async function advanceWorkflowForActionRequired(params: {
  tenantId: string;
  actionId: string;
  actionType: string;
  payload: Record<string, unknown>;
}): Promise<RequiredWorkflowAdvancement> {
  if (!isRetiredWaterAction(params.actionType)) return { ok: true, advanced: [] };

  const error = new RetiredVerticalError(
    `Action "${params.actionType}" belongs to the retired Water vertical`,
  );
  await withTenant(params.tenantId, async (db) => {
    await db
      .update(domainActions)
      .set({ status: "needs_human_review", executionStartedAt: null })
      .where(and(eq(domainActions.tenantId, params.tenantId), eq(domainActions.id, params.actionId)));
  });
  await appendEpisode(params.tenantId, params.actionId, "retired_vertical_blocked", {}, {
    actionType: params.actionType,
    effectSucceeded: false,
    error: error.message,
  });
  return { ok: false, error: error.message };
}
