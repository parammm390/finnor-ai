import { spawn } from "node:child_process";
import { PROFILE } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { Z3NativeFault, z3Fault } from "./contracts";

export interface ViabilityChildObservation {
  pid: number | null; exitCode: number | null; signal: string | null; closed: true;
  inputBytes: number; outputBytes: number; wallMs: number;
}
export class Z3ChildFault extends Z3NativeFault {
  constructor(code: string, readonly observation: ViabilityChildObservation) { super(code); }
}

/** Exactly one JSON result. Abort/cap errors settle only AFTER physical close,
 * so a rejected delivery never leaves a still-running solver/checker behind.
 * Work input is stdin, not argv; no inherited secrets or interpreter hooks. */
export async function runViabilityChild(input: {
  command: string; args: readonly string[]; inputLine: string;
  wallMs: number; signal?: AbortSignal; maxOutputBytes?: number;
}): Promise<{ value: unknown; observation: ViabilityChildObservation }> {
  const maxBytes = input.maxOutputBytes ?? PROFILE.artifactBytes + PROFILE.inputBytes;
  if (!Number.isSafeInteger(input.wallMs) || input.wallMs < 1 || input.wallMs > 300_000) z3Fault("Z3_CHILD_WALL_BOUND");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROFILE.artifactBytes + PROFILE.inputBytes) z3Fault("Z3_CHILD_OUTPUT_BOUND");
  const inputBytes = Buffer.byteLength(input.inputLine);
  if (inputBytes > PROFILE.artifactBytes + PROFILE.inputBytes) z3Fault("Z3_CHILD_INPUT_BOUND");
  if (input.signal?.aborted) z3Fault("Z3_CHILD_ABORTED_BEFORE_SPAWN");
  return new Promise((resolve, reject) => {
    const started = performance.now(), chunks: Buffer[] = [];
    let failure: string | null = null, outputBytes = 0;
    const child = spawn(input.command, [...input.args], {
      stdio: ["pipe", "pipe", "ignore"], env: { LANG: "C.UTF-8", NODE_ENV: "production" },
    });
    const stop = (code: string) => {
      failure ??= code;
      child.kill("SIGKILL");
    };
    const abort = () => stop("Z3_CHILD_ABORTED");
    const timer = setTimeout(() => stop("Z3_CHILD_TIMEOUT"), input.wallMs);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.on("error", () => stop("Z3_CHILD_SPAWN_FAILED"));
    child.stdin.on("error", () => stop("Z3_CHILD_STDIN_FAILED"));
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) stop("Z3_CHILD_OUTPUT_BOUND");
      else if (!failure) chunks.push(chunk);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      const observation: ViabilityChildObservation = {
        pid: child.pid ?? null, exitCode, signal, closed: true,
        inputBytes, outputBytes, wallMs: Math.round(performance.now() - started),
      };
      if (failure) return reject(new Z3ChildFault(failure, observation));
      if (exitCode !== 0 || signal !== null) return reject(new Z3ChildFault("Z3_CHILD_EXIT_NONZERO", observation));
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(line => line.trim().length);
      if (lines.length !== 1 || lines[0] === undefined) return reject(new Z3ChildFault("Z3_CHILD_PROTOCOL_ROWS", observation));
      try { resolve({ value: JSON.parse(lines[0]), observation }); }
      catch { reject(new Z3ChildFault("Z3_CHILD_OUTPUT_MALFORMED", observation)); }
    });
    child.stdin.end(input.inputLine);
  });
}
