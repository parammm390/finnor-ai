import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  businessEffects,
  closePool,
  commands,
  domainActions,
  integrationOperations,
  integrationEvents,
  reconciliationCases,
  tenantIntegrations,
  workflowRuns,
  workflowSteps,
  withTenant,
} from "@finnor/db";
import { settleExternalEffectObservation } from "@finnor/orchestration";
import { openReceipt } from "@finnor/workflow-runtime";
import type { ExternalObservationClassification } from "@finnor/shared-types";
import { migrate } from "../../packages/db/migrate";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const available = await (async () => {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
})();

const tenantId = randomUUID();
const integrationId = randomUUID();

async function waitingScenario(label: string) {
  const actionId = randomUUID();
  const effectId = randomUUID();
  const commandId = randomUUID();
  const runId = randomUUID();
  const stepId = randomUUID();
  const operationId = randomUUID();
  const semanticHash = createHash("sha256").update(`semantic:${label}`).digest("hex");
  await withTenant(tenantId, async (db) => {
    await db.insert(domainActions).values({ id: actionId, tenantId, actionType: "external_test", payload: {}, status: "executing" });
    await db.insert(businessEffects).values({
      id: effectId, tenantId, domainActionId: actionId, semanticHash, scopeHash: createHash("sha256").update(`scope:${label}`).digest("hex"),
      operationClass: "external_side_effect", status: "partially_verified",
      effect: {
        id: effectId,
        source: { domainActionId: actionId, actionType: "external_test", workId: null, objectiveStepId: null },
        operation: { external: true }, targets: [], bindings: [],
        delta: { values: { amountUsd: 125 } }, expected: { state: { amountUsd: 125 } },
      },
    });
    await db.update(domainActions).set({ businessEffectId: effectId }).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId)));
    await db.insert(commands).values({ id: commandId, tenantId, commandType: "external_test", status: "running", businessEffectId: effectId });
    await db.insert(workflowRuns).values({ id: runId, tenantId, commandId, workflowType: "single_action", status: "running" });
    await db.insert(workflowSteps).values({
      id: stepId, tenantId, workflowRunId: runId, stepType: "execute_authorized_effect", sequence: 1,
      status: "waiting_observation", executionState: "awaiting_observation", idempotencyKey: `observe:${label}`, domainActionId: actionId, businessEffectId: effectId,
    });
    await db.insert(integrationOperations).values({
      id: operationId, tenantId, workflowStepId: stepId, operationKey: `provider:${label}`, capability: "accounting",
      provider: "quickbooks", integrationId, businessEffectId: effectId, requestHash: semanticHash, status: "succeeded",
      response: { externalInvoiceId: `qbo-${label}` }, providerAcknowledgedAt: new Date(), verificationStatus: "awaiting_observation",
    });
  });
  await openReceipt({
    tenantId,
    workflowRunId: runId,
    workflowStepId: stepId,
    domainActionId: actionId,
    businessEffectId: effectId,
    intendedEffectHash: semanticHash,
    authorizedEffectHash: semanticHash,
    objective: `Observe external effect ${label}`,
    evidence: [{ source: "workflow_step", ref: stepId, timestamp: new Date().toISOString() }],
    policyApplied: null,
    riskTier: "medium",
    proposedAction: { actionType: "external_test", businessEffectId: effectId },
    approval: { required: false },
    expectedResult: { amountUsd: 125 },
  });
  return { actionId, effectId, commandId, runId, stepId, operationId, semanticHash };
}

async function settle(scenario: Awaited<ReturnType<typeof waitingScenario>>, classification: ExternalObservationClassification, observed?: Record<string, unknown>) {
  return settleExternalEffectObservation({
    tenantId,
    businessEffectId: scenario.effectId,
    integrationId,
    provider: "quickbooks",
    externalObjectType: "invoice",
    externalId: `qbo-${scenario.actionId}`,
    observedAt: new Date().toISOString(),
    classification,
    expected: { amountUsd: 125 },
    ...(observed ? { observed } : {}),
    evidence: { mechanism: "read_after_write" },
  }, { integrationOperationId: scenario.operationId, domainActionId: scenario.actionId });
}

