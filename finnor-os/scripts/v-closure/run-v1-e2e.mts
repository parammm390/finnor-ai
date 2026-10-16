/** Serial independent-fixture groups, never a split same-Work acceptance chain. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../../..");
const scope = join(repo, "scope-v/v1-v5-cumulative-closure");
const argument = process.argv[2], prefix = "--cumulative-allocation=";
assert.equal(process.argv.length, 3, "ONE_EXACT_ALLOCATION_REQUIRED");
if (!argument || !argument.startsWith(prefix)) throw Error("EXACT_CUMULATIVE_ALLOCATION_REQUIRED");
const allocationPath = argument.slice(prefix.length);
assert(resolve(allocationPath) === allocationPath && allocationPath.startsWith(scope + "/") &&
  allocationPath.endsWith(".json"), "EXACT_OWNED_ALLOCATION_REQUIRED");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const allocationBytes = await readFile(allocationPath);
const allocation = JSON.parse(allocationBytes.toString());
const cases = ["authenticated-boundary", "positive", "material-correction", "role", "identity-conflict",
  "wrong-buyer", "stale-interest", "generic-response", "wrong-terms", "unknown-fit", "contradicted-fit",
  "out-of-bounds", "already-active", "preexisting-process", "unresolved-origination", "incomplete-pipeline",
  "refusal", "cancel-before", "kill-after-acceptance", "suppression-no-policy"];
const groups = [cases.slice(0, 7), cases.slice(7, 14), cases.slice(14)];
assert.equal(allocation.schema, "finnor.v.cumulative-v1-allocation.v1");
assert.equal(allocation.authority, "CURRENT_USER_ORIGINAL_V1_V5_LOCAL_ENGINEERING_REQUEST");
assert.deepEqual(allocation.fixtureGroups, groups, "REGISTERED_INDEPENDENT_GROUPS_REQUIRED");
assert.equal(allocation.originalProgrammeGrantsReset, false);
assert.equal(allocation.liveContactAllowed, false);
assert.equal(allocation.publicationAllowed, false);
assert.equal(allocation.deploymentAllowed, false);
const specification = JSON.parse(await readFile(join(repo,
  "scope-v/v1-private-market-opportunity-creation/verification-plan.json"), "utf8"));
assert.deepEqual(allocation.limits, specification.limits, "ORIGINAL_LIMITS_CHANGED");
assert.equal(allocation.originalAllocationSha256, digest(await readFile(join(repo,
  "scope-v/v1-private-market-opportunity-creation/verification/functional-allocation.json"))));
const startedAt = new Date().toISOString(), deadline = Date.parse(allocation.deadline);
assert(Date.parse(allocation.startedAt) <= Date.now() && Date.now() < deadline &&
  deadline - Date.parse(allocation.startedAt) <= specification.limits.functional_campaign_wall_seconds * 1000,
  "REGISTERED_DEADLINE_EXHAUSTED");
const output = join(scope, "evidence", "v1-resource-repair-" + startedAt.replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const sources = async () => {
  const paths = execFileSync("git", ["-C", repo, "ls-files", "-z", "--cached", "--others",
    "--exclude-standard"], { encoding: "utf8" }).split("\0");
  const selected = [...new Set(paths.filter(p => p && !p.startsWith("scope-v/") &&
    !p.startsWith("evidence/") && (/\.(?:ts|tsx|mts|js|mjs|cjs|json|sql|css|m|py|sh)$/.test(p) ||
      p.startsWith("finnor-os/packages/") || p.endsWith("Dockerfile"))))].sort();
  const records: Array<{ path: string; sha256: string }> = [];
  for (let offset = 0; offset < selected.length; offset += 16) records.push(...await Promise.all(
    selected.slice(offset, offset + 16).map(async path => ({
      path, sha256: digest(await readFile(join(repo, path))),
    }))));
  return records;
};
const frozenSources = await sources();
await writeFile(join(output, "freeze.json"), JSON.stringify({
  schema: "finnor.v.serial-v1-freeze.v1", startedAt, allocationPath, allocationSha256: digest(allocationBytes),
  head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  groups, sources: frozenSources, maximumConcurrentGroups: 1,
  perFixtureCpuReservationMicros: "100000000", groupPortfolioCpuMicros: "1000000000",
  originalMemoryGrantBytes: "536870912", workerNodeOptions: "--max-old-space-size=256",
  qualification: "INDEPENDENT_SCENARIOS_NOT_SAME_WORK_V1_V5_PROOF",
}, null, 2) + "\n");
const results: Array<{ group: number; cases: string[]; status: string; evidence?: string;
  evidenceSha256?: string; exitCode?: number | null; signal?: string | null; failure?: string }> = [];
const phaseEvidence = join(repo, "scope-v/v1-private-market-opportunity-creation/evidence");
const save = () => writeFile(join(output, "results.json"), JSON.stringify({
  schema: "finnor.v.serial-v1-results.v1", startedAt, finishedAt: new Date().toISOString(),
  status: results.length === groups.length && results.every(r => r.status === "PASS") ? "PASS" : "INCOMPLETE",
  groups: results, notRun: groups.slice(results.length).flat(),
  qualification: "V1_ASSIGNED_CASES_ONLY_NOT_COMPLETION_ADMISSION_OR_ECONOMICS",
}, null, 2) + "\n");
try {
  for (const [index, assigned] of groups.entries()) {
    assert(Date.now() < deadline, "REGISTERED_DEADLINE_EXHAUSTED");
    assert.equal(digest(await readFile(allocationPath)), digest(allocationBytes), "ALLOCATION_CHANGED");
    assert.deepEqual(await sources(), frozenSources, "SUPERVISED_SOURCE_CHANGED");
    const free = await statfs(repo);
    assert(free.bavail * free.bsize >= 3 * 1024 ** 3, "UNCHANGED_THREE_GIB_RESOURCE_FLOOR");
    const before = new Set(await readdir(phaseEvidence).catch(() => [] as string[]));
    const child: ChildProcess = spawn(process.execPath, ["--import=tsx", join(repo, "finnor-os/scripts/v1/run-local.mts"),
      argument, "--cases=" + assigned.join(",")], {
      cwd: join(repo, "finnor-os"), env: { ...process.env, FINNOR_V1_ONE_CLIENT_PROOF: "1" },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const collect = (b: Buffer) => { if (log.length < 262144) log += b.toString(); };
    child.stdout!.on("data", collect); child.stderr!.on("data", collect);
    let forced: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      forced = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
      }, 5000);
    }, Math.max(1, deadline - Date.now()));
    const result = { group: index + 1, cases: assigned, status: "FAIL" } as typeof results[number];
    try {
      const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
      result.exitCode = code; result.signal = signal;
      await writeFile(join(output, `group-${index + 1}.log`), log.replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]")
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"), { mode: 0o600 });
      const created = (await readdir(phaseEvidence)).filter(p => !before.has(p) && p.startsWith("run-"));
      assert.equal(created.length, 1, "ONE_CHILD_EVIDENCE_DIRECTORY_REQUIRED");
      const path = join(phaseEvidence, created[0]!, "results.json"), bytes = await readFile(path);
      const observed = JSON.parse(bytes.toString());
      result.evidence = path.slice(repo.length + 1); result.evidenceSha256 = digest(bytes);
      assert.equal(code, 0, "CHILD_CAMPAIGN_FAILED");
      assert.equal(signal, null, "CHILD_CAMPAIGN_INTERRUPTED");
      assert.deepEqual(observed.cases.map((c: { id: string }) => c.id).sort(), [...assigned].sort(),
        "EXACT_ASSIGNED_CASE_COVERAGE_REQUIRED");
      assert(observed.cases.every((c: { status: string }) => c.status === "PASS"), "CHILD_CASE_FAILURE");
      assert.deepEqual(await sources(), frozenSources, "SUPERVISED_SOURCE_CHANGED");
      assert(Date.now() < deadline, "REGISTERED_DEADLINE_EXHAUSTED");
      result.status = "PASS";
    } catch (error) { result.failure = (error as Error).message; }
    finally { clearTimeout(timer); if (forced && !timedOut) clearTimeout(forced); }
    results.push(result); await save();
    console.log(JSON.stringify(result));
  }
} catch (error) {
  await writeFile(join(output, "campaign-failure.json"), JSON.stringify({
    failure: (error as Error).message, at: new Date().toISOString(), remainingCases: groups.slice(results.length).flat(),
  }, null, 2) + "\n");
} finally { await save(); }
if (results.length !== groups.length || results.some(r => r.status !== "PASS")) process.exitCode = 1;
