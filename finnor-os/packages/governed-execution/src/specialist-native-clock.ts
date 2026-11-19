/** Actual root-owned native sampling, not clock qualification or a signer port.
 * A later original clock issuer must independently authenticate its qualification
 * and enrolled key, and cannot replace these handles with caller JSON. */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { byteDigest, fault } from "../../capability-evolution/src/contracts";

const integer = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
const sampleSchema = z.object({
  schema: z.literal("finnor.specialist.raw-native-clock-sample.v1"),
  bootId: z.string().uuid(), samplerPid: z.number().int().positive(), parentPid: z.number().int().positive(),
  uid: z.literal(0), clockNamespaceDevice: integer, clockNamespaceInode: integer,
  monotonicBeforeNs: integer, realtimeNs: integer, monotonicAfterNs: integer,
  monotonicClock: z.literal("CLOCK_MONOTONIC"), utcClock: z.literal("CLOCK_REALTIME"),
  qualificationGranted: z.literal(false),
}).strict();
export { sampleSchema as nativeClockSampleSchema };
export type NativeClockSample = Readonly<z.infer<typeof sampleSchema> & { samplerSha256: string }>;
const sampled = new WeakSet<object>();
export function assertActualNativeClockSample(sample: NativeClockSample) {
  if (!sampled.has(sample)) fault("SPECIALIST_ACTUAL_NATIVE_CLOCK_HANDLE_REQUIRED", 503);
}

export async function readActualNativeClockSample(input: {
  executablePath: string; executableSha256: string; signal: AbortSignal;
}): Promise<NativeClockSample> {
  input.signal.throwIfAborted();
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0
    || !isAbsolute(input.executablePath) || resolve(input.executablePath) !== input.executablePath
    || !/^[a-f0-9]{64}$/.test(input.executableSha256))
    fault("SPECIALIST_NATIVE_CLOCK_ROOT_RUNTIME_REQUIRED", 503);
  let ancestor = dirname(input.executablePath);
  for (;;) {
    const st = await lstat(ancestor);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0
      || await realpath(ancestor) !== ancestor) fault("SPECIALIST_NATIVE_CLOCK_EXECUTABLE_CUSTODY", 503);
    input.signal.throwIfAborted();
    if (ancestor === parse(ancestor).root) break;
    ancestor = dirname(ancestor);
  }
  const fd = await open(input.executablePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0
      || (before.mode & 0o111) === 0 || before.size <= 0 || before.size > 4 * 1024 * 1024)
      fault("SPECIALIST_NATIVE_CLOCK_EXECUTABLE_CUSTODY", 503);
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await fd.read(bytes, used, bytes.length - used, null);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await fd.stat();
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1
      || after.ino !== before.ino || after.dev !== before.dev || byteDigest(bytes.subarray(0, used)) !== input.executableSha256)
      fault("SPECIALIST_NATIVE_CLOCK_EXECUTABLE_CHANGED", 503);
    input.signal.throwIfAborted();
    // Execute the pinned descriptor, not a pathname reopened after verification.
    // No shell, credential, dynamic-loader variable or caller argument is used.
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(1000)]);
    const child = spawn("/proc/self/fd/3", [], { cwd: "/", env: { LANG: "C", TZ: "UTC", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "ignore", fd.fd], signal, killSignal: "SIGKILL" });
    const raw = await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0, failureCode: string | null = null;
      child.once("error", () => { failureCode = "SPECIALIST_NATIVE_CLOCK_SAMPLE_UNAVAILABLE"; });
      child.once("close", (code, stopped) => {
        if (failureCode || code !== 0 || stopped !== null) {
          reject(Error(failureCode ?? "SPECIALIST_NATIVE_CLOCK_SAMPLE_UNAVAILABLE")); return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
        catch { reject(Error("SPECIALIST_NATIVE_CLOCK_SAMPLE_INVALID")); }
      });
      if (!child.stdout) {
        failureCode = "SPECIALIST_NATIVE_CLOCK_SAMPLE_UNAVAILABLE"; child.kill("SIGKILL"); return;
      }
      child.stdout.on("data", (chunk: Buffer) => {
        if (failureCode) return;
        if (size + chunk.length > 4096) {
          failureCode = "SPECIALIST_NATIVE_CLOCK_SAMPLE_BOUND"; child.kill("SIGKILL"); return;
        }
        chunks.push(chunk); size += chunk.length;
      });
    });
    signal.throwIfAborted(); input.signal.throwIfAborted();
    const sample = sampleSchema.parse(raw);
    if (sample.samplerPid !== child.pid || sample.parentPid !== process.pid
      || BigInt(sample.monotonicBeforeNs) > BigInt(sample.monotonicAfterNs))
      fault("SPECIALIST_ACTUAL_NATIVE_CLOCK_PROCESS_REQUIRED", 503);
    const value = Object.freeze({ ...sample, samplerSha256: input.executableSha256 });
    sampled.add(value); return value;
  } finally { await fd.close(); }
}
