import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { evaluateAuthority } from "@finnor/authority";
import { withTenant, type Db } from "@finnor/db";
import { recordBusinessEvent } from "@finnor/data-platform";
import { ensure } from "@finnor/ooxml";
import type { ArtifactActor } from "./service";
import type { MicrosoftDriveItemMetadata, MicrosoftGraphMutationAudit } from "@finnor/provider-microsoft365";
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

export function assertArtifactProviderIdentity(
  metadata: MicrosoftDriveItemMetadata,
  target: { driveId: string; itemId: string },
): void {
  ensure(metadata.driveId === target.driveId && metadata.itemId === target.itemId && metadata.id === target.itemId,
    "ARTIFACT_PROVIDER_TARGET_MISMATCH");
}

/** Current native-owner decision and attempt fence. This trusted-process check
 * does not authenticate an arbitrary executor or replace protected IR mediation. */
export async function assertArtifactOperationDispatch(input: {
  actor: ArtifactActor;
  documentId: string;
  capability: "artifact:publish" | "artifact:recalculate";
  claim: ClaimedProviderOperation;
  requestHash: string;
  validateOwner(db: Db): Promise<void>;
  invocationId?: string;
}): Promise<void> {
  const { actor, claim } = input;
  await withTenant(actor.tenantId,async db=>{await (await import('../../db/governed-egress')).assertNativeEffectAdapterAdmission(db,actor.tenantId,{businessEffectId:claim.operation.businessEffectId,domainActionId:claim.operation.domainActionId},'DATABASE_ARTIFACT');},actor.employeeId??actor.userId);
  const decision = await evaluateAuthority(actor, {
    operation: "execution", capability: input.capability,
    resource: { type: "document", id: input.documentId }, risk: "medium",
  });
  ensure(decision.outcome === "allowed", decision.outcome === "approval_required"
    ? "ARTIFACT_DISPATCH_APPROVAL_REQUIRED" : "ARTIFACT_DISPATCH_AUTHORITY_DENIED");
  await withTenant(actor.tenantId, async db => {
    const owned = await db.execute(sql`
      SELECT o.id FROM finnor_os.external_operations o
      JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=o.tenant_id AND a.external_operation_id=o.id
      WHERE o.tenant_id=${actor.tenantId}::uuid AND o.id=${claim.operation.id}::uuid
        AND o.owner_type='artifact_operation' AND o.owner_key=${claim.operation.ownerKey}
        AND o.operation_key=${claim.operation.operationKey} AND o.request_hash=${input.requestHash}
        AND o.provider='microsoft_graph' AND o.integration_id=${claim.operation.integrationId}::uuid
        AND o.target_key=${claim.operation.targetKey} AND o.status='running'
        AND o.execution_state IN ('claimed','provider_in_flight')
        AND a.id=${claim.providerOperationAttemptId}::uuid AND a.claim_token=${claim.providerOperationClaimToken}::uuid
        AND a.status IN ('claimed','provider_in_flight')
    `);
    ensure(owned.rows.length === 1, "ARTIFACT_DISPATCH_FENCE_LOST");
    await input.validateOwner(db);
    await recordBusinessEvent(db, {
      tenantId: actor.tenantId, entityType: "document", entityId: input.documentId,
      eventType: "artifact_dispatch_authorized", source: "artifact_operation",
      payload: { capability: input.capability, authorityDecisionId: decision.id,
        providerOperationId: claim.operation.id, providerOperationAttemptId: claim.providerOperationAttemptId,
        requestHash: input.requestHash, ...(input.invocationId ? { providerInvocationId: input.invocationId } : {}),
        boundary: input.invocationId ? "physical_request" : "adapter_entry" },
    });
  });
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
  /** Native owner check, repeated before every physical request's egress marker. */
  beforeConsequentialDispatch: (invocationId: string) => Promise<void>;
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
      if (!contexts.has(invocationId)) throw new Error("Microsoft Graph invocation audit context is missing");
      await input.beforeConsequentialDispatch(invocationId);
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
