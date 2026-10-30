import { latestWorkInput } from "@finnor/db";
import { evaluateAuthority } from "@finnor/authority";
import type { TenantContext } from "@finnor/shared-types";
import type { FastReadOnlyRouter } from "../../fast-read-lane";
import { queryAuthorityRequest } from "../../authority-runtime";
import { x2Fault } from "@finnor/private-equity/src/application-semantics/contracts";
import { nativeObservationRequest } from "./semantics";

/** Native-only observation, not receiveWork and not a new public wire intent.
 * The actual reader still verifies its persisted original input before accounting. */
export async function observeOriginalWork(input: unknown, ctx: TenantContext, options: {
  workId?: string; workInputId?: string; executionKey?: string; idempotencyKey?: string;
}, router: Pick<FastReadOnlyRouter, "execute">) {
  const bound = nativeObservationRequest(input, {
    workId: options.workId, ...(options.workInputId ? { workInputId: options.workInputId } : {}),
  });
  if (!router.execute) x2Fault("Z0_NATIVE_OBSERVATION_EXECUTOR_UNAVAILABLE", 503);
  const authority = await evaluateAuthority(ctx, queryAuthorityRequest(bound.request, bound.workId));
  if (authority.outcome !== "allowed") x2Fault("Z0_NATIVE_OBSERVATION_AUTHORITY_REQUIRED", 403);
  const current = await latestWorkInput(ctx.tenantId, bound.workId);
  if (!current || bound.workInputId && current.id !== bound.workInputId) {
    x2Fault("Z0_NATIVE_ORIGINAL_INPUT_UNAVAILABLE", 404);
  }
  const execution = await router.execute(bound.request, ctx, {
    workId: bound.workId, workInputId: current.id,
    executionKey: options.executionKey ?? options.idempotencyKey,
  });
  if (execution.request.intent !== bound.request.intent || execution.result.execution?.workId !== bound.workId
    || execution.result.execution?.workInputId !== current.id) x2Fault("Z0_NATIVE_OBSERVATION_IDENTITY_CHANGED");
  return { ...execution, workId: bound.workId, workInputId: current.id, instructionId: current.instructionId };
}
