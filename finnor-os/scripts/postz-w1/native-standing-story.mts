/** W004: actual independent standing Work, P6-admitted wait and event-fabric wake.
 * The explicitly disclosed deterministic proposer supplies a single native
 * decision; it does not replace authority, execution or completion verification. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { receiveWork } from "@finnor/db";
import { startWorkObjective, ObjectiveLoopRuntime, controlWorkObjective } from "../../packages/orchestration/src/objective-loop";
import { createDefaultPluginRegistry } from "../../packages/orchestration/src/plugin-registry";
import { ingestIntegrationEvent, objectiveWakeContext } from "../../packages/orchestration/src/event-waits";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { resolveOperatingInteractionContext } from "../../packages/orchestration/src/interaction-context";
import { configureAgentProfile } from "../../packages/orchestration/src/workforce-runtime";
import { closeInternalResources } from "./native-internal-support.mjs";

export async function nativeStandingStory(e: any, sourceFixture: {
  root: any; work: any; sourceId: string; versionId: string;
}) {
  const directory = join(e.evidence, "internal-standing");
  await mkdir(directory, { recursive: true });
  const artifact = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const other = randomUUID();
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
    [other, e.tenant, other + "@standing.example.test"]);
  const http = await nativeHttpFixture(e.admin, e.tenant, e.actor, other);
  const noAct = await receiveWork({ tenantId: e.tenant, userId: e.actor, channel: "console", idempotencyKey: randomUUID(),
    instruction: "Do not monitor, contact anyone, start agents or act. Read the consent order once." });
  const originalMandate = `Keep watching canonical source ${sourceFixture.sourceId}. On its next registered primary.source.reviewed event, read its company world state once, with no business effects or human contact.`;
  const originalDeadline = new Date(Date.now() + 60000);
  let standing: Awaited<ReturnType<typeof startWorkObjective>> | undefined;
  let report: any = { schema: "finnor.w1.standing-event-owning.v1", status: "FAIL", caseIds: ["W004"] };
  const snapshot = async (workId: string) => ({
    work: (await e.admin.query("SELECT * FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [e.tenant, workId])).rows[0],
    inputs: (await e.admin.query("SELECT * FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id", [e.tenant, workId])).rows,
    loops: (await e.admin.query("SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [e.tenant, workId])).rows,
    waits: (await e.admin.query("SELECT * FROM finnor_os.work_event_waits WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id", [e.tenant, workId])).rows,
    wakes: (await e.admin.query("SELECT * FROM finnor_os.work_wake_claims WHERE tenant_id=$1 AND work_id=$2 ORDER BY claimed_at,id", [e.tenant, workId])).rows,
    queries: (await e.admin.query("SELECT * FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 ORDER BY started_at,id", [e.tenant, workId])).rows,
    steps: (await e.admin.query("SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND work_id=$2 ORDER BY step_number,id", [e.tenant, workId])).rows,
    jobs: (await e.admin.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'workId'=$2 ORDER BY run_at,id", [e.tenant, workId])).rows,
    effects: (await e.admin.query("SELECT id,status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 ORDER BY id", [e.tenant, workId])).rows,
  });
  const read = async (work: any) => {
    const before = await snapshot(work.workId);
    const response = await http.call("economic-orchestration-research", {
      schema: "finnor.w1.primary-research-request.v1", mode: "ordinary_disposable", root: sourceFixture.root,
      workId: work.workId, workInputId: work.workInputId, question: "Read the original consent order, with no activation.",
      deadlineAt: new Date(Date.now() + 12000).toISOString(), maxParallel: 1,
      requirements: [{ id: "consentOrder", question: "What is the current recorded order status?",
        sourceId: sourceFixture.sourceId, path: ["diligence", "consentOrder"], valueType: "string", dependsOn: [] }],
    });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body.answers[0].value, "OPEN");
    const after = await snapshot(work.workId);
    assert.deepEqual(after, before);
    return { before, response, after };
  };
  try {
    const informational = await read(sourceFixture.work), doNotAct = await read(noAct);
    for (const observed of [informational, doNotAct])
      for (const field of ["loops", "waits", "wakes", "jobs", "effects"] as const) assert.equal(observed.after[field].length, 0);
    const registry = createDefaultPluginRegistry();
    const admittedWorker = await configureAgentProfile(e.tenant, registry, {
      key: "w1-original-standing-query-wait", name: "Explicit disposable standing query/wait worker",
      actor: e.ctx.auth, capabilityGrants: [
        { kind: "query", capability: "query:pe_world_state" },
        { kind: "wait", capability: "wait:event" },
        { kind: "check", capability: "check:objective_success" },
      ], autonomyLimits: { maxActions: 0, maxQueries: 1, maxReplans: 4,
        maxPlannerCalls: 4, maxWallClockMs: 60000 },
    });
    const originalContext = await resolveOperatingInteractionContext({
      tenantId: e.tenant, channel: "console", context: { entityRefs: [sourceFixture.root] },
    });
    assert(originalContext, "A validated original company context must precede the standing mandate");
    standing = await startWorkObjective(originalMandate, e.ctx.auth, {
      channel: "console", instructionId: randomUUID(), idempotencyKey: randomUUID(), deferInitialIteration: true,
      activeContext: originalContext,
      maxSteps: 4, maxActions: 0, maxQueries: 1, deadlineAt: originalDeadline,
    });
    assert.notEqual(standing.workId, sourceFixture.work.workId);
    assert.notEqual(standing.workId, noAct.workId);
    const actionOwner = (await import("../../apps/api/lib/orchestrator")).getOrchestrator();
    let proposed = 0;
    const runtime = new ObjectiveLoopRuntime(registry, actionOwner, {
      providerName: "EXPLICIT_ORIGINAL_STANDING_DISPOSABLE_PROPOSER_NOT_AN_LLM",
      async decide(input) {
        assert.equal(input.objective, originalMandate);
        assert.equal(input.workId, standing!.workId);
        proposed++;
        if (proposed === 1) return { kind: "wait" as const,
          waitFor: { eventType: "primary.source.reviewed", resource: { type: "evidence_source", id: sourceFixture.sourceId } },
          deadlineAt: originalDeadline.toISOString(), condition: "The exact original source emits its next canonical review event.",
          reason: "The original separately received standing mandate requests this one exact event wait." };
        if (proposed === 2) {
          assert(input.inspection.eventWake, "A real canonical wake, not the informational request, must own continuation");
          return { kind: "query" as const, request: { intent: "pe_world_state", root: sourceFixture.root },
            reason: "Read the original company state after its exact canonical source event; no action is requested." };
        }
        throw Error("W1_STANDING_ORIGINAL_ONE_EVENT_DECISION_BOUND");
      },
    });
    const first = await runtime.runIteration({ tenantId: e.tenant, workId: standing.workId,
      objectiveLoopId: standing.objectiveLoopId, expectedRevision: 1, expectedStepNumber: 1,
      signal: AbortSignal.timeout(20000) });
    assert.equal(first, "waiting");
    const waiting = await snapshot(standing.workId);
    assert.equal(waiting.waits.length, 1); assert.equal(waiting.waits[0].status, "waiting");
    assert.equal(waiting.wakes.length, 0); assert.equal(waiting.effects.length, 0);
    assert.equal(waiting.inputs[0].instruction_text, originalMandate);
    const event = { tenantId: e.tenant, source: "W1_DISPOSABLE_CANONICAL_PRIMARY_OWNER",
      eventType: "primary.source.reviewed", resource: { type: "evidence_source", id: sourceFixture.sourceId },
      evidenceRefs: [{ sourceId: sourceFixture.sourceId, versionId: sourceFixture.versionId }],
      trustClass: "trusted_runtime" as const, occurredAt: new Date(),
      payload: { sourceId: sourceFixture.sourceId, originalVersionId: sourceFixture.versionId, businessEffectAuthority: false } };
    const unrelated = await ingestIntegrationEvent({ ...event, workId: sourceFixture.work.workId, sourceEventId: randomUUID() });
    assert.deepEqual(unrelated.matchedWaitIds, []);
    assert.equal((await snapshot(standing.workId)).wakes.length, 0);
    const sourceEventId = randomUUID(), matched = await ingestIntegrationEvent({ ...event, workId: standing.workId, sourceEventId });
    assert.deepEqual(matched.matchedWaitIds, [waiting.waits[0].id]);
    assert.equal(matched.wakeClaimIds.length, 1);
    const duplicate = await ingestIntegrationEvent({ ...event, workId: standing.workId, sourceEventId });
    assert.equal(duplicate.duplicate, true);
    const wake = await objectiveWakeContext(e.tenant, standing.objectiveLoopId), woken = await snapshot(standing.workId);
    assert.equal(woken.wakes.length, 1); assert.equal(woken.waits[0].matched_event_id, matched.eventId);
    assert(woken.jobs.some((job: any) => job.type === "run_objective_iteration" &&
      job.payload.wakeEventId === matched.eventId && job.payload.wakeWaitId === waiting.waits[0].id));
    assert.equal(String(woken.loops[0].deadline_at), String(originalDeadline));
    const second = await runtime.runIteration({ tenantId: e.tenant, workId: standing.workId,
      objectiveLoopId: standing.objectiveLoopId, expectedRevision: 1, expectedStepNumber: 2,
      signal: AbortSignal.timeout(20000) });
    const continued = await snapshot(standing.workId);
    assert.equal(proposed, 2);
    assert(continued.queries.some((query: any) => query.intent === "pe_world_state" && query.status === "succeeded"));
    assert.equal(continued.effects.length, 0); assert.equal(continued.loops[0].action_count, 0);
    assert.equal(continued.loops[0].query_count, 1);
    assert.equal(String(continued.loops[0].deadline_at), String(originalDeadline));
    assert.deepEqual((await snapshot(sourceFixture.work.workId)), informational.after);
    assert.deepEqual((await snapshot(noAct.workId)), doNotAct.after);
    report = { ...report, status: "PASS_LOCAL_STANDING_EVENT_LINEAGE",
      informational, doNotAct, originalMandate, originalDeadline, standing, first, waiting, unrelated,
      matched, duplicate, wake, woken, second, continued,
      originalContext, admittedWorker,
      producer: "EXPLICIT_DISPOSABLE_ONE_DECISION_PROPOSER_COMPILED_AND_ADMITTED_BY_ORIGINAL_P6",
      actualOwnerExecution: "ORIGINAL_OBJECTIVE_RUNTIME_AND_CANONICAL_EVENT_FABRIC",
      llmOrFieldBehaviorQualified: false, newBusinessEffectAuthority: false };
    await artifact("oracle-input.json", report);
    const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON!, [
      join(e.repo, "finnor-os/scripts/postz-w1/native-internal-oracle.py"), "standing",
      join(directory, "oracle-input.json"), join(directory, "independent-oracle.json"),
    ], { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    await artifact("oracle-process.json", { status: oracle.status, signal: oracle.signal, stdout: oracle.stdout, stderr: oracle.stderr });
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    report.independentOracle = join(directory, "independent-oracle.json");
    return { directory, report };
  } catch (error) { report.status = "FAIL"; report.failure = String(error); report.stack = (error as Error).stack; throw error; }
  finally {
    try {
      await closeInternalResources(report, [
        async () => { if (standing) report.ownedTermination = await controlWorkObjective({
          tenantId: e.tenant, workId: standing.workId, actorId: e.actor, command: "cancel",
        }); },
        () => http.close(),
      ]);
    } finally { await artifact("results.json", report); }
  }
}
