// Phase 3.6: the two proof tests the pack calls for.
//
// 1. Policy conformance: every registered action type has a real, placeholder-free,
//    versioned policy for Dealer Zero (a live drift check against the actual plugin
//    registry, not a hand-maintained list that can silently go stale).
// 2. e2e on Dealer Zero: lead -> qualification -> proposed water-test -> approve via the
//    REAL API route (not a direct orchestrator call) -> booking recorded -> confirmation
//    queued (emulator, real until Phase 4 flips it to GHL/Vapi) -> full receipt chain
//    asserted. Drives the async workflow steps through the exact same runWorkflowStep
//    handler the real worker uses (tests/integration/vertical-workflows-phase4.test.ts's
//    established pattern), not a shortcut.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";
import {
  withTenant,
  closePool,
  domainPolicies,
  domainActions,
  households,
  technicians,
  leads,
  workflowRuns,
  workflowSteps,
  commands,
  integrationOperations,
  inboxEvents,
  decisionReceipts,
  reconciliationCases,
} from "@finnor/db";
import { eq, and, ne } from "drizzle-orm";
import { createDefaultPluginRegistry, FinnorOrchestrator } from "@finnor/orchestration";
import { createLead } from "@finnor/data-platform";
import { seedDealerZero, DEALER_ZERO_TENANT_ID } from "../../scripts/seed-dealer-zero";
import { seedTenantPolicies } from "../../scripts/seed-tenant-policies";
import { PRICING_CATALOG_ACTION_TYPE } from "../../packages/domain-plugins/shared/pricing-catalog";
import { POST as confirmRoute } from "../../apps/api/app/api/actions/[id]/confirm/route";
import { runWorkflowStep } from "../../apps/worker/src/handlers/run-workflow-step";
import { resetSchedulingEmulator, resetCommunicationsEmulator, getEmulatorHoldStatus, wasEmulatorCallSent } from "@finnor/tools";
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

function confirmRequest(actionId: string): Request {
  return new Request(`http://localhost/api/actions/${actionId}/confirm`, {
    method: "POST",
    headers: { "x-tenant-id": DEALER_ZERO_TENANT_ID, "x-user-role": "owner", "content-type": "application/json" },
    body: JSON.stringify({ note: "approved by e2e proof test" }),
  });
}

async function driveToCompletion(workflowRunId: string, maxIter = 10) {
  for (let i = 0; i < maxIter; i++) {
    const steps = await withTenant(DEALER_ZERO_TENANT_ID, (db) =>
      db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, workflowRunId)).orderBy(workflowSteps.sequence),
    );
    const pending = steps.find((s) => s.status === "pending");
    if (!pending) return steps;
    await runWorkflowStep({ tenantId: DEALER_ZERO_TENANT_ID, workflowStepId: pending.id });
  }
  return withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, workflowRunId)));
}

