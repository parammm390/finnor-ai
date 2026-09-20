// Canonical logical-provider-operation ledger. Scope-1 DomainAction is the normal
// semantic owner; narrowly-scoped runtime substrates can use an explicit non-domain
// owner rather than fabricating a competing ExecutionAttempt. PostgreSQL serializes
// concurrent claims and every consequential physical request gets its own invocation.

import { withTenant, externalOperations, providerOperationAttempts, providerInvocations, tenantIntegrations, authProfiles, jobs, reconciliationCases } from "@finnor/db";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { redactStructured } from "@finnor/security";
import { createHash, randomUUID } from "node:crypto";

export type ExternalOperationRow = typeof externalOperations.$inferSelect;

export type ProviderIdempotencyMode = "provider_key" | "readback" | "inherently_idempotent" | "none" | "unknown";
export type ProviderRetrySafety = "first_invocation_only" | "provider_idempotent" | "readback_required" | "repeatable" | "prohibited" | "unknown";

export interface ExternalOperationContract {
  protocolVersion?: number;
  targetKey?: string;
  workflowStepClaimId?: string;
  /** Exact tenant integration selected by the already-authorized caller. This is
   * required when a tenant can bind more than one account for the same provider. */
  integrationId?: string;
  retrySafety: ProviderRetrySafety;
  verification?: "acknowledgement" | "readback" | "webhook_or_readback" | "none";
  /** Control-plane operations pin an exact integration but may not depend on
   * source-data freshness while repairing that integration itself. */
  sourceTruthRequired?: boolean;
  idempotency: {
    mode: ProviderIdempotencyMode;
    scope?: string;
    /** Guaranteed protection window only. Omit when the provider makes no promise. */
    ttlMs?: number;
  };
}

export type ExternalOperationOwner =
  | { type: "domain_action"; key: string; domainActionId: string }
  | { type: "integration_subscription" | "computer_run" | "artifact_operation" | "system_job"; key: string };

export interface ClaimedProviderOperation {
  operation: ExternalOperationRow;
  providerOperationAttemptId: string;
  providerOperationClaimToken: string;
}

export type ClaimResult = ({ claimed: true } & ClaimedProviderOperation) | { claimed: false; existing: ExternalOperationRow };

export interface ProviderInvocationContext {
  tenantId: string;
  providerOperationAttemptId: string;
  provider: string;
  integrationId?: string;
  requestHash: string;
  providerIdempotencyKey?: string;
  providerIdempotencyScope?: string;
  providerIdempotencyExpiresAt?: Date;
  transportLayer?: "wrapped_call" | "sdk" | "http_client" | "provider_adapter" | "fake_provider";
}

export const ACCOUNT_BOUND_PROVIDERS = new Set([
  "ghl", "quickbooks", "stripe", "vapi", "docusign", "gmail", "resend", "meta_ads", "google_ads", "microsoft_graph",
]);

