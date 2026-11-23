/**
 * Existing fixed jail custody plus a distinct, fail-closed cgroup2 profile.
 *
 * Development-only delegated-cgroup qualification source. No provisioner,
 * admission issuer or production activation is included. The existing ECS Fargate
 * task cannot supply this per-child delegated-cgroup profile.
 *
 * The specialist owner requires the real queue's leaseLossSignal. A heartbeat
 * registration alone cannot observe failed base-job renewal. Loss aborts the
 * model request/body and initiates both process-group and pinned-cgroup stop;
 * publication additionally retains the actual SQL lease token/fence boundary.
 *
 * DESIGN NOTE (S8 lifecycle, W3): the existing institution capability port admits
 * literally DISPOSABLE_TEST_AUTHORITY with protectedQualification:false. The new
 * typed protected domain must inherit the lifecycle gates instead of relabeling
 * that admission: separated Ed25519 proposer/evaluator authorities, source-closure
 * readback, and protectedEvents journaling.
 */
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rmdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonical } from "./protocol";
import { prepareLinuxNodeIsolation } from "./executor-linux";
import { SPECIALIST_HOST_LIMITS as limits, SPECIALIST_PROFILE, SPECIALIST_QUALIFICATION_DOMAIN,
  specialistByteDigest, specialistDigest,
  specialistHostReferenceSchema, specialistIamSessionSourceSchema, specialistMechanismSchema,
  type SpecialistExecutionBinding, type SpecialistHostReference } from "./specialist-contract";

const hex = z.string().regex(/^[a-f0-9]{64}$/), instant = z.string().datetime({ offset: true });
const hostPolicySchema = z.object({
  schema: z.literal("finnor.s6.workforce-specialist-host-policy.v1"), profile: z.literal(SPECIALIST_PROFILE),
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN), productionActive: z.literal(false),
  architecture: z.enum(["x64", "arm64"]), cgroupParent: z.string().startsWith("/sys/fs/cgroup/").max(2048),
  controllerUid: z.number().int().positive(), protectedManifestDigest: hex,
  iamSessionSource: specialistIamSessionSourceSchema,
  validAfter: instant, validUntil: instant,
}).strict();
const protectedManifestSchema = specialistMechanismSchema.omit({
  hostPolicyDigest: true, protectedManifestDigest: true, jailManifestDigest: true,
}).extend({
  schema: z.literal("finnor.s6.protected-specialist-jail.v1"), ordinaryManifestDigest: hex,
  nativeABI: z.literal("LINUX_SPECIALIST_CGROUP2_V1"),
}).strict();
type HostPolicy = z.infer<typeof hostPolicySchema>;
type FileHandle = Awaited<ReturnType<typeof open>>;
const controls: Readonly<Record<string, string>> = Object.freeze({
  "memory.max": String(limits.memoryBytes), "memory.swap.max": "0", "memory.oom.group": "1",
  "pids.max": String(limits.pids), "cpu.max": `${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}`,
  "cpu.max.burst": "0",
});

async function immutableRootFile(path: string, maximum = 65536) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o6022)
      || st.size > maximum || await realpath(path) !== path)
      throw Error("SPECIALIST_HOST_ROOT_CUSTODY_INVALID");
    return await fd.readFile();
  } finally { await fd.close(); }
}

