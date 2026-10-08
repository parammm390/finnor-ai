#!/usr/bin/env -S node --import tsx
// Failure-first startup prerequisite: actual installed Next 15 + loopback HTTP.
// No mocks, DB, auth bypass, credential inheritance, or provider calls.
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const backend = join(root, "finnor-os");
const contract = join(root, "scope-pm/phase-06-m4-counterexample-search/api-startup-contract.md");
const label = process.argv[2] === "--label" ? process.argv[3] : "replay";
assert.ok(label && /^[a-z0-9-]+$/.test(label), "Use --label <lowercase-run-label>");
assert.ok(process.argv.length <= (process.argv[2] === "--label" ? 4 : 2), "Unexpected arguments");
const host = "127.0.0.1";
const port = 3160;
const base = `http://${host}:${port}`;
const environment = "api-startup-e2e";
const cli = join(backend, "node_modules/next/dist/bin/next");
const argv = [cli, "dev", "apps/api", "--hostname", host, "--port", String(port)];
const sourcePaths = [
  "finnor-os/scripts/m4/api-startup-e2e.mts",
  "finnor-os/apps/api/next.config.mjs",
  "finnor-os/apps/api/middleware.ts",
  "finnor-os/apps/api/lib/auth.ts",
  "finnor-os/apps/api/app/api/health/route.ts",
  "finnor-os/apps/api/app/api/policies/[operation]/route.ts",
  "finnor-os/apps/api/app/api/policies/[tenantId]/[actionType]/route.ts",
  "finnor-os/apps/api/app/api/policies/[tenantId]/[actionType]/simulate/route.ts",
  "finnor-os/apps/api/app/api/policies/[operation]/[actionType]/route.ts",
  "finnor-os/apps/api/app/api/policies/[operation]/[actionType]/simulate/route.ts",
];
const generatedPaths = ["finnor-os/apps/api/.next", "finnor-os/apps/api/tsconfig.tsbuildinfo"];
const evidence = {
  schema: "finnor.api-startup-e2e.v1",
  label,
  startedAt: new Date().toISOString(),
  endedAt: null as string | null,
  scope: "API startup prerequisite only; not an M4 or P4/S4 global gate",
  replay: { cwd: backend, command: `node --import tsx scripts/m4/api-startup-e2e.mts --label ${label}` },
  launch: { cwd: backend, executable: process.execPath, argv },
  versions: { node: process.version, backendNext: "", rootNext: "" },
  source: {
    head: "",
    tree: "",
    sha256: sourcePaths.map((path) => ({
      path,
      sha256: existsSync(join(root, path))
        ? createHash("sha256").update(readFileSync(join(root, path))).digest("hex")
        : null,
    })),
  },
  environment: {} as NodeJS.ProcessEnv,
  preconditions: [] as string[],
  checks: [] as {
    method: string; url: string; authorization: string | null; input: string | null;
    status: number; contentType: string | null; observed: unknown;
  }[],
  serverOutput: [] as { stream: "stdout" | "stderr"; text: string }[],
  child: null as { pid: number; exitCode: number | null; signal: NodeJS.Signals | null } | null,
  cleanup: { ownedPid: null as number | null, signals: [] as string[], processGroupGone: false, childClosed: false },
  generatedPaths: generatedPaths.map((path) => ({
    path, existedBefore: existsSync(join(root, path)), existsAfter: false,
  })),
  passed: false,
  failure: null as string | null,
};

let child: ChildProcess | undefined;
let closed: Promise<void> | undefined;
let childClosed = false;
let childError: Error | undefined;
let output = "";
let interrupted: string | undefined;
const abort = new AbortController();
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function ensureRunning() {
  if (interrupted) throw new Error(`E2E interrupted by ${interrupted}`);
  if (childError) throw childError;
  // Next's CLI can exit zero even when its server failed route discovery.
  if (/You cannot use different slug names for the same dynamic path/.test(output)) {
    throw new Error("Next route discovery failed: different slug names at /api/policies (operation !== tenantId)");
  }
  if (childClosed) throw new Error(`Next exited before E2E completed (code ${evidence.child?.exitCode})`);
}

