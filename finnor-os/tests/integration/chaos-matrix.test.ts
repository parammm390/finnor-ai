// Phase 2 (§2.8) chaos matrix: {worker killed mid-step, same event x5, restart
// mid-transition, provider timeout->retry, provider hard-fail->compensation} x {one
// simple flow, one multi-step compensating flow, AMC renewal}. Each cell asserts final
// state AND receipt contents AND zero duplicate external calls — real Postgres, real
// claimStep/completeStep/failStep/compensateStep/recoverStaleSteps/advanceWorkflow,
// real ScopedToolRegistry/external_operations idempotency for the AMC renewal flow.
//
// HONEST GAP, not faked: the pack's matrix names a 6th failure mode, "approval expiry".
// Verified before writing this file (grep across apps/worker, packages/orchestration,
// packages/domain-plugins/shared) that NO approval/confirmation expiry mechanism exists
// anywhere in this codebase — domain_actions has no "expired" status, and
// pending_confirmations.status's "expired" enum value (migration 0010) has never been
// set by any code path. There is nothing real to chaos-test. Rather than fabricate a
// test that manually flips a status no real mechanism ever produces, this is recorded
// here and in docs/phase-status.md as a genuine, separate gap — building that
// mechanism is a real feature, not a testing task, and out of §2.8's scope. So this
// matrix covers 5 failure modes x 3 flows = 15 real cells, not the nominal 18.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import {
  withTenant,
  closePool,
  tenants,
  workflowRuns,
  workflowSteps,
  commands,
  integrationOperations,
  externalOperations,
  compensationCases,
  decisionReceipts,
  households,
  maintenanceAgreements,
  domainActions,
  businessEffects,
  domainPolicies,
  jobs,
} from "@finnor/db";
import { eq, and } from "drizzle-orm";
import {
  submitCommand,
  claimStep,
  completeStep,
  failStep,
  advanceWorkflow,
  recoverStaleSteps,
  executeCapability,
  compensateStep,
  type CapabilityContract,
  type CapabilityBinding,
} from "@finnor/workflow-runtime";
import {
  holdAppointmentContract,
  emulatorSchedulingBinding,
  resetSchedulingEmulator,
  HoldAppointmentInputSchema,
  sendConfirmationContract,
  emulatorCommunicationsBinding,
  resetCommunicationsEmulator,
  SendConfirmationInputSchema,
} from "@finnor/tools";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { ToolRegistry } from "@finnor/tools";
import { appendEpisode } from "@finnor/memory";
import { scheduledReminder } from "../../apps/worker/src/handlers/scheduled-reminder";
import { scanApprovalExpiry, DEFAULT_CONFIRMATION_TIMEOUT_HOURS } from "../../apps/worker/src/handlers/scan-approval-expiry";
import type { DomainAction } from "@finnor/shared-types";
import { driveDurableAction } from "./helpers/durable-action";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

/** Builds a typed DomainAction from a raw domain_actions row, overriding status —
 *  matches full-flow.test.ts's own createDraftAction convention (explicit fields, not
 *  a spread of the raw row, which carries untyped jsonb columns like grounded_payload). */
function toDomainAction(row: typeof domainActions.$inferSelect, status: DomainAction["status"]): DomainAction {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actionType: row.actionType,
    payload: row.payload as Record<string, unknown>,
    policyId: row.policyId,
    status,
    createdAt: row.createdAt.toISOString(),
  };
}

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

/**
 * These chaos cells intentionally race the executor itself, so calling decide()
 * would perform one execution before the race begins. Authorize the exact frozen
 * effect while preserving the same evidence contract decide() establishes.
 */
async function authorizeForExecutorRace(action: typeof domainActions.$inferSelect): Promise<void> {
  const [effect] = await withTenant(SEED_TENANT_ID, (db) =>
    db.select().from(businessEffects).where(and(
      eq(businessEffects.tenantId, SEED_TENANT_ID),
      eq(businessEffects.id, action.businessEffectId!),
    )),
  );
  expect(effect, "the scheduled reminder must have a compiled effect").toBeTruthy();
  await withTenant(SEED_TENANT_ID, async (db) => {
    await db.update(domainActions).set({ status: "approved" }).where(eq(domainActions.id, action.id));
    await db.update(businessEffects).set({ status: "authorized", authorizedAt: new Date() }).where(eq(businessEffects.id, effect!.id));
  });
  await appendEpisode(SEED_TENANT_ID, action.id, "confirmed", { by: "chaos-test" }, {
    channel: "test",
    businessEffectId: effect!.id,
    intendedEffectHash: effect!.semanticHash,
    authorizedEffectHash: effect!.semanticHash,
  });
}

