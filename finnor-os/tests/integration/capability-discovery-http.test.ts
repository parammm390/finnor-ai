import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import { FinnorOrchestrator, prepareEmployeeConversationTurn, registerProvider } from "@finnor/orchestration";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { browserHttpFixture } from "../../scripts/v2/browser-http-fixture.mjs";
import { startHeartbeat } from "../../apps/worker/src/heartbeat";
import { readWorkerFleetReadiness } from "../../apps/api/lib/worker-readiness";

// This real intake regression owns routing, persisted thread continuity and the
// read-only result. Phrase tests and context-loader tests cannot observe them.
const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (adminUrl) assertDisposableDatabaseTarget(adminUrl, "capability discovery HTTP E2E");

describe.skipIf(!adminUrl)("authenticated capability discovery", () => {
  const tenantId = randomUUID(), actorId = randomUUID(), otherActorId = randomUUID();
  const runId = randomUUID();
  const directory = process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? join(tmpdir(), "finnor-capability-discovery", runId);
  const prior = Object.fromEntries(["DATABASE_URL", "SECRETS_PROVIDER", "ZEP_API_KEY", "LLM_PROVIDER_ANSWER_TEXT", "RATE_LIMIT_INTAKE_PER_MINUTE"].map(key => [key, process.env[key]]));
  const observations: Array<Record<string, unknown>> = [];
  let admin: pg.Client, http: Awaited<ReturnType<typeof browserHttpFixture>>;
  let heartbeat: ReturnType<typeof startHeartbeat>;
  const stop = new AbortController();
  let source: Record<string, unknown>;
  const modelInputs: unknown[] = [];

  async function record(step: string, value: unknown) {
    observations.push({ step, at: new Date().toISOString(), value });
    await writeFile(join(directory, `capability-${runId}.json`), JSON.stringify({
      schema: "finnor.capability-discovery-http-e2e.v1", runId, source,
      qualification: "Actual authenticated HTTP routes, canonical conversation persistence and ordinary SQL role in a disposable database. Deterministic model transport; no browser, live-provider or business-outcome claim.",
      rerun: "From finnor-os, set DATABASE_URL to a migrated disposable admin database and FINNOR_CAPABILITY_EVIDENCE_DIR to a private directory; run npx vitest run tests/integration/capability-discovery-http.test.ts.",
      inputs: { tenantId, actorId, otherActorId }, observations,
    }, null, 2) + "\n");
  }

  async function submit(instruction: string, threadId?: string, identity: "actor" | "other" = "actor") {
    const input = { instruction, channel: "text", idempotencyKey: randomUUID(), ...(threadId ? { threadId } : {}) };
    const response = await http.request("actions", input, identity);
    const workId = response.body.workId;
    const state = workId ? {
      work: (await admin.query("SELECT status,final_outcome FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, workId])).rows[0],
      loops: (await admin.query("SELECT id,state FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId])).rows,
      queries: (await admin.query("SELECT intent,status FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId])).rows,
      actions: (await admin.query("SELECT id,action_type FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId])).rows,
    } : null;
    await record("signed-instruction", { input, identity, response, state });
    return { ...response, state };
  }

  function expectDiscovery(result: Awaited<ReturnType<typeof submit>>) {
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.answer).toMatchObject({ kind: "answer", readOnly: true });
    expect(result.body.objective).toBeUndefined();
    expect(result.body.planned).toEqual([]);
    expect(result.state).toMatchObject({ work: { status: "completed" }, loops: [], queries: [], actions: [] });
  }

  beforeAll(async () => {
    await mkdir(directory, { recursive: true });
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
    source = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), patchSha256: createHash("sha256").update(patch).digest("hex"), node: process.version, migrationHead: CURRENT_MIGRATION_HEAD };
    await writeFile(join(directory, `source-${runId}.patch`), patch);
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Capability discovery')", [tenantId, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$3,$4,'owner','active','Discovery operator'),($2,$3,$5,'owner','active','Other operator')", [actorId, otherActorId, tenantId, `${actorId}@discovery.test.invalid`, `${otherActorId}@discovery.test.invalid`]);
    const applicationUrl = new URL(adminUrl!); applicationUrl.username = "finnor_app"; applicationUrl.password = "finnor_app";
    await closePool(); process.env.DATABASE_URL = applicationUrl.toString(); process.env.SECRETS_PROVIDER = "env";
    delete process.env.ZEP_API_KEY;
    process.env.RATE_LIMIT_INTAKE_PER_MINUTE = "1000";
    process.env.LLM_PROVIDER_ANSWER_TEXT = `discovery-${runId}`;
    registerProvider(`discovery-${runId}`, () => ({ name: `discovery-${runId}`, async complete(options) {
      modelInputs.push(JSON.parse(options.user));
      return "I can describe registered instruction capabilities. Execution requires current authority and configuration.";
    } }));
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorId, sourceSystem: "integration:capability-discovery" });
    http = await browserHttpFixture(admin, tenantId, actorId, otherActorId);
    heartbeat = startHeartbeat(1_000, stop.signal);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const fleet = await readWorkerFleetReadiness();
      if ((fleet.legacyCompatibleWorkers ?? 0) > 0 || fleet.computeReady) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ready, "Ordinary objective readiness must be reached so a wrong route cannot hide behind a 503").toBe(true);
    await record("setup", { applicationRole: (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows[0] });
  }, 120_000);

  afterAll(async () => {
    await record("model-transport-inputs", modelInputs);
    stop.abort(); await heartbeat?.markDraining(); await http?.close(); await closePool(); await admin?.end();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`CAPABILITY_DISCOVERY_EVIDENCE ${join(directory, `capability-${runId}.json`)}`);
  });

  it("answers the observed repeated capability followup without starting business work", async () => {
    const first = await submit("tell me what all can you do?");
    expectDiscovery(first);
    for (const instruction of [
      "nahh tell me like alllll the things!!!!!!!!! precise thing!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "Be more specific, list all of them.",
      "More detail please.",
      "Show me all of them.",
    ]) expectDiscovery(await submit(instruction, first.body.threadId));
  });

  it("exposes exact registered reads and human decisions without claiming runtime access", async () => {
    for (const instruction of ["What all do you handle?", "Hey what are your capabilities!", "Hey list all your capabilities!", "Show me all your capabilities", "Show me everything you can do"]) {
      const result = await submit(instruction);
      expectDiscovery(result);
      const facts = JSON.stringify(result.body.answer.display.facts);
      expect(facts).toContain("query:pe_world_state");
      expect(facts).toContain("query:harness_program_v1");
      expect(facts).toContain("wait:event");
      expect(facts).toContain("check:objective_success");
      expect(facts).toContain("record_ic_vote");
      expect(facts).toContain("human_attestation");
      expect(result.body.answer.spokenSummary).toMatch(/registered/i);
      expect(result.body.answer.spokenSummary).toMatch(/authority/i);
    }
  });

  it("keeps a business command after a capability question on the objective boundary", async () => {
    for (const instruction of [
      "What can you do? Then coordinate diligence and wait for the investment committee's approval.",
      "What can you do? Run underwriting for Atlas.",
      "What can you do? Start a diligence workstream for Atlas.",
      "Show me all your capabilities, then launch underwriting for Atlas.",
    ]) {
      const result = await submit(instruction);
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      expect(result.body.answer).toBeUndefined();
      expect(result.body.objective?.objectiveLoopId).toBeTruthy();
      expect(result.state?.loops).toHaveLength(1);
      expect(result.state?.actions).toEqual([]);
    }
  });

  it.each([
    "What can you do? Also run underwriting for Atlas.",
    "Show workflow activity, run underwriting for Atlas.",
    "Show workflow activity for the last run, start underwriting for Atlas.",
  ])("preserves the business command in a separate clause: %s", async instruction => {
    const result = await submit(instruction);
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.answer).toBeUndefined();
    expect(result.body.objective?.objectiveLoopId).toBeTruthy();
    expect(result.state).toMatchObject({ queries: [], actions: [], loops: [expect.objectContaining({ state: "continue" })] });
  });

  it.each([
    "Could you run underwriting for Atlas",
    "Can you create an underwriting run for Atlas",
  ])("accepts a modal business request without punctuation as durable Work: %s", async instruction => {
    const result = await submit(instruction);
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.answer).toBeUndefined();
    expect(result.body.objective?.objectiveLoopId).toBeTruthy();
    expect(result.state).toMatchObject({ queries: [], actions: [], loops: [expect.objectContaining({ state: "continue" })] });
  });

  it("keeps noun uses of run, start and launch on their actual read boundaries", async () => {
    // A mutation-word guard can silently turn an ordinary read into durable work.
    // Phrase-only coverage cannot observe the real query receipt or absent loop.
    for (const instruction of ["Show workflow activity for the last run", "Can you show workflow activity for the last run", "Show workflow activity since the start", "Show workflow activity after the launch", "Show workflow activity for run, start and launch events"]) {
      const result = await submit(instruction);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect(result.body.answer).toMatchObject({ readOnly: true, intent: "agent_activity" });
      expect(result.body.objective).toBeUndefined();
      expect(result.state).toMatchObject({ loops: [], actions: [], queries: [expect.objectContaining({ intent: "agent_activity", status: "succeeded" })] });
    }
    for (const instruction of ["How long does an underwriting run take?", "What is the difference between run, start and launch?"]) {
      const informational = await submit(instruction);
      expect(informational.status, JSON.stringify(informational.body)).toBe(201);
      expect(informational.body.answer).toMatchObject({ readOnly: true, intent: "conversation" });
      expect(informational.state).toMatchObject({ loops: [], actions: [], queries: [] });
    }
  });

  it("does not inherit a different employee's capability thread", async () => {
    const first = await submit("What can you do?"); expectDiscovery(first);
    const refused = await submit("More detail please.", first.body.threadId, "other");
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(refused.body.answer).toBeUndefined();
    expect(refused.body.threadId).toBeUndefined();
  });

  it("stops capability continuation at a changed business topic", async () => {
    const first = await submit("What can you do?"); expectDiscovery(first);
    const changed = await submit("Ensure the selected fund's diligence is coordinated and wait for approval.", first.body.threadId);
    expect(changed.status, JSON.stringify(changed.body)).toBe(202);
    const followup = await submit("More detail please.", first.body.threadId);
    expect(followup.body.answer?.evidence?.some((item: { source: string }) => item.source === "planning_capability_manifest")).not.toBe(true);
    expect(followup.body.objective?.objectiveLoopId).toBeTruthy();
  });

  it("uses exact thread context through the production orchestrator embedding too", async () => {
    // HTTP supplies a route decision. A worker or SDK embedding does not, so it
    // independently risks losing context before the same conversational owner.
    const first = await submit("What can you do?"); expectDiscovery(first);
    const ctx = { tenantId, userId: actorId, employeeId: actorId, role: "owner" as const };
    const instruction = "More detail please.", instructionId = randomUUID();
    const prepared = await prepareEmployeeConversationTurn({ ctx, threadId: first.body.threadId, instruction, instructionId, idempotencyKey: randomUUID(), channel: "text" });
    const result = await new FinnorOrchestrator().handleInstructionResult(instruction, ctx, { instructionId, channel: "text", conversationContext: prepared.context });
    await record("orchestrator-embedding", result);
    expect(result.answer).toMatchObject({ readOnly: true, evidence: [expect.objectContaining({ source: "planning_capability_manifest" })] });
    expect(result.objective).toBeUndefined();
    expect(result.actions).toEqual([]);
  });
});
