/** Owning-boundary E2E, not post-code unit tests. Every result comes through
 * authenticated HTTP, actual PostgreSQL/queue/worker and canonical owners.
 * Original-input expectations are recorded before their case executes.
 * CONTROLLED reports are never credited as people, meals, safety or elapsed days. */
import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, appendFile, readdir, statfs, chmod, lstat, realpath } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { mountedResponseBarrier, mountedServiceProof } from "./mounted.mts";
import { NATIVE_WORKER_LIMITS } from "./worker-protocol.mts";

const args = process.argv.slice(2), value = (name: string) => args[args.indexOf(name) + 1];
const outputArg = (args.includes("--output") ? value("--output") : "") ?? "";
assert(isAbsolute(outputArg), "A new absolute --output evidence directory is required");
const workspace = resolve(import.meta.dirname, "../../.."), repo = dirname(workspace), output = resolve(outputArg);
assert.equal(process.cwd(), workspace, "Run from the explicit finnor-os workspace");
const installationArg = args.includes("--installation") ? value("--installation") : undefined;
assert(!args.includes("--installation") || typeof installationArg === "string", "An absolute --installation path is required");
const installation = installationArg ? resolve(installationArg) : null;
let installedDescriptor: any = null;
let installedCustody: (() => any) | null = null;
if (installation) {
  assert(installationArg && isAbsolute(installationArg) && installation === repo, "Run the installed driver inside its own installation");
  installedDescriptor = JSON.parse(await readFile(join(installation, "finnor-os/w3-development-installation.json"), "utf8"));
  assert.equal(installedDescriptor.schema, "finnor.w3.development-installation.v1");
  const compatibility = await readFile(join(installation, installedDescriptor.compatibilityManifest.path));
  assert.equal(createHash("sha256").update(compatibility).digest("hex"), installedDescriptor.compatibilityManifest.sha256);
  const guard = createRequire(join(workspace, "package.json"))("@finnor/source-custody/installation.cjs");
  installedCustody = () => guard.installedRuntime(true);
  assert.equal(installedCustody!().manifestDigest, installedDescriptor.compatibilityManifest.sha256);
}
await mkdir(dirname(output), { recursive: true }); await mkdir(output);
const start = performance.now(), startedAt = new Date().toISOString(), results: any[] = [], traffic: unknown[] = [];
let written = 0, terminalExit = 0;
const artifact = async (name: string, body: unknown) => {
  const path = resolve(output, name); assert(path.startsWith(output + "/"));
  const data = JSON.stringify(body, (key, v) =>
    /^(claim_token|claimToken)$/.test(key) && typeof v === "string"
      ? "sha256:" + createHash("sha256").update(v).digest("hex") : v, 2) + "\n";
  written += Buffer.byteLength(data);
  assert(written <= 6 * 1024 ** 3, "W3 evidence disk bound");
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, data);
  return path;
};
const fast = args.includes("--fast");
const pauseChallenge = args.includes("--pause-challenge");
assert(!pauseChallenge || fast && !installation, "The focused pause challenge requires the source fast path");
const acceptanceChallenge = args.includes("--acceptance-challenge");
const observationsChallenge = args.includes("--observations-challenge");
const resourceChallenge = args.includes("--resource-challenge");
const currentnessChallenge = args.includes("--currentness-challenge");
const publicationChallenge = args.includes("--publication-challenge");
const dependencyChallenge = args.includes("--dependency-challenge");
const cancellationChallenge = args.includes("--cancellation-challenge");
const cancellationSampleArg = args.includes("--cancellation-sample") ? value("--cancellation-sample") : "0";
assert(/^[0-7]$/.test(cancellationSampleArg ?? "") && (!args.includes("--cancellation-sample") || cancellationChallenge),
  "Cancellation challenge requires an original sample from0through7");
const cancellationSample = Number(cancellationSampleArg);
const resourceSampleArg = args.includes("--resource-sample") ? value("--resource-sample") : "7";
assert(/^[0-7]$/.test(resourceSampleArg ?? "") && (!args.includes("--resource-sample") || resourceChallenge),
  "Resource challenge requires an original sample from0through7");
const resourceSample = Number(resourceSampleArg);
const resourceLimit = [4, 8, 16, 32, 64, 128, 256, 512][resourceSample]!;
assert(!resourceChallenge || !fast && !installation && !pauseChallenge && !acceptanceChallenge && !observationsChallenge,
  "The focused resource challenge requires a full-bound source owner");
assert(!acceptanceChallenge || !installation, "The focused acceptance challenge requires source owners");
const largeBasis = args.includes("--large-basis");
assert(!largeBasis || !fast && !acceptanceChallenge && !observationsChallenge && !resourceChallenge,
  "The complete large-basis journey requires the full native path");
const serviceOriginals = {
  COOK_CONTINUITY: { label: "cook continuity", unit: "meal", value: "1", instance: "meal-day" },
  FACILITY_REPAIR: { label: "facility repair", unit: "repair_visit", value: "2", instance: "repair-visit" },
  INVENTORY_REPLENISHMENT: { label: "inventory replenishment", unit: "item", value: "12.5", instance: "custody-delivery" },
  EQUIPMENT_ONBOARDING: { label: "equipment onboarding", unit: "equipment_kit", value: "3", instance: "onboarding-kit" },
  CUSTOMER_RECOVERY: { label: "customer service recovery", unit: "service_case", value: "4", instance: "recovery-service" },
  TRAVEL_EVENT_SITE: { label: "travel event site service", unit: "site_service", value: "6", instance: "site-service" },
  RECURRENT_SERVICE: { label: "recurrent service", unit: "service_visit", value: "1", instance: "recurrent-visit" },
} as const;
const familyArg = args.includes("--family") ? value("--family") : "COOK_CONTINUITY";
assert(typeof familyArg === "string" && Object.hasOwn(serviceOriginals, familyArg), "A supported original --family is required");
const family = familyArg as keyof typeof serviceOriginals, serviceOriginal = serviceOriginals[family];
assert(!dependencyChallenge || family === "FACILITY_REPAIR" && !fast && !installation && !resourceChallenge,
  "The native prerequisite challenge requires a full facility-repair source journey");
const sensory = family === "COOK_CONTINUITY";
const invoiceChallengeArg = args.includes("--invoice-challenge") ? value("--invoice-challenge") : undefined;
assert(!args.includes("--invoice-challenge") || typeof invoiceChallengeArg === "string" && /^[0-7]$/.test(invoiceChallengeArg),
  "Invoice challenge requires a sample from 0 through 7");
const invoiceChallenge = invoiceChallengeArg === undefined ? null : Number(invoiceChallengeArg);
assert(!fast || invoiceChallenge === null, "The invoice challenge requires the full owning-boundary path");
const commitmentChallenge = args.includes("--commitment-challenge");
assert(!commitmentChallenge || !fast && invoiceChallenge === null && !installation,
  "The historical-terms counterexample currently requires the full source-owning path");
assert(!dependencyChallenge || !commitmentChallenge && invoiceChallenge === null,
  "The prerequisite journey retains its own original terms and invoice plan");
assert(!dependencyChallenge || !acceptanceChallenge && !observationsChallenge && !largeBasis,
  "The prerequisite journey must complete its own original acceptance path");
assert(!resourceChallenge || !commitmentChallenge && invoiceChallenge === null && !dependencyChallenge,
  "The focused resource journey retains its own original allocation");
assert(!cancellationChallenge || family === "RECURRENT_SERVICE" && !fast && !installation
  && !resourceChallenge && !dependencyChallenge && !commitmentChallenge && invoiceChallenge === null
  && !acceptanceChallenge && !observationsChallenge && !largeBasis,
  "The accepted-provider cancellation challenge requires a full recurrent-service source journey");
assert(!currentnessChallenge || !fast && !installation && !pauseChallenge && !acceptanceChallenge
  && !observationsChallenge && !resourceChallenge && !dependencyChallenge && !cancellationChallenge
  && !commitmentChallenge && invoiceChallenge === null && !largeBasis,
  "The source currentness challenge requires its own full-bound multi-policy owner journey");
assert(!publicationChallenge || !fast && !installation && !pauseChallenge && !acceptanceChallenge
  && !observationsChallenge && !resourceChallenge && !dependencyChallenge && !cancellationChallenge
  && !commitmentChallenge && invoiceChallenge === null && !largeBasis && !currentnessChallenge,
  "The delayed-publication challenge requires its own full-bound source owner journey");
const loopDelay = monitorEventLoopDelay({ resolution: 20 }); loopDelay.enable();
const sqlStatistics = new Map<string, { count: number; elapsedMs: number; errors: number }>();
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function(this: pg.Client, ...parameters: any[]) {
  const sql = typeof parameters[0] === "string" ? parameters[0] : parameters[0]?.text;
  const key = typeof sql === "string" ? createHash("sha256").update(sql).digest("hex") : "unavailable";
  const began = performance.now();
  const result = Reflect.apply(originalQuery, this, parameters);
  if (result && typeof result.then === "function" && (sqlStatistics.has(key) || sqlStatistics.size < 4096)) {
    const row = sqlStatistics.get(key) ?? { count: 0, elapsedMs: 0, errors: 0 };
    sqlStatistics.set(key, row); row.count++;
    void result.then(() => { row.elapsedMs += performance.now() - began },
      () => { row.elapsedMs += performance.now() - began; row.errors++ });
  }
  return result;
} as typeof originalQuery;
let httpOrdinal = 0;
const maxSeconds = fast ? 120 : 1200;
const checkBound = () => assert(performance.now() - start < maxSeconds * 1000, "W3 run wall bound");
const run = async (id: string, input: unknown, expected: unknown, action: () => Promise<unknown>) => {
  checkBound(); await artifact("cases/" + id + "-original.json", { input, expected, frozenAt: new Date().toISOString() });
  try { const observed = await action(); results.push({ id, status: "PASS", observed });
    await artifact("cases/" + id + "-observed.json", { observed, elapsedMs: performance.now() - start });
    console.log(JSON.stringify({ id, status: "PASS" })); return observed;
  } catch (error) {
    const observed = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    results.push({ id, status: "FAIL", observed }); await artifact("cases/" + id + "-observed.json", observed); throw error;
  }
};
const space = await statfs(output);
assert(BigInt(space.bavail) * BigInt(space.bsize) >= 4n * 1024n ** 3n, "W3 minimum free disk");
Object.assign(process.env, {
  NODE_ENV: "test", CI: "1", LOG_LEVEL: "error", AUTH_DEV_BYPASS: "0",
  FINNOR_ENVIRONMENT: "staging", FINNOR_W3_PROFILE: "ordinary_disposable", FINNOR_P4_PROFILE: "ordinary_disposable",
  FINNOR_TEST_MANAGED_EXTENSIONS: "omit", RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
  FINNOR_S3_PYTHON: installation ? join(installation, installedDescriptor.entrypoints.s3Python)
    : process.env.FINNOR_S3_PYTHON ?? resolve(workspace, ".w3-venv/bin/python"),
  FINNOR_S5_PYTHON: installation ? join(installation, installedDescriptor.entrypoints.s5Python)
    : process.env.FINNOR_S5_PYTHON ?? resolve(workspace, ".w3-s5-venv/bin/python"),
  FINNOR_S3_MODEL_STORE: join(output, "ordinary-models"), FINNOR_S4_POLICY_STORE: join(output, "ordinary-policies"),
  WORKER_JOB_LEASE_SECONDS: "5", FINNOR_STEP_LEASE_SECONDS: "5",
});
delete process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG; delete process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT;
const port = await new Promise<number>((accept, reject) => {
  const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port; s.close(() => accept(p));
  });
});
const pgDirectory = join(output, "disposable-postgres"), adminPassword = randomUUID(), appPassword = randomUUID(), workerPassword = randomUUID();
const postgres = new EmbeddedPostgres({ databaseDir: pgDirectory, user: "w3_admin", password: adminPassword,
  port, persistent: false, onLog: () => undefined });
