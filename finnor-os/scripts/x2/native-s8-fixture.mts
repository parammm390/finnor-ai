/** Actual disposable S6/S8 services for the native driver, not an admission
 * oracle. Independent evaluation bodies must come from the driver's inspector.
 * No currentness, protected qualification or execution authority is fabricated. */
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { withTenantTransaction } from "@finnor/db";
import type {
  ApplicationActionModel, ApplicationModelCheck, ApplicationTransitionEvidence, ExperimentRef,
} from "@finnor/shared-types";
import type { PeMutationContext } from "../../packages/private-equity/src/types";
import type {
  AuthorizedApplicationProfile, OriginalApplicationParent,
} from "../../packages/private-equity/src/application-semantics/ports";
import {
  applicationRuntimeIdentity, parseApplicationCheck, parseApplicationModel, parseTransitionEvidence,
  sameX2Ref, X2RefSchema, x2Ref,
} from "../../packages/private-equity/src/application-semantics/contracts";
import {
  applicationArtifact, applicationSession, currentApplicationModel, currentApplicationWork,
  nativeApplicationProfile, type ApplicationSessionRow,
} from "../../packages/private-equity/src/application-semantics/store";
import { assertApplicationAllocationCurrent } from "../../packages/private-equity/src/application-semantics/allocation";
import {
  assertFreshApplicationProfile, currentFreshApplicationAuthority,
} from "../../packages/private-equity/src/application-semantics/fresh-authority";
import { canonical } from "../../packages/governed-execution/src/protocol";
import {
  ownerTransportRoute, resolveEconomicOwnerReference,
  type OwnerTransportRoute, type OwnerTransportScope,
} from "../../packages/governed-execution/src/owner-transport";
import {
  deliverOwnerTransportBatch, enqueueOwnerDeliveryInTransaction,
} from "../../packages/governed-execution/src/owner-delivery-store";
import { byteDigest, digest, type Signed } from "../../packages/capability-evolution/src/contracts";
import {
  assertCapabilitySourceClosure, requiredCapabilitySourcePaths,
} from "../../packages/capability-evolution/src/source-closure";
import type { CapabilityEvolution } from "../../packages/capability-evolution/src/lifecycle";
import {
  APPLICATION_S8_QUALIFICATION, ApplicationActivationSchema, ApplicationAdmissionSchema,
  ApplicationEvaluationSchema, ApplicationPortRefSchema, ApplicationProtocolSchema,
  ApplicationRevocationSchema, OriginalApplicationParentSchema, applicationDependencyDigest,
  applicationProfileBinding, applicationRef, makeApplicationCandidate,
  type ApplicationCandidate, type ApplicationPortRef,
} from "../../packages/capability-evolution/src/application-port";
import {
  ApplicationConsumerPolicySchema, type ApplicationConsumerPolicy,
} from "../../packages/capability-evolution/src/application-consumer";

export const NATIVE_S8_FIXTURE_FLAGS = Object.freeze({
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY" as const,
  qualification: APPLICATION_S8_QUALIFICATION,
  protectedAdmission: false as const, executionAuthorityGranted: false as const,
});
export type NativeS8ProtocolBody = z.infer<typeof ApplicationProtocolSchema>;
export type NativeS8EvaluationBody = z.infer<typeof ApplicationEvaluationSchema>;
export type NativeS8AdmissionBody = z.infer<typeof ApplicationAdmissionSchema>;
export type NativeS8ActivationBody = z.infer<typeof ApplicationActivationSchema>;
export type NativeS8RevocationBody = z.infer<typeof ApplicationRevocationSchema>;
export type NativeS8FixtureRole = "proposer" | "evaluator" | "promoter" | "consumer" | "reader";
export type NativeS8FixtureOperation =
  | "READ" | "APPLICATION_PROPOSE" | "APPLICATION_REGISTER" | "APPLICATION_EVALUATE"
  | "APPLICATION_ADMIT" | "APPLICATION_ACTIVATE" | "APPLICATION_REVOKE"
  | "APPLICATION_CURRENT" | "APPLICATION_USE" | "APPLICATION_RECHECK" | "APPLICATION_RECONCILE";
export interface NativeS8FixtureEnvironment {
  FINNOR_S6_OWNER_TRANSPORT_CONFIG: string;
  FINNOR_S6_OWNER_TRANSPORT_ROOT: string;
  FINNOR_S8_APPLICATION_CONSUMER_CONFIG?: string;
  FINNOR_S8_APPLICATION_CONSUMER_ROOT?: string;
}
export interface NativeS8FixtureInput {
  /** Must NOT exist yet. Created once with mode 0700; never adopted or deleted. */
  privateDir: string;
  /** Repository root, not finnor-os; must be the checkout loading this helper. */
  repoRoot: string;
  native: {
    context: PeMutationContext;
    acquisitionSessionId: string;
    currentRightsRef: string;
  };
  model: ApplicationActionModel;
  check: ApplicationModelCheck;
  originalParent: OriginalApplicationParent;
  originalProfiles: readonly AuthorizedApplicationProfile[];
  /** Omitted identities are new disposable protocol principals, not live users. */
  evaluatorPrincipalId?: string;
  promoterPrincipalId?: string;
  limits?: { maxTotalCost?: number; maxTotalUses?: number; maxCurrentnessMs?: number };
}
export interface NativeS8HttpResult { status: number; body: unknown }
export interface NativeS8Commitment {
  ref: ApplicationPortRef;
  receipt: unknown;
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  qualification: typeof APPLICATION_S8_QUALIFICATION;
  protectedAdmission: false;
  executionAuthorityGranted: false;
}
export interface NativeS8SignedCommitment<T> { signed: Signed<T>; commitment: NativeS8Commitment }
export interface NativeReferenceDrain {
  batches: Array<{ owner: string; report: Awaited<ReturnType<typeof deliverOwnerTransportBatch>> }>;
  unresolved: Array<{ owner: string; identity: string; status: string; lastError: string | null }>;
}
export interface NativeReferencePublication {
  enqueued: ExperimentRef[];
  drain: NativeReferenceDrain;
  readbacks: Array<{ ref: ExperimentRef; receipt: unknown }>;
}
export interface NativeS8ConsumerInstallation {
  path: string;
  policy: ApplicationConsumerPolicy;
  /** Existing native S4 evidence, never created by this fixture. */
  freshAuthorityRef: ExperimentRef | null;
  environment: NativeS8FixtureEnvironment;
}
export interface NativeS8Fixture {
  readonly privateDir: string;
  readonly candidate: ApplicationCandidate;
  readonly dependencyDigest: string;
  readonly principals: { native: string; evaluator: string; promoter: string };
  readonly sourcePins: readonly SourcePin[];
  readonly paths: {
    freeze: string; commands: string; processes: string;
    ledgerConfig: string; transportConfig: string; lifecycleConfig: string;
    ledgerJournalDir: string; lifecycleJournalDir: string;
  };
  endpoints(): { s6: string; s8: string };
  /** Forward these four keys to every native API/physical-worker child. */
  environment(): NativeS8FixtureEnvironment;
  assertSourceCut(): Promise<void>;
  /** Only actual retained, nonprivate native preimages can be delivered. */
  publishNativeRefs(refs: readonly ExperimentRef[]): Promise<NativeReferencePublication>;
  drainNativeRefs(maxBatchesPerOwner?: number): Promise<NativeReferenceDrain>;
  /** Private originals for the independent inspector, never published to S6. */
  readDiscoveryEvidence(): Promise<ApplicationTransitionEvidence[]>;
  propose(requestId?: string): Promise<NativeS8Commitment>;
  register(body: NativeS8ProtocolBody, requestId?: string): Promise<NativeS8SignedCommitment<NativeS8ProtocolBody>>;
  evaluate(body: NativeS8EvaluationBody, requestId?: string): Promise<NativeS8SignedCommitment<NativeS8EvaluationBody>>;
  admit(body: NativeS8AdmissionBody, requestId?: string): Promise<NativeS8SignedCommitment<NativeS8AdmissionBody>>;
  activate(body: NativeS8ActivationBody, requestId?: string):
    Promise<NativeS8SignedCommitment<NativeS8ActivationBody> & { generation: number }>;
  revoke(body: NativeS8RevocationBody, requestId?: string):
    Promise<NativeS8SignedCommitment<NativeS8RevocationBody> & { generation: number; unresolvedUsesPreserved: number }>;
  /** Changed grants/targets require an ALREADY retained fresh child authority. */
  writeConsumerConfig(input: {
    profiles: readonly AuthorizedApplicationProfile[];
    freshSessionId?: string;
    validUntil?: string;
  }): Promise<NativeS8ConsumerInstallation>;
  /** Raw authenticated responses permit wrong-role/negative owner-boundary cases. */
  commandAs(role: NativeS8FixtureRole, operation: NativeS8FixtureOperation,
    body: unknown, requestId?: string): Promise<NativeS8HttpResult>;
  /** Same ports, signed configs, keys, original deadline and journal directories. */
  restart(services?: "S8" | "S6_AND_S8"): Promise<void>;
  /** Stop only child handles created here; restore unchanged owned env; delete nothing. */
  close(): Promise<void>;
}

