import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import {
  authorityDecisions,
  businessEffects,
  closePool,
  commands,
  domainActions,
  externalOperations,
  providerInvocations,
  reconciliationCases,
  runtimeOperatorControls,
  workflowRuns,
  workflowSteps,
  withTenant,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  claimOwnedExternalOperation,
  markProviderRequestMayHaveLeft,
  prepareProviderInvocation,
  recordProviderInvocationFailure,
} from "@finnor/tools";
import {
  initiateCompensation,
  openReconciliationCase,
  resolveReconciliationCase,
} from "@finnor/workflow-runtime";

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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function authority(actorId = "system:scope2-certifier"): Promise<{ actorId: string; authorityDecisionId: string }> {
  const [row] = await withTenant(SEED_TENANT_ID, (db) => db.insert(authorityDecisions).values({
    tenantId: SEED_TENANT_ID,
    employeeId: null,
    authorityRevision: 1,
    operation: "approval",
    capability: "approve:*",
    resourceType: "*",
    risk: "medium",
    outcome: "allowed",
    reasonCode: "trusted_scope2_test_principal",
    evidence: { actorId, deterministic: true },
  }).returning({ id: authorityDecisions.id }));
  return { actorId, authorityDecisionId: row!.id };
}

async function uncertainOperation(label: string): Promise<{ operationId: string; invocationId: string }> {
  const requestHash = hash(`scope2-reconciliation:${label}`);
  const claim = await claimOwnedExternalOperation(
    SEED_TENANT_ID,
    { type: "system_job", key: `scope2-reconciliation:${label}` },
    `target:${label}`,
    requestHash,
    "deterministic_fault_provider",
    undefined,
    undefined,
    {
      protocolVersion: 2,
      retrySafety: "readback_required",
      verification: "readback",
      sourceTruthRequired: false,
      idempotency: { mode: "readback", scope: "scope2-operator-control-test" },
    },
  );
  expect(claim.claimed).toBe(true);
  if (!claim.claimed) throw new Error("test operation was not claimed");
  const context = {
    tenantId: SEED_TENANT_ID,
    providerOperationAttemptId: claim.providerOperationAttemptId,
    provider: "deterministic_fault_provider",
    requestHash,
    transportLayer: "fake_provider" as const,
  };
  const invocationId = await prepareProviderInvocation(context, 1);
  await markProviderRequestMayHaveLeft(SEED_TENANT_ID, invocationId);
  await recordProviderInvocationFailure(context, invocationId, {
    kind: "response_lost_after_possible_write",
    message: "deterministic unknown outcome",
    definitePreDispatch: false,
  });
  return { operationId: claim.operation.id, invocationId };
}