let admin: pg.Client | null = null, auth: any = null, recipient: any = null, activeWorker: ChildProcess | null = null;
let closePool: (() => Promise<void>) | null = null;
const workers: any[] = [];
try {
  await postgres.initialise(); await appendFile(join(pgDirectory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  await postgres.start(); await postgres.createDatabase("w3_service");
  const adminUrl = `postgres://w3_admin:${adminPassword}@127.0.0.1:${port}/w3_service`;
  const { migrate } = installation
    ? await import(pathToFileURL(join(installation, installedDescriptor.entrypoints.migrations)).href)
    : await import("../../../packages/db/migrate");
  const migrationNames: string[] = await migrate(adminUrl);
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD '" + appPassword + "'");
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD '" + workerPassword + "'");
  const workerDatabaseUrl = `postgres://finnor_worker:${workerPassword}@127.0.0.1:${port}/w3_service`;
  process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${port}/w3_service`;
  const db = await import("@finnor/db"); closePool = db.closePool;
  const { hash, canonical, optionTerms } = await import("../../../packages/private-equity/src/real-world-service/contracts");
  const { serviceIdentity } = await import("../../../packages/private-equity/src/real-world-service/identity");
  const { serviceExecutionRecordKey } = await import("../../../packages/private-equity/src/real-world-service/consumer");
  const { authenticatedApiFixture } = await import("../../frontier5/x1/authenticated-api-fixture.mts");
  const { createUpstreamFixtureSupport } = await import("../../s5/owner-fixture.mts");
  const { POST: allocationPost } = await import("../../../apps/api/app/api/allocations/[operation]/route");
  const { POST: policyPost } = await import("../../../apps/api/app/api/policies/[operation]/route");
  const { POST: obligationPost } = await import("../../../apps/api/app/api/obligations/[operation]/route");
  const { serviceRecipient } = await import("./recipient.mts");
  const tenant = randomUUID(), owner = randomUUID(), provider = randomUUID(), backup = randomUUID();
  const inspector = randomUUID(), evaluator = randomUUID(), unrelated = randomUUID(), foreign = randomUUID(), otherTenant = randomUUID();
  const actors = [owner, provider, backup, inspector, evaluator, unrelated, foreign];
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'W3 controlled enterprise'),($3,$4,'W3 foreign enterprise')",
    [tenant, randomUUID(), otherTenant, randomUUID()]);
  for (const actor of actors) await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status)
   VALUES($1,$2,$3,'owner','active')`, [actor, actor === foreign ? otherTenant : tenant, actor + "@test.invalid"]);
  await db.configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0,
    createdBy: owner, sourceSystem: "w3:controlled-verification" });
  await db.configureTenantVertical({ tenantId: otherTenant, verticalKey: "private_equity", expectedVersion: 0,
    createdBy: foreign, sourceSystem: "w3:controlled-verification" });
  process.env.FINNOR_W3_TENANT = tenant;
  const mountedBarrier = mountedResponseBarrier();
  auth = await authenticatedApiFixture(repo, owner, (row: unknown) => traffic.push(row),
    { additionalActors: actors.slice(1), maximumActors: 8, ...(installation ? { installation } : {}),
      afterResponse: async (path, body, status, request) => {
        if (status >= 400) traffic.push({ event: "W3_API_REFUSAL", path, status, body: JSON.parse(body) });
        await mountedBarrier.afterResponse(path, body, status, request);
      } });
  const clockAdvances: unknown[] = [];
  const setServiceClock = async (at: string) => {
    process.env.FINNOR_W3_CONTROLLED_NOW = at;
    const restart = installation ? await auth.restartCompiled() : null;
    clockAdvances.push({ logicalServiceAt: at, actualWallAt: new Date().toISOString(), restart,
      qualification: "CONTROLLED_SERVICE_CLOCK_NOT_AUTH_LEASES_OR_ELAPSED_FIELD_SERVICE" });
  };
  const tokens = new Map<string, string>([[owner, auth.token]]);
  for (const identity of auth.additionalIdentities) {
    const signedIn = await fetch(auth.authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ email: identity.email, password: identity.password }) });
    assert.equal(signedIn.status, 200); tokens.set(identity.actor, (await signedIn.json()).access_token);
  }
  const http = async (group: string, operation: string, body: unknown, actor: string = owner) => {
    checkBound();
    const ordinal = ++httpOrdinal, began = performance.now(), wall = Date.now(), cpu = process.cpuUsage();
    const baseline = new Map([...sqlStatistics].map(([key, value]) => [key, { ...value }]));
    loopDelay.reset(); let status: number | null = null;
    try {
      const r = await fetch(`${auth.origin}/api/${group}/${operation}`, { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + tokens.get(actor) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      status = r.status;
      return { status, body: await r.json() as any };
    } finally {
      const used = process.cpuUsage(cpu);
      await artifact("api-phases/" + String(ordinal).padStart(4, "0") + ".json", {
        group, operation, status, elapsedMs: performance.now() - began, wallElapsedMs: Date.now() - wall,
        parentProcessCpuMicroseconds: used.user + used.system, maximumEventLoopDelayMs: loopDelay.max / 1e6,
        sql: [...sqlStatistics].map(([digest, current]) => ({ digest,
          count: current.count - (baseline.get(digest)?.count ?? 0),
          elapsedMs: current.elapsedMs - (baseline.get(digest)?.elapsedMs ?? 0),
          errors: current.errors - (baseline.get(digest)?.errors ?? 0) })).filter(q => q.count || q.elapsedMs),
        diagnosticScope: "LOCAL_PROCESS_INTERVAL_INCLUDING_ANY_CONCURRENT_ACTIVITY_NO_SQL_TEXT_OR_CREDENTIALS",
      });
    }
  };
  const ok = async (group: string, operation: string, body: unknown, actor: string = owner) => {
    const result = await http(group, operation, body, actor);
    assert.equal(result.status, 200, JSON.stringify({ group, operation, ...result })); return result.body;
  };
  const source = (workId: string, body: unknown, key: string, actor: string = owner, protocolId: string | null = null) =>
    ok("real-world-services", "source", { workId, body, idempotencyKey: key, purpose: "Controlled W3 service verification", protocolId }, actor);
  const tick = async (expectKill = false, maximumTicks = 1,
    fault?: { mutate: () => Promise<void>; expectedRefusal?: string },
    schedule?: () => Promise<boolean>) => {
    checkBound();
    assert(Number.isSafeInteger(maximumTicks) && maximumTicks >= 1 && maximumTicks <= NATIVE_WORKER_LIMITS.maximumTicks);
    assert(!expectKill || maximumTicks === 1, "The physical payment kill remains a single tick");
    assert(!schedule || !expectKill && !fault && !installation, "W3_SCHEDULING_IS_SOURCE_VERIFICATION_ONLY");
    const workerArgs = installation ? [join(installation, installedDescriptor.entrypoints.w3Worker)]
      : ["--import=tsx", "scripts/postz/w3/worker.mts"];
    const p = spawn(process.execPath, [...workerArgs, "--maximum-ticks", String(maximumTicks),
      ...(schedule ? ["--parent-gated"] : [])], {
      cwd: workspace, env: { ...process.env, DATABASE_URL: workerDatabaseUrl,
        ...(installation ? { FINNOR_W3_INSTALLED: "1" } : {}),
        NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: schedule ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] });
    activeWorker = p; let log = "", pending = "";
    const observationLines: string[] = [];
    let mutation: Promise<void> | null = null, faultError: unknown, pause: unknown = null;
    let scheduling: Promise<void> | null = null, schedulingError: unknown;
    let nextSchedulingTick = 0;
    if (schedule) p.on("message", message => {
      scheduling = (async () => {
        try {
          const ready = message as any;
          assert.equal(ready?.schema, "finnor.w3.worker-ready.v1");
          assert.equal(ready.pid, p.pid); assert.equal(ready.tick, nextSchedulingTick++);
          const proceed = await schedule();
          assert(p.connected, "W3_WORKER_SCHEDULING_CHANNEL_CLOSED");
          p.send!({ schema: "finnor.w3.worker-scheduling.v1", tick: ready.tick,
            action: proceed ? "CONTINUE" : "STOP" });
        } catch (error) { schedulingError = error; p.kill("SIGTERM") }
      })();
    });
    const observationPrefix = '{"schema":"finnor.w3.worker-observation.v1",';
    p.stdout!.on("data", b => {
      log += b; pending += b;
      if (log.length > 8388608) { p.kill("SIGKILL"); return }
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith(observationPrefix)) continue;
        observationLines.push(line);
        if (!fault || mutation) continue;
        mutation = (async () => {
          try {
            const first = JSON.parse(line);
            assert.equal(first.pid, p.pid); assert.equal(first.tick, 0); assert.equal(first.worked, true);
            assert(p.kill("SIGSTOP"), "W3_OWNED_WORKER_PAUSE_FAILED");
            if (process.platform === "linux") {
              const probeBegan = performance.now(), path = `/proc/${p.pid}/status`;
              const samples: Array<{ pid: number; parentPid: number; state: string; elapsedMs: number }> = [];
              while (performance.now() - probeBegan < 5000) {
                const status = await readFile(path, "utf8");
                const pid = Number(/^Pid:\s+(\d+)$/m.exec(status)?.[1]);
                const parentPid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
                const state = /^State:\s+([A-Za-z])\s/m.exec(status)?.[1] ?? "";
                assert.equal(pid, p.pid, "W3_OWNED_WORKER_PAUSE_PID_CHANGED");
                assert.equal(parentPid, process.pid, "W3_OWNED_WORKER_PAUSE_PARENT_CHANGED");
                assert(p.exitCode === null && p.signalCode === null, "W3_OWNED_WORKER_EXITED_BEFORE_PAUSE");
                samples.push({ pid, parentPid, state, elapsedMs: performance.now() - probeBegan });
                if (state === "T") break;
                await new Promise(done => setTimeout(done, 10));
              }
              assert.equal(samples.at(-1)?.state, "T", "W3_OWNED_WORKER_NOT_PAUSED:" + JSON.stringify(samples));
              pause = { pid: p.pid, signal: "SIGSTOP", state: "T(/proc/status)", at: new Date().toISOString(),
                probe: { path, boundMs: 5000, samples } };
            } else {
            assert.equal(process.platform, "darwin", "W3_UNSUPPORTED_KERNEL_PAUSE_OBSERVER");
            // /bin/ps cannot execute under the verification sandbox on this host
            // (deterministic EPERM on the entitled binary itself, even copied to
            // /tmp; explicit seatbelt allowances do not override it; measured in
            // w3-ps-state-diagnostic-001 and w3-sandbox-exec-matrix-001). Probe the
            // kernel stopped state with proc_pidinfo(PROC_PIDTBSDINFO) instead:
            // proc_bsdinfo.pbi_status 4 = SSTOP, 2 = SRUN (w3-procpidinfo-probe-002).
            // The probe cwd must stay outside the denied donor prefixes because
            // python importlib stats sys.path[0] (w3-python-sandbox-imports-001).
            const pauseProbe = "import ctypes,sys,struct\n"
              + "libc=ctypes.CDLL(None)\n"
              + "buf=ctypes.create_string_buffer(256)\n"
              + "n=libc.proc_pidinfo(int(sys.argv[1]),3,0,buf,256)\n"
              + "print(str(n)+\":\"+(str(struct.unpack_from(\"<I\",buf,4)[0]) if n>0 else \"-1\"))";
            const probeBegan = performance.now();
            const state = spawnSync("/usr/bin/python3", ["-c", pauseProbe, String(p.pid)],
              { encoding: "utf8", timeout: 5000, cwd: workspace });
            const probe = { pid: p.pid, status: state.status, signal: state.signal,
              error: state.error ? String((state.error as NodeJS.ErrnoException).code || state.error.message || state.error) : null,
              stdout: (state.stdout || "").trim(), stderr: (state.stderr || "").trim().slice(0, 400),
              elapsedMs: performance.now() - probeBegan };
            assert.equal(state.status, 0, "W3_OWNED_WORKER_PAUSE_PROBE_FAILED:" + JSON.stringify(probe));
            const [probeBytes, processState] = probe.stdout.split(":");
            assert.equal(probeBytes, "136", "W3_OWNED_WORKER_PAUSE_PROBE_MALFORMED:" + JSON.stringify(probe));
            assert.equal(processState, "4", "W3_OWNED_WORKER_NOT_PAUSED:" + JSON.stringify(probe));
            pause = { pid: p.pid, signal: "SIGSTOP", state: "SSTOP(proc_pidinfo)", at: new Date().toISOString(), probe };
            }
            await fault.mutate();
          } catch (error) { faultError = error }
          finally { p.kill("SIGCONT") }
        })();
      }
    });
    p.stderr!.on("data", b => { log += b; if (log.length > 8388608) p.kill("SIGKILL") });
    const began = performance.now();
    let result: any;
    try {
      result = await new Promise<any>((accept, reject) => {
        let timedOut = false, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          timedOut = true; p.kill("SIGKILL");
          // Cleanup observation only; a timed-out process can never pass.
          cleanupTimer = setTimeout(() => reject(Error("W3_KILLED_WORKER_CLOSE_NOT_OBSERVED:" + log)), 2000);
        }, NATIVE_WORKER_LIMITS.processMilliseconds);
        p.once("error", error => { clearTimeout(timer); clearTimeout(cleanupTimer); reject(error) });
        p.once("close", (code, signal) => {
          clearTimeout(timer); clearTimeout(cleanupTimer);
          if (timedOut) reject(Error("W3_WORKER_TIME_BOUND:" + log));
          else accept({ pid: p.pid, code, signal, log });
        });
      });
    } finally { if (mutation) await mutation; if (scheduling) await scheduling }
    const observations = observationLines.map(line => JSON.parse(line));
    Object.assign(result, { observations, ticks: observations.length, elapsedMs: performance.now() - began, pause });
    activeWorker = null; workers.push(result); await artifact("workers/" + workers.length + ".json", result);
    if (faultError) throw faultError;
    if (schedulingError) throw schedulingError;
    if (expectKill) assert.equal(result.signal, "SIGKILL", log);
    else {
      assert(observations.length >= 1 && observations.length <= maximumTicks, "W3_WORKER_OBSERVATION_COUNT_REQUIRED");
      observations.forEach((entry, ordinal) => {
        assert.equal(entry.pid, p.pid); assert.equal(entry.tick, ordinal); assert.equal(typeof entry.worked, "boolean");
        assert.equal(entry.registration, "ACTUAL_PRODUCTION_CREATE_WORKER");
        assert.equal(entry.role.current_user, "finnor_worker");
        assert.equal(entry.role.rolsuper, false); assert.equal(entry.role.rolbypassrls, false);
      });
      if (fault) {
        assert(pause && mutation, "W3_ACTUAL_BETWEEN_TICK_MUTATION_REQUIRED");
        if (fault.expectedRefusal) {
          assert.notEqual(result.code, 0); assert.notEqual(result.code, null); assert.equal(result.signal, null);
          assert(log.includes(fault.expectedRefusal), log);
          assert.equal(observations.length, 1, "W3_DRIFT_MUST_REFUSE_BEFORE_ANOTHER_TICK");
        } else assert.equal(result.code, 0, log);
      } else assert.equal(result.code, 0, log);
    }
    return result;
  };
  const pump = async (maximum: number = NATIVE_WORKER_LIMITS.maximumTicks) => {
    assert(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= NATIVE_WORKER_LIMITS.maximumTicks);
    for (let ticks = 0; ticks < maximum;) {
      const pending = (await admin!.query(`SELECT count(*)::int n,min(run_at) due FROM finnor_os.jobs
       WHERE tenant_id=$1 AND status='queued'
        AND type IN('compile_real_world_service_v1','advance_real_world_service_v1','run_workflow_step_v3')`, [tenant])).rows[0];
      if (!pending.n) return;
      const delay = Math.max(0, (pending.due as Date).getTime() - Date.now());
      assert(delay <= 30000, "W3_QUEUE_CONTINUATION_NOT_DUE_WITHIN_BOUND");
      if (delay) await new Promise(done => setTimeout(done, delay + 25));
      const result = await tick(false, maximum - ticks);
      ticks += result.ticks;
    }
    throw Error("W3_FINITE_QUEUE_PUMP_BOUND");
  };
  const generated = spawnSync(process.env.FINNOR_S3_PYTHON!, ["-I", "-B", "scripts/s3/reference.py"], {
    cwd: workspace, input: JSON.stringify({ operation: "equivalent" }), encoding: "utf8", timeout: 30000 });
  assert.equal(generated.status, 0, generated.stderr);
  const day = 86400000, begin = new Date(Date.now() - 128 * day).toISOString();
  const fixtures: Record<string, any> = {};
  const native = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: JSON.parse(generated.stdout).rows,
    begin, day, fixtures, artifact, api: (f: any, op: string, body: unknown, handler = allocationPost) =>
      http(handler === policyPost ? "policies" : handler === obligationPost ? "obligations" : handler === allocationPost ? "allocations" : "interventions", op, body) });
  let intake: any = null;
  const alternateCompanyId = randomUUID();
  const f = await native.fixture("w3-controlled-" + randomUUID().slice(0, 8), 1, [
    { id: "cash", unit: "USD", capacity: 100, totalLimit: 100 },
    { id: "execution", unit: "request", capacity: 512, totalLimit: 512, resourceClass: "COMPUTE" },
    { id: "human", unit: "seconds", capacity: 900, totalLimit: 900, resourceClass: "HUMAN_ATTENTION" },
  ], { identity: { tenant, principal: owner }, operation: "SERVICE_TRANSITION_V1", exposureUnit: "service_transition",
    context: "controlled-service-transition-not-physical-qualification",
    beforeFit: async original => {
      await admin!.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
       VALUES($1,$2,$3,'W3 alternate controlled company','other')`, [alternateCompanyId, tenant, "w3-alternate-" + randomUUID()]);
      intake = await ok("real-world-services", "intake", { companyId: original.root.entityId,
        idempotencyKey: "original-service-week",
        instruction: `Maintain one seven-day ${serviceOriginal.label} assignment, independently observe each ${serviceOriginal.unit}, retain failures and separately reconcile invoices and temporary access. This is a controlled software experiment, not real service.` });
    } });
  assert(intake?.workId && intake.workInputId, "W3_ORIGINAL_CANONICAL_WORK_BEFORE_MODEL_REQUIRED");
  const policyByOperation: Record<string, any> = {};
  for (const op of fast || resourceChallenge ? ["OFFER"] : dependencyChallenge
    ? ["OFFER", "BOOK_PREDECESSOR", "BOOK", "RETIRE_PREDECESSOR", "RETIRE_ACCESS", "PAY"]
    : cancellationChallenge ? ["OFFER", "BOOK", "CANCEL", "RETIRE_PRIMARY", "BACKUP_OFFER", "BACKUP_BOOK", "RETIRE_ACCESS", "PAY"]
    : ["OFFER", "BOOK", "RETIRE_ACCESS", "PAY", ...(commitmentChallenge ? ["OLD_OFFER"] : [])])
    policyByOperation[op] = await native.policy(f, op, fast || resourceChallenge
      ? { cash: 100, execution: resourceChallenge ? resourceLimit : 512, human: 900 } : dependencyChallenge
        ? { cash: op === "OFFER" ? 20 : 16, execution: op === "OFFER" ? 87 : 85, human: 150 }
        : cancellationChallenge ? { cash: op === "OFFER" ? 16 : 12, execution: 64, human: op === "OFFER" ? 116 : 112 } : commitmentChallenge
        ? { cash: 20, execution: 102, human: 180 } : { cash: 25, execution: 128, human: 225 });
  await native.resource(f, "cash", "USD", "STOCK", ["100", "100"]);
  await native.resource(f, "execution", "request", "CUMULATIVE_EXPENDITURE", ["512", "512"]);
  await native.resource(f, "human", "seconds", "CUMULATIVE_EXPENDITURE", ["900", "900"]);
  const clearing = await ok("allocations", "clear", native.clearing(f,
    Object.fromEntries(Object.keys(policyByOperation).map(op => [op, ["100"]]))));
  assert.equal(clearing.status, "FEASIBLE", JSON.stringify(clearing));
  const parentAllocation = clearing.certificate.ref;
  const scope = { tenantId: tenant, principalId: owner, companyId: f.root.entityId, workId: intake.workId,
    businessAssignmentId: "original-seven-day-service" };
  const firstDay = Math.floor(Date.now() / day) * day + (publicationChallenge ? -7 * day : day);
  const deadline = new Date(firstDay + 8 * day).toISOString();
  const trigger = (await source(intake.workId, { schema: "finnor.service-trigger.v1", scope, kind: "EXPLICIT_OUTCOME",
    description: `Controlled original seven-day ${serviceOriginal.label} instruction; no actual person, tasting, safety judgement, purchase or elapsed service is asserted.`,
    occurredAt: new Date().toISOString(), basis: [] }, "original-trigger")).source;
  const mandate = (await source(intake.workId, { schema: "finnor.service-mandate.v1", scope,
    authorizedByPrincipalId: owner, purpose: "Controlled W3 service verification",
    permittedOperations: ["OFFER", "TRIAL", "BOOK", "ACCESS", "CANCEL", "PAY", "RETIRE_ACCESS"],
    validFrom: new Date(Date.now() - 1000).toISOString(), expiresAt: deadline, revoked: false,
    originalTrigger: "EXPLICIT_OUTCOME", eventSource: null }, "separate-mandate")).source;
  const obligations: Record<string, any> = {}, handoffs: Record<string, any> = {};
  // S4 forbids making a new choice while an existing effect is outstanding.
  // Obtain the original jointly allocated programme's preparations before any
  // S6 effect exists. Later execution still rechecks each W3 prerequisite.
  for (const [op, policy] of Object.entries(policyByOperation)) {
    handoffs[op] = await ok("policies", "handoff", { policyRef: policy.ref, allocationRef: parentAllocation,
      decision: native.decision(f, parentAllocation) });
  }
  await artifact("original-native-preparations.json", { parentAllocation, handoffs,
    effectCountBeforePreparation: (await admin.query("SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1", [tenant])).rows[0].n });
  for (const [op, handoff] of Object.entries(handoffs)) {
    obligations[op] = await ok("real-world-services", "prepare-native", { workId: intake.workId, mandateSource: mandate,
      preparationRef: handoff.preparationRef, allocationRef: parentAllocation, consumptionRef: handoff.consumptionRef });
    assert.equal(obligations[op].workLineage.workId, intake.workId);
  }
  const criteria = [
    { id: "readiness", phase: "READINESS", kind: "INSPECTION", qualificationIds: [] },
    { id: "trial-sensory", phase: "TRIAL", kind: "SENSORY", qualificationIds: [] },
    { id: "delivered-event", phase: "SERVICE", kind: "OBSERVED_EVENT", qualificationIds: [] },
    { id: "daily-sensory", phase: "SERVICE", kind: "SENSORY", qualificationIds: [] },
    { id: "qualified-process", phase: "SERVICE", kind: "PROFESSIONAL", qualificationIds: ["controlled-process"] },
    { id: "handback", phase: "HANDBACK", kind: "INSPECTION", qualificationIds: [] },
    { id: "retired-access", phase: "ACCESS_RETIREMENT", kind: "OBSERVED_EVENT", qualificationIds: [] },
    { id: "owner-verification", phase: "HANDBACK", kind: "ORIGINAL_ACCEPTANCE", qualificationIds: [] },
  ].filter(c => sensory || c.kind !== "SENSORY")
    .map(c => ({ ...c, hard: true, independentOfProvider: true, maximumAgeSeconds: 2678400,
      description: `Controlled ${serviceOriginal.label} ${c.id} assertion. No genuine sensory, professional or field qualification.` }));
  const demands = Array.from({ length: 7 }, (_, n) => ({
    id: serviceOriginal.instance + "-" + (n + 1), siteId: "site-a", localDate: new Date(firstDay + n * day).toISOString().slice(0, 10),
    startAt: new Date(firstDay + n * day + 10 * 3600000).toISOString(),
    endAt: new Date(firstDay + n * day + 11 * 3600000).toISOString(),
    quantity: { value: serviceOriginal.value, unit: serviceOriginal.unit }, criterionIds: criteria.map(c => c.id), prerequisites: [] as string[],
  }));
  if (dependencyChallenge) demands[1]!.prerequisites = [demands[0]!.id];
  const outcome: any = { schema: "finnor.service-outcome.v1", scope, family,
    enterpriseArchetype: "OPERATING_COMPANY", trigger: { kind: "EXPLICIT_OUTCOME", requesterId: owner, originalSource: trigger },
    originalMeaning: `One original seven-day ${serviceOriginal.label} result, not seven assignments.`, acceptanceOwnerId: owner,
    mandateSource: mandate, originalDeadlineAt: publicationChallenge ? new Date(Date.now() + 30000).toISOString() : deadline,
    fromDate: demands[0]!.localDate, throughDate: demands[6]!.localDate,
    sites: [{ id: "site-a", timeZone: "UTC" }], demands, criteria,
    disclosure: { purpose: "Controlled W3 service verification", operationalRequirements: ["Only exact service terms and needed observation criteria."],
      prohibitedData: ["unrelated-finances", "credentials", "private-messages"] }, currency: "USD",
    parentPolicy: obligations.OFFER.policyRef, parentAllocation, reservedDecisions: [],
    permittedOperations: ["OFFER", "TRIAL", "BOOK", "ACCESS", "CANCEL", "PAY", "RETIRE_ACCESS"],
    assumptions: ["Disposable software verification only. All service observations remain CONTROLLED."] };
  const outcomeRef = (await source(intake.workId, outcome, "original-outcome")).source;
  const submitted = await ok("real-world-services", "submit", { workId: intake.workId, workInputId: intake.workInputId,
    idempotencyKey: "original-week", outcomeSource: outcomeRef, providerSources: [],
    budgetObligationRef: obligations.OFFER.ref, s7EstimandId: null });
  const requestId = submitted.requestId;
  const read = async () => {
    const r = await ok("real-world-services", "read", { workId: intake.workId });
    assert.equal(r.scope.principalId, owner); return r.requests.find((r: any) => r.requestId === requestId);
  };
  await run("W004-read-is-not-activation", { workId: intake.workId }, { newRequests: 0, newEffects: 0 }, async () => {
    const counts = async () => (await admin!.query(`SELECT
     (SELECT count(*) FROM finnor_os.w3_service_requests WHERE tenant_id=$1)::int requests,
     (SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1)::int effects,
     (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs`, [tenant])).rows[0];
    const before = await counts(); await read(); const after = await counts(); assert.deepEqual(after, before);
    const attachments = (await admin!.query(`SELECT work_id,entity_type,entity_id,relationship,source
     FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2
      AND entity_type='external_organization' AND entity_id=$3`, [tenant, intake.workId, f.root.entityId])).rows;
    assert.equal(attachments.length, 1, "W3_ORIGINAL_COMPANY_CANONICAL_WORK_ATTACHMENT_REQUIRED");
    return { before, after, attachments };
  });
  const discover = await ok("real-world-services", "invite", { requestId, participantId: provider,
    instanceId: demands[0]!.id, providerId: provider, termsDigest: hash(outcome), role: "PROVIDER", criterionIds: [],
    permittedKinds: ["PROVIDER_EVIDENCE"], qualificationRefs: [], incentiveRef: null, expiresAt: outcome.originalDeadlineAt });
  await ok("real-world-services", "consent", { protocolId: discover.protocolId, revoke: false }, provider);
  const qualification = async (subject: string, key: string) => (await source(intake.workId, {
    schema: "finnor.service-qualification.v1", scope, subjectPrincipalId: subject, qualificationId: "controlled-process",
    process: "Controlled authenticated role/process example; not an actual safety credential.",
    verifiedByPrincipalId: owner, expiresAt: deadline, evidence: [trigger],
    limitations: ["CONTROLLED only. No person is certified professionally competent by this experiment."],
  }, key)).source;
  const providerQualification = await qualification(provider, "provider-controlled-qualification");
  const inspectorQualification = await qualification(inspector, "inspector-controlled-qualification");
  const providerBody: any = { schema: "finnor.service-provider-evidence.v1", scope, providerId: provider, reportingPrincipalId: provider,
    provisionKind: "TEMPORARY_PROVIDER", classification: "SERVICE_PROCUREMENT", classificationBasis: [trigger],
    lawfulDiscoveryBasis: [trigger], qualifications: [{ id: "controlled-process", validUntil: deadline,
      evidence: providerQualification, verifiedByPrincipalId: owner, limitation: "Controlled, not actual safety competence." }],
    availability: demands.map(d => ({ id: "availability-" + d.id, siteId: d.siteId, startAt: d.startAt, endAt: d.endAt,
      capacity: d.quantity, basis: trigger, validUntil: deadline })),
    quote: { revision: "quote-1", validUntil: deadline, cancellation: "Retain any actual costs and unresolved identities.",
      compensation: "Controlled record only; no actual purchase, hire, trial participant or payment.",
      acceptance: "This participant must explicitly accept these exact original terms.",
      perInstanceCosts: [{ id: "provider-price", category: "PROVIDER", amount: { currency: "USD", minor: "100" },
        basis: "QUOTE", evidence: [trigger], reason: "Controlled quote, not actual billing." }], unresolvedTerms: [] },
    evidenceValidUntil: deadline, claimsNotIndependentPhysicalTruth: true };
  const providerRef = (await source(intake.workId, providerBody, "provider-own-availability", provider, discover.protocolId)).source;
  let backupProviderRef: any = null, backupProviderBody: any = null;
  if (cancellationChallenge) {
    const backupQualification = await qualification(backup, "backup-controlled-qualification");
    const discovery = await ok("real-world-services", "invite", { requestId, participantId: backup,
      instanceId: demands[0]!.id, providerId: backup, termsDigest: hash(outcome), role: "PROVIDER", criterionIds: [],
      permittedKinds: ["PROVIDER_EVIDENCE"], qualificationRefs: [], incentiveRef: null, expiresAt: deadline });
    await ok("real-world-services", "consent", { protocolId: discovery.protocolId, revoke: false }, backup);
    backupProviderBody = structuredClone(providerBody);
    Object.assign(backupProviderBody, { providerId: backup, reportingPrincipalId: backup });
    backupProviderBody.qualifications[0].evidence = backupQualification;
    backupProviderBody.quote.revision = "backup-quote-1";
    backupProviderBody.quote.perInstanceCosts[0].amount.minor = "110";
    for (const availability of backupProviderBody.availability) availability.id = "backup-" + availability.id;
    backupProviderRef = (await source(intake.workId, backupProviderBody, "backup-own-availability",
      backup, discovery.protocolId)).source;
  }
  if (publicationChallenge) {
    await run("W007-delayed-publication-cannot-cross-original-deadline",
      { requestId, originalDeadlineAt: outcome.originalDeadlineAt, source: outcomeRef, parentAllocation },
      { actualInsertWaitObservedBeforeDeadline: true, artifacts: 0, checkedWorkEvents: 0, providerEgress: 0 }, async () => {
        const fault = new pg.Client({ connectionString: adminUrl }); await fault.connect();
        let worker: Promise<{ result: unknown } | { error: unknown }> | null = null;
        try {
          await fault.query("BEGIN");
          const blocker = (await fault.query("SELECT pg_backend_pid() pid")).rows[0].pid;
          await fault.query("LOCK TABLE finnor_os.w3_service_artifacts IN SHARE MODE");
          await new Promise(done => setTimeout(done, Math.max(0, Date.parse(outcome.originalDeadlineAt) - Date.now() - 3000)));
          worker = tick(false, 4).then(result => ({ result }), error => ({ error }));
          let waiting: Record<string, unknown> | undefined;
          const waitingLimit = Math.min(Date.now() + 15000, Date.parse(outcome.originalDeadlineAt) - 100);
          while (Date.now() < waitingLimit) {
            waiting = (await admin!.query(`SELECT pid,usename,state,wait_event_type,wait_event,query_start,
             pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database()
              AND usename='finnor_worker' AND wait_event_type='Lock'
              AND query LIKE 'INSERT INTO finnor_os.w3_service_artifacts%'`)).rows.find(row => row.blockers.includes(blocker));
            if (waiting) break;
            await new Promise(done => setTimeout(done, 20));
          }
          assert(waiting, "W3_ACTUAL_PUBLICATION_INSERT_WAIT_NOT_OBSERVED");
          assert(Date.now() < Date.parse(outcome.originalDeadlineAt), "W3_PUBLICATION_FAULT_MUST_REACH_INSERT_BEFORE_DEADLINE");
          const liveClaim = (await admin!.query(`SELECT id,claim_fence,lease_expires_at FROM finnor_os.jobs
           WHERE tenant_id=$1 AND payload->>'requestId'=$2 AND type='compile_real_world_service_v1'
            AND status='running'`, [tenant, requestId])).rows[0];
          assert(liveClaim && liveClaim.lease_expires_at.getTime() > Date.parse(outcome.originalDeadlineAt) + 100,
            "W3_PUBLICATION_FAULT_MUST_CROSS_DEADLINE_WITH_ORIGINAL_CLAIM_STILL_LIVE");
          const observedWaitingAt = new Date().toISOString();
          await artifact("publication/waiting.json", { blocker, waiting, liveClaim, observedWaitingAt,
            workerPid: activeWorker?.pid, originalDeadlineAt: outcome.originalDeadlineAt });
          await new Promise(done => setTimeout(done, Math.max(0, Date.parse(outcome.originalDeadlineAt) - Date.now()) + 25));
          const releasedAt = new Date().toISOString(); await fault.query("COMMIT");
          const settled = await worker;
          if ("error" in settled) throw settled.error;
          const artifacts = (await admin!.query(`SELECT id,body_digest FROM finnor_os.w3_service_artifacts
           WHERE tenant_id=$1 AND request_id=$2`, [tenant, requestId])).rows;
          const checkedEvents = (await admin!.query(`SELECT seq,reason FROM finnor_os.work_events
           WHERE tenant_id=$1 AND work_id=$2 AND reason='real_world_service_checked'`, [tenant, intake.workId])).rows;
          const effects = (await admin!.query(`SELECT id,status FROM finnor_os.business_effects
           WHERE tenant_id=$1 AND status<>'compiled'`, [tenant])).rows;
          const observed = { blocker, waiting, observedWaitingAt, releasedAt,
            originalDeadlineAt: outcome.originalDeadlineAt, artifacts, checkedEvents, effects, worker: settled.result };
          await artifact("publication/after-release.json", observed);
          assert.deepEqual(artifacts, [], "W3_LATE_PUBLICATION_MUST_NOT_PERSIST_ARTIFACT");
          assert.deepEqual(checkedEvents, [], "W3_LATE_PUBLICATION_MUST_NOT_PUBLISH_CHECKED_WORK");
          assert.deepEqual(effects, [], "W3_LATE_PUBLICATION_MUST_NOT_ADVANCE_NATIVE_EFFECTS");
          return observed;
        } finally {
          await fault.query("ROLLBACK");
          if (worker) await worker;
          await fault.end();
        }
      });
  } else {
  await pump();
  let view = await read();
  await run("W025-complete-original-programme", { outcome, provider: providerBody, originalAssignmentCount: 1 },
    { instances: 7, assignmentCount: 1, nativeDeliveriesClaimed: 0 }, async () => {
      assert(view.program && view.check?.disposition === "CHECKED_DEVELOPMENT", JSON.stringify(view));
      assert.equal(view.program.instances.length, demands.length); assert.equal(view.program.assignmentCount, 1);
      for (const demand of demands) {
        const original = view.program.instances.find((i: any) => i.id === demand.id);
        for (const [key, value] of Object.entries(demand)) assert.deepEqual(original[key], value);
      }
      assert.equal(view.program.selection.length, 7); assert.equal(view.projection.operationallyComplete, false);
      assert.equal(view.program.envelope.admitted, false); assert.equal(view.projection.fieldValidated, false);
      return view;
    });
  await run("W005-authenticated-private-boundaries", { workId: intake.workId, requestId },
    { unrelatedPrincipalDenied: true, foreignTenantDenied: true, ownerCannotConsentForProvider: true }, async () => {
      const wrong = await http("real-world-services", "read", { workId: intake.workId }, unrelated);
      const foreignResult = await http("real-world-services", "read", { workId: intake.workId }, foreign);
      const forgedConsent = await http("real-world-services", "consent", { protocolId: discover.protocolId, revoke: false });
      assert.equal(wrong.status, 404); assert.equal(foreignResult.status, 404); assert.equal(forgedConsent.status, 404);
      const hidden = await db.withTenantTransaction(tenant, { userId: unrelated, readOnly: true }, async (_d, c) =>
        (await c.query("SELECT content FROM finnor_os.evidence_source_versions WHERE id=$1", [outcomeRef.versionId])).rows);
      assert.equal(hidden.length, 0);
      return { wrong, foreignResult, forgedConsent, privateOriginalRows: hidden.length };
    });
  if (installation && !fast && invoiceChallenge === null) {
    const manifestBytes = await readFile(join(installation, installedDescriptor.compatibilityManifest.path));
    assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), installedDescriptor.compatibilityManifest.sha256);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const pin = [...manifest.files].reverse().find((p: any) =>
      p.path.startsWith("frontend/") && /(?:^|\/|[.-])LICENSE(?:[.-]|$)/i.test(p.path));
    assert(pin, "W3_OWNED_FRONTEND_LICENSE_PIN_REQUIRED");
    const target = join(installation, pin.path);
    assert(target.startsWith(installation + "/"));
    assert((await realpath(target)).startsWith(await realpath(installation) + "/"));
    const originalStat = await lstat(target);
    assert(originalStat.isFile(), "W3_OWNED_REGULAR_LICENSE_REQUIRED");
    const mode = originalStat.mode & 0o7777;
    assert.equal(mode, pin.mode);
    const original = await readFile(target), originalHash = createHash("sha256").update(original).digest("hex");
    assert.equal(originalHash, pin.sha256); assert(original.length <= 262144);
    const mutant = Buffer.concat([original, Buffer.from("\nW3_CONTROLLED_CUSTODY_DRIFT_" + randomUUID() + "\n")]);
    const mutantHash = createHash("sha256").update(mutant).digest("hex");
    await run("D021-installed-warm-custody-refuses-between-tick-drift",
      { requestId, target: pin.path, originalHash, mutantHash, mode, maximumTicks: 2 },
      { firstActualDeliveryCharged: true, nextTickRefusedBeforeClaim: true, exactOwnedBytesRestored: true }, async () => {
        await artifact("custody-drift/original-bytes.json", { path: pin.path, originalHash, mode, base64: original.toString("base64") });
        const counts = async () => (await admin!.query(`SELECT
         (SELECT count(*) FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j
          ON j.tenant_id=a.tenant_id AND j.id=a.job_id
          WHERE j.tenant_id=$1 AND j.type='advance_real_world_service_v1'
           AND j.payload->>'requestId'=$2)::int deliveries,
         (SELECT count(*) FROM finnor_os.s7_economic_records
          WHERE tenant_id=$1 AND kind='COMPUTE' AND body->'payload'->>'requestId'=$2)::int compute`,
        [tenant, requestId])).rows[0];
        const before = await counts();
        await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
        let observed: any = null;
        try {
          observed = await tick(false, 2, {
            expectedRefusal: "X1_INSTALLATION_BYTE_PIN_MISMATCH:" + pin.path,
            mutate: async () => {
              const held = await lstat(target);
              assert(held.isFile() && held.dev === originalStat.dev && held.ino === originalStat.ino);
              assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), originalHash);
              await chmod(target, mode | 0o200); await writeFile(target, mutant); await chmod(target, mode);
              assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), mutantHash);
              await artifact("custody-drift/mutation.json", { path: pin.path, mutantHash, mode, at: new Date().toISOString() });
            },
          });
          const after = await counts();
          assert.equal(after.deliveries, before.deliveries + 1); assert.equal(after.compute, before.compute + 1);
          return { before, after, worker: observed, target: pin.path, originalHash, mutantHash };
        } finally {
          assert(!activeWorker || activeWorker.exitCode !== null || activeWorker.signalCode !== null,
            "W3_CUSTODY_RESTORATION_REQUIRES_STOPPED_OWNED_WORKER");
          const heldStat = await lstat(target);
          assert(heldStat.isFile() && heldStat.dev === originalStat.dev && heldStat.ino === originalStat.ino,
            "W3_UNKNOWN_CUSTODY_NAMESPACE_LEFT_UNTOUCHED");
          assert([mode, mode | 0o200].includes(heldStat.mode & 0o7777), "W3_UNKNOWN_CUSTODY_MODE_LEFT_UNTOUCHED");
          const held = createHash("sha256").update(await readFile(target)).digest("hex");
          assert(held === originalHash || held === mutantHash, "W3_UNKNOWN_CUSTODY_EDIT_LEFT_UNTOUCHED");
          await chmod(target, mode | 0o200); await writeFile(target, original); await chmod(target, mode);
          assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), originalHash);
          assert.equal((await lstat(target)).mode & 0o7777, mode);
          await artifact("custody-drift/restoration.json", { target: pin.path, originalHash, mode, restored: true,
            afterRefusedWorkerPid: observed?.pid ?? null, at: new Date().toISOString() });
        }
      });
    view = await read();
  }
  if (pauseChallenge) {
    await run("W032-linux-production-worker-stop-state", { requestId, signal: "SIGSTOP", platform: process.platform },
      { actualDelivery: true, kernelStoppedBeforeMutation: true, sameWorkerResumed: true }, async () => {
        await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
        let pausedAction = false;
        const worker = await tick(false, 1, { mutate: async () => { pausedAction = true } });
        assert(pausedAction && worker.pause, "W3_KERNEL_STOPPED_ACTION_REQUIRED");
        assert.equal(worker.observations.length, 1);
        assert.equal(worker.observations[0].worked, true);
        return { worker, pausedAction, sourceCustodyMutated: false };
      });
  }
  if (acceptanceChallenge || observationsChallenge) {
    const term = view.program.selection[0];
    if (acceptanceChallenge) await run("W028-original-acceptance-observer-role",
      { requestId, criterion: "owner-verification", participantId: owner, role: "ACCEPTANCE_OWNER" },
      { invited: true, consented: true, authenticatedObservationPersisted: true }, async () => {
        const protocol = await ok("real-world-services", "invite", { requestId,
          instanceId: term.instanceId, providerId: term.providerId, termsDigest: term.termsDigest,
          participantId: owner, role: "ACCEPTANCE_OWNER", criterionIds: ["owner-verification"],
          permittedKinds: ["OBSERVATION", "ORIGINAL_ACCEPTANCE"], qualificationRefs: [], incentiveRef: null, expiresAt: deadline });
        await ok("real-world-services", "consent", { protocolId: protocol.protocolId, revoke: false });
        const at = demands[0]!.endAt;
        await setServiceClock(at);
        const observed = await ok("real-world-services", "report", { protocolId: protocol.protocolId,
          idempotencyKey: "acceptance-owner-observation", observation: { scope,
            instanceId: term.instanceId, providerId: term.providerId, termsDigest: term.termsDigest, at,
            kind: "OBSERVATION", criterionId: "owner-verification", result: "PASS",
            note: "Controlled original acceptance-owner verification, not field acceptance.",
            limits: ["CONTROLLED software evidence"], unobserved: ["Physical service"], basis: [] } });
        await pump();
        const projection = (await read()).projection;
        const instance = projection.instances.find((i: any) => i.instanceId === term.instanceId);
        assert(!instance.missingCriteria.includes("owner-verification"), "W3_ORIGINAL_OWNER_OBSERVATION_NOT_CONSUMED");
        assert.equal(instance.operationallyComplete, false, "An owner observation is not a complete service");
        return { protocol, observed, projection };
      });
    if (observationsChallenge) await run("W028-more-than-256-original-observation-sources",
      { requestId, reports: 257, acceptanceReferences: 257 },
      { allRealReportsPersisted: true, exactAcceptanceBasisPersisted: true }, async () => {
        const protocol = await ok("real-world-services", "invite", { requestId,
          instanceId: term.instanceId, providerId: term.providerId, termsDigest: term.termsDigest,
          participantId: inspector, role: "INSPECTOR", criterionIds: ["delivered-event"],
          permittedKinds: ["OBSERVATION"], qualificationRefs: [], incentiveRef: null, expiresAt: deadline });
        await ok("real-world-services", "consent", { protocolId: protocol.protocolId, revoke: false }, inspector);
        const acceptance = await ok("real-world-services", "invite", { requestId,
          instanceId: term.instanceId, providerId: term.providerId, termsDigest: term.termsDigest,
          participantId: owner, role: "ACCEPTANCE_OWNER", criterionIds: [], permittedKinds: ["ORIGINAL_ACCEPTANCE"],
          qualificationRefs: [], incentiveRef: null, expiresAt: deadline });
        await ok("real-world-services", "consent", { protocolId: acceptance.protocolId, revoke: false });
        const at = demands[0]!.startAt, sourceIds: string[] = [];
        await setServiceClock(at);
        for (let n = 0; n < 257; n++) {
          const report = await ok("real-world-services", "report", { protocolId: protocol.protocolId,
            idempotencyKey: "large-basis-" + n, observation: { scope, instanceId: term.instanceId,
              providerId: term.providerId, termsDigest: term.termsDigest, at, kind: "OBSERVATION",
              criterionId: "delivered-event", result: "PASS", note: "Controlled concordant observation " + n,
              limits: ["CONTROLLED software evidence"], unobserved: ["Physical service"], basis: [] } }, inspector);
          sourceIds.push(report.source.sourceId);
          if (n % 64 === 63) await pump();
        }
        assert.equal(new Set(sourceIds).size, 257);
        const report = await ok("real-world-services", "report", { protocolId: acceptance.protocolId,
          idempotencyKey: "large-original-acceptance", observation: { scope, instanceId: term.instanceId,
            providerId: term.providerId, termsDigest: term.termsDigest, at, kind: "ORIGINAL_ACCEPTANCE", accepted: true,
            observedSourceIds: sourceIds, limits: ["CONTROLLED software evidence"], unobserved: ["Physical service"], basis: [] } });
        await pump();
        const rows = (await admin!.query(`SELECT source_id FROM finnor_os.w3_observation_links
         WHERE tenant_id=$1 AND protocol_id=$2`, [tenant, protocol.protocolId])).rows;
        assert.deepEqual(rows.map(r => r.source_id).sort(), [...sourceIds].sort());
        const stored = (await admin!.query(`SELECT content,content_hash FROM finnor_os.evidence_source_versions
         WHERE tenant_id=$1 AND source_id=$2 AND id=$3`, [tenant, report.source.sourceId, report.source.versionId])).rows;
        assert.equal(stored.length, 1);
        assert.equal(createHash("sha256").update(stored[0].content).digest("hex"), report.source.contentDigest);
        assert.equal(stored[0].content_hash, report.source.contentDigest);
        assert.deepEqual(JSON.parse(stored[0].content).observedSourceIds, sourceIds);
        const projection = (await read()).projection;
        assert.equal(projection.operationallyComplete, false, "An exact acceptance basis does not invent missing service");
        return { reports: rows.length, sourceIds, acceptance: report, persistedAcceptance: JSON.parse(stored[0].content), projection };
      });
  }
  if (resourceChallenge) {
    const chargeCount = async () => (await admin!.query(`SELECT count(*)::int n
     FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1
      AND body->>'schema'='finnor.s5.service-compute-charge.v1'
      AND body->'serviceInvocation'->>'requestId'=$2`, [tenant, requestId])).rows[0].n as number;
    const originalBudget = await ok("obligations", "budget-status", { obligationRef: obligations.OFFER.ref });
    const expectedPredicate = resourceLimit === 512
      ? "S5_EXECUTION_RESOURCE_RECORD_BOUND" : "S5_SERVICE_COMPUTATION_UNFUNDED_OR_EXHAUSTED";
    await run("W005-actual-original-compute-exhaustion-" + resourceLimit,
      { requestId, workId: intake.workId, parentAllocation, originalDeadlineAt: deadline,
        resourceLimit, humanLimit: 900, originalBudget },
      { distinctRealChargedDeliveries: resourceLimit, remaining: "0", expectedPredicate,
        noNewAllocationOrMeasurementOnRefusal: true }, async () => {
        while (await chargeCount() < resourceLimit) {
          checkBound();
          await tick(false, 16, undefined, async () => {
            if (await chargeCount() >= resourceLimit) return false;
            await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
            return true;
          });
        }
        assert.equal(await chargeCount(), resourceLimit);
        const budget = await ok("obligations", "budget-status", { obligationRef: obligations.OFFER.ref });
        assert.deepEqual(budget.allocationRef, originalBudget.allocationRef);
        assert.deepEqual(budget.reservationRef, originalBudget.reservationRef);
        assert.deepEqual(budget.consumptionRef, originalBudget.consumptionRef);
        const execution = budget.budgets.find((b: any) => b.resourceId === "execution");
        assert.equal(execution.limit, String(resourceLimit));
        assert.equal(execution.used, String(resourceLimit)); assert.equal(execution.remaining, "0");
        const charges = (await admin!.query(`SELECT c.body,a.id,a.claim_token,a.claim_fence,a.job_id,a.finished_at,
         j.type,j.payload,s.body->'payload' compute
         FROM finnor_os.s5_governed_resource_charges c
         JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=c.tenant_id
          AND a.id::text=c.body->'serviceInvocation'->>'deliveryAttemptId'
         JOIN finnor_os.jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
         LEFT JOIN finnor_os.s7_economic_records s ON s.tenant_id=c.tenant_id AND s.kind='COMPUTE'
          AND s.body->'payload'->>'deliveryAttemptId'=a.id::text
         WHERE c.tenant_id=$1 AND c.body->'serviceInvocation'->>'requestId'=$2
         ORDER BY c.created_at,c.charge_key`, [tenant, requestId])).rows;
        assert.equal(charges.length, resourceLimit);
        assert.equal(new Set(charges.map(c => c.id)).size, resourceLimit);
        const witnesses = charges.map(c => {
          const invocation = c.body.serviceInvocation;
          assert.equal(c.body.units, 1); assert.equal(c.body.resourceId, "execution");
          assert.deepEqual(c.body.allocationRef, parentAllocation);
          assert.equal(invocation.jobId, c.job_id); assert.equal(invocation.claimFence, Number(c.claim_fence));
          assert.equal(invocation.generation, view.generation);
          assert.equal(invocation.claimTokenDigest, hash(c.claim_token));
          assert(c.finished_at && c.compute, "W3_EACH_REAL_CHARGE_REQUIRES_FINISHED_ATTEMPT_AND_S7");
          assert.deepEqual(c.compute.charge, c.body.ref);
          assert.equal(c.compute.deliveryAttemptId, c.id);
          assert(!JSON.stringify(c.body).includes(c.claim_token));
          return { chargeRef: c.body.ref, invocation, jobType: c.type, finishedAt: c.finished_at,
            computeStatus: c.compute.status, actualClaimTokenDigest: hash(c.claim_token) };
        });
        const snapshot = async () => ({
          measurements: (await admin!.query(`SELECT record_id,request_digest FROM finnor_os.s7_economic_records
           WHERE tenant_id=$1 AND kind='MEASUREMENT' AND body->'payload'->>'requestId'=$2 ORDER BY record_id`,
          [tenant, requestId])).rows,
          effects: (await admin!.query("SELECT id,status FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id", [tenant])).rows,
          charges: await chargeCount(),
          compute: (await admin!.query(`SELECT body->'payload' payload FROM finnor_os.s7_economic_records
           WHERE tenant_id=$1 AND kind='COMPUTE' AND body->'payload'->>'requestId'=$2
           ORDER BY knowledge_at,record_id`, [tenant, requestId])).rows.map(r => r.payload),
        });
        const atLimit = await snapshot(), refused: any[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const before = (await snapshot()).compute.filter((c: any) => c.predicate === expectedPredicate).length;
          await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
          for (let tickNumber = 0; tickNumber < 8; tickNumber++) {
            await tick();
            const after = await snapshot();
            if (after.compute.filter((c: any) => c.predicate === expectedPredicate).length > before) break;
          }
          const after = await snapshot();
          assert.deepEqual(after.measurements, atLimit.measurements); assert.deepEqual(after.effects, atLimit.effects);
          assert.equal(after.charges, resourceLimit);
          const failures = after.compute.filter((c: any) => c.predicate === expectedPredicate);
          assert.equal(failures.length, before + 1);
          const failure = failures.at(-1)!;
          assert.equal(failure.status, "REFUSED_RESPONSIBILITY_RETAINED"); assert.equal(failure.charge, null);
          refused.push(failure);
        }
        assert.notEqual(refused[0].deliveryAttemptId, refused[1].deliveryAttemptId);
        const finalBudget = await ok("obligations", "budget-status", { obligationRef: obligations.OFFER.ref });
        assert.deepEqual(finalBudget, budget);
        const current = await read();
        assert.equal(current.artifactDigest, view.artifactDigest);
        assert.equal(current.originalDeadlineAt, deadline);
        assert.equal(current.projection.operationallyComplete, false);
        return { budget, witnesses, refused, measuredProjectionCount: atLimit.measurements.length,
          providerEgress: 0, replacementBudget: false, sourceLimitsUnchanged: true };
      });
  }
  if (currentnessChallenge) await run("W007-batch-policy-read-rechecks-original-source-on-next-call",
    { parentAllocation, policyRefs: f.policies.map((policy: any) => policy.ref), originalSeries: f.series.outcome },
    { positiveCurrent: true, changedSourceInvalidatesS4AndS5: true, providerEgress: 0 }, async () => {
      assert(f.policies.length >= 4, "W3_SHARED_CURRENTNESS_REQUIRES_REAL_MULTI_POLICY_OWNER");
      const before = await ok("allocations", "validate", { allocationRef: parentAllocation });
      assert.equal(before.status, "CURRENT");
      const original = (await admin!.query(`SELECT id,value_numeric FROM finnor_os.pe_metric_observations
       WHERE tenant_id=$1 AND metric_series_id=$2 ORDER BY period_start,id LIMIT 1`,
      [tenant, f.series.outcome])).rows[0];
      assert(original);
      const changed = (await admin!.query(`UPDATE finnor_os.pe_metric_observations
       SET value_numeric=value_numeric+1 WHERE tenant_id=$1 AND id=$2 RETURNING id,value_numeric`,
      [tenant, original.id])).rows[0];
      assert(changed && changed.value_numeric !== original.value_numeric);
      const policy = await ok("policies", "validate", { policyRef: f.policies[0].ref });
      assert.equal(policy.status, "STALE_INPUT");
      assert.equal(policy.reason, "S1_SOURCE_RIGHTS_COVERAGE_OR_INTERPRETATION_CHANGED");
      const after = await ok("allocations", "validate", { allocationRef: parentAllocation });
      assert.equal(after.status, "STALE_INPUT");
      assert(after.reasons.includes("POLICY_MODEL_SOURCE_OR_RIGHTS_CHANGED"));
      assert.equal(recipient?.requests.filter((request: any) => request.method === "PATCH").length ?? 0, 0);
      return { before, original, changed, policy, after, providerEgress: 0 };
    });
  if (fast || acceptanceChallenge || observationsChallenge || resourceChallenge || currentnessChallenge) {
    await artifact("fast-result.json", { view, sourceIdentity: await serviceIdentity(),
      qualification: "AUTHENTICATED_NATIVE_FOCUSED_SLICE_ONLY" });
  } else {
    await run("W025-identical-projection-physical-replay", { requestId, artifactDigest: view.artifactDigest, deliveries: 2 },
      { immutableMeasurementReused: true, physicalDeliveriesCharged: 2, quarantinedJobs: 0 }, async () => {
        const snapshot = async () => ({
          measurements: (await admin!.query(`SELECT record_id,request_digest,valid_at,knowledge_at,event->>'eventId' event_id
           FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND kind='MEASUREMENT'
            AND body->'payload'->>'requestId'=$2 ORDER BY record_id`, [tenant, requestId])).rows,
          compute: (await admin!.query(`SELECT count(*)::int n FROM finnor_os.s7_economic_records
           WHERE tenant_id=$1 AND kind='COMPUTE' AND body->'payload'->>'requestId'=$2`, [tenant, requestId])).rows[0].n,
          deliveries: (await admin!.query(`SELECT count(*)::int n FROM finnor_os.job_delivery_attempts a
           JOIN finnor_os.jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
           WHERE a.tenant_id=$1 AND j.type='advance_real_world_service_v1'
            AND j.payload->>'requestId'=$2 AND a.finished_at IS NOT NULL`, [tenant, requestId])).rows[0].n,
        });
        const before = await snapshot(), originalView = view;
        assert(before.measurements.length > 0, "The original checked projection must already be measured");
        for (let n = 0; n < 2; n++) {
          await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: originalView.artifactDigest });
          await pump();
        }
        const after = await snapshot(); view = await read();
        assert.deepEqual(after.measurements, before.measurements);
        assert.equal(after.compute, before.compute + 2);
        assert.equal(after.deliveries, before.deliveries + 2);
        const computeUsed = (v: any) => v.budgets.budgets.find((b: any) => b.resourceId === "execution").used;
        assert.equal(BigInt(computeUsed(view)), BigInt(computeUsed(originalView)) + 2n);
        assert.deepEqual(view.budgets.allocationRef, parentAllocation);
        const bad = (await admin!.query(`SELECT id,type,status,last_error FROM finnor_os.jobs
         WHERE tenant_id=$1 AND status IN('failed','quarantined')`, [tenant])).rows;
        assert.deepEqual(bad, []);
        return { before, after, originalBudget: originalView.budgets, currentBudget: view.budgets, bad };
      });
    recipient = await serviceRecipient({ directory: join(output, "controlled-recipient-private"), tenantId: tenant,
      principalId: owner, providerIds: [provider, backup], rightsRef: obligations.OFFER.rightsRef, artifact,
      ownerCall: (op, body) => http("obligations", op, body) });
    let terms = demands.map(d => {
      const option = view.program.options.find((o: any) => o.instanceId === d.id && o.providerId === provider);
      assert.equal(option.termsDigest, optionTerms(outcome, d, { ref: providerRef, body: providerBody,
        authorId: provider, classification: "CONTROLLED", current: true, invalidationReasons: [] }));
      return { instanceId: d.id, providerId: provider, termsDigest: option.termsDigest };
    });
    let currentQuoteRevision = providerBody.quote.revision;
    let currentInvoiceMinor = 100;
    const backupTerms = cancellationChallenge ? demands.map(d => {
      const option = view.program.options.find((o: any) => o.instanceId === d.id && o.providerId === backup);
      assert(option);
      assert.equal(option.termsDigest, optionTerms(outcome, d, { ref: backupProviderRef, body: backupProviderBody,
        authorId: backup, classification: "CONTROLLED", current: true, invalidationReasons: [] }));
      return { instanceId: d.id, providerId: backup, termsDigest: option.termsDigest };
    }) : [];
    const historicalTerms = structuredClone(terms), historicalProtocols: Array<{ id: string; participantId: string }> = [];
    const originalCounts = async () => (await admin!.query(`SELECT
     (SELECT count(*) FROM finnor_os.evidence_source_versions WHERE tenant_id=$1)::int sources,
     (SELECT count(*) FROM finnor_os.w3_service_requests WHERE tenant_id=$1)::int requests,
     (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs`, [tenant])).rows[0];
    const acyclic = structuredClone(outcome);
    let priorInstance: string | null = null;
    for (const demand of acyclic.demands) {
      demand.prerequisites = priorInstance === null ? [] : [priorInstance];
      priorInstance = demand.id;
    }
    await run("W003-acyclic-original-boundary-control", { original: acyclic },
      { intendedOwner: "W3 original-input schema", status: 200, newSources: 1, newRequests: 0, newJobs: 0 }, async () => {
        const before = await originalCounts();
        const accepted = await http("real-world-services", "source", { workId: intake.workId, body: acyclic,
          idempotencyKey: "acyclic-original-control", purpose: "Controlled W3 service verification", protocolId: null });
        assert.equal(accepted.status, 200);
        const after = await originalCounts();
        assert.deepEqual(after, { ...before, sources: before.sources + 1 });
        return { accepted, before, after, compilationOrDeliveryEstablished: false };
      });
    for (let sample = 0; sample < 8; sample++) {
      const malformed = structuredClone(outcome), size = Math.min(sample + 2, demands.length);
      for (const demand of malformed.demands) demand.prerequisites = [];
      for (let n = 0; n < size; n++) malformed.demands[n].prerequisites = [malformed.demands[(n + 1) % size].id];
      if (sample === 6) {
        malformed.demands[0].prerequisites = [malformed.demands[1].id];
        malformed.demands[1].prerequisites = [malformed.demands[0].id];
        malformed.demands[2].prerequisites = [malformed.demands[3].id];
        malformed.demands[3].prerequisites = [malformed.demands[4].id];
        malformed.demands[4].prerequisites = [malformed.demands[2].id];
      }
      if (sample === 7) malformed.demands[0].prerequisites.push(malformed.demands[3].id);
      await run("W003-cyclic-original-" + sample, { original: malformed },
        { intendedOwner: "W3 original-input schema", status: 400, newSources: 0, newRequests: 0, newJobs: 0 }, async () => {
          const before = await originalCounts();
          const refusal = await http("real-world-services", "source", { workId: intake.workId, body: malformed,
            idempotencyKey: "cyclic-original-" + sample, purpose: "Controlled W3 service verification", protocolId: null });
          assert.equal(refusal.status, 400); assert.equal(refusal.body.code, "W3_INVALID_REQUEST");
          const after = await originalCounts(); assert.deepEqual(after, before);
          return { refusal, before, after };
        });
    }
    if (commitmentChallenge) {
      await run("W039-authenticated-old-terms-and-provider-revision",
        { originalTerms: historicalTerms, retainedInstances: historicalTerms.slice(1), parentAllocation,
          oldOffer: obligations.OLD_OFFER.ref, newQuoteRevision: "quote-2",
          cancellationRequestedIsNotConfirmed: true, cashComputeHuman: [100, 512, 900] },
        { genuineNativeOldOfferReadback: true, sixHistoricalCommitments: true,
          oneCurrentOnlyPositive: true, generationAdvanced: true, allCurrentTermsChanged: true }, async () => {
          const at = new Date(firstDay + 7 * 3600000).toISOString();
          await setServiceClock(at);
          const bare = { schema: "finnor.service-native-execution.v1", scope, ...historicalTerms[0], operation: "OFFER",
            coveredTerms: historicalTerms, paymentPlan: [], obligationRef: obligations.OLD_OFFER.ref, parentAllocation };
          const execution = await recipient!.bind(obligations.OLD_OFFER, provider, serviceExecutionRecordKey(bare as any));
          await source(intake.workId, { ...bare, execution }, "historical-native-OFFER");
          await pump(); view = await read();
          assert(view.nativeEffects.some((e: any) => e.operation === "OFFER" && e.state === "VERIFIED"
            && hash(e.ref) === hash(obligations.OLD_OFFER.ref)));
          assert.equal(recipient!.requests.filter((r: any) => r.method === "PATCH").length, 1);
          for (const [index, term] of historicalTerms.slice(1).entries()) {
            const invite = async (role: string, participantId: string, permittedKinds: string[]) => {
              const p = await ok("real-world-services", "invite", { requestId, participantId, ...term, role,
                criterionIds: [], permittedKinds, qualificationRefs: [], incentiveRef: null, expiresAt: deadline });
              await ok("real-world-services", "consent", { protocolId: p.protocolId, revoke: false }, participantId);
              const protocol = { id: p.protocolId, participantId }; historicalProtocols.push(protocol); return protocol;
            };
            const reportOld = async (protocol: { id: string; participantId: string }, extra: Record<string, unknown>) =>
              ok("real-world-services", "report", { protocolId: protocol.id,
                idempotencyKey: "historical-" + term.instanceId + "-" + extra.kind,
                observation: { scope, ...term, at, basis: [], ...extra,
                  limits: ["CONTROLLED original historical commitment, not real service or purchase."],
                  unobserved: ["All genuine human and physical outcomes"] } }, protocol.participantId);
            const providerProtocol = await invite("PROVIDER", provider, ["ACCEPTED"]);
            await reportOld(providerProtocol, { kind: "ACCEPTED", quoteRevision: providerBody.quote.revision,
              effectRef: obligations.OLD_OFFER.ref });
            if (index % 2 === 1) {
              const ownerProtocol = await invite("ACCEPTANCE_OWNER", owner, ["CANCELLATION_REQUESTED"]);
              await reportOld(ownerProtocol, { kind: "CANCELLATION_REQUESTED", effectRef: obligations.OLD_OFFER.ref });
            }
          }
          await pump(); view = await read();
          assert.equal(view.projection.instances.filter((i: any) => i.accepted).length, 6);
          assert.equal(view.projection.instances.find((i: any) => i.instanceId === historicalTerms[0]!.instanceId).accepted, false);
          const generation = async () => (await admin!.query(`SELECT generation FROM finnor_os.w3_service_requests
           WHERE tenant_id=$1 AND id=$2`, [tenant, requestId])).rows[0].generation;
          const generationBefore = await generation();
          const replacement = structuredClone(providerBody); replacement.quote.revision = "quote-2";
          const replacementRef = (await source(intake.workId, replacement, "provider-own-revised-quote",
            provider, discover.protocolId)).source;
          await pump(); view = await read();
          const generationAfter = await generation();
          assert.equal(generationAfter, generationBefore + 1);
          terms = demands.map(d => {
            const option = view.program.options.find((o: any) => o.instanceId === d.id && o.providerId === provider);
            assert(option);
            assert.equal(option.termsDigest, optionTerms(outcome, d, { ref: replacementRef, body: replacement,
              authorId: provider, classification: "CONTROLLED", current: true, invalidationReasons: [] }));
            assert.notEqual(option.termsDigest, historicalTerms.find(t => t.instanceId === d.id)!.termsDigest);
            return { instanceId: d.id, providerId: provider, termsDigest: option.termsDigest };
          });
          currentQuoteRevision = replacement.quote.revision;
          assert.equal(view.projection.instances.filter((i: any) => i.accepted).length, 0,
            "Historical acceptance must not become current exact-terms acceptance");
          return { originalTerms: historicalTerms, currentTerms: terms, replacementRef, historicalProtocols,
            generationBefore, generationAfter, view, recipient: recipient!.snapshot() };
        });
    }
    const bind = async (op: string, paymentPlan: any[] = [], coveredTerms = terms, obligationKey = op) => {
      assert(coveredTerms.length > 0);
      const bare = { schema: "finnor.service-native-execution.v1", scope, ...coveredTerms[0], operation: op,
        coveredTerms, paymentPlan, obligationRef: obligations[obligationKey].ref, parentAllocation };
      const execution = await recipient.bind(obligations[obligationKey], coveredTerms[0]!.providerId,
        serviceExecutionRecordKey(bare as any));
      return source(intake.workId, { ...bare, execution }, "native-" + obligationKey);
    };
    const reportKey = (term: any) => canonical([term.instanceId, term.providerId, term.termsDigest]);
    const protocols = new Map<string, any>();
    const inviteTerms = async (originalTerms: typeof terms) => { for (const term of originalTerms) {
      const invite = async (role: string, participantId: string, criterionIds: string[], permittedKinds: string[],
        qualificationRefs: any[] = [], incentiveRef: any = null) => {
        const p = await ok("real-world-services", "invite", { requestId, participantId, ...term, role, criterionIds,
          permittedKinds, qualificationRefs, incentiveRef, expiresAt: deadline });
        await ok("real-world-services", "consent", { protocolId: p.protocolId, revoke: false }, participantId);
        protocols.set(reportKey(term) + ":" + role, { id: p.protocolId, participantId }); return p;
      };
      await invite("PROVIDER", term.providerId, [], ["QUOTE", "ACCEPTED", "STARTED", "DELIVERED", "INVOICE", "COST", "CANCELLED",
        ...(cancellationChallenge ? ["DISPUTED"] : [])]);
      await invite("PROFESSIONAL", inspector, ["readiness", "delivered-event", "qualified-process", "handback", "retired-access"],
        ["OBSERVATION", "DISPUTED", "COST"], [inspectorQualification]);
      await invite("RECIPIENT", evaluator, sensory ? ["trial-sensory", "daily-sensory"] : [], ["OBSERVATION", "MISSED", "DISPUTED"], [], trigger);
      await invite("ACCEPTANCE_OWNER", owner, ["owner-verification"], ["OBSERVATION", "ORIGINAL_ACCEPTANCE", "PAYMENT", "COST", "CANCELLATION_REQUESTED", "DISPUTED"]);
    } };
    await inviteTerms(terms);
    if (cancellationChallenge) await inviteTerms(backupTerms);
    const reportSources = new Map<string, string[]>(), invoiceRefs: any[] = [];
    let reportOrdinal = 0;
    const report = async (term: any, role: string, extra: Record<string, unknown>, at: string) => {
      const protocol = protocols.get(reportKey(term) + ":" + role);
      const body: Record<string, any> = { scope, ...term, at, limits: ["CONTROLLED software assertion. No actual person, meal, tasting, safety judgement or payment."],
        unobserved: ["Genuine human and elapsed field outcome"], basis: [], ...extra };
      const result = await ok("real-world-services", "report", { protocolId: protocol.id, idempotencyKey: "report-" + (++reportOrdinal),
        observation: body }, protocol.participantId);
      if (body.kind === "OBSERVATION") reportSources.set(reportKey(term),
        [...(reportSources.get(reportKey(term)) ?? []), result.source.sourceId]);
      return result.source;
    };
    await setServiceClock(new Date(firstDay + 8 * 3600000).toISOString());
    await bind("OFFER");
    if (dependencyChallenge) {
      await bind("BOOK", [], terms.slice(0, 1), "BOOK_PREDECESSOR");
      await bind("BOOK", [], terms.slice(1));
      await bind("RETIRE_ACCESS", [], terms.slice(0, 1), "RETIRE_PREDECESSOR");
      await bind("RETIRE_ACCESS", [], terms.slice(1));
    } else if (cancellationChallenge) {
      await bind("BOOK"); await bind("CANCEL"); await bind("RETIRE_ACCESS", [], terms, "RETIRE_PRIMARY");
      await bind("OFFER", [], backupTerms, "BACKUP_OFFER"); await bind("BOOK", [], backupTerms, "BACKUP_BOOK");
      await bind("RETIRE_ACCESS", [], backupTerms);
    } else { await bind("BOOK"); await bind("RETIRE_ACCESS") }
    await pump(); view = await read();
    await run("W025-offer-not-service-or-consent", { terms, native: obligations.OFFER.ref },
      { nativeOfferVerified: true, accepted: false, delivered: false }, async () => {
        assert(view.nativeEffects.some((e: any) => e.operation === "OFFER" && e.state === "VERIFIED"), JSON.stringify(view.gaps));
        assert(view.projection.instances.every((i: any) => !i.accepted && !i.delivered && !i.operationallyComplete));
        assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, 1 + (commitmentChallenge ? 1 : 0));
        assert(!recipient.requests.some((r: any) => r.recordKey === serviceExecutionRecordKey({
          scope, operation: "BOOK", coveredTerms: terms, paymentPlan: [] } as any) && r.method === "PATCH"));
        return view;
      });
    await run("W005-accounting-claim-custody", { requestId, originalAllocation: parentAllocation },
      { nativeAttemptBound: true, rawTokenInChargeOrOwnerDelivery: false, freshBudgetValidates: true }, async () => {
        const budget = await ok("obligations", "budget-status", { obligationRef: obligations.OFFER.ref });
        assert.deepEqual(budget.allocationRef, parentAllocation);
        const charges = (await admin!.query(`SELECT c.body,a.claim_token,a.claim_fence,a.job_id,o.envelope
         FROM finnor_os.s5_governed_resource_charges c
         LEFT JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=c.tenant_id
          AND a.id::text=c.body->'serviceInvocation'->>'deliveryAttemptId'
         LEFT JOIN finnor_os.s6_owner_delivery_origins o ON o.tenant_id=c.tenant_id
          AND o.principal_id=c.principal_id AND o.semantic_owner='S5' AND o.kind='REFERENCE'
          AND o.identity=c.body->'ref'->>'id'
         WHERE c.tenant_id=$1 AND c.principal_id=$2
          AND c.body->>'schema'='finnor.s5.service-compute-charge.v1'
          AND c.body->'serviceInvocation'->>'requestId'=$3
         ORDER BY c.created_at,c.charge_key LIMIT 513`, [tenant, owner, requestId])).rows;
        assert(charges.length > 0 && charges.length <= 512);
        let ownerDeliveries = 0;
        const witnesses = charges.map(row => {
          const invocation = row.body.serviceInvocation;
          assert.deepEqual(Object.keys(invocation).sort(), ["requestId", "generation", "jobId", "deliveryAttemptId",
            "claimFence", "stage", "claimTokenDigest"].sort());
          assert.equal(typeof row.claim_token, "string");
          const digest = createHash("sha256").update(JSON.stringify(row.claim_token)).digest("hex");
          assert.equal(invocation.claimTokenDigest, digest);
          assert.equal(invocation.jobId, row.job_id); assert.equal(invocation.claimFence, Number(row.claim_fence));
          assert(!JSON.stringify(row.body).includes(row.claim_token), "W3_CLAIM_CREDENTIAL_IN_CHARGE");
          if (row.envelope) {
            ownerDeliveries++;
            assert(!JSON.stringify(row.envelope).includes(row.claim_token), "W3_CLAIM_CREDENTIAL_IN_OWNER_DELIVERY");
          }
          return { chargeRef: row.body.ref, deliveryAttemptId: invocation.deliveryAttemptId,
            claimTokenDigest: digest, ownerDeliveryPresent: Boolean(row.envelope) };
        });
        assert(ownerDeliveries > 0, "W3_ACCOUNTING_DISCLOSURE_CONTROL_NOT_REACHED");
        return { budget, chargeCount: charges.length, ownerDeliveries, witnesses, credentialRecorded: false };
      });
    await run("W028-no-provider-self-inspection", { providerId: provider, hardCriterion: "qualified-process" },
      { intendedRoleBoundaryRejects: true }, async () => {
        const refused = await http("real-world-services", "invite", { requestId, participantId: provider, ...terms[0],
          role: "PROFESSIONAL", criterionIds: ["qualified-process"], permittedKinds: ["OBSERVATION"],
          qualificationRefs: [providerQualification], incentiveRef: null, expiresAt: deadline });
        assert.equal(refused.status, 409); assert.equal(refused.body.code, "W3_PROVIDER_CANNOT_SELF_INSPECT"); return refused;
      });
    const trialAt = new Date(firstDay + 7 * 3600000).toISOString();
    for (const term of terms) {
      await report(term, "PROVIDER", { kind: "ACCEPTED", quoteRevision: currentQuoteRevision, effectRef: obligations.OFFER.ref }, trialAt);
      await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "readiness", result: "PASS", note: "Controlled readiness original; not field safety." }, trialAt);
      if (sensory) await report(term, "RECIPIENT", { kind: "OBSERVATION", criterionId: "trial-sensory", result: "PASS",
        note: "Scripted CONTROLLED report, no actual human ate or tasted anything." }, trialAt);
    }
    if (cancellationChallenge) for (const term of backupTerms) await report(term, "PROFESSIONAL", {
      kind: "OBSERVATION", criterionId: "readiness", result: "PASS",
      note: "Controlled independent readiness of the originally available backup, observed before the service window." }, trialAt);
    await pump(); view = await read();
    await run("W025-exact-acceptance-and-readiness", { terms }, { acceptedAndReady: 7, nativeBookVerified: true }, async () => {
      assert(view.projection.instances.every((i: any) => i.accepted && i.ready && !i.delivered), JSON.stringify(view));
      assert(view.nativeEffects.some((e: any) => e.operation === "BOOK" && e.state === "VERIFIED"));
      assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, 2 + (commitmentChallenge ? 1 : 0));
      return view;
    });
    if (cancellationChallenge) {
      const primaryTerms = structuredClone(terms);
      const failureAt = new Date(Date.parse(demands[0]!.startAt) + 60000).toISOString();
      await setServiceClock(failureAt);
      for (const term of primaryTerms) {
        await report(term, "PROVIDER", { kind: "DISPUTED",
          reason: "Authenticated controlled primary withdraws its accepted recurring programme, sample" + cancellationSample }, failureAt);
        await report(term, "ACCEPTANCE_OWNER", { kind: "CANCELLATION_REQUESTED", effectRef: obligations.CANCEL.ref }, failureAt);
      }
      if (cancellationSample >= 4) await report(primaryTerms[0], "RECIPIENT", { kind: "MISSED",
        reason: "Controlled original primary first visit was not observed at its required start; failure remains after recovery." }, failureAt);
      const backupOfferKey = serviceExecutionRecordKey({ scope, operation: "OFFER", coveredTerms: backupTerms, paymentPlan: [] } as any);
      const backupBookKey = serviceExecutionRecordKey({ scope, operation: "BOOK", coveredTerms: backupTerms, paymentPlan: [] } as any);
      const assertBackupBlocked = async () => {
        assert(view.gaps.some((g: string) => g.includes("W3_BACKUP_REQUIRES_ORIGINAL_FAILURE_AND_RECONCILED_COMMITMENT")));
        assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH"
          && [backupOfferKey, backupBookKey].includes(r.recordKey)).length, 0);
        const scheduled = (await admin!.query(`SELECT id FROM finnor_os.workflow_steps
         WHERE tenant_id=$1 AND step_type='execute_governed_obligation'
          AND payload->'obligationRef'->>'id'=ANY($2::text[])`,
        [tenant, [obligations.BACKUP_OFFER.ref.id, obligations.BACKUP_BOOK.ref.id]])).rows;
        assert.equal(scheduled.length, 0, "W3_LIVE_PRIMARY_MUST_NOT_ACTIVATE_BACKUP_WORKFLOW");
        for (const term of primaryTerms) {
          const instance = view.projection.instances.find((i: any) => i.instanceId === term.instanceId);
          assert(instance.originalFailures.length >= 1);
          assert(instance.commitments.some((c: any) => c.providerId === provider && c.termsDigest === term.termsDigest
            && c.state === "CANCELLATION_REQUESTED"));
        }
        return { view, recipient: recipient.snapshot() };
      };
      await run("W027-live-accepted-primary-blocks-prepared-backup-" + cancellationSample,
        { primaryTerms, backupTerms, cancellation: obligations.CANCEL.ref, parentAllocation },
        { livePrimaryCommitments: 7, backupPatches: 0, originalFailuresRetained: true }, async () => {
          await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
          for (let n = 0; n < 32; n++) {
            const next = (await admin!.query(`SELECT type FROM finnor_os.jobs WHERE tenant_id=$1 AND status='queued'
             AND run_at<=clock_timestamp() AND type IN('advance_real_world_service_v1','run_workflow_step_v3')
             ORDER BY priority DESC,run_at,id LIMIT 1`, [tenant])).rows[0];
            assert(next);
            if (next.type === "run_workflow_step_v3") break;
            await tick();
          }
          view = await read();
          assert(view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.CANCEL.ref))
            .every((e: any) => e.state === "NOT_ATTEMPTED"));
          return assertBackupBlocked();
        });
      await run("W027-native-cancel-without-provider-ack-blocks-backup-" + cancellationSample,
        { cancellation: obligations.CANCEL.ref, acknowledgement: "WITHHELD",
          additionalActualAdvances: cancellationSample % 2 ? cancellationSample + 1 : 0 },
        { originalCancellationVerified: true, backupPatches: 0, requestedCommitmentsRetained: true }, async () => {
          await pump(); view = await read();
          assert(view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.CANCEL.ref))
            .every((e: any) => e.state === "VERIFIED" && e.originalIdentityReadback));
          await assertBackupBlocked();
          if (cancellationSample % 2) for (let n = 0; n <= cancellationSample; n++) {
            await ok("real-world-services", "advance", { requestId, expectedArtifactDigest: view.artifactDigest });
            await pump(); view = await read(); await assertBackupBlocked();
          }
          return { ...await assertBackupBlocked(), nativeCancellationAloneIsNotProviderAcknowledgement: true };
        });
      for (const term of primaryTerms) await report(term, "PROVIDER", { kind: "CANCELLED", effectRef: obligations.CANCEL.ref,
        residualCosts: [{ id: "controlled-cancellation-" + term.instanceId, category: "CANCELLATION",
          amount: { currency: "USD", minor: String(10 + cancellationSample) }, basis: "ACCRUED", evidence: [trigger],
          reason: "Controlled authenticated residual-cost report only, not actual billing or payment." }] }, failureAt);
      await run("W027-confirmed-original-cancel-authorizes-compatible-backup-" + cancellationSample,
        { primaryTerms, backupTerms, originalBackupOffer: obligations.BACKUP_OFFER.ref, parentAllocation, originalDeadlineAt: deadline },
        { confirmedPrimaryCancellationWithResiduals: 7, originalBackupOfferVerified: true, freshAllowance: false }, async () => {
          await pump(); view = await read();
          assert(view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.BACKUP_OFFER.ref))
            .every((e: any) => e.state === "VERIFIED" && e.originalIdentityReadback));
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH" && r.recordKey === backupOfferKey).length, 1);
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH" && r.recordKey === backupBookKey).length, 0);
          for (const term of primaryTerms) {
            const instance = view.projection.instances.find((i: any) => i.instanceId === term.instanceId);
            const commitment = instance.commitments.find((c: any) => c.providerId === provider && c.termsDigest === term.termsDigest);
            assert.equal(commitment.state, "CONFIRMED_CANCELLED_WITH_RESIDUALS");
            assert.equal(commitment.residualCosts[0].amount.minor, String(10 + cancellationSample));
            assert(instance.originalFailures.length >= 1);
          }
          assert.deepEqual(view.budgets.allocationRef, parentAllocation);
          assert.equal(view.originalDeadlineAt, deadline);
          return { view, recipient: recipient.snapshot() };
        });
      terms = backupTerms; currentQuoteRevision = backupProviderBody.quote.revision; currentInvoiceMinor = 110;
      for (const term of terms) await report(term, "PROVIDER", {
        kind: "ACCEPTED", quoteRevision: currentQuoteRevision, effectRef: obligations.BACKUP_OFFER.ref }, failureAt);
      await pump(); view = await read();
      assert(view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.BACKUP_BOOK.ref))
        .every((e: any) => e.state === "VERIFIED"));
      assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH" && r.recordKey === backupBookKey).length, 1);
    }
    const dependentKey = dependencyChallenge ? serviceExecutionRecordKey({
      scope, operation: "BOOK", coveredTerms: terms.slice(1), paymentPlan: [] } as any) : null;
    const assertDependentBlocked = async () => {
      assert(view.gaps.includes("W3_ORIGINAL_SERVICE_PREREQUISITE_INCOMPLETE:" + demands[1]!.id));
      const dependentEffects = view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.BOOK.ref));
      assert.equal(dependentEffects.length, terms.length - 1);
      assert(dependentEffects.every((e: any) => e.state === "NOT_ATTEMPTED"));
      assert.equal(recipient.requests.filter((r: any) => r.recordKey === dependentKey && r.method === "PATCH").length, 0);
      const scheduled = (await admin!.query(`SELECT id FROM finnor_os.workflow_steps
       WHERE tenant_id=$1 AND step_type='execute_governed_obligation'
        AND payload->'obligationRef'->>'id'=$2`, [tenant, obligations.BOOK.ref.id])).rows;
      assert.equal(scheduled.length, 0, "W3_INCOMPLETE_PREREQUISITE_MUST_NOT_ACTIVATE_DEPENDENT_WORKFLOW");
      assert.deepEqual(view.budgets.allocationRef, parentAllocation);
      return { view, dependentKey, recipient: recipient.snapshot() };
    };
    if (dependencyChallenge) await run("W029-original-prerequisite-blocks-bound-booking",
      { predecessor: demands[0], dependent: demands[1], originalDependentObligation: obligations.BOOK.ref },
      { allExactAcceptanceAndReadiness: true, predecessorBooked: true, dependentPatches: 0 },
      async () => assertDependentBlocked());
    const deliver = async (n: number) => {
      const term = terms[n]!, demand = demands[n]!, at = new Date(Date.parse(demand.startAt) + 1800000).toISOString();
      const handbackAt = new Date(Date.parse(demand.endAt) + 60000).toISOString();
      await setServiceClock(handbackAt);
      await report(term, "PROVIDER", { kind: "STARTED" }, demand.startAt);
      await report(term, "PROVIDER", { kind: "DELIVERED", quantity: demand.quantity }, at);
      await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "delivered-event", result: "PASS", note: "Controlled independent event original." }, at);
      await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "qualified-process", result: "PASS",
        note: "Controlled role/process assertion, not an actual professionally qualified safety judgement." }, at);
      if (sensory) await report(term, "RECIPIENT", { kind: "OBSERVATION", criterionId: "daily-sensory", result: "PASS",
        note: "CONTROLLED original. No actual tasting or genuine human evidence." }, at);
      await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "handback", result: "PASS",
        note: "Controlled handback original." }, handbackAt);
      const split = invoiceChallenge !== null && invoiceChallenge % 2 === 1;
      for (let part = 0; part < (split ? 2 : 1); part++) {
        const invoiceId = "invoice-" + term.instanceId + (split ? "-" + part : "");
        const amount = { currency: "USD", minor: String((split ? currentInvoiceMinor / 2 : currentInvoiceMinor)
          + (invoiceChallenge === null ? 0 : 1 + Math.floor(invoiceChallenge / 2))) };
        const invoice = await report(term, "PROVIDER", { kind: "INVOICE", invoiceId,
          quantity: { ...demand.quantity, value: split ? String(Number(demand.quantity.value) / 2) : demand.quantity.value }, amount }, at);
        invoiceRefs.push({ ...term, invoiceSource: invoice, invoiceId, amount });
      }
    };
    if (dependencyChallenge) {
      await run("W029-reports-without-original-acceptance-do-not-unlock-booking",
        { predecessor: demands[0], dependentObligation: obligations.BOOK.ref },
        { deliveredAndInspected: true, nativePredecessorRetirement: true, dependentPatches: 0 }, async () => {
          await deliver(0); await pump(); view = await read();
          const predecessor = view.projection.instances.find((i: any) => i.instanceId === demands[0]!.id);
          assert(predecessor.delivered); assert.equal(predecessor.operationallyComplete, false);
          assert(view.nativeEffects.some((e: any) => hash(e.ref) === hash(obligations.RETIRE_PREDECESSOR.ref)
            && e.state === "VERIFIED"));
          return assertDependentBlocked();
        });
      await run("W029-actual-original-prerequisite-unlocks-same-booking",
        { predecessor: demands[0], dependent: demands[1], originalDependentObligation: obligations.BOOK.ref,
          parentAllocation, originalDeadlineAt: deadline },
        { originalPredecessorComplete: true, originalDependentBookReadback: true, noFreshBudget: true }, async () => {
          const at = new Date(Date.parse(demands[0]!.endAt) + 120000).toISOString(), term = terms[0]!;
          await setServiceClock(at);
          await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "retired-access",
            result: "PASS", note: "Controlled predecessor retirement, with separate actual native readback." }, at);
          await report(term, "ACCEPTANCE_OWNER", { kind: "OBSERVATION", criterionId: "owner-verification",
            result: "PASS", note: "Controlled original predecessor acceptance basis." }, at);
          await report(term, "ACCEPTANCE_OWNER", { kind: "ORIGINAL_ACCEPTANCE", accepted: true,
            observedSourceIds: reportSources.get(reportKey(term)) }, at);
          await pump(); view = await read();
          assert.equal(view.projection.instances.find((i: any) => i.instanceId === term.instanceId).operationallyComplete, true);
          const dependentEffects = view.nativeEffects.filter((e: any) => hash(e.ref) === hash(obligations.BOOK.ref));
          assert.equal(dependentEffects.length, terms.length - 1);
          assert(dependentEffects.every((e: any) => e.state === "VERIFIED"));
          assert(!view.gaps.some((gap: string) => gap.startsWith("W3_ORIGINAL_SERVICE_PREREQUISITE_INCOMPLETE:")));
          const patches = recipient.requests.filter((r: any) => r.method === "PATCH");
          const predecessorKey = serviceExecutionRecordKey({ scope, operation: "BOOK",
            coveredTerms: terms.slice(0, 1), paymentPlan: [] } as any);
          const retiredKey = serviceExecutionRecordKey({ scope, operation: "RETIRE_ACCESS",
            coveredTerms: terms.slice(0, 1), paymentPlan: [] } as any);
          const order = [predecessorKey, retiredKey, dependentKey].map(key => patches.findIndex((r: any) => r.recordKey === key));
          assert(order[0]! >= 0 && order[1]! > order[0]! && order[2]! > order[1]!);
          assert.equal(patches.filter((r: any) => r.recordKey === dependentKey).length, 1);
          assert.deepEqual(view.budgets.allocationRef, parentAllocation);
          assert.equal(view.originalDeadlineAt, deadline);
          return { order, view, recipient: recipient.snapshot() };
        });
    }
    for (let n = dependencyChallenge ? 1 : 0; n < terms.length; n++) await deliver(n);
    await pump();
    const retireAt = new Date(firstDay + 6 * day + 11 * 3600000 + 120000).toISOString();
    await setServiceClock(retireAt);
    for (const term of dependencyChallenge ? terms.slice(1) : terms) await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "retired-access",
      result: "PASS", note: "Controlled inspection; native retirement readback is separately required." }, retireAt);
    for (const term of dependencyChallenge ? terms.slice(1) : terms) await report(term, "ACCEPTANCE_OWNER", { kind: "OBSERVATION", criterionId: "owner-verification",
      result: "PASS", note: "Controlled acceptance owner verified the original service basis; no field claim." }, retireAt);
    if (largeBasis) {
      const term = terms[0]!, at = new Date(Date.parse(demands[0]!.startAt) + 1800000).toISOString();
      for (let n = 0; n < 257; n++) {
        await report(term, "PROFESSIONAL", { kind: "OBSERVATION", criterionId: "delivered-event",
          result: "PASS", note: "Controlled concordant observation original " + n }, at);
        if (n % 64 === 63) await pump();
      }
    }
    await pump();
    for (const term of dependencyChallenge ? terms.slice(1) : terms) await report(term, "ACCEPTANCE_OWNER", { kind: "ORIGINAL_ACCEPTANCE", accepted: true,
      observedSourceIds: reportSources.get(reportKey(term)) }, retireAt);
    await pump(); view = await read();
    await run("W032-native-access-retirement", { original: outcomeRef, retirement: obligations.RETIRE_ACCESS.ref },
      { allOriginalCriteriaAndAcceptance: true, noFinancialInference: true, fieldValidated: false }, async () => {
        assert.equal(view.projection.operationallyComplete, true, JSON.stringify(view));
        assert.equal(view.projection.financiallyReconciled, false); assert.equal(view.projection.fieldValidated, false);
        assert(view.nativeEffects.some((e: any) => e.operation === "RETIRE_ACCESS" && e.state === "VERIFIED"));
        assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length,
          3 + (commitmentChallenge ? 1 : 0) + (dependencyChallenge ? 2 : 0) + (cancellationChallenge ? 4 : 0));
        return view;
      });
    if (largeBasis) await run("W028-full-service-exact-large-observation-basis",
      { firstInstance: terms[0]!.instanceId, extraIndependentReports: 257 },
      { entireBasisConsumed: true, operationallyComplete: true, noFieldInference: true }, async () => {
        const ids = reportSources.get(reportKey(terms[0]!))!;
        assert.equal(ids.length, criteria.length + 257); assert.equal(new Set(ids).size, ids.length);
        assert.equal(view.projection.operationallyComplete, true);
        assert.equal(view.projection.fieldValidated, false);
        return { observedSourceIds: ids, projection: view.projection };
      });
    const patchesBeforePayment = recipient.requests.filter((r: any) => r.method === "PATCH").length;
    if (invoiceChallenge !== null) {
      await run("W030-original-invoice-amount-" + invoiceChallenge, { invoiceRefs, originalPerInstanceMinor: "100" },
        { deliveryPreserved: true, originalTermsContradiction: true, financialReconciliation: false,
          paymentPatches: 0, replacementBudget: false }, async () => {
          await bind("PAY", invoiceRefs); await pump(); view = await read();
          assert.equal(view.projection.operationallyComplete, true);
          assert.equal(view.projection.financiallyReconciled, false);
          assert.deepEqual(new Set(view.projection.unreconciledInvoiceSources.map((r: any) => r.sourceId)),
            new Set(invoiceRefs.map(r => r.invoiceSource.sourceId)));
          assert(view.projection.instances.every((i: any) => i.delivered
            && i.contradictions.includes("AGGREGATE_INVOICE_EXCEEDS_ORIGINAL_TERMS")));
          assert(view.gaps.some((gap: string) => gap.startsWith("W3_UNOBSERVED_SERVICE_PAYMENT_FORBIDDEN")));
          const key = serviceExecutionRecordKey({ scope, operation: "PAY", coveredTerms: terms, paymentPlan: invoiceRefs } as any);
          assert.equal(recipient.requests.filter((r: any) => r.recordKey === key && r.method === "PATCH").length, 0);
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, patchesBeforePayment);
          assert.deepEqual(view.budgets.allocationRef, parentAllocation);
          return { view, recipient: recipient.snapshot() };
        });
      const withdrawn = protocols.get(reportKey(terms.at(-1)!) + ":PROVIDER").id;
      await run("W015-W030-retained-invoice-after-revocation-" + invoiceChallenge,
        { protocolId: withdrawn, originalInvoiceSources: invoiceRefs.map(r => r.invoiceSource) },
        { liveDisclosure: null, historicalInvoicesRetained: true, financialReconciliation: false, paymentPatches: 0 }, async () => {
          await ok("real-world-services", "consent", { protocolId: withdrawn, revoke: true }, provider);
          await pump(); view = await read();
          const inbox = await ok("real-world-services", "inbox", {}, provider);
          const receipt = inbox.protocols.find((p: any) => p.id === withdrawn);
          assert.equal(receipt.status, "REVOKED"); assert.equal(receipt.disclosure, null);
          assert.deepEqual(receipt.permittedKinds, []); assert.deepEqual(receipt.criteria, []);
          assert.equal(view.projection.financiallyReconciled, false);
          assert.deepEqual(new Set(view.projection.unreconciledInvoiceSources.map((r: any) => r.sourceId)),
            new Set(invoiceRefs.map(r => r.invoiceSource.sourceId)));
          const key = serviceExecutionRecordKey({ scope, operation: "PAY", coveredTerms: terms, paymentPlan: invoiceRefs } as any);
          assert.equal(recipient.requests.filter((r: any) => r.recordKey === key && r.method === "PATCH").length, 0);
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, patchesBeforePayment);
          return { receipt, view, recipient: recipient.snapshot() };
        });
    } else {
      recipient.loseNextResponse(); recipient.wrongRead(true);
      recipient.killNextPatch(() => { assert(activeWorker?.pid); activeWorker!.kill("SIGKILL") });
      await bind("PAY", invoiceRefs);
      // First tick consumes the new source and durably schedules S6. The second
      // reaches its actual recipient and is physically killed after PATCH commit.
      for (let n = 0; n < 8; n++) {
        const next = (await admin.query(`SELECT type FROM finnor_os.jobs WHERE tenant_id=$1 AND status='queued'
         AND run_at<=clock_timestamp() AND type IN('advance_real_world_service_v1','run_workflow_step_v3')
         ORDER BY priority DESC,run_at,id LIMIT 1`, [tenant])).rows[0];
        assert(next, "Expected canonical service/payment job");
        if (next.type === "run_workflow_step_v3") { await tick(true); break }
        await tick();
      }
      await run("W030-W051-ambiguous-payment-and-physical-kill", { paymentIdentity: obligations.PAY.ref, invoiceRefs },
        { patches: 1, nativeResponsibilityRetained: true, financialReconciliation: false }, async () => {
          const paymentKey = serviceExecutionRecordKey({ scope, operation: "PAY", coveredTerms: terms, paymentPlan: invoiceRefs } as any);
          assert.equal(recipient.requests.filter((r: any) => r.recordKey === paymentKey && r.method === "PATCH").length, 1);
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, patchesBeforePayment + 1);
          view = await read(); assert.equal(view.projection.financiallyReconciled, false);
          assert(view.nativeEffects.some((e: any) => e.operation === "PAY" && e.state === "UNKNOWN"));
          const rows = (await admin!.query(`SELECT j.status,j.claim_token,j.claim_fence,j.lease_expires_at,s.effect_commit_at
           FROM finnor_os.jobs j JOIN finnor_os.workflow_steps s ON s.tenant_id=j.tenant_id
            AND j.payload->>'workflowStepId'=s.id::text
           WHERE j.tenant_id=$1 AND s.business_effect_id=$2`, [tenant, obligations.PAY.effectRef.id])).rows;
          assert(rows.some((r: any) => r.status === "running" && r.effect_commit_at));
          return { view, rows, recipient: recipient.snapshot(), killedWorker: workers.at(-1) };
        });
      const leases = (await admin.query(`SELECT max(lease_expires_at) until FROM finnor_os.jobs
       WHERE tenant_id=$1 AND status='running'`, [tenant])).rows[0].until as Date;
      await new Promise(done => setTimeout(done, Math.max(0, leases.getTime() - Date.now() + 150)));
      const restart = await recipient.restart();
      await tick(); recipient.wrongRead(false);
      for (let n = 0; n < 8; n++) {
        view = await read();
        if (view.nativeEffects.some((e: any) => e.operation === "PAY" && e.state === "VERIFIED")) break;
        const due = (await admin.query(`SELECT min(run_at) at FROM finnor_os.jobs WHERE tenant_id=$1 AND status='queued'
         AND type='run_workflow_step_v3'`, [tenant])).rows[0].at as Date;
        assert(due); await new Promise(done => setTimeout(done, Math.max(0, due.getTime() - Date.now() + 100))); await tick();
      }
      await run("W030-W051-original-identity-read-only-recovery", { paymentIdentity: obligations.PAY.ref },
        { noSecondPatch: true, originalReadbackVerified: true, noFreshBudget: true }, async () => {
          view = await read();
          assert(view.nativeEffects.some((e: any) => e.operation === "PAY" && e.state === "VERIFIED"), JSON.stringify(view));
          const key = serviceExecutionRecordKey({ scope, operation: "PAY", coveredTerms: terms, paymentPlan: invoiceRefs } as any);
          assert.equal(recipient.requests.filter((r: any) => r.recordKey === key && r.method === "PATCH").length, 1);
          assert.equal(recipient.requests.filter((r: any) => r.method === "PATCH").length, patchesBeforePayment + 1);
          assert.notEqual(restart.previousPid, restart.currentPid);
          assert.deepEqual(view.budgets.allocationRef, parentAllocation);
          return { restart, view, recipient: recipient.snapshot() };
        });
      for (const term of terms) {
        await report(term, "ACCEPTANCE_OWNER", { kind: "PAYMENT", invoiceId: "invoice-" + term.instanceId,
          effectRef: obligations.PAY.ref, status: "SETTLED", amount: { currency: "USD", minor: String(currentInvoiceMinor) } }, retireAt);
        if (!commitmentChallenge) await report(term, "ACCEPTANCE_OWNER", { kind: "COST", cost: { id: "compute-unmetered", category: "MODEL_TOOL_COMPUTE",
          amount: null, basis: "UNKNOWN", evidence: [], reason: "Actual local compute is measured by S7 but no authenticated money pricebook exists." } }, retireAt);
      }
      await pump(); view = await read();
      await run("W025-native-S7-and-retained-full-cost-gaps", { originalBusinessAssignments: 1 },
        { operationallyComplete: true, costsNeverInvented: true, S7RecordsPresent: true }, async () => {
          const s7 = (await admin!.query(`SELECT kind,body FROM finnor_os.s7_economic_records WHERE tenant_id=$1
           AND body->'payload'->>'workId'=$2 ORDER BY knowledge_at,record_id`, [tenant, intake.workId])).rows;
          assert(s7.some(r => r.kind === "COMPUTE" && r.body.payload.schema === "finnor.w3.physical-compute.v1"));
          assert(s7.some(r => r.kind === "MEASUREMENT" && r.body.payload.schema === "finnor.w3.service-measurement.v1"));
          assert.equal(view.projection.operationallyComplete, true);
          assert.equal(view.projection.financiallyReconciled, false);
          assert.deepEqual(view.projection.unreconciledInvoiceSources, []);
          assert(view.projection.unknownCostCategories.includes("MODEL_TOOL_COMPUTE"));
          assert.equal(view.program.assignmentCount, 1);
          const work = (await admin!.query("SELECT id,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
            [tenant, intake.workId])).rows[0];
          assert.equal(work.status, "recovery", "Unknown full costs retain canonical reconciliation responsibility");
          return { view, s7, work };
        });
      if (commitmentChallenge) {
        const assertHistoricalFinancialHold = () => {
          assert.deepEqual(view.projection.unreconciledInvoiceSources, []);
          const positive = view.projection.instances.find((i: any) => i.instanceId === terms[0]!.instanceId);
          assert.equal(positive.operationallyComplete, true);
          assert.equal(positive.financiallyReconciled, true, "The current exact provider/terms pair must not block itself");
          assert(positive.commitments.every((c: any) => c.termsDigest === terms[0]!.termsDigest
            || !["ACCEPTED", "CANCELLATION_REQUESTED"].includes(c.state)));
          for (const [index, old] of historicalTerms.slice(1).entries()) {
            const instance = view.projection.instances.find((i: any) => i.instanceId === old.instanceId);
            const retained = instance.commitments.find((c: any) => c.providerId === old.providerId && c.termsDigest === old.termsDigest);
            assert(retained, "The original exact historical commitment must remain visible");
            assert.equal(retained.state, index % 2 === 1 ? "CANCELLATION_REQUESTED" : "ACCEPTED");
            assert.equal(instance.operationallyComplete, true);
            assert.deepEqual(instance.outstandingEffects, []);
            assert.equal(instance.financiallyReconciled, false,
              "W3_OLD_SAME_PROVIDER_TERMS_CANNOT_RECONCILE:" + old.instanceId);
          }
          return { originalTerms: historicalTerms, currentTerms: terms, view, recipient: recipient!.snapshot() };
        };
        await run("W039-same-provider-old-terms-financial-hold",
          { historicalTerms, currentTerms: terms, historicalProtocols, cancellationConfirmation: "NOT_OBSERVED" },
          { currentOnlyPositiveReconciled: true, historicalAcceptedAndRequestedPairsRetained: true,
            oldPairsFinanciallyUnreconciled: 6, noUnsettledCurrentInvoiceOrUnresolvedEffect: true },
          async () => assertHistoricalFinancialHold());
        await run("W039-old-consent-revocation-retains-financial-hold",
          { historicalProtocols, originalTerms: historicalTerms, currentTerms: terms },
          { historicalFinancialHoldsRetained: 6, currentOnlyPositiveStillReconciled: true }, async () => {
            for (const protocol of historicalProtocols)
              await ok("real-world-services", "consent", { protocolId: protocol.id, revoke: true }, protocol.participantId);
            await pump(); view = await read(); return assertHistoricalFinancialHold();
          });
      }
      await artifact("mounted-input.json", { workId: intake.workId, owner, requestId,
        expected: { instances: 7, qualification: "CONTROLLED_DEVELOPMENT_ONLY", fieldValidated: false } });
      if (installation) await mountedServiceProof({
        installation, descriptor: installedDescriptor, auth, owner, participant: provider, companyId: f.root.entityId,
        participantProtocolIds: [discover.protocolId, ...terms.map(t => protocols.get(reportKey(t) + ":PROVIDER").id)],
        revokeProtocolId: protocols.get(reportKey(terms.at(-1)!) + ":PROVIDER").id,
        alternateCompanyId, workId: intake.workId, expectedInstanceIds: demands.map(d => d.id),
        barrier: mountedBarrier, output, artifact, run, pump, checkBound,
        restartApi: () => auth.restartCompiled(),
        revokeOwner: async revoked => { await admin!.query("UPDATE finnor_os.users SET status=$3 WHERE tenant_id=$1 AND id=$2",
          [tenant, owner, revoked ? "inactive" : "active"]) },
        createExpiringProtocol: async () => {
          const createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 20000).toISOString();
          const protocol = await ok("real-world-services", "invite", { requestId, participantId: provider,
            ...terms[0], role: "PROVIDER", criterionIds: [], permittedKinds: ["QUOTE"],
            qualificationRefs: [], incentiveRef: null, expiresAt });
          return { protocolId: protocol.protocolId, expiresAt, createdAt };
        },
        refuseExpiredReport: async protocolId => {
          const count = async () => (await admin!.query(`SELECT count(*)::int n FROM finnor_os.w3_observation_links
           WHERE tenant_id=$1 AND protocol_id=$2`, [tenant, protocolId])).rows[0].n;
          const before = await count();
          const refusal = await http("real-world-services", "report", { protocolId,
            idempotencyKey: "expired-mounted-report", observation: { scope, ...terms[0], at: retireAt,
              kind: "QUOTE", quoteRevision: "quote-1", limits: ["CONTROLLED expired protocol refusal"],
              unobserved: ["All genuine human and physical outcomes"], basis: [] } }, provider);
          assert.equal(refusal.status, 404); assert.equal(await count(), before);
          return { refusal, observationsBefore: before, observationsAfter: await count() };
        },
        snapshot: async () => ({
          requests: (await admin!.query(`SELECT id,generation,wake_revision,parent_allocation,original_deadline,status
           FROM finnor_os.w3_service_requests WHERE tenant_id=$1 AND work_id=$2`, [tenant, intake.workId])).rows,
          jobs: (await admin!.query(`SELECT id,type,status,attempts,claim_fence FROM finnor_os.jobs
           WHERE tenant_id=$1 ORDER BY id`, [tenant])).rows,
          work: (await admin!.query("SELECT id,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
            [tenant, intake.workId])).rows,
        }),
      });
    }
  }
  }
  if (installation) await run("W051-final-installed-byte-and-namespace-custody",
    { installation, descriptorManifestSha256: installedDescriptor.compatibilityManifest.sha256 },
    { exactAllBytesAndModes: true, closedScientificNamespace: true }, async () => {
      assert(installedCustody);
      const began = performance.now(), final = installedCustody();
      assert.equal(final.root, installation);
      assert.equal(final.manifestDigest, installedDescriptor.compatibilityManifest.sha256);
      return { manifestDigest: final.manifestDigest, files: final.manifest.files.length,
        links: final.manifest.links.length, elapsedMs: performance.now() - began, productionActive: false };
    });
  await artifact("controlled-clock.json", clockAdvances);
  await artifact("source-cut.json", { method: await serviceIdentity(), runtime: { node: process.version,
    nodeSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex") },
    lockSha256: createHash("sha256").update(await readFile(join(workspace, "package-lock.json"))).digest("hex"),
    migrations: await Promise.all(migrationNames.map(async name => ({ name,
      sha256: createHash("sha256").update(await readFile(join(workspace, "packages/db/migrations", name))).digest("hex") }))),
    roles: (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows,
    model: "gpt-6.1-sol", reasoning: "max", runtimeLLMCalls: 0, genuineHumanSeconds: 0, realProviderContacts: 0,
    fieldServiceDaysEstablished: 0, productionActive: false, installedDescriptor });
  const finalState = {
    requests: (await admin.query("SELECT * FROM finnor_os.w3_service_requests WHERE tenant_id=$1", [tenant])).rows,
    jobs: (await admin.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY id", [tenant])).rows,
    deliveries: (await admin.query("SELECT * FROM finnor_os.job_delivery_attempts WHERE tenant_id=$1 ORDER BY started_at,id", [tenant])).rows,
    workEvents: (await admin.query("SELECT * FROM finnor_os.work_events WHERE tenant_id=$1 ORDER BY seq", [tenant])).rows,
    works: (await admin.query("SELECT id,status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenant, intake.workId])).rows,
    occupations: (await admin.query(`SELECT * FROM finnor_os.work_programme_occupations
     WHERE tenant_id=$1 AND work_id=$2 ORDER BY owner,programme_id`, [tenant, intake.workId])).rows,
    originalInput: outcome, current: await read(),
  };
  await artifact("native-final-state.json", finalState);
  await run(publicationChallenge ? "W007-refused-publication-original-root-retained"
    : resourceChallenge ? "W005-exhausted-original-responsibility-retained" : "W025-canonical-open-responsibility-and-queue-health",
    { originalWorkId: intake.workId, originalWorkInputId: intake.workInputId },
    publicationChallenge ? { terminalWork: false, prematureCompletionEvents: 0, originalRootRetained: true }
    : { terminalWork: false, prematureCompletionEvents: 0, deliberatelyExhausted: resourceChallenge, activeW3Occupation: true }, async () => {
      assert.equal(finalState.works.length, 1);
      assert(!["completed", "cancelled", "failed"].includes(finalState.works[0].status));
      assert.deepEqual(finalState.workEvents.filter(e => e.work_id === intake.workId && e.to_status === "completed"), []);
      const original = finalState.requests.find(r => r.id === requestId);
      assert(original);
      assert.equal(original.work_id, intake.workId); assert.equal(original.work_input_id, intake.workInputId);
      assert.deepEqual(original.parent_allocation, parentAllocation);
      assert.equal(original.original_deadline.toISOString(), outcome.originalDeadlineAt);
      if (publicationChallenge) return { works: finalState.works, original,
        checkedWorkEvents: finalState.workEvents.filter(event => event.reason === "real_world_service_checked") };
      const unfinished = finalState.jobs.filter(j => !["completed", "cancelled"].includes(j.status));
      if (resourceChallenge) {
        assert(unfinished.length >= 1 && unfinished.length <= 2);
        assert(unfinished.every(j => j.type === "advance_real_world_service_v1"
          && /S5_(?:SERVICE_COMPUTATION_UNFUNDED_OR_EXHAUSTED|EXECUTION_RESOURCE_RECORD_BOUND)/.test(j.last_error ?? "")));
      } else assert.deepEqual(unfinished, []);
      assert(finalState.occupations.some(o => o.owner === "POSTZ.W3" && o.programme_id === requestId
        && ["PROGRESS", "RECONCILING"].includes(o.status)));
      return { works: finalState.works, occupations: finalState.occupations,
        jobStatusCounts: finalState.jobs.reduce((counts, job) => ({ ...counts, [job.status]: (counts[job.status] ?? 0) + 1 }), {} as Record<string, number>) };
    });
} catch (error) {
  await artifact("terminal-failure.json", { message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null }); terminalExit = 1;
  if (admin) {
    try {
      const sources = (await admin.query(`SELECT l.*,v.content_hash,v.content,v.snapshot,s.metadata
       FROM finnor_os.w3_original_source_links l JOIN finnor_os.evidence_source_versions v ON v.id=l.version_id
       JOIN finnor_os.evidence_sources s ON s.id=l.source_id ORDER BY l.created_at`)).rows;
      await artifact("failure-sources.json", sources);
      const diagnostics: Record<string, string> = {
        requests: "SELECT * FROM finnor_os.w3_service_requests ORDER BY created_at",
        protocols: "SELECT * FROM finnor_os.w3_participant_protocols ORDER BY created_at",
        jobs: "SELECT * FROM finnor_os.jobs ORDER BY id",
        attempts: "SELECT * FROM finnor_os.job_delivery_attempts ORDER BY started_at,id",
        policies: "SELECT * FROM pg_policies WHERE tablename LIKE 'w3_%' OR tablename='evidence_source_versions'",
        activity: "SELECT pid,backend_type,application_name,state,wait_event_type,wait_event,xact_start,query_start,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname=current_database()",
      };
      for (const [name, sql] of Object.entries(diagnostics)) {
        try { await artifact("failure-" + name + ".json", (await admin.query(sql)).rows) }
        catch (diagnostic) { await artifact("failure-" + name + "-unavailable.json", { reason: String(diagnostic) }) }
      }
    } catch (diagnostic) { await artifact("failure-database-unavailable.json", { reason: String(diagnostic) }) }
  }
} finally {
  loopDelay.disable(); pg.Client.prototype.query = originalQuery;
  const child = activeWorker as ChildProcess | null;
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (recipient) await recipient.close();
  if (auth) await auth.close();
  if (closePool) await closePool();
  if (admin) await admin.end();
  await postgres.stop().catch(() => undefined);
  await artifact("authentication.json", { authDevBypass: process.env.AUTH_DEV_BYPASS,
    bearerHTTP: true, traffic, credentialsRecorded: false, genuineHumanEstablished: false });
  await artifact("result.json", { schema: "finnor.w3.native-e2e.v1", startedAt, finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - start, results, exitCode: terminalExit, fast, invoiceChallenge, commitmentChallenge,
    pauseChallenge, acceptanceChallenge, observationsChallenge, resourceChallenge, resourceSample, dependencyChallenge,
    cancellationChallenge, cancellationSample, currentnessChallenge, publicationChallenge, largeBasis, family,
    command: ["node", "--import=tsx", "scripts/postz/w3/native.mts", "--output", "<new-absolute-output>",
      ...(fast ? ["--fast"] : []), ...(invoiceChallenge === null ? [] : ["--invoice-challenge", String(invoiceChallenge)]),
      ...(pauseChallenge ? ["--pause-challenge"] : []), ...(acceptanceChallenge ? ["--acceptance-challenge"] : []),
      ...(observationsChallenge ? ["--observations-challenge"] : []),
      ...(resourceChallenge ? ["--resource-challenge", "--resource-sample", String(resourceSample)] : []),
      ...(currentnessChallenge ? ["--currentness-challenge"] : []),
      ...(publicationChallenge ? ["--publication-challenge"] : []),
      ...(dependencyChallenge ? ["--dependency-challenge"] : []),
      ...(cancellationChallenge ? ["--cancellation-challenge", "--cancellation-sample", String(cancellationSample)] : []),
      ...(largeBasis ? ["--large-basis"] : []), ...(family === "COOK_CONTINUITY" ? [] : ["--family", family]),
      ...(commitmentChallenge ? ["--commitment-challenge"] : [])],
    limits: { wallSeconds: maxSeconds, minimumFreeDiskGiB: 4, maximumGeneratedDiskGiB: 6 },
    qualification: "CONTROLLED_ENGINEERING_ONLY_NOT_FIELD_OR_PROTECTED_QUALIFICATION",
    physicalFieldCompletion: false, genuineHumanEvidence: false, productionActive: false });
}
// embedded-postgres's beforeExit hook can otherwise mask process.exitCode.
// Explicitly return the retained terminal result only after every cleanup.
process.exit(terminalExit);
