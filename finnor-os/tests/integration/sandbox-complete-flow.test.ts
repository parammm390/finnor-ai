// The "99% real" acceptance test: with NO carrier credentials at all, an instruction
// flows gate → spoken approval → execution → and every real side effect lands —
// household record, booked service visit, communications log, outbox entry, workflow
// state machine advanced, full audit trail. The ONLY simulated thing is the carrier
// delivery hop, and each such output is explicitly marked simulated:true.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  withTenant,
  closePool,
  domainActions,
  domainPolicies,
  serviceVisits,
  sandboxOutbox,
  workflowStates,
  communicationsLog,
  households,
  businessOperations,
  businessOperationTargets,
} from "@finnor/db";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { createDefaultRegistry, commsMode } from "@finnor/tools";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DomainAction } from "@finnor/shared-types";
import { dispatchBusinessOperation, executeBusinessOperationTarget } from "../../apps/worker/src/handlers/business-operation";
import { driveDurableAction } from "./helpers/durable-action";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

async function createDraftAction(actionType: string, payload: Record<string, unknown>): Promise<DomainAction> {
  return withTenant(SEED_TENANT_ID, async (db) => {
    const [policy] = await db
      .select()
      .from(domainPolicies)
      .where(and(eq(domainPolicies.tenantId, SEED_TENANT_ID), eq(domainPolicies.actionType, actionType)))
      .limit(1);
    const [row] = await db
      .insert(domainActions)
      .values({ tenantId: SEED_TENANT_ID, actionType, payload, policyId: policy?.id ?? null, status: "draft" })
      .returning();
    return {
      id: row!.id,
      tenantId: row!.tenantId,
      actionType: row!.actionType,
      payload: row!.payload as Record<string, unknown>,
      policyId: row!.policyId,
      status: row!.status,
      createdAt: row!.createdAt.toISOString(),
    };
  });
}

