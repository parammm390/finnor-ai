/**
 * Runs the repository CI `test` job sequence (migrate, seed, legacy fixture seam,
 * LangGraph schema, sharded Vitest) against a disposable embedded PostgreSQL with
 * commit timestamps on. It uses no credentials, listeners other than loopback
 * PostgreSQL, or provider access, and writes one immutable evidence directory.
 *
 *   npx tsx scripts/project-z/run-integrated-regression.mts --evidence=/new/abs/dir [--shard=1/3] [-- vitest file filters]
 *
 * Differences from hosted CI are recorded rather than hidden: PostgreSQL is the
 * embedded build (no pgvector, so FINNOR_TEST_MANAGED_EXTENSIONS=omit) and no Redis
 * service is started.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const evidence = option("evidence");
const shard = option("shard");
const filters = process.argv.includes("--") ? process.argv.slice(process.argv.indexOf("--") + 1) : [];
if (!evidence || !evidence.startsWith("/") || existsSync(evidence)) throw new Error("A new absolute --evidence directory is required");
if (shard !== undefined && !/^[1-9][0-9]*\/[1-9][0-9]*$/.test(shard)) throw new Error("--shard must look like 1/3");
const backend = resolve(dirname(new URL(import.meta.url).pathname), "../..");
await mkdir(evidence, { recursive: true, mode: 0o700 });

const port = await new Promise<number>((done, fail) => {
  const probe = createServer();
  probe.once("error", fail);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (!address || typeof address === "string") return fail(new Error("port"));
    probe.close(() => done(address.port));
  });
});
const directory = await mkdtemp(join(tmpdir(), "finnor-regression-"));
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, "postgres"), user: "finnor", password: "finnor", port, persistent: false,
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories=", "-c", "track_commit_timestamp=on",
    "-c", "max_connections=200", "-c", "shared_buffers=128MB"],
  onLog: () => undefined, onError: () => undefined,
});
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: `postgres://finnor:finnor@127.0.0.1:${port}/finnor`,
  AUTH_DEV_BYPASS: "1",
  FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
  FINNOR_S7_CI_EVIDENCE_DIR: join(evidence, "s7"),
  FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR: join(evidence, "production-query"),
  FINNOR_PE_OBJECTIVE_EVIDENCE_DIR: join(evidence, "pe-objective"),
};
delete env.REDIS_URL;

const steps: Array<Record<string, unknown>> = [];
function run(name: string, argv: string[], timeoutMs: number): Promise<number> {
  const started = Date.now();
  const log = createWriteStream(join(evidence, `${name}.log`), { flags: "wx" });
  return new Promise(done => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: backend, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      log.end();
      const exit = code ?? 128;
      steps.push({ step: name, argv: argv.join(" "), exit, signal, wallMs: Date.now() - started });
      done(exit);
    });
  });
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

let failed = false;
const startedAt = new Date().toISOString();
try {
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase("finnor");
  const npm = ["npm", "run", "--silent"];
  const ordered: Array<[string, string[], number]> = [
    ["migrate", [...npm, "db:migrate"], 20 * 60_000],
    ["seed", [...npm, "db:seed"], 20 * 60_000],
    ["fixture-seam", ["npx", "--no-install", "tsx", "scripts/install-vertical-fixture-seam.ts"], 10 * 60_000],
    ["langgraph", [...npm, "setup:langgraph"], 10 * 60_000],
  ];
  for (const [name, argv, timeout] of ordered) {
    if (await run(name, argv, timeout) !== 0) { failed = true; break; }
  }
  if (!failed) {
    const vitest = ["npx", "--no-install", "vitest", "run", "--exclude", "tests/integration/phase6-conversation-context-kernel.test.ts",
      ...(shard ? [`--shard=${shard}`] : []), "--reporter=default", "--reporter=json",
      `--outputFile.json=${join(evidence, "vitest.json")}`, ...filters];
    if (await run("vitest", vitest, 4 * 3_600_000) !== 0) failed = true;
  }
} finally {
  await postgres.stop().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
let vitest: Record<string, unknown> | null = null;
if (existsSync(join(evidence, "vitest.json"))) {
  const parsed = JSON.parse(readFileSync(join(evidence, "vitest.json"), "utf8"));
  const failures = (parsed.testResults ?? []).filter((file: { status: string }) => file.status !== "passed")
    .map((file: { name: string; status: string; message?: string }) => ({ file: file.name.replace(backend + "/", ""), status: file.status,
      message: String(file.message ?? "").slice(0, 400) }));
  vitest = { numTotalTestSuites: parsed.numTotalTestSuites, numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests,
    numFailedTests: parsed.numFailedTests, numPendingTests: parsed.numPendingTests, numTodoTests: parsed.numTodoTests,
    success: parsed.success, nonPassingFiles: failures, resultSha256: sha(join(evidence, "vitest.json")) };
}
await writeFile(join(evidence, "result.json"), JSON.stringify({
  schema: "finnor.project-z.integrated-regression.v1", startedAt, finishedAt: new Date().toISOString(), shard: shard ?? "ALL",
  status: failed || vitest?.success !== true ? "FAIL" : "PASS", steps, vitest,
  differencesFromHostedCi: ["embedded PostgreSQL without pgvector (extensions omitted)", "no Redis service", "not hosted GitHub execution"],
  environmentNamesOnly: Object.keys(env).filter(key => /^(DATABASE_URL|AUTH_DEV_BYPASS|FINNOR_)/.test(key)).sort(),
  rerun: `cd finnor-os && npx tsx scripts/project-z/run-integrated-regression.mts --evidence=/new/abs/dir${shard ? ` --shard=${shard}` : ""}`,
}, null, 2) + "\n");
process.exit(failed || vitest?.success !== true ? 1 : 0);
