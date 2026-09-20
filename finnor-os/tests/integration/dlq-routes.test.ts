// Scope 2 governed DLQ controls: workflow-step redrive only, tenant isolation,
// Authority evidence, optimistic version/fence checks, and append-only audit.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  closePool,
  commands,
  deadLetters,
  runtimeOperatorControls,
  tenants,
  workflowRuns,
  workflowSteps,
  withTenant,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { GET as listDlq } from "../../apps/api/app/api/dlq/route";
import { GET as inspectDlq } from "../../apps/api/app/api/dlq/[id]/route";
import { POST as replayDlq } from "../../apps/api/app/api/dlq/[id]/replay/route";
import { POST as discardDlq } from "../../apps/api/app/api/dlq/[id]/discard/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000e9";

async function dbUp(): Promise<boolean> {
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

const available = await dbUp();

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\ncaused by: ");
}

async function expectDatabaseRejection(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  throw new Error(`Expected database operation to reject with ${pattern}`);
}

function request(
  path: string,
  options: { tenantId?: string; role?: string; method?: string; body?: Record<string, unknown> } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-tenant-id": options.tenantId ?? SEED_TENANT_ID,
      "x-user-role": options.role ?? "owner",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function makeStepDeadLetter(input: {
  errorKind?: "retryable" | "terminal" | "unknown_outcome";
  replayable?: boolean;
  afterPossibleEffect?: boolean;
} = {}): Promise<{ deadLetterId: string; stepId: string; runId: string }> {
  return withTenant(SEED_TENANT_ID, async (db) => {
    const [command] = await db.insert(commands).values({
      tenantId: SEED_TENANT_ID,
      commandType: "scope2_dlq_control_test",
      payload: {},
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      tenantId: SEED_TENANT_ID,
      commandId: command!.id,
      workflowType: "single_action",
      status: "failed",
    }).returning();
    const [step] = await db.insert(workflowSteps).values({
      tenantId: SEED_TENANT_ID,
      workflowRunId: run!.id,
      stepType: "scope2_dlq_probe",
      sequence: 1,
      idempotencyKey: `scope2-dlq:${crypto.randomUUID()}`,
      status: "failed",
      executionState: input.afterPossibleEffect ? "failed_after_possible_effect" : "failed_before_effect",
      ...(input.afterPossibleEffect ? { effectCommitAt: new Date() } : {}),
    }).returning();
    const [deadLetter] = await db.insert(deadLetters).values({
      tenantId: SEED_TENANT_ID,
      relatedWorkflowStepId: step!.id,
      envelope: {
        type: "workflow_step",
        version: 2,
        tenantId: SEED_TENANT_ID,
        occurredAt: new Date().toISOString(),
        payload: { workflowStepId: step!.id },
      },
      errorKind: input.errorKind ?? "retryable",
      attempts: 3,
      lastError: "deterministic test failure",
      replayable: input.replayable ?? true,
    }).returning();
    return { deadLetterId: deadLetter!.id, stepId: step!.id, runId: run!.id };
  });
}

describe.skipIf(!available)("governed DLQ routes", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await seed(DB_URL);
    await withTenant(OTHER_TENANT_ID, (db) => db.insert(tenants).values({
      id: OTHER_TENANT_ID,
      name: "Scope-2 tenant-isolation probe",
    }).onConflictDoNothing());
  });

  afterAll(async () => {
    await closePool();
  });

  it("requires owner authority and tenant-scopes list/inspect", async () => {
    const target = await makeStepDeadLetter();
    const forbidden = await listDlq(request("/api/dlq", { role: "analyst" }));
    expect(forbidden.status).toBe(403);

    const listed = await listDlq(request("/api/dlq"));
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { deadLetters: Array<{ id: string; relatedWorkflowRunId: string | null }> };
    expect(listBody.deadLetters).toContainEqual(expect.objectContaining({
      id: target.deadLetterId,
      relatedWorkflowRunId: target.runId,
    }));

    const isolated = await inspectDlq(request(`/api/dlq/${target.deadLetterId}`, { tenantId: OTHER_TENANT_ID }), {
      params: Promise.resolve({ id: target.deadLetterId }),
    });
    expect(isolated.status).toBe(404);
  });

  it("replays only a fenced pre-effect step and records both governed controls", async () => {
    const target = await makeStepDeadLetter();
    const response = await replayDlq(request(`/api/dlq/${target.deadLetterId}/replay`, {
      method: "POST",
      body: { expectedVersion: 1, reason: "operator verified the failure was pre-dispatch", controlKey: `replay:${target.deadLetterId}` },
    }), { params: Promise.resolve({ id: target.deadLetterId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, workflowRunId: target.runId, version: 2 });

    const state = await withTenant(SEED_TENANT_ID, async (db) => {
      const [deadLetter] = await db.select().from(deadLetters).where(eq(deadLetters.id, target.deadLetterId));
      const [step] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, target.stepId));
      const controls = await db.select().from(runtimeOperatorControls).where(and(
        eq(runtimeOperatorControls.tenantId, SEED_TENANT_ID),
        sql`${runtimeOperatorControls.targetId} IN (${target.deadLetterId}::uuid, ${target.stepId}::uuid)`,
      ));
      return { deadLetter, step, controls };
    });
    expect(state.deadLetter).toMatchObject({ status: "replayed", version: 2 });
    expect(state.step).toMatchObject({ status: "pending", executionState: "authorized", dispatchGeneration: 1 });
    expect(state.controls.map((row) => row.controlType).sort()).toEqual(["dlq_replay", "step_redrive"]);
    expect(state.controls.every((row) => row.authorityDecisionId && row.actorId && row.reason)).toBe(true);

    const duplicate = await replayDlq(request(`/api/dlq/${target.deadLetterId}/replay`, {
      method: "POST",
      body: { expectedVersion: 1, reason: "operator verified the failure was pre-dispatch", controlKey: `replay:${target.deadLetterId}` },
    }), { params: Promise.resolve({ id: target.deadLetterId }) });
    expect(duplicate.status).toBe(409);
  });

  it("blocks replay after a possible effect and preserves the unknown outcome", async () => {
    const target = await makeStepDeadLetter({ errorKind: "unknown_outcome", afterPossibleEffect: true });
    const response = await replayDlq(request(`/api/dlq/${target.deadLetterId}/replay`, {
      method: "POST",
      body: { expectedVersion: 1, reason: "requesting replay without reconciliation", controlKey: `unsafe-replay:${target.deadLetterId}` },
    }), { params: Promise.resolve({ id: target.deadLetterId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "reconciliation_required" });

    const [step] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, target.stepId)));
    expect(step).toMatchObject({ status: "failed", executionState: "failed_after_possible_effect", dispatchGeneration: 0 });
  });

  it("discards append-only history with an optimistic version and rejects stale control", async () => {
    const target = await makeStepDeadLetter({ errorKind: "terminal", replayable: false });
    const stale = await discardDlq(request(`/api/dlq/${target.deadLetterId}/discard`, {
      method: "POST",
      body: { expectedVersion: 2, reason: "stale operator screen", controlKey: `discard-stale:${target.deadLetterId}` },
    }), { params: Promise.resolve({ id: target.deadLetterId }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "version_conflict" });

    const applied = await discardDlq(request(`/api/dlq/${target.deadLetterId}/discard`, {
      method: "POST",
      body: { expectedVersion: 1, reason: "terminal invalid payload retained for audit", controlKey: `discard:${target.deadLetterId}` },
    }), { params: Promise.resolve({ id: target.deadLetterId }) });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ discarded: true, version: 2 });

    const [audit] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(runtimeOperatorControls).where(and(
      eq(runtimeOperatorControls.tenantId, SEED_TENANT_ID),
      eq(runtimeOperatorControls.controlKey, `discard:${target.deadLetterId}`),
    )));
    expect(audit).toMatchObject({ controlType: "dlq_discard", outcome: "applied", expectedVersion: 1 });
    await expectDatabaseRejection(withTenant(SEED_TENANT_ID, (db) => db.update(runtimeOperatorControls)
      .set({ outcome: "rejected" })
      .where(eq(runtimeOperatorControls.id, audit!.id))), /append-only audit evidence/i);
    await expectDatabaseRejection(withTenant(SEED_TENANT_ID, (db) => db.delete(runtimeOperatorControls)
      .where(eq(runtimeOperatorControls.id, audit!.id))), /append-only audit evidence/i);
  });
});
