/**
 * Drives the maintained product, never a projection host. Caller owns the fresh
 * Playwright context, real frontend/API/worker, canonical seed/oracles and cleanup.
 * Invoke before native cleanup. Importing this module does not launch anything.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Page, Request as BrowserRequest, Response as BrowserResponse, Route, APIResponse } from "playwright-core";
import type { AuthenticatedHttpFixture, AuthObservation, AuthSessionHandle } from "./authenticated-http-fixture.mjs";

export type ApplicationStatus = "QUEUED" | "ACQUIRING" | "MODEL_READY" | "PLANNING" | "EXECUTING"
  | "WAITING_OBSERVATION" | "COMPLETED" | "UNKNOWN" | "BLOCKED" | "CANCELLED" | "STALE" | "FAILED";
export interface ApplicationExpectation {
  tenantId: string;
  principalId: string;
  root: { entityType: "pe_deal"; entityId: string };
  workId: string;
  sessionId: string | null;
  status: ApplicationStatus | null;
}
export interface PreparedInvestigation {
  threadId: string;
  /** Unique synthetic persisted title, used by the actual Investigations drawer. */
  title: string;
  expected: ApplicationExpectation;
}
export interface PanelObservation {
  mounted: number;
  workId: string | null;
  sessionId: string | null;
  status: string | null;
  tenantId: string | null;
  principalId: string | null;
  root: { entityType: string; entityId: string } | null;
  inputCount: number;
}
export interface OracleReceipt {
  source: "CANONICAL_SQL" | "INDEPENDENT_EXTERNAL_STATE";
  asserted: true;
  /** Caller-owned evidence path/record reference, never credentials or raw source bodies. */
  reference: string;
}
interface OracleBoundary { checkpoint: string; signal: AbortSignal; deadlineAt: number }
export interface CanonicalCheck extends OracleBoundary {
  expected: ApplicationExpectation | null;
  observed: PanelObservation;
  canvasFocusedBlockId?: string;
  mutationCounts: { acquisition: number; execution: number; cancellation: number };
}
export interface MountedWorkOptions {
  context: BrowserContext;
  contextOwnership: "FRESH_TASK_OWNED_NO_SAVED_AUTH";
  fixtureQualification: "SYNTHETIC_DISPOSABLE_ONLY";
  auth: AuthenticatedHttpFixture;
  frontendOrigin: string;
  apiOrigin: string;
  frontendMode: "development" | "production";
  apiWorkerRuntime: "EMITTED_PRODUCTION_NODE";
  acquisition: PreparedInvestigation;
  /** This separately persisted Investigation must already reference the empty fresh Work. */
  fresh: PreparedInvestigation;
  otherPrincipal: PreparedInvestigation;
  freshUse: {
    executionProfileId: string;
    targetId: string;
    goalJson: string;
    parametersJson: string;
    /** Declared independently before the UI runs, not copied from a rendered result. */
    businessExpectation: Readonly<Record<string, unknown>>;
  };
  /** Supply only when the initial acquisition Work has no sessions. */
  acquire?: {
    profileIdsJson: string;
    targetsJson: string;
    resourceDemandJson: string;
    deadlineAt: string;
  };
  settleAcquisition?: (request: OracleBoundary & { workId: string }) => Promise<ApplicationExpectation>;
  settleFreshUse: (request: OracleBoundary & { workId: string; parentSessionId: string }) => Promise<ApplicationExpectation>;
  assertCanonical: (request: CanonicalCheck) => Promise<OracleReceipt>;
  assertBusiness: (request: OracleBoundary & {
    expected: Readonly<Record<string, unknown>>;
    work: ApplicationExpectation;
  }) => Promise<OracleReceipt>;
  /** Must modify/read back the real native access owner; do not revoke the auth fixture here. */
  setPrincipalRevoked: (request: OracleBoundary & { principalId: string; revoked: boolean }) => Promise<OracleReceipt>;
  evidence: {
    ownedWorkspaceDirectory: string;
    /** Existing caller-owned directory beneath ownedWorkspaceDirectory, not the checkout. */
    evidenceDirectory: string;
    seedReceiptPath: string;
    runtimeReceiptPath: string;
    driverPath: string;
  };
  budgets?: { readMs?: number; settleMs?: number; delayMs?: number; negativeWindowMs?: number };
}
interface NetworkObservation {
  sequence: number; at: string; method: string; path: string; status: number;
  principalId: string | null; issueId: number | null; signedLiveBearer: boolean;
}
interface DelayObservation {
  name: string; path: string; principalId: string; workId?: string;
  capturedAt?: number; boundaryAt?: number; releasedAt?: number; settledAt?: number;
  responseStatus?: number; responseSha256?: string; negativeControlMatched?: boolean;
  browserResponseSeen?: boolean; browserRequestFinished?: boolean; browserRequestFailed?: boolean;
  delivery?: "DELIVERED_UNMODIFIED" | "CANCELLED_BY_PRODUCT" | "FAILED";
  expired: boolean;
}
const stages = [
  "real-login-and-initial-mount", "canvas-focus-and-reload", "world-root-boundary",
  "fresh-use-and-persisted-investigation", "delayed-work-response", "offline-and-reconnect",
  "global-logout-expiry-and-sdk-refresh", "canonical-revocation-and-delayed-response",
  "principal-switch-and-delayed-investigation-list", "real-route-coverage",
] as const;
export interface MountedWorkResult {
  status: "PASS" | "FAIL";
  artifactPath: string;
  evidenceDirectory: string;
  failedStage: string | null;
  failureCode: string | null;
}
export class MountedWorkProofError extends Error {
  constructor(readonly result: MountedWorkResult) {
    super(`MOUNTED_WORK_FAILED:${result.failedStage}:${result.failureCode}; evidence=${result.artifactPath}`);
    this.name = "MountedWorkProofError";
  }
}
class Refusal extends Error { constructor(readonly code: string) { super(code); } }
function requireThat(value: unknown, code: string): asserts value { if (!value) throw new Refusal(code); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const panelSelector = "[data-application-work][data-application-session][data-application-status]";
const proxy = "/api/centropy/";
function ownedOrigin(value: string) {
  const url = new URL(value);
  requireThat(["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1"].includes(url.hostname)
    && url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "EXPLICIT_OWNED_LOOPBACK_ORIGIN_REQUIRED");
  return url.origin;
}
function bound(value: number, minimum: number, maximum: number) {
  requireThat(Number.isInteger(value) && value >= minimum && value <= maximum, "FINITE_BUDGET_REQUIRED");
  return value;
}
function validateExpected(expected: ApplicationExpectation) {
  requireThat([expected.tenantId, expected.principalId, expected.workId, expected.root.entityId].every(value => UUID.test(value))
    && expected.root.entityType === "pe_deal"
    && (expected.sessionId === null ? expected.status === null : UUID.test(expected.sessionId) && expected.status !== null),
  "CANONICAL_EXPECTATION_REQUIRED");
}
const sameRoot = (left: ApplicationExpectation["root"], right: ApplicationExpectation["root"]) =>
  left.entityType === right.entityType && left.entityId === right.entityId;
function syntheticJson(value: string): unknown {
  requireThat(value.length <= 65_536
    && !/\bBearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN|wss?:\/\/|devtools:\/\//i.test(value),
  "BOUNDED_NON_SECRET_SYNTHETIC_INPUT_REQUIRED");
  const parsed: unknown = JSON.parse(value);
  const visit = (item: unknown, depth: number) => {
    requireThat(depth <= 16, "SYNTHETIC_INPUT_DEPTH_BOUND");
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      requireThat(!/password|passwd|passphrase|secret|credential|authorization|bearer|api.?key|private.?key|access.?token|refresh.?token|cookie|browser.?handle/i.test(key),
        "NO_CREDENTIAL_FIELDS_IN_EVIDENCE_INPUTS");
      visit(child, depth + 1);
    }
  };
  visit(parsed, 0);
  return parsed;
}
function samePanel(observed: PanelObservation, expected: ApplicationExpectation) {
  return observed.mounted === 1 && observed.workId === expected.workId
    && observed.sessionId === (expected.sessionId ?? "none") && observed.status === (expected.status ?? "none")
    && observed.tenantId === expected.tenantId && observed.principalId === expected.principalId
    && observed.root?.entityType === expected.root.entityType && observed.root.entityId === expected.root.entityId;
}
async function poll<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, milliseconds: number, code: string): Promise<T> {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await read();
    if (accept(value)) return value;
    await sleep(Math.min(75, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Refusal(code);
}
async function bounded<T>(checkpoint: string, milliseconds: number,
  call: (boundary: OracleBoundary) => Promise<T>): Promise<T> {
  const controller = new AbortController(), deadlineAt = Date.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call({ checkpoint, signal: controller.signal, deadlineAt }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Refusal("OWNER_CALLBACK_TIMEOUT")); }, milliseconds);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
function receipt(value: OracleReceipt, source: OracleReceipt["source"]) {
  requireThat(value?.asserted === true && value.source === source && typeof value.reference === "string"
    && value.reference.length > 0 && value.reference.length <= 2_048
    && !/\bBearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(value.reference),
  "INDEPENDENT_OWNER_ASSERTION_RECEIPT_REQUIRED");
  return value;
}
async function observePanel(page: Page): Promise<PanelObservation> {
  return page.evaluate(selector => {
    const nodes = Array.from(document.querySelectorAll(selector)), node = nodes[0];
    const text = node?.textContent ?? "";
    const identity = /Tenant ([0-9a-f-]{36}) · native principal ([0-9a-f-]{36})/i.exec(text);
    const root = /Canonical Work [0-9a-f-]{36} · root ([a-z_]+) \/ ([0-9a-f-]{36})/i.exec(text);
    return {
      mounted: nodes.length, workId: node?.getAttribute("data-application-work") ?? null,
      sessionId: node?.getAttribute("data-application-session") ?? null,
      status: node?.getAttribute("data-application-status") ?? null,
      tenantId: identity?.[1] ?? null, principalId: identity?.[2] ?? null,
      root: root ? { entityType: root[1]!, entityId: root[2]! } : null,
      inputCount: node?.querySelectorAll("input,textarea,select").length ?? 0,
    };
  }, panelSelector);
}

/** An in-page observation only: no product global, fetch, clock or storage is replaced. */
async function watchNonResurrection(page: Page, expected: ApplicationExpectation | null, forbiddenTitles: string[] = []) {
  const key = `__owned_x2_observer_${randomUUID().replaceAll("-", "")}`;
  await page.evaluate(({ key, selector, expected, forbiddenTitles }) => {
    const target = window as unknown as Record<string, unknown>;
    const violations: string[] = [];
    let overflow = false, checks = 0;
    // Object methods avoid compiler name helpers in browser-serialized code.
    const watch = { check() {
      checks++;
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) {
        const work = node.getAttribute("data-application-work"), session = node.getAttribute("data-application-session");
        const status = node.getAttribute("data-application-status");
        const text = node.textContent ?? "";
        if ((work === "none" && (node.querySelector("input,textarea,select")
          || /Canonical Work [0-9a-f-]{36}|Tenant [0-9a-f-]{36}/i.test(text)))
          || (work !== "none" && (!expected || work !== expected.workId
          || session !== (expected.sessionId ?? "none") || status !== (expected.status ?? "none")
          || !text.includes(`native principal ${expected.principalId}`)
          || !text.includes(`Tenant ${expected.tenantId}`)
          || !text.includes(`root ${expected.root.entityType} / ${expected.root.entityId}`)))) {
          if (violations.length < 64) violations.push("OLD_OR_DIFFERENT_APPLICATION_SCOPE");
          else overflow = true;
        }
      }
      const drawer = document.querySelector('dialog[aria-label="Recent Investigations"]');
      if (forbiddenTitles.some(title => Array.from(drawer?.querySelectorAll("strong") ?? []).some(node => node.textContent === title))) {
        if (violations.length < 64) violations.push("PREVIOUS_PRINCIPAL_INVESTIGATION_TITLE");
        else overflow = true;
      }
    } };
    const observer = new MutationObserver(watch.check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    watch.check();
    target[key] = { finish() { watch.check(); observer.disconnect(); return { checks, violations, overflow }; } };
  }, { key, selector: panelSelector, expected, forbiddenTitles });
  return async () => page.evaluate(key => {
    const target = window as unknown as Record<string, { finish: () => { checks: number; violations: string[]; overflow: boolean } }>;
    const result = target[key]!.finish();
    delete target[key];
    return result;
  }, key);
}

/**
 * Exactly one real response is fetched, hashed and held, then fulfilled without
 * changing its status, headers or body. Product aborts are distinguished from delivery.
 */
async function holdResponse(page: Page, auth: AuthenticatedHttpFixture, frontendOrigin: string, input: {
  name: string; path: string; principalId: string; workId?: string; requiredText: string[];
  readMs: number; delayMs: number; evidence: DelayObservation[];
}) {
  const observation: DelayObservation = {
    name: input.name, path: input.path, principalId: input.principalId,
    ...(input.workId ? { workId: input.workId } : {}), expired: false,
  };
  input.evidence.push(observation);
  let claimed = false, captured = false, finished = false, failure: string | null = null;
  let release!: () => void;
  const released = new Promise<void>(yes => { release = yes; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const match = (url: URL) => url.origin === frontendOrigin && url.pathname === input.path;
  const handler = async (route: Route, request: BrowserRequest) => {
    const authorization = await request.headerValue("authorization");
    const identity = authorization?.startsWith("Bearer ") ? auth.private.describeAccessToken(authorization.slice(7)) : null;
    let workId: unknown;
    try { workId = request.postDataJSON()?.workId; } catch { /* A GET has no product payload. */ }
    if (claimed || !identity?.valid || identity.userId !== input.principalId
      || (input.workId && workId !== input.workId)) { await route.fallback(); return; }
    claimed = true;
    let response: APIResponse | undefined;
    let browserResponseSeen = false, browserRequestFinished = false, browserRequestFailed = false;
    const sawResponse = (candidate: BrowserResponse) => { if (candidate.request() === request) browserResponseSeen = true; };
    const sawFinish = (candidate: BrowserRequest) => { if (candidate === request) browserRequestFinished = true; };
    const sawFailure = (candidate: BrowserRequest) => { if (candidate === request) browserRequestFailed = true; };
    page.on("response", sawResponse); page.on("requestfinished", sawFinish); page.on("requestfailed", sawFailure);
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: input.readMs });
      const body = await response.body();
      observation.responseStatus = response.status();
      observation.responseSha256 = createHash("sha256").update(body).digest("hex");
      observation.negativeControlMatched = body.length <= 8 * 1_024 * 1_024
        && input.requiredText.every(text => body.includes(Buffer.from(JSON.stringify(text))));
      requireThat(response.ok() && observation.negativeControlMatched, "DELAY_REAL_RESPONSE_NEGATIVE_CONTROL_FAILED");
      observation.capturedAt = Date.now();
      captured = true;
      timer = setTimeout(() => { observation.expired = true; release(); }, input.delayMs);
      await released;
      if (timer) clearTimeout(timer);
      observation.releasedAt = Date.now();
      let fulfillFailed = false;
      try { await route.fulfill({ response }); }
      catch { fulfillFailed = true; }
      await poll(() => browserRequestFinished || browserRequestFailed, Boolean, input.readMs, "BROWSER_DELAY_DELIVERY_NOT_OBSERVED");
      requireThat(!fulfillFailed || browserRequestFailed, "DELAY_FULFILL_FAILED_WITHOUT_PRODUCT_ABORT");
      requireThat(!browserRequestFailed || /abort|cancel/i.test(request.failure()?.errorText ?? ""),
        "DELAY_REQUEST_FAILED_FOR_NON_ABORT_REASON");
      observation.delivery = browserRequestFinished && browserResponseSeen ? "DELIVERED_UNMODIFIED" : "CANCELLED_BY_PRODUCT";
    } catch (error) {
      failure = error instanceof Refusal ? error.code : "DELAY_REAL_FETCH_FAILED";
      observation.delivery = "FAILED";
      try { await route.abort("failed"); } catch { /* Already aborted by product. */ }
    } finally {
      if (timer) clearTimeout(timer);
      page.off("response", sawResponse); page.off("requestfinished", sawFinish); page.off("requestfailed", sawFailure);
      observation.browserResponseSeen = browserResponseSeen;
      observation.browserRequestFinished = browserRequestFinished;
      observation.browserRequestFailed = browserRequestFailed;
      try { await response?.dispose(); }
      catch { failure ??= "DELAY_RESPONSE_DISPOSE_FAILED"; observation.delivery = "FAILED"; }
      finally { observation.settledAt = Date.now(); finished = true; }
    }
  };
  await page.route(match, handler);
  return {
    observation,
    async captured() {
      await poll(() => ({ captured, failure }), value => value.captured || value.failure !== null, input.readMs, "REAL_RESPONSE_NOT_CAPTURED");
      requireThat(!failure && captured, failure ?? "REAL_RESPONSE_NOT_CAPTURED");
    },
    boundary() { requireThat(captured && !observation.expired, "DELAY_BOUNDARY_NOT_ORDERED"); observation.boundaryAt = Date.now(); },
    async release(requireDelivery = false) {
      requireThat(observation.boundaryAt && !observation.expired, "DELAY_WINDOW_EXPIRED_OR_BOUNDARY_MISSING");
      release();
      await poll(() => finished, Boolean, input.readMs, "DELAY_RELEASE_DID_NOT_SETTLE");
      await page.unroute(match, handler);
      requireThat(!failure && !observation.expired
        && observation.capturedAt! <= observation.boundaryAt! && observation.boundaryAt! <= observation.releasedAt!,
      failure ?? "DELAY_ORDER_NOT_ESTABLISHED");
      if (requireDelivery) requireThat(observation.delivery === "DELIVERED_UNMODIFIED", "LATE_LIST_DELIVERY_NOT_ESTABLISHED");
    },
    async close() {
      release();
      if (timer) clearTimeout(timer);
      await page.unroute(match, handler);
      if (claimed) await poll(() => finished, Boolean, input.readMs, "DELAY_CLEANUP_TIMEOUT");
    },
  };
}

