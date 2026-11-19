/** Disposable owner setup and physical local hosts, not a rendered UI oracle.
 * Browser assertions and screenshots must come from the actual browser client. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { receiveWork, attachWorkEntity, createEmployeeConversationThread, updateEmployeeConversationThreadContext } from "@finnor/db";
import { createDeal } from "@finnor/private-equity";
import type { NativeWorkforceOriginal } from "../../packages/orchestration/src/workforce-execution/contracts";
import type { authenticatedApiFixture } from "../frontier5/x1/authenticated-api-fixture.mts";

export function mountedResponseGate() {
  type DelayedResponse = { entered: boolean; released: boolean; drained: boolean; path: string | null; digest: string | null;
    promise: Promise<void>; release: () => void };
  let pending: DelayedResponse | null = null;
  let last: DelayedResponse | null = null;
  return {
    arm() {
      if (pending) throw Error("ONE_ORIGINAL_DELAYED_RESPONSE");
      let release!: () => void;
      const promise = new Promise<void>(resolve => { release = resolve; });
      pending = { entered: false, released: false, drained: false, path: null, digest: null, promise, release };
    },
    async afterResponse(path: string, body: string, status: number, request: { method: string }) {
      if (pending && !pending.entered && request.method === "GET" && status === 200 &&
          /^\/api\/workforce\/execution-programs\/[0-9a-f-]+$/.test(path)) {
        pending.entered = true; pending.path = path;
        pending.digest = createHash("sha256").update(body).digest("hex");
        const original = pending;
        await original.promise;
        original.drained = true; last = original; pending = null;
      }
    },
    state() {
      const value = pending ?? last;
      return { entered: value?.entered ?? false, released: value?.released ?? false, drained: value?.drained ?? false,
        path: value?.path ?? null, digest: value?.digest ?? null };
    },
    release() { if (pending) { pending.released = true; pending.release(); } },
  };
}

/** Compile public route shapes during native setup, not inside a UI predicate.
 * No session, bearer header, private response or business mutation is injected. */
