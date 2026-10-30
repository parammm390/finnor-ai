import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { NextRequest } from "next/server";
import { createNativeOwnerDatabase } from "../s7/native-owner-database.mjs";
import { captureMemoryProvider } from "./fixtures.mjs";

const backend = process.cwd(), root = resolve(backend, "..");
const output = resolve(root, "memory-evidence", "mounted-" + new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const config = parse(await readFile(process.env.FINNOR_MEMORY_UI_ENV ?? "/Users/paramdave/Desktop/FINNOR/.env.local"));
if (!config.TEST_OWNER_EMAIL || !config.TEST_OWNER_PASSWORD || !config.NEXT_PUBLIC_SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Existing test-owner auth configuration is required");
Object.assign(process.env, { LLM_PROVIDER_ANSWER: "memory-e2e-capture", LLM_PROVIDER_PLANNING: "memory-e2e-capture", SECRETS_PROVIDER: "env", RATE_LIMIT_PER_MINUTE: "10000", RATE_LIMIT_INTAKE_PER_MINUTE: "10000" });
delete process.env.REDIS_URL; delete process.env.ZEP_API_KEY;
const database = await createNativeOwnerDatabase();
delete process.env.AUTH_DEV_BYPASS;
Object.assign(process.env, { SUPABASE_URL: config.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY });
const { registerProvider } = await import("../../packages/tools/src/llm");
process.env.FINNOR_MEMORY_CAPTURE_FILE = join(output, "model-inputs.jsonl");
registerProvider("memory-e2e-capture", captureMemoryProvider);
createRequire(import.meta.url)("../../packages/tools/src/llm.ts").registerProvider("memory-e2e-capture", captureMemoryProvider);
const { admin, db } = database;
const tenantId = randomUUID(), employeeId = randomUUID();
await admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Disposable mounted conversation verification')", [tenantId]);
await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [employeeId, tenantId, config.TEST_OWNER_EMAIL]);
await admin.query("SELECT finnor_os.ensure_legacy_authority($1)", [tenantId]);
await db.configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: employeeId, sourceSystem: "memory-mounted" });
const thread = await db.createEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, title: "Atlas memory verification" });
for (let index = 1; index <= 30; index++) {
  const text = index === 1 ? "Atlas payment terms are 30 days." : index === 15 ? "Correction: Atlas payment terms are 45 days, replacing 30 days." : "Atlas analysis draft note " + index + ".";
  await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "user", channel: "text", originalText: text, idempotencyKey: randomUUID() });
  await db.appendEmployeeConversationMessage({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, role: "assistant", channel: "text", originalText: "This remains a user-supplied, unverified draft input.", idempotencyKey: randomUUID() });
}
const { compactEmployeeConversation } = await import("../../packages/orchestration/src/conversation-memory");
for (let index = 0; index < 3; index++) {
  const result = await compactEmployeeConversation({ tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: 52 }, { provider: captureMemoryProvider(), reviewer: captureMemoryProvider() });
  if (result.status !== "published") throw new Error("Mounted fixture compaction did not publish");
}
const routes: Array<{ parts: string[]; path: string }> = [];
async function discover(directory: string, parts: string[] = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await discover(join(directory, entry.name), [...parts, entry.name]);
    else if (entry.name === "route.ts") routes.push({ parts, path: join(directory, entry.name) });
  }
}
await discover(join(backend, "apps/api/app/api"));
routes.sort((a, b) => a.parts.filter(part => part.startsWith("[")).length - b.parts.filter(part => part.startsWith("[")).length);
const server = createServer(async (incoming, outgoing) => {
  const started = Date.now();
  const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
  try {
    const parts = url.pathname.replace(/^\/api\//, "").split("/");
    let selected: typeof routes[number] | undefined;
    let params: Record<string, string | string[]> = {};
    for (const route of routes) {
      if (route.parts.length !== parts.length) continue;
      const candidate: typeof params = {};
      if (route.parts.every((part, index) => {
        if (part.startsWith("[") && !part.startsWith("[...")) { candidate[part.slice(1, -1)] = decodeURIComponent(parts[index]!); return true; }
        return part === parts[index];
      })) { selected = route; params = candidate; break; }
    }
    if (!selected) { outgoing.writeHead(404); outgoing.end('{"error":"Route unavailable"}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) { chunks.push(Buffer.from(chunk)); if (chunks.reduce((sum, value) => sum + value.length, 0) > 2_000_000) throw new Error("Fixture request body exceeds limit"); }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new NextRequest("http://127.0.0.1" + incoming.url, { method: incoming.method, headers, ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: Buffer.concat(chunks) }) });
    const module = await import(pathToFileURL(selected.path).href);
    const handler = module[incoming.method ?? "GET"];
    const response: Response = handler ? await handler(request, { params: Promise.resolve(params) }) : Response.json({ error: "Method unavailable" }, { status: 405 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
    await appendFile(join(output, "http.jsonl"), JSON.stringify({ method: incoming.method, path: url.pathname, status: response.status, durationMs: Date.now() - started }) + "\n");
  } catch (error) {
    outgoing.writeHead(500); outgoing.end('{"error":"Mounted fixture boundary failed"}');
    await appendFile(join(output, "http-errors.jsonl"), JSON.stringify({ path: url.pathname, error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture HTTP port unavailable");
const frontendPort = 3517;
const frontend = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--turbopack", "-p", String(frontendPort), "--hostname", "127.0.0.1"], {
  cwd: root, env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: config.NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY: config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    FINNOR_OS_API_URL: "http://127.0.0.1:" + address.port, NEXT_PUBLIC_OS_API_URL: "http://127.0.0.1:" + address.port, NEXT_PUBLIC_CENTROPY_TEST_MODE: "0", CENTROPY_TEST_MODE: "0", NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"],
});
frontend.stdout.on("data", chunk => { void appendFile(join(output, "frontend.log"), chunk); });
frontend.stderr.on("data", chunk => { void appendFile(join(output, "frontend.log"), chunk); });
const state = { schema: "finnor.memory-mounted.v1", frontend: "http://127.0.0.1:" + frontendPort, threadUrl: "http://127.0.0.1:" + frontendPort + "/centropy/investigations/" + thread.id,
  threadId: thread.id, tenantId, employeeId, sourceMessages: 60, checkpoints: 3, output, auth: "Real configured Supabase test-owner sign-in and JWT verification; disposable canonical identity mapping; no auth bypass", backend: "Actual production route handlers through a loopback HTTP adapter, not a packaged Next API deployment", pids: { harness: process.pid, frontend: frontend.pid } };
await writeFile(join(output, "state.json"), JSON.stringify(state, null, 2));
process.stdout.write(JSON.stringify(state) + "\n");
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  frontend.kill("SIGTERM"); server.close(); await database.stop(); process.exit(0);
}
process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
setTimeout(() => { void stop(); }, 600_000);
