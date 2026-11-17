/** Actual pidfd/cgroup/inotify observations, never a clock qualification. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { digest } from "../../capability-evolution/src/contracts";
import { assertActualNativeClockSample, type NativeClockSample } from "./specialist-native-clock";
import { openOriginExecutable, requireOriginLinuxRoot } from "./specialist-origin-custody";
import {
  nativeCensusSchema, type NativeOriginCensus, type OriginPublicConfiguration,
  type NativeOriginPhysics,
} from "./specialist-origin-contract";

const actual = new WeakSet<object>();
export type ActualNativeOriginCensus = Readonly<NativeOriginCensus>;
export function assertActualNativeOriginCensus(value: ActualNativeOriginCensus) {
  if (!actual.has(value)) throw Error("SPECIALIST_ORIGIN_ACTUAL_NATIVE_CENSUS_REQUIRED");
}
export function originalOriginProcessIdentity(
  registration: NativeOriginPhysics, census: ActualNativeOriginCensus,
) {
  assertActualNativeOriginCensus(census);
  return processIdentityDigest(registration, census);
}
function processIdentityDigest(registration: NativeOriginPhysics, census: NativeOriginCensus) {
  return digest({
    schema: "finnor.specialist.actual-original-process-identity.v1",
    nativeBootstrapDigest: digest(registration.nativeBootstrap),
    hostReferenceDigest: digest(registration.hostReference),
    worker: { pid: census.workerPid, startTicks: census.workerStartTicks },
    guardian: { pid: census.guardianPid, startTicks: census.guardianStartTicks },
    guest: { pid: census.guestPid, startTicks: census.guestStartTicks },
    bootId: census.bootId,
    clockNamespaceDevice: census.clockNamespaceDevice, clockNamespaceInode: census.clockNamespaceInode,
    cgroupDevice: census.cgroupDevice, cgroupInode: census.cgroupInode,
  });
}
/** Comparison of already authenticated historical fields grants no raw handle. */
export function assertOriginalOriginProcessIdentityFields(
  registration: NativeOriginPhysics, census: NativeOriginCensus, expected: string,
) {
  if (processIdentityDigest(registration, census) !== expected)
    throw Error("SPECIALIST_ORIGIN_AUTHENTICATED_PROCESS_FIELDS_MISMATCH");
}
function argumentsFor(
  config: OriginPublicConfiguration, registration: NativeOriginPhysics,
  namespace: { device: string; inode: string }, nonce: string, snapshot: boolean,
  privateCustodyPaths: readonly string[],
) {
  const host = registration.hostReference, native = registration.nativeBootstrap;
  const files = [...new Set([...config.sourcePins.map(pin => pin.path),
    config.peerExecutable.path, config.watchExecutable.path, config.clockExecutable.path, ...privateCustodyPaths])];
  if (!files.length || files.length > 4224 || privateCustodyPaths.length > 128)
    throw Error("SPECIALIST_ORIGIN_NATIVE_SOURCE_PROFILE_BOUND");
  return [snapshot ? "--snapshot" : "--watch", nonce, String(native.guardianPid), String(native.guestPid),
    String(native.parentPid), join(host.cgroupParent, host.cgroupName), host.device, host.inode,
    namespace.device, namespace.inode, native.deadlineMonotonicNanoseconds, ...files];
}
function observeChild(
  child: ChildProcess, firstNonce: string, registration: NativeOriginPhysics,
  namespace: { device: string; inode: string },
) {
  const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
  if (!stdin || !stdout || !stderr) { child.kill("SIGKILL"); throw Error("SPECIALIST_ORIGIN_NATIVE_PIPE_REQUIRED"); }
  const waiting = new Map<string, { yes: (census: ActualNativeOriginCensus) => void; no: (error: Error) => void }>();
  let pending = Buffer.alloc(0), lost: Error | null = null, ready: ActualNativeOriginCensus | null = null,
    lostCensus: ActualNativeOriginCensus | null = null, childClosed = false, stderrBytes = 0;
  let finishClose!: () => void;
  const closed = new Promise<void>(resolve => { finishClose = resolve; });
  const failures: Array<(error: Error, census: ActualNativeOriginCensus | null) => void> = [];
  const fail = (code: string, census: ActualNativeOriginCensus | null = null) => {
    if (lost) return; lost = Error(code); lostCensus = census;
    for (const waiter of waiting.values()) waiter.no(lost);
    waiting.clear(); for (const handler of failures) handler(lost, census);
  };
  child.on("error", () => fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_LOST"));
  stdin.on("error", () => fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_LOST"));
  stdout.on("error", () => fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_LOST"));
  stderr.on("error", () => fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_LOST"));
  child.on("close", () => { childClosed = true; finishClose(); fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_LOST"); });
  stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 32768) { fail("SPECIALIST_ORIGIN_NATIVE_STDERR_BOUND"); child.kill("SIGKILL"); }
  });
  stdout.on("data", (chunk: Buffer) => {
    if (lost) return;
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 32768) { fail("SPECIALIST_ORIGIN_NATIVE_OUTPUT_BOUND"); child.kill("SIGKILL"); return; }
    for (;;) {
      const end = pending.indexOf(10); if (end < 0) break;
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      try {
        const census = nativeCensusSchema.parse(JSON.parse(line.toString("utf8")));
        if (census.guardianPid !== registration.nativeBootstrap.guardianPid
          || census.guestPid !== registration.nativeBootstrap.guestPid || census.workerPid !== registration.sourcePid
          || census.clockNamespaceDevice !== namespace.device || census.clockNamespaceInode !== namespace.inode
          || census.cgroupDevice !== registration.hostReference.device || census.cgroupInode !== registration.hostReference.inode
          || BigInt(census.fromMonotonicNs) > BigInt(census.throughMonotonicNs))
          throw Error("SPECIALIST_ORIGIN_NATIVE_IDENTITY_CHANGED");
        const value = Object.freeze(census); actual.add(value);
        if (value.type === "REVOKED") { fail("SPECIALIST_ORIGIN_NATIVE_SOURCE_REVOKED", value); continue; }
        if (value.type === "READY") {
          if (ready || value.nonce !== firstNonce) throw Error("SPECIALIST_ORIGIN_NATIVE_GENESIS_REPLAY");
          ready = value;
        } else if (!ready || value.guardianStartTicks !== ready.guardianStartTicks
          || value.guestStartTicks !== ready.guestStartTicks || value.workerStartTicks !== ready.workerStartTicks
          || value.bootId !== ready.bootId) throw Error("SPECIALIST_ORIGIN_NATIVE_PROCESS_REPLACED");
        const waiter = waiting.get(value.nonce);
        if (!waiter) throw Error("SPECIALIST_ORIGIN_UNSOLICITED_NATIVE_BARRIER");
        waiting.delete(value.nonce); waiter.yes(value);
      } catch { fail("SPECIALIST_ORIGIN_NATIVE_CENSUS_INVALID"); child.kill("SIGKILL"); return; }
    }
  });
  const wait = (nonce: string, signal: AbortSignal) => new Promise<ActualNativeOriginCensus>((yes, no) => {
    if (lost || signal.aborted || waiting.has(nonce)) { no(lost ?? Error("SPECIALIST_ORIGIN_NATIVE_BARRIER_ABORTED")); return; }
    const abort = () => { waiting.delete(nonce); no(Error("SPECIALIST_ORIGIN_NATIVE_BARRIER_ABORTED")); };
    signal.addEventListener("abort", abort, { once: true });
    waiting.set(nonce, {
      yes(value) { signal.removeEventListener("abort", abort); yes(value); },
      no(error) { signal.removeEventListener("abort", abort); no(error); },
    });
  });
  return {
    wait,
    onLoss(handler: (error: Error, census: ActualNativeOriginCensus | null) => void) {
      failures.push(handler); if (lost) handler(lost, lostCensus);
    },
    async barrier(through: string, signal: AbortSignal) {
      if (!ready || lost) throw lost ?? Error("SPECIALIST_ORIGIN_NATIVE_GENESIS_REQUIRED");
      const nonce = randomBytes(32).toString("hex"), result = wait(nonce, signal);
      void result.catch(() => undefined);
      try { stdin.write(`BARRIER ${nonce} ${through}\n`, error => { if (error) fail("SPECIALIST_ORIGIN_NATIVE_BARRIER_LOST"); }); }
      catch { fail("SPECIALIST_ORIGIN_NATIVE_BARRIER_LOST"); }
      return result;
    },
    async stop() {
      if (childClosed) return;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    },
  };
}
export async function startActualNativeOriginObserver(input: {
  config: OriginPublicConfiguration; registration: NativeOriginPhysics;
  namespace: { device: string; inode: string }; signal: AbortSignal;
  snapshotOnly?: boolean;
  privateCustodyPaths?: readonly string[];
}) {
  requireOriginLinuxRoot(); input.signal.throwIfAborted();
  const executable = await openOriginExecutable(input.config.watchExecutable);
  try {
    const nonce = randomBytes(32).toString("hex");
    const child = spawn("/proc/self/fd/3", argumentsFor(input.config, input.registration, input.namespace, nonce,
      input.snapshotOnly === true, input.privateCustodyPaths ?? []), {
      cwd: "/", env: { LANG: "C", TZ: "UTC", NODE_ENV: "production" }, stdio: ["pipe", "pipe", "pipe", executable.fd],
      signal: input.signal, killSignal: "SIGKILL",
    });
    const source = observeChild(child, nonce, input.registration, input.namespace);
    let ready: ActualNativeOriginCensus;
    try { ready = await source.wait(nonce, input.signal); }
    catch (error) { await source.stop(); throw error; }
    if (input.snapshotOnly) await source.stop();
    return { ...source, ready };
  } finally { await executable.close(); }
}
/** Root attempt signers can use this actual raw identity. It grants no health. */
export async function readActualNativeOriginIdentity(input: {
  config: OriginPublicConfiguration; registration: NativeOriginPhysics; clock: NativeClockSample; signal: AbortSignal;
}) {
  assertActualNativeClockSample(input.clock);
  const observed = await startActualNativeOriginObserver({
    config: input.config, registration: input.registration,
    namespace: { device: input.clock.clockNamespaceDevice, inode: input.clock.clockNamespaceInode },
    signal: input.signal, snapshotOnly: true,
  });
  if (observed.ready.bootId !== input.clock.bootId) throw Error("SPECIALIST_ORIGIN_ACTUAL_BOOT_CHANGED");
  return observed.ready;
}
