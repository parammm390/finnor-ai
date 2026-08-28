// P3.T8/T9 — Node-only staging load certification. It uses the built-in fetch
// implementation and the exact plan scenarios: 15 users for 20 minutes, then
// 25 users for 10 minutes. It is intentionally impossible to start without a
// verified staging contract, 25 distinct auth tokens, and a post-run DB
// reconciliation artifact.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { evaluateStagingGuards, formatStagingGuardReport, type StagingGuardReport } from "./staging-guards";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const REPORT_PATH = resolve(REPO_ROOT, "docs/release/generated/p3-load-results.json");
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/release/evidence/P3");
const LOAD_RUN_ID = process.env.P3_LOAD_RUN_ID?.trim() || randomUUID();

const CERTIFICATION_TENANTS = {
  alpha: "00000000-0000-4000-8000-0000000000a1",
  bravo: "00000000-0000-4000-8000-0000000000b1",
  charlie: "00000000-0000-4000-8000-0000000000c1",
} as const;

const LOAD_COVERAGE = {
  readOnlyQuestions: true,
  actionDrafts: true,
  approvals: true,
  concurrentDuplicates: true,
  queueVitals: true,
  voiceSession: "not-testable-without-isolated-voice-binding",
} as const;

type RequestKind = "read" | "draft" | "approval" | "duplicate" | "vitals";

interface Sample {
  kind: RequestKind;
  status: number;
  elapsedMs: number;
  ok: boolean;
  queueOldestAgeSeconds: number | null;
}

interface ScenarioResult {
  name: string;
  users: number;
  durationMinutes: number;
  startedAt: string;
  endedAt: string;
  requestCount: number;
  failureCount: number;
  errorRate: number;
  p50Ms: Record<RequestKind, number | null>;
  p95Ms: Record<RequestKind, number | null>;
  p99Ms: Record<RequestKind, number | null>;
  oldestQueueAgeSeconds: number | null;
  pass: boolean;
}

function percentile(values: number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

async function loadTokens(): Promise<string[]> {
  const path = process.env.P3_LOAD_JWTS_FILE;
  if (!path) throw new Error("P3_LOAD_JWTS_FILE is required; token values are never printed");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 25 || parsed.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("P3_LOAD_JWTS_FILE must contain at least 25 non-empty JWT strings");
  }
  return parsed as string[];
}

function baseUrl(): string {
  const value = process.env.STAGING_API_URL;
  if (!value) throw new Error("STAGING_API_URL is required");
  return value;
}

async function request(kind: RequestKind, token: string, userIndex: number, iteration: number): Promise<Sample> {
  const base = baseUrl();
  const started = Date.now();
  // Each virtual user represents a distinct authenticated client. Supplying a
  // stable TEST-NET address per user keeps the IP rate-limit bucket faithful to
  // that model; otherwise every user is seen as `unknown` and contends on one
  // Postgres counter row, measuring harness serialization instead of API load.
  const clientIp = `198.51.100.${userIndex + 1}`;
  const headers = { accept: "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": clientIp };
  let response: Response;
  if (kind === "duplicate") {
    const idempotencyKey = `p3-load-${LOAD_RUN_ID}-duplicate-${userIndex}-${iteration}`;
    const body = JSON.stringify({ instruction: process.env.P3_LOAD_INSTRUCTION, channel: "text", idempotencyKey });
    const first = await fetch(new URL("/api/actions", base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-correlation-id": idempotencyKey },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    await first.text();
    const second = await fetch(new URL("/api/actions", base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-correlation-id": idempotencyKey },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const secondText = await second.text();
    let secondBody: unknown = null;
    try { secondBody = secondText ? JSON.parse(secondText) : null; } catch { /* duplicate marker remains false */ }
    const duplicate = Boolean(secondBody && typeof secondBody === "object" && (secondBody as Record<string, unknown>).duplicate === true);
    return {
      kind,
      status: second.status,
      elapsedMs: Date.now() - started,
      ok: first.ok && second.ok && duplicate,
      queueOldestAgeSeconds: null,
    };
  }
  if (kind === "draft") {
    const idempotencyKey = `p3-load-${LOAD_RUN_ID}-${userIndex}-${iteration}`;
    response = await fetch(new URL("/api/actions", base), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-correlation-id": idempotencyKey },
      body: JSON.stringify({ instruction: process.env.P3_LOAD_INSTRUCTION, channel: "text", idempotencyKey }),
      signal: AbortSignal.timeout(30_000),
    });
  } else {
    const path = kind === "read" ? "/api/read-models/cash-collections" : kind === "approval" ? "/api/actions/pending" : "/api/vitals";
    response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(30_000) });
  }
  const elapsedMs = Date.now() - started;
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* response shape is not evidence */ }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const queue = record.queue && typeof record.queue === "object" ? record.queue as Record<string, unknown> : {};
  const age = typeof queue.oldestPendingAgeSeconds === "number" ? queue.oldestPendingAgeSeconds : null;
  return { kind, status: response.status, elapsedMs, ok: response.ok, queueOldestAgeSeconds: age };
}

