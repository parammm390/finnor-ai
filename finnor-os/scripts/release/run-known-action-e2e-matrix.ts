// P3.T5 — deterministic staging certification for the fixed 44-action spec.
//
// This is intentionally separate from the planner smoke runner. Every row starts
// at FinnorOrchestrator.draftKnownAction(), after a real Supabase JWT/tenant
// verification, and therefore cannot turn a slow or unavailable LLM planner into
// a false certification failure. The canonical Work input claim, approval decision,
// executor/runtime bridge, worker queue, and DecisionReceipt tables are still
// exercised and reported independently.

import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import {
  closePool,
  decisionReceipts,
  domainActions,
  getPool,
  receiveWork,
  recordWorkResponse,
  withTenant,
} from "@finnor/db";
import { resolveTenantFromBearerToken } from "@finnor/security";
import { FinnorOrchestrator, type Planner } from "../../packages/orchestration/src/index";
import type { ExecutionResult } from "../../packages/shared-types/src/index";
import {
  LEGACY_ACTION_HARDENING_SPEC as ACTION_HARDENING_SPEC,
  requiresTypedConfirmation,
} from "./action-hardening-spec";
import { buildActionFixture } from "./run-action-contract-matrix";
import { CERTIFICATION_TENANTS, type CertificationTenantKey } from "./seed-certification-tenants";
import { evaluateStagingGuards, formatStagingGuardReport, type StagingGuardReport } from "./staging-guards";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const REPORT_PATH = resolve(REPO_ROOT, "docs/release/generated/p3-known-action-results.json");
const EVIDENCE_PATH = resolve(REPO_ROOT, "docs/release/evidence/P3/p3-t5-known-action-certification-20260807.txt");
const FAILING_ROW_PREFLIGHT_PATH = resolve(REPO_ROOT, "docs/release/generated/p3-t5-failing-rows-before-known-action.json");

type TenantKey = CertificationTenantKey;

interface E2ECase {
  actionType: string;
  tenant: TenantKey;
  expectedTerminalStatus: string;
}

interface AuthContext {
  tenant: TenantKey;
  tenantId: string;
  userId: string;
  role: string;
  verified: boolean;
}

interface ServiceHealth {
  status: number | null;
  ok: boolean;
  elapsedMs: number | null;
  environment: string | null;
  release: string | null;
  bodyShape: string;
  error?: string;
}

interface ActionSnapshot {
  status: string | null;
  policyId: string | null;
  policyVersion: number | null;
}

interface ReceiptSnapshot {
  id: string | null;
  finalized: boolean;
  policyApplied: boolean;
  actualResult: boolean;
  failure: boolean;
}

interface WorkerJobSnapshot {
  key: string;
  status: string;
  attempts: number | null;
}

interface MatrixRow {
  number: number;
  actionType: string;
  tenant: TenantKey;
  profile: string;
  approvalFloor: string;
  expectedTerminalStatus: string;
  executionPath: "draftKnownAction";
  plannerInvoked: false;
  authVerified: boolean;
  policyApplied: boolean;
  policyVersion: number | null;
  approvalRequiredExpected: boolean;
  approvalGateObserved: boolean;
  approvalPass: boolean;
  typedConfirmationSent: boolean;
  approvalDuplicateSafe: boolean;
  actionId: string | null;
  actionStatus: string | null;
  executionPass: boolean;
  receiptId: string | null;
  receiptFinalized: boolean;
  receiptTruthful: boolean;
  idempotencyKeyClaimed: boolean;
  idempotencyDuplicateSafe: boolean;
  workerJobKey: string | null;
  workerJobStatus: string;
  workerPass: boolean;
  observedResultStatus: string | null;
  outcomeMatchesExpected: boolean;
  elapsedMs: number | null;
  corePathPass: boolean;
  status: "PASS" | "FAIL";
  error?: string;
}

interface SafeStoredResponse extends Record<string, unknown> {
  actionId: string | null;
  actionType: string;
  actionStatus: string | null;
  resultStatus: string | null;
}

