import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_ROOT, byteDigest, canonical, digest, fail, PROFILE, PROFILE_DIGEST, ProblemSchema,
  type Check, type RuntimeIdentity, type InteractionProblem, type InteractionCandidate
} from "./contracts.js";

const PYTHON = "/usr/bin/python3";
const requiredAssets = ["profile.json", "producer.py", "checker.py", "contracts.ts", "exact.ts", "game.ts", "producer.ts", "process.ts"] as const;
async function pinnedRead(path: string, maximum = 32 * 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > maximum) fail("Y3_UNSAFE_RUNTIME_ASSET");
    const bytes = await fd.readFile();
    const after = await fd.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino) fail("Y3_RUNTIME_ASSET_CHANGED");
    return bytes;
  } finally { await fd.close(); }
}
const digestCache=new Map<string,{stamp:string;sha256:string}>();
async function runtimeDigest(path:string,maximum:number,cache:boolean){
 if(!cache)return byteDigest(await pinnedRead(path,maximum));
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const stamp=(value:Awaited<ReturnType<typeof fd.stat>>)=>[value.dev,value.ino,value.size,value.mtimeMs,value.ctimeMs].join(':');
 try{
  const before=await fd.stat();
  if(!before.isFile()||before.size>maximum)fail('Y3_UNSAFE_RUNTIME_ASSET');
  const key=stamp(before),previous=digestCache.get(path);
  if(previous?.stamp===key)return previous.sha256;
  const bytes=await fd.readFile(),after=await fd.stat();
  if(stamp(after)!==key||bytes.length!==before.size)fail('Y3_RUNTIME_ASSET_CHANGED');
  const sha256=byteDigest(bytes);digestCache.set(path,{stamp:key,sha256});return sha256;
 }finally{await fd.close();}
}
/** Dispatches default to fresh bytes; owner reads can reuse unchanged file identities. */
export async function runtimeIdentity(cacheUnchangedFiles=false): Promise<RuntimeIdentity> {
  const modulePath = fileURLToPath(import.meta.url);
  const paths = [...new Set([...requiredAssets.map(p => resolve(ASSET_ROOT, p)), modulePath, await realpath(process.execPath)])];
  const outcomes = await Promise.allSettled(paths.map(async path => ({ path, sha256: await runtimeDigest(path,128*1024*1024,cacheUnchangedFiles) })));
  const sourcePins: RuntimeIdentity["sourcePins"] = [];
  for (const result of outcomes) {
    if (result.status === "rejected") throw result.reason;
    sourcePins.push(result.value);
  }
  const asset = (name: string) => sourcePins.find(p => p.path === resolve(ASSET_ROOT, name))!.sha256;
  if (asset("profile.json") !== PROFILE_DIGEST) fail("Y3_LOADED_PROFILE_CHANGED");
  const interpreterPath = await realpath(PYTHON);
  const interpreter = { path: PYTHON, sha256: await runtimeDigest(interpreterPath,32*1024*1024,cacheUnchangedFiles) };
  return {
    profileDigest: asset("profile.json"), producerDigest: asset("producer.py"), checkerDigest: asset("checker.py"),
    codeDigest: digest(sourcePins.map(p => ({ path: basename(p.path), sha256: p.sha256 }))), interpreter,
    sourcePins: [...sourcePins, { path: interpreterPath, sha256: interpreter.sha256 }]
  };
}
type ProcessResult = { value: unknown | null; reason: string | null; runtime: RuntimeIdentity | null; wallMs: number };
function reason(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "";
  return /^Y3_[A-Z0-9_]+$/.test(code) ? code : "Y3_PROCESS_FAILURE";
}
export async function isolatedRequest(
  asset: "producer.py" | "checker.py", body: unknown, deadlineAtEpochMs: number,
  expected?: RuntimeIdentity, signal?: AbortSignal
): Promise<ProcessResult> {
  const start = Date.now();
  let current: RuntimeIdentity | null = null;
  const gap = (code: string): ProcessResult => ({ value: null, reason: code, runtime: current, wallMs: Date.now() - start });
  if (!Number.isSafeInteger(deadlineAtEpochMs) || deadlineAtEpochMs <= Date.now()) return gap("Y3_DEADLINE");
  if (signal?.aborted) return gap("Y3_ABORTED");
  try {
    current = await runtimeIdentity();
    if (expected && canonical(expected) !== canonical(current)) return gap("Y3_RUNTIME_PIN_CHANGED");
    const input = canonical(body);
    if (Buffer.byteLength(input) > PROFILE.maxRequestBytes + PROFILE.maxArtifactBytes + 65536) return gap("Y3_PROCESS_INPUT_BOUND");
    const budget = Math.min(PROFILE.maxProcessWallMs, deadlineAtEpochMs - Date.now());
    if (budget <= 0 || signal?.aborted) return gap(signal?.aborted ? "Y3_ABORTED" : "Y3_DEADLINE");
    const captured = await new Promise<{ output: Buffer; failure: string | null }>((settle) => {
      const child = spawn(PYTHON, ["-I", "-B", resolve(ASSET_ROOT, asset)], {
        cwd: ASSET_ROOT, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", NODE_ENV: "test" },
        stdio: ["pipe", "pipe", "pipe"], detached: true
      });
      let failure: string | null = null, outputBytes = 0;
      const chunks: Buffer[] = [];
      const kill = (code: string) => {
        failure ??= code;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      };
      const abort = () => kill("Y3_ABORTED");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => kill("Y3_PROCESS_WALL_BOUND"), budget);
      child.stdout.on("data", (data: Buffer) => {
        outputBytes += data.length;
        if (outputBytes > PROFILE.maxProcessOutputBytes) kill("Y3_PROCESS_OUTPUT_BOUND");
        else chunks.push(data);
      });
      child.stderr.on("data", (data: Buffer) => {
        outputBytes += data.length;
        if (outputBytes > PROFILE.maxProcessOutputBytes) kill("Y3_PROCESS_OUTPUT_BOUND");
      });
      child.on("error", () => { failure ??= "Y3_PROCESS_START_FAILED"; });
      child.stdin.on("error", () => { failure ??= "Y3_PROCESS_INPUT_CLOSED"; });
      child.on("close", (code, childSignal) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (code !== 0) failure ??= childSignal ? "Y3_PROCESS_RESOURCE_OR_SIGNAL_BOUND" : "Y3_PROCESS_EXIT";
        settle({ output: Buffer.concat(chunks), failure });
      });
      if (signal?.aborted) abort();
      child.stdin.end(input);
    });
    if (captured.failure) return gap(captured.failure);
    if (signal?.aborted || Date.now() >= deadlineAtEpochMs) return gap(signal?.aborted ? "Y3_ABORTED" : "Y3_DEADLINE");
    const after = await runtimeIdentity();
    if (canonical(after) !== canonical(current)) return gap("Y3_RUNTIME_PIN_CHANGED");
    const value: unknown = JSON.parse(captured.output.toString("utf8"));
    return { value, reason: null, runtime: current, wallMs: Date.now() - start };
  } catch (error) { return gap(reason(error)); }
}
export async function independentlyCheck(
  input: InteractionProblem, candidate: InteractionCandidate | null, deadlineAtEpochMs: number,
  runtime?: RuntimeIdentity, signal?: AbortSignal
): Promise<Check> {
  const unknown = (code: string): Check => ({
    schema: "finnor.interaction-check.v1", status: "UNKNOWN", reason: code, profileDigest: PROFILE_DIGEST,
    protectedQualification: false, executionAuthorityGranted: false
  });
  let problem: InteractionProblem;
  try {
    if (Buffer.byteLength(canonical(input)) > PROFILE.maxRequestBytes) return unknown("Y3_REQUEST_BYTE_BOUND");
    problem = ProblemSchema.parse(input);
    if (candidate !== null && Buffer.byteLength(canonical(candidate)) > PROFILE.maxArtifactBytes) return unknown("Y3_ARTIFACT_BYTE_BOUND");
  } catch { return { ...unknown("Y3_PROBLEM_OR_ARTIFACT_SHAPE"), status: "REJECTED" }; }
  const execution = await isolatedRequest("checker.py", { problem, candidate }, deadlineAtEpochMs, runtime, signal);
  if (!execution.value || execution.reason) return { ...unknown(execution.reason ?? "Y3_CHECKER_NO_OUTPUT"), wallMs: execution.wallMs };
  const value = execution.value as Check;
  if (value.schema !== "finnor.interaction-check.v1"
    || !["CHECKED", "INFEASIBLE", "REJECTED", "UNKNOWN", "INCOMPLETE"].includes(value.status)
    || value.protectedQualification !== false || value.executionAuthorityGranted !== false)
    return unknown("Y3_CHECKER_OUTPUT_SHAPE");
  if (value.status === "CHECKED" || value.status === "INFEASIBLE") {
    if (value.problemDigest !== digest(problem) || value.profileDigest !== PROFILE_DIGEST
      || value.checkerDigest !== execution.runtime!.checkerDigest) return unknown("Y3_CHECKER_OUTPUT_BINDING");
  }
  if (value.status === "CHECKED" && (candidate === null || value.candidateDigest !== digest(candidate)
    || value.maxRegret !== "0" || value.globalBeliefConsistency !== true || value.fullDeviationCoverage !== true
    || value.informationValid !== true || value.resourcesValid !== true || value.participationValid !== true))
    return unknown("Y3_CHECKER_OBLIGATION_OUTPUT");
  if (value.status === "INFEASIBLE" && (candidate !== null || value.reason !== "Y3_WHOLE_FAMILY_TERMINAL_OWNER_BOUND"))
    return unknown("Y3_UNSUPPORTED_INFEASIBILITY_OUTPUT");
  return { ...value, checkerDigest: execution.runtime!.checkerDigest, wallMs: execution.wallMs };
}