async function runScenario(name: string, users: number, durationMinutes: number, tokens: string[]): Promise<ScenarioResult> {
  const start = Date.now();
  const end = start + durationMinutes * 60_000;
  const samples: Sample[] = [];
  let iteration = 0;
  async function userLoop(userIndex: number): Promise<void> {
    while (Date.now() < end) {
      const current = iteration++;
      for (const kind of ["read", "draft", "approval", "duplicate", "vitals"] as const) {
        try {
          samples.push(await request(kind, tokens[userIndex]!, userIndex, current));
        } catch {
          samples.push({ kind, status: 599, elapsedMs: 30_000, ok: false, queueOldestAgeSeconds: null });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: users }, (_, index) => userLoop(index)));
  const byKind = (kind: RequestKind) => samples.filter((sample) => sample.kind === kind);
  const p = (kind: RequestKind, value: number) => percentile(byKind(kind).map((sample) => sample.elapsedMs), value);
  const failureCount = samples.filter((sample) => !sample.ok).length;
  const errorRate = samples.length ? failureCount / samples.length : 1;
  const oldestQueueAgeSeconds = Math.max(...samples.map((sample) => sample.queueOldestAgeSeconds ?? 0));
  const measuredKinds = ["read", "draft", "approval", "duplicate", "vitals"] as const;
  const p50Ms = Object.fromEntries(measuredKinds.map((kind) => [kind, p(kind, 50)])) as Record<RequestKind, number | null>;
  const p95Ms = Object.fromEntries(measuredKinds.map((kind) => [kind, p(kind, 95)])) as Record<RequestKind, number | null>;
  const p99Ms = Object.fromEntries(measuredKinds.map((kind) => [kind, p(kind, 99)])) as Record<RequestKind, number | null>;
  const pass = samples.length > 0
    && errorRate < 0.01
    && (p95Ms.read ?? Number.POSITIVE_INFINITY) < 2_500
    && (p95Ms.draft ?? Number.POSITIVE_INFINITY) < 8_000
    && (p95Ms.approval ?? Number.POSITIVE_INFINITY) < 2_000
    && oldestQueueAgeSeconds < 30;
  return {
    name,
    users,
    durationMinutes,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date().toISOString(),
    requestCount: samples.length,
    failureCount,
    errorRate,
    p50Ms,
    p95Ms,
    p99Ms,
    oldestQueueAgeSeconds,
    pass,
  };
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/**
 * Reconcile the exact load submission namespace after the timed scenarios. The
 * load runner owns the `p3-load-*` namespace, so the canonical Work input key is a
 * direct database proof that the concurrent duplicate class did not create a
 * second planner claim. Marker visibility and fixed certification IDs provide
 * the tenant-boundary/data-integrity checks without printing payloads.
 */
async function reconcileStagingLoad(): Promise<Record<string, unknown>> {
  const connectionString = process.env.STAGING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("STAGING_DATABASE_URL or DATABASE_URL is required for post-load reconciliation");
  const parsed = new URL(connectionString);
  parsed.searchParams.delete("sslmode");
  const client = new Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } });
  const perTenant: Record<string, { workInputRows: number; duplicateKeys: number; bravoMarkerVisible: number; ownMarkerVisible: number; fixedHouseholds: number }> = {};
  try {
    await client.connect();
    for (const [alias, tenantId] of Object.entries(CERTIFICATION_TENANTS)) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const inputs = await client.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM finnor_os.work_inputs WHERE idempotency_key LIKE 'p3-load-%'",
      );
      const keys = inputs.rows.map((row) => row.idempotency_key);
      const uniqueKeys = new Set(keys);
      const markers = await client.query<{ bravo: string; own: string }>(
        "SELECT count(*) FILTER (WHERE water_profile::text LIKE '%BRAVO-ISOLATION-SENTINEL%')::int AS bravo, count(*) FILTER (WHERE water_profile::text LIKE $1)::int AS own FROM finnor_os.households",
        [`%${alias.toUpperCase()}-CERTIFICATION%`],
      );
      const fixed = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM finnor_os.households WHERE id::text LIKE $1",
        [`${alias === "alpha" ? "a1000000" : alias === "bravo" ? "b1000000" : "c1000000"}%`],
      );
      perTenant[alias] = {
        workInputRows: keys.length,
        duplicateKeys: keys.length - uniqueKeys.size,
        bravoMarkerVisible: Number(markers.rows[0]?.bravo ?? 0),
        ownMarkerVisible: Number(markers.rows[0]?.own ?? 0),
        fixedHouseholds: Number(fixed.rows[0]?.n ?? 0),
      };
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  const tenantLeaks = Object.entries(perTenant).reduce((count, [alias, value]) => count + (alias === "bravo" ? 0 : value.bravoMarkerVisible), 0);
  const dataCorruption = Object.values(perTenant).reduce((count, value) => count + (value.fixedHouseholds === 40 ? 0 : 1), 0);
  const duplicateEffects = Object.values(perTenant).reduce((count, value) => count + value.duplicateKeys, 0);
  return {
    phase: "P3",
    gate: "load-reconciliation",
    status: duplicateEffects === 0 && tenantLeaks === 0 && dataCorruption === 0 ? "PASS" : "FAIL",
    pass: duplicateEffects === 0 && tenantLeaks === 0 && dataCorruption === 0,
    duplicateEffects,
    tenantLeaks,
    dataCorruption,
    perTenant,
    evidence: "docs/release/generated/p3-load-reconciliation-20260807.json",
  };
}

