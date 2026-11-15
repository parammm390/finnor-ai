import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, open, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = join(repository, "finnor-os");
const output = resolve(process.argv[2] ?? join(repository, "docs/transformation/evidence/financial-explanation"));
const mountedInvestmentMemo = ["--mounted-investment-memo", "--mounted-planner-investment-memo"].includes(process.argv[3]);
const plannerInvestmentMemo = ["--planner-investment-memo", "--mounted-planner-investment-memo"].includes(process.argv[3]);
const investmentMemo = mountedInvestmentMemo || plannerInvestmentMemo || process.argv[3] === "--investment-memo";
const mounted = process.argv[3] === "--mounted";
const mountedDocumentReview = process.argv[3] === "--mounted-document-review";
const allWithDocumentReview = process.argv[3] === "--all-with-document-review";
const documentReview = mountedDocumentReview || allWithDocumentReview || process.argv[3] === "--document-review";
const mountedSourceProxyReview = process.argv[3] === "--mounted-source-proxy-review";
const sourceProxyReview = mountedSourceProxyReview || process.argv[3] === "--source-proxy-review";
const pattern = investmentMemo ? "runs a governed Work-scoped downside Scenario"
  : mounted ? "original FIN-01 through the mounted workspace"
  : allWithDocumentReview ? "."
  : documentReview ? "compares current document figures through a signed Investigation"
  : sourceProxyReview ? "reports incomplete coverage for an original merger proxy"
  : process.argv[3] ?? "checked supplied financial|affirmative requested work|source-bound calculation|actual cancellation queues";
const expectedCases = allWithDocumentReview ? 47 : mounted || documentReview || sourceProxyReview || investmentMemo ? 1 : process.argv[3] ? Number(process.argv[4]) : 29;
if (!Number.isSafeInteger(expectedCases) || expectedCases < 1) throw new Error("Supply an exact expected case count after a custom test pattern");
if ((documentReview || mountedInvestmentMemo || plannerInvestmentMemo) && !process.argv[4]) throw new Error("Supply the directory containing the exact management and QoE fixture bytes");
if (sourceProxyReview && !process.argv[4]) throw new Error("Supply the original merger proxy PDF path");
const require = createRequire(join(root, "package.json"));
const EmbeddedPostgres = require("embedded-postgres").default;
await mkdir(output, { recursive: true, mode: 0o700 });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(error => error ? reject(error) : resolvePort(address.port)); });
});
const directory = await mkdtemp(join(tmpdir(), "finnor-explanation-proof-"));
const postgresProfile = { initdbFlags: ["--wal-segsize=1"], postgresFlags: ["-c", "max_wal_size=32MB", "-c", "min_wal_size=4MB", "-c", "checkpoint_timeout=30s", "-c", "unix_socket_directories="] };
let databaseLog = "";
const db = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor", port, persistent: false, ...postgresProfile,
  onLog(chunk) { databaseLog = (databaseLog + chunk).slice(-65_536); } });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "TMPDIR"].includes(key)));
Object.assign(env, { NODE_ENV: "test", CI: "1", LOG_LEVEL: "silent", SECRETS_PROVIDER: "env", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
  RATE_LIMIT_INTAKE_PER_MINUTE: "1000", TSX_DISABLE_CACHE: "1",
  DATABASE_URL: `postgres://finnor:finnor@127.0.0.1:${port}/finnor_explanation_proof`, FINNOR_PE_OBJECTIVE_EVIDENCE_DIR: join(output, "owner-evidence") });