export interface SourcePin { path: string; sha256: string }
const loadedRepo = resolve(import.meta.dirname, "../../..");
const nativeOwners = ["S1", "WORK", "AUTHORITY", "S4", "S5", "S6", "COMPUTER"] as const;
const roles: NativeS8FixtureRole[] = ["proposer", "evaluator", "promoter", "consumer", "reader"];
const envKeys = [
  "FINNOR_S6_OWNER_TRANSPORT_CONFIG", "FINNOR_S6_OWNER_TRANSPORT_ROOT",
  "FINNOR_S8_APPLICATION_CONSUMER_CONFIG", "FINNOR_S8_APPLICATION_CONSUMER_ROOT",
] as const;
const keyPair = () => generateKeyPairSync("ed25519");
type KeyPair = ReturnType<typeof keyPair>;
const publicPem = (key: KeyPair) => key.publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = <T,>(body: T, keyId: string, key: KeyPair): Signed<T> => ({
  body, keyId, signature: sign(null, Buffer.from(canonical(body)), key.privateKey).toString("base64"),
});
function failure(code: string): never { throw Error(code); }
const replyFlags = {
  protectionDomain: z.literal("DISPOSABLE_TEST_AUTHORITY"), qualification: z.literal(APPLICATION_S8_QUALIFICATION),
  protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
};
const commitSchema = z.object({ ref: ApplicationPortRefSchema, receipt: z.record(z.unknown()), ...replyFlags }).strict();
const activationReplySchema = commitSchema.extend({ generation: z.number().int().positive() }).strict();
const revocationReplySchema = activationReplySchema.extend({
  liabilityBudgetReleased: z.literal(false), unresolvedUsesPreserved: z.number().int().nonnegative(),
}).strict();

async function boundedFile(path: string, privateFile = false): Promise<Buffer> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > 16 * 1024 * 1024
      || privateFile && ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.())) {
      failure("X2_S8_FIXTURE_UNSAFE_FILE");
    }
    const bytes = await fd.readFile(), after = await fd.stat();
    if (bytes.length > 16 * 1024 * 1024 || bytes.length !== before.size
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) failure("X2_S8_FIXTURE_FILE_CHANGED_DURING_READ");
    return bytes;
  } finally { await fd.close(); }
}
async function newPrivateFile(path: string, bytes: string | Uint8Array) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  await boundedFile(path, true);
}
async function appendPrivate(path: string, value: unknown) {
  const fd = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const st = await fd.stat();
    if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid?.()
      || st.size > 16 * 1024 * 1024) failure("X2_S8_FIXTURE_UNSAFE_LOG");
    await fd.writeFile(canonical(value) + "\n");
  } finally { await fd.close(); }
}
async function privateDirectory(path: string, create: boolean) {
  if (create) await mkdir(path, { mode: 0o700 }); // No recursive adoption.
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o700
    || st.uid !== process.getuid?.() || await realpath(path) !== resolve(path)) failure("X2_S8_FIXTURE_UNSAFE_DIRECTORY");
}
async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); no(Error("X2_S8_FIXTURE_PORT_REQUIRED")); return; }
      server.close((error) => error ? no(error) : yes(address.port));
    });
  });
}
async function jsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) failure("X2_S8_FIXTURE_EMPTY_RESPONSE");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) failure("X2_S8_FIXTURE_RESPONSE_BOUND");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}
function successful(result: NativeS8HttpResult): unknown {
  if (result.status !== 200) {
    const parsed = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,128}$/) }).passthrough().safeParse(result.body);
    failure(parsed.success ? parsed.data.code : "X2_S8_FIXTURE_OWNER_COMMAND_REFUSED");
  }
  return result.body;
}

