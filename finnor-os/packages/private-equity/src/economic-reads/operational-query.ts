import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { beginWorkQueryExecution, finishWorkQueryExecution, readWorkInputResponse, recordWorkQueryResponse,
  withTenantTransaction, WorkQueryInProgressError } from "@finnor/db";
import type { OperationalQueryOptions } from "@finnor/read-models";
import { EconomicReadRequestSchema, EconomicReadReplySchema, economicReadSource, storedEconomicQuery,
  type EconomicReadRequest, type EconomicOperationalQueryResult, type EconomicReadReply, type Role } from "@finnor/shared-types";
import { PeDomainError, type PeMutationContext } from "../types";
import { readEconomicQuery, assertEconomicReadReplayAccess } from "./reader";

/** Existing query receipt + existing private input response, committed together.
 * No new financial cache, lifecycle, grant registry or planner invocation. */
export async function executeEconomicReadQuery(tenantId: string, input: EconomicReadRequest, options: OperationalQueryOptions = {}): Promise<EconomicOperationalQueryResult> {
  const request = EconomicReadRequestSchema.parse(input), userId = options.userId;
  const workId = options.workId, workInputId = options.workInputId;
  if (!userId || !workId || !workInputId) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Authenticated exact Work input is required.");
  const user = await withTenantTransaction(tenantId, { userId, readOnly: true }, async (_db, client) =>
    (await client.query<{ role: Role; status: string }>("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2", [tenantId, userId])).rows[0]);
  if (!user || user.status !== "active") throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The authenticated principal is unavailable.");
  const ctx: PeMutationContext = { auth: { tenantId, userId, employeeId: options.employeeId, role: user.role },
    provenance: { sourceSystem: "POSTZ.W1:canonical-economic-read" } };
  const custody = { tenantId, userId, workId, workInputId,
    ...(options.objectiveClaim ? { objectiveStepId: options.objectiveClaim.stepId, objectiveClaim: options.objectiveClaim } : {}) };
  const owned = await readWorkInputResponse(custody);
  const startedAt = new Date().toISOString(), started = performance.now();
  const execution = await beginWorkQueryExecution({ tenantId, workId, workInputId, userId,
    intent: request.intent, request: { ...request }, recoveryAttemptKey: options.recoveryAttemptKey,
    executionKey: options.executionKey ?? (options.objectiveClaim
      ? `objective-economic:${options.objectiveClaim.stepId}` : `economic-read:${workInputId}:${request.intent}`),
    objectiveClaim: options.objectiveClaim });
  if (!execution.claimed) {
    const stored = await readWorkInputResponse(custody);
    const query = storedEconomicQuery(stored.response), receipt = stored.queryExecutions[0];
    if (!query) {
      if (execution.status === "running") throw new WorkQueryInProgressError(workId, workInputId);
      throw new PeDomainError("PE_ENTITY_NOT_FOUND", "No original committed reply exists for this input; use its explicit recovery or request a new read.");
    }
    const body = stored.response && typeof stored.response === "object" && !Array.isArray(stored.response)
      ? stored.response as Record<string, unknown> : {};
    if (!isDeepStrictEqual(query.request, request) || stored.queryExecutions.length !== 1 || !receipt || receipt.status !== "succeeded"
        || receipt.objectiveStepId !== (options.objectiveClaim?.stepId ?? null)
        || !isDeepStrictEqual(body.objective ?? null, stored.origin)
        || receipt.id !== query.result.execution.id || receipt.executionKey !== query.result.execution.executionKey
        || receipt.workId !== workId || receipt.workInputId !== workInputId || !isDeepStrictEqual(receipt.request, request)
        || query.result.execution.workId !== workId || query.result.execution.workInputId !== workInputId
        || body.workId !== workId || body.workInputId !== workInputId || body.instructionId !== stored.input.instructionId)
      throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The original authenticated read is unavailable.");
    if (stored.origin) EconomicReadReplySchema.parse(body);
    await assertEconomicReadReplayAccess(ctx, request, query.result.economicRead);
    return query.result;
  }
  let proposed: EconomicReadReply, committed: EconomicReadReply;
  try {
    const economicRead = await readEconomicQuery(ctx, request);
    const count = ["AVAILABLE", "CURRENT", "DELAYED"].includes(economicRead.availability) ? 1 : 0;
    const status = count ? "ok" : economicRead.availability === "AMBIGUOUS" ? "ambiguous"
      : economicRead.availability === "CONFLICTED" ? "partial" : "unavailable";
    const source = economicReadSource(request.intent), asOf = economicRead.observedAt;
    proposed = EconomicReadReplySchema.parse({ workId, workInputId, instructionId: owned.input.instructionId,
      ...(owned.origin ? { objective: owned.origin } : {}),
      query: { request, result: {
        kind: "operational_query_result", version: 1, intent: request.intent, status, source, asOf, count, truncated: false,
        data: { availability: economicRead.availability },
        page: { limit: 1, returned: count, totalCount: count, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false },
        meta: { version: 1, source, asOf },
        execution: { id: execution.id, workId, workInputId, executionKey: execution.executionKey, status: "succeeded" },
        economicRead,
      }, metadata: { queryId: execution.id, source: "postgresql", durationMs: Math.max(0, performance.now() - started),
        startedAt, completedAt: new Date().toISOString() } } });
    committed = await recordWorkQueryResponse({ tenantId, userId, workId, workInputId, objectiveClaim: options.objectiveClaim }, proposed);
  } catch (error) {
    await finishWorkQueryExecution({ tenantId, executionId: execution.id, status: "failed", rowCount: 0, durationMs: performance.now() - started,
      failure: { code: "ECONOMIC_READ_UNAVAILABLE" }, objectiveClaim: options.objectiveClaim }).catch(() => undefined);
    if (error instanceof PeDomainError) throw error;
    // Drizzle's failed private INSERT/UPDATE can include the full financial
    // response in SQL parameters. Never forward those bytes to shared failure
    // projections, traces or route error logging.
    const safe = new Error("The original economic read could not be committed; retry its original Work explicitly.");
    if (error instanceof Error && (error.name === "AbortError" || /\b(?:timeout|timed out|deadline|aborted?)\b/i.test(error.message)))
      safe.name = "AbortError";
    throw safe;
  }
  await assertEconomicReadReplayAccess(ctx, committed.query.request, committed.query.result.economicRead);
  return committed.query.result;
}
