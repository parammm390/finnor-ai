/** Integrates the separately specified browser proof with real native owners. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pg from "pg";
import { attachWorkEntity, createEmployeeConversationThread, receiveWork, updateEmployeeConversationThreadContext } from "@finnor/db";
import { runMountedWork, type ApplicationExpectation, type PreparedInvestigation } from "./mounted-work.mts";
import type { AuthenticatedHttpFixture } from "./authenticated-http-fixture.mts";

export interface MountedNativeInput {
  runtimeRoot: string; evidenceDirectory: string; privateDirectory: string;
  frontendOrigin: string; apiOrigin: string; auth: AuthenticatedHttpFixture;
  sql: pg.Client; tenantId: string; actorId: string; otherId: string;
  root: { entityType: "pe_deal"; entityId: string };
  acquisitionWorkId: string; acquisitionSessionId: string; freshWorkId: string;
  executionProfileId: string; targetId: string;
  goal: Record<string, unknown>; parameters: Record<string, unknown>;
  businessExpectation: Record<string, unknown>;
  settleFresh(sessionId: string, signal: AbortSignal): Promise<void>;
  assertBusiness(checkpoint: string, signal: AbortSignal): Promise<string>;
}
export async function runMountedNativeIntegration(input: MountedNativeInput) {
  const directory = join(input.privateDirectory, "maintained-frontend");
  await mkdir(directory, { mode: 0o700 });
  const owners = (await input.sql.query("SELECT id,status,role FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [input.tenantId, [input.actorId, input.otherId]])).rows;
  assert.equal(owners.length, 2);
  assert(owners.every(row => row.status === "active" && row.role === "owner"), "TWO_REAL_ACTIVE_CANONICAL_OWNERS_REQUIRED");
  const otherWork = await receiveWork({ tenantId: input.tenantId, userId: input.otherId,
    instruction: "Inspect my own empty disposable Work without the other principal's application records.",
    channel: "console", idempotencyKey: "x2-mounted-other:" + randomUUID(), activeContext: input.root });
  await attachWorkEntity(input.tenantId, otherWork.workId, { ...input.root, source: "FRONTIER5.X2:mounted-fixture" });
  async function investigation(principalId: string, workId: string, name: string, sessionId: string | null,
    status: ApplicationExpectation["status"]): Promise<PreparedInvestigation> {
    const title = "X2 " + name + " " + randomUUID();
    const thread = await createEmployeeConversationThread({ tenantId: input.tenantId, ownerEmployeeId: principalId, title });
    await updateEmployeeConversationThreadContext({ tenantId: input.tenantId, ownerEmployeeId: principalId,
      threadId: thread.id, activeReferences: [input.root], activeWorkId: workId });
    const row = (await input.sql.query("SELECT owner_employee_id,active_work_id,active_references FROM finnor_os.employee_conversation_threads"
      + " WHERE tenant_id=$1 AND id=$2", [input.tenantId, thread.id])).rows[0];
    assert.equal(row.owner_employee_id, principalId); assert.equal(row.active_work_id, workId);
    assert.deepEqual(row.active_references, [input.root]);
    return { threadId: thread.id, title,
      expected: { tenantId: input.tenantId, principalId, root: input.root, workId, sessionId, status } };
  }
  const acquisition = await investigation(input.actorId, input.acquisitionWorkId, "acquisition",
    input.acquisitionSessionId, "MODEL_READY");
  const fresh = await investigation(input.actorId, input.freshWorkId, "fresh", null, null);
  const other = await investigation(input.otherId, otherWork.workId, "other-principal", null, null);
  const seedPath = join(input.evidenceDirectory, "mounted-seed.json");
  await writeFile(seedPath, JSON.stringify({ acquisition, fresh, other, owners, source: "REAL_CANONICAL_OWNERS" }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" });
  const log = join(directory, "frontend.log");
  await writeFile(log, "", { mode: 0o600, flag: "wx" });
  const frontend = new URL(input.frontendOrigin);
  assert.equal(frontend.hostname, "127.0.0.1");
  let ready: () => void = () => {}, refuse: (error: Error) => void = () => {}, text = "", flush = Promise.resolve();
  let logFailure = false;
  const readiness = new Promise<void>((yes, no) => { ready = yes; refuse = no; });
  const arguments_ = [join(input.runtimeRoot, "node_modules/next/dist/bin/next"), "dev", "--webpack",
    "--hostname", "127.0.0.1", "--port", frontend.port];
  const child = spawn(process.execPath, arguments_, { cwd: input.runtimeRoot, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: "C", TZ: "UTC",
    NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=3072", NEXT_TELEMETRY_DISABLED: "1",
    FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable",
    FINNOR_OS_API_URL: input.apiOrigin, NEXT_PUBLIC_OS_API_URL: input.apiOrigin,
    NEXT_PUBLIC_SUPABASE_URL: input.auth.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: input.auth.publicAnonKey,
  } });
  const exited = new Promise<void>(yes => child.once("close", () => { refuse(Error("MAINTAINED_FRONTEND_EXITED")); yes(); }));
  child.once("error", refuse);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes: Buffer) => {
    flush = flush.then(() => appendFile(log, bytes)).catch(() => { logFailure = true; });
    text = (text + bytes.toString()).slice(-8192);
    if (/Ready in/.test(text)) ready();
  });
  let context: import("playwright-core").BrowserContext | undefined;
  let browser: import("playwright-core").Browser | undefined, ownedBrowser = false;
  let freshSessionId = "", oracleOrdinal = 0;
  let execution: { status: number; body: { sessionId: string } } | undefined;
  let capture = Promise.resolve(), captureFailure = false, executionResponses = 0;
  let expectedEffectIds: string[] | undefined;
  const observationPath = (name: string) => join(input.evidenceDirectory, `mounted-canonical-${++oracleOrdinal}-${name}.json`);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readiness, new Promise<void>((_, no) => {
        timer = setTimeout(() => no(Error("MAINTAINED_FRONTEND_START_DEADLINE")), 30000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    await writeFile(join(input.evidenceDirectory, "mounted-frontend-runtime.json"), JSON.stringify({
      pid: child.pid, processGroup: child.pid, argv: arguments_, mode: "MAINTAINED_DEVELOPMENT_FRONTEND",
      backend: "ACTUAL_EMITTED_PRODUCTION_NODE_STAGING_DISPOSABLE", log,
      ambientEnvironmentLoaded: false, cspDisabled: false, authBypassPresent: false,
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    // Real cold compilation, not a route stub. These unauthenticated page fetches
    // do not establish access, acquisition, or an application outcome.
    for (const path of ["/centropy/login", `/centropy/investigations/${acquisition.threadId}`]) {
      const response = await fetch(input.frontendOrigin + path, { redirect: "manual", signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, "ACTUAL_MAINTAINED_PAGE_COMPILE_FAILED"); await response.arrayBuffer();
    }
    try {
      const { chromium } = await import("playwright-core");
      const mode = process.env.FINNOR_X2_MOUNTED_BROWSER ?? "assigned_desktop";
      assert(["assigned_desktop", "task_owned_visible_chrome"].includes(mode), "EXPLICIT_MOUNTED_BROWSER_MODE_REQUIRED");
      if (mode === "task_owned_visible_chrome") {
        browser = await chromium.launch({ channel: "chrome", headless: false, timeout: 15000,
          env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, LANG: "C", TZ: "UTC" } });
        ownedBrowser = true;
      } else if (process.env.FACTORY_DESKTOP_CDP_PORT) {
        assert(process.env.AGENT_BROWSER_CDP, "ASSIGNED_DESKTOP_CDP_REQUIRED");
        browser = await chromium.connectOverCDP(process.env.AGENT_BROWSER_CDP, { timeout: 15000 });
      } else { throw Error("ASSIGNED_DESKTOP_OR_EXPLICIT_VISIBLE_BROWSER_REQUIRED"); }
      context = await browser.newContext({ serviceWorkers: "block" });
      assert.equal(context.pages().length, 0);
      const probe = await context.newPage();
      assert.equal(probe.url(), "about:blank"); await probe.close();
      await writeFile(join(input.evidenceDirectory, "mounted-browser-runtime.json"), JSON.stringify({
        mode, version: browser.version(), taskOwnedBrowser: ownedBrowser,
        freshContext: true, savedAuthenticationLoaded: false, visible: true,
        blankPageCreation: "PASS", desktopPolicyChanged: false, headlessFallback: false,
      }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch { throw Error("FRESH_TASK_OWNED_BROWSER_CONTEXT_UNAVAILABLE"); }
    context.on("response", response => {
      const url = new URL(response.url());
      if (url.origin !== input.frontendOrigin || url.pathname !== "/api/centropy/company-brain/application-execute"
        || response.request().method() !== "POST") return;
      capture = capture.then(async () => {
        const request = response.request().postDataJSON() as { workId?: string; sessionId?: string };
        assert.equal(request.workId, input.freshWorkId); assert.equal(request.sessionId, input.acquisitionSessionId);
        const body = await response.json() as { sessionId: string };
        assert.equal(typeof body.sessionId, "string");
        executionResponses++; execution = { status: response.status(), body };
      }).catch(() => { captureFailure = true; });
    });
    const result = await runMountedWork({
      context, contextOwnership: "FRESH_TASK_OWNED_NO_SAVED_AUTH", fixtureQualification: "SYNTHETIC_DISPOSABLE_ONLY",
      auth: input.auth, frontendOrigin: input.frontendOrigin, apiOrigin: input.apiOrigin,
      frontendMode: "development", apiWorkerRuntime: "EMITTED_PRODUCTION_NODE",
      acquisition, fresh, otherPrincipal: other,
      freshUse: { executionProfileId: input.executionProfileId, targetId: input.targetId,
        goalJson: JSON.stringify(input.goal), parametersJson: JSON.stringify(input.parameters),
        businessExpectation: input.businessExpectation },
      settleFreshUse: async request => {
        assert.equal(request.workId, input.freshWorkId); assert.equal(request.parentSessionId, input.acquisitionSessionId);
        do {
          const rows = (await input.sql.query("SELECT id,status,model_ref FROM finnor_os.application_semantics_sessions"
            + " WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at,id",
          [input.tenantId, input.actorId, input.freshWorkId])).rows;
          if (rows.length) {
            assert.equal(rows.length, 1, "ONE_ACTUAL_UI_FRESH_REGISTRATION_REQUIRED");
            freshSessionId = rows[0].id;
            await input.settleFresh(freshSessionId, request.signal);
            const final = (await input.sql.query("SELECT status FROM finnor_os.application_semantics_sessions WHERE id=$1", [freshSessionId])).rows[0];
            assert.equal(final.status, "COMPLETED");
            return { ...fresh.expected, sessionId: freshSessionId, status: "COMPLETED" };
          }
          await new Promise(yes => setTimeout(yes, 75));
        } while (!request.signal.aborted && Date.now() < request.deadlineAt);
        throw Error("ACTUAL_UI_FRESH_REGISTRATION_NOT_OBSERVED");
      },
      assertCanonical: async request => {
        assert.equal(request.mutationCounts.acquisition, 0); assert.equal(request.mutationCounts.cancellation, 0);
        assert(request.mutationCounts.execution <= 1);
        let row: unknown = null, focus: unknown = null;
        if (request.expected) {
          const expected = request.expected;
          assert.equal(expected.tenantId, input.tenantId); assert.deepEqual(expected.root, input.root);
          row = (await input.sql.query("SELECT id,created_by,current_owner_id,tenant_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
            [input.tenantId, expected.workId])).rows[0];
          assert(row); assert.equal((row as { created_by: string }).created_by, expected.principalId);
          assert.equal((row as { current_owner_id: string }).current_owner_id, expected.principalId);
          const sessions = (await input.sql.query("SELECT id,status FROM finnor_os.application_semantics_sessions"
            + " WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at,id",
          [input.tenantId, expected.principalId, expected.workId])).rows;
          if (expected.sessionId) assert(sessions.some(value => value.id === expected.sessionId && value.status === expected.status));
          else assert.equal(sessions.length, 0);
          if (request.canvasFocusedBlockId) {
            focus = (await input.sql.query("SELECT selected_block_id,ui_revision FROM finnor_os.centropy_canvas_preferences"
              + " WHERE tenant_id=$1 AND owner_employee_id=$2 AND thread_id=$3",
            [input.tenantId, input.actorId, acquisition.threadId])).rows[0];
            assert.equal((focus as { selected_block_id: string }).selected_block_id, request.canvasFocusedBlockId);
          }
        }
        const path = observationPath("scope");
        await writeFile(path, JSON.stringify({ checkpoint: request.checkpoint, expected: request.expected,
          observed: request.observed, canonicalWork: row, canonicalFocus: focus, mutationCounts: request.mutationCounts }, null, 2) + "\n",
        { mode: 0o600, flag: "wx" });
        return { source: "CANONICAL_SQL", asserted: true, reference: path };
      },
      assertBusiness: async request => {
        assert.deepEqual(request.expected, input.businessExpectation);
        assert.equal(request.work.sessionId, freshSessionId);
        const path = await input.assertBusiness(request.checkpoint, request.signal);
        const effects = (await input.sql.query("SELECT r.id,o.effect_id FROM finnor_os.application_semantics_requests r"
          + " JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
          + " WHERE r.session_id=$1 ORDER BY r.id", [freshSessionId])).rows.map(row => row.effect_id as string).sort();
        assert.equal(effects.length, 4); assert.equal(new Set(effects).size, 4);
        if (expectedEffectIds) assert.deepEqual(effects, expectedEffectIds, "UI_LIFECYCLE_MUST_NOT_REPLAY_BUSINESS_EFFECTS");
        else expectedEffectIds = effects;
        return { source: "INDEPENDENT_EXTERNAL_STATE", asserted: true, reference: path };
      },
      setPrincipalRevoked: async request => {
        assert.equal(request.principalId, input.actorId);
        const status = request.revoked ? "inactive" : "active";
        const rows = (await input.sql.query("UPDATE finnor_os.users SET status=$3 WHERE tenant_id=$1 AND id=$2 RETURNING id,status,role",
          [input.tenantId, input.actorId, status])).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].status, status); assert.equal(rows[0].role, "owner");
        const path = observationPath("access");
        await writeFile(path, JSON.stringify({ checkpoint: request.checkpoint, canonicalOwner: rows[0],
          authSessionRevokedByFixture: false }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        return { source: "CANONICAL_SQL", asserted: true, reference: path };
      },
      evidence: { ownedWorkspaceDirectory: resolve(input.evidenceDirectory, ".."), evidenceDirectory: input.evidenceDirectory,
        seedReceiptPath: seedPath, runtimeReceiptPath: join(input.evidenceDirectory, "installed-beginning.json"),
        driverPath: join(input.runtimeRoot, "finnor-os/scripts/x2/run-native-e2e.mts") },
    });
    await capture;
    assert(!captureFailure && execution, "ACTUAL_MOUNTED_API_RESPONSE_REQUIRED");
    assert.equal(executionResponses, 1); assert.equal(execution.status, 202);
    assert.equal(execution.body.sessionId, freshSessionId);
    return { result, freshSessionId, execution, investigations: { acquisition, fresh, other } };
  } finally {
    await context?.close();
    if (ownedBrowser) await browser?.close(); // Never close the desktop-owned browser.
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Owned group already exited. */ }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Exited. */ } }, 10000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await flush;
    if (logFailure) throw Error("MAINTAINED_FRONTEND_LOG_CUSTODY_FAILED");
  }
}