interface FailingRowPreflight {
  sourceReport?: unknown;
  sourceGate?: unknown;
  sourceStatus?: unknown;
  rowCount?: unknown;
  failCount?: unknown;
  rows?: unknown;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown error")
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/[^A-Za-z0-9 _.:-]/g, "")
    .slice(0, 500);
}

function timeoutMs(): number {
  const configured = Number(process.env.P3_KNOWN_ACTION_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 5_000), 120_000) : 120_000;
}

function tenantToken(tenant: TenantKey): string {
  const name = tenant === "alpha" ? "STAGING_JWT_ALPHA" : tenant === "bravo" ? "STAGING_JWT_BRAVO" : "STAGING_JWT_CHARLIE";
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; token value withheld`);
  return value;
}

function urlFor(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function resultStatus(result: ExecutionResult | null): string | null {
  return result?.status ?? null;
}

function resultOutput(result: ExecutionResult | null): Record<string, unknown> {
  return jsonRecord(result?.output);
}

function terminalStatus(status: string | null): boolean {
  return status === "completed"
    || status === "failed"
    || status === "blocked_integration_unavailable"
    || status === "rejected"
    || status === "needs_human_review";
}

async function healthRequest(base: string, path: string, token?: string): Promise<ServiceHealth> {
  const started = Date.now();
  try {
    const response = await fetch(urlFor(base, path), {
      signal: AbortSignal.timeout(Math.min(timeoutMs(), 15_000)),
      headers: {
        accept: "application/json, text/plain",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await response.text();
    let bodyShape = text.trim() === "ok" ? "text_ok" : "body_present";
    try {
      const body = text ? JSON.parse(text) as unknown : null;
      bodyShape = body && typeof body === "object" ? `json_keys_${Object.keys(body as Record<string, unknown>).length}` : bodyShape;
    } catch {
      // The body shape is intentionally not persisted; only its safe category is.
    }
    return {
      status: response.status,
      ok: response.ok,
      elapsedMs: Date.now() - started,
      environment: response.headers.get("x-finnor-environment"),
      release: response.headers.get("x-finnor-release"),
      bodyShape,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      elapsedMs: Date.now() - started,
      environment: null,
      release: null,
      bodyShape: "unavailable",
      error: safeError(error),
    };
  }
}

async function probeServices(): Promise<Record<string, ServiceHealth>> {
  const api = process.env.STAGING_API_URL!;
  const services = {
    api: await healthRequest(api, "/api/health", tenantToken("alpha")),
    frontend: await healthRequest(process.env.STAGING_FRONTEND_URL!, "/"),
    worker: await healthRequest(process.env.STAGING_WORKER_URL!, "/healthz"),
    orchestrator: await healthRequest(process.env.STAGING_ORCHESTRATOR_URL!, "/health"),
  };
  return services;
}

async function loadCases(): Promise<E2ECase[]> {
  const path = process.env.P3_E2E_CASES_FILE;
  if (!path) throw new Error("P3_E2E_CASES_FILE is required; no 44-row staging corpus was supplied");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const rows = Array.isArray(parsed) ? parsed : jsonRecord(parsed).cases;
  if (!Array.isArray(rows)) throw new Error("P3_E2E_CASES_FILE must contain an array or {cases: []}");
  if (rows.length !== ACTION_HARDENING_SPEC.length) throw new Error(`P3 E2E corpus has ${rows.length} rows; expected 44`);
  const fixed = new Set(ACTION_HARDENING_SPEC.map((row) => row.actionType));
  const seen = new Set<string>();
  const cases: E2ECase[] = [];
  for (const value of rows) {
    const row = jsonRecord(value);
    const actionType = typeof row.actionType === "string" ? row.actionType : "";
    const tenant = row.tenant;
    if (!fixed.has(actionType)) throw new Error(`P3 E2E corpus contains unknown action ${actionType || "<missing>"}`);
    if (seen.has(actionType)) throw new Error(`P3 E2E corpus duplicates action ${actionType}`);
    if (tenant !== "alpha" && tenant !== "bravo" && tenant !== "charlie") throw new Error(`P3 E2E corpus has invalid tenant for ${actionType}`);
    if (typeof row.expectedTerminalStatus !== "string") throw new Error(`P3 E2E corpus has no expected status for ${actionType}`);
    seen.add(actionType);
    cases.push({ actionType, tenant, expectedTerminalStatus: row.expectedTerminalStatus });
  }
  if (seen.size !== fixed.size) throw new Error("P3 E2E corpus does not cover every fixed action");
  if (new Set(cases.map((row) => row.tenant)).size !== 3) throw new Error("P3 E2E corpus must exercise Alpha, Bravo, and Charlie");
  return cases;
}

async function verifyAuth(): Promise<Record<TenantKey, AuthContext>> {
  const result = {} as Record<TenantKey, AuthContext>;
  for (const tenant of ["alpha", "bravo", "charlie"] as const) {
    const context = await resolveTenantFromBearerToken(tenantToken(tenant));
    const expectedTenantId = CERTIFICATION_TENANTS[tenant].id;
    if (context.tenantId !== expectedTenantId) {
      throw new Error(`JWT tenant mismatch for ${tenant}; expected certification tenant`);
    }
    result[tenant] = {
      tenant,
      tenantId: context.tenantId,
      userId: context.userId,
      role: context.role,
      verified: true,
    };
  }
  return result;
}

function payloadFor(actionType: string): Record<string, unknown> {
  if (actionType === "get_business_overview") return { focus: "pending" };
  if (actionType === "check_stock_level") return { sku: "SED-FILT-10" };
  return buildActionFixture(actionType);
}

async function actionSnapshot(tenantId: string, actionId: string): Promise<ActionSnapshot> {
  const [row] = await withTenant(tenantId, (db) =>
    db.select({ status: domainActions.status, policyId: domainActions.policyId, policyVersion: domainActions.policyVersion })
      .from(domainActions)
      .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)))
      .limit(1),
  );
  return {
    status: row?.status ?? null,
    policyId: row?.policyId ?? null,
    policyVersion: row?.policyVersion ?? null,
  };
}

async function receiptSnapshot(tenantId: string, actionId: string): Promise<ReceiptSnapshot> {
  const [row] = await withTenant(tenantId, (db) =>
    db.select({
      id: decisionReceipts.id,
      finalizedAt: decisionReceipts.finalizedAt,
      policyApplied: decisionReceipts.policyApplied,
      actualResult: decisionReceipts.actualResult,
      failure: decisionReceipts.failure,
    })
      .from(decisionReceipts)
      .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.domainActionId, actionId)))
      .orderBy(desc(decisionReceipts.createdAt))
      .limit(1),
  );
  return {
    id: row?.id ?? null,
    finalized: Boolean(row?.finalizedAt),
    policyApplied: row?.policyApplied !== null && row?.policyApplied !== undefined,
    actualResult: row?.actualResult !== null && row?.actualResult !== undefined,
    failure: row?.failure !== null && row?.failure !== undefined,
  };
}

function safeResponse(actionId: string | null, actionType: string, snapshot: ActionSnapshot | null, result: ExecutionResult | null): SafeStoredResponse {
  return {
    actionId,
    actionType,
    actionStatus: snapshot?.status ?? null,
    resultStatus: resultStatus(result),
  };
}

function cachedResponseMatches(response: unknown, expected: SafeStoredResponse): boolean {
  const actual = jsonRecord(response);
  return actual.actionId === expected.actionId
    && actual.actionType === expected.actionType
    && actual.actionStatus === expected.actionStatus;
}

async function readWorkerJobs(keys: string[]): Promise<Map<string, WorkerJobSnapshot>> {
  const result = new Map<string, WorkerJobSnapshot>();
  if (keys.length === 0) return result;
  const rows = await getPool().query<{ idempotency_key: string; status: string; attempts: number }>(
    "SELECT idempotency_key, status, attempts FROM jobs WHERE idempotency_key = ANY($1::text[])",
    [keys],
  );
  for (const row of rows.rows) {
    result.set(row.idempotency_key, { key: row.idempotency_key, status: row.status, attempts: Number(row.attempts) });
  }
  return result;
}

async function waitForWorkerJobs(keys: string[]): Promise<Map<string, WorkerJobSnapshot>> {
  const deadline = Date.now() + 30_000;
  let latest = new Map<string, WorkerJobSnapshot>();
  while (Date.now() <= deadline) {
    latest = await readWorkerJobs(keys);
    const settled = keys.every((key) => latest.get(key)?.status === "completed" || latest.get(key)?.status === "dead_letter");
    if (settled) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  }
  return latest;
}

async function runRow(
  row: E2ECase,
  number: number,
  auth: AuthContext,
  orchestrator: FinnorOrchestrator,
): Promise<MatrixRow> {
  const spec = ACTION_HARDENING_SPEC.find((candidate) => candidate.actionType === row.actionType)!;
  const started = Date.now();
  const idempotencyKey = `p3-known-${row.actionType}-${randomUUID()}`;
  const expectedApproval = spec.approvalFloor !== "NONE";
  let claimId: string | null = null;
  let received: Awaited<ReturnType<typeof receiveWork>> | null = null;
  let actionId: string | null = null;
  let action: ActionSnapshot | null = null;
  let receipt: ReceiptSnapshot = { id: null, finalized: false, policyApplied: false, actualResult: false, failure: false };
  let firstResult: ExecutionResult | null = null;
  let approvalResult: ExecutionResult | null = null;
  let duplicateApproval: ExecutionResult | null = null;
  let observedGate = false;
  let idempotencyClaimed = false;
  let idempotencyDuplicateSafe = false;
  let workerJobKey: string | null = null;
  let error: string | undefined;
  let stored: SafeStoredResponse = safeResponse(null, row.actionType, null, null);

  try {
    received = await receiveWork({
      tenantId: auth.tenantId,
      instruction: `P3 known action: ${row.actionType}`,
      channel: "text",
      instructionId: randomUUID(),
      userId: auth.userId,
      idempotencyKey,
      authorityContext: { principal: auth.userId, roles: [auth.role] },
    });
    if (!received.created || received.duplicate) throw new Error("fresh canonical Work input was not created");
    claimId = received.workId;
    idempotencyClaimed = true;

    const drafted = await orchestrator.draftKnownAction(
      row.actionType,
      payloadFor(row.actionType),
      auth.tenantId,
      {
        source: "p3_t5_known_action_certification",
        workId: received.workId,
        instructionId: received.instructionId,
        initiatedBy: auth.userId,
        authorityContext: { principal: auth.userId, roles: [auth.role] },
      },
    );
    actionId = drafted.action.id;
    firstResult = drafted.result;
    action = await actionSnapshot(auth.tenantId, actionId);
    observedGate = resultOutput(firstResult).pendingConfirmation === true || action.status === "pending";
    workerJobKey = observedGate ? `push:approval-needed:${actionId}` : null;

    if (observedGate) {
      approvalResult = await orchestrator.decide(
        actionId,
        auth.tenantId,
        "approve",
        auth.userId,
        { role: auth.role, typedConfirmation: requiresTypedConfirmation(row.actionType) },
      );
      duplicateApproval = await orchestrator.decide(
        actionId,
        auth.tenantId,
        "approve",
        auth.userId,
        { role: auth.role, typedConfirmation: requiresTypedConfirmation(row.actionType) },
      );
    }

    action = await actionSnapshot(auth.tenantId, actionId);
    receipt = await receiptSnapshot(auth.tenantId, actionId);
    const finalResult = observedGate ? approvalResult : firstResult;
    stored = safeResponse(actionId, row.actionType, action, finalResult);
    await recordWorkResponse(auth.tenantId, claimId, stored);
    const duplicate = await receiveWork({
      tenantId: auth.tenantId,
      instruction: `P3 known action: ${row.actionType}`,
      channel: "text",
      instructionId: received.instructionId,
      userId: auth.userId,
      idempotencyKey,
      authorityContext: { principal: auth.userId, roles: [auth.role] },
    });
    idempotencyDuplicateSafe = duplicate.duplicate
      && duplicate.workId === claimId
      && cachedResponseMatches(jsonRecord(duplicate.finalOutcome).response, stored);
  } catch (caught) {
    error = safeError(caught);
    if (claimId) {
      try {
        action = actionId ? await actionSnapshot(auth.tenantId, actionId) : null;
        receipt = actionId ? await receiptSnapshot(auth.tenantId, actionId) : receipt;
        stored = safeResponse(actionId, row.actionType, action, observedGate ? approvalResult : firstResult);
        await recordWorkResponse(auth.tenantId, claimId, stored);
        const duplicate = await receiveWork({
          tenantId: auth.tenantId,
          instruction: `P3 known action: ${row.actionType}`,
          channel: "text",
          instructionId: received?.instructionId ?? randomUUID(),
          userId: auth.userId,
          idempotencyKey,
          authorityContext: { principal: auth.userId, roles: [auth.role] },
        });
        idempotencyDuplicateSafe = duplicate.duplicate
          && duplicate.workId === claimId
          && cachedResponseMatches(jsonRecord(duplicate.finalOutcome).response, stored);
      } catch (completionError) {
        error = `${error}; idempotency completion ${safeError(completionError)}`.slice(0, 500);
      }
    }
  }

  const actionStatus = action?.status ?? null;
  const policyApplied = Boolean(action?.policyId && (action.policyVersion ?? 0) > 0 && receipt.policyApplied);
  const approvalPass = expectedApproval
    ? observedGate && approvalResult?.status === "success" && actionStatus !== "pending"
    : !observedGate;
  const approvalDuplicateSafe = expectedApproval
    ? duplicateApproval?.status === "success" && resultOutput(duplicateApproval).idempotent === true
    : true;
  const receiptTruthful = receipt.finalized && (receipt.actualResult !== receipt.failure);
  const executionPass = terminalStatus(actionStatus) && receipt.finalized && receiptTruthful;
  const outcomeMatchesExpected = row.expectedTerminalStatus === "completed"
    ? actionStatus === "completed" && receipt.actualResult && !receipt.failure
    : actionStatus === row.expectedTerminalStatus;
  const corePathPass = auth.verified
    && policyApplied
    && (expectedApproval === observedGate)
    && approvalPass
    && approvalDuplicateSafe
    && idempotencyClaimed
    && idempotencyDuplicateSafe
    && executionPass
    && outcomeMatchesExpected;

  return {
    number,
    actionType: row.actionType,
    tenant: row.tenant,
    profile: spec.profile,
    approvalFloor: spec.approvalFloor,
    expectedTerminalStatus: row.expectedTerminalStatus,
    executionPath: "draftKnownAction",
    plannerInvoked: false,
    authVerified: auth.verified,
    policyApplied,
    policyVersion: action?.policyVersion ?? null,
    approvalRequiredExpected: expectedApproval,
    approvalGateObserved: observedGate,
    approvalPass,
    typedConfirmationSent: observedGate && requiresTypedConfirmation(row.actionType),
    approvalDuplicateSafe,
    actionId,
    actionStatus,
    executionPass,
    receiptId: receipt.id,
    receiptFinalized: receipt.finalized,
    receiptTruthful,
    idempotencyKeyClaimed: idempotencyClaimed,
    idempotencyDuplicateSafe,
    workerJobKey,
    workerJobStatus: workerJobKey ? "pending_probe" : "not_applicable",
    workerPass: !workerJobKey,
    observedResultStatus: resultStatus(observedGate ? approvalResult : firstResult),
    outcomeMatchesExpected,
    elapsedMs: Date.now() - started,
    corePathPass,
    status: corePathPass ? "PASS" : "FAIL",
    ...(error ? { error } : {}),
  };
}

function refreshRowStatus(row: MatrixRow, worker: WorkerJobSnapshot | undefined, workerHealthPass: boolean): void {
  row.workerJobStatus = worker?.status ?? (row.workerJobKey ? "not_found" : "not_applicable");
  row.workerPass = workerHealthPass && (!row.workerJobKey || worker?.status === "completed");
  row.status = row.corePathPass && row.workerPass ? "PASS" : "FAIL";
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function verifyFailingRowPreflight(): Promise<{ path: string; rowCount: number; failCount: number }> {
  const preflight = JSON.parse(await readFile(FAILING_ROW_PREFLIGHT_PATH, "utf8")) as FailingRowPreflight;
  const rows = Array.isArray(preflight.rows) ? preflight.rows : [];
  const rowCount = Number(preflight.rowCount);
  const failCount = Number(preflight.failCount);
  if (preflight.sourceGate !== "api-e2e" || preflight.sourceStatus !== "FAIL" || rowCount !== 44 || failCount !== 44 || rows.length !== 44) {
    throw new Error("P3.T5 exact 44-row failing-row preflight is missing or incomplete; refusing full deterministic rerun");
  }
  if (rows.some((row) => jsonRecord(row).status === "PASS")) {
    throw new Error("P3.T5 failing-row preflight contains a PASS row; refusing to overwrite the exact failure baseline");
  }
  return { path: "docs/release/generated/p3-t5-failing-rows-before-known-action.json", rowCount, failCount };
}

async function writeEvidence(report: Record<string, unknown>): Promise<void> {
  const rows = Array.isArray(report.rows) ? report.rows.map(jsonRecord) : [];
  const lines = [
    "P3.T5 — DETERMINISTIC KNOWN-ACTION CERTIFICATION",
    `generatedAt=${new Date().toISOString()}`,
    `gate=${String(report.gate ?? "unknown")} status=${String(report.status ?? "unknown")} pass=${String(report.pass ?? false)}`,
    `path=${String(report.path ?? "unknown")}`,
    `plannerInvocations=${String(report.plannerInvocations ?? "unknown")}`,
    `exactRows=${rows.length}`,
    "auth=real staging Supabase JWT verification; tokenValuesPrinted=false",
    "policy=versioned tenant policy persisted on domain_action and cited by receipt",
    "approval=real pending gate, typed confirmation where fixed floor requires it, duplicate decision checked",
    "worker=staging approval-notification job status observed from the shared queue",
    "idempotency=real tenant-scoped intake claim completed then cached duplicate checked",
    "execution=existing draftKnownAction -> executor -> workflow-runtime receipt path",
    "",
    "number action tenant status actionStatus policyVersion approvalObserved approvalPass approvalDuplicateSafe workerStatus workerPass idempotencyDuplicateSafe receiptFinalized receiptTruthful outcomeMatchesExpected elapsedMs error",
    ...rows.map((row) => [
      row.number, row.actionType, row.tenant, row.status, row.actionStatus, row.policyVersion,
      row.approvalGateObserved, row.approvalPass, row.approvalDuplicateSafe, row.workerJobStatus,
      row.workerPass, row.idempotencyDuplicateSafe, row.receiptFinalized, row.receiptTruthful,
      row.outcomeMatchesExpected, row.elapsedMs, row.error ?? "null",
    ].map((value) => String(value ?? "null").replace(/[^A-Za-z0-9 _.:-]/g, "")).join(" ")),
    "",
    `failureRows=${JSON.stringify(report.failureRows ?? [])}`,
  ];
  await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${lines.join("\n")}\n`, "utf8");
}

