/** Disposable database harness for focused Scope-3 runtime and load tests. This
 * is NOT the complete 75-case certification gate or live AWS certification. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No PostgreSQL port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function runTests(databaseUrl: string, evidencePath: string): Promise<void> {
  const binary = resolve(root, "node_modules/.bin/vitest");
  const load = process.argv.includes("--load");
  const files = load ? ["tests/integration/scope3-compute-load.test.ts"] : [
    "tests/integration/scope3-compute-plane.test.ts",
    "tests/integration/cost-governor.test.ts",
    "tests/unit/scope3-compute-contract.test.ts",
    "tests/unit/compute-backpressure.test.ts",
    "tests/unit/compute-governor-routing.test.ts",
  ];
  const output = await new Promise<{ code: number; text: string }>((resolveOutput, reject) => {
    const child = spawn(binary, ["run", ...files, "--reporter=json", "--maxWorkers=1", "--fileParallelism=false"], {
      cwd: root,
      env: {
        ...process.env,
        CI: "1",
        LOG_LEVEL: "silent",
        FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
        FINNOR_SCOPE3_CERTIFICATION: "1",
        FINNOR_SCOPE3_DISPOSABLE_DB: "1",
        FINNOR_SCOPE3_LOAD_EVIDENCE_FILE: evidencePath,
        DATABASE_URL: databaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveOutput({ code: code ?? 1, text }));
  });
  if (output.code !== 0) throw new Error(output.text.slice(-80_000));
  const jsonLine = output.text.split(/\r?\n/).reverse().find((line) => line.startsWith('{"numTotalTestSuites"'));
  if (!jsonLine) throw new Error(`Vitest did not emit JSON evidence:\n${output.text.slice(-10_000)}`);
  const result = JSON.parse(jsonLine) as {
    success: boolean; numTotalTests: number; numPassedTests: number;
    numFailedTests: number; numPendingTests: number; numTodoTests: number;
    testResults: Array<{ status: string; assertionResults: Array<{ fullName: string; status: string }> }>;
  };
  if (!result.success || result.numTotalTests === 0 || result.numFailedTests !== 0
      || result.numPendingTests !== 0 || result.numTodoTests !== 0
      || result.numPassedTests !== result.numTotalTests) {
    throw new Error(`Focused Scope-3 tests failed or skipped: ${JSON.stringify(result)}`);
  }
  const assertions = result.testResults.flatMap((file) => file.assertionResults);
  if (result.testResults.some((file) => file.status !== "passed")
      || assertions.length !== result.numTotalTests
      || assertions.some((assertion) => assertion.status !== "passed")) {
    throw new Error("Scope-3 test evidence has a non-passing file or assertion");
  }
  if (process.env.FINNOR_SCOPE3_EMIT_ASSERTIONS === "1") {
    console.log(`SCOPE3_ASSERTIONS_PASS ${JSON.stringify(assertions.map((assertion) => assertion.fullName).sort())}`);
  }
  if (load) {
    const measured = JSON.parse(await readFile(evidencePath, "utf8")) as {
      queuedJobs?: number; insertionMs?: number; metricMs?: number;
      fourClassClaimMs?: number; sseConnections?: number; sseHealthP95Ms?: number; liveAwsCertified?: boolean;
      claimPlans?: Record<string, { executionMs: number; jobScans: string[] }>;
    };
    if (measured.queuedJobs !== 100_001 || measured.liveAwsCertified !== false
        || measured.sseConnections !== 30 || !Number.isFinite(measured.sseHealthP95Ms)
        || measured.sseHealthP95Ms! < 0 || measured.sseHealthP95Ms! >= 5_000
        || ![measured.insertionMs, measured.metricMs, measured.fourClassClaimMs]
          .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
        || !["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"].every((workloadClass) => {
          const plan = measured.claimPlans?.[workloadClass];
          return plan && Number.isFinite(plan.executionMs) && plan.executionMs >= 0
            && plan.jobScans.length > 0 && plan.jobScans.every((scan) => scan.includes("Index") && !scan.startsWith("Seq Scan:"));
        })) {
      throw new Error("Scope-3 load test emitted incomplete or invalid measurement evidence");
    }
    console.log(`SCOPE3_LOAD_MEASURED ${JSON.stringify(measured)}`);
  }
  console.log(`SCOPE3_${load ? "LOAD" : "FOCUSED"}_PASS ${result.numPassedTests}/${result.numTotalTests} tests; complete 75-case and live AWS certification remain separate`);
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "finnor-scope3-focused-pg-"));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({
    databaseDir: directory,
    user: "finnor",
    password: "finnor",
    port,
    persistent: false,
    postgresFlags: ["-c", "max_connections=240"],
    onLog: () => undefined,
  });
  try {
    await postgres.initialise();
    await postgres.start();
    const databaseName = `finnor_scope3_cert_${randomUUID().replaceAll("-", "_")}`;
    await postgres.createDatabase(databaseName);
    await runTests(`postgres://finnor:finnor@127.0.0.1:${port}/${databaseName}`,
      join(directory, "scope3-load-evidence.json"));
  } finally {
    await postgres.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