/** No default policy, unsigned profile, Darwin emulation, or provisioner. */
export async function workforceSpecialistHostConfiguration() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || process.getuid?.() === 0)
    throw Error("SPECIALIST_LINUX_NONROOT_HOST_UNAVAILABLE");
  const path = process.env.FINNOR_S6_WORKFORCE_SPECIALIST_HOST_CONFIG;
  const root = process.env.FINNOR_S6_WORKFORCE_SPECIALIST_HOST_ROOT;
  if (!path?.startsWith("/") || !root) throw Error("SPECIALIST_SIGNED_HOST_POLICY_UNAVAILABLE");
  const raw = await immutableRootFile(path), signed = z.object({
    body: hostPolicySchema, keyId: z.string().min(1).max(128), signature: z.string().min(1).max(128),
  }).strict().parse(JSON.parse(raw.toString()));
  const key = createPublicKey(root);
  if (key.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(signed.body)), key, Buffer.from(signed.signature, "base64")))
    throw Error("SPECIALIST_HOST_POLICY_SIGNATURE_INVALID");
  const policy = signed.body;
  if (policy.controllerUid !== process.getuid?.() || policy.architecture !== process.arch
    || policy.iamSessionSource.controllerUid !== policy.controllerUid
    || policy.iamSessionSource.controllerGid !== process.getgid?.()
    || Date.now() < Date.parse(policy.iamSessionSource.validAfter)
    || Date.now() >= Date.parse(policy.iamSessionSource.validUntil)
    || Date.now() < Date.parse(policy.validAfter) || Date.now() >= Date.parse(policy.validUntil)
    || Date.parse(policy.validUntil) <= Date.parse(policy.validAfter)
    || policy.cgroupParent.split("/").some(part => part === "." || part === ".."))
    throw Error("SPECIALIST_HOST_POLICY_SCOPE_OR_TIME_INVALID");
  const base = "/opt/finnor-s6-jail-" + policy.architecture;
  const manifestBytes = await immutableRootFile(base + "/specialist-manifest.json");
  if (specialistByteDigest(manifestBytes) !== policy.protectedManifestDigest)
    throw Error("SPECIALIST_PROTECTED_MANIFEST_CHANGED");
  const manifest = protectedManifestSchema.parse(JSON.parse(manifestBytes.toString()));
  if (manifest.architecture !== policy.architecture
    || specialistByteDigest(await immutableRootFile(base + "/manifest.json")) !== manifest.ordinaryManifestDigest)
    throw Error("SPECIALIST_ORDINARY_JAIL_BINDING_CHANGED");
  const parent = await lstat(policy.cgroupParent);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== policy.controllerUid
    || (parent.mode & 0o022) || await realpath(policy.cgroupParent) !== policy.cgroupParent
    || (await statfs(policy.cgroupParent, { bigint: true })).type !== 0x63677270n)
    throw Error("SPECIALIST_DELEGATED_CGROUP_PARENT_INVALID");
  const enabled = (await readFile(join(policy.cgroupParent, "cgroup.subtree_control"), "utf8")).trim().split(/\s+/);
  if (!["cpu", "memory", "pids"].every(name => enabled.includes(name))
    || (await readFile(join(policy.cgroupParent, "cgroup.type"), "utf8")).trim() !== "domain")
    throw Error("SPECIALIST_AGGREGATE_CONTROLLERS_UNAVAILABLE");
  const { schema: _schema, ordinaryManifestDigest: _ordinary, nativeABI: _abi, ...profile } = manifest;
  const mechanism = specialistMechanismSchema.parse({
    ...profile,
    hostPolicyDigest: specialistDigest(policy), protectedManifestDigest: policy.protectedManifestDigest,
    jailManifestDigest: manifest.ordinaryManifestDigest,
  });
  return { policy, policyDigest: specialistDigest(policy), manifest, mechanism };
}

const counters = (text: string) => new Map(text.trim().split("\n").map(line => {
  const [name, value] = line.trim().split(/\s+/);
  if (!name || !value || !/^\d+$/.test(value)) throw Error("SPECIALIST_KERNEL_METER_INVALID");
  return [name, value] as const;
}));
export interface SpecialistKernelUsage {
  cpuMicros: string | null; memoryPeakBytes: string | null; pidsObserved: string | null;
  pidsPeak: string | null; memoryOomKills: string | null; diskWriteBytes: "0";
  stopped: boolean; cleanupStatus: "NOT_RUN" | "PASS" | "FAIL"; meterGaps: string[];
}