export async function runKnownActionMatrix(): Promise<Record<string, unknown>> {
  const failingRowPreflight = await verifyFailingRowPreflight();
  const guard = evaluateStagingGuards("e2e");
  if (guard.status !== "PASS") {
    const report = {
      phase: "P3",
      gate: "known-action-e2e",
      status: "BLOCKED-CONFIG",
      pass: false,
      productionEgress: false,
      plannerInvocations: 0,
      failingRowPreflight,
      guard,
      rows: [],
      evidence: "docs/release/generated/p3-known-action-results.json",
    };
    await writeReport(report);
    console.error(formatStagingGuardReport(guard));
    return report;
  }

  const services = await probeServices();
  const servicesPass = Object.values(services).every((service) => service.ok);
  if (!servicesPass) {
    const report = {
      phase: "P3",
      gate: "known-action-e2e",
      status: "FAIL",
      pass: false,
      productionEgress: false,
      plannerInvocations: 0,
      failingRowPreflight,
      guard,
      services,
      rows: [],
      error: "staging service health probe failed; no deterministic action rows were sent",
      evidence: "docs/release/generated/p3-known-action-results.json",
    };
    await writeReport(report);
    return report;
  }

  const cases = await loadCases();
  const auth = await verifyAuth();
  let plannerCalls = 0;
  const plannerGuard: Planner = {
    plan: async () => {
      plannerCalls += 1;
      throw new Error("planner invocation is forbidden in the deterministic P3.T5 matrix");
    },
  };
  const orchestrator = new FinnorOrchestrator({ planner: plannerGuard });
  const rows: MatrixRow[] = [];
  for (const [index, row] of cases.entries()) {
    const result = await runRow(row, index + 1, auth[row.tenant], orchestrator);
    rows.push(result);
    console.log(`P3_KNOWN_ACTION_ROW ${index + 1}/44 action=${row.actionType} status=${result.status} elapsedMs=${result.elapsedMs ?? "null"}`);
  }

  const workerKeys = rows.flatMap((row) => row.workerJobKey ? [row.workerJobKey] : []);
  const workerJobs = await waitForWorkerJobs(workerKeys);
  const workerHealthPass = services.worker?.ok === true;
  for (const row of rows) refreshRowStatus(row, row.workerJobKey ? workerJobs.get(row.workerJobKey) : undefined, workerHealthPass);

  const pass = rows.length === ACTION_HARDENING_SPEC.length
    && rows.every((row) => row.status === "PASS")
    && plannerCalls === 0;
  const report = {
    phase: "P3",
    gate: "known-action-e2e",
    status: pass ? "PASS" : "FAIL",
    pass,
    productionEgress: false,
    path: "draftKnownAction -> existing Executor -> workflow-runtime receipts",
    plannerInvocations: plannerCalls,
    plannerSmokeSeparate: true,
    failingRowPreflight,
    auth: {
      mode: "jwt",
      verifiedTenants: Object.keys(auth),
      tokenValuesPrinted: false,
    },
    worker: {
      health: services.worker,
      approvalNotificationJobs: workerJobs.size,
      approvalNotificationJobsExpected: workerKeys.length,
      executionMode: "known-action runtime bridge is synchronous by design; worker proof is the real approval-notification queue claim/complete observation, not a false claim that every synchronous plugin call was async",
    },
    guard,
    services,
    rows,
    exactRows: rows.length,
    failureRows: rows.filter((row) => row.status !== "PASS").map((row) => ({ number: row.number, actionType: row.actionType, tenant: row.tenant, error: row.error ?? null })),
    evidence: "docs/release/evidence/P3/p3-t5-known-action-certification-20260807.txt",
  };
  await writeReport(report);
  await writeEvidence(report);
  console.log(`P3_KNOWN_ACTION_${pass ? "PASS" : "FAIL"} rows=${rows.filter((row) => row.status === "PASS").length}/44 plannerInvocations=${plannerCalls}`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKnownActionMatrix()
    .catch(async (error) => {
      const guard: StagingGuardReport = evaluateStagingGuards("e2e");
      const failingRowPreflight = await verifyFailingRowPreflight().catch(() => null);
      const report = {
        phase: "P3",
        gate: "known-action-e2e",
        status: guard.status === "PASS" ? "FAIL" : "BLOCKED-CONFIG",
        pass: false,
        productionEgress: false,
        plannerInvocations: 0,
        failingRowPreflight,
        guard,
        rows: [],
        error: safeError(error),
        evidence: "docs/release/generated/p3-known-action-results.json",
      };
      await writeReport(report).catch(() => undefined);
      console.error(`P3_KNOWN_ACTION_FAIL ${safeError(error)}`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => undefined));
}
