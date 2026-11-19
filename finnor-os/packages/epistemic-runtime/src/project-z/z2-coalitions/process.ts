import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProblemSchema, ASSET_ROOT as NATIVE_ROOT, PROFILE_DIGEST as NATIVE_PROFILE,
  type InteractionProblem } from "../../../../private-equity/src/interaction-synthesis/contracts";
import { LIMITS, canonical, digest, byteDigest, fail, ConstructionOutput, CheckOutput,
  type CoalitionConstruction, type CoalitionCheck, type CoalitionRuntime } from "./contracts";

export const ASSET_ROOT = resolve(process.env.FINNOR_Z2_ASSET_ROOT ?? dirname(fileURLToPath(import.meta.url)));
const PYTHON = "/usr/bin/python3";
const ASSETS = ["profile.json", "common.py", "linear.py", "plans.py", "producer.py", "checker.py", "contracts.ts", "process.ts"];
const NATIVE_ASSETS = ["profile.json", "checker.py", "producer.py"];

async function pinned(path: string, max = 128 * 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > max) fail("Z2_UNSAFE_RUNTIME_ASSET");
    const bytes = await fd.readFile(), after = await fd.stat();
    if (before.ino !== after.ino || before.size !== after.size || bytes.length !== before.size ||
      before.mtimeMs !== after.mtimeMs) fail("Z2_RUNTIME_ASSET_CHANGED");
    return bytes;
  } finally { await fd.close(); }
}

export async function coalitionRuntimeIdentity(): Promise<CoalitionRuntime> {
  const paths = [...ASSETS.map(p => resolve(ASSET_ROOT, p)), ...NATIVE_ASSETS.map(p => resolve(NATIVE_ROOT, p)),
    typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url)];
  const settled = await Promise.allSettled([...new Set(paths)].map(async path => ({
    path, sha256: byteDigest(await pinned(path))
  })));
  const assets: CoalitionRuntime["assets"] = [];
  for (const r of settled) {
    if (r.status === "rejected") throw r.reason;
    assets.push(r.value);
  }
  const profileDigest = assets.find(a => a.path === resolve(ASSET_ROOT, "profile.json"))!.sha256;
  const profile = JSON.parse((await pinned(resolve(ASSET_ROOT, "profile.json"))).toString());
  if (canonical(profile) !== canonical(LIMITS) ||
    assets.find(a => a.path === resolve(NATIVE_ROOT, "profile.json"))?.sha256 !== NATIVE_PROFILE)
    fail("Z2_LOADED_PROFILE_CHANGED");
  const python = { path: PYTHON, sha256: byteDigest(await pinned(await realpath(PYTHON))) },
    node = { version: process.version, sha256: byteDigest(await pinned(await realpath(process.execPath))) };
  const body = { schema: "finnor.project-z.z2.runtime.v1" as const, profileDigest, assets, python, node,
    nativeProfileDigest: NATIVE_PROFILE };
  return { ...body, digest: digest(body) };
}

/** Source semantics are shared by API/worker; each dispatch separately pins its emitted module. */
export function coalitionSemanticIdentity(runtime: CoalitionRuntime): string {
  const pins = [
    ...ASSETS.map(name => ({ name: "z2/"+name, path: resolve(ASSET_ROOT, name) })),
    ...NATIVE_ASSETS.map(name => ({ name: "y3/"+name, path: resolve(NATIVE_ROOT, name) }))
  ].map(({ name, path }) => {
    const asset = runtime.assets.find(a => a.path === path);
    if (!asset) fail("Z2_SEMANTIC_SOURCE_PIN_REQUIRED");
    return { name, sha256: asset.sha256 };
  });
  return digest({ schema: runtime.schema, profileDigest: runtime.profileDigest, pins, python: runtime.python,
    node: runtime.node, nativeProfileDigest: runtime.nativeProfileDigest });
}

