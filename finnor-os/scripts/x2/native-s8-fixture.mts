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
import { assertSignature, byteDigest, digest, type Signed } from "../../packages/capability-evolution/src/contracts";
import {
  assertCapabilitySourceClosure, requiredCapabilitySourcePaths,
  assertApplicationSemanticsSourceClosure, requiredApplicationSemanticsSourcePaths,
} from "../../packages/capability-evolution/src/source-closure";
import type { CapabilityEvolution } from "../../packages/capability-evolution/src/lifecycle";
import {
  APPLICATION_S8_QUALIFICATION, ApplicationActivationSchema, ApplicationAdmissionSchema, ApplicationCandidateBodySchema,
  ApplicationCurrentnessBodySchema, ApplicationRecheckBodySchema, ApplicationRecheckCommandSchema, ApplicationReconciliationSchema,
  ApplicationEvaluationSchema, ApplicationPortRefSchema, ApplicationProtocolSchema,
  ApplicationRevocationSchema, ApplicationUseCommandSchema, ApplicationUseLeaseSchema,
  OriginalApplicationParentSchema, applicationDependencyDigest, applicationRequestBindingDigest,
  applicationProfileBinding, applicationRef, makeApplicationCandidate, parseApplicationCandidate,
  type ApplicationCandidate, type ApplicationCapabilityUseLease, type ApplicationPortRef, type ApplicationUseCommand,
} from "../../packages/capability-evolution/src/application-semantics-port";
import {
  ApplicationConsumerPolicySchema, type ApplicationConsumerPolicy,
} from "../../packages/capability-evolution/src/application-semantics-consumer";

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
  | "READ" | "APPLICATION_SEMANTICS_PROPOSE" | "APPLICATION_SEMANTICS_REGISTER" | "APPLICATION_SEMANTICS_EVALUATE"
  | "APPLICATION_SEMANTICS_ADMIT" | "APPLICATION_SEMANTICS_ACTIVATE" | "APPLICATION_SEMANTICS_REVOKE"
  | "APPLICATION_SEMANTICS_CURRENT" | "APPLICATION_SEMANTICS_USE" | "APPLICATION_SEMANTICS_RECHECK" | "APPLICATION_SEMANTICS_RECONCILE";
