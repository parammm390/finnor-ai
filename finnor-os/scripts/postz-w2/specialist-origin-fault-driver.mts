/** Test-only finite root actuator. No install, grants, arbitrary command or signer.
 * An existing, separately qualified isolated root authority must start it.
 * An ACK is not fault evidence: the owning oracle still requires genuine signed
 * original GENESIS/fault tails and independent actual proof/projection/DB checks. */
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { constants } from "node:fs";
import { chown, chmod, lstat, open } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { digest } from "../../packages/capability-evolution/src/contracts";
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { assertVerifiedEnrollment, type VerifiedEnrollment } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { canonical } from "../../packages/governed-execution/src/protocol";
import { ORIGIN_JOURNAL_BYTES, originKeyCustodySchema } from "../../packages/governed-execution/src/specialist-origin-contract";
import { OriginalOriginJournal } from "../../packages/governed-execution/src/specialist-origin-journal";
import { assertRootOriginDirectory, connectRootOriginEndpoint, openOriginExecutable, OriginFrames,
  readActualOriginPeer, readOriginPublicConfiguration, readRootOriginFile, requireOriginLinuxRoot } from "../../packages/governed-execution/src/specialist-origin-custody";
import { loadOriginClockQualification, sampleOriginClock } from "../../packages/governed-execution/src/specialist-origin-verification";
import type { ActualOriginalOriginOwningView } from "../../packages/governed-execution/src/specialist-origin-owning-fixture";
const hex = z.string().regex(/^[a-f0-9]{64}$/), path = z.string().min(2).max(4096).refine(isAbsolute);
export const originalRootFaultOperations = ["CHANGE_EXISTING_KEY_MODE", "CORRUPT_JOURNAL_SUFFIX",
  "KILL_ORIGINAL_GUARDIAN", "CHANGE_WATCHED_SOURCE_BYTE", "EXHAUST_JOURNAL_BYTE_BOUND",
  "ROLLBACK_SIGNED_PREFIX", "STEP_ISOLATED_REALTIME", "CHANGE_ORIGINAL_CGROUP_CONTROL"] as const;
const operation = z.enum(originalRootFaultOperations);
export const qualifiedOriginalRootFaultAuthorizationSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.w3.existing-qualified-isolated-root-fault-authorization.v1"),
    authorizationId: z.string().uuid(), enrollmentDigest: hex, deploymentDigest: hex, clockQualificationDigest: hex,
    existingIsolationQualificationSha256: hex, existingRootAuthorityQualificationSha256: hex,
    sourceUid: z.number().int().positive(), sourceGid: z.number().int().positive(),
    socketPath: path, consumptionDirectory: path, allowedOriginalWorkIds: z.array(z.string().uuid()).min(1).max(32),
    allowedOperations: z.array(operation).min(1).max(8), authorizedFilesystemRoots: z.array(path).min(1).max(8),
    watchedSourcePinPath: path.optional(), nativeFaultExecutable: z.object({ path, sha256: hex }).strict().optional(),
    isolatedRealtimeStepExplicitlyAuthorized: z.boolean(), maximumFaults: z.number().int().min(1).max(32),
    validAfter: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
    developerTestOnly: z.literal(true), installationAuthorized: z.literal(false), newGrantsAuthorized: z.literal(false),
    paidModelAuthorized: z.literal(false), sourceWorkerKillSupported: z.literal(false),
  }).strict(), keyId: z.string().min(1), signature: z.string().min(1),
}).strict();
const requestSchema = z.object({
  type: z.literal("ORIGINAL_ROOT_FAULT"), requestId: hex, authorizationId: z.string().uuid(),
  operation, publicationId: hex, originalSourceDigest: hex, registrationDigest: hex,
}).strict();
const responseSchema = z.object({ type: z.enum(["ORIGINAL_ROOT_FAULT_APPLIED", "ORIGINAL_ROOT_FAULT_REFUSED"]),
  requestId: hex, operation, publicationId: hex }).strict();