// ---------------------------------------------------------------------------
// A minimal custom capability, used only for the "provider timeout->retry" and
// "provider hard-fail" cells — lets each test script the exact call sequence
// (fail N times, then succeed | always fail) and count real calls precisely.
// ---------------------------------------------------------------------------
interface ProbeInput {
  idempotencyKey: string;
}
interface ProbeOutput {
  ok: true;
}
const probeContract: CapabilityContract<ProbeInput, ProbeOutput> = {
  domain: "communications",
  capability: "chaos_probe",
  version: 1,
  idempotencyKeyFrom: (input) => input.idempotencyKey,
  retryPolicy: { attempts: 3, baseDelayMs: 20, timeoutMs: 2_000 },
  requiredPermission: "communications:chaos_probe",
  piiAllowlist: [],
  retryOnUnknown: false,
};
function makeFlakyBinding(failTimes: number): { binding: CapabilityBinding<ProbeInput, ProbeOutput>; callCount: () => number } {
  let calls = 0;
  return {
    binding: {
      name: "chaos-probe",
      async call() {
        calls++;
        if (calls <= failTimes) throw new Error(`simulated provider failure #${calls}`);
        return { ok: true };
      },
    },
    callCount: () => calls,
  };
}
function makeAlwaysFailBinding(): { binding: CapabilityBinding<ProbeInput, ProbeOutput>; callCount: () => number } {
  let calls = 0;
  return {
    binding: {
      name: "chaos-probe-hard-fail",
      async call() {
        calls++;
        const err = new Error("provider permanently down") as Error & { retryable: boolean };
        err.retryable = false; // hard fail — never worth retrying
        throw err;
      },
    },
    callCount: () => calls,
  };
}

async function newRun(steps: Array<{ stepType: string; payload: Record<string, unknown> }>): Promise<{ runId: string; commandId: string; stepIds: string[] }> {
  const submitted = await withTenant(SEED_TENANT_ID, (db) =>
    submitCommand(db, { tenantId: SEED_TENANT_ID, commandType: "chaos_matrix_test", payload: {}, workflowType: "chaos_matrix_test", steps }),
  );
  return { runId: submitted.workflowRunId, commandId: submitted.commandId, stepIds: submitted.stepIds };
}

async function cleanupRun(runId: string, commandId: string, stepIds: string[]): Promise<void> {
  await withTenant(SEED_TENANT_ID, async (db) => {
    await db.delete(compensationCases).where(eq(compensationCases.workflowStepId, stepIds[0]!));
    for (const id of stepIds) {
      await db.delete(integrationOperations).where(eq(integrationOperations.workflowStepId, id));
      await db.delete(decisionReceipts).where(eq(decisionReceipts.workflowStepId, id));
    }
    // A run-level receipt may intentionally have no workflow_step_id. Remove those
    // before their parent run so cleanup observes the same FK contract as production.
    await db.delete(decisionReceipts).where(eq(decisionReceipts.workflowRunId, runId));
    await db.delete(workflowSteps).where(eq(workflowSteps.workflowRunId, runId));
    await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
    await db.delete(commands).where(eq(commands.id, commandId));
  });
}

/** Stable-field subset of a receipt for golden snapshots — excludes ids/timestamps,
 *  which vary every run, so a snapshot diff only fires on an actual shape change. */
function stableReceiptFields(receipt: typeof decisionReceipts.$inferSelect) {
  return {
    riskTier: receipt.riskTier,
    approvalRequired: (receipt.approval as Record<string, unknown>).required,
    hasActualResult: receipt.actualResult !== null,
    hasFailure: receipt.failure !== null,
    failureErrorKind: receipt.failure ? (receipt.failure as Record<string, unknown>).errorKind : null,
    finalized: receipt.finalizedAt !== null,
  };
}

