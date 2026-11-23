import { beginWorkQueryExecution, finishWorkQueryExecution } from "@finnor/db";
import type { OperationalQueryOptions } from "@finnor/read-models";
import { OrganizationTransformationQueryRequestSchema, type OrganizationTransformationQueryRequest,
  type OrganizationTransformationQueryResult, type TenantContext } from "@finnor/shared-types";
import { organizationDigest } from "./compiler";
import { orgFail, orgRow, orgTx } from "./store";
import { readOrganizationTransformation } from "./native";
export async function executeOrganizationTransformationQuery(tenantId: string, value: OrganizationTransformationQueryRequest,
  options: OperationalQueryOptions = {}): Promise<OrganizationTransformationQueryResult> {
  const request = OrganizationTransformationQueryRequestSchema.parse(value), actor = options.employeeId ?? options.userId;
  if (!actor || options.workId !== request.workId || !options.workInputId) orgFail("W5_AUTHENTICATED_EXACT_QUERY_BINDING_REQUIRED", 403);
  const ctx: TenantContext = { tenantId, userId: actor, employeeId: actor, role: "owner" };
  const q = await orgTx(ctx, c => orgRow(ctx, request.requestId, c));
  if (q.work_id !== request.workId || q.work_input_id !== options.workInputId) orgFail("W5_CONTEXT_UNAVAILABLE", 404);
  const current = await readOrganizationTransformation(ctx, { requestId: q.id });
  if (current.access !== "OWNER") orgFail("W5_CONTEXT_UNAVAILABLE", 404);
  const alternative = current.program?.alternatives.find(a => a.id === request.alternativeId);
  if (request.alternativeId && !alternative) orgFail("W5_CURRENT_ALTERNATIVE_UNAVAILABLE", 404);
  const execution = await beginWorkQueryExecution({ tenantId, workId: q.work_id, workInputId: q.work_input_id,
    intent: request.intent, request: { ...request }, executionKey: options.executionKey ??
      "w5:query:" + organizationDigest({ request, revision: q.revision, currentness: current.currentness }) });
  const began = performance.now(), asOf = new Date().toISOString();
  const source = { kind: "canonical_postgres" as const, tables: ["w5_requests", "w5_revisions", "w5_dependency_pins", "work_plan_revisions"] };
  const checked = q.program !== null && current.currentness.status === "CURRENT" &&
    (current.check as { status?: string } | null)?.status === "CHECKED";
  const result: OrganizationTransformationQueryResult = { kind: "operational_query_result", status: checked ? "ok" : "partial",
    data: { requestId: q.id, workId: q.work_id, workInputId: q.work_input_id, revision: q.revision, checked,
      alternativeId: alternative?.id ?? null, status: current.status, originalDeadline: current.originalDeadline,
      currentness: current.currentness, fieldBenefitEstablished: false, newAuthorityGranted: false },
    version: 1, intent: request.intent, source, asOf, count: 1, truncated: false,
    page: { limit: 1, returned: 1, totalCount: 1, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false },
    meta: { version: 1, source, asOf }, execution: { id: execution.id, workId: execution.workId,
      workInputId: execution.workInputId, executionKey: execution.executionKey, status: "succeeded" } };
  await finishWorkQueryExecution({ tenantId, executionId: execution.id, status: "succeeded", rowCount: 1,
    durationMs: performance.now() - began, resultSummary: result.data });
  return result;
}