async function isolated(
  asset: "producer.py" | "checker.py", body: unknown, deadline: number, expected: CoalitionRuntime, signal?: AbortSignal
): Promise<{ value: unknown; wallMs: number }> {
  const started = Date.now();
  if (!Number.isSafeInteger(deadline) || deadline <= started || signal?.aborted) fail("Z2_ORIGINAL_DEADLINE_OR_ABORT");
  const runtime = await coalitionRuntimeIdentity();
  if (runtime.digest !== expected.digest) fail("Z2_RUNTIME_PIN_CHANGED");
  const bytes = canonical(body);
  if (Buffer.byteLength(bytes) > LIMITS.maxRequestBytes + LIMITS.maxArtifactBytes + 65536) fail("Z2_PROCESS_INPUT_BOUND");
  const value = await new Promise<unknown>((accept, reject) => {
    const child = spawn(PYTHON, ["-I", "-B", resolve(ASSET_ROOT, asset)], {
      cwd: ASSET_ROOT, env: { NODE_ENV: "test", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"], detached: true
    });
    let failed: string | null = null, size = 0;
    const chunks: Buffer[] = [];
    const kill = (code: string) => {
      failed ??= code;
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => kill("Z2_ORIGINAL_ABORT");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => kill("Z2_PROCESS_WALL_BOUND"), Math.max(1, Math.min(LIMITS.maxProcessWallMs, deadline-Date.now())));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMITS.maxOutputBytes) kill("Z2_PROCESS_OUTPUT_BOUND"); else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { size += chunk.length; if (size > LIMITS.maxOutputBytes) kill("Z2_PROCESS_OUTPUT_BOUND"); });
    child.on("error", () => { failed ??= "Z2_PROCESS_START_FAILED"; });
    child.stdin.on("error", () => { failed ??= "Z2_PROCESS_INPUT_CLOSED"; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (code !== 0) failed ??= "Z2_PROCESS_EXIT";
      if (failed) { reject(new Error(failed)); return; }
      try { accept(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Z2_PROCESS_JSON")); }
    });
    if (signal?.aborted) abort();
    child.stdin.end(bytes);
  });
  if (signal?.aborted || Date.now() >= deadline) fail("Z2_ORIGINAL_DEADLINE_OR_ABORT");
  if ((await coalitionRuntimeIdentity()).digest !== runtime.digest) fail("Z2_RUNTIME_PIN_CHANGED");
  return { value, wallMs: Date.now()-started };
}

export async function constructCoalitions(
  input: InteractionProblem, deadline: number, runtime: CoalitionRuntime, signal?: AbortSignal
): Promise<CoalitionConstruction> {
  const problem = ProblemSchema.parse(input);
  if (Buffer.byteLength(canonical(problem)) > LIMITS.maxRequestBytes) fail("Z2_REQUEST_BYTE_BOUND");
  const budgetMs = Math.max(0, Math.min(LIMITS.maxProcessWallMs, deadline-Date.now()));
  const r = await isolated("producer.py", { problem, budgetMs }, deadline, runtime, signal);
  const parsed = ConstructionOutput.parse(r.value), value = parsed as unknown as CoalitionConstruction;
  if (value.problemDigest !== digest(problem) || value.profileDigest !== runtime.profileDigest ||
    value.processDigest !== runtime.assets.find(a => a.path === resolve(ASSET_ROOT, "producer.py"))?.sha256)
    fail("Z2_PRODUCER_OUTPUT_BINDING");
  if (Buffer.byteLength(canonical(value)) > LIMITS.maxArtifactBytes) fail("Z2_ARTIFACT_BYTE_BOUND");
  if (value.status === "CANDIDATE" && !value.candidate) fail("Z2_CANDIDATE_REQUIRED");
  return value;
}

export async function independentlyCheckCoalitions(
  input: InteractionProblem, construction: CoalitionConstruction, deadline: number, runtime: CoalitionRuntime, signal?: AbortSignal
): Promise<CoalitionCheck> {
  const problem = ProblemSchema.parse(input);
  const r = await isolated("checker.py", { problem, construction }, deadline, runtime, signal),
    value = CheckOutput.parse(r.value) as CoalitionCheck;
  if (value.profileDigest !== runtime.profileDigest ||
    value.processDigest !== runtime.assets.find(a => a.path === resolve(ASSET_ROOT, "checker.py"))?.sha256)
    fail("Z2_CHECKER_OUTPUT_BINDING");
  if (["CHECKED_CANDIDATE", "CHECKED_INFEASIBLE"].includes(value.status)) {
    if (value.problemDigest !== digest(problem) || value.constructionDigest !== digest(construction))
      fail("Z2_CHECKER_OUTPUT_BINDING");
  }
  if (value.status === "CHECKED_CANDIDATE" && (!construction.candidate ||
    value.candidateDigest !== digest(construction.candidate) || value.allModels !== true ||
    value.allNonemptyCoalitions !== true || value.nativeFullSequentialAndCommonTremble !== true))
    fail("Z2_CHECKER_OBLIGATION_OUTPUT");
  return value;
}