export async function claimOwnedExternalOperation(
  tenantId: string,
  owner: ExternalOperationOwner,
  operationKey: string,
  requestHash: string,
  provider?: string,
  businessEffectId?: string,
  authProfileRef?: string,
  contract: ExternalOperationContract = { retrySafety: "unknown", idempotency: { mode: "unknown" } },
): Promise<ClaimResult> {
  return withTenant(tenantId, async (db) => {
    const domainActionId = owner.type === "domain_action" ? owner.domainActionId : null;
    if (!owner.key.trim() || (owner.type === "domain_action" && owner.key !== owner.domainActionId)) {
      throw new Error("External operation owner identity is invalid");
    }
    let integrationId: string | null = null;
    if (provider && ACCOUNT_BOUND_PROVIDERS.has(provider)) {
      const candidates = contract.integrationId
        ? await db.select({
            id: tenantIntegrations.id,
            health: tenantIntegrations.health,
            syncStatus: tenantIntegrations.syncStatus,
            reconciliationStatus: tenantIntegrations.reconciliationStatus,
            syncInitializedAt: tenantIntegrations.syncInitializedAt,
            lastSuccessfulSyncAt: tenantIntegrations.lastSuccessfulSyncAt,
            sourcePolicy: tenantIntegrations.sourcePolicy,
            freshnessPolicy: tenantIntegrations.freshnessPolicy,
          }).from(tenantIntegrations).where(and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.id, contract.integrationId),
            eq(tenantIntegrations.binding, provider),
          )).limit(2)
        : authProfileRef
        ? await db.select({
            id: tenantIntegrations.id,
            health: tenantIntegrations.health,
            syncStatus: tenantIntegrations.syncStatus,
            reconciliationStatus: tenantIntegrations.reconciliationStatus,
            syncInitializedAt: tenantIntegrations.syncInitializedAt,
            lastSuccessfulSyncAt: tenantIntegrations.lastSuccessfulSyncAt,
            sourcePolicy: tenantIntegrations.sourcePolicy,
            freshnessPolicy: tenantIntegrations.freshnessPolicy,
          }).from(tenantIntegrations).innerJoin(authProfiles, and(
            eq(authProfiles.tenantId, tenantId),
            eq(authProfiles.id, tenantIntegrations.authProfileId),
            eq(authProfiles.authProfileRef, authProfileRef),
          )).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.binding, provider))).limit(2)
        : await db.select({
            id: tenantIntegrations.id,
            health: tenantIntegrations.health,
            syncStatus: tenantIntegrations.syncStatus,
            reconciliationStatus: tenantIntegrations.reconciliationStatus,
            syncInitializedAt: tenantIntegrations.syncInitializedAt,
            lastSuccessfulSyncAt: tenantIntegrations.lastSuccessfulSyncAt,
            sourcePolicy: tenantIntegrations.sourcePolicy,
            freshnessPolicy: tenantIntegrations.freshnessPolicy,
          }).from(tenantIntegrations).where(and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.binding, provider),
          )).limit(2);
      if (candidates.length !== 1) throw new Error(`External operation requires one exact tenant integration/account for ${provider}`);
      const integration = candidates[0]!;
      if (contract.sourceTruthRequired !== false
          && (integration.health === "down" || integration.syncStatus === "blocked" || integration.reconciliationStatus === "blocked")) {
        throw new Error(`External operation refused because ${provider} source truth is blocked or unavailable`);
      }
      const source = integration.sourcePolicy && typeof integration.sourcePolicy === "object" && !Array.isArray(integration.sourcePolicy)
        ? integration.sourcePolicy as Record<string, unknown> : {};
      const freshness = integration.freshnessPolicy && typeof integration.freshnessPolicy === "object" && !Array.isArray(integration.freshnessPolicy)
        ? integration.freshnessPolicy as Record<string, unknown> : {};
      const requiresFresh = source.requireFreshBeforeEffect === true
        || freshness.requireFreshBeforeEffect === true
        || freshness.criticality === "consequential"
        || freshness.staleBehavior === "refresh_then_block";
      const maxAgeSeconds = typeof freshness.maxAgeSeconds === "number" && freshness.maxAgeSeconds > 0
        ? freshness.maxAgeSeconds : null;
      if (contract.sourceTruthRequired !== false && requiresFresh && (!integration.syncInitializedAt || !integration.lastSuccessfulSyncAt)) {
        throw new Error(`External operation refused because ${provider} has not completed its required initial synchronization`);
      }
      if (contract.sourceTruthRequired !== false && requiresFresh && maxAgeSeconds !== null && integration.lastSuccessfulSyncAt
          && Date.now() - integration.lastSuccessfulSyncAt.getTime() > maxAgeSeconds * 1000) {
        await db.update(tenantIntegrations).set({ freshnessState: "stale", syncStatus: "degraded", updatedAt: new Date() }).where(and(
          eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integration.id),
        ));
        throw new Error(`External operation refused because ${provider} source truth is stale`);
      }
      integrationId = integration.id;
    }
    const providerIdempotencyKey = contract.idempotency.mode === "provider_key"
      ? `finnor_${createHash("sha256").update(`${tenantId}:${owner.type}:${owner.key}:${operationKey}:${requestHash}`).digest("hex")}`
      : null;
    const providerIdempotencyExpiresAt = providerIdempotencyKey && contract.idempotency.ttlMs
      ? new Date(Date.now() + contract.idempotency.ttlMs)
      : null;

    const createAttempt = async (
      operation: ExternalOperationRow,
      authorizationBasis: "initial" | "provider_idempotency" | "verified_absent" | "definite_pre_dispatch_failure" | "definite_rejection" | "inherently_repeatable" | "operator_resolution",
    ): Promise<ClaimResult> => {
      const [latest] = await db.select({ ordinal: providerOperationAttempts.ordinal })
        .from(providerOperationAttempts)
        .where(and(
          eq(providerOperationAttempts.tenantId, tenantId),
          eq(providerOperationAttempts.externalOperationId, operation.id),
        ))
        .orderBy(desc(providerOperationAttempts.ordinal))
        .limit(1);
      const claimToken = randomUUID();
      const [attempt] = await db.insert(providerOperationAttempts).values({
        tenantId,
        externalOperationId: operation.id,
        workflowStepClaimId: contract.workflowStepClaimId ?? null,
        ordinal: (latest?.ordinal ?? 0) + 1,
        protocolVersion: contract.protocolVersion ?? 2,
        authorizationBasis,
        status: "claimed",
        claimToken,
      }).returning({ id: providerOperationAttempts.id });
      if (!attempt) throw new Error("Provider-operation attempt could not be established safely");
      return {
        claimed: true,
        operation,
        providerOperationAttemptId: attempt.id,
        providerOperationClaimToken: claimToken,
      };
    };

    let existing: ExternalOperationRow | undefined;
    for (let attempt = 0; attempt < 2 && !existing; attempt += 1) {
      const [row] = await db
        .insert(externalOperations)
        .values({
          tenantId,
          domainActionId,
          ownerType: owner.type,
          ownerKey: owner.key,
          businessEffectId: businessEffectId ?? null,
          integrationId,
          operationKey,
          provider: provider ?? null,
          requestHash,
          status: "running",
          protocolVersion: contract.protocolVersion ?? 2,
          targetKey: contract.targetKey ?? null,
          executionState: "claimed",
          retrySafety: contract.retrySafety,
          providerIdempotencyMode: contract.idempotency.mode,
          providerIdempotencyKey,
          providerIdempotencyScope: contract.idempotency.scope ?? null,
          providerIdempotencyExpiresAt,
          verificationMode: contract.verification ?? "readback",
          historyComplete: true,
        })
        .onConflictDoNothing({ target: [externalOperations.tenantId, externalOperations.ownerType, externalOperations.ownerKey, externalOperations.operationKey] })
        .returning();
      if (row) return createAttempt(row, "initial");
      [existing] = await db
        .select()
        .from(externalOperations)
        .where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.ownerType, owner.type),
          eq(externalOperations.ownerKey, owner.key),
          eq(externalOperations.operationKey, operationKey),
        ));
    }
    // Never execute a consequential provider call without owning a durable claim.
    // READ COMMITTED should reveal a conflict winner to the following SELECT; if an
    // administrative delete or an unexpected visibility fault prevents that, fail
    // closed instead of letting two callers dispatch the same effect.
    if (!existing) throw new Error("External operation claim could not be established safely");
    if ((existing.businessEffectId ?? null) !== (businessEffectId ?? null)) {
      throw new Error("External operation effect conflict: refusing to reuse an idempotency claim for a different Business Effect");
    }
    if (existing.requestHash !== requestHash) return { claimed: false, existing };

    // Serialize the retry decision. A mutable failed -> running transition is legal
    // only when durable evidence proves another physical invocation cannot duplicate
    // an unresolved effect. Historical rows lack complete invocation history and are
    // therefore never guessed safe.
    if (existing.status === "failed" || existing.status === "unknown") {
      const priorStatus = existing.status;
      await db.execute(sql`SELECT id FROM ${externalOperations}
        WHERE ${externalOperations.tenantId}=${tenantId}
          AND ${externalOperations.ownerType}=${owner.type}
          AND ${externalOperations.ownerKey}=${owner.key}
          AND ${externalOperations.operationKey}=${operationKey} FOR UPDATE`);
      const [locked] = await db.select().from(externalOperations).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.ownerType, owner.type),
        eq(externalOperations.ownerKey, owner.key),
        eq(externalOperations.operationKey, operationKey),
      )).limit(1);
      if (!locked || locked.status !== priorStatus) return { claimed: false, existing: locked ?? existing };
      const [lastAttempt] = await db.select({
        id: providerOperationAttempts.id,
        status: providerOperationAttempts.status,
        outcomeDetail: providerOperationAttempts.outcomeDetail,
      })
        .from(providerOperationAttempts)
        .where(and(
          eq(providerOperationAttempts.tenantId, tenantId),
          eq(providerOperationAttempts.externalOperationId, locked.id),
        )).orderBy(desc(providerOperationAttempts.ordinal)).limit(1);
      const [lastInvocation] = lastAttempt
        ? await db.select({ outcome: providerInvocations.outcome })
            .from(providerInvocations)
            .where(and(
              eq(providerInvocations.tenantId, tenantId),
              eq(providerInvocations.providerOperationAttemptId, lastAttempt.id),
            )).orderBy(desc(providerInvocations.ordinal)).limit(1)
        : [];
      const idempotencyStillGuaranteed = locked.providerIdempotencyMode === "provider_key"
        && Boolean(locked.providerIdempotencyKey)
        && locked.providerIdempotencyExpiresAt !== null
        && locked.providerIdempotencyExpiresAt.getTime() > Date.now();
      const definitePreDispatch = locked.status === "failed" && locked.historyComplete
        && lastInvocation?.outcome === "definite_pre_dispatch_failure";
      const definiteRejection = locked.status === "failed" && locked.historyComplete
        && lastInvocation?.outcome === "definite_rejection";
      const noPhysicalInvocation = locked.status === "failed" && locked.historyComplete
        && !lastInvocation && lastAttempt?.status === "known_failed"
        && Boolean(lastAttempt.outcomeDetail && typeof lastAttempt.outcomeDetail === "object"
          && (lastAttempt.outcomeDetail as Record<string, unknown>).noPhysicalInvocation === true);
      const verifiedAbsent = locked.executionState === "reconciled"
        && Boolean(locked.response && typeof locked.response === "object"
          && (locked.response as Record<string, unknown>).reconciliationOutcome === "definitely_did_not_happen");
      const inherentlyRepeatable = locked.historyComplete
        && (locked.retrySafety === "repeatable" || locked.providerIdempotencyMode === "inherently_idempotent");
      const authorizationBasis = idempotencyStillGuaranteed ? "provider_idempotency" as const
        : verifiedAbsent ? "verified_absent" as const
          : definitePreDispatch || noPhysicalInvocation ? "definite_pre_dispatch_failure" as const
            : definiteRejection ? "definite_rejection" as const
              : inherentlyRepeatable ? "inherently_repeatable" as const
                : null;
      if (!authorizationBasis) {
        if (locked.status === "unknown") return { claimed: false, existing: locked };
        const [blocked] = await db.update(externalOperations).set({
            status: "unknown",
            executionState: "reconciliation_required",
            verificationStatus: "unknown",
            version: sql`${externalOperations.version} + 1`,
            updatedAt: new Date(),
          }).where(and(
            eq(externalOperations.tenantId, tenantId),
            eq(externalOperations.id, locked.id),
            eq(externalOperations.status, "failed"),
          )).returning();
        return { claimed: false, existing: blocked ?? locked };
      }
      const [reclaimed] = await db
        .update(externalOperations)
        .set({
          status: "running",
          executionState: "claimed",
          requestHash,
          ...(provider ? { provider } : {}),
          version: sql`${externalOperations.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.id, locked.id),
          eq(externalOperations.status, priorStatus),
        ))
        .returning();
      if (reclaimed) return createAttempt(reclaimed, authorizationBasis);
      const [refetched] = await db
        .select()
        .from(externalOperations)
        .where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.ownerType, owner.type),
          eq(externalOperations.ownerKey, owner.key),
          eq(externalOperations.operationKey, operationKey),
        ));
      return { claimed: false, existing: refetched ?? existing } as const;
    }
    return { claimed: false, existing } as const;
  });
}

/** Scope-1-compatible facade. DomainAction remains the semantic owner; the generic
 * owner form above exists only for tenant runtime substrates that have no legitimate
 * DomainAction and must not fabricate one. */
export function claimExternalOperation(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  requestHash: string,
  provider?: string,
  businessEffectId?: string,
  authProfileRef?: string,
  contract: ExternalOperationContract = { retrySafety: "unknown", idempotency: { mode: "unknown" } },
): Promise<ClaimResult> {
  return claimOwnedExternalOperation(
    tenantId,
    { type: "domain_action", key: domainActionId, domainActionId },
    operationKey,
    requestHash,
    provider,
    businessEffectId,
    authProfileRef,
    contract,
  );
}

/**
 * A losing concurrent claim can observe the winner's row while it's still `status:
 * "running"` — that's not a failure, the winner just hasn't finished yet. Poll briefly
 * for it to settle rather than reporting a false "not ok" for a call that's actually
 * still in progress. Bounded (2s) so a genuinely stuck row (e.g. the winner's process
 * crashed mid-call) doesn't hang the loser forever.
 */
export async function awaitOwnedExternalOperationResolution(
  tenantId: string,
  row: ExternalOperationRow,
): Promise<ExternalOperationRow> {
  let current = row;
  const deadline = Date.now() + 2_000;
  while (current.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const fresh = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(externalOperations)
        .where(and(eq(externalOperations.tenantId, tenantId), eq(externalOperations.id, row.id))),
    );
    if (fresh[0]) current = fresh[0];
  }
  return current;
}

export function awaitExternalOperationResolution(
  tenantId: string,
  _domainActionId: string,
  _operationKey: string,
  row: ExternalOperationRow,
): Promise<ExternalOperationRow> {
  return awaitOwnedExternalOperationResolution(tenantId, row);
}

export async function readOwnedExternalOperation(
  tenantId: string,
  owner: ExternalOperationOwner,
  operationKey: string,
): Promise<ExternalOperationRow | null> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(externalOperations).where(and(
    eq(externalOperations.tenantId, tenantId),
    eq(externalOperations.ownerType, owner.type),
    eq(externalOperations.ownerKey, owner.key),
    eq(externalOperations.operationKey, operationKey),
  )).limit(1));
  return row ?? null;
}

/** Persist physical invocation identity before the adapter is allowed to run. */
export async function prepareProviderInvocation(
  context: ProviderInvocationContext,
  ordinal: number,
): Promise<string> {
  return withTenant(context.tenantId, async (db) => {
    const [attempt] = await db.select({
      externalOperationId: providerOperationAttempts.externalOperationId,
    })
      .from(providerOperationAttempts)
      .where(and(
        eq(providerOperationAttempts.tenantId, context.tenantId),
        eq(providerOperationAttempts.id, context.providerOperationAttemptId),
      )).limit(1);
    if (!attempt) throw new Error("Provider invocation lacks a tenant-scoped operation attempt");
    const [ownedAttempt] = await db.update(providerOperationAttempts).set({ status: "provider_in_flight" }).where(and(
      eq(providerOperationAttempts.tenantId, context.tenantId),
      eq(providerOperationAttempts.id, context.providerOperationAttemptId),
      eq(providerOperationAttempts.status, "claimed"),
    )).returning({ id: providerOperationAttempts.id });
    if (!ownedAttempt) throw new Error("Provider-operation attempt lost its execution fence before invocation preparation");
    const [invocation] = await db.insert(providerInvocations).values({
      tenantId: context.tenantId,
      providerOperationAttemptId: context.providerOperationAttemptId,
      ordinal,
      provider: context.provider,
      integrationId: context.integrationId ?? null,
      transportLayer: context.transportLayer ?? "wrapped_call",
      requestHash: context.requestHash,
      providerIdempotencyKey: context.providerIdempotencyKey ?? null,
      providerIdempotencyScope: context.providerIdempotencyScope ?? null,
      providerIdempotencyExpiresAt: context.providerIdempotencyExpiresAt ?? null,
      outcome: "prepared",
    }).returning({ id: providerInvocations.id });
    if (!invocation) throw new Error("Physical provider invocation identity was not persisted");
    const [ownedOperation] = await db.update(externalOperations).set({
      executionState: "provider_in_flight",
      updatedAt: new Date(),
    }).where(and(
      eq(externalOperations.tenantId, context.tenantId),
      eq(externalOperations.id, attempt.externalOperationId),
      eq(externalOperations.executionState, "claimed"),
    )).returning({ id: externalOperations.id });
    if (!ownedOperation) throw new Error("Logical provider operation lost its execution fence before invocation preparation");
    return invocation.id;
  });
}

/** Called immediately before entering the provider adapter. This is intentionally
 * conservative: a crash afterward is a tracked possible effect, never a silent one. */
export async function markProviderRequestMayHaveLeft(tenantId: string, invocationId: string): Promise<void> {
  const marked = await withTenant(tenantId, async (db) => {
    const [row] = await db.update(providerInvocations).set({
      outcome: "request_may_have_left",
      requestMayHaveLeftAt: new Date(),
    }).where(and(
      eq(providerInvocations.tenantId, tenantId),
      eq(providerInvocations.id, invocationId),
      eq(providerInvocations.outcome, "prepared"),
      sql`EXISTS (
        SELECT 1 FROM ${providerOperationAttempts} a
         WHERE a.id=${providerInvocations.providerOperationAttemptId}
           AND a.tenant_id=${tenantId}::uuid
           AND a.status='provider_in_flight'
      )`,
    )).returning({ id: providerInvocations.id });
    return row ?? null;
  });
  if (!marked) throw new Error("Provider invocation lost its durable attempt fence before request egress");
}

export interface StaleProviderOperationRecovery {
  inspected: number;
  knownFailedBeforeEgress: number;
  acknowledgementResumed: number;
  reconciliationRequired: number;
  operationIds: string[];
}

/** Classify provider work abandoned by a dead process from durable facts only.
 * `prepared` or no physical invocation proves pre-egress failure; any recorded
 * possible egress becomes unknown + reconciliation. A durable provider receipt can
 * resume acknowledgement bookkeeping without issuing another request. */
export async function recoverStaleProviderOperations(
  tenantId: string,
  options: { staleBefore?: Date; limit?: number } = {},
): Promise<StaleProviderOperationRecovery> {
  const staleBefore = options.staleBefore ?? new Date(Date.now() - 10 * 60_000);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return withTenant(tenantId, async (db) => {
    const candidates = await db.select().from(externalOperations).where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.status, "running"),
      inArray(externalOperations.executionState, ["claimed", "provider_in_flight", "provider_acknowledged"]),
      lte(externalOperations.updatedAt, staleBefore),
    )).orderBy(asc(externalOperations.updatedAt), asc(externalOperations.id)).limit(limit);
    const result: StaleProviderOperationRecovery = {
      inspected: 0,
      knownFailedBeforeEgress: 0,
      acknowledgementResumed: 0,
      reconciliationRequired: 0,
      operationIds: [],
    };
    for (const candidate of candidates) {
      const locked = await db.execute<{ id: string }>(sql`
        SELECT id FROM ${externalOperations}
         WHERE tenant_id=${tenantId}::uuid AND id=${candidate.id}::uuid
           AND status='running' AND updated_at <= ${staleBefore}
         FOR UPDATE SKIP LOCKED
      `);
      if (locked.rows.length === 0) continue;
      const [attempt] = await db.select().from(providerOperationAttempts).where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.externalOperationId, candidate.id),
      )).orderBy(desc(providerOperationAttempts.ordinal)).limit(1);
      const [invocation] = attempt ? await db.select().from(providerInvocations).where(and(
        eq(providerInvocations.tenantId, tenantId),
        eq(providerInvocations.providerOperationAttemptId, attempt.id),
      )).orderBy(desc(providerInvocations.ordinal)).limit(1) : [];
      result.inspected += 1;
      result.operationIds.push(candidate.id);

      const failBeforeEgress = candidate.historyComplete
        && Boolean(attempt)
        && (!invocation || invocation.outcome === "prepared" || invocation.outcome === "definite_pre_dispatch_failure");
      if (failBeforeEgress) {
        const settledAt = new Date();
        if (invocation) await db.update(providerInvocations).set({
          outcome: "definite_pre_dispatch_failure",
          requestMayHaveLeftAt: null,
          finishedAt: settledAt,
          failureKind: "worker_crash_before_provider_egress",
          receipt: { reason: "durable invocation remained prepared when its owner was lost" },
        }).where(and(
          eq(providerInvocations.tenantId, tenantId),
          eq(providerInvocations.id, invocation.id),
          inArray(providerInvocations.outcome, ["prepared", "definite_pre_dispatch_failure"]),
        ));
        await db.update(providerOperationAttempts).set({
          status: "known_failed",
          finishedAt: settledAt,
          outcomeDetail: invocation
            ? { failureKind: "worker_crash_before_provider_egress" }
            : { failureKind: "worker_crash_before_invocation_preparation", noPhysicalInvocation: true },
        }).where(and(
          eq(providerOperationAttempts.tenantId, tenantId),
          eq(providerOperationAttempts.id, attempt!.id),
          inArray(providerOperationAttempts.status, ["claimed", "provider_in_flight"]),
        ));
        await db.update(externalOperations).set({
          status: "failed",
          executionState: "known_failed",
          verificationStatus: "not_required",
          response: { failureKind: "worker_crash_before_provider_egress" },
          version: sql`${externalOperations.version} + 1`,
          updatedAt: settledAt,
        }).where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.id, candidate.id),
          eq(externalOperations.status, "running"),
        ));
        result.knownFailedBeforeEgress += 1;
        continue;
      }

      if (attempt && invocation?.outcome === "provider_acknowledged" && invocation.receipt
          && typeof invocation.receipt === "object" && !Array.isArray(invocation.receipt)) {
        const acknowledgedAt = invocation.providerAcknowledgedAt ?? invocation.finishedAt ?? new Date();
        const requiresObservation = candidate.verificationMode === "readback"
          || candidate.verificationMode === "webhook_or_readback";
        const receipt = invocation.receipt as Record<string, unknown>;
        await db.update(providerOperationAttempts).set({
          status: requiresObservation ? "awaiting_observation" : "verified",
          finishedAt: requiresObservation ? null : acknowledgedAt,
          outcomeDetail: receipt,
        }).where(and(
          eq(providerOperationAttempts.tenantId, tenantId),
          eq(providerOperationAttempts.id, attempt.id),
          inArray(providerOperationAttempts.status, ["claimed", "provider_in_flight", "provider_acknowledged"]),
        ));
        await db.update(externalOperations).set({
          status: "succeeded",
          response: receipt,
          executionState: requiresObservation ? "awaiting_observation" : "verified",
          providerAcknowledgedAt: acknowledgedAt,
          externalObservedAt: requiresObservation ? null : acknowledgedAt,
          verificationStatus: requiresObservation ? "awaiting_observation" : "verified",
          verifiedAt: requiresObservation ? null : acknowledgedAt,
          version: sql`${externalOperations.version} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(externalOperations.tenantId, tenantId),
          eq(externalOperations.id, candidate.id),
          eq(externalOperations.status, "running"),
        ));
        if (requiresObservation && candidate.businessEffectId && candidate.domainActionId) {
          await db.insert(jobs).values({
            tenantId,
            type: "observe_external_effect",
            payload: { tenantId, externalOperationKey: candidate.operationKey, domainActionId: candidate.domainActionId, attempt: 1 },
            idempotencyKey: `observe-effect:${tenantId}:${candidate.domainActionId}:${candidate.operationKey}:1`,
            lane: "batch",
            priority: 0,
            protocolVersion: 1,
            retrySafety: "locally_idempotent",
          }).onConflictDoNothing({ target: jobs.idempotencyKey });
        }
        result.acknowledgementResumed += 1;
        continue;
      }

      const settledAt = new Date();
      if (attempt) await db.update(providerOperationAttempts).set({
        status: "reconciliation_required",
        finishedAt: settledAt,
        outcomeDetail: { failureKind: "worker_crash_after_possible_provider_egress" },
      }).where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.id, attempt.id),
        inArray(providerOperationAttempts.status, ["claimed", "provider_in_flight", "provider_acknowledged", "unknown_outcome"]),
      ));
      if (invocation && invocation.outcome === "request_may_have_left") await db.update(providerInvocations).set({
        outcome: "unknown_outcome",
        finishedAt: settledAt,
        failureKind: "worker_crash_after_possible_provider_egress",
        receipt: { reason: "request may have left FINNOR before worker ownership was lost" },
      }).where(and(
        eq(providerInvocations.tenantId, tenantId),
        eq(providerInvocations.id, invocation.id),
        eq(providerInvocations.outcome, "request_may_have_left"),
      ));
      await db.update(externalOperations).set({
        status: "unknown",
        executionState: "reconciliation_required",
        verificationStatus: "unknown",
        response: { failureKind: "worker_crash_after_possible_provider_egress" },
        version: sql`${externalOperations.version} + 1`,
        updatedAt: settledAt,
      }).where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.id, candidate.id),
        eq(externalOperations.status, "running"),
      ));
      const [openCase] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
        eq(reconciliationCases.tenantId, tenantId),
        eq(reconciliationCases.relatedExternalOperationId, candidate.id),
        eq(reconciliationCases.status, "open"),
      )).limit(1);
      if (!openCase) await db.insert(reconciliationCases).values({
        tenantId,
        caseType: "unknown_delivery",
        relatedExternalOperationId: candidate.id,
        businessEffectId: candidate.businessEffectId,
        integrationId: candidate.integrationId,
        classification: "provider_invocation_owner_lost",
        authoritativeSide: "external",
        details: {
          provider: candidate.provider,
          operationKey: candidate.operationKey,
          invocationOutcome: invocation?.outcome ?? null,
          requestMayHaveLeftAt: invocation?.requestMayHaveLeftAt?.toISOString() ?? null,
          recovery: "readback_or_governed_resolution_required_before_repetition",
        },
      });
      result.reconciliationRequired += 1;
    }
    return result;
  });
}