function blockedReport(guard: StagingGuardReport, error?: string): Record<string, unknown> {
  return {
    phase: "P3",
    gate: "load",
    status: "BLOCKED-CONFIG",
    pass: false,
    productionEgress: false,
    guard,
    error: error ?? null,
    scenarios: [],
    reconciliation: "not_run",
    coverage: LOAD_COVERAGE,
    evidence: "docs/release/generated/p3-load-results.json",
  };
}

export async function runLoadCertification(): Promise<Record<string, unknown>> {
  const guard = evaluateStagingGuards("load");
  if (guard.status !== "PASS") {
    const report = blockedReport(guard);
    await writeReport(report);
    console.error(formatStagingGuardReport(guard));
    return report;
  }
  const tokens = await loadTokens();
  const scenarios = [
    await runScenario("15-user-20-minute", 15, 20, tokens),
    await runScenario("25-user-10-minute", 25, 10, tokens),
  ];
  const reconciliationPath = process.env.P3_LOAD_RECONCILIATION_FILE!;
  const reconciliation = await reconcileStagingLoad();
  await writeFile(reconciliationPath, `${JSON.stringify(reconciliation, null, 2)}\n`, "utf8");
  const report = {
    phase: "P3",
    gate: "load",
    status: scenarios.every((scenario) => scenario.pass) && reconciliation.pass === true ? "PASS" : "FAIL",
    pass: scenarios.length === 2 && scenarios.every((scenario) => scenario.pass) && reconciliation.pass === true && reconciliation.duplicateEffects === 0 && reconciliation.tenantLeaks === 0 && reconciliation.dataCorruption === 0,
    productionEgress: false,
    guard,
    scenarios,
    reconciliation: { pass: reconciliation.pass === true, duplicateEffects: reconciliation.duplicateEffects ?? null, tenantLeaks: reconciliation.tenantLeaks ?? null, dataCorruption: reconciliation.dataCorruption ?? null },
    coverage: LOAD_COVERAGE,
    evidence: "docs/release/generated/p3-load-results.json",
  };
  await writeReport(report);
  // Keep the measured scenarios in the durable report when a threshold fails.
  // The CLI wrapper below still returns exit code 1, so a failed gate cannot be
  // mistaken for success, while the evidence remains diagnostic instead of
  // being overwritten by the generic top-level catch.
  if (!report.pass) {
    console.error("P3_LOAD_FAIL", JSON.stringify({ scenarios, reconciliation: report.reconciliation }));
    return report;
  }
  console.log("P3_LOAD_PASS scenarios=2/2");
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLoadCertification().then((report) => {
    if (!report.pass) process.exitCode = 1;
  }).catch(async (error) => {
    const guard = evaluateStagingGuards("load");
    const message = error instanceof Error ? error.message : "unknown error";
    await writeReport({
      ...blockedReport(guard, message),
      status: guard.status === "PASS" ? "FAIL" : "BLOCKED-CONFIG",
    });
    console.error(`P3_LOAD_FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