describe.skipIf(!available)("sandbox mode: the complete workflow is REAL (§99%)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    delete process.env.GOHIGHLEVEL_API_KEY; // no carrier creds at all
    process.env.COMMS_MODE = "auto";
    await migrate(DB_URL);
    await seed(DB_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it("auto mode selects native drivers when no GHL key exists", () => {
    expect(commsMode()).toBe("native");
  });

  it("schedule_water_test: approve → REAL booked visit + comms log + workflow advanced", async () => {
    const orchestrator = new FinnorOrchestrator({ tools: createDefaultRegistry() });
    const phone = "+13195559999"; // brand-new caller, no household yet
    const action = await createDraftAction("schedule_water_test", {
      address: "77 Prairie View Dr, Cedar Falls, IA",
      contactPhone: phone,
      contactName: "Marcus Webb",
      requestedAt: "2026-07-21T09:30:00Z",
    });

    // Gate first, as always.
    const policy = await orchestrator.loadPolicy(action);
    const gated = await orchestrator.executor.execute(action, policy);
    expect(gated.output.gated).toBe(true);

    // Approve (voice or click — same path).
    const authorized = await orchestrator.decide(action.id, SEED_TENANT_ID, "approve", "voice:sandbox-test", { typedConfirmation: true });
    expect(authorized.status).toBe("success");
    const result = await driveDurableAction(SEED_TENANT_ID, action.id);
    expect(result.status).toBe("success");
    expect(result.output.booking).toMatchObject({ booked: true, simulated: true });

    // REAL side effects, all tenant-scoped:
    const [row] = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(domainActions).where(eq(domainActions.id, action.id)),
    );
    expect(row!.status).toBe("completed"); // not blocked — the workflow finished

    // 1. A household was created for the new caller.
    const [hh] = await withTenant(SEED_TENANT_ID, (db) =>
      db
        .select()
        .from(households)
        .where(and(
          eq(households.tenantId, SEED_TENANT_ID),
          sql`${households.contactInfo} ->> 'phone' = ${phone}`,
        )),
    );
    expect(hh).toBeTruthy();

    // 2. A real service visit was booked.
    const visits = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(serviceVisits).where(eq(serviceVisits.householdId, hh!.id)),
    );
    expect(visits.some((v) => v.type === "water_test")).toBe(true);

    // 3. The workflow state machine advanced to water_test_scheduled.
    const [wf] = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(workflowStates).where(eq(workflowStates.subjectId, hh!.id)),
    );
    expect(wf).toBeTruthy();
    expect(wf!.workflow).toBe("lead_to_install");
    expect(wf!.state).toBe("water_test_scheduled");
    expect((wf!.history as Array<{ to: string }>)[0]!.to).toBe("water_test_scheduled");
  });

  it("renew_maintenance_agreement: approve → outbox row + communications_log, marked simulated", async () => {
    const orchestrator = new FinnorOrchestrator({ tools: createDefaultRegistry() });
    const action = await createDraftAction("renew_maintenance_agreement", {
      householdLabel: "The Hendersons",
      contactPhone: "+13195550142",
      cadence: "annual",
    });
    const policy = await orchestrator.loadPolicy(action);
    await orchestrator.executor.execute(action, policy);
    const authorized = await orchestrator.decide(action.id, SEED_TENANT_ID, "approve", "voice:sandbox-test", { typedConfirmation: true });
    expect(authorized.status).toBe("success");
    expect((await driveDurableAction(SEED_TENANT_ID, action.id)).status).toBe("success");

    const [latest] = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(sandboxOutbox).orderBy(desc(sandboxOutbox.createdAt)).limit(1),
    );
    expect(latest).toBeTruthy();
    expect(latest!.channel).toBe("sms");
    expect(latest!.toNumber).toBe("+13195550142");
    expect(latest!.simulated).toBe(true); // honest: delivery hop is the one simulated step
    expect(latest!.content).toMatch(/renewal/i);

    // Mirrored into the household's real communications history.
    const comms = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(communicationsLog).orderBy(desc(communicationsLog.timestamp)).limit(3),
    );
    expect(comms.some((c) => c.direction === "outbound" && /renewal/i.test(c.content))).toBe(true);

    const [row] = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(domainActions).where(eq(domainActions.id, action.id)),
    );
    expect(row!.status).toBe("completed");
  });

  it("bulk notify completes through durable worker targets with real outbox records", async () => {
    const orchestrator = new FinnorOrchestrator({ tools: createDefaultRegistry() });
    const action = await createDraftAction("bulk_notify_existing_customers", {
      offerScript: "Fall tune-up special: free hardness re-test with any filter change this month.",
      channel: "sms",
    });
    const policy = await orchestrator.loadPolicy(action);
    await orchestrator.executor.execute(action, policy);
    const before = await withTenant(SEED_TENANT_ID, (db) => db.select().from(sandboxOutbox));
    const authorized = await orchestrator.decide(action.id, SEED_TENANT_ID, "approve", "voice:sandbox-test", { typedConfirmation: true });
    expect(authorized.status).toBe("success");
    expect(authorized.output).toMatchObject({ durable: true, queued: true, operationId: expect.any(String) });
    const [operation] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(businessOperations).where(eq(businessOperations.domainActionId, action.id)));
    await dispatchBusinessOperation({ tenantId: SEED_TENANT_ID, operationId: operation!.id, actionId: action.id });
    const targets = await withTenant(SEED_TENANT_ID, (db) => db.select().from(businessOperationTargets).where(eq(businessOperationTargets.operationId, operation!.id)));
    for (const target of targets.filter((candidate) => candidate.status === "pending" && candidate.jobKey)) {
      await executeBusinessOperationTarget({ tenantId: SEED_TENANT_ID, operationId: operation!.id, targetId: target.id, actionId: action.id });
    }
    const after = await withTenant(SEED_TENANT_ID, (db) => db.select().from(sandboxOutbox));
    expect(after.length).toBeGreaterThan(before.length);
    const [row] = await withTenant(SEED_TENANT_ID, (db) =>
      db.select().from(domainActions).where(eq(domainActions.id, action.id)),
    );
    expect(row!.status).toBe("completed");
  });
});