if (investmentMemo) {
  env.FINNOR_IC_MEMO_EVIDENCE_DIR = join(output, "owner-evidence");
  if (process.argv[4]) env.FINNOR_IC_MEMO_SOURCE_DIR = resolve(process.argv[4]);
}
if (mounted) env.FINNOR_MOUNTED_FIN01 = "1";
if (documentReview) env.FINNOR_DOCUMENT_REVIEW_FIXTURES = resolve(process.argv[4]);
if (sourceProxyReview) env.FINNOR_SOURCE_PROXY_PDF = resolve(process.argv[4]);
if (mountedSourceProxyReview) env.FINNOR_SOURCE_PROXY_MOUNTED = "1";
if (mountedDocumentReview) env.FINNOR_DOCUMENT_REVIEW_MOUNTED = "1";
if (mountedInvestmentMemo) env.FINNOR_IC_MEMO_MOUNTED = "1";
if (plannerInvestmentMemo) env.FINNOR_IC_MEMO_PLANNER = "1";
if ((mounted || mountedDocumentReview || mountedInvestmentMemo || mountedSourceProxyReview) && process.env.NEXT_TEST_NATIVE_DIR) env.NEXT_TEST_NATIVE_DIR = process.env.NEXT_TEST_NATIVE_DIR;
const report = { schema: "finnor.financial-explanation-e2e.v1", startedAt: new Date().toISOString(), root,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  pattern, postgresProfile, qualification: investmentMemo ? "Real underwriting and memo worker handlers, signed Investment Committee routes and exact document download." + (mountedInvestmentMemo ? " Includes the mounted Committee and Artifact Canvas." : "") + (plannerInvestmentMemo ? " Uses the ordinary Objective planner and verifies its persisted actions." : "")
    : documentReview
    ? "Signed local Investigation, real Document and Work owners, disposable SQL and exact source-byte witnesses." + (mountedDocumentReview ? " Includes the mounted workspace." : "")
    : sourceProxyReview
    ? "Signed local Investigation and forecast sensitivity export from an original public merger proxy." + (mountedSourceProxyReview ? " Includes browser submission, reload, export and source archival." : "")
    : mounted
    ? "Mounted development Next.js, signed local identity, real API owners and disposable SQL with deterministic proposals."
    : "Disposable SQL, signed HTTP, actual intake, PE calculation owner and persisted readback. Model proposals are deterministic. Live semantic quality and mounted browser acceptance are separate.",
  steps: [], status: "RUNNING" };
const save = () => writeFile(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function command(name, args) {
  const file = await open(join(output, `${name}.log`), "w", 0o600), startedAt = performance.now();
  try {
    const result = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", file.fd, file.fd] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 240000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
    });
    report.steps.push({ name, args, ...result, ms: performance.now() - startedAt }); await save();
    console.log(JSON.stringify(report.steps.at(-1)));
    if (result.code !== 0) throw new Error(`${name} failed`);
  } finally { await file.close(); }
}
let databaseStarted = false;
try {
  await save(); await db.initialise(); await db.start(); databaseStarted = true; await db.createDatabase("finnor_explanation_proof");
  await command("migrations", ["--import=tsx", "packages/db/migrate.ts"]);
  await command("http-acceptance", ["node_modules/vitest/vitest.mjs", "run", investmentMemo ? "tests/integration/private-equity-p4-underwriting.test.ts"
    : "tests/integration/pe-objective-world-scope.test.ts", "--testNamePattern", pattern,
    "--maxWorkers=1", "--fileParallelism=false", "--reporter=default", "--reporter=json", `--outputFile=${join(output, "vitest.json")}`]);
  const verdict = JSON.parse(await readFile(join(output, "vitest.json"), "utf8"));
  const required = verdict.testResults.flatMap(suite => suite.assertionResults).filter(test => new RegExp(pattern).test(test.fullName));
  report.expectedCases = expectedCases; report.executedCases = required.filter(test => test.status === "passed").length;
  if (required.length !== expectedCases || required.some(test => test.status !== "passed")) throw new Error("Required acceptance cases did not all execute and pass");
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.failure = error === undefined ? "Disposable PostgreSQL exited before readiness" : String(error); await save(); }
finally {
  if (databaseStarted) await db.stop().catch(error => { report.cleanupFailure = String(error); report.status = "FAIL"; });
  await writeFile(join(output, "database.log"), databaseLog, { mode: 0o600 });
  await rm(directory, { recursive: true, force: true }); report.finishedAt = new Date().toISOString(); await save();
}
await new Promise(resolveWrite => process.stdout.write(JSON.stringify({
  status: report.status, failure: report.failure, cleanupFailure: report.cleanupFailure,
}) + "\n", resolveWrite));
process.exit(report.status === "PASS" ? 0 : 1);