describe.skipIf(!available)("external EffectSet observation settlement", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    const admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES ($1,'Effect Observation Tenant')", [tenantId]);
    await admin.end();
    await withTenant(tenantId, (db) => db.insert(tenantIntegrations).values({
      id: integrationId, tenantId, capability: "accounting", binding: "quickbooks", mode: "sandbox",
    }));
  });

  afterAll(async () => { await closePool(); });

  it("keeps provider acknowledgement waiting, then verifies and advances only after matching read-back", async () => {
    const scenario = await waitingScenario("present");
    const [before] = await withTenant(tenantId, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, scenario.stepId)));
    expect(before).toMatchObject({ status: "waiting_observation", executionState: "awaiting_observation" });
    await settle(scenario, "present", { amountUsd: 125 });
    const [effect, action, step, run, command, operation] = await withTenant(tenantId, async (db) => Promise.all([
      db.select().from(businessEffects).where(eq(businessEffects.id, scenario.effectId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, scenario.actionId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, scenario.stepId)).then((rows) => rows[0]),
      db.select().from(workflowRuns).where(eq(workflowRuns.id, scenario.runId)).then((rows) => rows[0]),
      db.select().from(commands).where(eq(commands.id, scenario.commandId)).then((rows) => rows[0]),
      db.select().from(integrationOperations).where(eq(integrationOperations.id, scenario.operationId)).then((rows) => rows[0]),
    ]));
    expect(effect).toMatchObject({ status: "verified", verification: expect.objectContaining({ state: "verified" }) });
    expect(action?.status).toBe("completed");
    expect(step).toMatchObject({ status: "completed", executionState: "verified" });
    expect(run?.status).toBe("completed");
    expect(command?.status).toBe("completed");
    expect(operation).toMatchObject({ verificationStatus: "verified", observation: expect.objectContaining({ classification: "present" }) });
    const events = await withTenant(tenantId, (db) => db.select().from(integrationEvents).where(and(
      eq(integrationEvents.tenantId, tenantId),
      eq(integrationEvents.domainActionId, scenario.actionId),
      eq(integrationEvents.eventType, "effect.present"),
    )));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "unmatched", trustClass: "trusted_runtime" });

    // A delayed out-of-order provider event cannot regress already verified truth.
    await settle(scenario, "divergent", { amountUsd: 99 });
    const [monotonic] = await withTenant(tenantId, (db) => db.select().from(businessEffects).where(eq(businessEffects.id, scenario.effectId)));
    expect(monotonic?.status).toBe("verified");
  });

  it("marks a provider-success/business-state mismatch divergent and routes recovery", async () => {
    const scenario = await waitingScenario("divergent");
    await settle(scenario, "divergent", { amountUsd: 99 });
    const [effect, action, step, operation, cases] = await withTenant(tenantId, async (db) => Promise.all([
      db.select().from(businessEffects).where(eq(businessEffects.id, scenario.effectId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, scenario.actionId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, scenario.stepId)).then((rows) => rows[0]),
      db.select().from(integrationOperations).where(eq(integrationOperations.id, scenario.operationId)).then((rows) => rows[0]),
      db.select().from(reconciliationCases).where(eq(reconciliationCases.businessEffectId, scenario.effectId)),
    ]));
    expect(effect?.status).toBe("divergent");
    expect(action?.status).toBe("needs_human_review");
    expect(step).toMatchObject({ status: "failed", executionState: "reconciling" });
    expect(operation?.verificationStatus).toBe("divergent");
    expect(cases).toEqual([expect.objectContaining({ caseType: "external_drift", status: "open" })]);
  });

  it("keeps an inconclusive outcome unretryable and reconciliation-required", async () => {
    const scenario = await waitingScenario("unknown");
    await settle(scenario, "unknown");
    const [effect, action, step, operation, cases] = await withTenant(tenantId, async (db) => Promise.all([
      db.select().from(businessEffects).where(eq(businessEffects.id, scenario.effectId)).then((rows) => rows[0]),
      db.select().from(domainActions).where(eq(domainActions.id, scenario.actionId)).then((rows) => rows[0]),
      db.select().from(workflowSteps).where(eq(workflowSteps.id, scenario.stepId)).then((rows) => rows[0]),
      db.select().from(integrationOperations).where(eq(integrationOperations.id, scenario.operationId)).then((rows) => rows[0]),
      db.select().from(reconciliationCases).where(eq(reconciliationCases.businessEffectId, scenario.effectId)),
    ]));
    expect(effect?.status).toBe("reconciliation_required");
    expect(action?.status).toBe("needs_human_review");
    expect(step).toMatchObject({ status: "failed", executionState: "reconciling" });
    expect(operation?.verificationStatus).toBe("unknown");
    expect(cases).toEqual([expect.objectContaining({ caseType: "unknown_delivery", status: "open" })]);
  });
});
