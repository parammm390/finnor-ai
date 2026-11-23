/** An existing operator-host session, never a credential provider or issuer.
 * Missing genuine external policy/materialization is UNADMITTED. This port
 * neither obtains credentials nor claims to recheck their IAM role through STS. */
import { createPublicKey, verify } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import { z } from "zod";
import { currentWorkforceSpecialistCapability,
  type WorkforceSpecialistCapability } from "../../capability-evolution/src/specialist-consumer";
import { workforceSpecialistHostConfiguration } from "./executor-specialist-linux";
import { canonical } from "./protocol";
import { specialistDigest, specialistExecutionBindingSchema, specialistModelIdentitySchema, specialistRefSchema,
  type SpecialistExecutionBinding, type SpecialistIamSessionLease, type SpecialistIamSessionSource } from "./specialist-contract";

export type { SpecialistIamSessionLease } from "./specialist-contract";
type Credentials = Readonly<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }>;
const instant = z.string().datetime({ offset: true }), hex = z.string().regex(/^[a-f0-9]{64}$/);
const Materialization = z.object({
  body: z.object({
    schema: z.literal("finnor.s6.operator-host-existing-iam-session-materialization.v1"),
    sourceRef: specialistRefSchema, sourcePolicyDigest: hex, bindingDigest: hex,
    claim: specialistExecutionBindingSchema.shape.job,
    tenantId: z.string().uuid(), principalId: z.string().uuid(),
    methodRef: specialistRefSchema, admissionRef: specialistRefSchema,
    modelIdentity: specialistModelIdentitySchema, roleArn: z.string().min(1).max(1024),
    assumedRoleArn: z.string().min(1).max(1024),
    existingSession: z.literal(true), acquisition: z.literal("PREEXISTING_NO_REFRESH"),
    materializedAt: instant, expiresAt: instant,
    credentials: z.object({
      accessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
      secretAccessKey: z.string().regex(/^[A-Za-z0-9/+=]{16,256}$/),
      sessionToken: z.string().regex(/^[A-Za-z0-9/+=._-]{16,16384}$/),
    }).strict(),
  }).strict(),
  keyId: z.string().min(1).max(128), signature: z.string().min(1).max(128),
}).strict();
type LeaseState = {
  bindingDigest: string; source: SpecialistIamSessionSource; hostPolicyDigest: string;
  mechanismDigest: string; deadlineAt: number; expiresAt: number;
  fileFingerprint: string; directoryFingerprint: string; model: string; tenantId: string;
  signal: AbortSignal; credentials: Credentials; used: boolean; onAbort: () => void;
};
const sessions = new WeakMap<SpecialistIamSessionLease, LeaseState>();
// A disposed or unused lease does not reopen the same physical attempt. Keep
// the bounded replay fence through its original deadline and drain allowance.
const issuedBindings = new Map<string, number>();
const refuse = (): never => { throw Error("SPECIALIST_EXISTING_IAM_SESSION_UNADMITTED"); };
const fingerprint = (st: BigIntStats, directory = false) => {
  const fields = directory ? ["dev", "ino", "mode", "uid", "gid"] as const
    : ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
  return specialistDigest(Object.fromEntries(fields.map(field => [field, String(st[field])])));
};

/** Bounded local tmpfs read, not the normal credential-resolution subsystem.
 * Source directories are root:runtime-gid 0750, so the nonroot runtime can open
 * them read-only but cannot modify them; outsiders cannot traverse/list them.
 * The signed leaf is runtime-uid:runtime-gid 0400. Root-only 0700 directories
 * would be unreadable and are never relabeled usable. No handle survives. */
