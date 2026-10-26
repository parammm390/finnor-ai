import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export class CapabilityEngineError extends Error {
  constructor(readonly code: string, readonly detail?: string, readonly dispatchDisposition: "NOT_DISPATCHED" | "UNKNOWN" = "UNKNOWN") { super(code); this.name = "CapabilityEngineError"; }
}
export interface EngineLimits { deadlineAt: number; maxOutputBytes?: number; signal?: AbortSignal }
export interface EngineResult { result: Record<string, unknown>; identity: { engine: string; scriptSha256: string; node: string; elapsedMs: number } }
const scripts = { duckdb: "duckdb_engine.py", docling: "docling_engine.py", pywhy: "pywhy_engine.py", pageindex: "pageindex_engine.py", gepa: "gepa_engine.py", shinka: "shinka_engine.py", modal: "modal_engine.py" } as const;
export type PythonEngine = keyof typeof scripts;
let active = 0;
const launcher = [
  "import ctypes, io, json, math, os, resource, runpy, signal, sys, time",
  "raw = sys.stdin.buffer.read(16777217)",
  "payload = json.loads(raw)",
  "remaining = (payload['_finnorDeadlineAt'] - time.time() * 1000) / 1000",
  "if remaining <= 0: raise SystemExit(124)",
  "signal.setitimer(signal.ITIMER_REAL, remaining)",
  "resource.setrlimit(resource.RLIMIT_CPU, (max(1, math.ceil(remaining)), max(1, math.ceil(remaining))))",
  "if sys.platform == 'linux':",
  "    if ctypes.CDLL(None).prctl(1, signal.SIGKILL) != 0 or os.getppid() == 1: raise SystemExit(125)",
  "sys.stdin = io.TextIOWrapper(io.BytesIO(raw), encoding='utf-8')",
  "runpy.run_path(sys.argv[1], run_name='__main__')",
].join("\n");

/** Only trusted, packaged engine programs can execute. No command, module, path,
 * environment or Python executable is accepted from a capability request. This
 * process is for trusted engine code, not a hostile-code sandbox. */
export async function runPythonEngine(engine: PythonEngine, payload: Record<string, unknown>, limits: EngineLimits): Promise<EngineResult> {
  const executable = process.env.FINNOR_CAPABILITY_PYTHON;
  if (!executable) throw new CapabilityEngineError("CAPABILITY_PYTHON_NOT_CONFIGURED", undefined, "NOT_DISPATCHED");
  if (active >= 2) throw new CapabilityEngineError("CAPABILITY_ENGINE_BUSY", undefined, "NOT_DISPATCHED");
  if (!Number.isSafeInteger(limits.deadlineAt) || limits.deadlineAt <= Date.now()) throw new CapabilityEngineError("ENGINE_DEADLINE_EXCEEDED", undefined, "NOT_DISPATCHED");
  const input = JSON.stringify({ ...payload, _finnorDeadlineAt: limits.deadlineAt }), maxOutput = limits.maxOutputBytes ?? 8_388_608;
  if (Buffer.byteLength(input) > 16_777_216) throw new CapabilityEngineError("ENGINE_INPUT_TOO_LARGE", undefined, "NOT_DISPATCHED");
  if (limits.signal?.aborted) throw new CapabilityEngineError("ENGINE_ABORTED", undefined, "NOT_DISPATCHED");
  active++;
  try {
    const path = fileURLToPath(new URL(`./python/${scripts[engine]}`, import.meta.url));
    const sourceSignal = AbortSignal.timeout(Math.min(300_000, limits.deadlineAt - Date.now()));
    const source = await readFile(path, { signal: limits.signal ? AbortSignal.any([limits.signal, sourceSignal]) : sourceSignal });
    const digest = createHash("sha256").update(source).digest("hex"), started = performance.now();
    const remaining = Math.min(300_000, limits.deadlineAt - Date.now());
    if (remaining < 1) throw new CapabilityEngineError("ENGINE_DEADLINE_EXCEEDED", undefined, "NOT_DISPATCHED");
    const data = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ["-I", "-B", "-c", launcher, path], { shell: false, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "production", PYTHONDONTWRITEBYTECODE: "1", OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", LC_ALL: "C" } });
      let bytes = 0, failure: string | null = null, dispatchDisposition: "NOT_DISPATCHED" | "UNKNOWN" = "UNKNOWN", didSpawn = false;
      const chunks: Buffer[] = [];
      const stop = (reason: string) => { failure ??= reason; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop("ENGINE_TIMEOUT"), remaining);
      const abort = () => stop("ENGINE_ABORTED");
      limits.signal?.addEventListener("abort", abort, { once: true });
      if (limits.signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxOutput) stop("ENGINE_OUTPUT_TOO_LARGE"); else chunks.push(chunk); });
      // Child logs can contain document data or provider secrets: do not return them.
      child.stderr.on("data", () => undefined);
      child.once("spawn", () => { didSpawn = true; });
      child.on("error", () => { failure = "ENGINE_EXECUTABLE_UNAVAILABLE"; dispatchDisposition = didSpawn ? "UNKNOWN" : "NOT_DISPATCHED"; });
      child.stdin.on("error", () => undefined);
      child.on("close", code => {
        clearTimeout(timer); limits.signal?.removeEventListener("abort", abort);
        if (failure || code !== 0) reject(new CapabilityEngineError(failure ?? "ENGINE_PROCESS_FAILED", undefined, dispatchDisposition));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.end(input);
    });
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(data); } catch { throw new CapabilityEngineError("ENGINE_INVALID_JSON"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new CapabilityEngineError("ENGINE_INVALID_ENVELOPE");
    if (envelope.ok !== true) throw new CapabilityEngineError(typeof envelope.code === "string" ? envelope.code : "ENGINE_REJECTED", undefined,
      engine === "modal" && envelope.sourceSha256 === digest && envelope.dispatchDisposition === "NOT_DISPATCHED" ? "NOT_DISPATCHED" : "UNKNOWN");
    if (envelope.sourceSha256 !== digest) throw new CapabilityEngineError("ENGINE_SOURCE_IDENTITY_MISMATCH");
    if (!envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) throw new CapabilityEngineError("ENGINE_INVALID_RESULT");
    return { result: envelope.result as Record<string, unknown>, identity: { engine, scriptSha256: digest, node: process.version, elapsedMs: performance.now() - started } };
  } finally { active--; }
}
