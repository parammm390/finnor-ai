/** Parent E2E preparation only. No protected authority or external database. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, appendFile, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { migrate } from "../../packages/db/migrate";
import { closePool } from "@finnor/db";
import { currentCodeIdentity } from "../../packages/private-equity/src/evidence-execution/store";
import { ownDisposablePostgres, closeDisposablePostgres } from "./disposable-postgres.mjs";

const start = performance.now(), usage = process.resourceUsage(), startedAt = new Date().toISOString();
const { values } = parseArgs({ options: Object.fromEntries(
  ["phase", "evidence", "python", "tsx", "contract", "baseline", "scenario"].map(key => [key, { type: "string" as const }]),
) });
assert(values.phase === "broken" || values.phase === "repaired", "EXPLICIT_RECOVERY_EPOCH_REQUIRED");
assert(values.scenario === undefined || values.scenario === "control", "REGISTERED_RECOVERY_SCENARIO_REQUIRED");
const controlRecovery = values.scenario === "control";
for (const key of ["evidence", "python", "tsx", "contract"])
  assert(typeof values[key] === "string" && isAbsolute(values[key] as string), "ABSOLUTE_RUNNER_INPUT_REQUIRED");
if (values.phase === "repaired") assert(values.baseline && isAbsolute(values.baseline), "ABSOLUTE_RETAINED_BASELINE_REQUIRED");
const phase = values.phase, destination = values.evidence!, python = values.python!, tsx = values.tsx!;
const repo = resolve(import.meta.dirname, "../../.."), backend = join(repo, "finnor-os");
await mkdir(destination, { recursive: false, mode: 0o700 });
const WRAPPER_MS = 390000, SETUP_OBSERVER_MS = 75000;
const receipt: any = { schema: "finnor.w1.recovery-fixture-bootstrap.v1", status: "IN_PROGRESS", phase, startedAt,
  scenario: controlRecovery ? "CONTROL_W1_PRE_ADMISSION" : "ORIGINAL_EXECUTE_AND_UNKNOWN",
  limits: { wrapperMs: WRAPPER_MS, setupObserverMs: SETUP_OBSERVER_MS, innerRunnerMs: 300000, perCaseMs: 120000 },
  costs: { usd: null, completeChildUsage: null, intervalsNonadditive: true, finalPackagingTail: "UNMETERED" },
  fixtureOnly: true, coldSoftwareInstallation: false, protectedAdmission: false, productionActivated: false };
const save = () => writeFile(join(destination, "bootstrap.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
await save();
let postgres: EmbeddedPostgres | undefined, child: ReturnType<typeof spawn> | undefined, admin: pg.Client | undefined;
let disposable: ReturnType<typeof ownDisposablePostgres> | undefined;
let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let expired = false;
const bound = setTimeout(() => {
  expired = true;
  // The inner runner's own300s alarm cleans its exact case process groups first.
  if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  else void postgres?.stop().catch(() => undefined);
}, WRAPPER_MS);
const secrets: string[] = [];
const redact = (text: string) => secrets.filter(Boolean).sort((a, b) => b.length - a.length)
  .reduce((out, secret) => out.split(secret).join("[REDACTED]"), text);
try {
  receipt.sourceBefore = await currentCodeIdentity();
  receipt.tools = await Promise.all(([["node", process.execPath], ["python", python], ["tsx", tsx]] as const).map(async ([name, path]) => ({
    name, path, resolvedPath: await realpath(path), sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
  })));
  const preflight = spawnSync(python, ["-I", "-B", "-c",
    "import sys,json,numpy,scipy,statsmodels,arch;print(json.dumps({'executable':sys.executable,'prefix':sys.prefix,'basePrefix':sys.base_prefix,'versions':{m.__name__:m.__version__ for m in (numpy,scipy,statsmodels,arch)}}))"],
  { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(preflight.status, 0, "ORIGINAL_NUMERICAL_ENVIRONMENT_REQUIRED");
  receipt.numericalEnvironment = JSON.parse(preflight.stdout);
  assert.equal(await realpath(receipt.numericalEnvironment.executable), await realpath(python), "ACTUAL_PYTHON_EXECUTABLE_REQUIRED");
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => no(Error("LOCAL_PORT_REQUIRED")));
      server.close(error => error ? no(error) : yes(address.port));
    });
  });
  const dataDirectory = await mkdtemp(join(tmpdir(), "finnor-w1-recovery-" + phase + "-"));
  disposable = ownDisposablePostgres(dataDirectory, dataDirectory, join(destination, "disposable-postgres-cleanup.json"));
  const adminPassword = randomUUID(), appPassword = randomUUID(), workerPassword = randomUUID();
  secrets.push(adminPassword, appPassword, workerPassword);
  postgres = disposable.attach(new EmbeddedPostgres({ databaseDir: dataDirectory, user: "finnor", password: adminPassword, port,
    persistent: true, postgresFlags: ["-c", "listen_addresses=127.0.0.1"], onLog: () => undefined, onError: () => undefined }));
  await postgres.initialise();
  await appendFile(join(dataDirectory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  await postgres.start();
  receipt.cluster = { dataDirectory, persistent: true, host: "127.0.0.1", port,
    postgresPid: Number((await readFile(join(dataDirectory, "postmaster.pid"), "utf8")).split("\n")[0]),
    retention: "ORIGINAL_OBSERVATIONS_RETAINED_DISPOSABLE_CLUSTER_REMOVED_IN_FINALLY", databases: [] };
  const environment: Record<string, string> = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  environment.NODE_ENV = "test"; environment.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  const url = (database: string, user: string, password: string) =>
    `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  for (const track of controlRecovery ? ["C"] : ["A", "B"]) {
    const database = "w1_recovery_" + track.toLowerCase();
    await postgres.createDatabase(database);
    const adminUrl = url(database, "finnor", adminPassword), before = performance.now();
    const migrations = await migrate(adminUrl);
    admin = new pg.Client({ connectionString: adminUrl, application_name: "w1-fixture-bootstrap", statement_timeout: 20000 });
    await admin.connect();
    await admin.query(`INSERT INTO finnor_os.compute_resource_policies
      (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
      VALUES('native:p4',2,2,0,60,'explicit disposable P4 fixture; unmetered engineering capacity, not protected funding'),
      ('native:p2',2,2,0,60,'predeclared local P2 fixture capacity; not S5 funding')`);
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD " + admin.escapeLiteral(appPassword));
    await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD " + admin.escapeLiteral(workerPassword));
    const policies = (await admin.query("SELECT resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds FROM finnor_os.compute_resource_policies ORDER BY resource_key")).rows;
    receipt.cluster.databases.push({ track, database, migrationCount: migrations.length, setupWallMs: performance.now() - before, policies });
    environment["FINNOR_W1_RECOVERY_" + track + "_ADMIN_URL"] = adminUrl;
    environment["FINNOR_W1_RECOVERY_" + track + "_APP_URL"] = url(database, "finnor_app", appPassword);
    environment["FINNOR_W1_RECOVERY_" + track + "_WORKER_URL"] = url(database, "finnor_worker", workerPassword);
    secrets.push(...Object.values(environment).filter(value => value.startsWith("postgres://")));
    await admin.end(); admin = undefined;
  }
  receipt.setupWallMs = performance.now() - start;
  assert(receipt.setupWallMs <= SETUP_OBSERVER_MS && !expired, "FIXTURE_SETUP_75S_OBSERVER_BOUND");
  receipt.status = "PREPARED_RUNNING_INNER_EPOCH"; await save();
  const runtimeEvidence = join(destination, "execution");
  const command = [join(backend, "scripts/postz-w1/" + (controlRecovery ? "control-recovery-run.py" : "recovery-run.py")), "--node", process.execPath,
    "--tsx", tsx, "--python", python, "--contract", values.contract!, "--disposable-local-fixtures",
    "--phase", phase, "--evidence", runtimeEvidence,
    ...(values.baseline ? ["--baseline", values.baseline] : [])];
  const launchAt = performance.now(); let output = "", outputBytes = 0;
  const spawned = spawn(python, command, { cwd: backend, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child = spawned;
  childClosed = new Promise((yes, no) => {
    spawned.once("error", no); spawned.once("close", (code, signal) => yes({ code, signal }));
  });
  void childClosed.catch(() => undefined);
  receipt.innerProcess = { pid: child.pid, executable: python, arguments: command, startedAt: new Date().toISOString() };
  await save();
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes <= 8 * 1024 * 1024) output += chunk.toString();
  });
  const exited = await childClosed;
  await writeFile(join(destination, "epoch-wrapper.log"), redact(output), { mode: 0o600 });
  receipt.innerProcess = { ...receipt.innerProcess, ...exited, wallMs: performance.now() - launchAt, outputBytes };
  assert(outputBytes <= 8 * 1024 * 1024 && !expired, "WRAPPER_OUTPUT_OR_TIME_BOUND");
  const result = JSON.parse(await readFile(join(runtimeEvidence, "result.json"), "utf8"));
  const oracle = JSON.parse(await readFile(join(runtimeEvidence, "independent-recovery-oracle.json"), "utf8"));
  receipt.innerResult = result; receipt.independentOracle = oracle;
  assert(result.terminalSourceFreezeMatches && result.baselineUnchanged, "INNER_SOURCE_OR_BASELINE_CUSTODY_FAILED");
  if (phase === "broken") {
    assert.equal(exited.code, 1, "EXPECTED_BROKEN_EXIT_REQUIRED");
    assert(result.status === "FAIL" && result.expectedFailureMatch && oracle.expectedFailureMatch, "EXACT_FIRST_KEY_FAILURE_REQUIRED");
    receipt.status = "EXPECTED_FIRST_FAILURE_RETAINED";
  } else {
    assert.equal(exited.code, 0, "REPAIRED_EPOCH_EXIT_REQUIRED");
    assert(result.status === "PASS" && oracle.status === "PASS", "REGISTERED_PHYSICAL_CASES_MUST_PASS");
    receipt.status = "PASS_LOCAL_REPAIRED_RECOVERY";
  }
} catch (error) {
  receipt.status = "FAIL";
  const message = error instanceof Error ? error.message : "";
  receipt.failure = /^[A-Z][A-Z0-9_]{0,159}$/.test(message) ? message : "FIXTURE_OR_INNER_EPOCH_UNPASSED";
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const owned = child, force = setTimeout(() => owned.kill("SIGKILL"), 5000);
    try {
      owned.kill("SIGTERM");
      assert(childClosed, "OWNED_INNER_CLOSE_OBSERVER_REQUIRED");
      receipt.innerCleanup = { pid: owned.pid, ...(await childClosed), requestedSignal: "SIGTERM" };
    } catch {
      owned.kill("SIGKILL"); receipt.cleanupFailure = "OWNED_INNER_RUNNER_CLOSE_FAILED";
    } finally { clearTimeout(force); }
  }
  receipt.innerChildStopped = !child || child.exitCode !== null || child.signalCode !== null;
  if (!receipt.innerChildStopped) receipt.cleanupFailure = "OWNED_INNER_RUNNER_STILL_LIVE";
  try {
    await closeDisposablePostgres(disposable, [async () => admin?.end(), closePool]);
    receipt.clusterStopped = disposable?.observation.clusterStopped ?? true;
    receipt.disposableDirectoryRemoved = disposable?.observation.directoryRemoved ?? true;
  } catch { receipt.cleanupFailure = "OWNED_CLUSTER_OR_CONNECTION_CLEANUP_FAILED"; }
  clearTimeout(bound);
  receipt.sourceAfter = await currentCodeIdentity();
  receipt.sourceUnchanged = receipt.sourceBefore?.digest === receipt.sourceAfter.digest;
  if (!receipt.sourceUnchanged || receipt.cleanupFailure || expired) receipt.status = "FAIL";
  receipt.completedAt = new Date().toISOString();
  receipt.wallMsThroughCleanup = performance.now() - start;
  receipt.rootUsageBefore = usage; receipt.rootUsageAfter = process.resourceUsage();
  await save();
}
console.log(JSON.stringify({ status: receipt.status, evidence: destination, wallMs: receipt.wallMsThroughCleanup,
  sourceUnchanged: receipt.sourceUnchanged, clusterStopped: receipt.clusterStopped, billingUSD: null }));
process.exitCode = receipt.status === "PASS_LOCAL_REPAIRED_RECOVERY" ? 0 : 1;