export async function runMountedWork(options: MountedWorkOptions): Promise<MountedWorkResult> {
  const frontendOrigin = ownedOrigin(options.frontendOrigin), apiOrigin = ownedOrigin(options.apiOrigin);
  requireThat(options.contextOwnership === "FRESH_TASK_OWNED_NO_SAVED_AUTH"
    && options.fixtureQualification === "SYNTHETIC_DISPOSABLE_ONLY"
    && options.apiWorkerRuntime === "EMITTED_PRODUCTION_NODE"
    && options.auth.frontendOrigin === frontendOrigin && options.context.pages().length === 0
    && options.context.serviceWorkers().length === 0, "FRESH_OWNED_CONTEXT_AND_REAL_RUNTIME_REQUIRED");
  requireThat(options.frontendMode !== "production" || options.auth.origin.startsWith("https:"), "PRODUCTION_REQUIRES_TRUSTED_HTTPS_AUTH");
  const readMs = bound(options.budgets?.readMs ?? 25_000, 5_000, 60_000);
  const settleMs = bound(options.budgets?.settleMs ?? 180_000, 5_000, 600_000);
  const delayMs = bound(options.budgets?.delayMs ?? 18_000, 1_000, 18_000);
  const negativeWindowMs = bound(options.budgets?.negativeWindowMs ?? 1_000, 250, 5_000);
  for (const item of [options.acquisition, options.fresh, options.otherPrincipal]) {
    validateExpected(item.expected);
    requireThat(UUID.test(item.threadId) && item.title.trim() === item.title && item.title.length >= 8
      && item.title.length <= 200, "PERSISTED_SYNTHETIC_INVESTIGATION_REQUIRED");
  }
  requireThat(new Set([options.acquisition.threadId, options.fresh.threadId, options.otherPrincipal.threadId]).size === 3
    && new Set([options.acquisition.title, options.fresh.title, options.otherPrincipal.title]).size === 3
    && options.acquisition.expected.workId !== options.fresh.expected.workId
    && options.acquisition.expected.principalId === options.fresh.expected.principalId
    && options.acquisition.expected.principalId !== options.otherPrincipal.expected.principalId
    && options.fresh.expected.sessionId === null && options.fresh.expected.status === null,
  "DISTINCT_PERSISTED_SCOPES_AND_EMPTY_FRESH_WORK_REQUIRED");
  requireThat(options.acquisition.expected.tenantId === options.fresh.expected.tenantId
    && sameRoot(options.acquisition.expected.root, options.fresh.expected.root),
  "SAME_CANONICAL_DEAL_AND_TENANT_REQUIRED");
  requireThat(options.acquisition.expected.sessionId === null
    ? Boolean(options.acquire && options.settleAcquisition) : !options.acquire, "ACQUISITION_PLAN_MUST_MATCH_EMPTY_OR_PREACQUIRED_WORK");
  requireThat(UUID.test(options.freshUse.executionProfileId) && options.freshUse.targetId.length > 0
    && options.freshUse.targetId.length <= 256, "EXPLICIT_FRESH_USE_BINDING_REQUIRED");
  for (const value of [options.freshUse.goalJson, options.freshUse.parametersJson]) {
    const parsed = syntheticJson(value);
    requireThat(parsed && typeof parsed === "object" && !Array.isArray(parsed), "STRICT_FORM_JSON_OBJECT_REQUIRED");
  }
  syntheticJson(JSON.stringify(options.freshUse.businessExpectation));
  if (options.acquire) for (const value of [options.acquire.profileIdsJson, options.acquire.targetsJson, options.acquire.resourceDemandJson]) syntheticJson(value);
  requireThat([options.evidence.ownedWorkspaceDirectory, options.evidence.evidenceDirectory,
    options.evidence.seedReceiptPath, options.evidence.runtimeReceiptPath, options.evidence.driverPath].every(isAbsolute),
  "ABSOLUTE_CALLER_OWNED_EVIDENCE_PATHS_REQUIRED");
  const workspace = await realpath(options.evidence.ownedWorkspaceDirectory);
  const evidenceParent = await realpath(options.evidence.evidenceDirectory);
  const distance = relative(workspace, evidenceParent);
  requireThat(distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance), "EVIDENCE_OUTSIDE_OWNED_WORKSPACE");
  const evidenceDirectory = join(evidenceParent, `mounted-work-${randomUUID()}`);
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const artifactPath = join(evidenceDirectory, "result.json");
  const records = stages.map(name => ({ name, status: "NOT_RUN" as "NOT_RUN" | "PASS" | "FAIL",
    startedAt: null as string | null, finishedAt: null as string | null }));
  const network: NetworkObservation[] = [], delays: DelayObservation[] = [], screenshots: string[] = [];
  const assertions: Array<{ checkpoint: string; receipt: OracleReceipt }> = [];
  const panelReads: Array<{ checkpoint: string; observed: PanelObservation }> = [];
  const boundaries: Array<{ name: string; detail: unknown }> = [];
  const gates: Array<Awaited<ReturnType<typeof holdResponse>>> = [];
  const auxiliaryPages: Page[] = [];
  let networkSequence = 0, networkOverflow = false, failedStage: string | null = null, failureCode: string | null = null;
  let page: Page | undefined, revocationRequested = false, restoreConfirmed = false, pageClosed = false;
  let primary = { ...options.acquisition.expected }, fresh = { ...options.fresh.expected };
  let actorSession: AuthSessionHandle | null = null;
  const actor = primary.principalId, other = options.otherPrincipal.expected.principalId;
  const counts = () => ({
    acquisition: network.filter(item => item.method === "POST" && item.path === `${proxy}company-brain/application-acquire`).length,
    execution: network.filter(item => item.method === "POST" && item.path === `${proxy}company-brain/application-execute`).length,
    cancellation: network.filter(item => item.method === "POST" && item.path === `${proxy}company-brain/application-cancel`).length,
  });
  const canonical = async (checkpoint: string, expected: ApplicationExpectation | null, canvasFocusedBlockId?: string) => {
    const observed = expected ? await poll(() => observePanel(page!), value => samePanel(value, expected), readMs, "CANONICAL_MOUNT_MISMATCH")
      : await observePanel(page!);
    if (!expected) requireThat(observed.mounted === 0 || (observed.mounted === 1 && observed.workId === "none"
      && observed.sessionId === "none" && observed.status === "none" && observed.inputCount === 0), "PRIVATE_CANONICAL_BOUNDARY_NOT_ERASED");
    panelReads.push({ checkpoint, observed });
    const result = await bounded(checkpoint, readMs, boundary => options.assertCanonical({
      ...boundary, expected, observed, mutationCounts: counts(), ...(canvasFocusedBlockId ? { canvasFocusedBlockId } : {}),
    }));
    assertions.push({ checkpoint, receipt: receipt(result, "CANONICAL_SQL") });
  };
  const business = async (checkpoint: string) => {
    const result = await bounded(checkpoint, settleMs, boundary => options.assertBusiness({
      ...boundary, expected: options.freshUse.businessExpectation, work: fresh,
    }));
    assertions.push({ checkpoint, receipt: receipt(result, "INDEPENDENT_EXTERNAL_STATE") });
  };
  const waitAuth = async (after: number, predicate: (event: AuthObservation) => boolean, budget = readMs) => {
    const matching = await poll(() => options.auth.observations(after).find(predicate) ?? null, Boolean, budget, "REAL_AUTH_TRANSITION_NOT_OBSERVED");
    requireThat(matching, "REAL_AUTH_TRANSITION_NOT_OBSERVED");
    return matching;
  };
  const expectPanel = async (expected: ApplicationExpectation, checkpoint: string) => {
    await canonical(checkpoint, expected);
  };
  const erased = async (checkpoint: string) => {
    const observed = await poll(() => observePanel(page!), value => value.mounted === 0
      || (value.mounted === 1 && value.workId === "none" && value.sessionId === "none"
        && value.status === "none" && value.inputCount === 0), readMs, "PRIVATE_EVIDENCE_OR_INPUTS_RETAINED");
    panelReads.push({ checkpoint, observed });
  };
  const signIn = async (principalId: string, target: Page = page!) => {
    const credentials = options.auth.private.credentials(principalId), after = options.auth.cursor();
    await target.goto(`${frontendOrigin}/centropy/login`, { waitUntil: "domcontentloaded" });
    await target.getByLabel("Email", { exact: true }).fill(credentials.email);
    await target.getByLabel("Password", { exact: true }).fill(credentials.password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    const event = await waitAuth(after, item => item.event === "password" && item.status === 200
      && item.userId === principalId && item.caller === "BROWSER");
    requireThat(event.issueId, "PASSWORD_LOGIN_ISSUANCE_REQUIRED");
    await target.waitForURL(url => url.pathname === "/centropy", { timeout: readMs });
    await target.getByLabel("Account menu", { exact: true }).waitFor({ state: "visible", timeout: readMs });
    return options.auth.private.sessionForIssue(event.issueId);
  };
  const signOut = async (principalId: string) => {
    const after = options.auth.cursor();
    await page!.getByLabel("Account menu", { exact: true }).click();
    await page!.getByRole("button", { name: "Sign out", exact: true }).click();
    await waitAuth(after, item => item.event === "logout" && item.status === 204
      && item.userId === principalId && item.caller === "BROWSER");
    await page!.getByRole("heading", { name: "Your investment context stays private.", exact: true }).waitFor({ state: "visible", timeout: readMs });
    await erased("signed-out");
  };
  const openInvestigation = async (view: PreparedInvestigation) => {
    await page!.getByRole("button", { name: "Investigations", exact: true }).click();
    const drawer = page!.getByRole("dialog", { name: "Recent Investigations", exact: true });
    await drawer.getByText(view.title, { exact: true }).click();
    await page!.waitForURL(url => url.pathname === `/centropy/investigations/${view.threadId}`, { timeout: readMs });
    await page!.getByRole("main", { name: "Investigation Canvas", exact: true }).waitFor({ state: "visible", timeout: readMs });
  };
  const screenshot = async (name: string) => {
    const path = join(evidenceDirectory, `${name}.png`);
    await page!.screenshot({ path, type: "png", fullPage: false,
      mask: [page!.locator('input[type="password"],input[type="email"]')] });
    await chmod(path, 0o600);
    screenshots.push(path);
  };
  const stable = async (finish: Awaited<ReturnType<typeof watchNonResurrection>>, name: string) => {
    // Finite negative observation window, not a readiness sleep or universal absence claim.
    await sleep(negativeWindowMs);
    const observed = await finish();
    boundaries.push({ name, detail: { ...observed, negativeWindowMs } });
    requireThat(!observed.overflow && observed.violations.length === 0, "PRIVATE_RESPONSE_RESURRECTION");
  };
  const newGate = async (name: string, path: string, principalId: string, requiredText: string[], workId?: string) => {
    const gate = await holdResponse(page!, options.auth, frontendOrigin, {
      name, path: `${proxy}${path}`, principalId, requiredText, ...(workId ? { workId } : {}),
      readMs, delayMs, evidence: delays,
    });
    gates.push(gate);
    return gate;
  };
  const step = async (name: typeof stages[number], action: () => Promise<void>) => {
    const record = records.find(item => item.name === name)!;
    record.startedAt = new Date().toISOString();
    try { await action(); record.status = "PASS"; }
    catch (error) {
      record.status = "FAIL"; failedStage = name;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      failureCode = error instanceof Refusal ? error.code
        : /^[0-9A-Z]{5}$/.test(code) ? `OWNER_DATABASE_${code}`
          : error instanceof Error && error.name === "TimeoutError" ? "BROWSER_ACTION_TIMEOUT"
            : "LIVE_ACTION_OR_OWNER_ASSERTION_FAILED";
      throw new Refusal(failureCode);
    } finally { record.finishedAt = new Date().toISOString(); }
  };

  const preparePage = async (target: Page) => {
    target.setDefaultTimeout(readMs); target.setDefaultNavigationTimeout(readMs);
    await target.setViewportSize({ width: 1440, height: 1_000 });
    const allowedOrigins = new Set([frontendOrigin, apiOrigin, options.auth.origin]);
    await target.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (["http:", "https:"].includes(url.protocol) && !allowedOrigins.has(url.origin)) { await route.abort("blockedbyclient"); return; }
      await route.fallback();
    });
  };
  try {
    page = await options.context.newPage();
    await preparePage(page);
    page.on("response", response => {
      const request = response.request(), url = new URL(response.url());
      if (url.origin !== frontendOrigin || !url.pathname.startsWith(proxy)) return;
      if (network.length >= 10_000) { networkOverflow = true; return; }
      const authorization = request.headers().authorization;
      const identity = authorization?.startsWith("Bearer ") ? options.auth.private.describeAccessToken(authorization.slice(7)) : null;
      network.push({ sequence: ++networkSequence, at: new Date().toISOString(), method: request.method(),
        path: url.pathname, status: response.status(), principalId: identity?.userId ?? null,
        issueId: identity?.issueId ?? null, signedLiveBearer: identity?.valid ?? false });
    });
    await step("real-login-and-initial-mount", async () => {
      const credentials = options.auth.private.credentials(actor), after = options.auth.cursor();
      await page!.goto(`${frontendOrigin}/centropy/login`, { waitUntil: "domcontentloaded" });
      await page!.getByLabel("Email", { exact: true }).fill(credentials.email);
      await page!.getByLabel("Password", { exact: true }).fill(`${credentials.password}-intentionally-wrong`);
      await page!.getByRole("button", { name: "Sign in", exact: true }).click();
      await waitAuth(after, item => item.event === "password" && item.status === 400 && item.reason === "invalid_credentials");
      await page!.getByText("Invalid login credentials", { exact: true }).waitFor({ state: "visible" });
      await erased("incorrect-password");
      actorSession = await signIn(actor);
      await openInvestigation(options.acquisition);
      await expectPanel(primary, "initial-canonical-mount");
      if (primary.sessionId === null) {
        requireThat(options.acquire && options.settleAcquisition, "ACQUISITION_FORM_AND_CANONICAL_SETTLER_REQUIRED");
        const panel = page!.locator(panelSelector);
        await panel.getByLabel("Existing discovery-profile UUIDs — JSON array, 1–8 distinct references", { exact: true }).fill(options.acquire.profileIdsJson);
        await panel.getByLabel("Authorized discovery targets — JSON array, 2–16 distinct identities", { exact: true }).fill(options.acquire.targetsJson);
        await panel.getByLabel("Original resource demand — JSON array, 1–2 resource bindings", { exact: true }).fill(options.acquire.resourceDemandJson);
        await panel.getByLabel("Original deadline — ISO timestamp with explicit time-zone offset", { exact: true }).fill(options.acquire.deadlineAt);
        await panel.getByRole("button", { name: "Request acquisition and native reservation", exact: true }).click();
        const settled = await bounded("settle-ui-acquisition", settleMs, boundary => options.settleAcquisition!({ ...boundary, workId: primary.workId }));
        validateExpected(settled);
        requireThat(settled.workId === primary.workId && settled.principalId === actor
          && settled.tenantId === primary.tenantId && sameRoot(settled.root, primary.root),
        "ACQUISITION_SETTLER_CHANGED_SCOPE");
        primary = settled;
        await expectPanel(primary, "ui-acquisition-canonical-settled");
      }
      requireThat(primary.sessionId && primary.status === "MODEL_READY", "USABLE_CANONICAL_ACQUISITION_PARENT_REQUIRED");
      await screenshot("01-maintained-acquisition");
    });
    await step("canvas-focus-and-reload", async () => {
      const focus = page!.getByRole("button", { name: "Focus Work and verification", exact: true });
      await poll(() => focus.isEnabled(), Boolean, readMs, "CANVAS_FOCUS_NOT_READY");
      const save = async () => {
        await Promise.all([
          page!.waitForResponse(response => new URL(response.url()).pathname === `${proxy}threads/${options.acquisition.threadId}/canvas`
            && response.request().method() === "PUT" && response.ok()),
          page!.getByRole("button", { name: "Save order and focus", exact: true }).click(),
        ]);
        await poll(() => focus.isEnabled(), Boolean, readMs, "CANVAS_FOCUS_SAVE_NOT_SETTLED");
      };
      if (await focus.getAttribute("aria-pressed") === "true") { await focus.click(); await save(); }
      await focus.click();
      await save();
      await canonical("saved-canvas-focus", primary, `work:${primary.workId}`);
      await page!.reload({ waitUntil: "domcontentloaded" });
      await expectPanel(primary, "real-reload-persisted-acquisition");
      await poll(() => focus.getAttribute("aria-pressed"), value => value === "true", readMs, "CANVAS_FOCUS_NOT_PERSISTED");
      await canonical("reloaded-canvas-focus", primary, `work:${primary.workId}`);
    });
    await step("world-root-boundary", async () => {
      await page!.getByRole("button", { name: "Open WORLD", exact: true }).click();
      await page!.getByRole("main", { name: "WORLD explorer", exact: true }).waitFor({ state: "visible" });
      await page!.getByRole("button", { name: "Clear selected context", exact: true }).click();
      await page!.waitForURL(url => url.pathname === "/centropy/world" && url.searchParams.get("context") === "none");
      await page!.getByRole("button", { name: "Open Canvas", exact: true }).click();
      await page!.waitForURL(url => url.pathname === `/centropy/investigations/${options.acquisition.threadId}`
        && url.searchParams.get("context") === "none");
      await page!.getByRole("main", { name: "Investigation Canvas", exact: true }).waitFor({ state: "visible" });
      await page!.getByRole("button", { name: "Focus Work and verification", exact: true }).waitFor({ state: "visible" });
      await poll(() => observePanel(page!), value => value.mounted === 0, readMs, "ROOTLESS_CANVAS_RETAINED_APPLICATION_PANEL");
      await stable(await watchNonResurrection(page!, null), "explicit-no-root-canvas");
      await canonical("explicit-rootless-canvas", null);
      await page!.getByRole("button", { name: "Open WORLD", exact: true }).click();
      await page!.getByLabel("Choose WORLD root", { exact: true }).selectOption(`${primary.root.entityType}:${primary.root.entityId}`);
      await page!.waitForURL(url => {
        try { return url.pathname === "/centropy/world" && sameRoot(JSON.parse(url.searchParams.get("root") ?? "null"), primary.root); }
        catch { return false; }
      });
      await page!.getByRole("button", { name: "Open Canvas", exact: true }).click();
      await expectPanel(primary, "restored-canonical-world-root");
      boundaries.push({ name: "root-switch", detail: "CANONICAL_DEAL_TO_EXPLICIT_NONE_TO_SAME_CANONICAL_DEAL" });
    });
    await step("fresh-use-and-persisted-investigation", async () => {
      await openInvestigation(options.fresh);
      await expectPanel(fresh, "fresh-work-empty-before-submission");
      await openInvestigation(options.acquisition);
      await expectPanel(primary, "acquisition-before-fresh-form");
      const panel = page!.locator(panelSelector), before = counts().execution;
      await panel.getByLabel("Existing fresh Work UUID — different from acquisition Work", { exact: true }).fill(fresh.workId);
      await panel.getByLabel("Existing execution-profile UUID (reference only)", { exact: true }).fill(options.freshUse.executionProfileId);
      await panel.getByLabel("Current authorized target identifier", { exact: true }).fill(options.freshUse.targetId);
      await panel.getByLabel("Goal — strict application-state JSON", { exact: true }).fill(options.freshUse.goalJson);
      await panel.getByRole("textbox", { name: "Parameters — strict application-state JSON", exact: true }).fill(options.freshUse.parametersJson);
      await panel.getByRole("button", { name: "Request fresh use and native checks", exact: true }).click();
      const settled = await bounded("settle-ui-fresh-use", settleMs, boundary => options.settleFreshUse({
        ...boundary, workId: fresh.workId, parentSessionId: primary.sessionId!,
      }));
      validateExpected(settled);
      requireThat(settled.workId === fresh.workId && settled.principalId === actor && settled.sessionId
        && settled.tenantId === primary.tenantId && sameRoot(settled.root, primary.root),
      "FRESH_USE_SETTLER_CHANGED_SCOPE");
      fresh = settled;
      await page!.getByRole("button", {
        name: `Open recorded fresh Work · ${fresh.workId} — outcome still requires independent evidence`, exact: true,
      }).click();
      await expectPanel(fresh, "in-memory-fresh-work-callback");
      await business("fresh-use-independent-business-outcome");
      await openInvestigation(options.fresh);
      await expectPanel(fresh, "separately-persisted-fresh-investigation");
      await page!.reload({ waitUntil: "domcontentloaded" });
      await expectPanel(fresh, "real-reload-persisted-fresh-work");
      requireThat(counts().execution === before + 1, "FRESH_USE_REPLAY_OR_NO_REAL_MUTATION");
      await business("fresh-reload-no-business-replay");
      boundaries.push({ name: "fresh-selection-persistence", detail: "CALLBACK_IN_MEMORY_ONLY; RELOAD_USES_SEPARATELY_PERSISTED_FRESH_INVESTIGATION" });
      await screenshot("02-maintained-fresh-result");
    });
    await step("delayed-work-response", async () => {
      await openInvestigation(options.acquisition);
      await expectPanel(primary, "source-before-delayed-work-read");
      const gate = await newGate("old-work-application-projection", "company-brain/application-projection", actor,
        [primary.workId, primary.sessionId!], primary.workId);
      await page!.getByRole("button", { name: "Refresh current scope", exact: true }).click();
      await gate.captured();
      await openInvestigation(options.fresh);
      await expectPanel(fresh, "destination-before-old-work-release");
      const finish = await watchNonResurrection(page!, fresh);
      gate.boundary(); await gate.release();
      await stable(finish, "work-switch-delayed-response");
      await expectPanel(fresh, "destination-after-old-work-release");
    });
    await step("offline-and-reconnect", async () => {
      await openInvestigation(options.acquisition);
      await expectPanel(primary, "before-real-offline");
      await page!.locator(panelSelector).getByLabel("Current authorized target identifier", { exact: true }).fill(`disposable-offline-${randomUUID()}`);
      await options.context.setOffline(true);
      await erased("real-offline-cleared-evidence-and-inputs");
      const finish = await watchNonResurrection(page!, null);
      await stable(finish, "offline-private-evidence");
      await screenshot("03-offline-cleared");
      const after = networkSequence;
      await options.context.setOffline(false);
      await expectPanel(primary, "reconnect-canonical-revalidation");
      requireThat(network.some(item => item.sequence > after && item.path === `${proxy}company-brain/application-projection`
        && item.status === 200 && item.principalId === actor && item.signedLiveBearer), "RECONNECT_DID_NOT_READ_REAL_CANONICAL_SCOPE");
      requireThat(await page!.locator(panelSelector).getByLabel("Current authorized target identifier", { exact: true }).inputValue() === "",
        "OFFLINE_PRIVATE_FORM_VALUE_RESTORED");
    });
    await step("global-logout-expiry-and-sdk-refresh", async () => {
      const latest = options.auth.observations().filter(item => item.userId === actor && item.status === 200
        && item.caller === "BROWSER" && ["password", "refresh"].includes(item.event) && item.issueId).at(-1);
      requireThat(latest?.issueId, "CURRENT_BROWSER_SESSION_ISSUANCE_REQUIRED");
      const old = options.auth.private.sessionForIssue(latest.issueId);
      requireThat((await options.auth.private.probeUser(old)).status === 200, "LOGOUT_NEGATIVE_CONTROL_SESSION_NOT_LIVE");
      await signOut(actor);
      const revoked = await options.auth.private.probeUser(old);
      requireThat(revoked.status === 401 && revoked.code === "session_not_found", "GLOBAL_LOGOUT_DID_NOT_REVOKE_OLD_LIVE_SESSION");
      options.auth.private.nextPasswordAccessLifetime(actor, 5);
      const after = options.auth.cursor();
      const short = await signIn(actor);
      requireThat(short.sessionRef !== old.sessionRef && short.issueId !== old.issueId, "PASSWORD_RELOGIN_REUSED_LOGGED_OUT_SESSION");
      await sleep(Math.max(0, short.expiresAt * 1_000 - Date.now() + 100));
      const expired = await options.auth.private.probeUser(short);
      requireThat(expired.status === 401 && expired.code === "bad_jwt", "REAL_ACCESS_TOKEN_EXPIRY_NOT_ESTABLISHED");
      await page!.reload({ waitUntil: "domcontentloaded" });
      const refreshed = await waitAuth(after, item => item.event === "refresh" && item.status === 200
        && item.userId === actor && item.sessionRef === short.sessionRef && item.refreshOnly === true
        && item.caller === "BROWSER" && typeof item.generation === "number" && item.generation > short.generation);
      requireThat(refreshed.issueId && refreshed.issueId !== short.issueId, "SDK_REFRESH_DID_NOT_ISSUE_DISTINCT_SIGNED_ACCESS");
      actorSession = options.auth.private.sessionForIssue(refreshed.issueId);
      const afterRefresh = networkSequence;
      await openInvestigation(options.acquisition);
      await expectPanel(primary, "canonical-mount-after-real-sdk-refresh");
      requireThat(network.some(item => item.sequence > afterRefresh && item.issueId === actorSession!.issueId
        && item.signedLiveBearer && item.status === 200), "REAL_API_DID_NOT_USE_REFRESHED_SIGNED_ACCESS");
      boundaries.push({ name: "real-token-expiry-and-refresh", detail: {
        loggedOutIssueId: old.issueId, loggedOutUserStatus: revoked.status, loggedOutReason: revoked.code,
        passwordIssueId: short.issueId, expiredAt: short.expiresAt, expiredUserStatus: expired.status,
        refreshedIssueId: actorSession.issueId, generation: actorSession.generation,
        mechanism: "REAL_SDK_AUTO_REFRESH_OR_RELOAD_GET_SESSION; NO_CLOCK_OR_STORAGE_MUTATION",
      } });
    });
    await step("canonical-revocation-and-delayed-response", async () => {
      await expectPanel(primary, "before-native-access-revocation");
      const gate = await newGate("pre-revocation-application-projection", "company-brain/application-projection", actor,
        [primary.workId, primary.sessionId!], primary.workId);
      await page!.getByRole("button", { name: "Refresh current scope", exact: true }).click();
      await gate.captured();
      revocationRequested = true;
      const revoked = await bounded("revoke-real-native-principal", readMs, boundary => options.setPrincipalRevoked({
        ...boundary, principalId: actor, revoked: true,
      }));
      assertions.push({ checkpoint: "revoke-real-native-principal", receipt: receipt(revoked, "CANONICAL_SQL") });
      requireThat((await options.auth.private.probeUser(actorSession!)).status === 200,
        "REVOCATION_NEGATIVE_CONTROL_AUTH_SESSION_NOT_LIVE");
      const after = networkSequence;
      await page!.getByRole("button", { name: "Refresh current scope", exact: true }).click();
      await poll(() => network.some(item => item.sequence > after && item.path === `${proxy}me`
        && item.principalId === actor && [401, 403].includes(item.status)), Boolean, readMs, "NATIVE_REVOKED_ME_NOT_DENIED");
      await erased("native-revocation-cleared-private-evidence");
      const finish = await watchNonResurrection(page!, null);
      gate.boundary(); await gate.release();
      await stable(finish, "revoked-scope-delayed-response");
      await canonical("revoked-principal-no-private-projection", null);
      await business("revocation-and-late-read-no-new-business-effect");
      await screenshot("04-native-access-revoked");
      const restored = await bounded("restore-real-native-principal", readMs, boundary => options.setPrincipalRevoked({
        ...boundary, principalId: actor, revoked: false,
      }));
      assertions.push({ checkpoint: "restore-real-native-principal", receipt: receipt(restored, "CANONICAL_SQL") });
      restoreConfirmed = true;
      await page!.getByRole("button", { name: "Refresh current scope", exact: true }).click();
      await expectPanel(primary, "native-access-restored-through-real-api");
    });
    await step("principal-switch-and-delayed-investigation-list", async () => {
      await signOut(actor);
      const gate = await newGate("old-principal-recent-investigations", "threads", actor,
        [options.acquisition.threadId, options.acquisition.title]);
      // A login-route navigation unmounts CentropyWorkspace. Use the actual login
      // form in an owned second tab: SDK BroadcastChannel/storage events change
      // the first tab's principal without destroying its pending recent-list read.
      const loginPage = await options.context.newPage();
      auxiliaryPages.push(loginPage);
      await preparePage(loginPage);
      actorSession = await signIn(actor, loginPage);
      await page!.bringToFront();
      await page!.getByLabel("Account menu", { exact: true }).waitFor({ state: "visible" });
      await gate.captured();
      await signOut(actor);
      const forbidden = [options.acquisition.title, options.fresh.title];
      const transitionFinish = await watchNonResurrection(page!, options.otherPrincipal.expected, forbidden);
      const otherSession = await signIn(other, loginPage);
      await page!.bringToFront();
      await page!.getByLabel("Account menu", { exact: true }).waitFor({ state: "visible" });
      requireThat(otherSession.userId !== actorSession.userId && otherSession.sessionRef !== actorSession.sessionRef,
        "PRINCIPAL_SWITCH_REUSED_OLD_SESSION");
      await openInvestigation(options.otherPrincipal);
      await expectPanel(options.otherPrincipal.expected, "second-principal-own-canonical-canvas");
      await page!.getByRole("button", { name: "Investigations", exact: true }).click();
      const drawer = page!.getByRole("dialog", { name: "Recent Investigations", exact: true });
      await drawer.getByText(options.otherPrincipal.title, { exact: true }).waitFor({ state: "visible" });
      for (const title of forbidden) requireThat(await drawer.getByText(title, { exact: true }).count() === 0,
        "PREVIOUS_PRINCIPAL_LIST_ALREADY_RETAINED");
      const transition = await transitionFinish();
      boundaries.push({ name: "same-mounted-workspace-principal-transition", detail: transition });
      const finish = await watchNonResurrection(page!, options.otherPrincipal.expected, forbidden);
      gate.boundary(); await gate.release(true);
      await stable(finish, "principal-switch-delivered-old-list");
      requireThat(!transition.overflow && transition.violations.length === 0, "PRIVATE_DATA_RETAINED_DURING_PRINCIPAL_TRANSITION");
      await drawer.getByText(options.otherPrincipal.title, { exact: true }).waitFor({ state: "visible" });
      for (const title of forbidden) requireThat(await drawer.getByText(title, { exact: true }).count() === 0,
        "DELAYED_PREVIOUS_PRINCIPAL_LIST_RESURRECTED");
      await page!.getByRole("button", { name: "Close Investigations", exact: true }).click();
      await expectPanel(options.otherPrincipal.expected, "second-principal-after-old-list-delivery");
      await screenshot("05-second-principal");
    });
    await step("real-route-coverage", async () => {
      const required = [
        ["GET", "me"], ["GET", "threads"], ["GET", `threads/${options.acquisition.threadId}`],
        ["GET", `threads/${options.acquisition.threadId}/canvas`], ["PUT", `threads/${options.acquisition.threadId}/canvas`],
        ["GET", `threads/${options.fresh.threadId}`], ["GET", `works/${primary.workId}`], ["GET", `works/${fresh.workId}`],
        ["POST", "company-brain/roots"], ["POST", "company-brain/projection"],
        ["POST", "company-brain/application-projection"], ["POST", "company-brain/application-execute"], ["GET", "user-prefs"],
      ];
      for (const [method, path] of required) requireThat(network.some(item => item.method === method
        && item.path === `${proxy}${path}` && item.status >= 200 && item.status < 300 && item.signedLiveBearer),
      `REAL_ROUTE_NOT_OBSERVED:${method}:${path}`);
      requireThat(options.auth.observations().some(item => item.event === "user" && item.status === 200
        && item.userId === actor && item.caller === "BACKEND_SDK" && item.sdkVersion === "2.115.0")
        && options.auth.observations().some(item => item.event === "user" && item.status === 200
          && item.userId === other && item.caller === "BACKEND_SDK" && item.sdkVersion === "2.115.0"),
      "BACKEND_HS256_USER_VERIFICATION_NOT_OBSERVED_FOR_BOTH_PRINCIPALS");
      requireThat(counts().execution === 1 && counts().acquisition === (options.acquire ? 1 : 0)
        && counts().cancellation === 0 && !networkOverflow && !options.auth.summary().overflow, "MUTATION_REPLAY_OR_OBSERVATION_OVERFLOW");
      await canonical("final-second-principal-canonical-state", options.otherPrincipal.expected);
      await business("final-independent-business-state-no-replay");
    });
  } catch {
    failedStage ??= "setup-or-cleanup";
    failureCode ??= "LIVE_ACTION_OR_OWNER_ASSERTION_FAILED";
    if (page && !page.isClosed()) { try { await screenshot("failure-masked"); } catch { /* Failure artifact still records missing screenshot. */ } }
  } finally {
    for (const gate of gates) {
      try { await gate.close(); }
      catch { failedStage ??= "setup-or-cleanup"; failureCode ??= "DELAY_CLEANUP_FAILED"; }
    }
    if (revocationRequested && !restoreConfirmed) {
      try {
        const restored = await bounded("finally-restore-native-principal", readMs, boundary => options.setPrincipalRevoked({
          ...boundary, principalId: actor, revoked: false,
        }));
        assertions.push({ checkpoint: "finally-restore-native-principal", receipt: receipt(restored, "CANONICAL_SQL") });
        restoreConfirmed = true;
      } catch { failedStage ??= "setup-or-cleanup"; failureCode = "CANONICAL_REVOCATION_RESTORE_FAILED_MAIN_MUST_RESTORE"; }
    }
    try { await options.context.setOffline(false); } catch { failedStage ??= "setup-or-cleanup"; failureCode ??= "OWNED_CONTEXT_RECONNECT_CLEANUP_FAILED"; }
    for (const auxiliary of auxiliaryPages) {
      try { await auxiliary.close(); }
      catch { failedStage ??= "setup-or-cleanup"; failureCode ??= "OWNED_AUXILIARY_PAGE_CLOSE_FAILED"; }
    }
    if (page) {
      try { await page.close(); pageClosed = true; }
      catch { failedStage ??= "setup-or-cleanup"; failureCode ??= "OWNED_PAGE_CLOSE_FAILED"; }
    }
  }
  const result: MountedWorkResult = { status: failedStage ? "FAIL" : "PASS", artifactPath, evidenceDirectory, failedStage, failureCode };
  await writeFile(artifactPath, JSON.stringify({
    schema: "finnor.x2.maintained-mounted-work.v1", ...result,
    qualification: {
      fixture: "SIGNED_DISPOSABLE_GOTRUE_COMPATIBLE_NOT_HOSTED_SUPABASE",
      ui: "ACTUAL_MAINTAINED_CENTROPY_INVESTIGATION_CANVAS",
      frontendMode: options.frontendMode, apiWorkerRuntime: options.apiWorkerRuntime,
      rootSwitch: "DEAL_TO_EXPLICIT_NONE_AND_BACK_NOT_TWO_DISTINCT_DEALS",
      finiteNegativeWindowMs: negativeWindowMs,
      claim: "ONLY_PASS_STAGES_EXECUTED; NOT_RUN_IS_NOT_PROOF; CALLBACKS_OWN_SQL_AND_EXTERNAL_TRUTH",
    },
    rerun: options.evidence, origins: { frontendOrigin, apiOrigin, authOrigin: options.auth.origin },
    budgets: { readMs, settleMs, delayMs, negativeWindowMs },
    inputs: {
      acquisition: options.acquisition, freshBefore: options.fresh, otherPrincipal: options.otherPrincipal,
      freshUse: options.freshUse, acquire: options.acquire ?? null,
    },
    settled: { acquisition: primary, fresh }, stages: records, assertions, panelReads, network, delays, boundaries, screenshots,
    authentication: { summary: options.auth.summary(), observations: options.auth.observations() },
    cleanup: { revocationRequested, restoreConfirmed, pageClosed,
      auxiliaryPagesClosed: auxiliaryPages.every(item => item.isClosed()), callerStillOwnsContextAndStack: true },
  }, null, 2), { mode: 0o600, flag: "wx" });
  if (result.status !== "PASS") throw new MountedWorkProofError(result);
  return result;
}
