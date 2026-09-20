import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  businessEffects,
  closePool,
  commands,
  decisionReceipts,
  domainActions,
  externalOperations,
  jobs,
  providerInvocations,
  providerOperationAttempts,
  reconciliationCases,
  workflowRuns,
  workflowStepClaims,
  workflowSteps,
  withTenant,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  advanceWorkflow,
  claimStep,
  completeStep,
  inspectRuntimeTruth,
  recoverStaleSteps,
  stepFence,
  submitCommand,
} from "@finnor/workflow-runtime";
import {
  claimExternalOperation,
  claimOwnedExternalOperation,
  recoverStaleProviderOperations,
  type ExternalOperationContract,
} from "@finnor/tools";
import { SCOPE2_CRASH_BOUNDARIES } from "./fixtures/scope2-crash-boundaries";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const CHILD = resolve(process.cwd(), "tests/integration/fixtures/scope2-crash-child.ts");

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

const recoveryContract: ExternalOperationContract = {
  protocolVersion: 2,
  retrySafety: "readback_required",
  verification: "readback",
  sourceTruthRequired: false,
  idempotency: { mode: "readback", scope: "scope2-real-sigkill" },
};

async function runKilled(mode: string, args: string[], timeoutMs = 30_000): Promise<void> {
  const output: Buffer[] = [];
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    // Execute the fixture in the Node process itself. The `tsx` CLI is a parent
    // wrapper and reports a killed child as exit 137 on macOS, which obscures the
    // signal. `node --import=tsx` lets child_process observe the real SIGKILL.
    const child = spawn(process.execPath, ["--import=tsx", CHILD, mode, SEED_TENANT_ID, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: "test", LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`crash child timed out in ${mode}`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
  if (result.signal !== "SIGKILL" || result.code !== null) {
    throw new Error(`expected real SIGKILL for ${mode}; code=${String(result.code)} signal=${String(result.signal)} output=${Buffer.concat(output).toString("utf8")}`);
  }
}

async function findCrashOperation(label: string) {
  const [operation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(externalOperations).where(and(
    eq(externalOperations.tenantId, SEED_TENANT_ID),
    eq(externalOperations.ownerType, "system_job"),
    eq(externalOperations.ownerKey, `scope2-crash:${label}`),
    eq(externalOperations.operationKey, `member:${label}`),
  )).limit(1));
  if (!operation) throw new Error(`missing crash operation ${label}`);
  const [attempt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerOperationAttempts).where(eq(
    providerOperationAttempts.externalOperationId,
    operation.id,
  )).orderBy(sql`${providerOperationAttempts.ordinal} DESC`).limit(1));
  if (!attempt) throw new Error(`missing provider attempt ${label}`);
  const [invocation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(eq(
    providerInvocations.providerOperationAttemptId,
    attempt.id,
  )).orderBy(sql`${providerInvocations.ordinal} DESC`).limit(1));
  return { operation, attempt, invocation };
}

async function makeEffect(label: string): Promise<{ actionId: string; effectId: string }> {
  const actionId = randomUUID();
  const effectId = randomUUID();
  const effectHash = hash(`effect:${label}:${effectId}`);
  await withTenant(SEED_TENANT_ID, async (db) => {
    await db.insert(domainActions).values({
      id: actionId,
      tenantId: SEED_TENANT_ID,
      actionType: "scope2_sigkill_effect",
      payload: { label },
      status: "executing",
    });
    await db.insert(businessEffects).values({
      id: effectId,
      tenantId: SEED_TENANT_ID,
      domainActionId: actionId,
      semanticHash: effectHash,
      scopeHash: hash(`scope:${label}:${effectId}`),
      operationClass: "external_side_effect",
      effect: {
        id: effectId,
        semanticHash: effectHash,
        source: { domainActionId: actionId, actionType: "scope2_sigkill_effect", workId: null, objectiveStepId: null },
        operation: { class: "external_side_effect", external: true },
        // Provider-operation membership is represented by external_operations;
        // this fixture must not invent a DomainTarget kind merely to name a fake.
        targets: [],
        bindings: [],
        delta: { values: { label } },
        expected: { state: { label } },
      },
      status: "executing",
    });
    await db.update(domainActions).set({ businessEffectId: effectId }).where(and(
      eq(domainActions.tenantId, SEED_TENANT_ID),
      eq(domainActions.id, actionId),
    ));
  });
  return { actionId, effectId };
}

describe.skipIf(!available)("Scope-2 real process-kill crash/redeploy matrix", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
    const keys = SCOPE2_CRASH_BOUNDARIES.map((boundary) => `scope2-crash-boundary:${boundary.id}`);
    await withTenant(SEED_TENANT_ID, (db) => db.delete(jobs).where(inArray(jobs.idempotencyKey, keys)));
  });

  afterAll(async () => {
    const keys = SCOPE2_CRASH_BOUNDARIES.map((boundary) => `scope2-crash-boundary:${boundary.id}`);
    await withTenant(SEED_TENANT_ID, (db) => db.delete(jobs).where(inArray(jobs.idempotencyKey, keys))).catch(() => undefined);
    await closePool();
  });

  it("executes one real SIGKILL transaction probe for every active contract boundary", async () => {
    expect(SCOPE2_CRASH_BOUNDARIES).toHaveLength(32);
    const active = SCOPE2_CRASH_BOUNDARIES.filter((boundary) => boundary.disposition === "ACTIVE_SIGKILL");
    expect(active).toHaveLength(29);
    expect(SCOPE2_CRASH_BOUNDARIES.filter((boundary) => boundary.disposition === "RETIRED_NOT_REACHABLE")).toHaveLength(2);
    expect(SCOPE2_CRASH_BOUNDARIES.filter((boundary) => boundary.disposition === "UNSUPPORTED_FAIL_CLOSED")).toHaveLength(1);

    // Four child processes at a time keeps this a real multi-process corpus without
    // turning TypeScript startup into an accidental CPU/connection exhaustion test.
    for (let offset = 0; offset < active.length; offset += 4) {
      await Promise.all(active.slice(offset, offset + 4).map((boundary) => runKilled(
        boundary.checkpoint === "pre_commit_rollback" ? "transaction-before-commit" : "transaction-after-commit",
        [boundary.id],
      )));
    }

    const persisted = await withTenant(SEED_TENANT_ID, (db) => db.select({ key: jobs.idempotencyKey }).from(jobs).where(inArray(
      jobs.idempotencyKey,
      active.map((boundary) => `scope2-crash-boundary:${boundary.id}`),
    )));
    const persistedKeys = new Set(persisted.map((row) => row.key));
    for (const boundary of active) {
      const exists = persistedKeys.has(`scope2-crash-boundary:${boundary.id}`);
      expect(exists, boundary.id).toBe(boundary.checkpoint === "post_commit_durable");
    }
  }, 180_000);

  it("rolls back command/run/step/first-job atomically when SIGKILL lands before commit", async () => {
    const label = randomUUID();
    const commandKey = `scope2-crash-command:${label}`;
    await runKilled("command-pre-commit", [label]);
    const rolledBack = await withTenant(SEED_TENANT_ID, (db) => db.select().from(commands).where(eq(commands.idempotencyKey, commandKey)));
    expect(rolledBack).toHaveLength(0);

    const replay = await withTenant(SEED_TENANT_ID, (db) => submitCommand(db, {
      tenantId: SEED_TENANT_ID,
      commandType: "scope2_sigkill_command",
      payload: { label },
      workflowType: "scope2_sigkill_workflow",
      steps: [{ stepType: "scope2_sigkill_step", payload: { label } }],
      idempotencyKey: commandKey,
    }));
    const graph = await withTenant(SEED_TENANT_ID, async (db) => ({
      commands: await db.select().from(commands).where(eq(commands.id, replay.commandId)),
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.id, replay.workflowRunId)),
      steps: await db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, replay.workflowRunId)),
      firstJobs: await db.select().from(jobs).where(sql`${jobs.payload}->>'workflowStepId'=${replay.stepIds[0]}`),
    }));
    expect(graph.commands).toHaveLength(1);
    expect(graph.runs).toHaveLength(1);
    expect(graph.steps).toHaveLength(1);
    expect(graph.firstJobs).toHaveLength(1);
  });

  it("preserves one committed step claim and DecisionReceipt across post-commit/pre-ACK SIGKILL", async () => {
    const label = randomUUID();
    const submitted = await withTenant(SEED_TENANT_ID, (db) => submitCommand(db, {
      tenantId: SEED_TENANT_ID,
      commandType: "scope2_sigkill_claim",
      payload: { label },
      workflowType: "scope2_sigkill_workflow",
      steps: [{ stepType: "scope2_sigkill_step", payload: { label } }],
      idempotencyKey: `scope2-sigkill-claim:${label}`,
    }));
    const stepId = submitted.stepIds[0]!;
    await runKilled("step-claim-post-commit", [stepId, "0"]);
    const durable = await withTenant(SEED_TENANT_ID, async (db) => ({
      step: (await db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)))[0],
      claims: await db.select().from(workflowStepClaims).where(eq(workflowStepClaims.workflowStepId, stepId)),
      receipts: await db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)),
    }));
    expect(durable.step).toMatchObject({ status: "leased", executionState: "claimed", attempts: 1 });
    expect(durable.claims).toHaveLength(1);
    expect(durable.receipts).toHaveLength(1);
    expect(await claimStep(SEED_TENANT_ID, stepId, 0, {
      workerId: "scope2-duplicate-after-kill",
      jobProtocolVersion: 2,
      eligibilityEvidence: { version: 1, source: "duplicate_delivery" },
    })).toBeNull();

    const oldFence = stepFence(durable.step!);
    await withTenant(SEED_TENANT_ID, (db) => db.update(workflowSteps).set({
      leaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(workflowSteps.id, stepId)));
    await recoverStaleSteps(SEED_TENANT_ID);
    await completeStep(SEED_TENANT_ID, stepId, { stale: true }, oldFence);
    const afterRecovery = await withTenant(SEED_TENANT_ID, async (db) => ({
      step: (await db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)))[0],
      claims: await db.select().from(workflowStepClaims).where(eq(workflowStepClaims.workflowStepId, stepId)),
    }));
    // `evidence` is schema-defaulted to {}, so unchanged empty evidence—not null—is
    // the proof that the killed generation could not commit `{ stale: true }`.
    expect(afterRecovery.step).toMatchObject({ status: "pending", dispatchGeneration: 1, evidence: {} });
    expect(afterRecovery.claims).toHaveLength(1);
    expect(afterRecovery.claims[0]).toMatchObject({ outcome: "superseded", finishedAt: expect.any(Date) });
  });

  it("recovers a SIGKILL between durable next-step readiness and physical enqueue", async () => {
    const label = randomUUID();
    const submitted = await withTenant(SEED_TENANT_ID, (db) => submitCommand(db, {
      tenantId: SEED_TENANT_ID,
      commandType: "scope2_sigkill_advance",
      payload: { label },
      workflowType: "scope2_sigkill_workflow",
      steps: [
        { stepType: "scope2_first", payload: { label } },
        { stepType: "scope2_second", payload: { label } },
      ],
      idempotencyKey: `scope2-sigkill-advance:${label}`,
    }));
    const first = await claimStep(SEED_TENANT_ID, submitted.stepIds[0]!, 0, {
      workerId: "scope2-advance-primer",
      jobProtocolVersion: 2,
      eligibilityEvidence: { version: 1, source: "scope2_crash_test" },
    });
    if (!first) throw new Error("first step was not claimable");
    await completeStep(SEED_TENANT_ID, first.id, { done: true }, stepFence(first));
    await runKilled("advance-mid-multi-step", [submitted.workflowRunId]);
    const [ready] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(
      workflowSteps.id,
      submitted.stepIds[1]!,
    )));
    expect(ready!.causalReadyAt).not.toBeNull();
    const beforeRecovery = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(sql`${jobs.payload}->>'workflowStepId'=${ready!.id}`));
    expect(beforeRecovery).toHaveLength(0);
    await advanceWorkflow(SEED_TENANT_ID, submitted.workflowRunId);
    const afterRecovery = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(sql`${jobs.payload}->>'workflowStepId'=${ready!.id}`));
    expect(afterRecovery).toHaveLength(1);
  });

  it("classifies a prepared invocation as proven pre-egress and permits only a new runtime attempt", async () => {
    const label = randomUUID();
    await runKilled("provider-prepared", [label]);
    const crashed = await findCrashOperation(label);
    expect(crashed.invocation).toMatchObject({ outcome: "prepared", requestMayHaveLeftAt: null });
    const recovery = await recoverStaleProviderOperations(SEED_TENANT_ID, { staleBefore: new Date(Date.now() + 60_000) });
    expect(recovery.knownFailedBeforeEgress).toBeGreaterThanOrEqual(1);
    const after = await findCrashOperation(label);
    expect(after.operation).toMatchObject({ status: "failed", executionState: "known_failed" });
    expect(after.invocation).toMatchObject({ outcome: "definite_pre_dispatch_failure", requestMayHaveLeftAt: null });
    const retry = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-crash:${label}` },
      `member:${label}`,
      hash(`scope2-crash:${label}`),
      "deterministic_fault_provider",
      undefined,
      undefined,
      recoveryContract,
    );
    expect(retry.claimed).toBe(true);
    if (retry.claimed) expect(retry.providerOperationAttemptId).not.toBe(crashed.attempt.id);
  });

  it("turns possible egress into reconciliation and never creates a second physical invocation", async () => {
    const label = randomUUID();
    await runKilled("provider-possible-egress", [label]);
    const crashed = await findCrashOperation(label);
    expect(crashed.invocation?.outcome).toBe("request_may_have_left");
    const recovery = await recoverStaleProviderOperations(SEED_TENANT_ID, { staleBefore: new Date(Date.now() + 60_000) });
    expect(recovery.reconciliationRequired).toBeGreaterThanOrEqual(1);
    const after = await findCrashOperation(label);
    expect(after.operation).toMatchObject({ status: "unknown", executionState: "reconciliation_required" });
    expect(after.invocation?.outcome).toBe("unknown_outcome");
    const duplicate = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-crash:${label}` },
      `member:${label}`,
      hash(`scope2-crash:${label}`),
      "deterministic_fault_provider",
      undefined,
      undefined,
      recoveryContract,
    );
    expect(duplicate.claimed).toBe(false);
    const cases = await withTenant(SEED_TENANT_ID, (db) => db.select().from(reconciliationCases).where(and(
      eq(reconciliationCases.relatedExternalOperationId, after.operation.id),
      eq(reconciliationCases.status, "open"),
    )));
    expect(cases).toHaveLength(1);
    const invocations = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(eq(
      providerInvocations.providerOperationAttemptId,
      crashed.attempt.id,
    )));
    expect(invocations).toHaveLength(1);
  });

  it("preserves a fake-provider accepted request with lost response as unknown without replay", async () => {
    const label = randomUUID();
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ externalRecordId: `fake:${label}` }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake provider did not bind a TCP port");
    try {
      await runKilled("provider-response-before-persist", [label, `http://127.0.0.1:${address.port}/effect`]);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    expect(requests).toBe(1);
    const crashed = await findCrashOperation(label);
    expect(crashed.invocation).toMatchObject({ outcome: "request_may_have_left", receipt: null });
    await recoverStaleProviderOperations(SEED_TENANT_ID, { staleBefore: new Date(Date.now() + 60_000) });
    const duplicate = await claimOwnedExternalOperation(
      SEED_TENANT_ID,
      { type: "system_job", key: `scope2-crash:${label}` },
      `member:${label}`,
      hash(`scope2-crash:${label}`),
      "deterministic_fault_provider",
      undefined,
      undefined,
      recoveryContract,
    );
    expect(duplicate.claimed).toBe(false);
    const after = await findCrashOperation(label);
    expect(after.operation.executionState).toBe("reconciliation_required");
    expect(after.invocation?.outcome).toBe("unknown_outcome");
    expect(requests).toBe(1);
  });

  it("commits provider ACK, logical result and one readback job atomically before SIGKILL", async () => {
    const label = randomUUID();
    const { actionId, effectId } = await makeEffect(label);
    await runKilled("provider-ack-post-commit", [label, actionId, effectId]);
    const [operation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(externalOperations).where(and(
      eq(externalOperations.domainActionId, actionId),
      eq(externalOperations.operationKey, `member:${label}`),
    )).limit(1));
    expect(operation).toMatchObject({
      status: "succeeded",
      executionState: "awaiting_observation",
      verificationStatus: "awaiting_observation",
    });
    const readbackJobs = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(eq(
      jobs.idempotencyKey,
      `observe-effect:${SEED_TENANT_ID}:${actionId}:member:${label}:1`,
    )));
    expect(readbackJobs).toHaveLength(1);
    const duplicate = await claimExternalOperation(
      SEED_TENANT_ID,
      actionId,
      `member:${label}`,
      hash(`scope2-crash:${label}`),
      "deterministic_fault_provider",
      effectId,
      undefined,
      recoveryContract,
    );
    expect(duplicate.claimed).toBe(false);
    const attempts = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerOperationAttempts).where(eq(
      providerOperationAttempts.externalOperationId,
      operation!.id,
    )));
    const invocations = await withTenant(SEED_TENANT_ID, (db) => db.select().from(providerInvocations).where(inArray(
      providerInvocations.providerOperationAttemptId,
      attempts.map((attempt) => attempt.id),
    )));
    expect(attempts).toHaveLength(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({ outcome: "provider_acknowledged" });
    const inspection = await inspectRuntimeTruth(SEED_TENANT_ID, { businessEffectId: effectId });
    expect(inspection.businessEffects).toHaveLength(1);
    expect(inspection.logicalProviderOperations).toHaveLength(1);
    expect(inspection.providerOperationAttempts).toHaveLength(1);
    expect(inspection.physicalProviderInvocations).toHaveLength(1);
    expect(inspection.jobs).toHaveLength(1);
    expect(inspection.read.possiblyTruncatedCollections).toEqual([]);
  });
});