async function portMustBeFree() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen({ host, port, exclusive: true }, () => {
      socket.close((error) => error ? reject(error) : resolve());
    });
  });
  evidence.preconditions.push(`Exclusive bind/release proved ${host}:${port} was free before launch`);
}

async function request(method: string, path: string, authorization: string | null, input: string | null, timeoutMs = 120_000) {
  ensureRunning();
  const headers: Record<string, string> = {};
  if (input !== null) headers["content-type"] = "application/json";
  if (authorization !== null) headers.authorization = authorization;
  const response = await fetch(`${base}${path}`, {
    method, headers, body: input, redirect: "manual",
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await response.text();
  let observed: unknown;
  try { observed = JSON.parse(text); } catch { observed = text.slice(0, 4096); }
  evidence.checks.push({
    method, url: `${base}${path}`, authorization, input, status: response.status,
    contentType: response.headers.get("content-type"), observed,
  });
  assert.match(response.headers.get("content-type") ?? "", /application\/json/, `${method} ${path}: expected JSON`);
  ensureRunning();
  return { status: response.status, body: observed };
}

function assertHealth(result: { status: number; body: unknown }) {
  assert.equal(result.status, 200, "Health must return 200");
  assert.ok(result.body !== null && typeof result.body === "object", "Health must return an object");
  const body = result.body as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.service, "finnor-api");
  assert.equal(body.environment, environment, "Health must come from this test's server");
}

async function awaitHealth() {
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    ensureRunning();
    try {
      const result = await request("GET", "/api/health", null, null, 2_000);
      assertHealth(result);
      return;
    } catch (error) {
      ensureRunning();
      // A completed HTTP response is evidence, not a retryable connection warmup.
      if (evidence.checks.length > 0) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(200);
    }
  }
  throw new Error(`Health never became ready within 180 seconds: ${lastError}`);
}

