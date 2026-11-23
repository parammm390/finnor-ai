/** Fixed original-only E2E calls to EXTERNAL, separately enrolled OS/SQL roles. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { z } from "zod";
import { digest } from "../../packages/capability-evolution/src/contracts";
import { canonicalDeploymentQualificationSchema,
  type CanonicalSpecialistAuthority } from "../../packages/capability-evolution/src/specialist-publication-authority";
import { integer, immutable } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { readOwnerTransportReference } from "../../packages/governed-execution/src/owner-transport";
import { assertOriginConfiguration, peerSchema,
  type ActualOriginPeer, type OriginPublicConfiguration } from "../../packages/governed-execution/src/specialist-origin-contract";
import { assertActualOriginPeer, OriginFrames, readActualOriginPeer } from "../../packages/governed-execution/src/specialist-origin-custody";
import { refuseQualifiedFixture as refuse } from "./qualified-fixture-custody.mts";

const hex = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096);
export const originalRoleSchema = z.enum(["proof", "projection"]);
export type OriginalPublicationRole = z.infer<typeof originalRoleSchema>;
export const qualifiedOriginalRoleRequestSchema = z.object({
  schema: z.literal("finnor.w2.qualified-original-role-request.v1"), requestId: hex,
  role: originalRoleSchema, runId: z.string().uuid(), fixtureSha256: hex, enrollmentDigest: hex,
  publicationId: hex, candidateDigest: hex, originalSourceDigest: hex,
  programmeId: z.string().uuid(), originalWorkId: z.string().uuid(), originalInputId: z.string().uuid(),
}).strict();
export const qualifiedOriginalRoleOpenSchema = qualifiedOriginalRoleRequestSchema.pick({
  requestId: true, role: true, runId: true, fixtureSha256: true, enrollmentDigest: true, originalWorkId: true,
}).extend({ schema: z.literal("finnor.w2.qualified-original-role-open.v1") }).strict();
export const qualifiedOriginalRoleReadySchema = z.object({
  schema: z.literal("finnor.w2.qualified-original-role-ready.v1"), open: qualifiedOriginalRoleOpenSchema,
  processPid: z.number().int().positive(), processUid: z.number().int().positive(), sqlLogin: text,
}).strict();
export const qualifiedOriginalRoleAckSchema = z.object({
  schema: z.literal("finnor.w2.qualified-original-role-ack.v1"), requestId: hex, replyDigest: hex,
}).strict();
export const qualifiedOriginalRoleReplySchema = z.object({
  schema: z.literal("finnor.w2.qualified-original-role-reply.v1"),
  request: qualifiedOriginalRoleRequestSchema,
  role: originalRoleSchema, processPid: z.number().int().positive(), processUid: z.number().int().positive(),
  sqlLogin: text, status: z.enum(["ORIGINAL_DECISION_RECORDED", "APPLIED_ORIGINAL_HISTORY",
    "ORIGINAL_NOT_PROVEN", "ORIGINAL_NOT_PROJECTED"]),
  decisionDigest: hex.nullable(), projectionDigest: hex.nullable(), operationFailureCode: text.nullable(),
  observedMonotonicNs: integer,
}).strict();
export const qualifiedOriginalRoleReceiptSchema = z.object({
  reply: qualifiedOriginalRoleReplySchema, actualPeer: peerSchema, socketDevice: z.string(), socketInode: z.string(),
  actualExecutable: z.object({ sha256: hex, device: z.string(), inode: z.string() }).strict(),
}).strict();
export type QualifiedOriginalRoleReceipt = z.infer<typeof qualifiedOriginalRoleReceiptSchema>;
export interface QualifiedOriginalRoleSeparation {
  readonly sourceUid: number; readonly enrollmentDigest: string; readonly bootId: string;
  readonly proof: Readonly<{ uid: number; sqlLogin: string }>;
  readonly projection: Readonly<{ uid: number; sqlLogin: string }>;
}
export async function readQualifiedOriginalRoleSeparation(input: {
  authority: CanonicalSpecialistAuthority; config: OriginPublicConfiguration; workerSqlLogin: string;
}): Promise<QualifiedOriginalRoleSeparation> {
  const { authority, config } = input, e = authority.enrollment;
  assertOriginConfiguration(e, config);
  const found = await readOwnerTransportReference({ semanticOwner: "S8",
    tenantId: e.body.tenantId, principalId: e.body.principalId }, e.body.qualifiedDeploymentRef.id);
  if (!found.receipt || digest(found.reference.content) !== e.body.qualifiedDeploymentRef.contentDigest)
    refuse("W2_GENUINE_ORIGINAL_QUALIFIED_ROLE_BINDINGS_REQUIRED");
  const q = canonicalDeploymentQualificationSchema.parse(found.reference.content);
  const candidate = q.clientBindings.candidate, proof = q.clientBindings.proof, projection = q.clientBindings.projection;
  if (!candidate || !proof || !projection || candidate.processUid !== config.sourceUid
    || candidate.processUid <= 0 || proof.processUid <= 0 || projection.processUid <= 0
    || new Set([candidate.processUid, proof.processUid, projection.processUid]).size !== 3
    || new Set([e.body.roles.candidate, e.body.roles.proof, e.body.roles.projection, input.workerSqlLogin]).size !== 4
    || digest(q.primary) !== digest(e.body.primary)
    || q.sourceClosureDigest !== e.body.sourceClosureDigest || q.runtimeDigest !== e.body.runtimeDigest
    || new Set(e.body.origins.map(origin => origin.bootId)).size !== 1)
    refuse("W2_GENUINE_SEPARATE_PROOF_PROJECTION_OS_SQL_ROLES_REQUIRED");
  return immutable({ sourceUid: config.sourceUid, enrollmentDigest: e.digest, bootId: e.body.origins[0]!.bootId,
    proof: { uid: proof.processUid, sqlLogin: e.body.roles.proof },
    projection: { uid: projection.processUid, sqlLogin: e.body.roles.projection } });
}
export async function assertQualifiedRoleSocketParent(path: string, uid: number) {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
    refuse("W2_GENUINE_ROLE_SOCKET_CANONICAL_PATH_REQUIRED");
  const parent = dirname(path), root = parse(path).root;
  let at = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    at = join(at, part);
    const stat = await lstat(at);
    const rootSticky = stat.uid === 0 && !!(stat.mode & 0o1000);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, uid].includes(stat.uid)
      || (stat.mode & 0o022) && !rootSticky)
      refuse("W2_GENUINE_ROLE_SOCKET_ANCESTRAL_CUSTODY_REQUIRED");
  }
  const final = await lstat(parent);
  if (final.uid !== uid || final.mode & 0o022)
    refuse("W2_GENUINE_ROLE_SOCKET_PARENT_MUST_BE_ROLE_OWNED");
}
export async function assertQualifiedRolePeerExecutable(input: {
  socket: Socket; peer: ActualOriginPeer; config: OriginPublicConfiguration; signal: AbortSignal;
}) {
  assertActualOriginPeer(input.peer); input.signal.throwIfAborted();
  // Kernel-selected SO_PEERCRED PID, not a caller path or server-claimed hash.
  // Cross-UID denial is an unmet genuine host prerequisite, never a grant/fallback.
  const fd = await open(`/proc/${input.peer.pid}/exe`, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || before.mode & 0o022
      || before.size <= 0 || before.size > 256 * 1024 * 1024)
      refuse("W2_GENUINE_ROLE_ROOT_OWNED_EXECUTABLE_REQUIRED");
    const hash = createHash("sha256");
    for await (const raw of fd.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) {
      input.signal.throwIfAborted(); hash.update(raw as Buffer);
    }
    const after = await fd.stat(), again = await readActualOriginPeer(input.socket, input.config, input.signal);
    const sha256 = hash.digest("hex");
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
      || sha256 !== input.config.sourceExecutableSha256 || digest(again) !== digest(input.peer))
      refuse("W2_GENUINE_ROLE_EXECUTABLE_OR_BIRTH_REPLACED");
    return Object.freeze({ sha256, device: String(before.dev), inode: String(before.ino) });
  } finally { await fd.close(); }
}
export interface QualifiedOriginalRoleSession {
  run(request: Pick<z.infer<typeof qualifiedOriginalRoleRequestSchema>,
    "publicationId" | "candidateDigest" | "originalSourceDigest" | "programmeId" | "originalInputId">): Promise<QualifiedOriginalRoleReceipt>;
  close(): void;
}
export async function openQualifiedOriginalRoleSession(input: {
  socketPath: string; separation: QualifiedOriginalRoleSeparation; config: OriginPublicConfiguration;
  original: Omit<z.infer<typeof qualifiedOriginalRoleOpenSchema>, "requestId" | "schema">;
  signal: AbortSignal;
}): Promise<QualifiedOriginalRoleSession> {
  input.signal.throwIfAborted();
  const expected = input.separation[input.original.role];
  if (process.getuid?.() !== input.separation.sourceUid || process.pid <= 0
    || input.original.enrollmentDigest !== input.separation.enrollmentDigest)
    refuse("W2_GENUINE_SOURCE_ROLE_CALLER_REQUIRED");
  await assertQualifiedRoleSocketParent(input.socketPath, expected.uid);
  const before = await lstat(input.socketPath);
  if (!before.isSocket() || before.isSymbolicLink() || before.uid !== expected.uid)
    refuse("W2_GENUINE_ROLE_SOCKET_CUSTODY_REQUIRED");
  const socket = createConnection({ path: input.socketPath });
  const stop = () => socket.destroy(Error("W2_GENUINE_ROLE_CALL_ABORTED"));
  input.signal.addEventListener("abort", stop, { once: true });
  const close = () => { input.signal.removeEventListener("abort", stop); socket.destroy(); };
  try {
    await new Promise<void>((yes, no) => { socket.once("connect", yes); socket.once("error", no); });
    input.signal.throwIfAborted();
    const peer = await readActualOriginPeer(socket, input.config, input.signal);
    assertActualOriginPeer(peer);
    const after = await lstat(input.socketPath);
    if (peer.uid !== expected.uid || peer.pid === process.pid || peer.startTicks === "0" || peer.bootId !== input.separation.bootId
      || before.dev !== after.dev || before.ino !== after.ino || after.uid !== expected.uid)
      refuse("W2_GENUINE_SEPARATE_ROLE_KERNEL_PEER_REQUIRED");
    const actualExecutable = await assertQualifiedRolePeerExecutable({ socket, peer,
      config: input.config, signal: input.signal });
    const frames = new OriginFrames(socket);
    const opening = qualifiedOriginalRoleOpenSchema.parse({ ...input.original,
      schema: "finnor.w2.qualified-original-role-open.v1", requestId: randomBytes(32).toString("hex") });
    let state: "READY" | "REQUEST" | "RESULT" | "DONE" = "READY", protocolFailure: unknown;
    let request: z.infer<typeof qualifiedOriginalRoleRequestSchema> | undefined;
    let readyYes!: () => void, readyNo!: (error: unknown) => void;
    let resultYes!: (reply: z.infer<typeof qualifiedOriginalRoleReplySchema>) => void, resultNo!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { readyYes = yes; readyNo = no; });
    const completed = new Promise<z.infer<typeof qualifiedOriginalRoleReplySchema>>((yes, no) => { resultYes = yes; resultNo = no; });
    void ready.catch(() => undefined); void completed.catch(() => undefined);
    const fail = (error: unknown) => { protocolFailure ??= error; readyNo(error); resultNo(error); close(); };
    frames.onFailure(fail);
    frames.onMessage(raw => {
      try {
        input.signal.throwIfAborted();
        if (state === "READY") {
          const message = qualifiedOriginalRoleReadySchema.parse(raw);
          if (digest(message.open) !== digest(opening) || message.processPid !== peer.pid
            || message.processUid !== peer.uid || message.sqlLogin !== expected.sqlLogin)
            refuse("W2_GENUINE_ROLE_PREFLIGHT_NONCE_IDENTITY_REQUIRED");
          state = "REQUEST"; readyYes(); return;
        }
        if (state !== "RESULT" || !request) refuse("W2_GENUINE_ROLE_UNSOLICITED_REPLY");
        const reply = qualifiedOriginalRoleReplySchema.parse(raw);
        if (digest(reply.request) !== digest(request) || reply.role !== request.role
          || reply.processPid !== peer.pid || reply.processUid !== peer.uid || reply.sqlLogin !== expected.sqlLogin
          || !(request.role === "proof" ? ["ORIGINAL_DECISION_RECORDED", "ORIGINAL_NOT_PROVEN"]
            : ["APPLIED_ORIGINAL_HISTORY", "ORIGINAL_NOT_PROJECTED"]).includes(reply.status)
          || reply.status === "ORIGINAL_DECISION_RECORDED" && (!reply.decisionDigest || reply.projectionDigest !== null || reply.operationFailureCode !== null)
          || reply.status === "APPLIED_ORIGINAL_HISTORY" && (!reply.decisionDigest || !reply.projectionDigest || reply.operationFailureCode !== null)
          || ["ORIGINAL_NOT_PROVEN", "ORIGINAL_NOT_PROJECTED"].includes(reply.status)
            && (reply.decisionDigest !== null || reply.projectionDigest !== null))
          refuse("W2_GENUINE_ROLE_REPLY_ORIGINAL_BINDING_REQUIRED");
        state = "DONE"; resultYes(reply);
      } catch (error) { fail(error); }
    });
    await frames.send(opening); await ready;
    input.signal.throwIfAborted();
    return Object.freeze({
      close,
      async run(original: Parameters<QualifiedOriginalRoleSession["run"]>[0]) {
        try {
          input.signal.throwIfAborted();
          if (state !== "REQUEST" || request || protocolFailure) refuse("W2_GENUINE_ROLE_ONE_ORIGINAL_OPERATION_ONLY");
          request = qualifiedOriginalRoleRequestSchema.parse({ ...opening, ...original,
            schema: "finnor.w2.qualified-original-role-request.v1" });
          state = "RESULT"; await frames.send(request);
          const reply = await completed; input.signal.throwIfAborted();
          const finalExecutable = await assertQualifiedRolePeerExecutable({ socket, peer, config: input.config, signal: input.signal });
          if (digest(finalExecutable) !== digest(actualExecutable) || protocolFailure)
            refuse("W2_GENUINE_ROLE_EXECUTABLE_OR_PROTOCOL_CHANGED");
          const current = await lstat(input.socketPath);
          if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== expected.uid)
            refuse("W2_GENUINE_ROLE_SOCKET_REPLACED_DURING_ORIGINAL");
          await frames.send(qualifiedOriginalRoleAckSchema.parse({
            schema: "finnor.w2.qualified-original-role-ack.v1", requestId: opening.requestId, replyDigest: digest(reply),
          }));
          return immutable(qualifiedOriginalRoleReceiptSchema.parse({ reply, actualPeer: peer,
            actualExecutable: finalExecutable, socketDevice: String(before.dev), socketInode: String(before.ino) }));
        } finally { close(); }
      },
    });
  } catch (error) { close(); throw error; }
}
