/** EXTERNALLY launched one-original role process. No spawn/sudo/role/key setup. */
import { chmod, lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { digest } from "../../packages/capability-evolution/src/contracts";
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { candidateSchema, observationSchema } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { readOriginalPublicationWitness, assertVerifiedPublicationWitnessCurrentTails } from "../../packages/governed-execution/src/specialist-publication-witness";
import { readOriginPublicConfiguration, readActualOriginPeer,
  assertActualOriginPeer, OriginFrames } from "../../packages/governed-execution/src/specialist-origin-custody";
import { proveOriginalSpecialistPublication,
  projectOriginalSpecialistPublication } from "../../packages/orchestration/src/workforce-execution/specialist-publication";
import { assertQualifiedRolePeerExecutable, assertQualifiedRoleSocketParent, originalRoleSchema,
  qualifiedOriginalRoleRequestSchema, qualifiedOriginalRoleReplySchema, qualifiedOriginalRoleOpenSchema,
  qualifiedOriginalRoleReadySchema, qualifiedOriginalRoleAckSchema,
  readQualifiedOriginalRoleSeparation } from "./qualified-publication-role-protocol.mts";
import { qualifiedFixtureFailureCode, readPrivateQualifiedFixture,
  refuseQualifiedFixture as refuse } from "./qualified-fixture-custody.mts";

const hex = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096);
export const qualifiedOriginalRoleServiceFixtureSchema = z.object({
  schema: z.literal("finnor.w2.prequalified-original-role-service.v1"),
  role: originalRoleSchema, runId: z.string().uuid(), owningFixtureSha256: hex,
  originalWorkId: z.string().uuid(), enrollmentDigest: hex, workerSqlLogin: text,
  socketPath: text, maximumWallMs: z.number().int().min(1000).max(300000),
  dataClass: z.literal("HUMAN_APPROVED_DEVELOPER_TEST_DATA_ONLY"),
}).strict();

