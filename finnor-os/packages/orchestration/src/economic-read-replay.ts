import { isDeepStrictEqual } from "node:util";
import { readWorkInputResponse } from "@finnor/db";
import { isEconomicReadIntent, storedEconomicQuery, type TenantContext } from "@finnor/shared-types";
import { PeDomainError } from "@finnor/private-equity/src/types";
import { assertEconomicReadReplayAccess } from "@finnor/private-equity/src/economic-reads/reader";

export { storedEconomicQuery } from "@finnor/shared-types";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unavailable = () => new PeDomainError("PE_ENTITY_NOT_FOUND", "The original authenticated economic read is unavailable.");

/** A complete original-input reply is data, never current source/capability
 * authority. Even a corrupted reply cannot demote itself to generic replay. */
export async function assertEconomicReadReplyAccess(
  ctx: TenantContext,
  value: unknown,
  input: { workId: string; workInputId: string; instructionId: string },
): Promise<void> {
  const owned = await readWorkInputResponse({ tenantId: ctx.tenantId, userId: ctx.userId, ...input });
  const body = record(record(value).response ?? value), query = record(body.query ?? body);
  const request = record(query.request), result = record(query.result);
  const financial = owned.queryExecutions.length > 0 || isEconomicReadIntent(request.intent) || isEconomicReadIntent(result.intent) || result.economicRead !== undefined;
  if (!financial) return;
  const execution = storedEconomicQuery(value), original = storedEconomicQuery(owned.response);
  const originalBody = record(record(owned.response).response ?? owned.response);
  if (!execution || !original || !isDeepStrictEqual(execution, original) || owned.input.instructionId !== input.instructionId
      || originalBody.workId !== input.workId || originalBody.workInputId !== input.workInputId || originalBody.instructionId !== input.instructionId
      || execution.result.execution.workId !== input.workId || execution.result.execution.workInputId !== input.workInputId
      || owned.queryExecutions.length !== 1) throw unavailable();
  const receipt = owned.queryExecutions[0]!;
  if (receipt.id !== execution.result.execution.id || receipt.status !== "succeeded"
      || receipt.executionKey !== execution.result.execution.executionKey || receipt.intent !== execution.request.intent
      || !isDeepStrictEqual(receipt.request, execution.request)
      || body.workId !== undefined && body.workId !== input.workId
      || body.workInputId !== undefined && body.workInputId !== input.workInputId
      || body.instructionId !== undefined && body.instructionId !== input.instructionId) throw unavailable();
  await assertEconomicReadReplayAccess({ auth: ctx, provenance: { sourceSystem: "POSTZ.W1:canonical-read-replay" } },
    execution.request, execution.result.economicRead);
}