export interface NativeS8FixtureEnvironment {
  FINNOR_S6_OWNER_TRANSPORT_CONFIG: string;
  FINNOR_S6_OWNER_TRANSPORT_ROOT: string;
  FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_CONFIG?: string;
  FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_ROOT?: string;
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
/** Lifecycle stages run before their unchanged positive command. Use stages
 * require real canonical leases; no stage manufactures native currentness. */
export type NativeS8ApplicationCommandNegativeInput =
  | { phase: "candidate" }
  | { phase: "register"; body: NativeS8ProtocolBody }
  | { phase: "evaluate"; body: NativeS8EvaluationBody }
  | { phase: "admit"; body: NativeS8AdmissionBody }
  | { phase: "activate"; body: NativeS8ActivationBody }
  | { phase: "retained-use"; lease: ApplicationCapabilityUseLease }
  | { phase: "live-use"; command: ApplicationUseCommand; lease: ApplicationCapabilityUseLease;
      alternateCurrentnessRef?: ExperimentRef }
  | { phase: "disposable-revocation"; protocol: NativeS8ProtocolBody }
  /** Supplied subject must already have its OWN independent lifecycle/evidence,
   * in a different domain. This helper never recycles evaluation cases. */
  | { phase: "isolated-live-use"; candidate: ApplicationCandidate; command: ApplicationUseCommand;
      lease: ApplicationCapabilityUseLease; alternateCurrentnessRef?: ExperimentRef }
  /** Already expired under its original signed activation, without waiting or
   * changing any deadline. The original fixture must still be current. */
  | { phase: "isolated-expired-activation"; candidate: ApplicationCandidate; command: ApplicationUseCommand };
export interface NativeS8ApplicationCommandNegativeObservation {
  id: string;
  role: NativeS8FixtureRole;
  operation: NativeS8FixtureOperation;
  requestId: string;
  commandDigest: string;
  mutation: string;
  boundary: string;
  expected: { status: number; code: string | null };
  observed: { status: number; code: string | null };
  beforeStateDigest: string;
  afterStateDigest: string | null;
  passed: boolean;
}
export interface NativeS8ApplicationCommandNegativeReport {
  schema: "finnor.x2.s8-application-command-negatives.v1";
  phase: NativeS8ApplicationCommandNegativeInput["phase"];
  verdict: "PASS" | "FAIL";
  artifactPath: string;
  /** Strict typed references/bindings only, stored mode 0600; never credentials
   * or native private wire/observation preimages. Not included in this report. */
  inputArtifactPath: string;
  startedAt: string;
  finishedAt: string | null;
  fixtureRevisionRef: ApplicationPortRef;
  subjectRevisionRef: ApplicationPortRef;
  sourcePinsDigest: string;
  inputDigest: string;
  cases: NativeS8ApplicationCommandNegativeObservation[];
  controls: NativeS8ApplicationCommandNegativeObservation[];
  deferred: Array<{ boundary: string; reason: string }>;
  failureCode: string | null;
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  qualification: typeof APPLICATION_S8_QUALIFICATION;
  protectedAdmission: false;
  executionAuthorityGranted: false;
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
  /** Opt-in, serial, finite native owner checks. Writes a private replayable
   * report, stops on the first unexpected response/state change, never logs keys.
   * A test-only signal cancels delivery; it is never part of a signed command. */
  checkApplicationCommandNegatives(input: NativeS8ApplicationCommandNegativeInput, options?: { signal?: AbortSignal }):
    Promise<NativeS8ApplicationCommandNegativeReport>;
  /** Same ports, signed configs, keys, original deadline and journal directories. */
  restart(services?: "S8" | "S6_AND_S8"): Promise<void>;
  /** Stop only child handles created here; restore unchanged owned env; delete nothing. */
  close(): Promise<void>;
}

/** Named entry for callers keeping the original fixture lifecycle unchanged. */
export function runNativeS8ApplicationCommandNegatives(fixture: NativeS8Fixture,
  input: NativeS8ApplicationCommandNegativeInput): Promise<NativeS8ApplicationCommandNegativeReport> {
  return fixture.checkApplicationCommandNegatives(input);
}

export interface SourcePin { path: string; sha256: string }
const loadedRepo = resolve(import.meta.dirname, "../../..");
const nativeOwners = ["S1", "WORK", "AUTHORITY", "S4", "S5", "S6", "COMPUTER"] as const;
const roles: NativeS8FixtureRole[] = ["proposer", "evaluator", "promoter", "consumer", "reader"];
const envKeys = [
  "FINNOR_S6_OWNER_TRANSPORT_CONFIG", "FINNOR_S6_OWNER_TRANSPORT_ROOT",
  "FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_CONFIG", "FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_ROOT",
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
const commitSchema = z.object({ ref: ApplicationPortRefSchema, receipt: z.record(z.string(), z.unknown()), ...replyFlags }).strict();
const activationReplySchema = commitSchema.extend({ generation: z.number().int().positive() }).strict();
const revocationReplySchema = activationReplySchema.extend({
  liabilityBudgetReleased: z.literal(false), unresolvedUsesPreserved: z.number().int().nonnegative(),
}).strict();
const negativeCandidateSchema = ApplicationCandidateBodySchema.extend({ ref: ApplicationPortRefSchema }).strict();
const commandNegativeInputSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("candidate") }).strict(),
  z.object({ phase: z.literal("register"), body: ApplicationProtocolSchema }).strict(),
  z.object({ phase: z.literal("evaluate"), body: ApplicationEvaluationSchema }).strict(),
  z.object({ phase: z.literal("admit"), body: ApplicationAdmissionSchema }).strict(),
  z.object({ phase: z.literal("activate"), body: ApplicationActivationSchema }).strict(),
  z.object({ phase: z.literal("retained-use"), lease: ApplicationUseLeaseSchema }).strict(),
  z.object({ phase: z.literal("live-use"), command: ApplicationUseCommandSchema, lease: ApplicationUseLeaseSchema,
    alternateCurrentnessRef: X2RefSchema.optional() }).strict(),
  z.object({ phase: z.literal("disposable-revocation"), protocol: ApplicationProtocolSchema }).strict(),
  z.object({ phase: z.literal("isolated-live-use"), candidate: negativeCandidateSchema,
    command: ApplicationUseCommandSchema, lease: ApplicationUseLeaseSchema, alternateCurrentnessRef: X2RefSchema.optional() }).strict(),
  z.object({ phase: z.literal("isolated-expired-activation"), candidate: negativeCandidateSchema,
    command: ApplicationUseCommandSchema }).strict(),
]);
// Complete, bounded canonical READ, not journal-file inspection or a mock owner.
const commandNegativeSnapshotSchema = z.object({
  applications: z.object({
    revisions: z.array(z.object({
      ref: ApplicationPortRefSchema, modelRef: X2RefSchema, checkRef: X2RefSchema, originalParentRef: X2RefSchema,
      scope: z.record(z.string(), z.unknown()), dependencyDigest: z.string(), revoked: z.boolean(),
      protocolRef: ApplicationPortRefSchema.nullable(), evaluationRef: ApplicationPortRefSchema.nullable(),
      admissionRef: ApplicationPortRefSchema.nullable(), activationRef: ApplicationPortRefSchema.nullable(),
      domain: z.object({ generation: z.number().int().nonnegative(), active: z.string().nullable() }).strict(),
    }).passthrough()).max(256),
    uses: z.array(z.object({
      lease: ApplicationUseLeaseSchema, reconciled: z.boolean(), lastEvidenceRef: X2RefSchema.nullable(),
      evidenceRefs: z.array(X2RefSchema), liabilityRefs: z.array(X2RefSchema), possibleEffectRefs: z.array(X2RefSchema),
    }).strict()).max(256),
    counts: z.object({ revisions: z.number().int(), uses: z.number().int(), consumedCases: z.number().int() }).strict(),
    liabilityBudgetReleased: z.literal(false), economicCreditGranted: z.literal(false), ...replyFlags,
  }).strict(),
  accounting: z.object({ totalCost: z.number(), totalLoss: z.number(), useCount: z.number().int() }).strict(),
  history: z.array(z.object({
    sequence: z.number().int(), operation: z.string(), requestId: z.string(), digest: z.string(), knowledgeAt: z.string(),
  }).strict()).max(256),
  page: z.object({
    offset: z.literal(0), limit: z.literal(256), sequence: z.number().int(),
    nextOffset: z.null(), complete: z.literal(true),
  }).strict(),
}).passthrough();
type CommandNegativeSnapshot = z.infer<typeof commandNegativeSnapshotSchema>;

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
  const sourcePaths = [...new Set([...requiredApplicationSemanticsSourcePaths, ...nativePaths, ...installedPaths,
    join(import.meta.dirname, "native-s8-fixture.mts")])].sort();
  if (sourcePaths.length > 128) failure("X2_S8_FIXTURE_S8_SOURCE_PIN_CAPACITY");
  const lifecycleSourcePaths = [...new Set([...requiredCapabilitySourcePaths,...sourcePaths])].sort();
  if(lifecycleSourcePaths.length>256) failure("X2_S8_FIXTURE_LIFECYCLE_SOURCE_PIN_CAPACITY");
  const snapshot = (paths: readonly string[]) => Promise.all(paths.map(async (path) => ({
    path, sha256: byteDigest(await boundedFile(path)),
  })));
  const sourcePins = await snapshot(sourcePaths), lifecyclePins = await snapshot(lifecycleSourcePaths), ledgerPins = await snapshot(ledgerSources);
  for (const pin of parent.dependencyPins) if (!sourcePins.some((source) => source.path === resolve(repoRoot, pin.path) && source.sha256 === pin.sha256)) {
    failure("X2_S8_FIXTURE_NATIVE_PIN_CHANGED");
  }
  await assertApplicationSemanticsSourceClosure(sourcePins);
  await assertCapabilitySourceClosure(lifecyclePins);
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
    sourcePins:lifecyclePins, applicationSemantics: {
      schema: "finnor.s8.application-port-policy.v1", frontier: "FRONTIER5.X2", sourceRoot: repoRoot, sourcePins,
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
    await assertApplicationSemanticsSourceClosure(sourcePins);
    await assertCapabilitySourceClosure(lifecyclePins);
    if (digest(await snapshot(sourcePaths)) !== digest(sourcePins) || digest(await snapshot(lifecycleSourcePaths)) !== digest(lifecyclePins)
      || digest(await snapshot(ledgerSources)) !== digest(ledgerPins)
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
    requestId = "x2-fixture:" + operation + ":" + randomUUID(), signal?: AbortSignal): Promise<NativeS8HttpResult> => {
    assertEnvironment();
    if (signal?.aborted) failure("X2_S8_NEGATIVE_EXECUTION_ABORTED");
    if (!s8 || s8.child.exitCode !== null || s8.child.signalCode !== null) failure("X2_S8_FIXTURE_SERVICE_NOT_RUNNING");
    const token = lifecycleTokens.get(role) ?? failure("X2_S8_FIXTURE_ROLE_INVALID");
    const payload = canonical({ operation, requestId, body });
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) failure("X2_S8_FIXTURE_REQUEST_BOUND");
    const attempt = { role, operation, requestId, bodyDigest: digest(body) };
    await appendPrivate(paths.commands, { at: new Date().toISOString(), phase: "ATTEMPT", ...attempt });
    try {
      const credential = await boundedFile(token.path, true);
      if (byteDigest(credential) !== byteDigest(token.value)) failure("X2_S8_FIXTURE_ROLE_TOKEN_CHANGED");
      if (signal?.aborted) failure("X2_S8_NEGATIVE_EXECUTION_ABORTED");
      const response = await fetch(endpoints.s8 + "/command", {
        method: "POST", headers: { authorization: "Bearer " + credential.toString(), "content-type": "application/json" },
        body: payload, redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });
      const result = { status: response.status, body: await jsonResponse(response, 2 * 1024 * 1024) };
      await appendPrivate(paths.commands, { at: new Date().toISOString(), phase: "RESPONSE", ...attempt, ...result });
      return result;
    } catch (error) {
      const code = signal?.aborted ? "X2_S8_NEGATIVE_EXECUTION_ABORTED"
        : error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
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
  const lifecycleCommit = async <T,>(operation: "APPLICATION_SEMANTICS_REGISTER" | "APPLICATION_SEMANTICS_EVALUATE" | "APPLICATION_SEMANTICS_ADMIT"
    | "APPLICATION_SEMANTICS_ACTIVATE" | "APPLICATION_SEMANTICS_REVOKE", body: T, requestId?: string) => {
    assertEnvironment(); await assertSourceCut();
    const independent = operation === "APPLICATION_SEMANTICS_REGISTER" || operation === "APPLICATION_SEMANTICS_EVALUATE";
    const signedBody = signed(body, independent ? "x2-evaluator" : "x2-promoter", independent ? keys.evaluator : keys.promoter);
    const result = successful(await commandAs(independent ? "evaluator" : "promoter", operation, signedBody, requestId));
    const reply = operation === "APPLICATION_SEMANTICS_ACTIVATE" ? activationReplySchema.parse(result)
      : operation === "APPLICATION_SEMANTICS_REVOKE" ? revocationReplySchema.parse(result) : commitSchema.parse(result);
    if (!sameX2Ref(reply.ref, applicationRef(operation.slice("APPLICATION_SEMANTICS_".length).toLowerCase(), signedBody))) {
      failure("X2_S8_FIXTURE_S8_COMMITMENT_IDENTITY");
    }
    await committed(reply.ref, signedBody, reply.receipt);
    return { signed: signedBody, commitment: commitSchema.parse({
      ref: reply.ref, receipt: reply.receipt, ...NATIVE_S8_FIXTURE_FLAGS,
    }), raw: reply };
  };
  let negativeSuiteRunning = false;
  const checkApplicationCommandNegatives = async (
    supplied: NativeS8ApplicationCommandNegativeInput,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<NativeS8ApplicationCommandNegativeReport> => {
    assertEnvironment();
    if (negativeSuiteRunning) failure("X2_S8_NEGATIVE_SERIAL_INVOCATION_REQUIRED");
    // Capture caller inputs before the first await. Never mutate its positive bodies.
    const input: NativeS8ApplicationCommandNegativeInput = commandNegativeInputSchema.parse(structuredClone(supplied)), runId = randomUUID();
    if ((input.phase === "live-use" || input.phase === "isolated-live-use") && input.alternateCurrentnessRef === undefined) {
      delete input.alternateCurrentnessRef; // canonical encoding deliberately refuses undefined.
    }
    const report: NativeS8ApplicationCommandNegativeReport = {
      schema: "finnor.x2.s8-application-command-negatives.v1", phase: input.phase, verdict: "FAIL",
      artifactPath: join(privateDir, "command-negatives-" + runId + ".json"),
      inputArtifactPath: join(privateDir, "command-negative-input-" + runId + ".json"),
      startedAt: new Date().toISOString(), finishedAt: null, fixtureRevisionRef: candidate.ref,
      subjectRevisionRef: candidate.ref, sourcePinsDigest: digest(sourcePins), inputDigest: digest(input),
      cases: [], controls: [], deferred: [], failureCode: null, ...NATIVE_S8_FIXTURE_FLAGS,
    };
    negativeSuiteRunning = true;
    const assertActive = () => {
      if (signal?.aborted) failure("X2_S8_NEGATIVE_EXECUTION_ABORTED");
    };
    const negativeCommand = (role: NativeS8FixtureRole, operation: NativeS8FixtureOperation,
      body: unknown, requestId?: string) => commandAs(role, operation, body, requestId, signal);
    const requireThat = (condition: unknown, code: string): void => {
      assertActive();
      if (!condition) failure("X2_S8_NEGATIVE_" + code);
    };
    const same = (left: unknown, right: unknown, code: string) => requireThat(digest(left) === digest(right), code);
    const changedHex = (value: string) => (value[0] === "0" ? "1" : "0") + value.slice(1);
    const changedText = (value: string) => {
      const replacement = "x2-negative:" + changedHex(digest(value));
      return replacement === value ? "y2-negative:" + changedHex(digest(value)) : replacement;
    };
    const union = (left: ExperimentRef[], right: ExperimentRef[]) =>
      [...new Map([...left, ...right].map(ref => [digest(ref), ref])).values()];
    const defer = (boundary: string, reason: string) => { report.deferred.push({ boundary, reason }); };
    const snapshot = async (atSequence?: number): Promise<CommandNegativeSnapshot> => {
      const response = successful(await negativeCommand("reader", "READ", {
        offset: 0, limit: 256, ...(atSequence === undefined ? {} : { atSequence }),
      }));
      const parsed = commandNegativeSnapshotSchema.safeParse(response);
      requireThat(parsed.success, "COMPLETE_CANONICAL_SNAPSHOT_REQUIRED");
      if (!parsed.success) failure("X2_S8_NEGATIVE_COMPLETE_CANONICAL_SNAPSHOT_REQUIRED");
      requireThat(parsed.data.applications.counts.revisions === parsed.data.applications.revisions.length
        && parsed.data.applications.counts.uses === parsed.data.applications.uses.length,
      "TRUNCATED_APPLICATION_SNAPSHOT");
      return parsed.data;
    };
    const revision = (state: CommandNegativeSnapshot, ref: ApplicationPortRef) => {
      const found = state.applications.revisions.find(item => sameX2Ref(item.ref, ref));
      if (!found) failure("X2_S8_NEGATIVE_CANONICAL_REVISION_REQUIRED");
      return found;
    };
    const protection = (state: CommandNegativeSnapshot, permittedRecheckUseId?: string) => ({
      revision: revision(state, candidate.ref), accounting: state.accounting,
      uses: state.applications.uses.filter(item => sameX2Ref(item.lease.revisionRef, candidate.ref)
        && item.lease.useId !== permittedRecheckUseId),
      consumedCases: state.applications.counts.consumedCases,
    });
    const ownerContent = async (ref: ExperimentRef) => {
      assertActive();
      const read = await resolveEconomicOwnerReference(scope("S8"), ref, { purpose: "CONSUMER", rightsRef: parent.rightsRevision });
      requireThat(read.protectionDomain === "DISPOSABLE_TEST_AUTHORITY"
        && digest(read.reference.content) === ref.contentDigest, "CANONICAL_OWNER_PREIMAGE_REQUIRED");
      return read.reference.content as unknown;
    };
    type SignedOperation = "APPLICATION_SEMANTICS_REGISTER" | "APPLICATION_SEMANTICS_EVALUATE" | "APPLICATION_SEMANTICS_ADMIT"
      | "APPLICATION_SEMANTICS_ACTIVATE" | "APPLICATION_SEMANTICS_REVOKE";
    const independentOperation = (operation: SignedOperation) =>
      operation === "APPLICATION_SEMANTICS_REGISTER" || operation === "APPLICATION_SEMANTICS_EVALUATE";
    const signingRole = (operation: SignedOperation) => independentOperation(operation) ? "evaluator" as const : "promoter" as const;
    const signAs = (role: "evaluator" | "promoter", body: unknown) =>
      signed(body, "x2-" + role, keys[role]);
    const observe = async (args: {
      id: string; role: NativeS8FixtureRole; operation: NativeS8FixtureOperation; body: unknown;
      mutation: string; boundary: string; expected: { status: number; code: string | null };
      requestId?: string;
      accepted?: (body: unknown, before: CommandNegativeSnapshot, after: CommandNegativeSnapshot) => Promise<void> | void;
    }) => {
      requireThat(report.cases.length + report.controls.length < 128, "FINITE_CASE_BOUND");
      const before = await snapshot(), requestId = args.requestId ?? "x2-negative:" + runId + ":" + args.id;
      const row: NativeS8ApplicationCommandNegativeObservation = {
        id: args.id, role: args.role, operation: args.operation, requestId, commandDigest: digest(args.body),
        mutation: args.mutation, boundary: args.boundary, expected: args.expected,
        observed: { status: 0, code: null }, beforeStateDigest: digest(before), afterStateDigest: null, passed: false,
      };
      (args.accepted ? report.controls : report.cases).push(row);
      try {
        const result = await negativeCommand(args.role, args.operation, args.body, requestId);
        const error = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,128}$/) }).passthrough().safeParse(result.body);
        row.observed = { status: result.status, code: error.success ? error.data.code : null };
        // Refusals/read-only controls cannot append history, even with a right-looking error.
        const after = await snapshot(args.expected.status === 200 && args.operation !== "APPLICATION_SEMANTICS_CURRENT"
          ? undefined : before.page.sequence);
        row.afterStateDigest = digest(after);
        same(row.observed, args.expected, "UNEXPECTED_OWNER_DISPOSITION");
        if (args.accepted) await args.accepted(result.body, before, after);
        else same(before, after, "REFUSAL_CHANGED_CANONICAL_STATE");
        assertActive();
        row.passed = true;
        return { body: result.body, before, after, requestId };
      } finally {
        await appendPrivate(paths.commands, { at: new Date().toISOString(), kind: "X2_S8_COMMAND_NEGATIVE_OBSERVATION", ...row });
      }
    };
    const refuse = (id: string, role: NativeS8FixtureRole, operation: NativeS8FixtureOperation, body: unknown,
      code: string, mutation: string, boundary: string, status = 409, requestId?: string) =>
      observe({ id, role, operation, body, mutation, boundary, expected: { status, code }, requestId });
    const signedRefusal = (id: string, operation: SignedOperation, schema: { parse(value: unknown): unknown },
      body: unknown, code: string, mutation: string, status = 409) =>
      refuse(id, signingRole(operation), operation, signAs(signingRole(operation), schema.parse(body)),
        code, mutation, "ApplicationCapabilityPort.command:" + operation, status);
    const signedRoleChecks = async (operation: SignedOperation, schema: { parse(value: unknown): unknown }, body: unknown) => {
      const correct = signingRole(operation), other = correct === "evaluator" ? "promoter" : "evaluator";
      const parsed = schema.parse(body);
      await refuse("wrong-role", other, operation, signAs(correct, parsed), "S8_OPERATION_NOT_AUTHORIZED",
        "Only the authenticated configured role changes; the original valid signature/body are retained.",
        "ApplicationCapabilityPort.role", 403);
      await refuse("wrong-signer-principal", correct, operation, signAs(other, parsed), "INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID",
        "The other existing configured principal genuinely signs the unchanged body; authentication keeps the required role.",
        "assertSignature:configured-role-key-and-actor", 403);
    };
    const assertCommit = async (reply: unknown, expectedRef: ApplicationPortRef, content: unknown) => {
      const parsed = commitSchema.passthrough().parse(reply);
      same(parsed.ref, expectedRef, "CONTROL_COMMITMENT_IDENTITY");
      await committed(parsed.ref, content, parsed.receipt);
    };
    const assertAppend = (before: CommandNegativeSnapshot, after: CommandNegativeSnapshot, permittedUseId?: string) => {
      requireThat(after.page.sequence === before.page.sequence + 1, "CONTROL_DID_NOT_APPEND_ONCE");
      same(protection(before, permittedUseId), protection(after, permittedUseId), "CONTROL_CHANGED_POSITIVE_FIXTURE");
    };
    const currentControl = async (ref: ApplicationPortRef, expectedCurrent: boolean, id: string) =>
      observe({ id, role: "consumer", operation: "APPLICATION_SEMANTICS_CURRENT", body: { revisionRef: ref },
        mutation: "None; canonical owner currentness read.", boundary: "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_CURRENT",
        expected: { status: 200, code: null }, accepted(body, before, after) {
          const reply = z.object({
            current: z.boolean(), revisionRef: ApplicationPortRefSchema, generation: z.number().int(),
            admissionRef: ApplicationPortRefSchema.nullable(), activationRef: ApplicationPortRefSchema.nullable(),
            dependencyDigest: z.string(), ...replyFlags,
          }).strict().parse(body);
          same(before, after, "CURRENT_CONTROL_CHANGED_STATE");
          same(reply.revisionRef, ref, "CURRENT_CONTROL_REVISION");
          requireThat(reply.current === expectedCurrent, "CURRENT_CONTROL_DISPOSITION");
          const retained = revision(after, ref);
          requireThat(reply.generation === retained.domain.generation
            && reply.dependencyDigest === retained.dependencyDigest, "CURRENT_CONTROL_BINDING");
          same(reply.admissionRef, expectedCurrent ? retained.admissionRef : null, "CURRENT_CONTROL_ADMISSION");
          same(reply.activationRef, expectedCurrent ? retained.activationRef : null, "CURRENT_CONTROL_ACTIVATION");
        } });
    const canonicalLease = (state: CommandNegativeSnapshot, lease: ApplicationCapabilityUseLease) => {
      const retained = state.applications.uses.find(item => item.lease.useId === lease.useId);
      if (!retained) failure("X2_S8_NEGATIVE_CANONICAL_LEASE_REQUIRED");
      same(retained.lease, lease, "LEASE_PREIMAGE_SUBSTITUTION");
      return retained;
    };
    const applicationUseCommand = (lease: ApplicationCapabilityUseLease): ApplicationUseCommand => ApplicationUseCommandSchema.parse({
      revisionRef: lease.revisionRef, modelRef: lease.modelRef, checkRef: lease.checkRef,
      originalParentRef: lease.originalParentRef, originalParentDigest: lease.originalParentDigest,
      profile: lease.profile, request: lease.request,
    });
    const acceptedUseIdentity = (state: CommandNegativeSnapshot, lease: ApplicationCapabilityUseLease) => {
      const matches = state.history.filter(item => item.operation === "APPLICATION_SEMANTICS_USE"
        && lease.useId === "application-use:" + digest({ requestId: item.requestId, revisionRef: lease.revisionRef,
          requestBindingDigest: lease.requestBindingDigest }));
      requireThat(matches.length === 1, "EXACT_ACCEPTED_USE_IDENTITY_REQUIRED");
      return matches[0]!.requestId;
    };
    const retainedUseChecks = async (lease: ApplicationCapabilityUseLease, state: CommandNegativeSnapshot) => {
      const retained = canonicalLease(state, lease), original = applicationUseCommand(lease);
      const recheck = ApplicationRecheckCommandSchema.parse({ ...original, useId: lease.useId, leaseDigest: changedHex(digest(lease)) });
      await refuse("wrong-exact-lease", "consumer", "APPLICATION_SEMANTICS_RECHECK", recheck, "S8_APPLICATION_USE_IDENTITY",
        "leaseDigest := flip-first-hex(digest(original canonical lease)); all use/request fields stay original.",
        "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_RECHECK.leaseDigest");
      const requestId = acceptedUseIdentity(state, lease);
      const changedRequest = ApplicationUseCommandSchema.parse({
        ...original, request: { ...original.request, inputDigest: changedHex(original.request.inputDigest) },
      });
      await refuse("accepted-use-body-substitution", "consumer", "APPLICATION_SEMANTICS_USE", changedRequest, "S8_IDEMPOTENCY_SUBSTITUTION",
        "Reuse the exact accepted USE envelope ID with inputDigest := flip-first-hex(original).",
        "CapabilityEvolution.command:prior.requestDigest", 409, requestId);
      await refuse("accepted-use-actor-substitution", "reader", "APPLICATION_SEMANTICS_USE", original, "S8_IDEMPOTENCY_SUBSTITUTION",
        "Reuse the exact accepted USE ID/body with a different existing authenticated actor.",
        "CapabilityEvolution.command:prior.requestDigest", 409, requestId);
      // Real original transition refs only; these cases stop at the binding guard.
      const originals = await readDiscoveryEvidence();
      const reconciliation = ApplicationReconciliationSchema.parse({ useId: lease.useId, revisionRef: lease.revisionRef,
        evidenceRef: originals[0]!.ref, priorEvidenceRef: retained.lastEvidenceRef, outcome: "OBSERVED" });
      await refuse("reconciliation-wrong-role", "evaluator", "APPLICATION_SEMANTICS_RECONCILE", reconciliation, "S8_OPERATION_NOT_AUTHORIZED",
        "Only the authenticated role changes.", "ApplicationCapabilityPort.role", 403);
      for (const [id, patch] of [
        ["reconciliation-revision", { revisionRef: lease.activationRef }],
        ["reconciliation-prior-evidence", { priorEvidenceRef: lease.modelRef }],
        ["reconciliation-evidence-owner", { evidenceRef: lease.modelRef }],
      ] as const) {
        requireThat(id !== "reconciliation-prior-evidence" || digest(lease.modelRef) !== digest(retained.lastEvidenceRef),
          "RECONCILIATION_SUBSTITUTION_MUST_DIFFER");
        await refuse(id, "consumer", "APPLICATION_SEMANTICS_RECONCILE", ApplicationReconciliationSchema.parse({ ...reconciliation, ...patch }),
          "S8_APPLICATION_RECONCILIATION_BINDING", id + " := the indicated existing original model/activation reference.",
          "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_RECONCILE.binding", 403);
      }
      defer("exact-original-reconciliation-evidence",
        "These binding refusals do not replace the separate existing real-parameter/effect/obligation reconciliation mutant.");
    };
    const isolatedSubject = async (value: ApplicationCandidate, state: CommandNegativeSnapshot) => {
      const subject = parseApplicationCandidate(value), retained = revision(state, subject.ref);
      requireThat(!sameX2Ref(subject.ref, candidate.ref), "POSITIVE_REVISION_IS_NOT_DISPOSABLE");
      requireThat(digest({ originalParentRef: subject.originalParent.originalParentRef, scope: subject.scope })
        !== digest({ originalParentRef: candidate.originalParent.originalParentRef, scope: candidate.scope }),
      "DISPOSABLE_DOMAIN_MUST_BE_INDEPENDENT");
      requireThat(subject.tenantId === tenantId && subject.principalId === principalId
        && subject.rightsRef === parent.rightsRevision && !retained.revoked
        && retained.protocolRef && retained.evaluationRef && retained.admissionRef && retained.activationRef
        && retained.domain.active === subject.ref.id, "INDEPENDENT_ACTIVE_SUBJECT_REQUIRED");
      same(subject.sourcePins, sourcePins, "ISOLATED_SUBJECT_SOURCE_CUT");
      const { ref: _ref, ...body } = subject;
      same(await ownerContent(subject.ref), body, "ISOLATED_SUBJECT_OWNER_PREIMAGE");
      same(retained.dependencyDigest, applicationDependencyDigest(subject), "ISOLATED_SUBJECT_DEPENDENCIES");
      requireThat(Date.parse(subject.dependencies.validAfter) <= Date.now()
        && Date.parse(subject.dependencies.validUntil) > Date.now(), "ISOLATED_PARENT_MUST_REMAIN_CURRENT");
      report.subjectRevisionRef = subject.ref;
      return subject;
    };
    const actualActivation = async (state: CommandNegativeSnapshot, ref: ApplicationPortRef) => {
      const activationRef = revision(state, ref).activationRef;
      if (!activationRef) failure("X2_S8_NEGATIVE_ACTIVATION_PREIMAGE_REQUIRED");
      const signedActivation = z.object({
        body: ApplicationActivationSchema, keyId: z.string(), signature: z.string(),
      }).strict().parse(await ownerContent(activationRef));
      assertSignature(signedActivation, lifecyclePolicy.promotionKeys, promoterId);
      same(applicationRef("activate", signedActivation), activationRef, "ACTIVATION_OWNER_IDENTITY");
      return signedActivation.body;
    };
    try {
      assertActive();
      await assertSourceCut();
      assertActive();
      await newPrivateFile(report.inputArtifactPath, canonical(input));
      defer("expired-or-revoked-signing-authority",
        "Frozen signed policy contains only current nonrevoked keys; rewriting it is forbidden.");
      defer("same-principal-evaluator-promoter-at-command",
        "Bootstrap and CapabilityEvolution.open reject that policy before dispatch. Wrong-signer cases are not this deeper guard.");
      defer("correct-role-wrong-proposer-or-consumer-principal",
        "The unchanged policy has only the original native principal in PROPOSER/CONSUMER roles.");
      const initial = await snapshot(), positive = revision(initial, candidate.ref);
      same(positive.modelRef, model.ref, "POSITIVE_MODEL_CHANGED");
      same(positive.checkRef, check.ref, "POSITIVE_CHECK_CHANGED");
      same(positive.originalParentRef, parent.originalParentRef, "POSITIVE_PARENT_CHANGED");
      same(positive.dependencyDigest, dependencyDigest, "POSITIVE_DEPENDENCIES_CHANGED");
      if (input.phase === "candidate") {
        await refuse("candidate-wrong-role", "evaluator", "APPLICATION_SEMANTICS_PROPOSE", parseApplicationCandidate(candidate),
          "S8_OPERATION_NOT_AUTHORIZED", "Only the authenticated role changes.", "ApplicationCapabilityPort.role", 403);
        const mutatedCandidate = (edit: (body: z.infer<typeof ApplicationCandidateBodySchema>) => void) => {
          const { ref: _ref, ...body } = structuredClone(candidate);
          edit(body);
          const parsed = ApplicationCandidateBodySchema.parse(body);
          return parseApplicationCandidate({ ...parsed, ref: applicationRef("candidate", parsed) });
        };
        for (const key of ["tenantId", "principalId"] as const) {
          const mutant = mutatedCandidate(body => {
            const value = changedText(body[key]); body[key] = value; body.scope[key] = value;
            for (const profile of body.profiles) profile[key] = value;
          });
          await refuse("candidate-" + key, "proposer", "APPLICATION_SEMANTICS_PROPOSE", mutant, "S8_TENANT_OR_OWNER_MISMATCH",
            key + ", scope." + key + " and every profile." + key + " := changedText(original); recompute candidate ref.",
            "ApplicationCapabilityPort.scope", 403);
        }
        await refuse("candidate-source-cut", "proposer", "APPLICATION_SEMANTICS_PROPOSE", mutatedCandidate(body => {
          body.sourcePins[0]!.sha256 = changedHex(body.sourcePins[0]!.sha256);
        }), "S8_APPLICATION_SOURCE_CLOSURE_SUBSTITUTION", "sourcePins[0].sha256 := flip-first-hex(original); recompute candidate ref.",
        "ApplicationCapabilityPort.sources");
        await refuse("candidate-dependency-cut", "proposer", "APPLICATION_SEMANTICS_PROPOSE", mutatedCandidate(body => {
          body.dependencies.runtimeDigest = changedHex(body.dependencies.runtimeDigest);
        }), "S8_APPLICATION_NATIVE_MODEL_SUBSTITUTION", "dependencies.runtimeDigest := flip-first-hex(original); parent/source pins stay original.",
        "ApplicationCapabilityPort.model");
        await refuse("candidate-domain", "proposer", "APPLICATION_SEMANTICS_PROPOSE", mutatedCandidate(body => {
          const account = changedText(body.scope.account); body.scope.account = account;
          for (const profile of body.profiles) profile.account = account;
        }), "S8_APPLICATION_NATIVE_MODEL_SUBSTITUTION", "scope.account and all profile accounts := changedText(original); recompute candidate ref.",
        "ApplicationCapabilityPort.model");
        await refuse("candidate-supported-domain", "proposer", "APPLICATION_SEMANTICS_PROPOSE", mutatedCandidate(body => {
          body.dependencies.supportedDomain.substrates = [body.dependencies.supportedDomain.substrates.includes("API") ? "UI" : "API"];
        }), "S8_APPLICATION_NATIVE_MODEL_SUBSTITUTION", "dependencies.supportedDomain.substrates := a different valid nonempty substrate list.",
        "ApplicationCapabilityPort.model");
      } else if (input.phase === "register") {
        const body = ApplicationProtocolSchema.parse(input.body);
        requireThat(!positive.protocolRef && !positive.evaluationRef && !positive.admissionRef && !positive.activationRef,
          "REGISTER_MUST_PRECEDE_POSITIVE_REGISTRATION");
        requireThat(initial.applications.counts.consumedCases === 0, "ORIGINAL_PROTOCOL_CASES_MUST_BE_UNCONSUMED");
        await readDiscoveryEvidence();
        requireThat(body.tenantId === tenantId && body.principalId === principalId && body.evaluatorId === evaluatorId
          && sameX2Ref(body.revisionRef, candidate.ref) && body.dependencyDigest === dependencyDigest
          && digest(body.originalEvidenceRefs) === digest(check.originalEvidenceRefs)
          && new Set(body.caseCommitments).size === body.caseCommitments.length
          && Date.parse(body.registeredAt) >= Date.parse(candidate.proposedAt) && Date.parse(body.registeredAt) <= Date.now(),
        "ORIGINAL_INDEPENDENT_PROTOCOL_REQUIRED");
        await signedRoleChecks("APPLICATION_SEMANTICS_REGISTER", ApplicationProtocolSchema, body);
        for (const key of ["tenantId", "principalId"] as const) await signedRefusal("protocol-" + key,
          "APPLICATION_SEMANTICS_REGISTER", ApplicationProtocolSchema, { ...body, [key]: changedText(body[key]) },
          "S8_TENANT_OR_OWNER_MISMATCH", key + " := changedText(original).", 403);
        for (const [id, patch, mutation] of [
          ["protocol-evaluator", { evaluatorId: promoterId }, "evaluatorId := the distinct configured promoter."],
          ["protocol-dependency", { dependencyDigest: changedHex(body.dependencyDigest) }, "dependencyDigest := flip-first-hex(original)."],
          ["protocol-evidence", { originalEvidenceRefs: [model.ref] }, "originalEvidenceRefs := [the real original model ref]."],
          ["protocol-duplicate-cases", { caseCommitments: [body.caseCommitments[0]!, body.caseCommitments[0]!] }, "caseCommitments := [original[0], original[0]]."],
          ["protocol-before-candidate", { registeredAt: new Date(Date.parse(candidate.proposedAt) - 1).toISOString() }, "registeredAt := original candidate proposedAt minus 1ms."],
        ] as const) await signedRefusal(id, "APPLICATION_SEMANTICS_REGISTER", ApplicationProtocolSchema, { ...body, ...patch },
          "S8_APPLICATION_PROTOCOL_INVALID", mutation);
      } else if (input.phase === "evaluate") {
        const body = ApplicationEvaluationSchema.parse(input.body);
        requireThat(protocol && positive.protocolRef && !positive.evaluationRef && !positive.admissionRef && !positive.activationRef,
          "EVALUATE_REQUIRES_ONLY_ORIGINAL_REGISTRATION");
        if (!protocol) failure("X2_S8_NEGATIVE_ORIGINAL_PROTOCOL_REQUIRED");
        await readDiscoveryEvidence();
        requireThat(body.tenantId === tenantId && body.principalId === principalId && body.evaluatorId === evaluatorId
          && sameX2Ref(body.revisionRef, candidate.ref) && sameX2Ref(body.protocolRef, protocol.ref)
          && digest(positive.protocolRef) === digest(protocol.ref) && body.dependencyDigest === dependencyDigest
          && digest(body.originalEvidenceRefs) === digest(protocol.signed.body.originalEvidenceRefs)
          && digest(body.caseCommitments) === digest(protocol.signed.body.caseCommitments)
          && sameX2Ref(body.oracleRef, protocol.signed.body.oracleRef)
          && Date.parse(body.completedAt) >= Date.parse(protocol.signed.body.registeredAt) && Date.parse(body.completedAt) <= Date.now(),
        "ORIGINAL_INDEPENDENT_EVALUATION_REQUIRED");
        await signedRoleChecks("APPLICATION_SEMANTICS_EVALUATE", ApplicationEvaluationSchema, body);
        for (const key of ["tenantId", "principalId"] as const) await signedRefusal("evaluation-" + key,
          "APPLICATION_SEMANTICS_EVALUATE", ApplicationEvaluationSchema, { ...body, [key]: changedText(body[key]) },
          "S8_TENANT_OR_OWNER_MISMATCH", key + " := changedText(original).", 403);
        for (const [id, patch, mutation] of [
          ["evaluation-evaluator", { evaluatorId: promoterId }, "evaluatorId := the distinct configured promoter."],
          ["evaluation-protocol", { protocolRef: candidate.ref }, "protocolRef := the real original candidate ref."],
          ["evaluation-dependency", { dependencyDigest: changedHex(body.dependencyDigest) }, "dependencyDigest := flip-first-hex(original)."],
          ["evaluation-original-evidence", { originalEvidenceRefs: [model.ref] }, "originalEvidenceRefs := [the real original model ref]."],
          ["evaluation-oracle", { oracleRef: model.ref }, "oracleRef := the real original model ref."],
          ["evaluation-cases", { caseCommitments: body.caseCommitments.map((value, index) => index ? value : changedHex(value)) }, "caseCommitments[0] := flip-first-hex(original)."],
          ["evaluation-before-registration", { completedAt: new Date(Date.parse(protocol.signed.body.registeredAt) - 1).toISOString() }, "completedAt := original registeredAt minus 1ms."],
        ] as const) await signedRefusal(id, "APPLICATION_SEMANTICS_EVALUATE", ApplicationEvaluationSchema, { ...body, ...patch },
          "S8_APPLICATION_EVALUATION_BINDING", mutation);
      } else if (input.phase === "admit") {
        const body = ApplicationAdmissionSchema.parse(input.body);
        requireThat(positive.evaluationRef && !positive.admissionRef && !positive.activationRef, "ADMIT_MUST_PRECEDE_POSITIVE_ADMISSION");
        if (!positive.evaluationRef) failure("X2_S8_NEGATIVE_REAL_EVALUATION_REQUIRED");
        const evaluated = z.object({ body: ApplicationEvaluationSchema, keyId: z.string(), signature: z.string() })
          .strict().parse(await ownerContent(positive.evaluationRef));
        assertSignature(evaluated, lifecyclePolicy.evaluatorKeys, evaluatorId);
        requireThat(evaluated.body.disposition === "SUPPORTED_DEVELOPMENT" && !evaluated.body.falseValid
          && !evaluated.body.falseInvalid && !evaluated.body.authorityViolations && !evaluated.body.duplicateEffects
          && !evaluated.body.falseCompletions && sameX2Ref(body.revisionRef, candidate.ref)
          && sameX2Ref(body.evaluationRef, positive.evaluationRef) && body.dependencyDigest === dependencyDigest,
        "INDEPENDENT_SUPPORTED_ADMISSION_CONTROL_REQUIRED");
        await signedRoleChecks("APPLICATION_SEMANTICS_ADMIT", ApplicationAdmissionSchema, body);
        await signedRefusal("admission-evaluation", "APPLICATION_SEMANTICS_ADMIT", ApplicationAdmissionSchema,
          { ...body, evaluationRef: candidate.ref }, "S8_APPLICATION_ADMISSION_BINDING", "evaluationRef := the real original candidate ref.");
        await signedRefusal("admission-dependency", "APPLICATION_SEMANTICS_ADMIT", ApplicationAdmissionSchema,
          { ...body, dependencyDigest: changedHex(body.dependencyDigest) }, "S8_APPLICATION_ADMISSION_BINDING", "dependencyDigest := flip-first-hex(original).");
        defer("admission-negative-evaluation-counters",
          "Cannot rewrite the independently retained supported evaluation or recycle its one-use cases for a different result.");
      } else if (input.phase === "activate") {
        const body = ApplicationActivationSchema.parse(input.body);
        const predecessor = positive.domain.active
          ? initial.applications.revisions.find(item => item.ref.id === positive.domain.active)?.ref : null;
        requireThat(positive.admissionRef && !positive.activationRef && predecessor !== undefined
          && sameX2Ref(body.revisionRef, candidate.ref) && sameX2Ref(body.admissionRef, positive.admissionRef)
          && body.dependencyDigest === dependencyDigest && body.expectedGeneration === positive.domain.generation
          && digest(body.predecessorRef) === digest(predecessor) && Date.parse(body.validUntil) > Date.now()
          && Date.parse(body.validUntil) <= Date.parse(candidate.dependencies.validUntil)
          && body.maxCost <= limits.maxTotalCost && body.maxUses <= limits.maxTotalUses,
        "ACTIVATE_MUST_PRECEDE_VALID_POSITIVE_ACTIVATION");
        await signedRoleChecks("APPLICATION_SEMANTICS_ACTIVATE", ApplicationActivationSchema, body);
        for (const [id, patch, mutation] of [
          ["activation-admission", { admissionRef: candidate.ref }, "admissionRef := the real original candidate ref."],
          ["activation-dependency", { dependencyDigest: changedHex(body.dependencyDigest) }, "dependencyDigest := flip-first-hex(original)."],
          ["activation-generation", { expectedGeneration: body.expectedGeneration + 1 }, "expectedGeneration := original plus 1."],
          ["activation-predecessor", { predecessorRef: body.predecessorRef ? null : candidate.ref }, "predecessorRef := a different real predecessor/null binding."],
          ["activation-expired", { validUntil: candidate.dependencies.validAfter }, "validUntil := the original already-started validAfter (not an expired active-domain claim)."],
          ["activation-deadline-extension", { validUntil: new Date(Date.parse(candidate.dependencies.validUntil) + 1).toISOString() }, "validUntil := original dependency deadline plus 1ms; no actual grant/deadline is changed."],
        ] as const) await signedRefusal(id, "APPLICATION_SEMANTICS_ACTIVATE", ApplicationActivationSchema, { ...body, ...patch },
          "S8_APPLICATION_ACTIVATION_BINDING", mutation);
        if (limits.maxTotalUses < 100000) await signedRefusal("activation-policy-uses", "APPLICATION_SEMANTICS_ACTIVATE", ApplicationActivationSchema,
          { ...body, maxUses: limits.maxTotalUses + 1 }, "S8_APPLICATION_ACTIVATION_BINDING", "maxUses := signed policy maximum plus 1, within the command schema.");
        else defer("activation-policy-use-ceiling", "Signed policy already equals the schema maximum; a larger command would only test parsing.");
        if (limits.maxTotalCost < 100) await signedRefusal("activation-policy-cost", "APPLICATION_SEMANTICS_ACTIVATE", ApplicationActivationSchema,
          { ...body, maxCost: (limits.maxTotalCost + 100) / 2 }, "S8_APPLICATION_ACTIVATION_BINDING", "maxCost := midpoint(signed policy maximum, schema maximum 100).");
        else defer("activation-policy-cost-ceiling", "Signed policy equals the schema maximum 100; a larger command would only test parsing.");
      } else if (input.phase === "retained-use") {
        const lease = ApplicationUseLeaseSchema.parse(input.lease);
        requireThat(sameX2Ref(lease.revisionRef, candidate.ref), "ORIGINAL_RETAINED_LEASE_REQUIRED");
        await retainedUseChecks(lease, initial);
        defer("live-currentness-and-request-binding", "This retained-use phase deliberately does not credit a stale/reconciled lease as a live-currentness control.");
      } else if (input.phase === "disposable-revocation") {
        await currentControl(candidate.ref, true, "positive-current-before-disposable");
        const originalProtocol = ApplicationProtocolSchema.parse(input.protocol);
        requireThat(protocol && digest(originalProtocol) === digest(protocol.signed.body), "ORIGINAL_REGISTERED_PROTOCOL_REQUIRED");
        const { ref: _ref, ...body } = structuredClone(candidate);
        body.parents = [candidate.ref];
        const sibling = parseApplicationCandidate({ ...body, ref: applicationRef("candidate", body) });
        report.subjectRevisionRef = sibling.ref;
        requireThat(!initial.applications.revisions.some(item => sameX2Ref(item.ref, sibling.ref)), "NEW_DISPOSABLE_SIBLING_REQUIRED");
        await observe({ id: "propose-unactivated-sibling", role: "proposer", operation: "APPLICATION_SEMANTICS_PROPOSE", body: sibling,
          mutation: "parents := [original positive revision]; model/evidence/grants/deadline/source cut unchanged.",
          boundary: "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_PROPOSE", expected: { status: 200, code: null },
          async accepted(reply, before, after) {
            await assertCommit(reply, sibling.ref, body); assertAppend(before, after);
            requireThat(after.applications.counts.revisions === before.applications.counts.revisions + 1, "SIBLING_NOT_RETAINED_ONCE");
            const retained = revision(after, sibling.ref);
            requireThat(!retained.revoked && !retained.protocolRef && !retained.activationRef, "SIBLING_MUST_REMAIN_UNACTIVATED");
          } });
        const state = await snapshot(), siblingState = revision(state, sibling.ref);
        const revocation = ApplicationRevocationSchema.parse({
          schema: "finnor.s8.application-revocation.v1", revisionRef: sibling.ref,
          expectedGeneration: siblingState.domain.generation, expectedActivationRef: null,
          reason: "X2 disposable unactivated sibling negative control", evidenceRefs: [candidate.ref], ...NATIVE_S8_FIXTURE_FLAGS,
        });
        await signedRoleChecks("APPLICATION_SEMANTICS_REVOKE", ApplicationRevocationSchema, revocation);
        await signedRefusal("revocation-generation", "APPLICATION_SEMANTICS_REVOKE", ApplicationRevocationSchema,
          { ...revocation, expectedGeneration: revocation.expectedGeneration + 1 }, "S8_APPLICATION_REVOCATION_BINDING", "expectedGeneration := actual sibling domain generation plus 1.");
        await signedRefusal("revocation-activation", "APPLICATION_SEMANTICS_REVOKE", ApplicationRevocationSchema,
          { ...revocation, expectedActivationRef: positive.activationRef }, "S8_APPLICATION_REVOCATION_BINDING", "expectedActivationRef := the distinct positive fixture activation (sibling has none).");
        const signedRevocation = signAs("promoter", revocation);
        await observe({ id: "revoke-only-unactivated-sibling", role: "promoter", operation: "APPLICATION_SEMANTICS_REVOKE", body: signedRevocation,
          mutation: "Correct generation/null activation; revoke only the unactivated disposable sibling.",
          boundary: "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_REVOKE", expected: { status: 200, code: null },
          async accepted(reply, before, after) {
            const parsed = revocationReplySchema.parse(reply);
            await assertCommit(reply, applicationRef("revoke", signedRevocation), signedRevocation); assertAppend(before, after);
            requireThat(revision(after, sibling.ref).revoked && parsed.generation === siblingState.domain.generation
              && parsed.unresolvedUsesPreserved === before.applications.uses.filter(item => !item.reconciled).length,
            "DISPOSABLE_REVOCATION_RETENTION");
            same(before.applications.uses, after.applications.uses, "REVOCATION_CHANGED_RETAINED_USES");
          } });
        await signedRefusal("register-revoked-sibling", "APPLICATION_SEMANTICS_REGISTER", ApplicationProtocolSchema,
          { ...originalProtocol, revisionRef: sibling.ref }, "S8_APPLICATION_REVOKED",
          "Use the genuine original protocol signature authority, changing only revisionRef to the revoked sibling.", 403);
        await signedRefusal("revoke-revoked-sibling", "APPLICATION_SEMANTICS_REVOKE", ApplicationRevocationSchema,
          revocation, "S8_APPLICATION_REVOKED", "Fresh envelope ID for the same genuine signed revocation after its retained revocation.", 403);
        await currentControl(sibling.ref, false, "revoked-sibling-not-current");
        await currentControl(candidate.ref, true, "positive-current-after-disposable");
        defer("revoked-live-use-and-exact-replay",
          "This sibling has no independent evaluation/activation/lease. Use isolated-live-use with a genuine different-domain subject; do not credit this as live replay.");
      } else {
        // Live and expiry paths accept only canonical native inputs/leases. No
        // currentness, allocation, business request or evaluation is authored here.
        let subject = candidate;
        if (input.phase === "isolated-live-use" || input.phase === "isolated-expired-activation") {
          await currentControl(candidate.ref, true, "positive-current-before-isolated");
          subject = await isolatedSubject(input.candidate, initial);
        } else requireThat(input.phase === "live-use", "UNKNOWN_PHASE");
        if (input.phase !== "live-use" && input.phase !== "isolated-live-use" && input.phase !== "isolated-expired-activation") {
          failure("X2_S8_NEGATIVE_UNKNOWN_PHASE");
        }
        const command = ApplicationUseCommandSchema.parse(input.command);
        requireThat(sameX2Ref(command.revisionRef, subject.ref), "USE_SUBJECT_BINDING");
        if (input.phase === "isolated-expired-activation") {
          const activation = await actualActivation(initial, subject.ref);
          requireThat(Date.parse(activation.validUntil) <= Date.now(), "GENUINELY_EXPIRED_ACTIVATION_REQUIRED");
          requireThat(initial.applications.uses.some(item => sameX2Ref(item.lease.revisionRef, subject.ref)
            && digest(applicationUseCommand(item.lease)) === digest(command)), "EXPIRED_SUBJECT_ORIGINAL_RETAINED_COMMAND_REQUIRED");
          await currentControl(subject.ref, false, "expired-isolated-not-current");
          await refuse("expired-isolated-use", "consumer", "APPLICATION_SEMANTICS_USE", command, "S8_APPLICATION_NOT_ACTIVE",
            "New envelope ID, original shaped request; the separate retained activation is already expired.",
            "ApplicationCapabilityPort.activeDomain:activation.validUntil", 403);
          await currentControl(candidate.ref, true, "positive-current-after-expired");
        } else {
          const lease = ApplicationUseLeaseSchema.parse(input.lease), retained = canonicalLease(initial, lease);
          requireThat(sameX2Ref(lease.revisionRef, subject.ref) && !retained.reconciled
            && !retained.possibleEffectRefs.length && Date.parse(lease.expiresAt) > Date.now()
            && applicationRequestBindingDigest(command.request) === lease.requestBindingDigest,
          "UNRECONCILED_CURRENT_CANONICAL_LEASE_REQUIRED");
          await currentControl(subject.ref, true, "live-subject-current");
          const recheck = ApplicationRecheckCommandSchema.parse({ ...command, useId: lease.useId, leaseDigest: digest(lease) });
          const control = await observe({ id: "original-live-recheck", role: "consumer", operation: "APPLICATION_SEMANTICS_RECHECK", body: recheck,
            mutation: "None; original independently owner-published currentness and canonical lease.",
            boundary: "ApplicationCapabilityPort.currentUse/currentness", expected: { status: 200, code: null },
            async accepted(reply, before, after) {
              const parsed = commitSchema.extend({ recheck: ApplicationRecheckBodySchema }).strict().parse(reply);
              await assertCommit(parsed, applicationRef("recheck", parsed.recheck), parsed.recheck);
              assertAppend(before, after, lease.useId); same(parsed.recheck.lease, lease, "RECHECK_CONTROL_LEASE_SUBSTITUTION");
              same(before.applications.revisions, after.applications.revisions, "RECHECK_CHANGED_REVISIONS");
              const priorUse = canonicalLease(before, lease), nextUse = canonicalLease(after, lease);
              same(priorUse.lease, nextUse.lease, "RECHECK_CHANGED_LEASE");
              same({ reconciled: priorUse.reconciled, lastEvidenceRef: priorUse.lastEvidenceRef, possibleEffectRefs: priorUse.possibleEffectRefs },
                { reconciled: nextUse.reconciled, lastEvidenceRef: nextUse.lastEvidenceRef, possibleEffectRefs: nextUse.possibleEffectRefs },
                "RECHECK_CHANGED_RECONCILIATION_OR_EFFECTS");
              same(nextUse.evidenceRefs, union(priorUse.evidenceRefs, parsed.recheck.evidenceRefs), "RECHECK_DROPPED_OR_SUBSTITUTED_EVIDENCE");
              same(nextUse.liabilityRefs, union(priorUse.liabilityRefs, parsed.recheck.liabilityRefs), "RECHECK_DROPPED_OR_SUBSTITUTED_LIABILITIES");
              same(before.applications.uses.filter(item => item.lease.useId !== lease.useId),
                after.applications.uses.filter(item => item.lease.useId !== lease.useId), "RECHECK_CHANGED_OTHER_USES");
              requireThat(before.applications.counts.uses === after.applications.counts.uses, "RECHECK_ALLOCATED_ANOTHER_USE");
            } });
          const current = ApplicationCurrentnessBodySchema.parse(await ownerContent(command.request.currentnessRef));
          const requireLiveControl = () => requireThat(Date.now() < Date.parse(current.expiresAt)
            && Date.now() < Date.parse(lease.expiresAt), "POSITIVE_CURRENTNESS_WINDOW_EXPIRED");
          await retainedUseChecks(lease, control.after);
          for (const operation of ["APPLICATION_SEMANTICS_CURRENT", "APPLICATION_SEMANTICS_USE", "APPLICATION_SEMANTICS_RECHECK"] as const) {
            await refuse("consumer-wrong-role-" + operation.toLowerCase(), "evaluator", operation,
              operation === "APPLICATION_SEMANTICS_CURRENT" ? { revisionRef: subject.ref } : operation === "APPLICATION_SEMANTICS_USE" ? command : recheck,
              "S8_OPERATION_NOT_AUTHORIZED", "Only the authenticated existing role changes.", "ApplicationCapabilityPort.role", 403);
          }
          const applicationUseRefusal = async (id: string, patch: Record<string, unknown>, code: string, mutation: string) => {
            requireLiveControl();
            await refuse(id, "consumer", "APPLICATION_SEMANTICS_USE", ApplicationUseCommandSchema.parse({ ...command, ...patch }),
              code, mutation, "ApplicationCapabilityPort.currentness", 403);
            requireLiveControl(); // An expired original stamp cannot explain a passing substitution.
          };
          for (const [id, patch, mutation] of [
            ["use-model", { modelRef: subject.checkRef }, "modelRef := the real original check ref."],
            ["use-check", { checkRef: subject.modelRef }, "checkRef := the real original model ref."],
            ["use-parent", { originalParentRef: subject.modelRef }, "originalParentRef := the real original model ref."],
            ["use-parent-digest", { originalParentDigest: changedHex(command.originalParentDigest) }, "originalParentDigest := flip-first-hex(original)."],
            ["use-profile-role", { profile: { ...command.profile, role: changedText(command.profile.role) } }, "profile.role := changedText(original), without changing grants."],
          ] as const) await applicationUseRefusal(id, patch, "S8_APPLICATION_USE_BINDING", mutation);
          for (const [id, patch, code, mutation] of [
            ["use-domain", { target: { ...command.request.target, account: changedText(command.request.target.account) } }, "S8_APPLICATION_USE_BINDING", "request.target.account := changedText(original)."],
            ["use-duplicate-operations", { operationIds: [command.request.operationIds[0]!, command.request.operationIds[0]!] }, "S8_APPLICATION_USE_BINDING", "operationIds := [original[0], original[0]]."],
            ["use-allocation-owner", { allocationRef: subject.modelRef }, "S8_APPLICATION_USE_BINDING", "allocationRef := real original S4 model ref, not an S5 allocation."],
            ["use-reservation", { reservationRef: command.request.allocationRef }, "S8_APPLICATION_USE_BINDING", "reservationRef := the distinct real S5 allocation ref."],
            ["use-expired-request", { deadlineAt: subject.dependencies.validAfter }, "S8_APPLICATION_USE_BINDING", "request.deadlineAt := the original already-started validAfter."],
            ["use-currentness-owner", { currentnessRef: subject.ref }, "S8_APPLICATION_USE_BINDING", "currentnessRef := the real S8 revision, not S4 currentness."],
            ["use-resource-envelope", { resourceEnvelopeDigest: changedHex(command.request.resourceEnvelopeDigest) }, "S8_APPLICATION_ORIGINAL_RESOURCE_BINDING", "resourceEnvelopeDigest := flip-first-hex(original); genuine S5 preimages unchanged."],
            ["use-currentness-input", { inputDigest: changedHex(command.request.inputDigest) }, "S8_APPLICATION_CURRENTNESS_INVALID", "inputDigest := flip-first-hex(original); original real currentness unchanged."],
            ["use-currentness-revision", { applicationRevision: changedText(command.request.applicationRevision) }, "S8_APPLICATION_CURRENTNESS_INVALID", "request.applicationRevision := changedText(original); original real currentness unchanged."],
          ] as const) await applicationUseRefusal(id, { request: { ...command.request, ...patch } }, code, mutation);
          requireLiveControl();
          await refuse("recheck-request-mismatch", "consumer", "APPLICATION_SEMANTICS_RECHECK", ApplicationRecheckCommandSchema.parse({
            ...recheck, request: { ...command.request, inputDigest: changedHex(command.request.inputDigest) },
          }), "S8_APPLICATION_USE_STALE_OR_RECONCILED", "Correct exact lease digest; inputDigest := flip-first-hex(original).",
          "ApplicationCapabilityPort.currentUse:requestBindingDigest", 403);
          requireLiveControl();
          if (input.alternateCurrentnessRef) {
            const alternateRef = X2RefSchema.parse(input.alternateCurrentnessRef);
            requireThat(alternateRef.owner === "S4" && !sameX2Ref(alternateRef, command.request.currentnessRef), "DIFFERENT_REAL_S4_CURRENTNESS_REQUIRED");
            const alternate = ApplicationCurrentnessBodySchema.parse(await ownerContent(alternateRef));
            same(x2Ref("S4", "application-s8-currentness", alternate), alternateRef, "ALTERNATE_CURRENTNESS_OWNER_IDENTITY");
            requireThat(Date.parse(alternate.checkedAt) <= Date.now() && Date.parse(alternate.expiresAt) > Date.now(),
              "ALTERNATE_CURRENTNESS_MUST_NOT_ALREADY_BE_STALE");
            requireThat(alternate.requestBindingDigest !== applicationRequestBindingDigest(command.request)
              || alternate.dependencyDigest !== applicationDependencyDigest(subject)
              || alternate.profileBindingDigest !== digest(command.profile), "INCOMPATIBLE_GENUINE_CURRENTNESS_REQUIRED");
            await applicationUseRefusal("use-other-real-currentness", { request: { ...command.request, currentnessRef: alternateRef } },
              "S8_APPLICATION_CURRENTNESS_INVALID", "currentnessRef := caller-supplied, owner-read-back genuine S4 currentness with an incompatible request/dependency/profile binding.");
            requireThat(Date.parse(alternate.expiresAt) > Date.now(), "ALTERNATE_CURRENTNESS_EXPIRED_DURING_GUARD");
          } else defer("different-genuine-currentness-preimage", "No alternative independently retained S4 currentness ref supplied; a fabricated or model preimage is not substituted.");
          if (input.phase === "isolated-live-use") {
            const now = await snapshot(), activation = await actualActivation(now, subject.ref);
            const uses = now.applications.uses.filter(item => sameX2Ref(item.lease.revisionRef, subject.ref));
            const triggers = {
              policyUses: now.accounting.useCount >= limits.maxTotalUses, activationUses: uses.length >= activation.maxUses,
              policyCost: now.accounting.totalCost + command.request.reservedCost > limits.maxTotalCost,
              activationCost: uses.reduce((sum, use) => sum + use.lease.reservedCost, 0) + command.request.reservedCost > activation.maxCost,
            };
            if (Object.values(triggers).some(Boolean)) {
              requireLiveControl();
              await refuse("isolated-cumulative-resource", "consumer", "APPLICATION_SEMANTICS_USE", command, "S8_APPLICATION_CUMULATIVE_RESOURCE_BOUND",
                "New envelope ID with unchanged genuine request/currentness; already-exhausted real bounds: " + canonical(triggers),
                "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_USE.cumulative", 429);
              requireLiveControl();
            } else defer("cumulative-use-and-cost-bounds",
              "Separate real subject is not at an actual bound. No extra leases, invented resource stamps or changed reservedCost are issued to exhaust it.");
            const beforeRevoke = await snapshot(), disposableState = revision(beforeRevoke, subject.ref);
            const revocation = ApplicationRevocationSchema.parse({
              schema: "finnor.s8.application-revocation.v1", revisionRef: subject.ref,
              expectedGeneration: disposableState.domain.generation, expectedActivationRef: disposableState.activationRef,
              reason: "X2 isolated live-lease replay negative", evidenceRefs: [lease.currentnessRef], ...NATIVE_S8_FIXTURE_FLAGS,
            }), signedRevocation = signAs("promoter", revocation);
            requireLiveControl();
            await observe({ id: "revoke-only-isolated-live-subject", role: "promoter", operation: "APPLICATION_SEMANTICS_REVOKE", body: signedRevocation,
              mutation: "Revoke only the separately qualified, different-domain disposable revision with its exact generation/activation.",
              boundary: "ApplicationCapabilityPort.command:APPLICATION_SEMANTICS_REVOKE", expected: { status: 200, code: null },
              async accepted(reply, before, after) {
                const parsed = revocationReplySchema.parse(reply);
                await assertCommit(reply, applicationRef("revoke", signedRevocation), signedRevocation); assertAppend(before, after);
                requireThat(revision(after, subject.ref).revoked && parsed.generation === disposableState.domain.generation + 1
                  && parsed.unresolvedUsesPreserved === before.applications.uses.filter(item => !item.reconciled).length,
                "ISOLATED_REVOCATION_RETENTION");
                same(before.applications.uses, after.applications.uses, "REVOCATION_CHANGED_USES_OR_LIABILITIES");
              } });
            await currentControl(subject.ref, false, "revoked-isolated-not-current");
            for (const [id, operation, body, requestId] of [
              ["revoked-isolated-new-use", "APPLICATION_SEMANTICS_USE", command, undefined],
              ["revoked-isolated-new-recheck", "APPLICATION_SEMANTICS_RECHECK", recheck, undefined],
              ["revoked-isolated-exact-use-replay", "APPLICATION_SEMANTICS_USE", applicationUseCommand(lease), acceptedUseIdentity(initial, lease)],
              ["revoked-isolated-exact-recheck-replay", "APPLICATION_SEMANTICS_RECHECK", recheck, control.requestId],
            ] as const) {
              requireThat(Date.parse(lease.expiresAt) > Date.now(), "REVOKED_REPLAY_LEASE_EXPIRED_BEFORE_GUARD");
              await refuse(id, "consumer", operation, body, "S8_APPLICATION_UNADMITTED_REVOKED_OR_EXPIRED",
                requestId ? "Exact previously accepted actor/envelope/body replay after ONLY the isolated revision was revoked."
                  : "Fresh envelope with the genuine request/lease after ONLY the isolated revision was revoked.",
                "ApplicationCapabilityPort.admitted:state.revoked", 403, requestId);
              requireThat(Date.parse(lease.expiresAt) > Date.now(), "REVOKED_REPLAY_LEASE_EXPIRED_DURING_GUARD");
            }
            await currentControl(candidate.ref, true, "positive-current-after-isolated-revocation");
          } else {
            defer("revoked-live-use-and-exact-replay", "The original positive revision is never revoked; supply a genuine different-domain subject to isolated-live-use.");
            defer("cumulative-use-and-cost-bounds", "The positive revision is never exhausted; only an already-bounded isolated live subject can test this guard.");
          }
        }
      }
      if (input.phase !== "isolated-expired-activation") defer("expired-activated-domain",
        "No shared deadline is shortened or awaited. isolated-expired-activation requires a genuine already-expired different-domain activation.");
      if (input.phase !== "live-use" && input.phase !== "isolated-live-use") defer("live-currentness-and-cumulative-command-boundaries",
        "This phase does not acquire or fabricate a live native request; use the explicit live/isolated stages with their real prerequisites.");
      await assertSourceCut();
      assertActive();
      report.verdict = "PASS";
    } catch (error) {
      report.failureCode = error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
        ? error.message : "X2_S8_NEGATIVE_VALIDATION_FAILED";
    } finally {
      if (signal?.aborted) {
        report.failureCode = "X2_S8_NEGATIVE_EXECUTION_ABORTED";
        report.verdict = "FAIL";
      }
      report.finishedAt = new Date().toISOString();
      try {
        await newPrivateFile(report.artifactPath, canonical(report));
        await appendPrivate(paths.commands, { at: report.finishedAt, operation: "X2_S8_COMMAND_NEGATIVE_REPORT",
          artifactPath: report.artifactPath, digest: digest(report), verdict: report.verdict, phase: report.phase });
      } finally { negativeSuiteRunning = false; }
    }
    if (report.failureCode) failure(report.failureCode);
    assertActive();
    return structuredClone(report);
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
      originalDeadline: validUntil, sourcePins, lifecyclePins, ledgerPins, runtime: applicationRuntimeIdentity(),
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
      assertSourceCut, publishNativeRefs, drainNativeRefs, readDiscoveryEvidence, commandAs, checkApplicationCommandNegatives,
      async propose(requestId) {
        await publishNativeRefs([
          model.ref, check.ref, parent.originalParentRef, parent.tenantRef, parent.workRef,
          parent.authorityGrantRef, parent.resourceGrantRef, parent.baselineManifestRef,
          parent.producerRef, parent.grammarRef, parent.checkerRef, parent.runtimeRef,
          session.allocation_ref, session.reservation_ref, session.root_consumption_ref,
          ...originalBindings.map((profile) => profile.grantRef),
        ]);
        const reply = commitSchema.parse(successful(await commandAs("proposer", "APPLICATION_SEMANTICS_PROPOSE", candidate, requestId)));
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
        const result = await lifecycleCommit("APPLICATION_SEMANTICS_REGISTER", body, requestId);
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
        const result = await lifecycleCommit("APPLICATION_SEMANTICS_EVALUATE", body, requestId);
        return { signed: result.signed, commitment: result.commitment };
      },
      async admit(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_SEMANTICS_ADMIT", ApplicationAdmissionSchema.parse(value), requestId);
        return { signed: result.signed, commitment: result.commitment };
      },
      async activate(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_SEMANTICS_ACTIVATE", ApplicationActivationSchema.parse(value), requestId);
        return { signed: result.signed, commitment: result.commitment,
          generation: activationReplySchema.parse(result.raw).generation };
      },
      async revoke(value, requestId) {
        const result = await lifecycleCommit("APPLICATION_SEMANTICS_REVOKE", ApplicationRevocationSchema.parse(value), requestId);
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
        environment.FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_CONFIG = path;
        environment.FINNOR_S8_APPLICATION_SEMANTICS_CONSUMER_ROOT = publicPem(keys.consumerRoot);
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