export async function serveQualifiedOriginalPublicationRole(input: {
  readonly fixturePath: string; readonly signal: AbortSignal;
}) {
  const { fixture: f } = await readPrivateQualifiedFixture(input.fixturePath, qualifiedOriginalRoleServiceFixtureSchema);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(f.maximumWallMs)]);
  signal.throwIfAborted();
  if (process.platform !== "linux" || !process.getuid?.()) refuse("W2_GENUINE_ROLE_PROCESS_OS_REQUIRED");
  let authority: Awaited<ReturnType<typeof openWorkforceSpecialistPublicationAuthority>> | undefined;
  let primary: { error: unknown } | undefined;
  const lifecycle: { server?: Server; inFlight?: Promise<void>; detachAbort?: () => void;
    completed: boolean; consumed: boolean } = { completed: false, consumed: false };
  const sockets = new Set<Socket>();
  try {
    const config = await readOriginPublicConfiguration();
    authority = await openWorkforceSpecialistPublicationAuthority(f.role, true);
    const separation = await readQualifiedOriginalRoleSeparation({ authority, config, workerSqlLogin: f.workerSqlLogin });
    signal.throwIfAborted();
    const role = separation[f.role];
    if (f.enrollmentDigest !== authority.enrollment.digest || process.getuid() !== role.uid
      || authority.config.role !== f.role || authority.config.processUid !== role.uid)
      refuse("W2_GENUINE_ROLE_EXISTING_OS_SQL_BINDING_REQUIRED");
    await assertQualifiedRoleSocketParent(f.socketPath, role.uid);
    try { await lstat(f.socketPath); refuse("W2_GENUINE_ROLE_SOCKET_MUST_BE_NEW"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    signal.throwIfAborted();
    const enrolled = authority;
    const execute = async (socket: Socket) => {
      signal.throwIfAborted();
      const peer = await readActualOriginPeer(socket, config, signal); assertActualOriginPeer(peer);
      if (peer.uid !== separation.sourceUid || peer.pid === process.pid || peer.startTicks === "0" || peer.bootId !== separation.bootId)
        refuse("W2_GENUINE_ROLE_ACTUAL_SOURCE_PEER_REQUIRED");
      await assertQualifiedRolePeerExecutable({ socket, peer, config, signal });
      const frames = new OriginFrames(socket);
      let stage: "OPEN" | "REQUEST" | "ACK" | "COMPLETE" = "OPEN", protocolFailure: unknown;
      let opening: z.infer<typeof qualifiedOriginalRoleOpenSchema> | undefined, replyDigest: string | undefined;
      let openYes!: (value: z.infer<typeof qualifiedOriginalRoleOpenSchema>) => void, openNo!: (error: unknown) => void;
      let requestYes!: (value: z.infer<typeof qualifiedOriginalRoleRequestSchema>) => void, requestNo!: (error: unknown) => void;
      let ackYes!: () => void, ackNo!: (error: unknown) => void;
      const opened = new Promise<z.infer<typeof qualifiedOriginalRoleOpenSchema>>((yes, no) => { openYes = yes; openNo = no; });
      const requestPromise = new Promise<z.infer<typeof qualifiedOriginalRoleRequestSchema>>((yes, no) => { requestYes = yes; requestNo = no; });
      const acknowledged = new Promise<void>((yes, no) => { ackYes = yes; ackNo = no; });
      void opened.catch(() => undefined); void requestPromise.catch(() => undefined); void acknowledged.catch(() => undefined);
      const fail = (error: unknown) => { protocolFailure ??= error; openNo(error); requestNo(error); ackNo(error); socket.destroy(); };
      frames.onFailure(fail);
      frames.onMessage(raw => {
        try {
          signal.throwIfAborted();
          if (stage === "OPEN") {
            const value = qualifiedOriginalRoleOpenSchema.parse(raw);
            if (value.role !== f.role || value.runId !== f.runId || value.fixtureSha256 !== f.owningFixtureSha256
              || value.enrollmentDigest !== f.enrollmentDigest || value.originalWorkId !== f.originalWorkId)
              refuse("W2_GENUINE_ROLE_OPEN_SCOPE_MISMATCH");
            opening = value; stage = "REQUEST"; openYes(value); return;
          }
          if (stage === "REQUEST") {
            const value = qualifiedOriginalRoleRequestSchema.parse(raw);
            if (!opening || value.requestId !== opening.requestId || value.role !== f.role || value.runId !== f.runId
              || value.fixtureSha256 !== f.owningFixtureSha256 || value.enrollmentDigest !== f.enrollmentDigest
              || value.originalWorkId !== f.originalWorkId)
              refuse("W2_GENUINE_ROLE_REQUEST_SCOPE_MISMATCH");
            stage = "ACK"; requestYes(value); return;
          }
          if (stage !== "ACK" || !opening || !replyDigest) refuse("W2_GENUINE_ROLE_REQUEST_REPLAY");
          const value = qualifiedOriginalRoleAckSchema.parse(raw);
          if (value.requestId !== opening.requestId || value.replyDigest !== replyDigest)
            refuse("W2_GENUINE_ROLE_ACK_NONCE_DIGEST_REQUIRED");
          stage = "COMPLETE"; ackYes();
        } catch (error) { fail(error); }
      });
      const actualOpen = await opened; signal.throwIfAborted();
      await frames.send(qualifiedOriginalRoleReadySchema.parse({
        schema: "finnor.w2.qualified-original-role-ready.v1", open: actualOpen,
        processPid: process.pid, processUid: process.getuid(), sqlLogin: role.sqlLogin,
      }));
      const request = await requestPromise; signal.throwIfAborted();
      if (lifecycle.consumed || protocolFailure) refuse("W2_GENUINE_ROLE_ONE_ORIGINAL_OPERATION_ONLY");
      const before = await enrolled.observeOriginal(request.publicationId);
      const row = before?.candidateRow, candidate = candidateSchema.parse(row?.candidate);
      if (typeof before?.originalUpperCaptured !== "boolean" || candidate.enrollmentDigest !== f.enrollmentDigest
        || candidate.originalWorkId !== request.originalWorkId || candidate.originalInputId !== request.originalInputId
        || candidate.programmeId !== request.programmeId || candidate.publicationId !== request.publicationId
        || row.candidate_digest !== request.candidateDigest || digest(candidate) !== request.candidateDigest
        || digest({ intent: row.original_intent, nativeReady: row.original_sources.nativeReady }) !== request.originalSourceDigest
        || before.projection !== null
        || f.role === "proof" && before.decision !== null
        || f.role === "projection" && before.decision !== null && before.decision?.status !== "ACCEPTED_ORIGINAL_COMMIT")
        refuse("W2_GENUINE_ROLE_ACTUAL_ORIGINAL_CANDIDATE_REQUIRED");
      lifecycle.consumed = true;
      signal.throwIfAborted();
      // The ONLY operation enum. Reuse the real independent proof/projection.
      let resultStatus: string | undefined, operationFailure: unknown;
      try {
        if (f.role === "projection" && before.decision !== null) {
          // Fresh shared verification, never an old witness or parsed brand.
          const witness = await readOriginalPublicationWitness({
            directory: enrolled.config.witnessDirectory, expectedDirectory: enrolled.config.witnessDirectory,
            enrollment: enrolled.enrollment, candidate, pre: observationSchema.parse(row.pre_observation),
            post: observationSchema.parse(before.postObservation), originalSourceDigest: request.originalSourceDigest, signal,
          });
          assertVerifiedPublicationWitnessCurrentTails(witness); signal.throwIfAborted();
          if (witness.candidateDigest !== request.candidateDigest || witness.evidenceDigest !== before.decision.witnessDigest
            || digest(witness.interval) !== digest(before.decision.interval))
            refuse("W2_GENUINE_PROJECTION_CURRENT_TAIL_WITNESS_BINDING_REQUIRED");
        }
        const result = f.role === "proof"
          ? await proveOriginalSpecialistPublication(enrolled, request.publicationId)
          : await projectOriginalSpecialistPublication(enrolled, request.publicationId);
        resultStatus = typeof result === "string" ? result : result?.status;
      } catch (error) { operationFailure = error; }
      signal.throwIfAborted();
      const expected = f.role === "proof" ? "ORIGINAL_DECISION_RECORDED" : "APPLIED_ORIGINAL_HISTORY";
      const after = await enrolled.observeOriginal(request.publicationId);
      signal.throwIfAborted();
      const operationCode = (operationFailure as { code?: unknown } | null)?.code;
      const operationMessage = (operationFailure as { message?: unknown } | null)?.message;
      // A known pre-decision source/root refusal (or real no-upper return) is
      // not a transport/COMMIT uncertainty. A projection P0002 is the actual
      // atomic missing-decision SQL refusal. Permission/network failures never
      // become no-positive receipts merely because a later SELECT is empty.
      const preDecisionRefusal = typeof operationCode === "string"
        ? /^(WORKFORCE_|SPECIALIST_)/.test(operationCode) || operationCode === "ENOENT"
        : typeof operationMessage === "string" && operationMessage.startsWith("SPECIALIST_");
      const noPositive = after?.decision === null && after.projection === null
        && (f.role === "proof" ? resultStatus === "UNKNOWN_READ_ONLY" || preDecisionRefusal : operationCode === "P0002");
      const positive = operationFailure === undefined && resultStatus === expected
        && after?.decision?.status === "ACCEPTED_ORIGINAL_COMMIT"
        && after.decision.candidateDigest === request.candidateDigest
        && (f.role === "proof" ? after.projection === null
          : after.projection?.status === "APPLIED_ORIGINAL_HISTORY" && after.projection.publication_id === request.publicationId
            && after.projection.decision_digest === digest(after.decision));
      if (!noPositive && !positive) {
        if (operationFailure !== undefined) throw operationFailure;
        refuse("W2_GENUINE_ROLE_ACTUAL_DECISION_PROJECTION_REQUIRED");
      }
      const again = await readActualOriginPeer(socket, config, signal);
      if (digest(again) !== digest(peer)) refuse("W2_GENUINE_ROLE_SOURCE_PEER_REPLACED");
      const reply = qualifiedOriginalRoleReplySchema.parse({
        schema: "finnor.w2.qualified-original-role-reply.v1", request, role: f.role,
        processPid: process.pid, processUid: process.getuid(), sqlLogin: role.sqlLogin,
        status: noPositive ? f.role === "proof" ? "ORIGINAL_NOT_PROVEN" : "ORIGINAL_NOT_PROJECTED" : expected,
        decisionDigest: noPositive ? null : digest(after!.decision),
        projectionDigest: after!.projection === null ? null : digest(after!.projection),
        operationFailureCode: operationFailure === undefined ? null : qualifiedFixtureFailureCode(operationFailure),
        observedMonotonicNs: String(process.hrtime.bigint()),
      });
      replyDigest = digest(reply);
      // Stay alive while the worker independently rechecks this actual peer's
      // executable and birth. An unacknowledged self-report is not completion.
      await frames.send(reply); await acknowledged; signal.throwIfAborted();
      if (protocolFailure) throw protocolFailure;
      socket.end(); lifecycle.completed = true;
    };
    let acceptedConnection = false;
    const done = new Promise<void>((yes, no) => {
      const server = createServer(socket => {
        if (acceptedConnection || signal.aborted) { socket.destroy(); return; }
        acceptedConnection = true; sockets.add(socket);
        socket.on("error", no);
        socket.once("close", () => sockets.delete(socket));
        lifecycle.inFlight = execute(socket);
        void lifecycle.inFlight.then(yes, no);
      });
      lifecycle.server = server;
      server.maxConnections = 1;
      server.once("error", no);
      const stop = () => {
        for (const socket of sockets) socket.destroy();
        no(Error("W2_GENUINE_ROLE_ORIGINAL_SERVICE_WALL"));
      };
      signal.addEventListener("abort", stop, { once: true });
      lifecycle.detachAbort = () => signal.removeEventListener("abort", stop);
      if (signal.aborted) stop();
    });
    void done.catch(() => undefined);
    signal.throwIfAborted();
    const server = lifecycle.server;
    if (!server) refuse("W2_GENUINE_ROLE_OWNED_SERVER_REQUIRED");
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(f.socketPath, () => yes());
    });
    signal.throwIfAborted();
    // Only the just-created owned socket. Its parent was supplied externally.
    const socket = await lstat(f.socketPath);
    if (!socket.isSocket() || socket.uid !== role.uid) refuse("W2_GENUINE_ROLE_CREATED_SOCKET_CUSTODY");
    await chmod(f.socketPath, 0o666);
    signal.throwIfAborted();
    console.log(JSON.stringify({ status: "ACTUAL_ORIGINAL_ROLE_ENDPOINT_LISTENING",
      role: f.role, processPid: process.pid, processUid: process.getuid() }));
    await done; signal.throwIfAborted();
  } catch (error) { primary = { error }; }
  finally {
    lifecycle.detachAbort?.();
    for (const socket of sockets) socket.destroy();
    const server = lifecycle.server;
    if (server?.listening) {
      try { await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); }
      catch (error) { primary ??= { error }; }
    }
    // Drain the one existing operation before closing its real SQL pool.
    // This is teardown, not a retry, new admission, or renewed source window.
    if (lifecycle.inFlight) { try { await lifecycle.inFlight; } catch (error) { primary ??= { error }; } }
    try { await authority?.close(); } catch (error) { primary ??= { error }; }
  }
  if (primary !== undefined) throw primary.error;
  if (!lifecycle.completed || !lifecycle.consumed) refuse("W2_GENUINE_ROLE_OPERATION_NOT_COMPLETED");
  return Object.freeze({ schema: "finnor.w2.qualified-original-role-process.v1",
    role: f.role, status: "ONE_ACTUAL_ORIGINAL_ROLE_OPERATION_COMPLETED", processPid: process.pid,
    processUid: process.getuid?.(), originalOnly: true, physicalReplayPermitted: false, budgetRenewed: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.env.FINNOR_W2_GENUINE_FIXTURE_RUNTIME_AUTHORIZED !== "EXPLICIT_EXTERNAL_RUNTIME_GRANT")
    refuse("W2_GENUINE_ROLE_EXTERNAL_RUNTIME_GRANT_AND_ONE_FIXTURE_REQUIRED");
  const controller = new AbortController();
  const stop = () => controller.abort(Error("W2_GENUINE_ROLE_EXTERNAL_STOP"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { console.log(JSON.stringify(await serveQualifiedOriginalPublicationRole({
    fixturePath: process.argv[2]!, signal: controller.signal }))); }
  catch (error) { console.error(JSON.stringify({ status: "NOT_QUALIFIED",
    failureCode: qualifiedFixtureFailureCode(error) })); process.exitCode = 1; }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
