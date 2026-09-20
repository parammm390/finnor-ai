import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPE3_MANDATORY_CASES, SCOPE3_MANDATORY_CASE_COUNT } from "./scope3-compute-mandatory-cases";
import { SCOPE3_CASE_PROOFS } from "./scope3-compute-case-proofs";

const osRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = resolve(osRoot, "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(label: string, executable: string, args: string[], cwd = osRoot, timeoutMs = 1_800_000): Promise<string> {
  console.log(`SCOPE3_COMMAND_START ${label}`);
  const started = Date.now();
  const output: Buffer[] = [];
  let timedOut = false;
  const code = await new Promise<number>((resolveExit, rejectExit) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, CI: "1", LOG_LEVEL: "silent", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
        FINNOR_SCOPE3_EMIT_ASSERTIONS: "1", VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", rejectExit);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("close", (exitCode) => { clearTimeout(timer); resolveExit(exitCode ?? 1); });
  });
  const text = Buffer.concat(output).toString("utf8");
  if (code !== 0 || timedOut || /SCOPE\d+_CERTIFICATION_FAIL\b/.test(text)) {
    throw new Error(`${label} failed${timedOut ? " (timeout)" : ""}:\n${text.slice(-80_000)}`);
  }
  console.log(`SCOPE3_COMMAND_PASS ${label} ${Date.now() - started}ms`);
  return text;
}

function assertions(output: string, label: string): string[] {
  const marker = output.split(/\r?\n/).find((line) => line.startsWith("SCOPE3_ASSERTIONS_PASS "));
  assert(marker, `${label} omitted exact passing assertion identities`);
  const names = JSON.parse(marker.slice("SCOPE3_ASSERTIONS_PASS ".length)) as unknown;
  assert(Array.isArray(names) && names.length > 0 && names.every((name) => typeof name === "string"),
    `${label} emitted invalid assertion evidence`);
  assert(new Set(names).size === names.length, `${label} emitted duplicate assertion identities`);
  return names;
}

function releaseAssertions(output: string): string[] {
  const tests = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => `node:${match[1]}`);
  assert(tests.length >= 17 && new Set(tests).size === tests.length, "Release policy test evidence is missing or duplicate");
  for (const summary of ["fail 0", "cancelled 0", "skipped 0", "todo 0"]) {
    assert(output.includes(`# ${summary}`), `Release policy tests did not establish ${summary}`);
  }
  assert(!/^not ok\b/m.test(output), "Release policy contains a failing assertion");
  return tests;
}

function scope2Assertions(output: string): string[] {
  const marker = output.split(/\r?\n/).find((line) => line.startsWith("SCOPE2_CERTIFICATION_PASS "));
  assert(marker, "Scope-2 disposable certification did not emit its final result");
  const result = JSON.parse(marker.slice("SCOPE2_CERTIFICATION_PASS ".length)) as {
    status?: string; mandatoryCases?: number; passedCases?: number; failedCases?: number;
    skippedCases?: number; todoCases?: number; executableTests?: number;
    realDatabaseSessions?: number; gates?: Array<{ id: string; status: string }>;
  };
  assert(result.status === "PASS" && result.mandatoryCases === 75 && result.passedCases === 75
    && result.failedCases === 0 && result.skippedCases === 0 && result.todoCases === 0
    && (result.executableTests ?? 0) > 0 && (result.realDatabaseSessions ?? 0) >= 100,
  "Scope-2 certification did not pass all 75 cases with executable/real-session evidence");
  assert(result.gates?.every((gate) => gate.status === "PASS")
    && result.gates.some((gate) => gate.id === "scope1-phase15a"),
  "Scope-2 did not prove the nested Scope-1/Phase-15A regression gate");
  return ["scope2:certified", "scope1:certified"];
}

async function main(): Promise<void> {
  assert(SCOPE3_MANDATORY_CASE_COUNT === 75, "Mandatory-case registry must contain exactly 75 cases");
  const expectedOrdinals = SCOPE3_MANDATORY_CASES.map((item) => item.ordinal);
  assert(expectedOrdinals.every((ordinal, index) => ordinal === index + 1), "Mandatory-case ordinals must be contiguous");
  assert(Object.keys(SCOPE3_CASE_PROOFS).length === 75, "Every mandatory case needs an explicit exact-proof mapping");
  await run("typescript", "npm", ["run", "typecheck"]);
  const focused = await run("focused-disposable-postgres", "npm", ["run", "release:scope3:focused"]);
  const load = await run("100001-job-indexed-load", "npm", ["run", "release:scope3:load"]);
  assert(/SCOPE3_LOAD_MEASURED .*"queuedJobs":100001.*"liveAwsCertified":false/.test(load),
    "Load measurement missing or confused with live AWS certification");
  const historical = await run("historical-forward-upgrade", "npx", ["tsx", "scripts/release/rehearse-historical-upgrade.ts"]);
  assert(historical.includes('"rerun":"no-op"'), "Historical migration rehearsal did not prove idempotent replay");
  assert(historical.includes('"mergedFresh":"PASS"'),
    "Historical migration rehearsal did not prove a fresh install with protected main's migration lineage");
  const scope2 = await run("scope1-scope2-regressions", "npm", ["run", "release:scope2"]);
  const release = await run("phase15a-release-policy", process.execPath,
    ["--test", "scripts/release/compute-plane-policy.test.mjs", "scripts/release/release-policy.test.mjs"], repoRoot);
  const passed = new Set([
    ...assertions(focused, "focused"),
    ...assertions(load, "load"),
    ...scope2Assertions(scope2),
    ...releaseAssertions(release),
  ]);
  const cases = SCOPE3_MANDATORY_CASES.map((item) => {
    const required = SCOPE3_CASE_PROOFS[item.ordinal];
    assert(required && required.length > 0, `${item.id} has no exact proof`);
    const missing = required.filter((identity) => !passed.has(identity));
    return { ordinal: item.ordinal, id: item.id, status: missing.length ? "FAIL" : "PASS", missing };
  });
  const failed = cases.filter((item) => item.status !== "PASS");
  assert(failed.length === 0, `Scope-3 mandatory cases lack passing direct evidence: ${JSON.stringify(failed)}`);
  console.log(`SCOPE3_CERTIFICATION_PASS ${JSON.stringify({ status: "PASS", mandatoryCases: 75,
    passedCases: 75, failedCases: 0, skippedCases: 0, todoCases: 0,
    exactPassingAssertions: passed.size, loadBackend: "disposable-embedded-postgres",
    liveAwsComputeCertification: "SEPARATE_NOT_CLAIMED" })}`);
}

void main().catch((error) => {
  console.error(`SCOPE3_CERTIFICATION_FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