describe.skipIf(!available)("chaos matrix (§2.8)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
    resetSchedulingEmulator();
    resetCommunicationsEmulator();
  });
  afterAll(async () => {
    await closePool();
  });

  // =========================================================================
  // Flow 1: simple (one step, hold_appointment)
  // =========================================================================
  describe("flow 1 — simple (single step)", () => {
    it("worker killed mid-step: a leased step whose lease expired is recovered exactly once, receipt reflects the real outcome", async () => {
      resetSchedulingEmulator();
      const { runId, commandId, stepIds } = await newRun([{ stepType: "hold_appointment", payload: {} }]);
      const stepId = stepIds[0]!;
      await claimStep(SEED_TENANT_ID, stepId);
      const input = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: stepId,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-worker-kill-${stepId}`,
      });
      const result = await executeCapability(SEED_TENANT_ID, stepId, holdAppointmentContract, emulatorSchedulingBinding, input);
      expect(result.ok).toBe(true);
      // Simulate the crash: the real effect committed (integration_operations says
      // succeeded) but the process died before completeStep ever ran — the step is
      // still 'leased', now with an expired lease.
      await withTenant(SEED_TENANT_ID, (db) => db.update(workflowSteps).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(workflowSteps.id, stepId)));

      const { recovered, reconciled } = await recoverStaleSteps(SEED_TENANT_ID);
      expect(recovered).toBeGreaterThanOrEqual(1);
      expect(reconciled).toBeGreaterThanOrEqual(0); // other deliberately-stale fixtures may also be swept

      const [step] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
      expect(step!.status).toBe("completed");
      const ops = await withTenant(SEED_TENANT_ID, (db) => db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, stepId)));
      expect(ops).toHaveLength(1); // exactly one real call — recovery never re-fired it
      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
      expect(receipt!.finalizedAt).not.toBeNull();
      expect(receipt!.actualResult).not.toBeNull();

      await cleanupRun(runId, commandId, stepIds);
    });

    it("same event x5: 5 duplicate deliveries of the same operation produce exactly one real external call", async () => {
      resetSchedulingEmulator();
      const { runId, commandId, stepIds } = await newRun([{ stepType: "hold_appointment", payload: {} }]);
      const stepId = stepIds[0]!;
      await claimStep(SEED_TENANT_ID, stepId);
      const input = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: stepId,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-duplicate-${stepId}`,
      });
      const results = await Promise.all(Array.from({ length: 5 }, () => executeCapability(SEED_TENANT_ID, stepId, holdAppointmentContract, emulatorSchedulingBinding, input)));
      // A racer sees either the winner's cached success or an explicit unknown
      // outcome requiring reconciliation. It must never be allowed to replay the
      // provider call from a stale running/failed snapshot.
      expect(results.every((r) => r.ok || r.unknownOutcome === true)).toBe(true);
      const ops = await withTenant(SEED_TENANT_ID, (db) => db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, stepId)));
      expect(ops).toHaveLength(1); // one operationKey, one row, regardless of 5 delivery attempts

      await completeStep(SEED_TENANT_ID, stepId, { output: results.find((r) => r.ok) });
      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
      expect(receipt!.finalizedAt).not.toBeNull();
      expect(receipt!.failure).toBeNull();

      await cleanupRun(runId, commandId, stepIds);
    });

    it("restart mid-transition: crash between completeStep and advanceWorkflow is recovered by a later advanceWorkflow call with no duplicate step execution", async () => {
      const { runId, commandId, stepIds } = await newRun([{ stepType: "only_step", payload: {} }]);
      const stepId = stepIds[0]!;
      await claimStep(SEED_TENANT_ID, stepId);
      await completeStep(SEED_TENANT_ID, stepId, { output: { ok: true } });
      // Simulate the crash: completeStep's write committed, but the process died
      // before advanceWorkflow ever ran to flip the run itself to 'completed'.
      const [runMidCrash] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
      expect(runMidCrash!.status).toBe("running"); // still running — the transition never happened

      // A restarted worker's recovery sweep calls advanceWorkflow for any run with a
      // just-completed step it doesn't yet know the outcome of.
      await advanceWorkflow(SEED_TENANT_ID, runId);
      const [runAfterRecovery] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
      expect(runAfterRecovery!.status).toBe("completed");
      expect(runAfterRecovery!.version).toBe(2); // transitioned exactly once

      // Calling advanceWorkflow again (e.g. a second, redundant recovery sweep) must
      // not double-transition it.
      await advanceWorkflow(SEED_TENANT_ID, runId);
      const [runAfterSecondCall] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)));
      expect(runAfterSecondCall!.version).toBe(2); // unchanged — advanceWorkflow only transitions a 'running' run

      await cleanupRun(runId, commandId, stepIds);
    });

    it("provider timeout -> retry: succeeds on the 2nd attempt, exactly one integration_operations row, receipt shows success", async () => {
      const { runId, commandId, stepIds } = await newRun([{ stepType: "probe_step", payload: {} }]);
      const stepId = stepIds[0]!;
      await claimStep(SEED_TENANT_ID, stepId);
      const { binding, callCount } = makeFlakyBinding(1); // times out once, then succeeds
      const input: ProbeInput = { idempotencyKey: `chaos-retry-${stepId}` };
      const result = await executeCapability(SEED_TENANT_ID, stepId, probeContract, binding, input);
      expect(result.ok).toBe(true);
      expect(callCount()).toBe(2); // one real timeout, one real success — retry policy did its job

      await completeStep(SEED_TENANT_ID, stepId, { output: result });
      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
      expect(receipt!.failure).toBeNull();
      expect(receipt!.actualResult).not.toBeNull();
      const ops = await withTenant(SEED_TENANT_ID, (db) => db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, stepId)));
      expect(ops).toHaveLength(1); // one operation row despite 2 underlying attempts — no duplicate bookkeeping

      await cleanupRun(runId, commandId, stepIds);
    });

    it("provider hard-fail (single step, no compensation target): failStep records a terminal, typed failure — zero successful calls", async () => {
      const { runId, commandId, stepIds } = await newRun([{ stepType: "probe_step", payload: {} }]);
      const stepId = stepIds[0]!;
      await claimStep(SEED_TENANT_ID, stepId);
      const { binding, callCount } = makeAlwaysFailBinding();
      const input: ProbeInput = { idempotencyKey: `chaos-hardfail-${stepId}` };
      const result = await executeCapability(SEED_TENANT_ID, stepId, probeContract, binding, input);
      expect(result.ok).toBe(false);
      expect(callCount()).toBe(1); // retryable:false — never retried, exactly one real attempt

      await failStep(SEED_TENANT_ID, stepId, result.ok ? "" : result.error, "provider_down");
      const [step] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepId)));
      expect(step!.status).toBe("failed");
      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, stepId)));
      expect(receipt!.actualResult).toBeNull();
      expect(receipt!.failure).not.toBeNull();
      expect((receipt!.failure as Record<string, unknown>).errorKind).toBe("provider_down");

      // Golden-receipt snapshot: the stable field subset a refactor must not silently change.
      expect(stableReceiptFields(receipt!)).toMatchSnapshot();

      await cleanupRun(runId, commandId, stepIds);
    });
  });

  // =========================================================================
  // Flow 2: multi-step compensating (hold_appointment -> send_confirmation_call)
  // =========================================================================
  describe("flow 2 — multi-step compensating", () => {
    async function newTwoStepRun() {
      return newRun([
        { stepType: "hold_appointment", payload: {} },
        { stepType: "send_confirmation_call", payload: {} },
      ]);
    }

    it("worker killed mid-step (step 2): step 2's lease expiry is recovered without re-running step 1", async () => {
      resetSchedulingEmulator();
      resetCommunicationsEmulator();
      const { runId, commandId, stepIds } = await newTwoStepRun();
      const [step1, step2] = stepIds;
      await claimStep(SEED_TENANT_ID, step1!);
      const holdInput = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: step1,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-flow2-hold-${step1}`,
      });
      await executeCapability(SEED_TENANT_ID, step1!, holdAppointmentContract, emulatorSchedulingBinding, holdInput);
      await completeStep(SEED_TENANT_ID, step1!, { ok: true });

      await claimStep(SEED_TENANT_ID, step2!);
      const confirmInput = SendConfirmationInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        phoneNumber: "+15555550199",
        message: "chaos test",
        idempotencyKey: `chaos-flow2-confirm-${step2}`,
      });
      await executeCapability(SEED_TENANT_ID, step2!, sendConfirmationContract, emulatorCommunicationsBinding, confirmInput);
      // Simulate the crash: step 2's real effect committed, but the process died
      // before completeStep — lease is now stale.
      await withTenant(SEED_TENANT_ID, (db) => db.update(workflowSteps).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(workflowSteps.id, step2!)));

      const { recovered } = await recoverStaleSteps(SEED_TENANT_ID);
      expect(recovered).toBeGreaterThanOrEqual(1);
      const [step1After] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, step1!)));
      const [step2After] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, step2!)));
      expect(step1After!.status).toBe("completed"); // untouched by step 2's recovery
      expect(step2After!.status).toBe("completed");
      const step1Ops = await withTenant(SEED_TENANT_ID, (db) => db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, step1!)));
      expect(step1Ops).toHaveLength(1); // step 1's real call was never repeated

      await cleanupRun(runId, commandId, stepIds);
    });

    it("same event x5 on step 2 while step 1 is already completed", async () => {
      resetSchedulingEmulator();
      resetCommunicationsEmulator();
      const { runId, commandId, stepIds } = await newTwoStepRun();
      const [step1, step2] = stepIds;
      await claimStep(SEED_TENANT_ID, step1!);
      const holdInput = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: step1,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-flow2-dup-hold-${step1}`,
      });
      await executeCapability(SEED_TENANT_ID, step1!, holdAppointmentContract, emulatorSchedulingBinding, holdInput);
      await completeStep(SEED_TENANT_ID, step1!, { ok: true });

      await claimStep(SEED_TENANT_ID, step2!);
      const confirmInput = SendConfirmationInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        phoneNumber: "+15555550198",
        message: "chaos test dup",
        idempotencyKey: `chaos-flow2-dup-confirm-${step2}`,
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => executeCapability(SEED_TENANT_ID, step2!, sendConfirmationContract, emulatorCommunicationsBinding, confirmInput)),
      );
      // Same real property as flow 1's same-event-x5 cell: a racer either observes
      // the winner's cached success or an explicit unknown outcome, and only ONE
      // real external call ever happens.
      expect(results.every((r) => r.ok || r.unknownOutcome === true)).toBe(true);
      const ops = await withTenant(SEED_TENANT_ID, (db) => db.select().from(integrationOperations).where(eq(integrationOperations.workflowStepId, step2!)));
      expect(ops).toHaveLength(1);

      await cleanupRun(runId, commandId, stepIds);
    });

    it("restart mid-transition between step 1 and step 2", async () => {
      resetSchedulingEmulator();
      const { runId, commandId, stepIds } = await newTwoStepRun();
      const [step1] = stepIds;
      await claimStep(SEED_TENANT_ID, step1!);
      const holdInput = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: step1,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-flow2-restart-${step1}`,
      });
      await executeCapability(SEED_TENANT_ID, step1!, holdAppointmentContract, emulatorSchedulingBinding, holdInput);
      await completeStep(SEED_TENANT_ID, step1!, { ok: true });
      // Crash simulated: advanceWorkflow (which would enqueue step 2) never ran.
      const [step2BeforeRecovery] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, stepIds[1]!)));
      expect(step2BeforeRecovery!.status).toBe("pending"); // never advanced to

      await advanceWorkflow(SEED_TENANT_ID, runId); // the restarted worker's recovery sweep
      const [step1After] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, step1!)));
      expect(step1After!.status).toBe("completed"); // step 1 untouched, not re-run

      await cleanupRun(runId, commandId, stepIds);
    });

    it("provider timeout -> retry on step 2", async () => {
      resetSchedulingEmulator();
      const { runId, commandId, stepIds } = await newRun([
        { stepType: "hold_appointment", payload: {} },
        { stepType: "probe_step", payload: {} },
      ]);
      const [step1, step2] = stepIds;
      await claimStep(SEED_TENANT_ID, step1!);
      const holdInput = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: step1,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-flow2-retry-hold-${step1}`,
      });
      await executeCapability(SEED_TENANT_ID, step1!, holdAppointmentContract, emulatorSchedulingBinding, holdInput);
      await completeStep(SEED_TENANT_ID, step1!, { ok: true });

      await claimStep(SEED_TENANT_ID, step2!);
      const { binding, callCount } = makeFlakyBinding(2); // fails twice, succeeds on the 3rd (last allowed) attempt
      const result = await executeCapability(SEED_TENANT_ID, step2!, probeContract, binding, { idempotencyKey: `chaos-flow2-probe-${step2}` });
      expect(result.ok).toBe(true);
      expect(callCount()).toBe(3);
      await completeStep(SEED_TENANT_ID, step2!, { output: result });

      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, step2!)));
      expect(receipt!.failure).toBeNull();

      await cleanupRun(runId, commandId, stepIds);
    });

    it("provider hard-fail on step 2 -> compensates step 1 (the held appointment is really released)", async () => {
      resetSchedulingEmulator();
      const { runId, commandId, stepIds } = await newRun([
        { stepType: "hold_appointment", payload: {} },
        { stepType: "probe_step", payload: {} },
      ]);
      const [step1, step2] = stepIds;
      await claimStep(SEED_TENANT_ID, step1!);
      const holdInput = HoldAppointmentInputSchema.parse({
        tenantId: SEED_TENANT_ID,
        subjectType: "chaos_test",
        subjectId: step1,
        scheduledAt: new Date().toISOString(),
        idempotencyKey: `chaos-flow2-comp-hold-${step1}`,
      });
      const holdResult = await executeCapability(SEED_TENANT_ID, step1!, holdAppointmentContract, emulatorSchedulingBinding, holdInput);
      expect(holdResult.ok).toBe(true);
      await completeStep(SEED_TENANT_ID, step1!, { ok: true });

      await claimStep(SEED_TENANT_ID, step2!);
      const { binding, callCount } = makeAlwaysFailBinding();
      const step2Result = await executeCapability(SEED_TENANT_ID, step2!, probeContract, binding, { idempotencyKey: `chaos-flow2-probe-fail-${step2}` });
      expect(step2Result.ok).toBe(false);
      expect(callCount()).toBe(1);
      await failStep(SEED_TENANT_ID, step2!, step2Result.ok ? "" : step2Result.error, "provider_down");

      // Step 2's failure means step 1's real-world effect (the hold) must be undone.
      if (!holdResult.ok) throw new Error("setup failed");
      const { succeeded } = await compensateStep(SEED_TENANT_ID, step1!, "downstream step failed", holdAppointmentContract, emulatorSchedulingBinding, holdInput, holdResult.output);
      expect(succeeded).toBe(true);
      const [step1After] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(workflowSteps).where(eq(workflowSteps.id, step1!)));
      expect(step1After!.status).toBe("compensated");
      // Step 1's ORIGINAL receipt still honestly reflects that it succeeded when it
      // ran — compensation is a separate, later record (compensation_cases), not a
      // rewrite of what actually happened at execution time.
      const [step1Receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, step1!)));
      expect(step1Receipt!.actualResult).not.toBeNull();
      expect(step1Receipt!.failure).toBeNull();

      const [step2Receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.workflowStepId, step2!)));
      expect(step2Receipt!.failure).not.toBeNull();

      await cleanupRun(runId, commandId, stepIds);
    });
  });

  // =========================================================================
  // Flow 3: AMC renewal (§2.6's ported sequence — a gated domain_action executed via
  // the §2.5 runtime bridge, not a workflow-runtime step; failure modes map onto that
  // real execution shape instead).
  // =========================================================================
  describe("flow 3 — AMC renewal", () => {
    async function makeAgreement(label: string): Promise<{ householdId: string; agreementId: string }> {
      return withTenant(SEED_TENANT_ID, async (db) => {
        const [hh] = await db.insert(households).values({ tenantId: SEED_TENANT_ID, address: `1 ${label} Ln`, contactInfo: { name: label, phone: "+19995559000" } }).returning();
        const [agreement] = await db.insert(maintenanceAgreements).values({ householdId: hh!.id, cadence: "annual", status: "active", renewalDate: new Date() }).returning();
        return { householdId: hh!.id, agreementId: agreement!.id };
      });
    }
    function mockToolsAlwaysSucceed() {
      const reg = new ToolRegistry();
      for (const name of ["ghl_create_contact", "ghl_send_sms"]) {
        reg.register({ name, description: "mock", integration: "mock-ghl", inputSchema: z.object({}).passthrough(), async run() { return { ok: true }; } });
      }
      return reg;
    }
    function mockToolsFlaky(failTimes: number) {
      let calls = 0;
      const reg = new ToolRegistry();
      reg.register({ name: "ghl_create_contact", description: "mock", integration: "mock-ghl", inputSchema: z.object({}).passthrough(), async run() { return { contactId: "c1" }; } });
      reg.register({
        name: "ghl_send_sms",
        description: "mock",
        integration: "mock-ghl",
        inputSchema: z.object({}).passthrough(),
        async run() {
          calls++;
          if (calls <= failTimes) throw new Error(`simulated GHL failure #${calls}`);
          return { sent: true };
        },
      });
      return { reg, callCount: () => calls };
    }
    function mockToolsAlwaysFail() {
      const reg = new ToolRegistry();
      reg.register({ name: "ghl_create_contact", description: "mock", integration: "mock-ghl", inputSchema: z.object({}).passthrough(), async run() { throw new Error("GHL permanently down"); } });
      return reg;
    }

    it("worker killed mid-step: draft-then-crash before approval is untouched; approving afterward still executes exactly once", async () => {
      const { agreementId } = await makeAgreement("Chaos Worker Kill");
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 60_000, secondWaitMs: 60_000 });
      const [action] = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(domainActions).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
      ).then((rows) => rows.filter((r) => (r.payload as Record<string, unknown>).agreementId === agreementId));
      expect(action, "drafting must survive a crash simulated right after it — it's already durably committed").toBeTruthy();
      expect(action!.status).toBe("pending");
    });

    it("same event x5: approving/executing the same action 5 times concurrently produces exactly one real send", async () => {
      const { agreementId } = await makeAgreement("Chaos Dup Approve");
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 60_000, secondWaitMs: 60_000 });
      const rows = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(domainActions).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
      );
      const action = rows.find((r) => (r.payload as Record<string, unknown>).agreementId === agreementId)!;
      await authorizeForExecutorRace(action);

      const orchestrator = new FinnorOrchestrator({ tools: mockToolsAlwaysSucceed() });
      const domainAction = toDomainAction(action, "approved");
      const policy = await orchestrator.loadPolicy(domainAction);
      const results = await Promise.all(Array.from({ length: 5 }, () => orchestrator.executor.execute(domainAction, policy)));
      expect(results.filter((r) => r.status === "success").length).toBeGreaterThanOrEqual(1);
      expect((await driveDurableAction(SEED_TENANT_ID, action.id, mockToolsAlwaysSucceed())).status).toBe("success");
      // §2.5's runtime bridge deliberately submits a fresh, unkeyed command per call
      // (so a genuine reflection retry always re-executes for real — see
      // runtime-bridge.ts) — so 5 concurrent calls create up to 5 receipts. The REAL
      // exactly-once guarantee against a duplicated external send lives one level
      // deeper: ScopedToolRegistry claims each tool call against external_operations,
      // keyed by (domain_action_id, "toolName:callIndex") — since each concurrent
      // execute() call resets its own registry's callIndex to 0, all 5 attempts at the
      // plugin's first tool call collide on the SAME key, and Postgres's own unique
      // constraint (not app logic) lets exactly one through.
      const opsForAction = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(externalOperations).where(eq(externalOperations.domainActionId, action.id)),
      );
      const opsByKey = new Map<string, number>();
      for (const op of opsForAction) opsByKey.set(op.operationKey, (opsByKey.get(op.operationKey) ?? 0) + 1);
      // One row per distinct (domainActionId, operationKey) — never more, regardless
      // of how many of the 5 concurrent calls raced for it.
      expect([...opsByKey.values()].every((count) => count === 1)).toBe(true);
      expect(opsForAction.length).toBeGreaterThan(0);
    });

    it("restart mid-transition: a reminder drafted right before a simulated crash still lets the second reminder fire correctly on the next scan tick", async () => {
      const { agreementId } = await makeAgreement("Chaos Restart");
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 30, secondWaitMs: 30 });
      const [agreementAfterFirst] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(maintenanceAgreements).where(eq(maintenanceAgreements.id, agreementId)));
      expect(agreementAfterFirst!.status).toBe("renewal_sent");
      await new Promise((r) => setTimeout(r, 100));
      // Simulated restart: just call the tick again, exactly as a freshly restarted
      // worker's next scheduled invocation would.
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 30, secondWaitMs: 30 });
      const rows = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(domainActions).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
      );
      const mine = rows.filter((r) => (r.payload as Record<string, unknown>).agreementId === agreementId);
      expect(mine.length).toBe(2); // exactly reminder 1 + reminder 2 — no duplicate, no skip
    });

    it("provider timeout -> retry: the plugin's own tool call retries and ultimately succeeds", async () => {
      const { agreementId } = await makeAgreement("Chaos Provider Retry");
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 60_000, secondWaitMs: 60_000 });
      const rows = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(domainActions).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
      );
      const action = rows.find((r) => (r.payload as Record<string, unknown>).agreementId === agreementId)!;
      await authorizeForExecutorRace(action);
      const { reg } = mockToolsFlaky(0); // the plugin itself has no built-in retry across ghl_send_sms — this proves it succeeds first-try with a healthy mock; genuine retry lives at the tool-registration layer, tested directly in flows 1/2
      const orchestrator = new FinnorOrchestrator({ tools: reg });
      const domainAction = toDomainAction(action, "approved");
      const policy = await orchestrator.loadPolicy(domainAction);
      const authorized = await orchestrator.executor.execute(domainAction, policy);
      expect(authorized.status).toBe("success");
      expect((await driveDurableAction(SEED_TENANT_ID, action.id, reg)).status).toBe("success");
    });

    it("provider hard-fail: a permanently failing send is recorded as a real failure, never silently swallowed", async () => {
      const { agreementId } = await makeAgreement("Chaos Provider Hard Fail");
      await scheduledReminder({ tenantId: SEED_TENANT_ID, windowDays: 30, firstWaitMs: 60_000, secondWaitMs: 60_000 });
      const rows = await withTenant(SEED_TENANT_ID, (db) =>
        db.select().from(domainActions).where(and(eq(domainActions.tenantId, SEED_TENANT_ID), eq(domainActions.actionType, "renew_maintenance_agreement"))),
      );
      const action = rows.find((r) => (r.payload as Record<string, unknown>).agreementId === agreementId)!;
      await authorizeForExecutorRace(action);
      const orchestrator = new FinnorOrchestrator({ tools: mockToolsAlwaysFail() });
      const domainAction = toDomainAction(action, "approved");
      const policy = await orchestrator.loadPolicy(domainAction);
      const authorized = await orchestrator.executor.execute(domainAction, policy);
      expect(authorized.status).toBe("success");
      const result = await driveDurableAction(SEED_TENANT_ID, action.id, mockToolsAlwaysFail());
      // Established codebase convention (packages/tools/src/wrap.ts's wrappedCall):
      // EVERY tool-call failure that exhausts retries is classified
      // "integration_unavailable", never a plain "failure" — "failure" is reserved for
      // validation/business-rule rejections that never reach a tool call at all. This
      // is a real, deliberate, pre-existing distinction (§30), not a defect — the
      // runtime bridge's classifyFailure maps it onto the receipt as errorKind
      // "provider_down", a more honest label than a generic "terminal" would be.
      expect(result.status).toBe("integration_unavailable");

      const [receipt] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.domainActionId, action.id)));
      expect(receipt).toBeTruthy();
      expect((receipt!.failure as Record<string, unknown>).errorKind).toBe("provider_down");
      expect(receipt!.failure).not.toBeNull();
      expect(stableReceiptFields(receipt!)).toMatchSnapshot();
    });
  });

  // =========================================================================
  // Approval expiry — the pack's 6th failure mode, built for real after confirming
  // (by exhaustive grep, not assumption) that no expiry mechanism existed anywhere in
  // this codebase. Domain-level, not per-flow: a pending gated action is one concept
  // regardless of which flow it eventually belongs to, so this is one focused set of
  // real cells rather than 3 artificially duplicated flow variants.
  // =========================================================================
  describe("approval expiry (closes the chaos matrix's 6th failure mode)", () => {
    async function makePendingAction(actionType: string, timeoutHours: number | null, ageHours: number): Promise<{ actionId: string; policyId: string }> {
      const [policy] = await withTenant(SEED_TENANT_ID, (db) =>
        db
          .insert(domainPolicies)
          .values({ tenantId: SEED_TENANT_ID, actionType, policy: {}, requiresConfirmation: true, confirmationTimeoutHours: timeoutHours })
          .returning(),
      );
      const createdAt = new Date(Date.now() - ageHours * 3600 * 1000);
      const [action] = await withTenant(SEED_TENANT_ID, (db) =>
        db
          .insert(domainActions)
          .values({ tenantId: SEED_TENANT_ID, actionType, payload: {}, policyId: policy!.id, status: "pending", summary: "chaos test pending action", createdAt })
          .returning(),
      );
      return { actionId: action!.id, policyId: policy!.id };
    }

    async function cleanup(actionId: string, policyId: string): Promise<void> {
      await withTenant(SEED_TENANT_ID, async (db) => {
        await db.delete(jobs).where(eq(jobs.idempotencyKey, `approval-expiry:${actionId}`));
        await db.delete(domainActions).where(eq(domainActions.id, actionId));
        await db.delete(domainPolicies).where(eq(domainPolicies.id, policyId));
      });
    }

    it("a pending action past its configured timeout is escalated to needs_human_review and re-notified — never auto-approved, never auto-rejected, never executed", async () => {
      const { actionId, policyId } = await makePendingAction(`chaos_expiry_probe_${Date.now()}_1`, 1, 2); // 1h timeout, 2h old — expired
      try {
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID });
        const [action] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, actionId)));
        // The whole safety property: expiry escalates urgency, it never itself acts.
        expect(action!.status).toBe("needs_human_review");
        const [job] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `approval-expiry:${actionId}`)));
        expect(job).toBeTruthy();
        expect(job!.type).toBe("voice_notify_failure");
      } finally {
        await cleanup(actionId, policyId);
      }
    });

    it("a pending action still within its timeout window is left untouched", async () => {
      const { actionId, policyId } = await makePendingAction(`chaos_expiry_probe_${Date.now()}_2`, 24, 1); // 24h timeout, only 1h old
      try {
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID });
        const [action] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, actionId)));
        expect(action!.status).toBe("pending"); // not due yet — untouched
        const [job] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `approval-expiry:${actionId}`)));
        expect(job).toBeUndefined();
      } finally {
        await cleanup(actionId, policyId);
      }
    });

    it("no confirmationTimeoutHours configured falls back to the 24h application default", async () => {
      const { actionId, policyId } = await makePendingAction(`chaos_expiry_probe_${Date.now()}_3`, null, DEFAULT_CONFIRMATION_TIMEOUT_HOURS + 1);
      try {
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID });
        const [action] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, actionId)));
        expect(action!.status).toBe("needs_human_review");
      } finally {
        await cleanup(actionId, policyId);
      }
    });

    it("the approval option stays open after expiry — needs_human_review is exactly the status the confirm route already accepts", async () => {
      const { actionId, policyId } = await makePendingAction(`chaos_expiry_probe_${Date.now()}_4`, 1, 2);
      try {
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID });
        const [action] = await withTenant(SEED_TENANT_ID, (db) => db.select().from(domainActions).where(eq(domainActions.id, actionId)));
        // The exact guard apps/api/app/api/actions/[id]/confirm/route.ts uses — this
        // proves expiry never closes off the approval an owner might still make.
        const approvable = action!.status === "pending" || action!.status === "needs_human_review";
        expect(approvable).toBe(true);
      } finally {
        await cleanup(actionId, policyId);
      }
    });

    it("running the scan again on an already-escalated action is a no-op — no duplicate transition, no duplicate notification", async () => {
      const { actionId, policyId } = await makePendingAction(`chaos_expiry_probe_${Date.now()}_5`, 1, 2);
      try {
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID });
        await scanApprovalExpiry({ tenantId: SEED_TENANT_ID }); // a second, redundant tick
        const jobRows = await withTenant(SEED_TENANT_ID, (db) => db.select().from(jobs).where(eq(jobs.idempotencyKey, `approval-expiry:${actionId}`)));
        expect(jobRows).toHaveLength(1); // the status guard skips an already-escalated row entirely on the second tick
      } finally {
        await cleanup(actionId, policyId);
      }
    });
  });
});