async function snapshot(source: SpecialistIamSessionSource, bindingDigest: string,
  signal: AbortSignal, readBytes: boolean) {
  signal.throwIfAborted();
  let path = "";
  for (const part of source.directory.split("/").slice(1)) {
    path += "/" + part;
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o6022)) refuse();
    if ((path === "/run/finnor-specialist-iam" || path.startsWith("/run/finnor-specialist-iam/"))
      && (st.gid !== source.controllerGid || (st.mode & 0o7777) !== 0o750)) refuse();
    signal.throwIfAborted();
  }
  const directory = await open(source.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const beforeDirectory = await directory.stat({ bigint: true }), pinned = "/proc/self/fd/" + directory.fd;
    if (!beforeDirectory.isDirectory() || beforeDirectory.uid !== 0n || (beforeDirectory.mode & 0o6022n)
      || beforeDirectory.gid !== BigInt(source.controllerGid) || (beforeDirectory.mode & 0o7777n) !== 0o750n
      || await realpath(source.directory) !== source.directory
      || (await statfs(pinned, { bigint: true })).type !== 0x01021994n) refuse();
    file = await open(pinned + "/" + bindingDigest + ".session.json",
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(source.controllerUid)
      || before.gid !== BigInt(source.controllerGid) || before.nlink !== 1n
      || (before.mode & 0o7777n) !== 0o400n || before.size <= 0n || before.size > 32768n) refuse();
    let bytes: Buffer | null = null;
    if (readBytes) {
      const buffer = Buffer.alloc(Number(before.size) + 1); let used = 0;
      while (used < buffer.length) {
        signal.throwIfAborted();
        const next = await file.read(buffer, used, buffer.length - used, used);
        if (!next.bytesRead) break;
        used += next.bytesRead;
      }
      if (used !== Number(before.size)) { buffer.fill(0); refuse(); }
      bytes = buffer.subarray(0, used);
    }
    if (fingerprint(before) !== fingerprint(await file.stat({ bigint: true }))
      || fingerprint(beforeDirectory, true) !== fingerprint(await directory.stat({ bigint: true }), true)) {
      bytes?.fill(0); refuse();
    }
    signal.throwIfAborted();
    return { bytes, fileFingerprint: fingerprint(before), directoryFingerprint: fingerprint(beforeDirectory, true) };
  } finally {
    try { if (file) await file.close(); } finally { await directory.close(); }
  }
}

function current(state: LeaseState) {
  state.signal.throwIfAborted();
  const now = Date.now();
  if (now >= state.deadlineAt || now >= state.expiresAt
    || now < Date.parse(state.source.validAfter) || now >= Date.parse(state.source.validUntil)) refuse();
}
function stateFor(lease: SpecialistIamSessionLease) {
  const state = sessions.get(lease);
  if (!state) return refuse();
  current(state);
  return state;
}

/** Authenticate the already-admitted host source and one already-existing
 * call-bound materialization. This creates an in-memory custody lease only,
 * never an AWS session, credential, role, policy, reference or admission. */
export async function acquireAdmittedSpecialistIamSession(bindingInput: SpecialistExecutionBinding,
  currentCapability: WorkforceSpecialistCapability, signal: AbortSignal): Promise<SpecialistIamSessionLease> {
  try {
    signal.throwIfAborted();
    const binding = specialistExecutionBindingSchema.parse(bindingInput), configured = await workforceSpecialistHostConfiguration();
    const source = configured.policy.iamSessionSource, deadlineAt = Date.parse(binding.effectiveDeadline);
    if (source.tenantId !== binding.tenantId || source.principalId !== binding.principalId
      || specialistDigest(source.modelIdentity) !== specialistDigest(binding.modelIdentity)
      || specialistDigest(configured.mechanism) !== binding.mechanismDigest
      || specialistDigest(currentCapability.revisionRef) !== specialistDigest(binding.methodRef)
      || specialistDigest(currentCapability.admissionRef) !== specialistDigest(binding.admissionRef)
      || specialistDigest(currentCapability.spendBudgetRef) !== specialistDigest(binding.budgetRef)
      || currentCapability.sourceClosureDigest !== binding.sourceClosureDigest
      || currentCapability.runtimeDigest !== binding.runtimeDigest
      || Date.now() < Date.parse(source.validAfter) || Date.now() >= Date.parse(source.validUntil)
      || deadlineAt + source.drainMs > Date.parse(source.validUntil)
      || deadlineAt + source.drainMs > Date.parse(configured.policy.validUntil)) refuse();
    await currentWorkforceSpecialistCapability({ tenantId: binding.tenantId, principalId: binding.principalId,
      rightsRef: source.rightsRef, spendBudgetRef: binding.budgetRef, methodRef: binding.methodRef,
      admissionRef: binding.admissionRef, modelIdentity: binding.modelIdentity, mechanism: configured.mechanism,
      deadlineAt, signal }, currentCapability);
    const bindingDigest = specialistDigest(binding), observed = await snapshot(source, bindingDigest, signal, true);
    let materialization: z.infer<typeof Materialization>;
    try {
      if (!observed.bytes) return refuse();
      materialization = Materialization.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(observed.bytes)));
    } finally { observed.bytes?.fill(0); }
    const key = createPublicKey(source.materializer.publicKey), body = materialization.body, now = Date.now();
    const materializedAt = Date.parse(body.materializedAt), expiresAt = Date.parse(body.expiresAt);
    const role = /^arn:aws:iam::([0-9]{12}):role\/(.+)$/.exec(source.roleArn);
    const roleName = role?.[2]?.split("/").at(-1);
    const assumedPrefix = role && roleName ? `arn:aws:sts::${role[1]}:assumed-role/${roleName}/` : "";
    if (key.asymmetricKeyType !== "ed25519" || materialization.keyId !== source.materializer.keyId
      || !verify(null, Buffer.from(canonical(body)), key, Buffer.from(materialization.signature, "base64"))
      || body.sourcePolicyDigest !== specialistDigest(source)
      || specialistDigest(body.sourceRef) !== specialistDigest(source.reference)
      || body.bindingDigest !== bindingDigest || specialistDigest(body.claim) !== specialistDigest(binding.job)
      || body.tenantId !== binding.tenantId || body.principalId !== binding.principalId
      || specialistDigest(body.methodRef) !== specialistDigest(binding.methodRef)
      || specialistDigest(body.admissionRef) !== specialistDigest(binding.admissionRef)
      || specialistDigest(body.modelIdentity) !== specialistDigest(binding.modelIdentity) || body.roleArn !== source.roleArn
      || !assumedPrefix || !body.assumedRoleArn.startsWith(assumedPrefix)
      || !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(body.assumedRoleArn.slice(assumedPrefix.length))
      || materializedAt > now || materializedAt < Date.parse(source.validAfter)
      || now - materializedAt > source.maximumMaterializationAgeMs
      || expiresAt <= materializedAt || expiresAt < deadlineAt + source.drainMs || deadlineAt <= now) refuse();
    for (const [prior, until] of issuedBindings) if (until <= now) issuedBindings.delete(prior);
    if (issuedBindings.has(bindingDigest) || issuedBindings.size >= 128) refuse();
    issuedBindings.set(bindingDigest, deadlineAt + source.drainMs);
    const lease = Object.freeze({}) as SpecialistIamSessionLease;
    const onAbort = () => disposeAdmittedSpecialistIamSession(lease);
    sessions.set(lease, { bindingDigest, source, hostPolicyDigest: configured.policyDigest,
      mechanismDigest: binding.mechanismDigest, deadlineAt, expiresAt,
      fileFingerprint: observed.fileFingerprint, directoryFingerprint: observed.directoryFingerprint,
      model: binding.modelIdentity.model, tenantId: binding.tenantId, signal,
      credentials: Object.freeze({ ...body.credentials }), used: false, onAbort });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); signal.throwIfAborted(); }
    return lease;
  } catch { return refuse(); }
}

