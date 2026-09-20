import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  businessEffects,
  closePool,
  domainActions,
  externalOperations,
  jobs,
  providerInvocations,
  providerOperationAttempts,
  withTenant,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  claimExternalOperation,
  claimOwnedExternalOperation,
  markProviderRequestMayHaveLeft,
  prepareProviderInvocation,
  reconcileOwnedExternalOperation,
  recordOwnedExternalOperationResult,
  recordProviderInvocationAcknowledged,
  recordProviderInvocationFailure,
  type ClaimedProviderOperation,
  type ExternalOperationContract,
  type ProviderInvocationContext,
} from "@finnor/tools";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const available = await databaseAvailable();

function hash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

const readbackContract: ExternalOperationContract = {
  protocolVersion: 2,
  retrySafety: "readback_required",
  verification: "readback",
  sourceTruthRequired: false,
  idempotency: { mode: "readback", scope: "scope2-certification" },
};

function invocationContext(claim: ClaimedProviderOperation, requestHash: string): ProviderInvocationContext {
  return {
    tenantId: SEED_TENANT_ID,
    providerOperationAttemptId: claim.providerOperationAttemptId,
    provider: "deterministic_fault_provider",
    requestHash,
    ...(claim.operation.providerIdempotencyKey ? { providerIdempotencyKey: claim.operation.providerIdempotencyKey } : {}),
    ...(claim.operation.providerIdempotencyScope ? { providerIdempotencyScope: claim.operation.providerIdempotencyScope } : {}),
    ...(claim.operation.providerIdempotencyExpiresAt ? { providerIdempotencyExpiresAt: claim.operation.providerIdempotencyExpiresAt } : {}),
    transportLayer: "fake_provider",
  };
}

async function claimedSystemOperation(
  label: string,
  contract: ExternalOperationContract = readbackContract,
): Promise<{ claim: ClaimedProviderOperation; requestHash: string }> {
  const requestHash = hash(`request:${label}`);
  const result = await claimOwnedExternalOperation(
    SEED_TENANT_ID,
    { type: "system_job", key: `scope2-cert:${label}` },
    `provider-member:${label}`,
    requestHash,
    "deterministic_fault_provider",
    undefined,
    undefined,
    contract,
  );
  expect(result.claimed).toBe(true);
  if (!result.claimed) throw new Error("test operation was not claimed");
  return { claim: result, requestHash };
}