export interface ExistingQualifiedRootFaultAuthority {
  readonly authorizationPath: string; readonly existingOperatorPublicKeyPath: string;
  readonly externallyTrustedOperatorPublicKeySha256: string;
  readonly existingIsolationQualificationPath: string; readonly existingRootAuthorityQualificationPath: string;
}
async function nativeFault(pin: { path: string; sha256: string }, args: string[], signal: AbortSignal, clock = false) {
  const executable = await openOriginExecutable(pin);
  try {
    await new Promise<void>((yes, no) => {
      const child = spawn("/proc/self/fd/3", args, { cwd: "/", signal, killSignal: "SIGKILL",
        env: { LANG: "C", TZ: "UTC", ...(clock ? { FINNOR_EXPLICIT_ISOLATED_CLOCK_FAULT: "EXTERNALLY_AUTHORIZED_TEST_ONLY" } : {}) },
        stdio: ["ignore", "pipe", "pipe", executable.fd] });
      let stdout = "", size = 0;
      child.stdout?.on("data", (part: Buffer) => {
        size += part.length; if (size > 4096) child.kill("SIGKILL"); else stdout += part.toString();
      });
      child.stderr?.on("data", (part: Buffer) => { size += part.length; if (size > 4096) child.kill("SIGKILL"); });
      child.on("error", () => no(Error("W3_EXISTING_NATIVE_FAULT_AUTHORITY_UNAVAILABLE")));
      child.on("close", code => code === 0 && size <= 4096 && stdout === '{"status":"ACTUAL_FAULT_APPLIED"}\n'
        ? yes() : no(Error("W3_ACTUAL_NATIVE_FAULT_NOT_ESTABLISHED")));
    });
  } finally { await executable.close(); }
}
export async function serveQualifiedOriginalRootFaultDriver(input: {
  enrollment: VerifiedEnrollment; authority: ExistingQualifiedRootFaultAuthority; signal: AbortSignal;
}) {
  requireOriginLinuxRoot(); assertVerifiedEnrollment(input.enrollment); input.signal.throwIfAborted();
  const config = await readOriginPublicConfiguration(), qualified = await loadOriginClockQualification(input.enrollment, config),
    a = input.authority, keyBytes = await readRootOriginFile(a.existingOperatorPublicKeyPath, 16384);
  if (createHash("sha256").update(keyBytes).digest("hex") !== a.externallyTrustedOperatorPublicKeySha256)
    throw Error("W3_PREEXISTING_EXTERNALLY_QUALIFIED_ROOT_AUTHORITY_REQUIRED");
  const authorization = qualifiedOriginalRootFaultAuthorizationSchema.parse(JSON.parse(
    (await readRootOriginFile(a.authorizationPath, 65536, true)).toString("utf8"))), b = authorization.body,
    key = createPublicKey(keyBytes);
  const hashes = await Promise.all([a.existingIsolationQualificationPath, a.existingRootAuthorityQualificationPath]
    .map(async path => createHash("sha256").update(await readRootOriginFile(path, 262144)).digest("hex")));
  if (key.asymmetricKeyType !== "ed25519" || !verify(null, Buffer.from(canonical(b)), key, Buffer.from(authorization.signature, "base64"))
    || b.enrollmentDigest !== input.enrollment.digest || b.deploymentDigest !== digest(config.qualifiedDeploymentRef)
    || b.clockQualificationDigest !== digest(qualified.body) || b.sourceUid !== config.sourceUid || b.sourceGid !== config.sourceGid
    || hashes[0] !== b.existingIsolationQualificationSha256 || hashes[1] !== b.existingRootAuthorityQualificationSha256
    || b.authorizedFilesystemRoots.some(root => root === "/" || root.split("/").filter(Boolean).length < 2))
    throw Error("W3_ROOT_FAULT_EXTERNAL_QUALIFICATION_OR_SCOPE_REQUIRED");
  const assertAuthorized = () => {
    input.signal.throwIfAborted();
    if (Date.now() <= Date.parse(b.validAfter) || Date.now() >= Date.parse(b.validUntil))
      throw Error("W3_ROOT_FAULT_AUTHORIZATION_NOT_CURRENT");
  };
  const allowedPath = (target: string) => {
    if (!b.authorizedFilesystemRoots.some(root => { const part = relative(root, target); return !!part && !part.startsWith("..") && !isAbsolute(part); }))
      throw Error("W3_ROOT_FAULT_PATH_NOT_IN_EXISTING_ISOLATED_TEST_AUTHORITY");
  };
  allowedPath(b.socketPath); allowedPath(b.consumptionDirectory + "/intent");
  await assertRootOriginDirectory(dirname(b.socketPath)); await assertRootOriginDirectory(b.consumptionDirectory);
  try { await lstat(b.socketPath); throw Error("W3_EXISTING_FAULT_ENDPOINT_NOT_REPLACED"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let spent = 0, inFlight = false; const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.pause();
    void (async () => {
      const peer = await readActualOriginPeer(socket, config, input.signal), frames = new OriginFrames(socket); let used = false;
      frames.onMessage(raw => {
        if (used || inFlight) { frames.fail("W3_FAULT_ONE_OPERATION_ONLY"); return; } used = true; inFlight = true;
        void (async () => {
          assertAuthorized();
          const request = requestSchema.parse(raw);
          if (request.authorizationId !== b.authorizationId || !b.allowedOperations.includes(request.operation)
            || peer.uid !== config.sourceUid || peer.gid !== config.sourceGid || spent >= b.maximumFaults)
            throw Error("W3_ROOT_FAULT_NOT_AUTHORIZED");
          const journals = []; let journalBytes = 0;
          for (const origin of input.enrollment.body.origins) {
            const journal = await OriginalOriginJournal.historical(input.enrollment, origin, request.publicationId, config);
            journalBytes += Buffer.byteLength(canonical(journal.recordsSnapshot));
            if (journalBytes > 16 * 1024 * 1024) throw Error("W3_ROOT_FAULT_TOTAL_JOURNAL_BOUND");
            journals.push(journal);
          }
          const registration = journals[0]!.registration, firstCensus = journals[0]!.recordsSnapshot.find(record => record.body.operation === "CENSUS"),
            native = (firstCensus?.body.value as { native?: { workerStartTicks?: string; guardianStartTicks?: string } })?.native;
          if (!native || registration.sourcePid !== peer.pid || native.workerStartTicks !== peer.startTicks
            || request.originalSourceDigest !== registration.originalSourceDigest || request.registrationDigest !== digest(registration)
            || !b.allowedOriginalWorkIds.includes(registration.binding.originalWorkId)
            || journals.some(journal => digest(journal.registration) !== digest(registration) || journal.sourceEnded)
            || request.operation !== "ROLLBACK_SIGNED_PREFIX" && journals.some(journal => journal.revocations.length !== 0)
            || peer.bootId !== qualified.body.bootId || peer.clockNamespaceDevice !== qualified.body.clockNamespaceDevice
            || peer.clockNamespaceInode !== qualified.body.clockNamespaceInode)
            throw Error("W3_ACTUAL_ORIGINAL_ALL_GENESIS_AND_PEER_REQUIRED");
          const clock = await sampleOriginClock(config, qualified, input.signal);
          if (BigInt(clock.monotonicAfterNs) >= BigInt(registration.nativeBootstrap.deadlineMonotonicNanoseconds))
            throw Error("W3_ROOT_FAULT_ORIGINAL_ALREADY_ENDED");
          const intent = await open(join(b.consumptionDirectory, digest({ authorizationId: b.authorizationId,
            workId: registration.binding.originalWorkId }) + ".json"),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await intent.writeFile(canonical({ requestId: request.requestId, publicationId: request.publicationId,
            operation: request.operation }) + "\n"); await intent.sync(); } finally { await intent.close(); }
          let slotClaimed = false;
          for (let slot = 0; slot < b.maximumFaults; slot++) {
            try {
              const fd = await open(join(b.consumptionDirectory, `${b.authorizationId}.slot-${slot}.json`),
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              try { await fd.writeFile(canonical({ requestId: request.requestId, publicationId: request.publicationId }) + "\n");
                await fd.sync(); } finally { await fd.close(); }
              slotClaimed = true; break;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          }
          if (!slotClaimed) throw Error("W3_ROOT_FAULT_IMMUTABLE_AUTHORIZATION_BUDGET_SPENT");
          const dir = await open(b.consumptionDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await dir.sync(); } finally { await dir.close(); } spent++;
          if (request.operation === "KILL_ORIGINAL_GUARDIAN" || request.operation === "STEP_ISOLATED_REALTIME"
            || request.operation === "CHANGE_ORIGINAL_CGROUP_CONTROL") {
            if (!b.nativeFaultExecutable || request.operation === "STEP_ISOLATED_REALTIME" && !b.isolatedRealtimeStepExplicitlyAuthorized)
              throw Error("W3_EXISTING_QUALIFIED_NATIVE_ROOT_FAULT_REQUIRED");
            let args: string[];
            if (request.operation === "KILL_ORIGINAL_GUARDIAN")
              args = ["--kill-original-guardian", String(registration.nativeBootstrap.guardianPid), native.guardianStartTicks!, String(registration.sourcePid)];
            else if (request.operation === "CHANGE_ORIGINAL_CGROUP_CONTROL") {
              const host = registration.hostReference, group = join(host.cgroupParent, host.cgroupName);
              allowedPath(group + "/pids.max");
              args = ["--change-original-cgroup-pids", group, host.device, host.inode];
            } else args = ["--step-isolated-realtime"];
            await nativeFault(b.nativeFaultExecutable, args, input.signal, request.operation === "STEP_ISOLATED_REALTIME");
          } else {
            const kind = request.operation === "ROLLBACK_SIGNED_PREFIX" ? "CONTROLLER" : "GUARDIAN",
              journal = journals.find(journal => journal.origin.kind === kind)!;
            if (!journal) throw Error("W3_ENROLLED_FAULT_SUBJECT_REQUIRED");
            let target = join(config.journalDirectory, request.publicationId, digest(journal.origin.id) + ".jsonl");
            if (request.operation === "CHANGE_EXISTING_KEY_MODE") {
              const custodyPath = process.env.FINNOR_SPECIALIST_ORIGIN_KEY_CUSTODY;
              if (!custodyPath) throw Error("W3_EXISTING_KEY_CUSTODY_REQUIRED");
              const custody = originKeyCustodySchema.parse(JSON.parse((await readRootOriginFile(custodyPath, 65536, true)).toString()));
              if (custody.publicConfigurationDigest !== digest(config))
                throw Error("W3_EXISTING_KEY_CUSTODY_CONFIGURATION_CHANGED");
              target = custody.keys.find(key => key.originId === journal.origin.id)!.privateKeyPath;
            } else if (request.operation === "CHANGE_WATCHED_SOURCE_BYTE") {
              target = b.watchedSourcePinPath ?? "";
              if (!config.sourcePins.some(pin => pin.path === target)) throw Error("W3_QUALIFIED_WATCHED_SOURCE_REQUIRED");
            }
            allowedPath(target); const originalBytes = await readRootOriginFile(target, ORIGIN_JOURNAL_BYTES);
            if (request.operation === "CHANGE_WATCHED_SOURCE_BYTE"
              && createHash("sha256").update(originalBytes).digest("hex") !== config.sourcePins.find(pin => pin.path === target)!.sha256)
              throw Error("W3_SOURCE_WAS_NOT_THE_UNCHANGED_QUALIFIED_SOURCE");
            const fd = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
            try {
              const before = await fd.stat();
              if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || before.size < 1)
                throw Error("W3_EXISTING_ROOT_FAULT_FILE_REQUIRED");
              if (request.operation === "CHANGE_EXISTING_KEY_MODE") await fd.chmod((before.mode & 0o200) ? 0o400 : 0o600);
              else if (request.operation === "EXHAUST_JOURNAL_BYTE_BOUND") await fd.truncate(ORIGIN_JOURNAL_BYTES + 1);
              else if (request.operation === "ROLLBACK_SIGNED_PREFIX") {
                const records = journal.recordsSnapshot; let seal = -1;
                for (let index = 0; index < records.length; index++) if (records[index]!.body.operation === "SEAL") seal = index;
                if (seal < 0 || seal === records.length - 1) throw Error("W3_REAL_SIGNED_PREFIX_WITH_LATER_TAIL_REQUIRED");
                await fd.truncate(Buffer.byteLength(records.slice(0, seal + 1).map(record => canonical(record) + "\n").join("")));
              } else {
                const offset = request.operation === "CHANGE_WATCHED_SOURCE_BYTE" ? 0 : before.size - 1, one = Buffer.alloc(1);
                if ((await fd.read(one, 0, 1, offset)).bytesRead !== 1) throw Error("W3_ACTUAL_FAULT_BYTE_UNAVAILABLE");
                one[0] = one[0]! ^ 1; await fd.write(one, 0, 1, offset);
              }
              await fd.sync();
            } finally { await fd.close(); }
          }
          await frames.send({ type: "ORIGINAL_ROOT_FAULT_APPLIED", requestId: request.requestId,
            operation: request.operation, publicationId: request.publicationId });
        })().catch(async () => {
          const request = requestSchema.safeParse(raw);
          if (request.success) await frames.send({ type: "ORIGINAL_ROOT_FAULT_REFUSED", requestId: request.data.requestId,
            operation: request.data.operation, publicationId: request.data.publicationId }).catch(() => undefined);
          else frames.fail("W3_ROOT_FAULT_REQUEST_REFUSED");
        }).finally(() => { inFlight = false; });
      }); socket.resume();
    })().catch(() => socket.destroy());
  });
  assertAuthorized();
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(b.socketPath, () => { server.removeListener("error", no); yes(); }); });
  await chown(b.socketPath, 0, config.sourceGid); await chmod(b.socketPath, 0o660);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { for (const socket of sockets) socket.destroy();
    await new Promise<void>(yes => server.close(() => yes())); })();
  input.signal.addEventListener("abort", () => { void close(); }, { once: true });
  return Object.freeze({ close, authorizationId: b.authorizationId, operations: b.allowedOperations.slice() });
}
export async function callQualifiedOriginalRootFault(input: {
  socketPath: string; authorizationId: string; operation: z.infer<typeof operation>;
  actual: ActualOriginalOriginOwningView; signal: AbortSignal;
}) {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(3000)]);
  const config = await readOriginPublicConfiguration(), connected = await connectRootOriginEndpoint(input.socketPath, config, signal),
    frames = new OriginFrames(connected.socket), requestId = randomBytes(32).toString("hex"), r = input.actual.registration;
  try {
    const result = new Promise<void>((yes, no) => {
      frames.onFailure(() => no(Error("W3_QUALIFIED_ROOT_FAULT_UNAVAILABLE")));
      frames.onMessage(raw => {
        const response = responseSchema.safeParse(raw);
        if (!response.success || response.data.requestId !== requestId || response.data.operation !== input.operation
          || response.data.publicationId !== r.publicationId || response.data.type !== "ORIGINAL_ROOT_FAULT_APPLIED")
          no(Error("W3_ACTUAL_QUALIFIED_ROOT_FAULT_NOT_ESTABLISHED")); else yes();
      });
    });
    void result.catch(() => undefined);
    await frames.send({ type: "ORIGINAL_ROOT_FAULT", requestId, authorizationId: input.authorizationId,
      operation: input.operation, publicationId: r.publicationId, originalSourceDigest: r.originalSourceDigest, registrationDigest: digest(r) });
    await result; input.signal.throwIfAborted();
  } finally { frames.socket.destroy(); }
}
const existingRootFaultDriverPlanSchema = z.object({
  schema: z.literal("finnor.w3.existing-root-fault-driver-plan.v1"),
  authorizationPath: path, existingOperatorPublicKeyPath: path, externallyTrustedOperatorPublicKeySha256: hex,
  existingIsolationQualificationPath: path, existingRootAuthorityQualificationPath: path,
  maximumWallMs: z.number().int().min(1000).max(300000),
}).strict();
/** Explicit test entrypoint only. Nothing is installed or activated on import. */
async function rootFaultDriverMain() {
  if (process.argv.length !== 4 || process.argv[2] !== "--serve-qualified-root-fault")
    throw Error("W3_EXISTING_QUALIFIED_ROOT_FAULT_PLAN_REQUIRED");
  requireOriginLinuxRoot();
  const plan = existingRootFaultDriverPlanSchema.parse(JSON.parse((await readRootOriginFile(process.argv[3]!, 65536, true)).toString())),
    stopped = new AbortController(), signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(plan.maximumWallMs)]);
  const stop = () => stopped.abort(Error("W3_EXISTING_ROOT_FAULT_DRIVER_STOPPED"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const authority = await openWorkforceSpecialistPublicationAuthority("reader", true);
  try {
    const driver = await serveQualifiedOriginalRootFaultDriver({ enrollment: authority.enrollment, authority: plan, signal });
    try { await new Promise<void>(yes => { if (signal.aborted) yes(); else signal.addEventListener("abort", () => yes(), { once: true }); }); }
    finally { await driver.close(); }
  } finally { await authority.close(); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void rootFaultDriverMain().catch(() => { process.stderr.write("W3_ROOT_FAULT_DRIVER_NOT_RUN_OR_UNQUALIFIED\n"); process.exitCode = 2; });