/** No secret read or refresh: the original admitted source/leaf must remain the
 * same. Deletion, replacement, expiry, policy change or lost custody refuses. */
export async function assertAdmittedSpecialistIamSessionCurrent(lease: SpecialistIamSessionLease, signal: AbortSignal) {
  try {
    signal.throwIfAborted();
    const state = stateFor(lease), configured = await workforceSpecialistHostConfiguration();
    if (configured.policyDigest !== state.hostPolicyDigest
      || specialistDigest(configured.mechanism) !== state.mechanismDigest
      || specialistDigest(configured.policy.iamSessionSource) !== specialistDigest(state.source)) refuse();
    const observed = await snapshot(state.source, state.bindingDigest, signal, false);
    if (observed.fileFingerprint !== state.fileFingerprint || observed.directoryFingerprint !== state.directoryFingerprint
      || sessions.get(lease) !== state) refuse();
    current(state); signal.throwIfAborted();
  } catch { return refuse(); }
}

/** Only the native IAM helper consumes this one-use lease. The result is a
 * resolved literal, deliberately without expiration/provider/refresh fields. */
export function consumeAdmittedSpecialistIamSession(lease: SpecialistIamSessionLease, request: {
  model: string; region: string; tenantId: string | undefined; deadlineAt: number | undefined;
  signal: AbortSignal | undefined;
}): Credentials {
  const state = stateFor(lease);
  if (state.used || request.model !== state.model || request.region !== "us-east-1"
    || request.tenantId !== state.tenantId || request.deadlineAt !== state.deadlineAt
    || request.signal !== state.signal) return refuse();
  state.used = true;
  return Object.freeze({ ...state.credentials });
}
export function admittedSpecialistIamSessionEvidence(lease: SpecialistIamSessionLease) {
  const state = stateFor(lease);
  return Object.freeze({ sourceRef: Object.freeze({ ...state.source.reference }), roleArn: state.source.roleArn,
    expiresAt: new Date(state.expiresAt).toISOString(), bindingDigest: state.bindingDigest,
    custody: "ADMITTED_OPERATOR_HOST_SIGNED_PREEXISTING_SESSION" as const,
    directoryAccess: "ROOT_RUNTIME_GID_0750" as const, leafAccess: "RUNTIME_UID_GID_0400" as const,
    liveIamIdentityRechecked: false, providerResolution: "NONE" as const, refresh: "DENIED" as const });
}
export function disposeAdmittedSpecialistIamSession(lease: SpecialistIamSessionLease) {
  const state = sessions.get(lease);
  if (!state) return;
  sessions.delete(lease);
  state.signal.removeEventListener("abort", state.onAbort);
}