interface ManagedProcess {
  child: ChildProcess;
  logPath: string;
  completed: Promise<void>;
  stop(): Promise<void>;
}
/** Private output is retained, but never interpolated into error/console text. */
async function launch(input: {
  script: string; cwd: string; env: NodeJS.ProcessEnv; port: number; logPath: string;
}): Promise<ManagedProcess> {
  const log = await open(input.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const child = spawn(process.execPath, [...(input.script.endsWith(".mts") ? ["--import=tsx"] : []), input.script], {
    cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let writes: Promise<unknown> = Promise.resolve(), bytes = 0, line = "", logFailed = false;
  let bootDone = false;
  let acceptBoot: () => void = () => undefined, rejectBoot: (error: Error) => void = () => undefined;
  const boot = new Promise<void>((yes, no) => { acceptBoot = yes; rejectBoot = no; });
  const reject = (code: string) => { if (!bootDone) { bootDone = true; rejectBoot(Error(code)); } };
  const capture = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) { reject("X2_S8_FIXTURE_PROCESS_OUTPUT_BOUND"); child.kill("SIGTERM"); return; }
    writes = writes.then(() => log.writeFile(chunk)).catch(() => {
      logFailed = true; reject("X2_S8_FIXTURE_PROCESS_LOG_UNAVAILABLE"); child.kill("SIGTERM");
    });
  };
  child.stderr!.on("data", capture);
  child.stdout!.on("data", (chunk: Buffer) => {
    capture(chunk);
    if (bootDone) return;
    line += chunk.toString();
    if (Buffer.byteLength(line) > 65536) { reject("X2_S8_FIXTURE_READINESS_BOUND"); return; }
    const lines = line.split("\n"); line = lines.pop()!;
    for (const raw of lines) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { continue; }
      const ready = z.object({
        status: z.literal("READY"), port: z.number().int().min(1).max(65535),
        domain: z.literal("DISPOSABLE_TEST_AUTHORITY"),
      }).passthrough().safeParse(value);
      if (!ready.success) continue;
      if (ready.data.port !== input.port) { reject("X2_S8_FIXTURE_READINESS_PORT_SUBSTITUTION"); return; }
      bootDone = true; acceptBoot(); return;
    }
  });
  child.once("error", () => reject("X2_S8_FIXTURE_PROCESS_SPAWN_FAILED"));
  const completed = new Promise<void>((yes) => child.once("close", () => {
    reject("X2_S8_FIXTURE_PROCESS_EXIT_BEFORE_READY");
    void writes.finally(() => log.close()).then(() => yes(), () => { logFailed = true; yes(); });
  }));
  const wait = (ms: number) => new Promise<boolean>((yes) => {
    const timer = setTimeout(() => yes(false), ms);
    void completed.then(() => { clearTimeout(timer); yes(true); });
  });
  const managed: ManagedProcess = {
    child, logPath: input.logPath, completed,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (!await wait(5000)) { child.kill("SIGKILL"); if (!await wait(5000)) failure("X2_S8_FIXTURE_OWNED_PROCESS_STOP_TIMEOUT"); }
      if (logFailed) failure("X2_S8_FIXTURE_PROCESS_LOG_UNAVAILABLE");
    },
  };
  const timeout = setTimeout(() => reject("X2_S8_FIXTURE_PROCESS_READINESS_TIMEOUT"), 15000);
  try { await boot; return managed; }
  catch (error) { await managed.stop(); throw error; }
  finally { clearTimeout(timeout); }
}