describe.skipIf(!available)("Scope-2 governed reconciliation and compensation", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it("requires evidence, keeps still-unknown cases open, and pins the exact provider", async () => {
    const label = randomUUID();
    const operation = await uncertainOperation(label);
    const { caseId } = await openReconciliationCase(SEED_TENANT_ID, {
      caseType: "unknown_delivery",
      relatedExternalOperationId: operation.operationId,
      classification: "provider_response_lost",
      authoritativeSide: "external",
      details: { invocationId: operation.invocationId },
    });
    const control = await authority();

    await expect(resolveReconciliationCase(SEED_TENANT_ID, caseId, {
      ...control,
      controlKey: `reconcile-empty:${caseId}`,
      expectedVersion: 1,
      reason: "attempted empty resolution",
      outcome: "happened_as_intended",
      evidence: {},
      provider: "deterministic_fault_provider",
    })).resolves.toEqual({ resolved: false, reason: "evidence_required" });

    await expect(resolveReconciliationCase(SEED_TENANT_ID, caseId, {
      ...control,
      controlKey: `reconcile-unknown:${caseId}`,
      expectedVersion: 1,
      reason: "readback remains inconclusive",
      outcome: "still_unknowable",
      evidence: { readbackAt: new Date().toISOString(), result: "inconclusive" },
      provider: "deterministic_fault_provider",
    })).resolves.toEqual({ resolved: false, reason: "still_unresolved" });

    await expect(resolveReconciliationCase(SEED_TENANT_ID, caseId, {
      ...control,
      controlKey: `reconcile-wrong-provider:${caseId}`,
      expectedVersion: 1,
      reason: "attempted evidence from another provider",
      outcome: "happened_as_intended",
      evidence: { providerObjectId: `fake:${label}` },
      provider: "different_provider",
    })).resolves.toEqual({ resolved: false, reason: "account_mismatch" });

    const [stillOpen] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(reconciliationCases).where(eq(reconciliationCases.id, caseId)));
    expect(stillOpen).toMatchObject({ status: "open", version: 1, resolutionOutcome: null });
    const [unchangedInvocation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(eq(providerInvocations.id, operation.invocationId)));
    expect(unchangedInvocation).toMatchObject({ outcome: "unknown_outcome" });
  });

  it("settles runtime truth with exact evidence without re-invoking the provider", async () => {
    const label = randomUUID();
    const operation = await uncertainOperation(label);
    const { caseId } = await openReconciliationCase(SEED_TENANT_ID, {
      caseType: "unknown_delivery",
      relatedExternalOperationId: operation.operationId,
      classification: "ack_lost",
      authoritativeSide: "external",
      details: { invocationId: operation.invocationId },
    });
    const control = await authority("system:scope2-reconciler");
    const invocationCountBefore = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(
      eq(providerInvocations.tenantId, SEED_TENANT_ID),
    ));

    const result = await resolveReconciliationCase(SEED_TENANT_ID, caseId, {
      ...control,
      controlKey: `reconcile-exact:${caseId}`,
      expectedVersion: 1,
      reason: "exact provider object readback matched immutable intent",
      outcome: "happened_as_intended",
      evidence: {
        providerObjectId: `fake:${label}`,
        observedAt: new Date().toISOString(),
        immutableIntentMatched: true,
      },
      provider: "deterministic_fault_provider",
    });
    expect(result).toEqual({ resolved: true, version: 2 });

    const state = await withTenant(SEED_TENANT_ID, async (db) => {
      const [reconciliation] = await db.select().from(reconciliationCases).where(eq(reconciliationCases.id, caseId));
      const [externalOperation] = await db.select().from(externalOperations).where(eq(externalOperations.id, operation.operationId));
      const [audit] = await db.select().from(runtimeOperatorControls).where(and(
        eq(runtimeOperatorControls.tenantId, SEED_TENANT_ID),
        eq(runtimeOperatorControls.controlKey, `reconcile-exact:${caseId}`),
      ));
      const invocationCountAfter = await db.select().from(providerInvocations).where(eq(providerInvocations.tenantId, SEED_TENANT_ID));
      return { reconciliation, externalOperation, audit, invocationCountAfter };
    });
    expect(state.reconciliation).toMatchObject({
      status: "resolved",
      version: 2,
      resolutionOutcome: "happened_as_intended",
      resolvedBy: control.actorId,
      resolutionProvider: "deterministic_fault_provider",
    });
    expect(state.externalOperation).toMatchObject({ status: "succeeded", executionState: "verified", verificationStatus: "verified" });
    expect(state.audit).toMatchObject({ controlType: "reconciliation_resolution", outcome: "applied", expectedVersion: 1 });
    expect(state.invocationCountAfter).toHaveLength(invocationCountBefore.length);

    await expect(resolveReconciliationCase(SEED_TENANT_ID, caseId, {
      ...control,
      controlKey: `reconcile-stale:${caseId}`,
      expectedVersion: 1,
      reason: "stale duplicate screen",
      outcome: "happened_as_intended",
      evidence: { immutableIntentMatched: true },
      provider: "deterministic_fault_provider",
    })).resolves.toEqual({ resolved: false, reason: "version_conflict" });
  });

  it("fails unsupported compensation closed and leaves original verified effect intact", async () => {
    const actionId = randomUUID();
    const effectId = randomUUID();
    const effectHash = hash(`effect:${effectId}`);
    const fixture = await withTenant(SEED_TENANT_ID, async (db) => {
      await db.insert(domainActions).values({
        id: actionId,
        tenantId: SEED_TENANT_ID,
        actionType: "scope2_irreversible_effect",
        payload: {},
        status: "completed",
      });
      await db.insert(businessEffects).values({
        id: effectId,
        tenantId: SEED_TENANT_ID,
        domainActionId: actionId,
        semanticHash: effectHash,
        scopeHash: hash(`scope:${effectId}`),
        operationClass: "external_side_effect",
        effect: {
          version: 1,
          id: effectId,
          semanticHash: effectHash,
          source: {
            domainActionId: actionId,
            actionType: "scope2_irreversible_effect",
            workId: null,
            objectiveStepId: null,
          },
          operation: { class: "external_side_effect", external: true },
          targets: [],
          bindings: [],
          delta: { values: {} },
          expected: { state: {} },
          reversibility: { classification: "irreversible" },
        },
        status: "verified",
      });
      await db.update(domainActions).set({ businessEffectId: effectId }).where(eq(domainActions.id, actionId));
      const [command] = await db.insert(commands).values({
        tenantId: SEED_TENANT_ID,
        commandType: "scope2_compensation_test",
        payload: {},
      }).returning();
      const [run] = await db.insert(workflowRuns).values({
        tenantId: SEED_TENANT_ID,
        commandId: command!.id,
        workflowType: "single_action",
        status: "completed",
      }).returning();
      const [step] = await db.insert(workflowSteps).values({
        tenantId: SEED_TENANT_ID,
        workflowRunId: run!.id,
        stepType: "scope2_irreversible_effect",
        sequence: 1,
        idempotencyKey: `scope2-compensation:${randomUUID()}`,
        status: "completed",
        executionState: "verified",
        businessEffectId: effectId,
      }).returning();
      return { stepId: step!.id };
    });
    const control = await authority("system:scope2-compensation-operator");
    const result = await initiateCompensation(SEED_TENANT_ID, fixture.stepId, {
      ...control,
      controlKey: `compensation:${fixture.stepId}`,
      expectedVersion: 0,
      reason: "test that no fantasy inverse is created",
    });
    expect(result).toEqual({ initiated: false, reason: "unsupported_compensation" });

    const [effect, audit] = await withTenant(SEED_TENANT_ID, async (db) => {
      const [effectRow] = await db.select().from(businessEffects).where(eq(businessEffects.id, effectId));
      const [auditRow] = await db.select().from(runtimeOperatorControls).where(and(
        eq(runtimeOperatorControls.tenantId, SEED_TENANT_ID),
        eq(runtimeOperatorControls.controlKey, `compensation:${fixture.stepId}`),
      ));
      return [effectRow, auditRow] as const;
    });
    expect(effect).toMatchObject({ id: effectId, status: "verified", compensationForEffectId: null });
    expect(audit).toMatchObject({ controlType: "compensation_initiation", outcome: "rejected", expectedVersion: 0 });
  });
});