function ownedGroupAlive(pid: number) {
  try { process.kill(-pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function cleanup() {
  const pid = child?.pid;
  if (!pid) return;
  evidence.cleanup.ownedPid = pid;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!ownedGroupAlive(pid)) break;
    // detached creates a new group containing only our CLI and its Next forks.
    // Never discover/kill a process by port, name, or a peer's PID.
    try { process.kill(-pid, signal); evidence.cleanup.signals.push(signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 5_000;
    while (ownedGroupAlive(pid) && Date.now() < deadline) await sleep(100);
  }
  if (closed) await Promise.race([closed, sleep(5_000)]);
  evidence.cleanup.processGroupGone = !ownedGroupAlive(pid);
  evidence.cleanup.childClosed = childClosed;
  assert.equal(evidence.cleanup.processGroupGone, true, "Owned Next process group still exists after cleanup");
  assert.equal(childClosed, true, "Owned Next CLI did not close after cleanup");
}

function appendEvidence() {
  const text = readFileSync(contract, "utf8");
  const section = label === "first-failure" ? "## First failing result" : "## Repaired result";
  const start = text.indexOf(`${section}\n`);
  assert.ok(start >= 0, `Contract is missing ${section}`);
  const following = text.indexOf("\n## ", start + section.length);
  const end = following < 0 ? text.length : following;
  const result = `\n### E2E ${label} ${evidence.startedAt}\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`;
  writeFileSync(contract, `${text.slice(0, end)}${result}${text.slice(end)}`);
  console.log(`Evidence appended to ${contract}`);
}

try {
  assert.notEqual(process.platform, "win32", "Owned-PID process-group cleanup requires POSIX");
  const backendNext = JSON.parse(readFileSync(join(backend, "node_modules/next/package.json"), "utf8")) as { version: string };
  const rootNext = JSON.parse(readFileSync(join(root, "node_modules/next/package.json"), "utf8")) as { version: string };
  evidence.versions.backendNext = backendNext.version;
  evidence.versions.rootNext = rootNext.version;
  assert.match(backendNext.version, /^15\./, "Launch backend Next 15, never root Next 16");
  evidence.source.head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  evidence.source.tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  for (const directory of [root, backend, join(backend, "apps/api")]) {
    for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      assert.equal(existsSync(join(directory, name)), false, `Refusing automatic env loading from ${join(directory, name)}`);
    }
  }
  evidence.preconditions.push("No development dotenv files; child receives only the recorded allowlisted environment");
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "development",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_TRACE_UPLOAD_DISABLED: "1",
    NEXT_EXIT_TIMEOUT_MS: "5000",
    AUTH_DEV_BYPASS: "0",
    SECRETS_PROVIDER: "env",
    FINNOR_ENVIRONMENT: environment,
    FINNOR_COMMIT_SHA: evidence.source.head,
    FINNOR_RELEASE_SOURCE: "local-api-startup-e2e",
    CONSOLE_ORIGIN: "http://127.0.0.1:3161",
  };
  evidence.environment = env;
  await portMustBeFree();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => { interrupted = signal; abort.abort(); };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  child = spawn(process.execPath, argv, {
    cwd: backend, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid, "Next CLI did not create an owned PID");
  evidence.child = { pid: child.pid, exitCode: null, signal: null };
  child.once("error", (error) => { childError = error; });
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
      evidence.serverOutput.push({ stream, text });
      output += text;
      process[stream].write(text);
    });
  }
  closed = new Promise<void>((resolve) => child!.once("close", (exitCode, signal) => {
    childClosed = true;
    if (evidence.child) Object.assign(evidence.child, { exitCode, signal });
    resolve();
  }));
  await awaitHealth();
  const operations = ["synthesize", "replan", "read", "replay", "validate", "assessment", "observe", "decide", "handoff"];
  const tenantPolicy = "/api/policies/00000000-0000-4000-8000-000000000316/clarification_request";
  const probes = [
    ...operations.map((operation) => ({ method: "POST", path: `/api/policies/${operation}`, input: "{}" })),
    { method: "GET", path: tenantPolicy, input: null },
    { method: "PUT", path: tenantPolicy, input: "{}" },
    { method: "POST", path: `${tenantPolicy}/simulate`, input: "{}" },
  ];
  for (const probe of probes) {
    for (const authorization of [null, "Basic api-startup-e2e"]) {
      const result = await request(probe.method, probe.path, authorization, probe.input);
      assert.equal(result.status, 401, `${probe.method} ${probe.path}: anonymous/non-bearer must return 401`);
      assert.deepEqual(result.body, {
        error: authorization === null ? "Missing Authorization header" : "Missing bearer token",
      }, `${probe.method} ${probe.path}: preserve middleware/handler auth boundaries`);
    }
  }
  assertHealth(await request("GET", "/api/health", null, null));
  assert.equal(evidence.checks.length, 26, "Expected two health and 24 real policy HTTP observations");
  evidence.passed = true;
} catch (error) {
  evidence.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  try { await cleanup(); } catch (error) {
    evidence.passed = false;
    const message = error instanceof Error ? error.message : String(error);
    evidence.failure = [evidence.failure, `Cleanup failed: ${message}`].filter(Boolean).join("; ");
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  for (const path of evidence.generatedPaths) path.existsAfter = existsSync(join(root, path.path));
  evidence.endedAt = new Date().toISOString();
  appendEvidence();
}

console.log(`${evidence.passed ? "PASS" : "FAIL"} API startup E2E: ${evidence.checks.length} HTTP observations`);
if (evidence.failure) console.error(evidence.failure);
process.exitCode = evidence.passed ? 0 : 1;