/** Boots services only when called. Imports do not start servers or mutate PG. */
export async function bootstrapNativeS8Fixture(input: NativeS8FixtureInput): Promise<NativeS8Fixture> {
  if (!isAbsolute(input.privateDir) || !isAbsolute(input.repoRoot)) failure("X2_S8_FIXTURE_ABSOLUTE_PATHS_REQUIRED");
  const repoRoot = await realpath(input.repoRoot);
  if (repoRoot !== await realpath(loadedRepo) || repoRoot !== resolve(input.repoRoot)) failure("X2_S8_FIXTURE_WRONG_CHECKOUT");
  if (!relative(repoRoot, resolve(input.privateDir)).startsWith("../")) failure("X2_S8_FIXTURE_PRIVATE_CUSTODY_OUTSIDE_SOURCE_REQUIRED");
  const backend = join(repoRoot, "finnor-os"), installed = existsSync(join(backend, "x2-runtime/identity.json"));
  const nodeMode = installed ? "production" : "development";
  const ledgerEntry = join(backend, installed ? "x2-runtime/ledger-server.js" : "packages/governed-execution/src/ledger-server.mts");
  const s8Entry = join(backend, installed ? "x2-runtime/s8-server.js" : "packages/capability-evolution/src/server.mts");
  if (process.env.NODE_ENV !== nodeMode || process.env.FINNOR_ENVIRONMENT !== "staging"
    || process.env.FINNOR_X2_PROFILE !== "ordinary_disposable"
    || resolve(process.env.FINNOR_X2_SOURCE_ROOT ?? "") !== repoRoot
    || envKeys.some((key) => process.env[key] !== undefined)) failure("X2_S8_FIXTURE_DISPOSABLE_UNCONFIGURED_ENV_REQUIRED");
  const database = new URL(process.env.DATABASE_URL ?? failure("X2_S8_FIXTURE_NATIVE_DATABASE_REQUIRED"));
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !["127.0.0.1", "[::1]"].includes(database.hostname)) {
    failure("X2_S8_FIXTURE_LOOPBACK_DATABASE_REQUIRED");
  }
  const ctx = { ...input.native.context, auth: { ...input.native.context.auth } };
  const principalId = ctx.auth.employeeId ?? ctx.auth.userId, tenantId = ctx.auth.tenantId;
  z.string().uuid().parse(tenantId); z.string().uuid().parse(principalId);
  if (ctx.auth.role !== "owner" || principalId !== ctx.auth.userId) failure("X2_S8_FIXTURE_NATIVE_OWNER_REQUIRED");
  const model = parseApplicationModel(input.model), check = parseApplicationCheck(input.check);
  const parent = OriginalApplicationParentSchema.parse(input.originalParent);
  const session = await applicationSession(ctx, input.native.acquisitionSessionId);
  if (session.id !== session.parent_id || session.status !== "MODEL_READY"
    || digest(session.parent) !== digest(parent) || !session.model_ref || !sameX2Ref(session.model_ref, model.ref)
    || !session.check_ref || !sameX2Ref(session.check_ref, check.ref)
    || model.scope.tenantId !== tenantId || model.scope.principalId !== principalId
    || input.native.currentRightsRef !== parent.rightsRevision) {
    failure("X2_S8_FIXTURE_RETAINED_ACQUISITION_BINDING");
  }
  await currentApplicationWork(ctx, session);
  await assertApplicationAllocationCurrent(ctx, session.allocation_ref);
  const retained = await currentApplicationModel(ctx, session);
  if (digest(retained.model) !== digest(model) || digest(retained.check) !== digest(check)) failure("X2_S8_FIXTURE_MODEL_PREIMAGE_SUBSTITUTION");
  await withTenantTransaction(tenantId, { userId: principalId, readOnly: true }, async (_db, c) => {
    const role = (await c.query<{ name: string; superuser: boolean; bypass: boolean }>(
      "SELECT rolname name,rolsuper superuser,rolbypassrls bypass FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (!role || !["finnor_app", "finnor_worker"].includes(role.name) || role.superuser || role.bypass) {
      failure("X2_S8_FIXTURE_ORDINARY_NATIVE_DATABASE_ROLE_REQUIRED");
    }
  });
  const originalBindings = input.originalProfiles.map(applicationProfileBinding);
  if (digest([...session.profile_ids].sort()) !== digest(originalBindings.map((profile) => profile.id).sort())) {
    failure("X2_S8_FIXTURE_ALL_ORIGINAL_PROFILES_REQUIRED");
  }
  for (const binding of originalBindings) {
    const current = await nativeApplicationProfile(ctx, binding.id);
    if (digest(applicationProfileBinding(current.profile)) !== digest(binding)) failure("X2_S8_FIXTURE_ORIGINAL_PROFILE_SUBSTITUTION");
  }
  const evaluatorId = z.string().uuid().parse(input.evaluatorPrincipalId ?? randomUUID());
  const promoterId = z.string().uuid().parse(input.promoterPrincipalId ?? randomUUID());
  if (new Set([principalId, evaluatorId, promoterId]).size !== 3) failure("X2_S8_FIXTURE_SEPARATE_PRINCIPALS_REQUIRED");
  const limits = z.object({
    maxTotalCost: z.number().finite().min(0).max(100),
    maxTotalUses: z.number().int().min(1).max(100000),
    maxCurrentnessMs: z.number().int().min(100).max(30000),
  }).strict().parse({ maxTotalCost: 100, maxTotalUses: 64, maxCurrentnessMs: 30000, ...input.limits });
  const validAfter = parent.validAfter, validUntil = parent.deadlineAt;
  if (Date.parse(validUntil) <= Date.now() || Date.parse(validAfter) > Date.now()
    || parent.runtimeDigest !== digest(applicationRuntimeIdentity())) failure("X2_S8_FIXTURE_ORIGINAL_RUNTIME_OR_DEADLINE_CHANGED");
  const require = createRequire(join(backend, "packages/governed-execution/src/ledger.ts"));
  const fsExt = dirname(require.resolve("fs-ext/package.json"));
  const ledgerSources = ["ledger.ts", "ledger-server.mts", "protocol.ts", "request-verifier.ts", "adapter-contract.ts"]
    .map((name) => join(backend, "packages/governed-execution/src", name))
    .concat(["fs-ext.js", "build/Release/fs_ext.node", "package.json"].map((name) => join(fsExt, name)));
  const nativePaths = parent.dependencyPins.map((pin) => {
    const path = resolve(repoRoot, pin.path);
    if (isAbsolute(pin.path) || relative(repoRoot, path) !== pin.path || pin.path.startsWith("../")) failure("X2_S8_FIXTURE_NATIVE_PIN_PATH_ESCAPE");
    return path;
  });
  const installedPaths = installed ? ["identity.json", "physical-worker.js", "worker/index.js",
    "ledger-server.js", "s8-server.js", "application-consumer.js"].map(name => join(backend, "x2-runtime", name)) : [];
  const sourcePaths = [...new Set([...requiredCapabilitySourcePaths, ...nativePaths, ...installedPaths,
    join(import.meta.dirname, "native-s8-fixture.mts")])].sort();
  if (sourcePaths.length > 128) failure("X2_S8_FIXTURE_S8_SOURCE_PIN_CAPACITY");
  const snapshot = (paths: readonly string[]) => Promise.all(paths.map(async (path) => ({
    path, sha256: byteDigest(await boundedFile(path)),
  })));
  const sourcePins = await snapshot(sourcePaths), ledgerPins = await snapshot(ledgerSources);
  for (const pin of parent.dependencyPins) if (!sourcePins.some((source) => source.path === resolve(repoRoot, pin.path) && source.sha256 === pin.sha256)) {
    failure("X2_S8_FIXTURE_NATIVE_PIN_CHANGED");
  }
  await assertCapabilitySourceClosure(sourcePins);
  const candidate = makeApplicationCandidate({
    model, check, originalParent: parent, profiles: [...input.originalProfiles], sourcePins, proposedAt: new Date().toISOString(),
  });
  const dependencyDigest = applicationDependencyDigest(candidate);
  const privateDir = resolve(input.privateDir);
  await privateDirectory(privateDir, true);
  await privateDirectory(join(privateDir, "s6"), true);
  await privateDirectory(join(privateDir, "s6", "protected"), true);
  await privateDirectory(join(privateDir, "s6", "content"), true);
  await privateDirectory(join(privateDir, "s8"), true);
  const paths = {
    freeze: join(privateDir, "freeze.json"), commands: join(privateDir, "commands.jsonl"),
    processes: join(privateDir, "processes.jsonl"), ledgerConfig: join(privateDir, "s6", "config.json"),
    transportConfig: join(privateDir, "owner-transport.json"), lifecycleConfig: join(privateDir, "s8", "config.json"),
    ledgerJournalDir: join(privateDir, "s6", "protected"), lifecycleJournalDir: join(privateDir, "s8", "journal"),
  };
  await newPrivateFile(paths.commands, ""); await newPrivateFile(paths.processes, "");
  const immutableFiles = new Map<string, string>();
  const saveImmutable = async (path: string, bytes: string | Uint8Array) => {
    await newPrivateFile(path, bytes); immutableFiles.set(path, byteDigest(bytes));
  };
  const keys = {
    ledgerRelease: keyPair(), ledgerSigner: keyPair(), transportRoot: keyPair(),
    lifecycleRelease: keyPair(), journal: keyPair(), evaluator: keyPair(), promoter: keyPair(), consumerRoot: keyPair(),
  };
  const saveKey = (path: string, key: KeyPair) =>
    saveImmutable(path, key.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  for (const [name, key] of Object.entries(keys)) await saveKey(join(privateDir, name + ".pem"), key);
  const ownerNames = [...nativeOwners, "S8"] as const;
  const ownerTokens = new Map<string, { value: string; path: string }>();
  for (const name of [...ownerNames, "S8_READER"]) {
    const value = randomBytes(32).toString("hex"), path = join(privateDir, "ledger-" + name + ".token");
    await saveImmutable(path, value); ownerTokens.set(name, { value, path });
  }
  const lifecycleTokens = new Map<NativeS8FixtureRole, { value: string; path: string }>();
  for (const role of roles) {
    const value = randomBytes(32).toString("hex"), path = join(privateDir, "lifecycle-" + role + ".token");
    await saveImmutable(path, value); lifecycleTokens.set(role, { value, path });
  }
  const ledgerPolicy = {
    schema: "finnor.s6.ledger-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
    owners: [...ownerTokens].map(([name, token]) => ({
      owner: name === "S8_READER" ? "S8" : name, tokenHash: byteDigest(token.value),
      tenantId, principalId, rightsRefs: [parent.rightsRevision],
      append: name !== "S8_READER", read: true, sealedAppend: false, sealedRead: false,
      protectedExecution: false, dispatch: false,
    })), signerPublicKey: publicPem(keys.ledgerSigner), maxEntries: 100000,
  };
  const ledgerRelease = {
    schema: "finnor.s6.ledger-release.v2", releaseId: "x2-native-s8-reference:" + randomUUID(), sourceDigests: ledgerPins,
    runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: digest(ledgerPolicy), validUntil,
  };
  const ledgerPort = await reserveLoopbackPort(), lifecyclePort = await reserveLoopbackPort();
  if (ledgerPort === lifecyclePort) failure("X2_S8_FIXTURE_DISTINCT_PORTS_REQUIRED");
  const endpoints = { s6: "http://127.0.0.1:" + ledgerPort, s8: "http://127.0.0.1:" + lifecyclePort };
  await saveImmutable(paths.ledgerConfig, canonical({
    policy: ledgerPolicy, release: { ...ledgerRelease, signature: signed(ledgerRelease, "ledger-release", keys.ledgerRelease).signature },
    signerPath: join(privateDir, "ledgerSigner.pem"), protectedDirectory: paths.ledgerJournalDir,
    contentDirectory: join(privateDir, "s6", "content"), port: ledgerPort,
  }));
  const routes: OwnerTransportRoute[] = [];
  for (const semanticOwner of ownerNames) {
    const origin = keyPair(), originPath = join(privateDir, "origin-" + semanticOwner + ".pem");
    await saveKey(originPath, origin);
    const token = ownerTokens.get(semanticOwner)!;
    const route: OwnerTransportRoute = {
      semanticOwner, tenantId, principalId, purpose: "OWNER", rightsRefs: [parent.rightsRevision],
      originKeys: [{ id: "x2-native-" + semanticOwner, publicKey: publicPem(origin), validAfter, validUntil, revoked: false }],
      originSigner: { keyId: "x2-native-" + semanticOwner, path: originPath },
      tokenPath: token.path, tokenSha256: byteDigest(token.value),
      ledger: { endpoint: endpoints.s6, acceptedReceipts: [{
        signerPublicKey: publicPem(keys.ledgerSigner), releaseId: ledgerRelease.releaseId,
        verifierDigest: digest(ledgerPins), policyDigest: digest(ledgerPolicy),
      }] }, requestTimeoutMs: 5000, leaseMs: 20000,
    };
    routes.push(route);
    if (semanticOwner === "S8") {
      const { originSigner: _signer, ...consumer } = route, reader = ownerTokens.get("S8_READER")!;
      routes.push({ ...consumer, purpose: "CONSUMER", tokenPath: reader.path, tokenSha256: byteDigest(reader.value) });
    }
  }
  const transportPolicy = { schema: "finnor.s6.owner-transport-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", validAfter, validUntil, routes };
  await saveImmutable(paths.transportConfig, canonical({
    policy: transportPolicy, signature: signed(transportPolicy, "transport-root", keys.transportRoot).signature,
  }));
  const lifecyclePolicy: CapabilityEvolution["policy"] = {
    schema: "finnor.s8.lifecycle-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY", tenantId, principalId,
    rightsRef: parent.rightsRevision, validAfter, validUntil,
    actors: roles.map((role) => ({
      id: "x2-" + role, principalId: role === "evaluator" ? evaluatorId : role === "promoter" ? promoterId : principalId,
      tokenHash: byteDigest(lifecycleTokens.get(role)!.value), roles: [role.toUpperCase() as Uppercase<NativeS8FixtureRole>],
    })),
    evaluatorKeys: [{ id: "x2-evaluator", principalId: evaluatorId, publicKey: publicPem(keys.evaluator), validAfter, validUntil, revoked: false }],
    promotionKeys: [{ id: "x2-promoter", principalId: promoterId, publicKey: publicPem(keys.promoter), validAfter, validUntil, revoked: false }],
    costAuthorityPrincipalIds: [evaluatorId], journalPublicKey: publicPem(keys.journal), allowedStrata: ["ordinary-x2-development"],
    maxEntries: 20000, maxQueue: 4, maxTotalCost: limits.maxTotalCost, maxTotalLoss: 5, maxTotalUses: limits.maxTotalUses,
    sourcePins, application: {
      schema: "finnor.s8.application-port-policy.v1", frontier: "FRONTIER5.X2", sourceRoot: repoRoot,
      transportContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", maxCurrentnessMs: limits.maxCurrentnessMs, ...NATIVE_S8_FIXTURE_FLAGS,
    },
  };
  await saveImmutable(paths.lifecycleConfig, canonical({
    signedPolicy: signed(lifecyclePolicy, "x2-lifecycle-release", keys.lifecycleRelease),
    directory: paths.lifecycleJournalDir, signerPath: join(privateDir, "journal.pem"),
  }));
  const environment: NativeS8FixtureEnvironment = {
    FINNOR_S6_OWNER_TRANSPORT_CONFIG: paths.transportConfig, FINNOR_S6_OWNER_TRANSPORT_ROOT: publicPem(keys.transportRoot),
  };
  const previousEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
  const installedEnvironment = new Map<string, string>();
  const installEnvironment = (values: NativeS8FixtureEnvironment) => {
    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] !== installedEnvironment.get(key) && process.env[key] !== previousEnvironment.get(key as typeof envKeys[number])) {
        failure("X2_S8_FIXTURE_AMBIENT_ENVIRONMENT_CHANGED");
      }
      process.env[key] = value; installedEnvironment.set(key, value);
    }
  };
  const restoreEnvironment = () => {
    for (const [key, value] of installedEnvironment) if (process.env[key] === value) {
      const previous = previousEnvironment.get(key as typeof envKeys[number]);
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  };
  let closed = false, s6: ManagedProcess | null = null, s8: ManagedProcess | null = null, generation = 0, consumerFile = 0;
  let protocol: { signed: Signed<NativeS8ProtocolBody>; ref: ApplicationPortRef } | null = null;
  const assertOpen = () => { if (closed) failure("X2_S8_FIXTURE_CLOSED"); };
  const assertEnvironment = () => {
    assertOpen();
    for (const [key, value] of installedEnvironment) if (process.env[key] !== value) failure("X2_S8_FIXTURE_AMBIENT_ENVIRONMENT_CHANGED");
  };
  const assertSourceCut = async () => {
    assertOpen(); await privateDirectory(privateDir, false);
    await assertCapabilitySourceClosure(sourcePins);
    if (digest(await snapshot(sourcePaths)) !== digest(sourcePins) || digest(await snapshot(ledgerSources)) !== digest(ledgerPins)
      || parent.runtimeDigest !== digest(applicationRuntimeIdentity())) failure("X2_S8_FIXTURE_SOURCE_OR_RUNTIME_CHANGED");
    for (const [path, sha256] of immutableFiles) if (byteDigest(await boundedFile(path, true)) !== sha256) {
      failure("X2_S8_FIXTURE_SIGNED_CONFIGURATION_OR_KEY_CHANGED");
    }
  };
  const childEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: privateDir, TMPDIR: privateDir, LANG: "C", TZ: "UTC", NODE_ENV: nodeMode,
    FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable", FINNOR_X2_SOURCE_ROOT: repoRoot,
  };
  const commandAs = async (role: NativeS8FixtureRole, operation: NativeS8FixtureOperation, body: unknown,
    requestId = "x2-fixture:" + operation + ":" + randomUUID()): Promise<NativeS8HttpResult> => {
    assertEnvironment();
    if (!s8 || s8.child.exitCode !== null || s8.child.signalCode !== null) failure("X2_S8_FIXTURE_SERVICE_NOT_RUNNING");
    const token = lifecycleTokens.get(role) ?? failure("X2_S8_FIXTURE_ROLE_INVALID");
    const payload = canonical({ operation, requestId, body });
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) failure("X2_S8_FIXTURE_REQUEST_BOUND");
    const attempt = { role, operation, requestId, bodyDigest: digest(body) };
    await appendPrivate(paths.commands, { at: new Date().toISOString(), phase: "ATTEMPT", ...attempt });
    try {
      const credential = await boundedFile(token.path, true);
      if (byteDigest(credential) !== byteDigest(token.value)) failure("X2_S8_FIXTURE_ROLE_TOKEN_CHANGED");
      const response = await fetch(endpoints.s8 + "/command", {
        method: "POST", headers: { authorization: "Bearer " + credential.toString(), "content-type": "application/json" },
        body: payload, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10000),
      });
      const result = { status: response.status, body: await jsonResponse(response, 2 * 1024 * 1024) };
      await appendPrivate(paths.commands, { at: new Date().toISOString(), phase: "RESPONSE", ...attempt, ...result });
      return result;
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
        ? error.message : "X2_S8_FIXTURE_COMMAND_TRANSPORT_UNAVAILABLE";
      await appendPrivate(paths.commands, { at: new Date().toISOString(), phase: "FAILED", ...attempt, code });
      failure(code);
    }
  };
  const startServices = async (startLedger: boolean) => {
    await assertSourceCut(); ++generation;
    if (startLedger) {
      s6 = await launch({ cwd: backend, script: ledgerEntry,
        env: { ...childEnvironment, FINNOR_S6_LEDGER_CONFIG: paths.ledgerConfig, FINNOR_S6_LEDGER_RELEASE_ROOT: publicPem(keys.ledgerRelease) },
        port: ledgerPort, logPath: join(privateDir, "s6-process-" + generation + ".log") });
      const health = await fetch(endpoints.s6 + "/health", {
        headers: { authorization: "Bearer " + ownerTokens.get("S8_READER")!.value }, redirect: "error",
        credentials: "omit", signal: AbortSignal.timeout(5000),
      });
      if (health.status !== 200) failure("X2_S8_FIXTURE_LEDGER_AUTHENTICATED_READINESS_FAILED");
      await jsonResponse(health, 8 * 1024 * 1024);
      await appendPrivate(paths.processes, { event: "READY", service: "S6", pid: s6.child.pid, port: ledgerPort,
        entry: ledgerEntry, argv: s6.child.spawnargs, nodeMode, logPath: s6.logPath });
    }
    s8 = await launch({ cwd: backend, script: s8Entry,
      env: { ...childEnvironment, FINNOR_S8_PORT: String(lifecyclePort),
        FINNOR_S8_LIFECYCLE_CONFIG: paths.lifecycleConfig, FINNOR_S8_RELEASE_ROOT: publicPem(keys.lifecycleRelease),
        FINNOR_S6_OWNER_TRANSPORT_CONFIG: paths.transportConfig, FINNOR_S6_OWNER_TRANSPORT_ROOT: publicPem(keys.transportRoot) },
      port: lifecyclePort, logPath: join(privateDir, "s8-process-" + generation + ".log") });
    successful(await commandAs("reader", "READ", { offset: 0, limit: 1 }));
    await appendPrivate(paths.processes, { event: "READY", service: "S8", pid: s8.child.pid, port: lifecyclePort,
      entry: s8Entry, argv: s8.child.spawnargs, nodeMode, logPath: s8.logPath });
  };
  const stop = async (service: "S6" | "S8") => {
    const managed = service === "S6" ? s6 : s8;
    if (!managed) return;
    await managed.stop();
    await appendPrivate(paths.processes, { event: "STOPPED", service, pid: managed.child.pid,
      exitCode: managed.child.exitCode, signal: managed.child.signalCode, logPath: managed.logPath });
    if (service === "S6") s6 = null; else s8 = null;
  };
  const close = async () => {
    if (closed) return;
    // Let S8 finish closing its journal before stopping its commitment service.
    const outcomes = [];
    for (const service of ["S8", "S6"] as const) {
      try { await stop(service); outcomes.push(true); } catch { outcomes.push(false); }
    }
    restoreEnvironment(); closed = true;
    if (outcomes.some((outcome) => !outcome)) failure("X2_S8_FIXTURE_OWNED_PROCESS_CLEANUP_FAILED");
  };
  const scope = (semanticOwner: string): OwnerTransportScope => ({ semanticOwner, tenantId, principalId });
  const drainNativeRefs = async (maxBatchesPerOwner = 8): Promise<NativeReferenceDrain> => {
    assertEnvironment(); await assertSourceCut();
    z.number().int().min(1).max(8).parse(maxBatchesPerOwner);
    const batches: NativeReferenceDrain["batches"] = [];
    for (const owner of nativeOwners) for (let batch = 0; batch < maxBatchesPerOwner; batch++) {
      const report = await deliverOwnerTransportBatch(scope(owner), { limit: 32 });
      batches.push({ owner, report });
      if (!report.inspected || report.failures.length) break;
    }
    const unresolved = await withTenantTransaction(tenantId, { userId: principalId, readOnly: true }, async (_db, c) =>
      (await c.query<NativeReferenceDrain["unresolved"][number]>(
        "SELECT semantic_owner owner,identity,status,last_error AS \"lastError\" FROM finnor_os.s6_owner_delivery_states"
        + " WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner=ANY($3::text[]) AND status<>'ACCEPTED' ORDER BY semantic_owner,identity LIMIT 1537",
        [tenantId, principalId, nativeOwners])).rows);
    await appendPrivate(paths.commands, { at: new Date().toISOString(), operation: "NATIVE_OWNER_DELIVERY_DRAIN", batches, unresolved });
    return { batches, unresolved };
  };
  const publishNativeRefs = async (requested: readonly ExperimentRef[]): Promise<NativeReferencePublication> => {
    assertEnvironment(); await assertSourceCut();
    const refs = X2RefSchema.array().min(1).max(256).parse(requested), unique = new Map<string, ExperimentRef>();
    for (const ref of refs) {
      if (!nativeOwners.some((owner) => owner === ref.owner)) failure("X2_S8_FIXTURE_NATIVE_OWNER_UNSUPPORTED");
      if (unique.has(ref.id) && !sameX2Ref(unique.get(ref.id)!, ref)) failure("X2_S8_FIXTURE_NATIVE_REFERENCE_IDENTITY_CONFLICT");
      unique.set(ref.id, ref);
    }
    await withTenantTransaction(tenantId, { userId: principalId }, async (_db, c) => {
      for (const ref of unique.values()) {
        const artifact = (await c.query<{
          semantic_owner: string; version: string; content_digest: string; private: boolean; body: unknown;
        }>("SELECT semantic_owner,version,content_digest,private,body FROM finnor_os.application_semantics_artifacts"
          + " WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3", [tenantId, principalId, ref.id])).rows[0];
        let content: unknown;
        if (artifact) {
          if (artifact.private || artifact.semantic_owner !== ref.owner || artifact.version !== ref.version
            || artifact.content_digest !== ref.contentDigest) failure("X2_S8_FIXTURE_PRIVATE_OR_SUBSTITUTED_NATIVE_REFERENCE");
          content = artifact.body;
        } else if (ref.owner === "S5") {
          // These are immutable owner origins, NOT a mutable reservation/status projection.
          const originals = (await c.query<{ body: unknown; tenant_id: string; principal_id: string }>(
            "SELECT certificate body,tenant_id,principal_id FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND certificate->'ref'->>'id'=$3"
            + " UNION ALL SELECT body,tenant_id,principal_id FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3"
            + " UNION ALL SELECT body,tenant_id,principal_id FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3"
            + " UNION ALL SELECT body,tenant_id,principal_id FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND principal_id=$2 AND body->'ref'->>'id'=$3",
            [tenantId, principalId, ref.id])).rows;
          if (originals.length !== 1) failure("X2_S8_FIXTURE_EXACT_NATIVE_S5_ORIGIN_REQUIRED");
          const original = z.object({ ref: X2RefSchema }).passthrough().parse(originals[0]!.body);
          const { ref: storedRef, ...body } = original;
          if (!sameX2Ref(storedRef, ref) || originals[0]!.tenant_id !== tenantId || originals[0]!.principal_id !== principalId) {
            failure("X2_S8_FIXTURE_NATIVE_S5_ORIGIN_SUBSTITUTION");
          }
          content = body;
        } else failure("X2_S8_FIXTURE_RETAINED_NATIVE_REFERENCE_REQUIRED");
        if (digest(content) !== ref.contentDigest) failure("X2_S8_FIXTURE_NATIVE_PREIMAGE_INTEGRITY");
        const queued = await enqueueOwnerDeliveryInTransaction(c, scope(ref.owner), {
          kind: "REFERENCE", identity: ref.id, payload: { reference: { ...ref, content }, rightsRefs: [parent.rightsRevision] },
        });
        if (queued.status !== "AUTHENTICATED_OWNER_INTENT_PENDING_LEDGER") failure("X2_S8_FIXTURE_OWNER_DELIVERY_UNCONFIGURED");
      }
    });
    const drain = await drainNativeRefs();
    if (drain.batches.some((batch) => batch.report.failures.length)
      || drain.unresolved.some((row) => unique.has(row.identity))) failure("X2_S8_FIXTURE_NATIVE_DELIVERY_UNRESOLVED");
    const readbacks: NativeReferencePublication["readbacks"] = [];
    for (const ref of unique.values()) {
      const result = await resolveEconomicOwnerReference(scope("S8"), ref, { purpose: "CONSUMER", rightsRef: parent.rightsRevision });
      if (result.protectionDomain !== "DISPOSABLE_TEST_AUTHORITY") failure("X2_S8_FIXTURE_NATIVE_RECEIPT_DOMAIN");
      readbacks.push({ ref, receipt: result.receipt as unknown });
    }
    return { enqueued: [...unique.values()], drain, readbacks };
  };
  const readDiscoveryEvidence = async (): Promise<ApplicationTransitionEvidence[]> => {
    assertOpen();
    const originals = await withTenantTransaction(tenantId, { userId: principalId, readOnly: true }, async (_db, c) =>
      (await c.query<{ body: Omit<ApplicationTransitionEvidence, "ref">; ref: ExperimentRef; content_digest: string }>(
        "SELECT a.body,e.body->'detail'->'ref' ref,a.content_digest FROM finnor_os.application_semantics_events e"
        + " JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=e.tenant_id AND a.principal_id=e.principal_id"
        + " AND a.artifact_id=e.body->'detail'->'ref'->>'id' WHERE e.tenant_id=$1 AND e.principal_id=$2"
        + " AND e.session_id=$3 AND e.kind='ORIGINAL_TRANSITION_EVIDENCE' ORDER BY e.created_at,e.event_id LIMIT 257",
        [tenantId, principalId, session.id])).rows);
    if (!originals.length || originals.length > 256) failure("X2_S8_FIXTURE_ORIGINAL_EVIDENCE_BOUND");
    const evidence = originals.map(({ body, ref, content_digest }) => {
      if (digest(body) !== content_digest || ref.contentDigest !== content_digest) failure("X2_S8_FIXTURE_ORIGINAL_EVIDENCE_INTEGRITY");
      return parseTransitionEvidence({ ...body, ref });
    });
    if (digest(evidence.map((item) => item.ref)) !== digest(check.originalEvidenceRefs)
      || evidence.some((item) => !sameX2Ref(item.originalParentRef, parent.originalParentRef))) {
      failure("X2_S8_FIXTURE_RETAINED_CHECK_EVIDENCE_SUBSTITUTION");
    }
    return evidence;
  };
  const committed = async (ref: ApplicationPortRef, content: unknown, receipt: unknown) => {
    const read = await resolveEconomicOwnerReference(scope("S8"), ref, { purpose: "CONSUMER", rightsRef: parent.rightsRevision });
    if (read.protectionDomain !== "DISPOSABLE_TEST_AUTHORITY" || digest(read.reference.content) !== digest(content)
      || digest(read.receipt) !== digest(receipt)) failure("X2_S8_FIXTURE_S8_READBACK_SUBSTITUTION");
  };
  const lifecycleCommit = async <T,>(operation: "APPLICATION_REGISTER" | "APPLICATION_EVALUATE" | "APPLICATION_ADMIT"
    | "APPLICATION_ACTIVATE" | "APPLICATION_REVOKE", body: T, requestId?: string) => {
    assertEnvironment(); await assertSourceCut();
    const independent = operation === "APPLICATION_REGISTER" || operation === "APPLICATION_EVALUATE";
    const signedBody = signed(body, independent ? "x2-evaluator" : "x2-promoter", independent ? keys.evaluator : keys.promoter);
    const result = successful(await commandAs(independent ? "evaluator" : "promoter", operation, signedBody, requestId));
    const reply = operation === "APPLICATION_ACTIVATE" ? activationReplySchema.parse(result)
      : operation === "APPLICATION_REVOKE" ? revocationReplySchema.parse(result) : commitSchema.parse(result);
    if (!sameX2Ref(reply.ref, applicationRef(operation.slice("APPLICATION_".length).toLowerCase(), signedBody))) {
      failure("X2_S8_FIXTURE_S8_COMMITMENT_IDENTITY");
    }
    await committed(reply.ref, signedBody, reply.receipt);
    return { signed: signedBody, commitment: commitSchema.parse({
      ref: reply.ref, receipt: reply.receipt, ...NATIVE_S8_FIXTURE_FLAGS,
    }), raw: reply };
  };
  try {
    installEnvironment(environment);
    // Validate every real route before opening either process; no ambient donor routes.
    for (const route of routes) if (!await ownerTransportRoute(scope(route.semanticOwner), route.purpose)) {
      failure("X2_S8_FIXTURE_OWNER_ROUTE_UNAVAILABLE");
    }
    await startServices(true);
    await saveImmutable(paths.freeze, canonical({
      schema: "finnor.x2.native-s8-fixture-freeze.v1", createdAt: new Date().toISOString(),
      repoRoot, nativeSessionId: session.id, modelRef: model.ref, checkRef: check.ref, originalParentRef: parent.originalParentRef,
      principals: { native: principalId, evaluator: evaluatorId, promoter: promoterId },
      originalDeadline: validUntil, sourcePins, ledgerPins, runtime: applicationRuntimeIdentity(),
      candidateRef: candidate.ref, dependencyDigest, lifecyclePolicyDigest: digest(lifecyclePolicy),
      ledgerPolicyDigest: digest(ledgerPolicy), ledgerReleaseId: ledgerRelease.releaseId, transportPolicyDigest: digest(transportPolicy),
      endpoints, limits, privateEnvironmentKeys: envKeys, evaluationSuppliedBy: "CALLER_INDEPENDENT_NATIVE_AND_PORTAL_INSPECTOR",
      independentEvaluationPerformed: false, lifecycleCosts: "UNKNOWN", protectedCustodyEstablished: false,
      ...NATIVE_S8_FIXTURE_FLAGS,
    }));
    const fixture: NativeS8Fixture = {
      privateDir, get paths() { return { ...paths }; }, get candidate() { return structuredClone(candidate); }, dependencyDigest,
      principals: { native: principalId, evaluator: evaluatorId, promoter: promoterId },
      get sourcePins() { return structuredClone(sourcePins); },
      endpoints: () => ({ ...endpoints }), environment: () => ({ ...environment }),
      assertSourceCut, publishNativeRefs, drainNativeRefs, readDiscoveryEvidence, commandAs,
      async propose(requestId) {
        await publishNativeRefs([
          model.ref, check.ref, parent.originalParentRef, parent.tenantRef, parent.workRef,
          parent.authorityGrantRef, parent.resourceGrantRef, parent.baselineManifestRef,
          parent.producerRef, parent.grammarRef, parent.checkerRef, parent.runtimeRef,
          session.allocation_ref, session.reservation_ref, session.root_consumption_ref,
          ...originalBindings.map((profile) => profile.grantRef),
        ]);
        const reply = commitSchema.parse(successful(await commandAs("proposer", "APPLICATION_PROPOSE", candidate, requestId)));
        const { ref: _ref, ...body } = candidate;
        if (!sameX2Ref(reply.ref, candidate.ref)) failure("X2_S8_FIXTURE_CANDIDATE_IDENTITY");
        await committed(reply.ref, body, reply.receipt); return reply;
      },
      async register(value, requestId) {
        const body = ApplicationProtocolSchema.parse(value);
        await readDiscoveryEvidence();
        if (body.tenantId !== tenantId || body.principalId !== principalId || body.evaluatorId !== evaluatorId
          || !sameX2Ref(body.revisionRef, candidate.ref) || body.dependencyDigest !== dependencyDigest
          || digest(body.originalEvidenceRefs) !== digest(check.originalEvidenceRefs)) failure("X2_S8_FIXTURE_INDEPENDENT_REGISTRATION_BINDING");
        const result = await lifecycleCommit("APPLICATION_REGISTER", body, requestId);
        protocol = { signed: result.signed, ref: result.commitment.ref };
        return { signed: result.signed, commitment: result.commitment };
      },
      async evaluate(value, requestId) {
        const body = ApplicationEvaluationSchema.parse(value);
        await readDiscoveryEvidence();
        if (!protocol || body.tenantId !== tenantId || body.principalId !== principalId || body.evaluatorId !== evaluatorId
          || !sameX2Ref(body.revisionRef, candidate.ref) || !sameX2Ref(body.protocolRef, protocol.ref)
          || body.dependencyDigest !== dependencyDigest
          || digest(body.originalEvidenceRefs) !== digest(protocol.signed.body.originalEvidenceRefs)
          || digest(body.caseCommitments) !== digest(protocol.signed.body.caseCommitments)
          || !sameX2Ref(body.oracleRef, protocol.signed.body.oracleRef)) failure("X2_S8_FIXTURE_INDEPENDENT_EVALUATION_BINDING");
        // Never infer SUPPORTED, counters, result evidence or costs from model/check.
        const result = await lifecycleCommit("APPLICATION_EVALUATE", body, requestId);
        return { signed: result.signed, commitment: result.commitment };
      },
      async admit(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_ADMIT", ApplicationAdmissionSchema.parse(value), requestId);
        return { signed: result.signed, commitment: result.commitment };
      },
      async activate(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_ACTIVATE", ApplicationActivationSchema.parse(value), requestId);
        return { signed: result.signed, commitment: result.commitment,
          generation: activationReplySchema.parse(result.raw).generation };
      },
      async revoke(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_REVOKE", ApplicationRevocationSchema.parse(value), requestId);
        const reply = revocationReplySchema.parse(result.raw);
        return { signed: result.signed, commitment: result.commitment, generation: reply.generation,
          unresolvedUsesPreserved: reply.unresolvedUsesPreserved };
      },
      async writeConsumerConfig(value) {
        assertEnvironment(); await assertSourceCut();
        const profiles = [...value.profiles];
        if (!profiles.length || profiles.length > 8 || new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
          failure("X2_S8_FIXTURE_CURRENT_PROFILE_DOMAIN");
        }
        let fresh: ApplicationSessionRow | null = null, freshAuthorityRef: ExperimentRef | null = null;
        if (value.freshSessionId) {
          fresh = await applicationSession(ctx, value.freshSessionId);
          if (fresh.parent_id !== session.id || !sameX2Ref(fresh.original_parent_ref, parent.originalParentRef)
            || !fresh.model_ref || !sameX2Ref(fresh.model_ref, model.ref)
            || !fresh.check_ref || !sameX2Ref(fresh.check_ref, check.ref)) failure("X2_S8_FIXTURE_FRESH_CHILD_SUBSTITUTION");
          const authority = await currentFreshApplicationAuthority(ctx, fresh);
          freshAuthorityRef = x2Ref("S4", "application-fresh-authority", authority);
          if (digest(await applicationArtifact(ctx, freshAuthorityRef)) !== digest(authority)) failure("X2_S8_FIXTURE_FRESH_OWNER_PREIMAGE");
        }
        const bindings = [];
        for (const profile of profiles) {
          const binding = applicationProfileBinding(profile), original = originalBindings.find((item) => item.id === profile.id);
          if (!original || binding.tenantId !== original.tenantId || binding.principalId !== original.principalId
            || binding.application !== original.application || binding.account !== original.account
            || binding.actingPrincipal !== original.actingPrincipal || binding.role !== original.role || binding.origin !== original.origin
            || Date.parse(binding.validUntil) < Date.parse(parent.deadlineAt)) failure("X2_S8_FIXTURE_STABLE_PROFILE_IDENTITY_CHANGED");
          const native = await nativeApplicationProfile(ctx, profile.id);
          if (digest(applicationProfileBinding(native.profile)) !== digest(binding)) failure("X2_S8_FIXTURE_CURRENT_PROFILE_SUBSTITUTION");
          if (fresh) await assertFreshApplicationProfile(ctx, fresh, native);
          else if (digest(original) !== digest(binding)) failure("X2_S8_FIXTURE_RETAINED_FRESH_AUTHORITY_REQUIRED");
          bindings.push(binding);
        }
        if (freshAuthorityRef) await publishNativeRefs([freshAuthorityRef, ...bindings.map((profile) => profile.grantRef)]);
        const until = value.validUntil ?? validUntil;
        if (Date.parse(until) > Date.parse(validUntil) || Date.parse(until) <= Date.now()) failure("X2_S8_FIXTURE_CONSUMER_DEADLINE_EXTENSION");
        const token = lifecycleTokens.get("consumer")!;
        const policy = ApplicationConsumerPolicySchema.parse({
          schema: "finnor.s8.application-consumer-policy.v1", tenantId, principalId, rightsRef: parent.rightsRevision,
          revisionRef: candidate.ref, modelRef: model.ref, checkRef: check.ref,
          originalParentRef: parent.originalParentRef, originalParentDigest: digest(parent), dependencyDigest,
          profileBindingDigests: bindings.map((binding) => digest(binding)).sort(), sourceRoot: repoRoot, sourcePins,
          endpoint: endpoints.s8, tokenPath: token.path, tokenHash: byteDigest(token.value), validAfter, validUntil: until,
          timeoutMs: 10000, maxCurrentnessMs: limits.maxCurrentnessMs, ...NATIVE_S8_FIXTURE_FLAGS,
        });
        const path = join(privateDir, "consumer-policy-" + (++consumerFile) + ".json");
        await saveImmutable(path, canonical(signed(policy, "x2-consumer-root", keys.consumerRoot)));
        environment.FINNOR_S8_APPLICATION_CONSUMER_CONFIG = path;
        environment.FINNOR_S8_APPLICATION_CONSUMER_ROOT = publicPem(keys.consumerRoot);
        installEnvironment(environment);
        return { path, policy, freshAuthorityRef, environment: { ...environment } };
      },
      async restart(services = "S6_AND_S8") {
        assertEnvironment(); await assertSourceCut();
        await stop("S8");
        if (services === "S6_AND_S8") await stop("S6");
        try { await startServices(services === "S6_AND_S8"); }
        catch (error) { await close(); throw error; }
      },
      close,
    };
    return fixture;
  } catch (error) { await close(); throw error; }
}