export async function prepareMountedFrontend(p: {
  repo: string; evidence: string; privateDirectory: string; frontendOrigin: string; frontendInstallation?: string;
  service: Awaited<ReturnType<typeof authenticatedApiFixture>>; startupWallMs: number;
}) {
  const origin = new URL(p.frontendOrigin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert(origin.port && origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password);
  assert.equal(p.startupWallMs, 900000, "ORIGINAL_BUILD_STARTUP_ENVELOPE");
  await mkdir(join(p.privateDirectory, "home"), { mode: 0o700 });
  await mkdir(join(p.privateDirectory, "tmp"), { mode: 0o700 });
  let manifest: any = null;
  if (p.frontendInstallation) {
    manifest = JSON.parse(await readFile(join(p.frontendInstallation, "w2-frontend-installation.json"), "utf8"));
    assert.equal(manifest.schema, "finnor.postz.w2.frontend-installation.v1");
    assert.equal(manifest.frontendOrigin, origin.origin);
  }
  const frontend = spawn(process.execPath, p.frontendInstallation
    ? ["--max-old-space-size=1536", join(p.frontendInstallation, "frontend-host.mjs"),
      "--api-origin", p.service.origin, "--auth-origin", p.service.authOrigin]
    : ["--max-old-space-size=1536", join(p.repo, "node_modules/next/dist/bin/next"),
      "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", origin.port],
  { cwd: p.frontendInstallation ?? p.repo, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: join(p.privateDirectory, "home"), TMPDIR: join(p.privateDirectory, "tmp"),
    NODE_ENV: p.frontendInstallation ? "production" : "development", NODE_OPTIONS: "",
    NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_CENTROPY_TEST_MODE: "0", CENTROPY_TEST_MODE: "0",
    FINNOR_OS_API_URL: p.service.origin, NEXT_PUBLIC_OS_API_URL: p.service.origin,
    NEXT_PUBLIC_SUPABASE_URL: p.service.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: "disposable-local-auth",
  } });
  const cancel = new AbortController(), started = performance.now(), deadline = Date.now() + p.startupWallMs;
  let logBytes = 0, logFailure: string | null = null, stopped = false, writes = Promise.resolve();
  for (const stream of [frontend.stdout!, frontend.stderr!]) stream.on("data", bytes => {
    logBytes += bytes.length;
    if (logBytes > 2097152) { logFailure = "MOUNTED_FRONTEND_LOG_BOUND"; cancel.abort(); return; }
    writes = writes.then(() => appendFile(join(p.evidence, "mounted-frontend.log"), bytes, { mode: 0o600 }))
      .catch(error => { logFailure = String(error); cancel.abort(); });
  });
  const readiness = (async () => {
    const routes: Array<Record<string, unknown>> = [];
    for (const path of ["/centropy/login", "/centropy/workforce",
      "/centropy/investigations/00000000-0000-4000-8000-000000000000"]) {
      const routeStarted = performance.now();
      let attempts = 0;
      for (;;) {
        assert(!cancel.signal.aborted && Date.now() < deadline, "OWNED_FRONTEND_STARTUP_BOUND_OR_STOP");
        assert(frontend.exitCode === null && frontend.signalCode === null, "OWNED_FRONTEND_EARLY_EXIT");
        attempts++;
        try {
          const response = await fetch(origin.origin + path, { signal: AbortSignal.any([
            cancel.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          ]) });
          assert.equal(response.status, 200, "PUBLIC_ROUTE_PREPARATION");
          const body = await response.arrayBuffer();
          assert(body.byteLength <= 2097152, "PUBLIC_PREPARATION_RESPONSE_BOUND");
          routes.push({ path, finalPath: new URL(response.url).pathname, status: response.status, attempts,
            responseBytes: body.byteLength, elapsedMs: performance.now() - routeStarted });
          break;
        } catch (error) {
          if (cancel.signal.aborted || Date.now() >= deadline || frontend.exitCode !== null || frontend.signalCode !== null) throw error;
          // Only a listening/startup connection can be retried here. A real HTTP
          // refusal is not replaced by another attempt or a canned response.
          if (!(error instanceof TypeError && (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED")) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    }
    return { status: "PASS", routes, elapsedMs: performance.now() - started, buildStartupWallMs: p.startupWallMs,
      compiled: Boolean(p.frontendInstallation), credentialsOrBusinessDataInjected: false, browserWaitsChanged: false };
  })().catch(error => ({ status: "FAIL", failure: error instanceof Error ? error.stack : String(error),
    elapsedMs: performance.now() - started, buildStartupWallMs: p.startupWallMs, logFailure }));
  const recorded = readiness.then(async result => {
    await writeFile(join(p.evidence, "mounted-public-route-preparation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    return result;
  });
  // Make a preparation failure observable without an unhandled rejection while
  // the independently bounded native cases are still executing.
  const ready = recorded.catch(error => ({ status: "FAIL", failure: String(error), elapsedMs: performance.now() - started,
    buildStartupWallMs: p.startupWallMs, logFailure }));
  return { frontend, manifest, ready, async stop() {
    if (!stopped) {
      stopped = true; cancel.abort();
      if (frontend.exitCode === null && frontend.signalCode === null) {
        const ending = new Promise<void>(resolve => frontend.once("exit", () => resolve()));
        frontend.kill("SIGTERM"); const timer = setTimeout(() => frontend.kill("SIGKILL"), 7000);
        await ending; clearTimeout(timer);
      }
    }
    await ready; await writes;
  } };
}

type PreparedFrontend = Awaited<ReturnType<typeof prepareMountedFrontend>>;
export async function holdMountedWorkforce(params: {
  repo: string; evidence: string; privateDirectory: string; frontendOrigin: string; frontendInstallation?: string;
  tenant: string; principal: string; alternate: string; foreignTenant: string; foreign: string;
  participant: string; participantWorkId: string;
  workId: string; original: NativeWorkforceOriginal; admin: pg.Client;
  service: Awaited<ReturnType<typeof authenticatedApiFixture>>; gate: ReturnType<typeof mountedResponseGate>;
  api: (path: string, body?: unknown, actor?: string) => Promise<{ status: number; body: any }>;
  startWorker: () => Promise<void>;
  preparedFrontend?: PreparedFrontend;
  participantOnly?: boolean;
  onPositive?: () => Promise<void>;
}) {
  const p = params, save = (name: string, value: unknown) =>
    writeFile(join(p.evidence, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const expiryContact = randomUUID(), expiryPurpose = "w2-mounted-natural-expiry";
  await p.admin.query(`INSERT INTO finnor_os.external_contacts(tenant_id,id,contact_key,name)
    VALUES($1,$2,$3,'Controlled mounted expiry contact, not field evidence')`,
  [p.tenant, expiryContact, "w2-mounted-expiry-" + expiryContact]);
  const expiredAt = Date.now() + 1500;
  const oldProposal = await p.api("workforce/participants", { contactId: expiryContact,
    recipientPrincipalId: p.participant, purpose: expiryPurpose, validUntil: new Date(expiredAt).toISOString(),
    idempotencyKey: "mounted-expiring-proposal" });
  assert.equal(oldProposal.status, 202);
  const oldConsent = await p.api("workforce/participants/" + oldProposal.body.id, {
    action: "CONFIRM", proposalDigest: oldProposal.body.proposalDigest, expectedRevision: 0,
    idempotencyKey: "mounted-original-recipient-consent" }, p.participant);
  assert.equal(oldConsent.status, 200);
  await new Promise(resolve => setTimeout(resolve, Math.max(1, expiredAt - Date.now() + 1)));
  const freshProposal = await p.api("workforce/participants", { contactId: expiryContact,
    recipientPrincipalId: p.participant, purpose: expiryPurpose, validUntil: p.original.outcome.deadline,
    idempotencyKey: "mounted-fresh-exact-proposal" });
  assert.equal(freshProposal.status, 202);
  assert.notEqual(freshProposal.body.id, oldProposal.body.id);
  await save("mounted-expiry-inputs.json", { oldProposal, oldConsent, freshProposal, expiredAt,
    source: "CONTROLLED_ACTOR_RECORDS_REAL_CLOCK_AND_AUTHENTICATED_API", originalDeadlineReset: false });
  const origin = new URL(p.frontendOrigin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  assert(origin.port && origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password);
  const deal = async (tenantId: string, actor: string) => {
    const organization = randomUUID();
    await p.admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
      VALUES($1,$2,$3,'Controlled disposable mounted institution','other')`, [organization, tenantId, "w2-" + organization]);
    return createDeal({ auth: { tenantId, userId: actor, employeeId: actor, role: "owner" },
      provenance: { sourceSystem: "W2:controlled-mounted-owner", createdBy: actor, externalId: randomUUID() } },
    { targetOrganizationId: organization, name: "Controlled W2 delivery, not field evidence", dealLeadEmployeeId: actor,
      signedLoiAt: new Date(Date.now() - 86400000), targetClosingAt: new Date(Date.now() + 86400000) });
  };
  const ownDeal = await deal(p.tenant, p.principal), otherDeal = await deal(p.foreignTenant, p.foreign);
  const root = { entityType: "pe_deal", entityId: String(ownDeal.row.id) };
  const work = await receiveWork({ tenantId: p.tenant, userId: p.principal, workId: p.workId, channel: "console",
    instruction: JSON.stringify(p.original), idempotencyKey: "w2-mounted-original:" + p.workId, requireExactIntake: true,
    activeContext: root, authorityContext: { authenticatedPrincipal: p.principal, controlledServiceIdentity: true } });
  await attachWorkEntity(p.tenant, work.workId, { ...root, source: "W2:actual-mounted-Work-context" });
  const thread = await createEmployeeConversationThread({ tenantId: p.tenant, ownerEmployeeId: p.principal,
    title: "W2 accountable original outcome", workId: work.workId });
  const empty = await createEmployeeConversationThread({ tenantId: p.tenant, ownerEmployeeId: p.principal,
    title: "W2 separate empty Work scope" });
  const alternate = await createEmployeeConversationThread({ tenantId: p.tenant, ownerEmployeeId: p.alternate,
    title: "W2 independently scoped checker", workId: work.workId });
  const foreign = await createEmployeeConversationThread({ tenantId: p.foreignTenant, ownerEmployeeId: p.foreign,
    title: "W2 foreign tenant private context" });
  for (const [threadId, actor, activeWorkId] of [[thread.id, p.principal, work.workId],
    [empty.id, p.principal, null], [alternate.id, p.alternate, work.workId]] as const)
    await updateEmployeeConversationThreadContext({ tenantId: p.tenant, ownerEmployeeId: actor, threadId,
      activeWorkId, activeReferences: [root] });
  await updateEmployeeConversationThreadContext({ tenantId: p.foreignTenant, ownerEmployeeId: p.foreign,
    threadId: foreign.id, activeReferences: [{ entityType: "pe_deal", entityId: String(otherDeal.row.id) }] });
  let frontend: ChildProcess | undefined, positive: unknown = null, completed = false, failure: Error | null = null;
  let prepared: PreparedFrontend | undefined = p.preparedFrontend;
  type RoleRestoration = { restored: true; mutationTerminal: true; noPendingMutation: true; ownerReadbackObserved: true;
    canonicalRole: string; status: string; samePrincipalAndTenant: true };
  let roleDeadlineNs: bigint | null = null, roleClosing = false, roleMutationTerminal = true, roleSqlPending = 0;
  let roleMutation: Promise<void> | null = null, roleReconciliation: Promise<RoleRestoration> | null = null;
  let observedRestoration: RoleRestoration | null = null, fixtureFailed = false;
  let demotionObservation: { canonicalRole: string; status: string; samePrincipalAndTenant: true } | null = null;
  const roleChanges: Array<{ from: string; to: string; status: string; samePrincipalAndTenant: boolean }> = [];
  let roleSdk: { version: string; sha256: string; bytes: number; frontendPackageSha256: string; packageLockSha256: string;
    compiledAssetInsideInstallation: boolean | null; installationManifest: {
      sha256: string; entrypoint: string; tracingLayout: { projectPath: string };
      sourcePreimages: Array<{ path: string; sha256: string }>;
      files: Array<{ path: string; bytes: number; mode: number; sha256: string }> } } | null = null;
  const bindRoleDeadline = (raw: string | string[] | undefined, mayStart: boolean) => {
    assert(typeof raw === "string" && /^[1-9][0-9]{0,24}$/.test(raw), "ORIGINAL_ROLE_CASE_DEADLINE_REQUIRED");
    const deadline = BigInt(raw), now = process.hrtime.bigint();
    if (roleDeadlineNs === null) {
      assert(mayStart && deadline > now && deadline - now <= 45000000000n, "ORIGINAL_ROLE_CASE_DEADLINE_INVALID");
      roleDeadlineNs = deadline;
    } else assert.equal(deadline, roleDeadlineNs, "ROLE_CASE_DEADLINE_MUST_NOT_CHANGE");
  };
  const remainingRoleMs = (until: bigint) => {
    const ms = Math.floor(Number(until - process.hrtime.bigint()) / 1000000);
    assert(ms > 0, "ROLE_RECONCILIATION_ORIGINAL_BUDGET_EXPIRED");
    return ms;
  };
  async function observeRoleUntil<T>(work: Promise<T>, until: bigint): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Observation is bounded; timing out never cancels or declares SQL terminal.
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("ROLE_RECONCILIATION_UNCONFIRMED")), remainingRoleMs(until));
    });
    try {
      const result = await Promise.race([work, expiry]);
      remainingRoleMs(until); return result;
    } finally { if (timer) clearTimeout(timer); }
  }
  const roleSql = async (from: "owner" | "participant", to: "owner" | "participant", until: bigint) => {
    const timeout = Math.min(5000, remainingRoleMs(until));
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    assert(uuid.test(p.tenant) && uuid.test(p.principal), "EXACT_CONTROLLED_ROLE_IDENTITIES_REQUIRED");
    // One simple-protocol transaction: no interleaving between SET LOCAL and
    // the write. Only these validated fixture UUIDs enter the SQL literal.
    const sql = `BEGIN; SET LOCAL statement_timeout='${timeout}ms';
      DO $w2_role$ BEGIN
        UPDATE finnor_os.users SET role='${to}' WHERE tenant_id='${p.tenant}'::uuid AND id='${p.principal}'::uuid
          AND role='${from}' AND status='active';
        IF NOT FOUND THEN RAISE EXCEPTION 'EXACT_CONTROLLED_ROLE_CHANGE_REQUIRED'; END IF;
      END; $w2_role$; COMMIT;`;
    let terminal = false;
    roleSqlPending++;
    try {
      await p.admin.query(sql);
      terminal = true; return { ok: true, terminal: true, error: undefined };
    } catch (error) {
      try { await p.admin.query("ROLLBACK"); terminal = true; } catch {}
      return { ok: false, terminal, error };
    } finally { if (terminal) roleSqlPending--; }
  };
  const readCanonicalRole = async (until: bigint) => {
    remainingRoleMs(until);
    const rows = (await p.admin.query("SELECT id,tenant_id,role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2",
      [p.tenant, p.principal])).rows;
    remainingRoleMs(until);
    assert(rows.length === 1 && rows[0].id === p.principal && rows[0].tenant_id === p.tenant,
      "EXACT_CANONICAL_ROLE_READBACK_REQUIRED");
    return rows[0];
  };
  const restoreRole = () => {
    roleClosing = true;
    if (roleReconciliation) return roleReconciliation;
    const originalDeadline = roleDeadlineNs;
    assert(originalDeadline !== null, "ORIGINAL_ROLE_CASE_DEADLINE_REQUIRED");
    const cleanupCap = process.hrtime.bigint() + 5000000000n;
    const until = originalDeadline < cleanupCap ? originalDeadline : cleanupCap;
    const work = Promise.resolve().then(async (): Promise<RoleRestoration> => {
      remainingRoleMs(until);
      if (roleMutation) await roleMutation.catch(() => {});
      remainingRoleMs(until);
      assert(roleMutationTerminal && roleSqlPending === 0, "ROLE_MUTATION_TERMINAL_NOT_OBSERVED");
      let row = await readCanonicalRole(until);
      assert.equal(row.status, "active", "CANONICAL_ROLE_STATUS_CHANGED");
      if (row.role === "participant") {
        assert(roleMutation, "NO_UNOWNED_ROLE_RESTORATION");
        const outcome = await roleSql("participant", "owner", until);
        if (!outcome.ok || !outcome.terminal) throw outcome.error ?? Error("ROLE_RESTORATION_SQL_UNCONFIRMED");
        row = await readCanonicalRole(until);
        roleChanges.push({ from: "participant", to: row.role, status: row.status, samePrincipalAndTenant: true });
      }
      assert(row.role === "owner" && row.status === "active" && roleMutationTerminal && roleSqlPending === 0,
        "ACTUAL_TERMINAL_OWNER_RESTORATION_REQUIRED");
      const receipt: RoleRestoration = { restored: true, mutationTerminal: true, noPendingMutation: true,
        ownerReadbackObserved: true, canonicalRole: row.role, status: row.status, samePrincipalAndTenant: true };
      await save("mounted-role-change-readback.json", { changes: roleChanges, suspended: false, restoration: receipt });
      remainingRoleMs(until); return receipt;
    });
    // Cache the one bounded operation, including failure. Finally cannot retry
    // it with a fresh deadline, and no subsequent demotion can pass the fence.
    roleReconciliation = observeRoleUntil(work, until).then(receipt => {
      remainingRoleMs(until); observedRestoration = receipt; return receipt;
    });
    return roleReconciliation;
  };
  const readSdkAsset = async (relative: string,
    pin?: { path: string; bytes: number; mode: number; sha256: string }, limit = 1048576) => {
    const installation = p.frontendInstallation;
    assert(installation, "COMPILED_FRONTEND_OWN_SDK_INSTALLATION_REQUIRED");
    assert(!relative.startsWith("/") && !relative.includes("\\") && !relative.includes("\0")
      && relative.split("/").every(name => name && name !== "." && name !== ".."), "ROLE_SDK_RELATIVE_PATH_REQUIRED");
    const path = join(installation, relative), physicalRoot = await realpath(installation);
    const directoryIdentity = async () => {
      let part = installation;
      const identities = [];
      assert.equal(await realpath(installation), physicalRoot, "COMPILED_SDK_INSTALLATION_MOVED");
      for (const name of ["", ...relative.split("/").slice(0, -1)]) {
        part = name ? join(part, name) : part;
        const entry = await lstat(part, { bigint: true });
        assert(entry.isDirectory() && !entry.isSymbolicLink(), "COMPILED_SDK_ANCESTOR_SYMLINK_REFUSED");
        const actual = await realpath(part);
        assert(actual === physicalRoot || actual.startsWith(physicalRoot + "/"), "COMPILED_SDK_BORROWED_DEPENDENCY_REFUSED");
        identities.push([entry.dev, entry.ino, entry.mode, entry.uid, entry.gid].join(":"));
      }
      return identities.join("/");
    };
    const parents = await directoryIdentity(), physicalFile = await realpath(path);
    assert(physicalFile.startsWith(physicalRoot + "/"),
      "COMPILED_SDK_BORROWED_DEPENDENCY_REFUSED");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      assert(before.isFile() && before.nlink === 1n && (before.mode & 0o7777n) === 0o444n
        && before.size > 0n && before.size <= BigInt(limit), "ROLE_SDK_SEALED_ASSET_BOUND");
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      assert(BigInt(size) === before.size && size <= limit && !named.isSymbolicLink()
        && [after, named].every(value => value.dev === before.dev && value.ino === before.ino
          && value.mode === before.mode && value.uid === before.uid && value.gid === before.gid
          && value.nlink === before.nlink && value.size === before.size
          && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs),
      "ROLE_SDK_ASSET_CHANGED_OR_SYMLINKED");
      assert.equal(await realpath(path), physicalFile, "COMPILED_SDK_FILE_MOVED");
      assert.equal(await directoryIdentity(), parents, "COMPILED_SDK_ANCESTOR_CHANGED");
      const bytes = buffer.subarray(0, size);
      if (pin) {
        assert.equal(pin.path, relative); assert.equal(pin.mode, 0o444);
        assert.equal(pin.bytes, size); assert.equal(pin.sha256, createHash("sha256").update(bytes).digest("hex"),
          "ROLE_SDK_EXISTING_MANIFEST_PIN_REQUIRED");
      }
      return bytes;
    } finally { await handle.close(); }
  };
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; }), key = randomBytes(32).toString("hex");
  const control = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
    if (req.headers.authorization !== "Bearer " + key) { res.writeHead(401); res.end("{}"); return; }
    try {
      let body = ""; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw Error("CONTROL_BODY_BOUND"); }
      if (req.method === "GET" && req.url === "/state") {
        res.end(JSON.stringify({ delay: p.gate.state(), positiveObserved: Boolean(positive),
          frontendExited: frontend?.exitCode !== null, completed })); return;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      if (["/role-sdk", "/role-demote", "/role-restore"].includes(req.url ?? "")) {
        assert(positive && !p.participantOnly, "ORIGINAL_OWNER_ROLE_CASE_REQUIRED");
        bindRoleDeadline(req.headers["x-finnor-w2-role-deadline-ns"], req.url === "/role-sdk");
      }
      if (req.url === "/role-sdk") {
        assert(!roleClosing, "ROLE_MUTATION_ADMISSION_CLOSED");
        const manifest = prepared?.manifest;
        assert(p.frontendInstallation && manifest, "ACTUAL_PREPARED_COMPILED_FRONTEND_REQUIRED");
        const expectedManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
        const manifestBytes = await readSdkAsset("w2-frontend-installation.json", undefined, expectedManifestBytes.length);
        assert(manifestBytes.equals(expectedManifestBytes), "ORIGINAL_PREPARED_FRONTEND_MANIFEST_REQUIRED");
        assert.equal(manifest.schema, "finnor.postz.w2.frontend-installation.v1");
        assert.equal(manifest.mode, "DEVELOPMENT_ONLY"); assert.equal(manifest.frontendOrigin, new URL(p.frontendOrigin).origin);
        const projectPath = manifest.tracingLayout?.projectPath;
        assert(typeof projectPath === "string" && !projectPath.includes("\\") && !projectPath.includes("\0")
          && (!projectPath || projectPath.split("/").every(name => name && name !== "." && name !== "..")),
        "ACTUAL_RUNTIME_PROJECT_PATH_REQUIRED");
        const runtimeProject = ["runtime", projectPath].filter(Boolean).join("/");
        assert.equal(manifest.entrypoint, runtimeProject + "/server.js", "ACTUAL_RUNTIME_PROJECT_ENTRY_REQUIRED");
        const sourcePin = (path: string) => {
          const rows = manifest.sourcePreimages.filter((row: any) => row.path === path);
          assert(rows.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].sha256)
            && rows[0].generatedSha256 === undefined, "ACTUAL_BUILD_OWN_FRONTEND_SOURCE_PIN_REQUIRED");
          return { path, sha256: rows[0].sha256 as string };
        };
        const packageSource = sourcePin("package.json");
        const lockSource = sourcePin("package-lock.json");
        const sourcePreimages = [packageSource, lockSource];
        const sealedAsset = async (name: string) => {
          const path = runtimeProject + "/.finnor-w2-sdk-custody/" + name;
          const rows = manifest.files.filter((row: any) => row.path === path);
          assert(rows.length === 1, "ACTUAL_SEALED_FRONTEND_SDK_ASSET_REQUIRED");
          const pin = { path, bytes: rows[0].bytes as number, mode: rows[0].mode as number, sha256: rows[0].sha256 as string };
          return { pin, bytes: await readSdkAsset(path, pin) };
        };
        const frontendPackageAsset = await sealedAsset("frontend-package.json");
        const lockAsset = await sealedAsset("frontend-package-lock.json");
        const packageAsset = await sealedAsset("sdk-package.json");
        const bundleAsset = await sealedAsset("supabase.js");
        const custodyAssets = [frontendPackageAsset, lockAsset, packageAsset];
        const assets = [...custodyAssets, bundleAsset];
        const { bytes: frontendPackageBytes } = frontendPackageAsset;
        const { bytes: lockBytes } = lockAsset;
        const { bytes: packageBytes } = packageAsset;
        const { bytes: bundle } = bundleAsset;
        const frontendPackage = JSON.parse(frontendPackageBytes.toString("utf8"));
        const pkg = JSON.parse(packageBytes.toString("utf8")), lock = JSON.parse(lockBytes.toString("utf8"));
        const frontendPackageSha256 = createHash("sha256").update(frontendPackageBytes).digest("hex");
        const packageLockSha256 = createHash("sha256").update(lockBytes).digest("hex");
        assert.equal(frontendPackageSha256, packageSource.sha256, "ACTUAL_BUILD_OWN_FRONTEND_PACKAGE_REQUIRED");
        assert.equal(packageLockSha256, lockSource.sha256, "ACTUAL_BUILD_OWN_FRONTEND_LOCK_REQUIRED");
        assert.equal(frontendPackage.name, "centropy");
        assert.equal(lock.lockfileVersion, 3);
        assert.equal(lock.name, frontendPackage.name);
        assert.equal(lock.version, frontendPackage.version);
        assert.equal(lock.packages?.[""]?.name, frontendPackage.name);
        assert.equal(lock.packages?.[""]?.version, frontendPackage.version);
        assert.equal(frontendPackage.dependencies?.["@supabase/supabase-js"], "^2.45.1");
        assert.equal(frontendPackage.dependencies["@supabase/supabase-js"],
          lock.packages?.[""]?.dependencies?.["@supabase/supabase-js"], "ACTUAL_FRONTEND_SDK_DECLARATION_REQUIRED");
        assert.equal(pkg.name, "@supabase/supabase-js");
        assert.equal(pkg.version, "2.99.3", "REVIEWED_REAL_SDK_VERSION_REQUIRED");
        assert.equal(pkg.version, lock.packages?.["node_modules/@supabase/supabase-js"]?.version,
          "ACTUAL_FRONTEND_SDK_LOCK_VERSION_REQUIRED");
        const sha256 = createHash("sha256").update(bundle).digest("hex");
        assert.equal(bundle.length, 166800, "REVIEWED_REAL_SDK_BYTE_COUNT_REQUIRED");
        assert.equal(sha256, "588fb53d9380e3cb8688065c48144fa839205c328b416cc68c11331ba01955ee",
          "REVIEWED_UNMODIFIED_SDK_BUNDLE_REQUIRED");
        roleSdk = { version: pkg.version, sha256, bytes: bundle.length, frontendPackageSha256,
          packageLockSha256, compiledAssetInsideInstallation: true, installationManifest: {
            sha256: createHash("sha256").update(manifestBytes).digest("hex"), entrypoint: manifest.entrypoint,
            tracingLayout: { projectPath }, sourcePreimages, files: assets.map(asset => asset.pin) } };
        await save("mounted-role-sdk-identity.json", roleSdk);
        res.end(JSON.stringify({ schema: "finnor.postz.w2.mounted-role-sdk.v1", ...roleSdk,
          custodyAssets: custodyAssets.map(asset => ({ path: asset.pin.path, base64: asset.bytes.toString("base64") })),
          base64: bundle.toString("base64") })); return;
      }
      if (req.url === "/role-demote") {
        assert(roleSdk && !roleClosing && roleMutation === null, "CONTROLLED_OWNER_ROLE_CASE_REQUIRED");
        const until = roleDeadlineNs; assert(until !== null); remainingRoleMs(until);
        roleMutationTerminal = false;
        // Publish the pending operation before the microtask can enqueue SQL.
        roleMutation = Promise.resolve().then(async () => {
          const outcome = await roleSql("owner", "participant", until);
          roleMutationTerminal = outcome.terminal;
          if (!outcome.ok || !outcome.terminal) throw outcome.error ?? Error("ROLE_DEMOTION_SQL_UNCONFIRMED");
          const row = await readCanonicalRole(until);
          assert(row.role === "participant" && row.status === "active", "ACTUAL_CONTROLLED_DEMOTION_READBACK_REQUIRED");
          demotionObservation = { canonicalRole: row.role, status: row.status, samePrincipalAndTenant: true };
          roleChanges.push({ from: "owner", to: row.role, status: row.status, samePrincipalAndTenant: true });
          await save("mounted-role-change-readback.json", { changes: roleChanges, suspended: false });
        });
        await roleMutation;
        assert(demotionObservation, "ACTUAL_CONTROLLED_DEMOTION_READBACK_REQUIRED");
        res.end(JSON.stringify({ changed: true, ...demotionObservation })); return;
      }
      if (req.url === "/role-restore") {
        assert(positive && roleSdk && !p.participantOnly, "CONTROLLED_OWNER_ROLE_CASE_REQUIRED");
        res.end(JSON.stringify(await restoreRole())); return;
      }
      if (req.url === "/participant-expiry") {
        const rows = (await p.admin.query(`SELECT id,status,proposal_digest,revision FROM finnor_os.w2_contact_bindings
          WHERE tenant_id=$1 AND contact_id=$2 ORDER BY created_at,id`, [p.tenant, expiryContact])).rows;
        assert.equal(rows.length, 2);
        assert.equal(rows.find(row => row.id === oldProposal.body.id)?.status, "EXPIRED");
        assert.equal(rows.find(row => row.id === freshProposal.body.id)?.status, "CONFIRMED");
        const events = (await p.admin.query(`SELECT binding_id,body FROM finnor_os.w2_contact_binding_events
          WHERE tenant_id=$1 AND binding_id=ANY($2::uuid[]) ORDER BY created_at,event_key`,
        [p.tenant, [oldProposal.body.id, freshProposal.body.id]])).rows;
        assert.equal(events.filter(row => row.binding_id === oldProposal.body.id && row.body.action === "EXPIRE").length, 1);
        assert.equal(events.filter(row => row.binding_id === oldProposal.body.id && row.body.action === "CONFIRM").length, 1);
        assert.equal(events.filter(row => row.binding_id === freshProposal.body.id && row.body.action === "CONFIRM" &&
          row.body.authenticatedPrincipal === p.participant).length, 1);
        const observation = { rows, events, freshConsentInherited: false, realClockExpiry: true, genuineHumanQualified: false };
        await save("mounted-expiry-owning-readback.json", observation);
        res.end(JSON.stringify(observation)); return;
      }
      if (req.url === "/completion") {
        const row = (await p.admin.query(`SELECT id,status,program,budget,original FROM finnor_os.w2_programs
          WHERE tenant_id=$1 AND work_id=$2`, [p.tenant, p.workId])).rows[0];
        assert(row && row.status === "CLOSED");
        assert(row.program.assignments.every((a: { state: { kind: string } }) => a.state.kind === "CLOSED"));
        const readback = await p.api("workforce/execution-programs/" + row.id), workRead = await p.api("works/" + p.workId);
        assert.equal(readback.status, 200); assert.equal(readback.body.currentCheck.valid, true);
        assert.equal(workRead.body.work.work.status, "completed");
        const physical = (await p.admin.query("SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2",
          [p.tenant, row.id])).rows;
        assert.equal(physical.filter(e => e.kind === "S6_INTENDED").length, 1);
        assert.equal(physical.filter(e => e.kind === "S6_OBSERVATION").length, 1);
        if (!positive) await p.onPositive?.();
        positive = { native: readback.body, work: workRead.body, physical,
          actualMountedSubmitRequired: true, genuineHumanQualified: false };
        await save("mounted-native-completion.json", positive);
        res.end(JSON.stringify({ status: "PASS", programId: row.id, workId: p.workId })); return;
      }
      if (req.url === "/delay-next") { assert(positive); p.gate.arm(); res.end("{}"); return; }
      if (req.url === "/release") { p.gate.release(); res.end("{}"); return; }
      if (req.url === "/revoke-owner") {
        assert(positive);
        const revoked = (await p.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2 RETURNING id,status",
          [p.tenant, p.principal])).rows;
        await save("mounted-canonical-owner-revocation.json", { revoked, delayed: p.gate.state(), grantsAdded: false });
        res.end(JSON.stringify({ revoked: revoked.length })); return;
      }
      if (req.url === "/finish") {
        const browser = JSON.parse(await readFile(join(p.evidence, "mounted-browser-report.json"), "utf8"));
        assert.equal(browser.status, "PASS");
        if (p.participantOnly) {
          assert.equal(browser.profile, "FOCUSED_PARTICIPANT_EXPIRY_ORIGINAL_SIX_NOT_RUN");
          assert.deepEqual(browser.assertions, []);
        } else {
          assert(positive);
          assert.deepEqual(browser.assertions, ["mounted-original-compile-and-verified-completion", "work-switch-withdrawal",
            "same-tenant-principal-withdrawal", "foreign-tenant-withdrawal", "offline-private-withdrawal",
            "delayed-revoked-response-withdrawal"]);
          const role = browser.roleRevalidation;
          assert(roleSdk && roleClosing && roleMutationTerminal && roleSqlPending === 0
            && observedRestoration?.ownerReadbackObserved && roleChanges.length === 2, "CONTROLLED_OWNER_ROLE_NOT_RESTORED");
          assert.equal(role?.schema, "finnor.postz.w2.mounted-role-revalidation.v1");
          assert.equal(role.status, "PASS");
          assert.equal(role.sdk.sha256, roleSdk.sha256); assert.equal(role.sdk.version, roleSdk.version);
          assert.equal(role.sdk.packageLockSha256, roleSdk.packageLockSha256);
          assert.equal(role.sameOriginalDocument, true); assert.equal(role.sameUser, true);
          assert.equal(role.tokenRotations, 2); assert.equal(role.pendingRouteConsumed, true);
          assert.equal(role.transport.actualRequestHeld, true);
          assert.equal(role.transport.actualParticipantResponseHeld, true);
          assert.equal(role.transport.actualOwnerResponseObserved, true);
          assert.equal(role.transport.actualResponseUnchanged, true);
          assert.equal(role.transport.serverStatus, 200); assert.equal(role.transport.serverRole, "participant");
          assert(/^[0-9a-f]{64}$/.test(role.transport.participantResponseSha256), "ACTUAL_ROLE_RESPONSE_DIGEST_REQUIRED");
          assert.equal(role.pending.ownerRequestStarts, 0); assert.equal(role.pending.ownerResourceStarts, 0);
          assert.equal(role.demoted.ownerRequestStarts, 0); assert.equal(role.demoted.ownerResourceStarts, 0);
          assert(role.demoted.observedMs >= 6000 && role.elapsedMs < 45000, "ROLE_OBSERVATION_OR_DEADLINE_BOUND");
          assert(role.positive.baselineRequests > 0 && role.positive.recoveryRequests > 0);
          assert.equal(role.positive.originalClosedWorkRecovered, true);
          assert.equal(role.cleanup.fetchRestored, true); assert.equal(role.cleanup.iframeRemoved, true);
          assert.equal(role.cleanup.transportReleased, true); assert.equal(role.cleanup.dbRoleRestored, true);
          assert.equal(role.cleanup.dbMutationTerminal, true); assert.equal(role.cleanup.dbOwnerReadbackObserved, true);
          assert(browser.steps.some((step: { name: string }) =>
            step.name === "same-user-role-revalidation-zero-owner-read-barrier"));
        }
        assert.equal(browser.browser?.headed, true);
        assert.equal(browser.browser?.separatelyLaunched, true);
        assert(browser.steps.some((step: { name: string }) => step.name === "nonowner-participant-workspace-exact-own-contracts"));
        assert(browser.steps.some((step: { name: string }) => step.name === "participant-natural-expiry-and-fresh-exact-mounted-consent"));
        completed = true; res.end('{"status":"PASS"}'); finish(); return;
      }
      if (req.url === "/abort") {
        failure = Error("ACTUAL_BROWSER_VALIDATION_FAILED");
        res.end("{}"); finish(); return;
      }
      res.writeHead(404); res.end("{}");
    } catch (error) {
      await save("mounted-control-refusal.json", { predicate: (error as Error).message });
      res.writeHead(409); res.end('{"error":"mounted_predicate_not_satisfied"}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
    const address = control.address(); assert(address && typeof address !== "string");
    prepared ??= await prepareMountedFrontend({ ...p, startupWallMs: 900000 });
    const ready = await prepared.ready;
    assert.equal(ready.status, "PASS", JSON.stringify(ready));
    frontend = prepared.frontend;
    assert(frontend.exitCode === null && frontend.signalCode === null, "ACTUAL_MOUNTED_FRONTEND_STOPPED");
    const frontendManifest = prepared.manifest;
    frontend.once("exit", () => { if (!completed) { failure = Error("ACTUAL_MOUNTED_FRONTEND_STOPPED"); finish(); } });
    await p.startWorker();
    const privateFile = join(p.privateDirectory, "mounted-private-fixture.json");
    const alternateIdentity = p.service.additionalIdentities.find(value => value.actor === p.alternate)!;
    const foreignIdentity = p.service.additionalIdentities.find(value => value.actor === p.foreign)!;
    const participantIdentity = p.service.additionalIdentities.find(value => value.actor === p.participant)!;
    await writeFile(privateFile, JSON.stringify({ frontendOrigin: origin.origin, evidence: p.evidence, workId: p.workId,
      participantOnly: Boolean(p.participantOnly),
      ...(!p.participantOnly ? { roleRevalidation: { userId: p.principal, tenantId: p.tenant,
        authOrigin: p.service.authOrigin, anonKey: "disposable-local-auth",
        pendingUrl: origin.origin + "/centropy/investigations/" + empty.id + "?root=" +
          encodeURIComponent(JSON.stringify(root)) } } : {}),
      url: origin.origin + "/centropy/investigations/" + thread.id,
      otherUrl: origin.origin + "/centropy/investigations/" + empty.id,
      owner: { email: p.service.email, password: p.service.password },
      participant: { email: participantIdentity.email, password: participantIdentity.password, workId: p.participantWorkId,
        url: origin.origin + "/centropy/workforce?workId=" + p.participantWorkId, expectedOwnAssignments: 2, expiryPurpose },
      alternate: { email: alternateIdentity.email, password: alternateIdentity.password,
        url: origin.origin + "/centropy/investigations/" + alternate.id },
      foreign: { email: foreignIdentity.email, password: foreignIdentity.password,
        url: origin.origin + "/centropy/investigations/" + foreign.id },
      controlOrigin: "http://127.0.0.1:" + address.port, controlKey: key }), { flag: "wx", mode: 0o600 });
    await save("mounted-ready.json", { privateFile, url: origin.origin + "/centropy/investigations/" + thread.id,
      workId: p.workId, frontendPid: frontend.pid, compiled: Boolean(p.frontendInstallation),
      frontendSource: frontendManifest?.source ?? null, credentialsInPublicEvidence: false });
    console.log(JSON.stringify({ event: "W2_MOUNTED_FIXTURE_READY", privateFile, evidence: p.evidence }));
    await finished;
    if (failure) throw failure;
    assert(completed, "ACTUAL_BROWSER_COMPLETION_REQUIRED");
    return { status: "PASS", actualMountedSubmitAndReadback: !p.participantOnly, compiled: Boolean(p.frontendInstallation),
      profile: p.participantOnly ? "FOCUSED_PARTICIPANT_EXPIRY_ORIGINAL_SIX_NOT_RUN" : "ORIGINAL_COMPLETE_MOUNTED",
      genuineHumanQualified: false, browserEvidence: "mounted-browser-report.json" };
  } catch (error) {
    fixtureFailed = true; throw error;
  } finally {
    let cleanupFailure: unknown = null;
    if (roleDeadlineNs !== null) {
      try { await restoreRole(); } catch (error) { cleanupFailure = error; }
    }
    try {
      p.gate.release(); control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve()));
      await prepared?.stop();
    } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure) {
      await save("mounted-role-cleanup-refusal.json", { restored: false, mutationTerminal: roleMutationTerminal,
        noPendingMutation: roleSqlPending === 0, firstFailurePreserved: fixtureFailed,
        code: "CANONICAL_ROLE_CLEANUP_UNCONFIRMED" }).catch(() => {});
      if (!fixtureFailed) throw cleanupFailure;
    }
  }
}