function providerRequestId(output: Record<string, unknown>): string | null {
  for (const key of ["id", "messageId", "callId", "requestId", "envelopeId", "externalRecordId"]) {
    if (typeof output[key] === "string" && output[key]) return output[key];
  }
  return null;
}

const GOVERNED_PROVIDER_IDENTIFIER_KEYS = [
  "id", "contactId", "messageId", "callId", "communicationIdentityId", "documentId",
  "taskId", "dealId", "companyId", "partyId", "externalRecordId", "linkId", "envelopeId",
] as const;

function durableProviderReceipt(output: Record<string, unknown>): Record<string, unknown> {
  const receipt = redactStructured(output) as Record<string, unknown>;
  // Stable opaque provider identifiers are not contact content or credentials; they
  // are the governed handles needed for exact readback and safe crash recovery.
  for (const key of GOVERNED_PROVIDER_IDENTIFIER_KEYS) {
    if (typeof output[key] === "string") receipt[key] = output[key];
  }
  return receipt;
}

export async function recordProviderInvocationAcknowledged(
  context: ProviderInvocationContext,
  invocationId: string,
  output: Record<string, unknown>,
  options: { advanceLogicalOperation?: boolean } = {},
): Promise<void> {
  const receipt = durableProviderReceipt(output);
  const requestId = providerRequestId(output);
  if (requestId) receipt.providerRequestId = requestId;
  await withTenant(context.tenantId, async (db) => {
    if (options.advanceLogicalOperation === false) {
      await db.update(providerInvocations).set({
        outcome: "provider_acknowledged",
        providerAcknowledgedAt: new Date(),
        finishedAt: new Date(),
        providerRequestId: requestId,
        receipt,
      }).where(and(
        eq(providerInvocations.tenantId, context.tenantId),
        eq(providerInvocations.id, invocationId),
        eq(providerInvocations.providerOperationAttemptId, context.providerOperationAttemptId),
      ));
      return;
    }
    const [attempt] = await db.select({
      externalOperationId: providerOperationAttempts.externalOperationId,
      status: providerOperationAttempts.status,
    }).from(providerOperationAttempts).where(and(
      eq(providerOperationAttempts.tenantId, context.tenantId),
      eq(providerOperationAttempts.id, context.providerOperationAttemptId),
    )).limit(1);
    if (!attempt) throw new Error("Provider acknowledgement lacks its tenant-scoped operation attempt");
    const [operation] = await db.select().from(externalOperations).where(and(
      eq(externalOperations.tenantId, context.tenantId),
      eq(externalOperations.id, attempt.externalOperationId),
    )).limit(1);
    if (!operation) throw new Error("Provider acknowledgement lacks its logical operation");
    const acknowledgedAt = new Date();
    const requiresObservation = operation.verificationMode === "readback"
      || operation.verificationMode === "webhook_or_readback";
    await db.update(providerInvocations).set({
      outcome: "provider_acknowledged",
      providerAcknowledgedAt: acknowledgedAt,
      finishedAt: acknowledgedAt,
      providerRequestId: requestId,
      receipt,
    }).where(and(
      eq(providerInvocations.tenantId, context.tenantId),
      eq(providerInvocations.id, invocationId),
      eq(providerInvocations.providerOperationAttemptId, context.providerOperationAttemptId),
    ));
    const [advancedAttempt] = await db.update(providerOperationAttempts).set({
      status: requiresObservation ? "awaiting_observation" : "verified",
      finishedAt: requiresObservation ? null : acknowledgedAt,
      outcomeDetail: receipt,
    }).where(and(
      eq(providerOperationAttempts.tenantId, context.tenantId),
      eq(providerOperationAttempts.id, context.providerOperationAttemptId),
      sql`${providerOperationAttempts.status} IN ('claimed','provider_in_flight','provider_acknowledged')`,
    )).returning({ id: providerOperationAttempts.id });
    if (!advancedAttempt) return;
    await db.update(externalOperations).set({
      status: "succeeded",
      response: receipt,
      executionState: requiresObservation ? "awaiting_observation" : "verified",
      providerAcknowledgedAt: acknowledgedAt,
      externalObservedAt: requiresObservation ? null : acknowledgedAt,
      verificationStatus: requiresObservation ? "awaiting_observation" : "verified",
      verifiedAt: requiresObservation ? null : acknowledgedAt,
      version: sql`${externalOperations.version} + 1`,
      updatedAt: acknowledgedAt,
    }).where(and(
      eq(externalOperations.tenantId, context.tenantId),
      eq(externalOperations.id, attempt.externalOperationId),
      sql`${externalOperations.executionState} NOT IN ('verified','reconciled','compensated')`,
    ));
    // Provider ACK/result persistence and the durable readback request are one
    // transaction. A process death can therefore leave neither half-committed nor
    // an acknowledged effect stranded without an observation recovery path.
    if (requiresObservation && operation.businessEffectId && operation.domainActionId) {
      await db.insert(jobs).values({
        tenantId: context.tenantId,
        type: "observe_external_effect",
        payload: {
          tenantId: context.tenantId,
          externalOperationKey: operation.operationKey,
          domainActionId: operation.domainActionId,
          attempt: 1,
        },
        idempotencyKey: `observe-effect:${context.tenantId}:${operation.domainActionId}:${operation.operationKey}:1`,
        lane: "batch",
        priority: 0,
        protocolVersion: 1,
        retrySafety: "locally_idempotent",
      }).onConflictDoNothing({ target: jobs.idempotencyKey });
    }
  });
}