describe.skipIf(!available)("Phase 3.6 proof tests — policy conformance + Dealer Zero e2e", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    // A1.T2 flipped scheduling's default to native — pin emulator explicitly so this
    // test's getEmulatorHoldStatus()/wasEmulatorCallSent() assertions still hold.
    process.env.SCHEDULING_BINDING = "emulator";
    await migrate(DB_URL);
    await seed(DB_URL);
    await seedDealerZero();
    await seedTenantPolicies(DEALER_ZERO_TENANT_ID, { reviewLinkUrl: "https://g.page/r/dealer-zero-finnor-water-co/review" });
    await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.delete(reconciliationCases).where(eq(reconciliationCases.tenantId, DEALER_ZERO_TENANT_ID)));
  }, 60_000);
  afterAll(async () => {
    await closePool();
  });

  it("policy conformance: every registered action type + the pricing_catalog pseudo-row has a real, placeholder-free, versioned policy for Dealer Zero", async () => {
    const registry = createDefaultPluginRegistry();
    const registeredTypes = registry.actionTypes();
    expect(registeredTypes.length).toBeGreaterThan(0);

    const rows = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(domainPolicies).where(eq(domainPolicies.tenantId, DEALER_ZERO_TENANT_ID)));
    const byActionType = new Map(rows.map((r) => [r.actionType, r]));

    for (const actionType of [...registeredTypes, PRICING_CATALOG_ACTION_TYPE]) {
      const row = byActionType.get(actionType);
      expect(row, `missing domain_policies row for ${actionType}`).toBeTruthy();
      expect(row!.version, `${actionType} must have a real version >= 1`).toBeGreaterThanOrEqual(1);
      expect(typeof row!.requiresConfirmation).toBe("boolean");
      const hasPlaceholder = JSON.stringify(row!.policy).includes("PLACEHOLDER_NEEDS_REAL_VALUE");
      expect(hasPlaceholder, `${actionType}'s policy still has a placeholder`).toBe(false);
    }
  }, 30_000);

  it("e2e: lead -> qualification -> proposed water-test -> approve via the real API route -> booking recorded -> confirmation queued -> full receipt chain", async () => {
    resetSchedulingEmulator();
    resetCommunicationsEmulator();

    // 1. Lead: a real caller, through the same createLead() path a real inbound call
    // uses. A fresh externalId per run — this test itself becomes one more real,
    // permanent event in Dealer Zero's history (see cleanup note below), so re-running
    // it must never collide with a prior run's lead via createLead's own idempotency.
    const runId = `e2e-proof-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const leadResult = await withTenant(DEALER_ZERO_TENANT_ID, (db) =>
      createLead(db, {
        tenantId: DEALER_ZERO_TENANT_ID,
        name: "E2E Proof Test Household",
        phone: "+13195559876",
        address: "1 E2E Proof Test Ln, Cedar Falls, IA",
        source: "voice",
        provenance: { sourceSystem: "e2e_proof_test", externalId: runId },
      }),
    );
    const householdId = leadResult.householdId;
    const [leadRow] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(leads).where(eq(leads.id, leadResult.leadId)));
    expect(leadRow!.status).toBe("new");

    // 2. Qualification.
    await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.update(leads).set({ status: "qualified" }).where(eq(leads.id, leadResult.leadId)));
    const [qualified] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(leads).where(eq(leads.id, leadResult.leadId)));
    expect(qualified!.status).toBe("qualified");

    // 3. Proposed water-test: a real technician, drafted through the real orchestrator —
    // gated true (policy-matrix.md §18), so this lands as a real pending approval.
    const [tech] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(technicians).where(eq(technicians.tenantId, DEALER_ZERO_TENANT_ID)).limit(1));
    const orchestrator = new FinnorOrchestrator();
    const scheduledAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const { action } = await orchestrator.draftKnownAction(
      "start_water_test_workflow",
      { householdId, technicianId: tech!.id, scheduledAt, phoneNumber: "+13195559876" },
      DEALER_ZERO_TENANT_ID,
      { source: "e2e_proof_test" },
    );
    const [pendingRow] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, action.id)));
    expect(pendingRow!.status).toBe("pending");

    // 4. Approve via the REAL API route (not a direct orchestrator.decide() call) —
    // exercises auth, RBAC, and the confirm route's own status transitions for real.
    const res = await confirmRoute(confirmRequest(action.id), { params: Promise.resolve({ id: action.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.status).toBe("success");
    const { workflowRunId: outerWorkflowRunId, commandId: outerCommandId } = body.result.output as { workflowRunId: string; commandId: string };
    expect(outerWorkflowRunId).toBeTruthy();

    // 5. Drive the authorization envelope and the child workflow through the real
    // worker handlers. The approval response names the single-action envelope; the
    // plugin creates the business workflow only when that worker executes.
    expect((await driveDurableAction(DEALER_ZERO_TENANT_ID, action.id)).status).toBe("success");
    const [childRun] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select({ id: workflowRuns.id, commandId: workflowRuns.commandId }).from(workflowRuns)
      .innerJoin(workflowSteps, and(eq(workflowSteps.tenantId, DEALER_ZERO_TENANT_ID), eq(workflowSteps.workflowRunId, workflowRuns.id)))
      .where(and(eq(workflowRuns.tenantId, DEALER_ZERO_TENANT_ID), ne(workflowRuns.workflowType, "single_action"), eq(workflowSteps.domainActionId, action.id))).limit(1));
    expect(childRun).toBeTruthy();
    const workflowRunId = childRun!.id;
    const steps = await driveToCompletion(workflowRunId);
    expect(steps.every((s) => s.status === "completed")).toBe(true);
    expect(steps.map((s) => s.stepType).sort()).toEqual(["confirm_appointment", "hold_appointment", "send_confirmation_call"]);

    // 6. Booking recorded: the hold really landed in the (emulator, until Phase 4) scheduling provider.
    const holdStep = steps.find((s) => s.stepType === "hold_appointment")!;
    const holdId = (holdStep.evidence as { output: { holdId: string } }).output.holdId;
    expect(getEmulatorHoldStatus(holdId)).toBe("confirmed");

    // 7. Confirmation queued: the (emulator, until Phase 4) communications provider really got the call.
    const confirmationKey = `lead-to-water-test:${householdId}:${scheduledAt}:confirm-call`;
    expect(wasEmulatorCallSent(confirmationKey)).toBe(true);

    // 8. Full receipt chain: every step opened a real DecisionReceipt with a real
    // finalized outcome — the actual audit trail a dealer/owner would inspect via "Why?"
    // in the cockpit (Phase 7), not a placeholder.
    for (const step of steps) {
      const [receipt] = await withTenant(DEALER_ZERO_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, step.id)));
      expect(receipt, `no receipt for step ${step.stepType}`).toBeTruthy();
      expect(receipt!.finalizedAt).not.toBeNull();
      expect(receipt!.actualResult).not.toBeNull();
      expect(receipt!.failure).toBeNull();
    }

    // Cleanup — the workflow-runtime execution internals only (matching
    // vertical-workflows-phase4.test.ts's own cleanWorkflowRun pattern). Deliberately
    // NOT deleting domain_actions, leads, or households: this run is now real Dealer
    // Zero business history (a real lead, really qualified, a real water test really
    // booked) — and action_log's append-only trigger (migration 0015) would refuse the
    // domain_actions delete anyway, since a real audit trail references it. Dealer
    // Zero is designed to accumulate exactly this kind of record forever.
    await withTenant(DEALER_ZERO_TENANT_ID, async (db) => {
      for (const s of steps) {
        await db.delete(integrationOperations).where(eq(integrationOperations.workflowStepId, s.id));
        await db.delete(inboxEvents).where(eq(inboxEvents.matchedStepId, s.id));
        await db.delete(decisionReceipts).where(eq(decisionReceipts.workflowStepId, s.id));
      }
      await db.delete(workflowSteps).where(eq(workflowSteps.workflowRunId, workflowRunId));
      await db.delete(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
      await db.delete(commands).where(eq(commands.id, childRun!.commandId));
      const outerSteps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, outerWorkflowRunId));
      for (const s of outerSteps) {
        await db.delete(integrationOperations).where(eq(integrationOperations.workflowStepId, s.id));
        await db.delete(decisionReceipts).where(eq(decisionReceipts.workflowStepId, s.id));
      }
      await db.delete(workflowSteps).where(eq(workflowSteps.workflowRunId, outerWorkflowRunId));
      await db.delete(workflowRuns).where(eq(workflowRuns.id, outerWorkflowRunId));
      await db.delete(commands).where(eq(commands.id, outerCommandId));
    });
  }, 30_000);
});