describe.skipIf(!available)("Scope-2 canonical effect protocol", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it("persists logical operation -> provider-operation attempt -> physical invocation as distinct identities", async () => {
    const label = randomUUID();
    const { claim, requestHash } = await claimedSystemOperation(label);
    const context = invocationContext(claim, requestHash);
    const invocationId = await prepareProviderInvocation(context, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, invocationId);
    await recordProviderInvocationAcknowledged(context, invocationId, { externalRecordId: `fake:${label}` });
    await recordOwnedExternalOperationResult(
      SEED_TENANT_ID,
      claim.operation.id,
      "succeeded",
      { externalRecordId: `fake:${label}` },
      claim.providerOperationAttemptId,
    );

    const rows = await withTenant(SEED_TENANT_ID, async (db) => ({
      operations: await db.select().from(externalOperations).where(eq(externalOperations.id, claim.operation.id)),
      attempts: await db.select().from(providerOperationAttempts).where(eq(providerOperationAttempts.externalOperationId, claim.operation.id)),
      invocations: await db.select().from(providerInvocations).where(eq(providerInvocations.providerOperationAttemptId, claim.providerOperationAttemptId)),
    }));
    expect(rows.operations).toHaveLength(1);
    expect(rows.attempts).toHaveLength(1);
    expect(rows.invocations).toHaveLength(1);
    expect(new Set([rows.operations[0]!.id, rows.attempts[0]!.id, rows.invocations[0]!.id]).size).toBe(3);
    expect(rows.operations[0]).toMatchObject({ ownerType: "system_job", domainActionId: null, executionState: "awaiting_observation" });
    expect(rows.invocations[0]).toMatchObject({ outcome: "provider_acknowledged", transportLayer: "fake_provider" });
  });

  it("records a possible request egress and forbids blind replay of an unknown outcome", async () => {
    const label = randomUUID();
    const { claim, requestHash } = await claimedSystemOperation(label);
    const context = invocationContext(claim, requestHash);
    const invocationId = await prepareProviderInvocation(context, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, invocationId);
    await recordProviderInvocationFailure(context, invocationId, {
      kind: "timeout_after_possible_write",
      message: "deterministic response loss",
      definitePreDispatch: false,
    });

    const duplicate = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-cert:${label}` },
      `provider-member:${label}`,
      requestHash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      readbackContract,
    );
    expect(duplicate.claimed).toBe(false);
    if (duplicate.claimed) throw new Error("unknown outcome was blindly reclaimed");
    expect(duplicate.existing).toMatchObject({ status: "unknown", executionState: "unknown_outcome" });
    const [invocation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(eq(providerInvocations.id, invocationId)));
    expect(invocation).toMatchObject({ outcome: "unknown_outcome" });
    expect(invocation!.requestMayHaveLeftAt).not.toBeNull();
  });

  it("allows a new runtime attempt only after durable evidence proves repetition legal", async () => {
    const label = randomUUID();
    const { claim, requestHash } = await claimedSystemOperation(label);
    const context = invocationContext(claim, requestHash);
    const invocationId = await prepareProviderInvocation(context, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, invocationId);
    await recordProviderInvocationFailure(context, invocationId, {
      kind: "connection_refused_before_dispatch",
      message: "deterministic pre-dispatch failure",
      definitePreDispatch: true,
    });
    const replay = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-cert:${label}` },
      `provider-member:${label}`,
      requestHash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      readbackContract,
    );
    expect(replay.claimed).toBe(true);
    if (!replay.claimed) throw new Error("proven-safe repetition was not admitted");
    expect(replay.operation.id).toBe(claim.operation.id);
    expect(replay.providerOperationAttemptId).not.toBe(claim.providerOperationAttemptId);

    const history = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerOperationAttempts)
      .where(eq(providerOperationAttempts.externalOperationId, claim.operation.id))
      .orderBy(asc(providerOperationAttempts.ordinal)));
    expect(history.map((row) => row.authorizationBasis)).toEqual(["initial", "definite_pre_dispatch_failure"]);
    const [firstInvocation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(eq(providerInvocations.id, invocationId)));
    expect(firstInvocation!.requestMayHaveLeftAt).toBeNull();
  });

  it("honors provider idempotency only inside its guaranteed TTL", async () => {
    const activeLabel = randomUUID();
    const activeContract: ExternalOperationContract = {
      ...readbackContract,
      retrySafety: "provider_idempotent",
      idempotency: { mode: "provider_key", scope: "fake-tenant-key", ttlMs: 60_000 },
    };
    const active = await claimedSystemOperation(activeLabel, activeContract);
    const activeContext = invocationContext(active.claim, active.requestHash);
    const activeInvocation = await prepareProviderInvocation(activeContext, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, activeInvocation);
    await recordProviderInvocationFailure(activeContext, activeInvocation, {
      kind: "response_lost",
      message: "provider may have accepted the key",
      definitePreDispatch: false,
    });
    const equivalentReplay = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-cert:${activeLabel}` },
      `provider-member:${activeLabel}`,
      active.requestHash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      activeContract,
    );
    expect(equivalentReplay.claimed).toBe(true);

    const expiredLabel = randomUUID();
    const expiredContract: ExternalOperationContract = {
      ...readbackContract,
      retrySafety: "provider_idempotent",
      idempotency: { mode: "provider_key", scope: "fake-tenant-key", ttlMs: 1 },
    };
    const expired = await claimedSystemOperation(expiredLabel, expiredContract);
    const expiredContext = invocationContext(expired.claim, expired.requestHash);
    const expiredInvocation = await prepareProviderInvocation(expiredContext, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, expiredInvocation);
    await recordProviderInvocationFailure(expiredContext, expiredInvocation, {
      kind: "response_lost",
      message: "provider may have accepted the key",
      definitePreDispatch: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const unsafeReplay = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-cert:${expiredLabel}` },
      `provider-member:${expiredLabel}`,
      expired.requestHash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      expiredContract,
    );
    expect(unsafeReplay.claimed).toBe(false);
    if (unsafeReplay.claimed) throw new Error("expired provider key authorized an unsafe replay");
    expect(unsafeReplay.existing.status).toBe("unknown");
  });

  it("keeps provider acknowledgement separate from exact readback verification", async () => {
    const label = randomUUID();
    const { claim, requestHash } = await claimedSystemOperation(label);
    const context = invocationContext(claim, requestHash);
    const invocationId = await prepareProviderInvocation(context, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, invocationId);
    await recordProviderInvocationAcknowledged(context, invocationId, { externalRecordId: `fake:${label}` });
    const acknowledged = await recordOwnedExternalOperationResult(
      SEED_TENANT_ID,
      claim.operation.id,
      "succeeded",
      { externalRecordId: `fake:${label}` },
      claim.providerOperationAttemptId,
    );
    expect(acknowledged).toMatchObject({ status: "succeeded", executionState: "awaiting_observation", verificationStatus: "awaiting_observation" });

    const verified = await reconcileOwnedExternalOperation(SEED_TENANT_ID, claim.operation.id, "succeeded", {
      externalRecordId: `fake:${label}`,
      providerReadback: "matched immutable request",
    });
    expect(verified).toMatchObject({ executionState: "reconciled", verificationStatus: "verified" });
    const duplicate = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-cert:${label}` },
      `provider-member:${label}`,
      requestHash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      readbackContract,
    );
    expect(duplicate.claimed).toBe(false);
  });

  it("models one BusinessEffect as multiple independently recoverable provider members", async () => {
    const actionId = randomUUID();
    const effectId = randomUUID();
    const effectHash = hash(`effect:${effectId}`);
    await withTenant(SEED_TENANT_ID, async (db) => {
      await db.insert(domainActions).values({
        id: actionId,
        tenantId: SEED_TENANT_ID,
        actionType: "scope2_multi_member_effect",
        payload: {},
        status: "executing",
      });
      await db.insert(businessEffects).values({
        id: effectId,
        tenantId: SEED_TENANT_ID,
        domainActionId: actionId,
        semanticHash: effectHash,
        scopeHash: hash(`scope:${effectId}`),
        operationClass: "batch_external",
        effect: {
          id: effectId,
          semanticHash: effectHash,
          source: {
            domainActionId: actionId,
            actionType: "scope2_multi_member_effect",
            workId: null,
            objectiveStepId: null,
          },
          operation: { class: "batch_external", external: true },
          targets: [],
          bindings: [],
          delta: { values: { members: ["target-a", "target-b"] } },
          expected: { state: { memberCount: 2 } },
        },
        status: "executing",
      });
      await db.update(domainActions).set({ businessEffectId: effectId }).where(and(
        eq(domainActions.tenantId, SEED_TENANT_ID),
        eq(domainActions.id, actionId),
      ));
    });

    const firstHash = hash(`member-a:${effectId}`);
    const secondHash = hash(`member-b:${effectId}`);
    const first = await claimExternalOperation(SEED_TENANT_ID, actionId, "target:a", firstHash, "deterministic_fault_provider", effectId, undefined, readbackContract);
    const second = await claimExternalOperation(SEED_TENANT_ID, actionId, "target:b", secondHash, "deterministic_fault_provider", effectId, undefined, readbackContract);
    expect(first.claimed && second.claimed).toBe(true);
    if (!first.claimed || !second.claimed) throw new Error("multi-member effect claims did not converge");

    const firstContext = invocationContext(first, firstHash);
    const firstInvocation = await prepareProviderInvocation(firstContext, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, firstInvocation);
    await recordProviderInvocationAcknowledged(firstContext, firstInvocation, { externalRecordId: "target-a" });
    const afterAcknowledgement = await withTenant(SEED_TENANT_ID, async (db) => ({
      operation: (await db.select().from(externalOperations).where(eq(externalOperations.id, first.operation.id)))[0],
      observationJobs: await db.select().from(jobs).where(eq(
        jobs.idempotencyKey,
        `observe-effect:${SEED_TENANT_ID}:${actionId}:target:a:1`,
      )),
    }));
    expect(afterAcknowledgement.operation).toMatchObject({
      status: "succeeded",
      executionState: "awaiting_observation",
      verificationStatus: "awaiting_observation",
    });
    expect(afterAcknowledgement.observationJobs).toHaveLength(1);
    const acknowledgementVersion = afterAcknowledgement.operation!.version;
    await recordOwnedExternalOperationResult(SEED_TENANT_ID, first.operation.id, "succeeded", { externalRecordId: "target-a" }, first.providerOperationAttemptId);
    const idempotentResultPersistence = await withTenant(SEED_TENANT_ID, async (db) => ({
      operation: (await db.select().from(externalOperations).where(eq(externalOperations.id, first.operation.id)))[0],
      observationJobs: await db.select().from(jobs).where(eq(
        jobs.idempotencyKey,
        `observe-effect:${SEED_TENANT_ID}:${actionId}:target:a:1`,
      )),
    }));
    expect(idempotentResultPersistence.operation!.version).toBe(acknowledgementVersion);
    expect(idempotentResultPersistence.observationJobs).toHaveLength(1);
    await reconcileOwnedExternalOperation(SEED_TENANT_ID, first.operation.id, "succeeded", { externalRecordId: "target-a", readback: "matched" });

    const secondContext = invocationContext(second, secondHash);
    const secondInvocation = await prepareProviderInvocation(secondContext, 1);
    await markProviderRequestMayHaveLeft(SEED_TENANT_ID, secondInvocation);
    await recordProviderInvocationFailure(secondContext, secondInvocation, {
      kind: "timeout_after_possible_write",
      message: "target-b remains uncertain",
      definitePreDispatch: false,
    });

    const summary = await withTenant(SEED_TENANT_ID, (db) => db.execute<{
      member_count: number;
      verified_count: number;
      uncertain_count: number;
    }>(sql`SELECT member_count,verified_count,uncertain_count
             FROM finnor_os.business_effect_operation_summary
            WHERE tenant_id=${SEED_TENANT_ID}::uuid AND business_effect_id=${effectId}::uuid`));
    expect(summary.rows[0]).toMatchObject({ member_count: 2, verified_count: 1, uncertain_count: 1 });

    const verifiedReplay = await claimExternalOperation(SEED_TENANT_ID, actionId, "target:a", firstHash, "deterministic_fault_provider", effectId, undefined, readbackContract);
    const uncertainReplay = await claimExternalOperation(SEED_TENANT_ID, actionId, "target:b", secondHash, "deterministic_fault_provider", effectId, undefined, readbackContract);
    expect(verifiedReplay.claimed).toBe(false);
    expect(uncertainReplay.claimed).toBe(false);
    const invocationCount = await withTenant(SEED_TENANT_ID, (db) => db.select({ count: sql<number>`count(*)::int` })
      .from(providerInvocations)
      .where(eq(providerInvocations.tenantId, SEED_TENANT_ID)));
    expect(invocationCount[0]!.count).toBeGreaterThanOrEqual(2);
  });
});
