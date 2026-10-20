/** Actual mounted product with disposable signed auth and canonical owners.
 * stdin `fail` drives the accepted Objective's real inspection failure; `stop`
 * closes only this fixture's servers. No browser or production credentials. */
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import pg from "pg";
import { closePool, configureTenantVertical, createEmployeeConversationThread, updateEmployeeConversationThreadContext, receiveWork } from "@finnor/db";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { browserHttpFixture } from "../v2/browser-http-fixture.mjs";
import { startHeartbeat } from "../../apps/worker/src/heartbeat";
import { readWorkerFleetReadiness } from "../../apps/api/lib/worker-readiness";

const adminUrl = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
assertDisposableDatabaseTarget(adminUrl, "mounted core product proof");
const directory = process.env.FINNOR_MOUNTED_EVIDENCE_DIR;
if (!directory || !directory.startsWith("/")) throw Error("PRIVATE_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(directory, { recursive: true });
const repo = resolve(import.meta.dirname, "../../..");
const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: repo, encoding: "utf8" });
const source = { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), patchSha256: createHash("sha256").update(patch).digest("hex"), node: process.version, migrationHead: CURRENT_MIGRATION_HEAD };
await writeFile(join(directory, "source.patch"), patch);
const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
const tenantId = randomUUID(), actorId = randomUUID(), peerId = randomUUID(), roleId = randomUUID();
await admin.query("SET app.test_vertical_mode='explicit'");
await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Mounted PE core proof')", [tenantId, randomUUID()]);
await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$3,$4,'owner','active','Core proof operator'),($2,$3,$5,'owner','active','Private peer')", [actorId, peerId, tenantId, `${actorId}@mounted.test.invalid`, `${peerId}@mounted.test.invalid`]);
await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Disposable core proof authority')", [roleId, tenantId, `mounted-${randomUUID()}`]);
await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{\"kind\":\"tenant\"}'::jsonb)", [tenantId, actorId, roleId]);
await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)", [tenantId, roleId]);
const appUrl = new URL(adminUrl!); appUrl.username = "finnor_app"; appUrl.password = "finnor_app";
await closePool(); process.env.DATABASE_URL = appUrl.toString(); process.env.SECRETS_PROVIDER = "env";
delete process.env.ZEP_API_KEY;
await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorId, sourceSystem: "verification:mounted-core" });
const http = await browserHttpFixture(admin, tenantId, actorId, peerId);
const abort = new AbortController(), heartbeat = startHeartbeat(1_000, abort.signal);
let ready = false;
for (let attempt = 0; attempt < 80; attempt++) {
  const fleet = await readWorkerFleetReadiness();
  if ((fleet.legacyCompatibleWorkers ?? 0) > 0 || fleet.computeReady) { ready = true; break; }
  await new Promise(resolve => setTimeout(resolve, 25));
}
if (!ready) throw Error("ORDINARY_WORKER_READINESS_REQUIRED");
const objective = await http.request("objectives", {
  objective: "Ensure the exact selected investment record is inspected. Do not invent a Deal when the subject is absent.",
  channel: "text", idempotencyKey: randomUUID(),
  budgets: { maxSteps: 4, maxActions: 1, maxQueries: 4, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 900_000).toISOString() },
});
if (objective.status !== 202) throw Error(JSON.stringify(objective));
const { workId, objectiveLoopId } = objective.body.objective;
const thread = await createEmployeeConversationThread({ tenantId, ownerEmployeeId: actorId, title: "Mounted Objective state proof" });
await updateEmployeeConversationThreadContext({ tenantId, ownerEmployeeId: actorId, threadId: thread.id, activeWorkId: workId, activeObjectiveLoopId: objectiveLoopId });
const orphan = await receiveWork({ tenantId, userId: actorId, instruction: "Recover the mounted existing Work without creating another Work", channel: "text", instructionId: randomUUID(), idempotencyKey: randomUUID() });
const portServer = createServer();
await new Promise<void>((yes, no) => { portServer.once("error", no); portServer.listen(0, "127.0.0.1", yes); });
const address = portServer.address(); if (!address || typeof address === "string") throw Error("OWNED_LOOPBACK_PORT_REQUIRED");
const port = address.port; await new Promise<void>(yes => portServer.close(() => yes()));
const frontLog = await open(join(directory, "frontend.log"), "w");
const front = spawn(process.execPath, [join(repo, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: repo, stdio: ["ignore", frontLog.fd, frontLog.fd],
  env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SUPABASE_URL: http.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: "disposable-publishable-not-live", FINNOR_OS_API_URL: http.origin },
});
const observations: unknown[] = [];
const descriptor = { source, frontendOrigin: `http://127.0.0.1:${port}`, tenantId, actorId, peerId, loginEmail: http.loginEmail, loginPassword: "local-disposable-no-authority", threadId: thread.id, workId, objectiveLoopId, orphanWorkId: orphan.workId,
  qualification: "Disposable synthetic sign-in; actual frontend, HTTP routes, ordinary SQL role and canonical Objective runtime. No live integration or economic qualification.",
  rerun: "From finnor-os, set DATABASE_URL to a migrated disposable admin database and FINNOR_MOUNTED_EVIDENCE_DIR to a private absolute path; run node --import=tsx scripts/verification/mounted-core-product.mts. Sign in at frontendOrigin using these fixture-only credentials. Open the exact thread, issue fail on this process stdin, and observe Objective status without reloading. Use stop to close owned servers.",
};
await writeFile(join(directory, "mounted-inputs.json"), JSON.stringify(descriptor, null, 2) + "\n");
console.log(JSON.stringify({ status: "READY", ...descriptor }));
const runtime = new FinnorOrchestrator(), input = createInterface({ input: process.stdin });
let stopped = false;
async function record() {
  const state = { work: (await admin.query("SELECT status,failure FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, workId])).rows[0], loop: (await admin.query("SELECT state,reason FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2", [tenantId, objectiveLoopId])).rows[0] };
  observations.push({ at: new Date().toISOString(), state, requests: [...http.observed.apiRequests] });
  await writeFile(join(directory!, "owner-observations.json"), JSON.stringify({ source, descriptor, observations }, null, 2) + "\n");
  return state;
}
async function stop() {
  if (stopped) return; stopped = true; input.close(); abort.abort(); front.kill("SIGTERM");
  await record(); await heartbeat.markDraining(); await http.close(); await closePool(); await admin.end(); await frontLog.close();
}
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
for await (const line of input) {
  try {
    if (line.trim() === "fail") {
      const outcome = await runtime.runObjectiveIteration({ tenantId, workId, objectiveLoopId });
      console.log(JSON.stringify({ command: "fail", outcome, state: await record() }));
    } else if (line.trim() === "inspect") console.log(JSON.stringify({ command: "inspect", state: await record() }));
    else if (line.trim() === "stop") { await stop(); break; }
  } catch (error) { console.log(JSON.stringify({ command: line.trim(), error: error instanceof Error ? error.message : "UNKNOWN", state: await record() })); }
}
await stop();
