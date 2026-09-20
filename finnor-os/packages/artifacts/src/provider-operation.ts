import { createHash } from "node:crypto";
import type { MicrosoftGraphMutationAudit } from "@finnor/provider-microsoft365";
import {
  markProviderRequestMayHaveLeft,
  prepareProviderInvocation,
  recordProviderInvocationAcknowledged,
  recordProviderInvocationFailure,
  type ClaimedProviderOperation,
  type ProviderInvocationContext,
} from "@finnor/tools";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

export function artifactOperationRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/**
 * Bridges one durable logical provider-operation attempt to every physical Graph
 * mutation emitted below it. The provider client owns transport retry/redirect
 * visibility; the artifact owner retains the logical operation and readback truth.
 */
export function microsoftGraphMutationAudit(input: {
  tenantId: string;
  claim: ClaimedProviderOperation;
  logicalRequestHash: string;
}): MicrosoftGraphMutationAudit & { preparedInvocationCount(): number } {
  let ordinal = 0;
  let preparedCount = 0;
  const contexts = new Map<string, ProviderInvocationContext>();

  return {
    async prepare(request) {
      ordinal += 1;
      const context: ProviderInvocationContext = {
        tenantId: input.tenantId,
        providerOperationAttemptId: input.claim.providerOperationAttemptId,
        provider: "microsoft_graph",
        ...(input.claim.operation.integrationId ? { integrationId: input.claim.operation.integrationId } : {}),
        requestHash: artifactOperationRequestHash({
          logicalRequestHash: input.logicalRequestHash,
          ordinal,
          operation: request.operation,
          method: request.method,
        }),
        ...(input.claim.operation.providerIdempotencyKey
          ? { providerIdempotencyKey: input.claim.operation.providerIdempotencyKey }
          : {}),
        ...(input.claim.operation.providerIdempotencyScope
          ? { providerIdempotencyScope: input.claim.operation.providerIdempotencyScope }
          : {}),
        ...(input.claim.operation.providerIdempotencyExpiresAt
          ? { providerIdempotencyExpiresAt: input.claim.operation.providerIdempotencyExpiresAt }
          : {}),
        transportLayer: "http_client",
      };
      const invocationId = await prepareProviderInvocation(context, ordinal);
      preparedCount += 1;
      contexts.set(invocationId, context);
      return invocationId;
    },

    async markRequestMayHaveLeft(invocationId) {
      await markProviderRequestMayHaveLeft(input.tenantId, invocationId);
    },

    async acknowledge(invocationId, response) {
      const context = contexts.get(invocationId);
      if (!context) throw new Error("Microsoft Graph invocation audit context is missing");
      await recordProviderInvocationAcknowledged(context, invocationId, {
        operation: response.operation,
        status: response.status,
        clientRequestId: response.clientRequestId,
        ...(response.requestId ? { requestId: response.requestId } : {}),
      }, { advanceLogicalOperation: false });
    },

    async fail(invocationId, failure) {
      const context = contexts.get(invocationId);
      if (!context) throw new Error("Microsoft Graph invocation audit context is missing");
      await recordProviderInvocationFailure(context, invocationId, {
        kind: failure.kind,
        message: failure.message,
        definitePreDispatch: failure.definitePreDispatch,
        definiteRejection: failure.definiteRejection,
        advanceLogicalOperation: failure.terminalForLogicalOperation,
      });
    },

    preparedInvocationCount() {
      return preparedCount;
    },
  };
}