export async function recordProviderInvocationFailure(
  context: ProviderInvocationContext,
  invocationId: string,
  failure: {
    kind: string;
    message: string;
    definitePreDispatch: boolean;
    definiteRejection?: boolean;
    advanceLogicalOperation?: boolean;
  },
): Promise<void> {
  const knownFailure = failure.definitePreDispatch || failure.definiteRejection === true;
  const outcome = failure.definitePreDispatch
    ? "definite_pre_dispatch_failure" as const
    : failure.definiteRejection
      ? "definite_rejection" as const
      : "unknown_outcome" as const;
  await withTenant(context.tenantId, async (db) => {
    if (failure.advanceLogicalOperation === false) {
      await db.update(providerInvocations).set({
        outcome,
        ...(failure.definitePreDispatch ? { requestMayHaveLeftAt: null } : {}),
        finishedAt: new Date(),
        failureKind: failure.kind,
        receipt: { message: failure.message },
      }).where(and(
        eq(providerInvocations.tenantId, context.tenantId),
        eq(providerInvocations.id, invocationId),
        eq(providerInvocations.providerOperationAttemptId, context.providerOperationAttemptId),
      ));
      return;
    }
    const [attempt] = await db.update(providerOperationAttempts).set({
      status: knownFailure ? "known_failed" : "unknown_outcome",
      finishedAt: new Date(),
      outcomeDetail: { failureKind: failure.kind, message: failure.message },
    }).where(and(
      eq(providerOperationAttempts.tenantId, context.tenantId),
      eq(providerOperationAttempts.id, context.providerOperationAttemptId),
    )).returning({ externalOperationId: providerOperationAttempts.externalOperationId });
    await db.update(providerInvocations).set({
      outcome,
      ...(failure.definitePreDispatch ? { requestMayHaveLeftAt: null } : {}),
      finishedAt: new Date(),
      failureKind: failure.kind,
      receipt: { message: failure.message },
    }).where(and(
      eq(providerInvocations.tenantId, context.tenantId),
      eq(providerInvocations.id, invocationId),
      eq(providerInvocations.providerOperationAttemptId, context.providerOperationAttemptId),
    ));
    if (attempt) await db.update(externalOperations).set({
      status: knownFailure ? "failed" : "unknown",
      executionState: knownFailure ? "known_failed" : "unknown_outcome",
      verificationStatus: knownFailure ? "not_required" : "unknown",
      version: sql`${externalOperations.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(externalOperations.tenantId, context.tenantId),
      eq(externalOperations.id, attempt.externalOperationId),
    ));
  });
}

export async function recordExternalOperationResult(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  status: "succeeded" | "failed" | "unknown",
  response: Record<string, unknown>,
  providerOperationAttemptId?: string,
): Promise<ExternalOperationRow | null> {
  const [operation] = await withTenant(tenantId, (db) => db.select({ id: externalOperations.id })
    .from(externalOperations)
    .where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.domainActionId, domainActionId),
      eq(externalOperations.operationKey, operationKey),
    ))
    .limit(1));
  if (!operation) return null;
  return recordOwnedExternalOperationResult(
    tenantId,
    operation.id,
    status,
    response,
    providerOperationAttemptId,
  );
}

export async function recordOwnedExternalOperationResult(
  tenantId: string,
  externalOperationId: string,
  status: "succeeded" | "failed" | "unknown",
  response: Record<string, unknown>,
  providerOperationAttemptId?: string,
): Promise<ExternalOperationRow | null> {
  const redacted = durableProviderReceipt(response);
  return withTenant(tenantId, async (db) => {
    const [operation] = await db.select().from(externalOperations).where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.id, externalOperationId),
    )).limit(1);
    if (!operation) return null;
    // The default acknowledgement hook persists the receipt, logical result and
    // readback job atomically. Its caller still invokes this function for API
    // compatibility; that second bookkeeping call must be a no-op, not a second
    // version transition that could obscure the real provider boundary.
    if (status === "succeeded" && operation.status === "succeeded"
        && ["awaiting_observation", "verified", "reconciled"].includes(operation.executionState)) {
      return operation;
    }
    const operationContract = {
      integrationId: operation.integrationId,
      verificationMode: operation.verificationMode,
      businessEffectId: operation.businessEffectId,
      domainActionId: operation.domainActionId,
      operationKey: operation.operationKey,
    };
    const requiresObservation = operationContract.verificationMode === "readback"
      || operationContract.verificationMode === "webhook_or_readback";
    const executionState = status === "succeeded"
      ? requiresObservation ? "awaiting_observation" as const : "verified" as const
      : status === "unknown" ? "reconciliation_required" as const : "known_failed" as const;
    const [row] = await db
      .update(externalOperations)
      // Cached results are replayed internally, but they are still durable business
      // data. Keep only the minimum structured result and redact direct identifiers
      // before persisting the ledger.
      .set({
        status,
        response: redacted,
        providerAcknowledgedAt: status === "succeeded" && requiresObservation ? new Date() : null,
        externalObservedAt: status === "succeeded" && !requiresObservation ? new Date() : null,
        verificationStatus: status === "succeeded"
          ? requiresObservation ? "awaiting_observation" : "verified"
          : status === "unknown" ? "unknown" : "not_required",
        executionState,
        verifiedAt: status === "succeeded" && !requiresObservation ? new Date() : null,
        version: sql`${externalOperations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(externalOperations.tenantId, tenantId), eq(externalOperations.id, externalOperationId)))
      .returning();
    if (providerOperationAttemptId) {
      await db.update(providerOperationAttempts).set({
        status: status === "succeeded"
          ? requiresObservation ? "awaiting_observation" : "verified"
          : status === "unknown" ? "reconciliation_required" : "known_failed",
        finishedAt: status === "succeeded" && requiresObservation ? null : new Date(),
        outcomeDetail: redacted,
      }).where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.id, providerOperationAttemptId),
        ...(row ? [eq(providerOperationAttempts.externalOperationId, row.id)] : []),
      ));
    }
    if (row && status === "succeeded" && requiresObservation
        && operationContract.businessEffectId && operationContract.domainActionId) {
      await db.insert(jobs).values({
        tenantId,
        type: "observe_external_effect",
        payload: {
          tenantId,
          externalOperationKey: operationContract.operationKey,
          domainActionId: operationContract.domainActionId,
          attempt: 1,
        },
        idempotencyKey: `observe-effect:${tenantId}:${operationContract.domainActionId}:${operationContract.operationKey}:1`,
        lane: "batch",
        priority: 0,
        protocolVersion: 1,
        retrySafety: "locally_idempotent",
      }).onConflictDoNothing({ target: jobs.idempotencyKey });
    }
    return row ?? null;
  });
}