/** The cgroup reference is an observation target, never a model-call permit. */
export async function prepareWorkforceSpecialistHost(scratch: string, node: string,
  binding: SpecialistExecutionBinding, wallTimeMs: number, deadlineNanoseconds: bigint) {
  const configured = await workforceSpecialistHostConfiguration();
  if (!Number.isInteger(wallTimeMs) || wallTimeMs < 100 || wallTimeMs > limits.maximumWallTimeMs
    || Date.parse(binding.effectiveDeadline) <= Date.now()
    || Date.parse(binding.effectiveDeadline) > Date.parse(configured.policy.validUntil)
    || deadlineNanoseconds <= process.hrtime.bigint()
    || deadlineNanoseconds - process.hrtime.bigint() > BigInt(limits.maximumWallTimeMs) * 1000000n)
    throw Error("SPECIALIST_ORIGINAL_LIFETIME_BOUND_INVALID");
  const jail = await prepareLinuxNodeIsolation(scratch, node, { readOnlyScratch: true });
  const name = "job-" + randomUUID(), path = join(configured.policy.cgroupParent, name);
  let group: FileHandle | undefined, created = false;
  try {
    if (jail.profile.manifestDigest !== configured.mechanism.jailManifestDigest
      || jail.profile.binarySha256 !== configured.mechanism.launcherSha256
      || jail.profile.filterSha256 !== configured.mechanism.filterSha256
      || specialistByteDigest(await immutableRootFile(jail.node, 256 * 1024 * 1024)) !== configured.mechanism.nodeSha256)
      throw Error("SPECIALIST_LOADED_NATIVE_PROFILE_SUBSTITUTION");
    await mkdir(path, { mode: 0o700 }); created = true;
    group = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const handle = group, metadata = await handle.stat({ bigint: true }), pinned = "/proc/self/fd/" + handle.fd;
    if (metadata.uid !== BigInt(configured.policy.controllerUid)
      || (await statfs(pinned, { bigint: true })).type !== 0x63677270n)
      throw Error("SPECIALIST_CGROUP_DESCRIPTOR_CUSTODY_INVALID");
    const read = async (name: string) => (await readFile(join(pinned, name), "utf8")).trim();
    const write = async (name: string, value: string) => {
      const fd = await open(join(pinned, name), constants.O_WRONLY | constants.O_NOFOLLOW);
      try { await fd.writeFile(value); } finally { await fd.close(); }
    };
    for (const [name, value] of Object.entries(controls)) await write(name, value);
    const assertControls = async () => {
      const current = await handle.stat({ bigint: true });
      if (current.dev !== metadata.dev || current.ino !== metadata.ino
        || (await read("cgroup.type")) !== "domain") throw Error("SPECIALIST_CGROUP_IDENTITY_CHANGED");
      for (const [name, value] of Object.entries(controls))
        if (await read(name) !== value) throw Error("SPECIALIST_AGGREGATE_CONTROL_CHANGED");
    };
    await assertControls();
    const assertCurrent = async () => {
      const current = await workforceSpecialistHostConfiguration();
      if (current.policyDigest !== configured.policyDigest
        || specialistDigest(current.mechanism) !== specialistDigest(configured.mechanism))
        throw Error("SPECIALIST_HOST_POLICY_OR_PROFILE_CHANGED");
      await assertControls();
    };
    const assertMembership = async (guardianPid: number, guestPid: number) => {
      await assertCurrent();
      const members = (await read("cgroup.procs")).split(/\s+/).filter(Boolean);
      if (members.length !== 2 || !members.includes(String(guardianPid)) || !members.includes(String(guestPid)))
        throw Error("SPECIALIST_KERNEL_MEMBERSHIP_CHANGED");
    };
    if (counters(await read("cgroup.events")).get("populated") !== "0")
      throw Error("SPECIALIST_NEW_CGROUP_NOT_EMPTY");
    // Missing peak-memory metering cannot be reinterpreted as zero usage.
    if (!/^\d+$/.test(await read("memory.peak"))) throw Error("SPECIALIST_MEMORY_METER_UNAVAILABLE");
    const reference = specialistHostReferenceSchema.parse({
      schema: "finnor.s6.specialist-host-reference.v1", profile: SPECIALIST_PROFILE,
      bindingDigest: specialistDigest(binding), hostPolicyDigest: configured.policyDigest,
      cgroupParent: configured.policy.cgroupParent, cgroupName: name,
      device: String(metadata.dev), inode: String(metadata.ino), controllerUid: configured.policy.controllerUid,
      createdAt: new Date().toISOString(),
    });
    const usage: SpecialistKernelUsage = { cpuMicros: null, memoryPeakBytes: null, pidsObserved: null,
      pidsPeak: null, memoryOomKills: null, diskWriteBytes: "0", stopped: false, cleanupStatus: "NOT_RUN", meterGaps: [] };
    const observe = async () => {
      await assertControls();
      usage.cpuMicros = counters(await read("cpu.stat")).get("usage_usec") ?? null;
      usage.memoryPeakBytes = await read("memory.peak"); usage.pidsObserved = await read("pids.current");
      usage.memoryOomKills = counters(await read("memory.events")).get("oom_kill") ?? null;
      try { usage.pidsPeak = await read("pids.peak"); } catch { usage.pidsPeak = null; }
      usage.stopped = counters(await read("cgroup.events")).get("populated") === "0";
      return { ...usage };
    };
    let stopPromise: Promise<void> | undefined;
    // Stop uses the already pinned owned descriptor even if a control readback
    // fails. A changed control must not prevent an attempt to kill our group.
    const stop = () => stopPromise ??= write("cgroup.kill", "1");
    let cleanupPromise: Promise<SpecialistKernelUsage> | undefined;
    const cleanup = () => cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      try {
        await stop(); await assertControls();
        const until = Date.now() + 2000;
        while (counters(await read("cgroup.events")).get("populated") !== "0" && Date.now() < until)
          await new Promise(resolve => setTimeout(resolve, 20));
        await observe();
        if (!usage.stopped) throw Error("SPECIALIST_OWNED_CGROUP_STILL_LIVE");
      } catch (error) { failures.push(error); usage.meterGaps.push("OWNED_KERNEL_USAGE_OR_STOP_UNKNOWN"); }
      try { await handle.close(); } catch (error) { failures.push(error); }
      if (usage.stopped) try {
        const current = await lstat(path, { bigint: true });
        if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw Error("SPECIALIST_CGROUP_PATH_REPLACED");
        await rmdir(path);
      } catch (error) { failures.push(error); }
      if (usage.stopped) {
        try { await jail.cleanup(); } catch (error) { failures.push(error); }
      } else failures.push(Error("SPECIALIST_LIVE_CUSTODY_RETAINED_FOR_RECOVERY"));
      usage.cleanupStatus = failures.length ? "FAIL" : "PASS";
      if (failures.length) throw new AggregateError(failures, "SPECIALIST_OWNED_CLEANUP_FAILED");
      return { ...usage };
    })();
    return { ...jail, args: [...jail.args, "protected-specialist-v1", String(wallTimeMs), String(deadlineNanoseconds)],
      cgroupFd: handle.fd, reference, mechanism: configured.mechanism, policy: configured.policy,
      assertControls, assertCurrent, assertMembership, observe, usage, stop, cleanup };
  } catch (error) {
    await group?.close().catch(() => undefined);
    if (created) await rmdir(path).catch(() => undefined);
    await jail.cleanup();
    throw error;
  }
}

