import { spawn } from "node:child_process";
import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { Certificate, IndependentCheck, Input } from "./contracts";
import { digest } from "./contracts";
import { REPOSITORY } from "./source";
import path from "node:path";

const producerPath = path.join(REPOSITORY, "finnor-os/packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts");
const checkerPath = path.join(REPOSITORY, "finnor-os/packages/epistemic-runtime/src/project-z/z5-institution-linker/checker.py");
export async function pinnedAsset(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw Error("Z5_NATIVE_ASSET_BOUND");
    return createHash("sha256").update(await handle.readFile()).digest("hex");
  } finally { await handle.close(); }
}
export async function runIsolated(executable: string, args: string[], input: unknown, wallMs: number, signal?: AbortSignal) {
  if (!Number.isFinite(wallMs) || wallMs <= 0) throw Error("Z5_ORIGINAL_DEADLINE_EXHAUSTED");
  if (signal?.aborted) throw Error("Z5_PHYSICAL_CLAIM_ABORTED");
  if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024) throw Error("Z5_PROCESS_INPUT_BOUND");
  return new Promise<{ exitCode: number; body: unknown; stdoutDigest: string; wallMs: number }>((resolve, reject) => {
    const started = performance.now(), child = spawn(executable, args, {
      env: { NODE_ENV: "development", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", diagnostic = "", refusal: string | null = null, sampling = false;
    const kill = (reason: string) => { refusal = reason; child.kill("SIGKILL"); };
    const onAbort = () => kill("Z5_PHYSICAL_CLAIM_ABORTED");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => kill("Z5_PHYSICAL_PROCESS_WALL_BOUND"), Math.min(35000, wallMs));
    const memory = setInterval(() => {
      if (!child.pid || sampling) return;
      sampling = true;
      void readFile(`/proc/${child.pid}/status`, "utf8").then(status => {
        const rss = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? 0) * 1024;
        if (rss > 640 * 1024 * 1024) kill("Z5_PHYSICAL_PROCESS_RSS_BOUND");
      }).catch(() => undefined).finally(() => { sampling = false; });
    }, 100);
    child.stdout.on("data", bytes => { output += String(bytes); if (Buffer.byteLength(output) > 24 * 1024 * 1024) kill("Z5_PROCESS_OUTPUT_BOUND"); });
    child.stderr.on("data", bytes => { diagnostic += String(bytes); if (Buffer.byteLength(diagnostic) > 65536) kill("Z5_PROCESS_DIAGNOSTIC_BOUND"); });
    child.on("error", () => { refusal = "Z5_PROCESS_EXECUTABLE_UNAVAILABLE"; });
    child.on("close", code => {
      clearTimeout(timer); clearInterval(memory);
      signal?.removeEventListener("abort", onAbort);
      if (refusal) { reject(Error(refusal)); return; }
      try {
        const body: unknown = JSON.parse(output);
        if (code !== 0) throw Error("Z5_INDEPENDENT_PROCESS_REFUSED");
        resolve({ exitCode: code, body, stdoutDigest: createHash("sha256").update(output).digest("hex"), wallMs: performance.now() - started });
      } catch { reject(Error("Z5_INDEPENDENT_PROCESS_REFUSED")); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
export async function produceInstitution(input: Input, expectedProducer: string, signal?: AbortSignal, deadlineAt = Infinity) {
  if (!/^v22\./.test(process.version) || await pinnedAsset(producerPath) !== expectedProducer) throw Error("Z5_PINNED_NODE22_PRODUCER_REQUIRED");
  const result = await runIsolated(process.execPath, ["--experimental-strip-types", "--max-old-space-size=384", producerPath],
    input, Math.min(input.limits.wallMs + 4000, deadlineAt - Date.now()), signal);
  if (await pinnedAsset(producerPath) !== expectedProducer) throw Error("Z5_PRODUCER_CHANGED_DURING_EXECUTION");
  return result.body as Certificate;
}
export async function independentlyCheckInstitution(input: Input, certificate: Certificate, expectedChecker: string, signal?: AbortSignal, deadlineAt = Infinity) {
  if (await pinnedAsset(checkerPath) !== expectedChecker) throw Error("Z5_CHECKER_SOURCE_NOT_PINNED");
  const result = await runIsolated("/usr/bin/python3", ["-I", "-B", checkerPath], { input, certificate }, Math.min(35000, deadlineAt - Date.now()), signal);
  const check = result.body as IndependentCheck, { costs: _costs, ...claim } = certificate;
  if (check.checked !== true || check.inputDigest !== digest(input) || check.claimDigest !== digest(claim)
    || check.disposition !== certificate.disposition || check.protectedAdmission !== false || check.executionAuthorityGranted !== false
    || await pinnedAsset(checkerPath) !== expectedChecker) throw Error("Z5_INDEPENDENT_ORIGINAL_SEMANTICS_CHECK_REQUIRED");
  return check;
}
export const Z5_ASSETS = { producerPath, checkerPath };
