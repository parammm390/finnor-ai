import { constants } from "node:fs";
import { open, lstat, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Socket, createConnection } from "node:net";
import { byteDigest } from "../../capability-evolution/src/contracts";
import {
  ORIGIN_FRAME_BYTES, originPublicConfigurationSchema, peerSchema,
  type ActualOriginPeer, type OriginPublicConfiguration,
} from "./specialist-origin-contract";
const actualPeers = new WeakSet<object>();
export function assertActualOriginPeer(peer: ActualOriginPeer) {
  if (!actualPeers.has(peer)) throw Error("SPECIALIST_ORIGIN_ACTUAL_SO_PEERCRED_HANDLE_REQUIRED");
}

export function requireOriginLinuxRoot() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw Error("SPECIALIST_ORIGIN_QUALIFIED_ROOT_RUNTIME_REQUIRED");
}
export async function assertRootOriginDirectory(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw Error("SPECIALIST_ORIGIN_ABSOLUTE_CUSTODY_REQUIRED");
  for (let current = path;; current = dirname(current)) {
    const value = await lstat(current);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== 0 || (value.mode & 0o022)
      || await realpath(current) !== current) throw Error("SPECIALIST_ORIGIN_DIRECTORY_CUSTODY");
    if (current === parse(current).root) return;
  }
}
export async function readRootOriginFile(path: string, maximum = ORIGIN_FRAME_BYTES, privateKey = false) {
  await assertRootOriginDirectory(dirname(path));
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat(), named = await lstat(path);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || before.size <= 0 || before.size > maximum
      || (before.mode & 0o022) || privateKey && (before.mode & 0o077)
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink())
      throw Error("SPECIALIST_ORIGIN_FILE_CUSTODY");
    const buffer = Buffer.alloc(before.size + 1); let used = 0;
    while (used < buffer.length) {
      const read = await fd.read(buffer, used, buffer.length - used, null);
      if (!read.bytesRead) break; used += read.bytesRead;
    }
    const bytes = buffer.subarray(0, used), after = await fd.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.ino !== before.ino
      || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1)
      throw Error("SPECIALIST_ORIGIN_CUSTODY_CHANGED");
    return bytes;
  } finally { await fd.close(); }
}
export async function readOriginPublicConfiguration(path = process.env.FINNOR_SPECIALIST_ORIGIN_CONFIG) {
  if (!path) throw Error("SPECIALIST_ORIGIN_GENUINE_CONFIGURATION_REQUIRED");
  return originPublicConfigurationSchema.parse(JSON.parse((await readRootOriginFile(path)).toString("utf8")));
}
export async function openOriginExecutable(value: { path: string; sha256: string }): Promise<FileHandle> {
  await assertRootOriginDirectory(dirname(value.path));
  const fd = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022)
      || !(before.mode & 0o111) || before.size <= 0 || before.size > 4 * 1024 * 1024)
      throw Error("SPECIALIST_ORIGIN_NATIVE_EXECUTABLE_CUSTODY");
    const buffer = Buffer.alloc(before.size + 1); let used = 0;
    while (used < buffer.length) {
      const read = await fd.read(buffer, used, buffer.length - used, null);
      if (!read.bytesRead) break; used += read.bytesRead;
    }
    const bytes = buffer.subarray(0, used), after = await fd.stat();
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || byteDigest(bytes) !== value.sha256) throw Error("SPECIALIST_ORIGIN_NATIVE_EXECUTABLE_CHANGED");
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
export async function readActualOriginPeer(
  socket: Socket, config: OriginPublicConfiguration, signal: AbortSignal,
): Promise<ActualOriginPeer> {
  signal.throwIfAborted();
  // Node 22's actual accepted/connected descriptor is passed to the pinned
  // helper. The helper obtains SO_PEERCRED itself; no claimed PID is trusted.
  const descriptor = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isSafeInteger(descriptor) || Number(descriptor) < 0)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_SOCKET_DESCRIPTOR_REQUIRED");
  const executable = await openOriginExecutable(config.peerExecutable);
  try {
    const abort = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
    const child = spawn("/proc/self/fd/3", ["--peer"], {
      cwd: "/", env: { LANG: "C", TZ: "UTC", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "ignore", executable.fd, Number(descriptor)],
      signal: abort, killSignal: "SIGKILL",
    });
    const raw = await new Promise<unknown>((yes, no) => {
      const chunks: Buffer[] = []; let size = 0, failed = false;
      child.once("error", () => { failed = true; });
      child.stdout?.on("data", (chunk: Buffer) => {
        if ((size += chunk.length) > 8192) { failed = true; child.kill("SIGKILL"); return; }
        chunks.push(chunk);
      });
      child.once("close", (code, stopped) => {
        if (failed || code !== 0 || stopped !== null) { no(Error("SPECIALIST_ORIGIN_PEER_UNAVAILABLE")); return; }
        try { yes(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { no(Error("SPECIALIST_ORIGIN_PEER_INVALID")); }
      });
    });
    abort.throwIfAborted();
    const value = Object.freeze(peerSchema.parse(raw)); actualPeers.add(value); return value;
  } finally { await executable.close(); }
}
export async function connectRootOriginEndpoint(path: string, config: OriginPublicConfiguration, signal: AbortSignal) {
  signal.throwIfAborted();
  await assertRootOriginDirectory(dirname(path));
  const before = await lstat(path);
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o007))
    throw Error("SPECIALIST_ORIGIN_ROOT_ENDPOINT_CUSTODY");
  const socket = createConnection({ path });
  const stop = () => socket.destroy(Error("SPECIALIST_ORIGIN_ORIGINAL_SCOPE_ABORTED"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((yes, no) => { socket.once("connect", yes); socket.once("error", no); });
    const peer = await readActualOriginPeer(socket, config, signal), after = await lstat(path);
    if (peer.uid !== 0 || before.dev !== after.dev || before.ino !== after.ino)
      throw Error("SPECIALIST_ORIGIN_ROOT_ENDPOINT_PEER_CHANGED");
    socket.once("close", () => signal.removeEventListener("abort", stop));
    return { socket, peer };
  } catch (error) {
    signal.removeEventListener("abort", stop); socket.destroy(); throw error;
  }
}
/** A bounded line protocol. It never drops a record or returns a partial frame. */
export class OriginFrames {
  private pending = Buffer.alloc(0);
  private handlers: Array<(value: unknown) => void> = [];
  private failures: Array<(error: Error) => void> = [];
  private ended: Error | null = null;
  private closingByOwner: { yes: () => void; no: (error: Error) => void } | null = null;
  private closedByOwner = false;
  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      if (this.ended) return;
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length > ORIGIN_FRAME_BYTES) { this.fail("SPECIALIST_ORIGIN_FRAME_BOUND"); return; }
      for (;;) {
        const end = this.pending.indexOf(10); if (end < 0) break;
        const line = this.pending.subarray(0, end); this.pending = this.pending.subarray(end + 1);
        try { const value: unknown = JSON.parse(line.toString("utf8")); for (const handler of this.handlers) handler(value); }
        catch { this.fail("SPECIALIST_ORIGIN_FRAME_INVALID"); return; }
      }
    });
    socket.on("error", () => this.fail("SPECIALIST_ORIGIN_CHANNEL_LOST"));
    socket.on("close", (hadError: boolean) => {
      const owned = this.closingByOwner;
      if (owned && !this.ended && !this.pending.length && !hadError) {
        this.closingByOwner = null; this.closedByOwner = true; owned.yes(); return;
      }
      this.fail(this.pending.length ? "SPECIALIST_ORIGIN_TORN_FRAME" : "SPECIALIST_ORIGIN_CHANNEL_LOST");
    });
  }
  onMessage(handler: (value: unknown) => void) { this.handlers.push(handler); }
  onFailure(handler: (error: Error) => void) {
    this.failures.push(handler); if (this.ended) handler(this.ended);
  }
  fail(code: string) {
    if (this.ended) return; this.ended = Error(code);
    const owned = this.closingByOwner; this.closingByOwner = null; owned?.no(this.ended);
    for (const handler of this.failures) handler(this.ended);
    this.socket.destroy();
  }
  /** Transport ownership only, never a source/clock/archive completion proof.
   * The source caller must first confirm its existing END+DRAINED handshake. */
  async closeOwnedTransport() {
    if (this.ended) throw this.ended;
    if (this.closingByOwner || this.closedByOwner) throw Error("SPECIALIST_ORIGIN_OWNED_CLOSE_REPLAY");
    if (this.pending.length) { this.fail("SPECIALIST_ORIGIN_TORN_FRAME"); throw this.ended!; }
    if (this.socket.destroyed || this.socket.errored || this.socket.readableEnded || this.socket.writableEnded
      || !this.socket.readable || !this.socket.writable) {
      this.fail("SPECIALIST_ORIGIN_CHANNEL_LOST"); throw this.ended!;
    }
    await new Promise<void>((yes, no) => {
      this.closingByOwner = { yes, no };
      try { this.socket.destroy(); }
      catch { this.fail("SPECIALIST_ORIGIN_CHANNEL_LOST"); }
    });
    if (this.ended) throw this.ended;
  }
  async send(value: unknown) {
    if (this.ended) throw this.ended;
    if (this.closingByOwner || this.closedByOwner) throw Error("SPECIALIST_ORIGIN_TRANSPORT_CLOSED_BY_OWNER");
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > ORIGIN_FRAME_BYTES) throw Error("SPECIALIST_ORIGIN_FRAME_BOUND");
    await new Promise<void>((yes, no) => this.socket.write(bytes, error => error ? no(error) : yes()));
  }
}