const pid = z.number().int().positive();
const protectedBootstrap = z.object({
  schema: z.literal("finnor.s6.linux-specialist-bootstrap.v1"),
  profile: z.literal(SPECIALIST_PROFILE), pid, parentPid: pid, guardianPid: pid, guestPid: pid,
  guestParentPid: pid, processGroupId: pid, lifetimeGuard: z.literal("TRUSTED_NONEXECUTING_PROCESS_GROUP_GUARD"),
  uid: z.number().int().positive(), capabilities: z.literal(0), noNewPrivileges: z.literal(1),
  fixedJail: z.literal(true), landlockAbi: z.number().int().min(2), filterSha256: hex,
  cgroupDevice: z.string().regex(/^\d+$/), cgroupInode: z.string().regex(/^\d+$/),
  memoryBytes: z.literal(limits.memoryBytes), swapBytes: z.literal(0), pidsMax: z.literal(limits.pids),
  cpuQuotaMicros: z.literal(limits.cpuQuotaMicros), cpuPeriodMicros: z.literal(limits.cpuPeriodMicros),
  cpuBurstMicros: z.literal(0), scratchWriteBytes: z.literal(0), wallTimeMs: z.number().int().min(100).max(10000),
  deadlineMonotonicNanoseconds: z.string().regex(/^\d{1,20}$/),
  cgroupMembershipVerified: z.literal(true), guardianWallTimerArmed: z.literal(true),
  guardianWallTimer: z.literal("KERNEL_ABSOLUTE_CLOCK_MONOTONIC"),
}).strict();
export async function readWorkforceSpecialistBootstrap(path: string, expected: {
  guardianPid: number | undefined; reference: SpecialistHostReference; filterSha256: string; wallTimeMs: number;
  deadlineMonotonicNanoseconds: string;
}) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || st.size > 8192)
      throw Error("SPECIALIST_BOOTSTRAP_CUSTODY_INVALID");
    const value = protectedBootstrap.parse(JSON.parse(await fd.readFile("utf8")));
    if (value.pid !== expected.guardianPid || value.guardianPid !== expected.guardianPid
      || value.parentPid !== process.pid || value.processGroupId !== expected.guardianPid
      || value.guestParentPid !== expected.guardianPid || value.guestPid === value.guardianPid
      || value.uid !== process.getuid?.() || value.filterSha256 !== expected.filterSha256
      || value.cgroupDevice !== expected.reference.device || value.cgroupInode !== expected.reference.inode
      || value.wallTimeMs !== expected.wallTimeMs
      || value.deadlineMonotonicNanoseconds !== expected.deadlineMonotonicNanoseconds)
      throw Error("SPECIALIST_NATIVE_BOOTSTRAP_BINDING_INVALID");
    return value;
  } finally { await fd.close(); }
}