/** Explicit provider reconciliation is the only way an unknown operation becomes a
 * known success/failure. The caller supplies provider evidence, which is redacted by
 * the same persistence path as ordinary results. */
export async function reconcileExternalOperation(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  status: "succeeded" | "failed",
  evidence: Record<string, unknown>,
): Promise<ExternalOperationRow> {
  const [operation] = await withTenant(tenantId, (db) => db.select({ id: externalOperations.id })
    .from(externalOperations)
    .where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.domainActionId, domainActionId),
      eq(externalOperations.operationKey, operationKey),
    ))
    .limit(1));
  if (!operation) throw new Error("External operation is not awaiting reconciliation");
  return reconcileOwnedExternalOperation(tenantId, operation.id, status, evidence);
}

export async function reconcileOwnedExternalOperation(
  tenantId: string,
  externalOperationId: string,
  status: "succeeded" | "failed",
  evidence: Record<string, unknown>,
): Promise<ExternalOperationRow> {
  const redacted = redactStructured(evidence) as Record<string, unknown>;
  return withTenant(tenantId, async (db) => {
    const [row] = await db
      .update(externalOperations)
      .set({
        status,
        response: {
          ...redacted,
          reconciliationOutcome: status === "succeeded" ? "happened_as_intended" : "definitely_did_not_happen",
        },
        executionState: "reconciled",
        verificationStatus: "verified",
        externalObservedAt: new Date(),
        verifiedAt: new Date(),
        version: sql`${externalOperations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(externalOperations.tenantId, tenantId),
        eq(externalOperations.id, externalOperationId),
        // Exact readback is stronger evidence than transport classification. It can
        // settle unknown/running work, verify an acknowledged success, or correct a
        // known rejection whose provider readback proves a different final truth.
        sql`${externalOperations.executionState} IN (
          'claimed','provider_in_flight','provider_acknowledged','awaiting_observation',
          'unknown_outcome','reconciliation_required','known_failed'
        )`,
      ))
      .returning();
    if (!row) throw new Error("External operation is not awaiting reconciliation");
    const [latestAttempt] = await db.select({ id: providerOperationAttempts.id })
      .from(providerOperationAttempts)
      .where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.externalOperationId, row.id),
      ))
      .orderBy(desc(providerOperationAttempts.ordinal))
      .limit(1);
    if (latestAttempt) await db.update(providerOperationAttempts).set({
      status: "reconciled",
      finishedAt: new Date(),
      outcomeDetail: {
        ...redacted,
        reconciliationOutcome: status === "succeeded" ? "happened_as_intended" : "definitely_did_not_happen",
      },
    }).where(and(
      eq(providerOperationAttempts.tenantId, tenantId),
      eq(providerOperationAttempts.id, latestAttempt.id),
    ));
    return row;
  });
}

/** Exact readback proved that provider state differs from the immutable intent.
 * Divergence is terminal for blind execution but remains an explicit reconciliation
 * concern; it is not rewritten into a generic failure or fabricated success. */
export async function markOwnedExternalOperationDivergent(
  tenantId: string,
  externalOperationId: string,
  evidence: Record<string, unknown>,
  providerOperationAttemptId?: string,
): Promise<ExternalOperationRow> {
  const redacted = redactStructured(evidence) as Record<string, unknown>;
  return withTenant(tenantId, async (db) => {
    const [row] = await db.update(externalOperations).set({
      status: "unknown",
      response: { ...redacted, reconciliationOutcome: "happened_differently" },
      executionState: "divergent",
      verificationStatus: "divergent",
      externalObservedAt: new Date(),
      version: sql`${externalOperations.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.id, externalOperationId),
      sql`${externalOperations.executionState} <> 'verified'`,
    )).returning();
    if (!row) throw new Error("Verified external operation cannot regress to divergent");
    const attemptId = providerOperationAttemptId ?? (await db.select({ id: providerOperationAttempts.id })
      .from(providerOperationAttempts)
      .where(and(
        eq(providerOperationAttempts.tenantId, tenantId),
        eq(providerOperationAttempts.externalOperationId, externalOperationId),
      ))
      .orderBy(desc(providerOperationAttempts.ordinal))
      .limit(1))[0]?.id;
    if (attemptId) await db.update(providerOperationAttempts).set({
      status: "divergent",
      finishedAt: new Date(),
      outcomeDetail: { ...redacted, reconciliationOutcome: "happened_differently" },
    }).where(and(
      eq(providerOperationAttempts.tenantId, tenantId),
      eq(providerOperationAttempts.id, attemptId),
      eq(providerOperationAttempts.externalOperationId, externalOperationId),
    ));
    return row;
  });
}

export async function markExternalOperationUnknown(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  evidence: Record<string, unknown> = {},
  providerOperationAttemptId?: string,
): Promise<void> {
  await recordExternalOperationResult(
    tenantId,
    domainActionId,
    operationKey,
    "unknown",
    evidence,
    providerOperationAttemptId,
  );
}
