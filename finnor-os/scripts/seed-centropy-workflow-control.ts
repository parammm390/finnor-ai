import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { closePool, getPool, receiveWork, transitionWork, users, withTenant, workflowRuns, workflowSteps } from "@finnor/db";
import { advanceWorkflow, claimStep, completeStep, failStep, stepFence, submitCommand } from "@finnor/workflow-runtime";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  assertDisposableDatabaseTarget(url, "CENTROPY authored workflow control fixture");
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Use the named loopback fixture");
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const [owner] = await withTenant(tenantId, (db) => db.select({ id: users.id, status: users.status }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.email, process.env.TEST_OWNER_EMAIL ?? ""), eq(users.role, "owner"))).limit(1));
  if (!owner || owner.status !== "active") throw new Error("An actual active fixture owner is required");
  const id = randomUUID();
  const work = await receiveWork({ tenantId, userId: owner.id, instruction: "Authored disposable workflow-control certification; no provider or live business operation.", channel: "text", instructionId: id, idempotencyKey: id });
  await transitionWork(tenantId, work.workId, "planning", "authored_fixture_preparation", {});
  await transitionWork(tenantId, work.workId, "executing", "authored_fixture_execution", {});
  const submitted = await withTenant(tenantId, (db) => submitCommand(db, {
    tenantId, requestedBy: owner.id, workId: work.workId, commandType: "authored_workflow_control_fixture",
    workflowType: "authored_workflow_control_fixture", payload: { authored: true, noBusinessAssertion: true }, idempotencyKey: id,
    steps: [{ stepType: "authored_local_owner_read", payload: { authored: true } }, { stepType: "authored_known_failure_before_effect", payload: { authored: true } }],
  }));
  const claim = async (stepId: string) => {
    const [job] = await getPool().query<{ id: string }>("SELECT id FROM finnor_os.jobs WHERE payload->>'workflowStepId'=$1 AND type='run_workflow_step_v2' LIMIT 1", [stepId]).then((result) => result.rows);
    if (!job) throw new Error("A physical fixture job was not inserted");
    const step = await claimStep(tenantId, stepId, 0, { workerId: `authored-fixture-driver:${process.pid}`, jobProtocolVersion: 2, eligibilityEvidence: { authored: true, processId: process.pid, physicalJobId: job.id, noProviderOperation: true } });
    if (!step) throw new Error("The exact authored fixture step could not be claimed");
    await getPool().query("UPDATE finnor_os.jobs SET status='completed',completed_at=now() WHERE id=$1 AND status='queued'", [job.id]);
    return step;
  };
  const first = await claim(submitted.stepIds[0]!);
  // The completed fixture step records the real local owner read above, rather
  // than claiming a provider or business mutation. Its evidence must survive retry.
  await completeStep(tenantId, first.id, { authored: true, output: { ownerId: owner.id, ownerStatus: owner.status, source: "finnor_os.users", noBusinessAssertion: true } }, stepFence(first));
  await advanceWorkflow(tenantId, submitted.workflowRunId);
  const second = await claim(submitted.stepIds[1]!);
  await failStep(tenantId, second.id, "Authored controlled failure before any provider operation", "terminal", stepFence(second), "failed_before_effect");
  await advanceWorkflow(tenantId, submitted.workflowRunId);
  const record = await withTenant(tenantId, async (db) => ({
    run: (await db.select().from(workflowRuns).where(eq(workflowRuns.id, submitted.workflowRunId)))[0],
    steps: await db.select().from(workflowSteps).where(eq(workflowSteps.workflowRunId, submitted.workflowRunId)),
  }));
  if (record.run?.status !== "failed") throw new Error("The fixture did not enter an actual known failed state");
  const output = resolve(process.argv[2] ?? "../.centropy-certification/atlas-final-v2/workflow-control-fixture.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ schema: "centropy.workflow-control-fixture/v1", authored: true, tenantId, ownerId: owner.id, workId: work.workId, ...submitted, ...record }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "AUTHORED_KNOWN_FAILURE_CREATED", runId: submitted.workflowRunId, output }));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Fixture failed"); process.exitCode = 1; }).finally(closePool);