export async function observeWorkforceSpecialistHost(reference: SpecialistHostReference) {
  const parsed = specialistHostReferenceSchema.parse(reference), configured = await workforceSpecialistHostConfiguration();
  if (parsed.hostPolicyDigest !== configured.policyDigest || parsed.cgroupParent !== configured.policy.cgroupParent
    || parsed.controllerUid !== configured.policy.controllerUid) throw Error("SPECIALIST_RECOVERY_HOST_SCOPE_CHANGED");
  const fd = await open(join(parsed.cgroupParent, parsed.cgroupName),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat({ bigint: true });
    if (String(st.dev) !== parsed.device || String(st.ino) !== parsed.inode)
      throw Error("SPECIALIST_RECOVERY_CGROUP_IDENTITY_CHANGED");
    const prefix = "/proc/self/fd/" + fd.fd;
    const events = counters(await readFile(join(prefix, "cgroup.events"), "utf8"));
    return { readOnly: true, stopped: events.get("populated") === "0",
      cpuMicros: counters(await readFile(join(prefix, "cpu.stat"), "utf8")).get("usage_usec") ?? null,
      memoryPeakBytes: (await readFile(join(prefix, "memory.peak"), "utf8")).trim(),
      modelOutcome: "UNKNOWN", executionAuthorityGranted: false, protectedQualification: false };
  } finally { await fd.close(); }
}
