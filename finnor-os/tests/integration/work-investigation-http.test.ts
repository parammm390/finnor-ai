import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendEmployeeConversationMessage, closePool, configureTenantVertical,
  createEmployeeConversationThread, receiveWork, updateEmployeeConversationThreadContext,
} from "@finnor/db";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { createFund } from "@finnor/private-equity";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { browserHttpFixture } from "../../scripts/v2/browser-http-fixture.mjs";

// Contract: opening existing Work creates/reuses only the caller's real private
// Investigation, with its exact Work and Objective, without executing anything.
// The existing browser sweep enters a known Investigation directly, so cannot
// detect missing adoption, recent-list truncation, races or history disclosure.
// Authentication is the shared disposable fixture; every owner response is real.
const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (adminUrl) assertDisposableDatabaseTarget(adminUrl, "existing Work Investigation HTTP E2E");

describe.skipIf(!adminUrl)("opening existing Work as a private Investigation", () => {
  const tenantId = randomUUID(), foreignTenantId = randomUUID();
  const actorId = randomUUID(), otherActorId = randomUUID(), foreignActorId = randomUUID();
  const runId = randomUUID();
  const directory = process.env.FINNOR_WORK_INVESTIGATION_EVIDENCE_DIR ?? join(tmpdir(), "finnor-work-investigation", runId);
  const prior = { DATABASE_URL: process.env.DATABASE_URL, SECRETS_PROVIDER: process.env.SECRETS_PROVIDER };
  const observations: Array<Record<string, unknown>> = [];
  let source: Record<string, unknown>;
  let admin: pg.Client, http: Awaited<ReturnType<typeof browserHttpFixture>>;
  let unlinked: { workId: string; objectiveLoopId: string }, oldWorkId: string, oldThreadId: string;
  let sharedWorkId: string, otherThreadId: string, foreignWorkId: string;
  let laterRoot: { entityType: "pe_fund"; entityId: string };
  let scopedWorkId: string, acceptedRoot: { entityType: "pe_fund"; entityId: string };
  let actorToken: string, otherToken: string;

  async function record(step: string, value: unknown) {
    observations.push({ step, at: new Date().toISOString(), value });
    await writeFile(join(directory, `work-investigation-${runId}.json`), JSON.stringify({
      schema: "finnor.work-investigation-http-e2e.v1", runId, source,
      qualification: "Signed local HTTP authentication, real conversation and Work owners, ordinary finnor_app role, migrated disposable database. No browser or production execution claim.",
      rerun: "From finnor-os, set DATABASE_URL to a migrated disposable admin database and FINNOR_WORK_INVESTIGATION_EVIDENCE_DIR to a private directory; run npx vitest run tests/integration/work-investigation-http.test.ts.",
      inputs: { tenantId, actorId, otherActorId, unlinked, oldWorkId, oldThreadId, sharedWorkId, otherThreadId, foreignWorkId, scopedWorkId, acceptedRoot, laterRoot }, observations,
    }, null, 2) + "\n");
  }

  async function open(workId: string, identity: "actor" | "other" | "anonymous" = "actor") {
    const response = await http.request("threads", { workId }, identity);
    await record("open-existing-work", { workId, identity, response });
    return response;
  }

  async function readThread(id: string, identity: "actor" | "other" = "actor") {
    const response = await fetch(`${http.origin}/api/threads/${id}`, { headers: { authorization: `Bearer ${identity === "actor" ? actorToken : otherToken}` } });
    const result = { status: response.status, body: await response.json() };
    await record("read-private-thread", { id, identity, result });
    return result;
  }

  async function counts() {
    return (await admin.query("SELECT (SELECT count(*)::int FROM finnor_os.works WHERE tenant_id=$1) AS works, (SELECT count(*)::int FROM finnor_os.work_objective_loops WHERE tenant_id=$1) AS loops, (SELECT count(*)::int FROM finnor_os.domain_actions WHERE tenant_id=$1) AS actions, (SELECT count(*)::int FROM finnor_os.business_effects WHERE tenant_id=$1) AS effects", [tenantId])).rows[0];
  }

  beforeAll(async () => {
    await mkdir(directory, { recursive: true });
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
    const testSource = await readFile(new URL(import.meta.url), "utf8");
    source = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), patchSha256: createHash("sha256").update(patch).digest("hex"), testSourceSha256: createHash("sha256").update(testSource).digest("hex"), testSource: `test-${runId}.ts`, node: process.version, migrationHead: CURRENT_MIGRATION_HEAD };
    await writeFile(join(directory, `source-${runId}.patch`), patch);
    await writeFile(join(directory, `test-${runId}.ts`), testSource);
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Existing Work inspection'),($3,$4,'Foreign private Work')", [tenantId, randomUUID(), foreignTenantId, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$4,$6,'owner','active','Inspection operator'),($2,$4,$7,'owner','active','Other operator'),($3,$5,$8,'owner','active','Foreign operator')", [actorId, otherActorId, foreignActorId, tenantId, foreignTenantId, `${actorId}@inspection.test.invalid`, `${otherActorId}@inspection.test.invalid`, `${foreignActorId}@inspection.test.invalid`]);
    const applicationUrl = new URL(adminUrl!); applicationUrl.username = "finnor_app"; applicationUrl.password = "finnor_app";
    await closePool(); process.env.DATABASE_URL = applicationUrl.toString(); process.env.SECRETS_PROVIDER = "env";
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorId, sourceSystem: "integration:work-investigation" });
    await configureTenantVertical({ tenantId: foreignTenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: foreignActorId, sourceSystem: "integration:work-investigation" });
    const ctx = { tenantId, userId: actorId, employeeId: actorId, role: "owner" as const };
    laterRoot = { entityType: "pe_fund", entityId: String((await createFund({ auth: ctx }, { name: "Later unrelated Fund", baseCurrency: "USD" })).row.id) };
    acceptedRoot = { entityType: "pe_fund", entityId: String((await createFund({ auth: ctx }, { name: "Original accepted Fund", baseCurrency: "USD" })).row.id) };
    scopedWorkId = (await receiveWork({ tenantId, userId: actorId, instruction: "Inspect the accepted original Fund", channel: "text", idempotencyKey: randomUUID(), activeContext: { businessRoot: acceptedRoot } })).workId;
    unlinked = await new FinnorOrchestrator().startObjective("Coordinate the existing Work inspection and wait for its recorded recovery decision.", ctx, { channel: "text", idempotencyKey: randomUUID() });
    oldWorkId = (await receiveWork({ tenantId, userId: actorId, instruction: "Older linked diligence Work", channel: "text", idempotencyKey: randomUUID() })).workId;
    oldThreadId = (await createEmployeeConversationThread({ tenantId, ownerEmployeeId: actorId, title: "Older exact Investigation" })).id;
    await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: actorId, threadId: oldThreadId, activeWorkId: oldWorkId });
    await admin.query("UPDATE finnor_os.employee_conversation_threads SET last_activity_at=now()-interval '1 day' WHERE id=$1", [oldThreadId]);
    for (let index = 0; index < 35; index++) await createEmployeeConversationThread({ tenantId, ownerEmployeeId: actorId, title: `Newer Investigation ${index}` });
    sharedWorkId = (await receiveWork({ tenantId, userId: otherActorId, instruction: "Shared tenant Work without shared private history", channel: "text", idempotencyKey: randomUUID() })).workId;
    otherThreadId = (await createEmployeeConversationThread({ tenantId, ownerEmployeeId: otherActorId, title: "Other employee private Investigation" })).id;
    await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: otherActorId, threadId: otherThreadId, activeWorkId: sharedWorkId });
    await appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: otherActorId, threadId: otherThreadId, role: "user", channel: "text", originalText: "PRIVATE_OTHER_EMPLOYEE_MESSAGE", idempotencyKey: randomUUID() });
    foreignWorkId = (await receiveWork({ tenantId: foreignTenantId, userId: foreignActorId, instruction: "FOREIGN_TENANT_PRIVATE_WORK", channel: "text", idempotencyKey: randomUUID() })).workId;
    http = await browserHttpFixture(admin, tenantId, actorId, otherActorId);
    async function token(id: string) {
      const response = await fetch(`${http.authOrigin}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${id}@inspection.test.invalid`, password: "local-disposable-no-authority" }) });
      expect(response.status).toBe(200); return (await response.json()).access_token as string;
    }
    actorToken = await token(actorId); otherToken = await token(otherActorId);
    await record("setup", { counts: await counts(), applicationRole: (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows[0] });
  }, 120_000);

  afterAll(async () => {
    if (admin) await record("final-owner-state", { counts: await counts(), requests: http?.observed.apiRequests });
    await http?.close(); await closePool(); await admin?.end();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`WORK_INVESTIGATION_EVIDENCE ${join(directory, `work-investigation-${runId}.json`)}`);
  });

  it("atomically binds a real inspection thread to the original Work and Objective across concurrent opens", async () => {
    const before = await counts();
    const opened = await Promise.all(Array.from({ length: 6 }, () => open(unlinked.workId)));
    for (const response of opened) expect(response.status, JSON.stringify(response.body)).toBe(201);
    const first = opened[0];
    if (!first) throw new Error("Concurrent opens returned no response");
    const id = first.body.thread.id;
    expect(new Set(opened.map(response => response.body.thread.id)).size).toBe(1);
    expect(first.body.thread).toMatchObject({ activeWorkId: unlinked.workId, activeObjectiveLoopId: unlinked.objectiveLoopId });
    expect(await counts()).toEqual(before);
    const persisted = await readThread(id);
    expect(persisted.status).toBe(200);
    expect(persisted.body.thread).toMatchObject({ activeWorkId: unlinked.workId, activeObjectiveLoopId: unlinked.objectiveLoopId });
    expect(persisted.body.messages).toEqual([]);
    expect((await admin.query("SELECT count(*)::int AS n FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1 AND owner_employee_id=$2 AND active_work_id=$3", [tenantId, actorId, unlinked.workId])).rows[0].n).toBe(1);
    expect((await open(unlinked.workId)).body.thread.id).toBe(id);
    await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: actorId, threadId: id, activeWorkId: oldWorkId, activeObjectiveLoopId: null, activeReferences: [laterRoot], unresolvedReferences: [{ expression: "that later fund" }] });
    const restored = await open(unlinked.workId);
    expect(restored.body.thread).toMatchObject({ id, activeWorkId: unlinked.workId, activeObjectiveLoopId: unlinked.objectiveLoopId });
    const restoredContext = await readThread(id);
    expect(restoredContext.body.thread.activeReferences).toEqual([]);
    expect(restoredContext.body.thread.unresolvedReferences).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it("reuses the actual owned Investigation beyond the recent thirty", async () => {
    const response = await open(oldWorkId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.thread.id).toBe(oldThreadId);
    expect(response.body.thread.activeWorkId).toBe(oldWorkId);
  });

  it("initializes accepted Fund scope, preserves an unchanged inspection and restores a moved inspection", async () => {
    // API/voice followups use persisted scope without the browser's reconstruction.
    // A correct rebind alone cannot detect missing scope on the first insert.
    const first = await open(scopedWorkId);
    expect(first.status).toBe(201);
    expect((await readThread(first.body.thread.id)).body.thread.activeReferences).toEqual([acceptedRoot]);
    await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: actorId, threadId: first.body.thread.id, activeReferences: [laterRoot] });
    expect((await open(scopedWorkId)).body.thread.id).toBe(first.body.thread.id);
    expect((await readThread(first.body.thread.id)).body.thread.activeReferences).toEqual([laterRoot]);
    await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: actorId, threadId: first.body.thread.id, activeWorkId: oldWorkId, activeReferences: [laterRoot] });
    const restored = await open(scopedWorkId);
    expect(restored.status).toBe(201);
    expect(restored.body.thread.id).toBe(first.body.thread.id);
    expect((await readThread(first.body.thread.id)).body.thread.activeReferences).toEqual([acceptedRoot]);
  });

  it("creates a private inspection of shared Work without exposing another employee's conversation", async () => {
    const response = await open(sharedWorkId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.thread.id).not.toBe(otherThreadId);
    expect(response.body.thread.activeWorkId).toBe(sharedWorkId);
    const loaded = await readThread(response.body.thread.id);
    expect(loaded.body.messages).toEqual([]);
    expect(JSON.stringify(loaded.body)).not.toContain("PRIVATE_OTHER_EMPLOYEE_MESSAGE");
    expect((await readThread(otherThreadId)).status).toBe(404);
    expect((await readThread(response.body.thread.id, "other")).status).toBe(404);
    expect((await open(sharedWorkId, "other")).body.thread.id).toBe(otherThreadId);
  });

  it("refuses missing, foreign and unauthenticated Work without creating a thread", async () => {
    const before = (await admin.query("SELECT count(*)::int AS n FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1", [tenantId])).rows[0].n;
    for (const workId of [randomUUID(), foreignWorkId]) {
      const response = await open(workId);
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("FOREIGN_TENANT_PRIVATE_WORK");
    }
    expect((await open(unlinked.workId, "anonymous")).status).toBe(401);
    expect((await admin.query("SELECT count(*)::int AS n FROM finnor_os.employee_conversation_threads WHERE tenant_id=$1", [tenantId])).rows[0].n).toBe(before);
  });
});
