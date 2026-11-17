/** Genuine owning caller. No fixture can bootstrap qualification or permission. */
import { createPublicKey, verify } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getPool, PRODUCTION_JOB_CONTRACTS } from "@finnor/db";
import { JobQueue } from "../../apps/worker/src/queue";
import { canonical } from "../../packages/governed-execution/src/protocol";
import { byteDigest, digest, sameRef, RefSchema } from "../../packages/capability-evolution/src/contracts";
import { candidateSchema, observationSchema, clockSealSchema, originSealSchema, integer,
  immutable } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { readOriginalPublicationWitness, assertVerifiedPublicationWitnessCurrentTails } from "../../packages/governed-execution/src/specialist-publication-witness";
import { readSpecialistRootBytes } from "../../packages/governed-execution/src/specialist-root-custody";
import { readOriginPublicConfiguration } from "../../packages/governed-execution/src/specialist-origin-custody";
import { assertOriginConfiguration, eventKindSchema, originKindSchema, signedRevocationSchema,
  type SourceRegistration } from "../../packages/governed-execution/src/specialist-origin-contract";
import { actualOriginalFailureEvidenceSchema, verifyActualOriginalFailureEvidence,
  readExistingOriginalFailureEvidence,
  type ActualOriginalFailureEvidence } from "../../packages/governed-execution/src/specialist-origin-failure";
import { withOriginalOriginOwningFixture, originalOriginOwningPhases,
  type OriginalOriginOwningObserver, type ActualOriginalOriginOwningView } from "../../packages/governed-execution/src/specialist-origin-owning-fixture";
import { nativeWorkforceOriginalSchema } from "../../packages/orchestration/src/workforce-execution/contracts";
import { intakeWorkforceExecution } from "../../packages/orchestration/src/workforce-execution/runtime";
import { rootContext, tx } from "../../packages/orchestration/src/workforce-execution/store";
import { runWorkforceExecutionJob } from "../../packages/orchestration/src/workforce-execution/worker";
import { specialistComputationSchema } from "../../packages/governed-execution/src/specialist-contract";
import { openQualifiedOriginalRoleSession, readQualifiedOriginalRoleSeparation,
  qualifiedOriginalRoleReceiptSchema, type QualifiedOriginalRoleSession } from "./qualified-publication-role-protocol.mts";
import { qualifiedFixtureFailureCode as safeCode, readPrivateQualifiedFixture,
  reserveQualifiedFixtureArtifacts, refuseQualifiedFixture as refuse,
  type QualifiedFixtureArtifacts } from "./qualified-fixture-custody.mts";

export type { OriginalOriginOwningObserver, ActualOriginalOriginOwningView };
const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const signed = <T extends z.ZodTypeAny>(body: T) => z.object({ body, keyId: text, signature: text }).strict();
export const genuineOriginalPublicationEpisodeSchema = z.object({
  schema: z.literal("finnor.w2.genuine-original-publication-episode.v1"),
  enrollmentDigest: hex, publicationId: hex, originalSourceDigest: hex, witnessDirectory: text.refine(isAbsolute),
  candidate: candidateSchema, pre: observationSchema, post: observationSchema,
  clock: signed(clockSealSchema), origins: z.array(z.array(signed(originSealSchema)).min(1).max(4096)).min(7).max(64),
  physicalEvents: z.array(signed(z.unknown())).max(3),
}).strict().superRefine((value, ctx) => {
  const id = value.publicationId, enrollment = value.enrollmentDigest, candidateDigest = digest(value.candidate);
  if (value.candidate.enrollmentDigest !== enrollment || value.candidate.publicationId !== id
    || value.clock.body.enrollmentDigest !== enrollment || value.clock.body.publicationId !== id
    || value.pre.publicationId !== id || value.post.publicationId !== id
    || value.pre.candidateDigest !== candidateDigest || value.post.candidateDigest !== candidateDigest
    || value.pre.phase !== "BEFORE_COMMIT" || value.post.phase !== "AFTER_COMMITTED"
    || value.post.commitStatus !== "committed"
    || value.origins.some(chain => chain.some(seal => seal.body.enrollmentDigest !== enrollment
      || seal.body.publicationId !== id || seal.body.candidateDigest !== candidateDigest)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GENUINE_EPISODE_ORIGINAL_IDENTITY_MISMATCH" });
});
export type GenuineOriginalPublicationEpisode = z.infer<typeof genuineOriginalPublicationEpisodeSchema>;

export const qualifiedPublicationFixtureSchema = z.object({
  schema: z.literal("finnor.w2.prequalified-owning-publication-fixture.v1"),
  lane: z.enum(["FRESH_DATABASE", "ALREADY_APPLIED_UPGRADE"]), runId: z.string().uuid(),
  database: z.string().regex(/^finnor_w2_e2e_[a-z0-9_]+$/), workerSqlLogin: text,
  tenantId: z.string().uuid(), principalId: z.string().uuid(), workId: z.string().uuid(),
  enrollmentDigest: hex, workerInstanceId: text, leaseSeconds: z.number().int().min(30).max(600),
  maximumTicks: z.number().int().min(2).max(64), maximumWallMs: z.number().int().min(1000).max(300000),
  proofSocketPath: text.refine(isAbsolute), projectionSocketPath: text.refine(isAbsolute),
  original: nativeWorkforceOriginalSchema, dataClass: z.literal("HUMAN_APPROVED_DEVELOPER_TEST_DATA_ONLY"),
}).strict();
export type QualifiedPublicationFixture = z.infer<typeof qualifiedPublicationFixtureSchema>;
const modeSchema = z.enum(["GENUINE_POSITIVE", "ORIGIN_NEGATIVE_NO_MODEL"]);
export interface ExplicitOutsideModelAuthorization {
  readonly signedApprovalPath: string; readonly existingApproverPublicKeyPath: string;
  readonly externallyTrustedPublicKeySha256: string;
}
const modelApprovalSchema = z.object({
  schema: z.literal("finnor.w2.explicit-outside-paid-model-authorization.v1"),
  authorizationId: z.string().uuid(), runId: z.string().uuid(), fixtureSha256: hex,
  database: text, enrollmentDigest: hex, tenantId: text, principalId: text, workId: text,
  methodRef: RefSchema, admissionRef: RefSchema, modelIdentity: specialistComputationSchema.shape.modelIdentity,
  api: z.literal("bedrock:Converse"), maximumInvocations: z.literal(1),
  paidModelInvocationExplicitlyAuthorized: z.literal(true), customerContactAuthorized: z.literal(false),
  dataClass: z.literal("HUMAN_APPROVED_DEVELOPER_TEST_DATA_ONLY"),
  validAfter: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }),
  authorityKind: z.literal("EXPLICIT_OUTSIDE_MODEL_PERMISSION_NOT_HOST_OR_SOFTWARE_TEST_GO"),
}).strict();
async function actualOutsideModelApproval(input: {
  authorization: ExplicitOutsideModelAuthorization | undefined; fixture: QualifiedPublicationFixture; fixtureSha256: string;
}) {
  const { authorization: a, fixture: f } = input;
  if (!a || !hex.safeParse(a.externallyTrustedPublicKeySha256).success)
    refuse("W2_EXPLICIT_OUTSIDE_PAID_MODEL_AUTHORIZATION_REQUIRED");
  const keyBytes = await readSpecialistRootBytes(a.existingApproverPublicKeyPath, 16384);
  if (byteDigest(keyBytes) !== a.externallyTrustedPublicKeySha256)
    refuse("W2_EXISTING_OUTSIDE_MODEL_APPROVER_REQUIRED");
  const key = createPublicKey(keyBytes);
  if (key.asymmetricKeyType !== "ed25519") refuse("W2_OUTSIDE_MODEL_APPROVAL_SIGNATURE_REQUIRED");
  const approval = signed(modelApprovalSchema).parse(JSON.parse(
    (await readSpecialistRootBytes(a.signedApprovalPath, 65536)).toString("utf8")));
  if (!verify(null, Buffer.from(canonical(approval.body)), key, Buffer.from(approval.signature, "base64")))
    refuse("W2_OUTSIDE_MODEL_APPROVAL_SIGNATURE_REQUIRED");
  const operation = f.original.operations.length === 1
    ? specialistComputationSchema.parse(f.original.operations[0]!.computation) : null, b = approval.body;
  if (!operation || b.fixtureSha256 !== input.fixtureSha256 || b.runId !== f.runId || b.database !== f.database
    || b.enrollmentDigest !== f.enrollmentDigest || b.tenantId !== f.tenantId || b.principalId !== f.principalId
    || b.workId !== f.workId || !sameRef(b.methodRef, operation.methodRef) || !sameRef(b.admissionRef, operation.admissionRef)
    || digest(b.modelIdentity) !== digest(operation.modelIdentity)
    || Date.parse(b.validAfter) >= Date.now() || Date.parse(b.validUntil) <= Date.now())
    refuse("W2_OUTSIDE_MODEL_APPROVAL_ORIGINAL_SCOPE_MISMATCH");
  return immutable(b);
}
const phaseEvidenceSchema = z.object({
  phase: z.enum(originalOriginOwningPhases), edge: z.enum(["BEFORE_OBSERVER", "AFTER_OBSERVER"]),
  invocation: z.number().int().positive(),
  atMonotonicNs: integer, registrationDigest: hex, workerPid: z.number().int().positive(),
  guardianPid: z.number().int().positive(), guestPid: z.number().int().positive(),
  jobId: text, claimFence: z.number().int().positive(), lastCensusDigest: hex.nullable(),
  originalAborted: z.boolean(), combinedAborted: z.boolean(), p3Aborted: z.boolean(),
  controllerAborted: z.boolean(), socketDestroyed: z.boolean(),
}).strict();
export const genuineOriginalNegativeExpectationSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("DURABLE_REVOCATION"), phase: z.enum(originalOriginOwningPhases),
    originKind: originKindSchema, event: eventKindSchema }).strict(),
  z.object({ basis: z.literal("JOURNAL_CONTINUITY_LOST"), phase: z.enum(originalOriginOwningPhases),
    originKind: originKindSchema }).strict(),
]);
export type GenuineOriginalNegativeExpectation = z.infer<typeof genuineOriginalNegativeExpectationSchema>;
const actualDatabaseOutcomeSchema = z.object({
  schema: z.literal("finnor.w2.actual-independent-original-database-outcome.v1"),
  enrollmentDigest: hex, publicationId: hex, observedMonotonicNs: integer,
  authorityRole: z.literal("candidate"), sqlLogin: text, tlsCertificateSha256: hex,
  primaryDigest: hex, authorityCustodyDigest: hex, originalObservationDigest: hex,
  candidatePresent: z.boolean(), originalUpperCaptured: z.boolean(), decisionPresent: z.boolean(), projectionPresent: z.boolean(),
}).strict();
export const genuineOriginalPublicationFailureSchema = z.object({
  schema: z.literal("finnor.w2.genuine-original-publication-failure.v1"),
  status: z.enum(["NOT_RUN", "FAILED_UNQUALIFIED", "ACTUAL_NEGATIVE_OBSERVED"]),
  fixtureSha256: hex.nullable(), publicationId: hex.nullable(), programmeId: z.string().uuid().nullable(),
  originalSourceDigest: hex.nullable(), negativeExpectation: genuineOriginalNegativeExpectationSchema.nullable(),
  intakeAccepted: z.boolean(), sourceReadyObserved: z.boolean(), allOriginGenesisVerified: z.boolean(),
  faultReceiptVerified: z.boolean(), authenticatedOriginEvidenceDigest: hex.nullable(),
  authenticatedOriginEvidence: actualOriginalFailureEvidenceSchema.nullable(),
  databaseOutcome: actualDatabaseOutcomeSchema.nullable(),
  proofOutcome: qualifiedOriginalRoleReceiptSchema.nullable(), projectionOutcome: qualifiedOriginalRoleReceiptSchema.nullable(),
  observerInvocationCount: z.number().int().nonnegative(), phaseEvidence: z.array(phaseEvidenceSchema).max(1024),
  failureCode: text, secondaryFailureCodes: z.array(text).max(32),
  originalOnly: z.literal(true), modelReplayPermitted: z.literal(false), qualificationGranted: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (value.status === "ACTUAL_NEGATIVE_OBSERVED" && (!value.intakeAccepted || !value.sourceReadyObserved
    || !value.allOriginGenesisVerified || !value.faultReceiptVerified || !value.authenticatedOriginEvidenceDigest
    || !value.authenticatedOriginEvidence || !value.negativeExpectation
    || digest(value.authenticatedOriginEvidence) !== value.authenticatedOriginEvidenceDigest
    || value.authenticatedOriginEvidence.originalSourceDigest !== value.originalSourceDigest
    || !value.databaseOutcome || value.databaseOutcome.decisionPresent || value.databaseOutcome.projectionPresent
    || value.databaseOutcome.publicationId !== value.publicationId
    || value.databaseOutcome.candidatePresent && (value.proofOutcome?.reply.status !== "ORIGINAL_NOT_PROVEN"
      || value.projectionOutcome?.reply.status !== "ORIGINAL_NOT_PROJECTED"
      || value.proofOutcome.actualPeer.uid === value.projectionOutcome.actualPeer.uid
      || value.proofOutcome.reply.request.publicationId !== value.publicationId
      || value.projectionOutcome.reply.request.publicationId !== value.publicationId)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GENUINE_NEGATIVE_ACTUAL_EVIDENCE_REQUIRED" });
});
export type GenuineOriginalPublicationFailure = z.infer<typeof genuineOriginalPublicationFailureSchema>;
export interface GenuineOriginalPublicationFailureError extends Error {
  readonly failure: GenuineOriginalPublicationFailure; readonly artifactPath: string | null;
  readonly artifactSha256: string | null; readonly originalCause: unknown;
}
const actualFailures = new WeakSet<object>();
export function assertGenuineOriginalPublicationFailure(error: unknown): asserts error is GenuineOriginalPublicationFailureError {
  if (!error || typeof error !== "object" || !actualFailures.has(error))
    refuse("W2_GENUINE_FAILURE_ACTUAL_PRODUCER_IDENTITY_REQUIRED");
}
export function assertActualGenuineOriginalPublicationNegative(error: unknown): asserts error is GenuineOriginalPublicationFailureError {
  assertGenuineOriginalPublicationFailure(error);
  if (error.failure.status !== "ACTUAL_NEGATIVE_OBSERVED" || !error.artifactPath || !error.artifactSha256)
    refuse("W2_GENUINE_NEGATIVE_NOT_ESTABLISHED");
}
export interface GenuineOriginalPublicationEpisodeInput {
  readonly fixturePath: string; readonly artifactDirectory: string; readonly signal: AbortSignal;
  readonly observe?: OriginalOriginOwningObserver;
  readonly mode?: z.infer<typeof modeSchema>;
  readonly outsideModelAuthorization?: ExplicitOutsideModelAuthorization;
  readonly negativeExpectation?: GenuineOriginalNegativeExpectation;
}
type CandidateAuthority = Awaited<ReturnType<typeof openWorkforceSpecialistPublicationAuthority>>;
type FirstFailure = { readonly error: unknown };
async function actualDatabaseOutcome(authority: CandidateAuthority, publicationId: string) {
  const custody = await authority.readOriginalAuthorityCustody();
  const raw = await authority.observeOriginal(publicationId);
  if (authority.config.role !== "candidate" || custody.enrollmentDigest !== authority.enrollment.digest
    || digest(custody.primary) !== digest(authority.enrollment.body.primary))
    refuse("W2_NEGATIVE_ACTUAL_INDEPENDENT_DATABASE_CUSTODY_REQUIRED");
  if (raw !== null && (!Object.hasOwn(raw, "candidateRow") || !Object.hasOwn(raw, "decision")
    || !Object.hasOwn(raw, "projection") || !Object.hasOwn(raw, "originalUpperCaptured")
    || typeof raw.originalUpperCaptured !== "boolean"))
    refuse("W2_NEGATIVE_ACTUAL_COMPLETE_DATABASE_OBSERVATION_REQUIRED");
  return actualDatabaseOutcomeSchema.parse({
    schema: "finnor.w2.actual-independent-original-database-outcome.v1",
    enrollmentDigest: authority.enrollment.digest, publicationId, observedMonotonicNs: String(process.hrtime.bigint()),
    authorityRole: authority.config.role, sqlLogin: authority.enrollment.body.roles.candidate,
    tlsCertificateSha256: authority.config.tlsCertificateSha256, primaryDigest: digest(custody.primary),
    authorityCustodyDigest: digest(custody), originalObservationDigest: digest(raw),
    candidatePresent: raw !== null && raw.candidateRow !== null,
    originalUpperCaptured: raw?.originalUpperCaptured === true,
    decisionPresent: raw !== null && raw.decision !== null, projectionPresent: raw !== null && raw.projection !== null,
  });
}

/** One real original. No recovery/claim synthesis, provider retry, renewed P3 or candidate resubmit. */
export async function produceGenuineOriginalPublicationEpisode(input: GenuineOriginalPublicationEpisodeInput) {
  let artifacts: QualifiedFixtureArtifacts | undefined;
  let authority: CandidateAuthority | undefined, primary: FirstFailure | undefined, fixtureSha256: string | null = null;
  let proofSession: QualifiedOriginalRoleSession | undefined, projectionSession: QualifiedOriginalRoleSession | undefined;
  let proofOutcome: z.infer<typeof qualifiedOriginalRoleReceiptSchema> | null = null;
  let projectionOutcome: z.infer<typeof qualifiedOriginalRoleReceiptSchema> | null = null;
  let originalSignal = input.signal;
  let negativeExpectation: GenuineOriginalNegativeExpectation | null = null;
  let programmeId: string | null = null, intakeAccepted = false, observerInvocationCount = 0;
  const state: {
    publicationId: string | null; registration: SourceRegistration | null;
    originEvidence: ActualOriginalFailureEvidence | null; sourceReadyObserved: boolean; qualifiedSourceReady: boolean;
    handlerFailure?: FirstFailure; owningFailure?: FirstFailure;
  } = { publicationId: null, registration: null, originEvidence: null, sourceReadyObserved: false, qualifiedSourceReady: false };
  let databaseOutcome: z.infer<typeof actualDatabaseOutcomeSchema> | null = null;
  const secondaryFailureCodes: string[] = [], phaseEvidence: z.infer<typeof phaseEvidenceSchema>[] = [];
  let produced: { episode: GenuineOriginalPublicationEpisode; witnessDigest: string;
    proof: z.infer<typeof qualifiedOriginalRoleReceiptSchema>; projection: z.infer<typeof qualifiedOriginalRoleReceiptSchema>;
    decisionDigest: string; projectionDigest: string; lane: QualifiedPublicationFixture["lane"] } | undefined;
  try {
    artifacts = await reserveQualifiedFixtureArtifacts(input.artifactDirectory);
    const loaded = await readPrivateQualifiedFixture(input.fixturePath, qualifiedPublicationFixtureSchema), f = loaded.fixture;
    fixtureSha256 = loaded.fixtureSha256;
    const mode = modeSchema.parse(input.mode ?? "GENUINE_POSITIVE");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(f.maximumWallMs)]);
    originalSignal = signal;
    negativeExpectation = input.negativeExpectation
      ? genuineOriginalNegativeExpectationSchema.parse(input.negativeExpectation)
      : mode === "ORIGIN_NEGATIVE_NO_MODEL" ? {
        basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "CONTROLLER", event: "ABORT",
      } : null;
    signal.throwIfAborted();
    if (f.original.operations.length !== 1 || f.original.outcome.tasks.length !== 1
      || !specialistComputationSchema.safeParse(f.original.operations[0]!.computation).success
      || f.original.outcome.tasks.some(task => task.assignmentMode !== "INTERNAL_AUTHORIZED")
      || Date.parse(f.original.outcome.deadline) <= Date.now())
      refuse("W2_GENUINE_SINGLE_INTERNAL_SPECIALIST_ORIGINAL_REQUIRED");
    // Host GO never permits this default positive to reach intake without paid approval.
    const approval = mode === "GENUINE_POSITIVE"
      ? await actualOutsideModelApproval({ authorization: input.outsideModelAuthorization, fixture: f, fixtureSha256 }) : null;
    signal.throwIfAborted();
    const config = await readOriginPublicConfiguration();
    if (process.platform !== "linux" || !process.getuid?.() || process.getuid() !== config.sourceUid
      || process.getgid?.() !== config.sourceGid) refuse("W2_GENUINE_ORIGINAL_SOURCE_OS_IDENTITY_REQUIRED");
    const database = (await getPool().query(`SELECT current_database() database,
      (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) database_oid,
      session_user login,current_user actor,
      r.rolsuper,r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`)).rows[0];
    signal.throwIfAborted();
    if (database?.database !== f.database || database.login !== f.workerSqlLogin || database.actor !== database.login
      || database.rolsuper || database.rolbypassrls) refuse("W2_GENUINE_DISPOSABLE_WORKER_LOGIN_REQUIRED");
    authority = await openWorkforceSpecialistPublicationAuthority("candidate", false);
    assertOriginConfiguration(authority.enrollment, config); signal.throwIfAborted();
    if (authority.enrollment.digest !== f.enrollmentDigest || authority.enrollment.body.tenantId !== f.tenantId
      || authority.enrollment.body.principalId !== f.principalId
      || authority.enrollment.body.primary.databaseOid !== database.database_oid)
      refuse("W2_GENUINE_FIXTURE_ENROLLMENT_REQUIRED");
    const separation = await readQualifiedOriginalRoleSeparation({ authority, config, workerSqlLogin: f.workerSqlLogin });
    signal.throwIfAborted();
    if (mode === "GENUINE_POSITIVE") {
      const original = { runId: f.runId, fixtureSha256: loaded.fixtureSha256,
        enrollmentDigest: f.enrollmentDigest, originalWorkId: f.workId };
      // Authenticate BOTH real services before any paid intake/model boundary.
      proofSession = await openQualifiedOriginalRoleSession({ socketPath: f.proofSocketPath, separation, config,
        original: { ...original, role: "proof" }, signal });
      projectionSession = await openQualifiedOriginalRoleSession({ socketPath: f.projectionSocketPath, separation, config,
        original: { ...original, role: "projection" }, signal });
      signal.throwIfAborted();
    }
    const ctx = rootContext({ tenant_id: f.tenantId, principal_id: f.principalId });
    const prior = await tx(ctx, async c => (await c.query(`SELECT
      (SELECT count(*) FROM finnor_os.w2_programs WHERE tenant_id=$1 AND work_id=$2)::integer programmes,
      (SELECT count(*) FROM finnor_os.jobs WHERE status IN('queued','running'))::integer pending_jobs`,
    [f.tenantId, f.workId])).rows[0]);
    signal.throwIfAborted();
    if (prior?.programmes !== 0 || prior.pending_jobs !== 0) refuse("W2_SINGLE_NEW_ORIGINAL_ONLY_NO_RETRY");
    const accepted = await intakeWorkforceExecution(ctx, { workId: f.workId,
      idempotencyKey: "qualified-original:" + f.runId, original: f.original });
    if (accepted.semanticReplay) refuse("W2_SINGLE_NEW_ORIGINAL_ONLY_NO_RETRY");
    programmeId = accepted.id; intakeAccepted = true;
    const observer = async (phase: Parameters<OriginalOriginOwningObserver>[0],
      actual: ActualOriginalOriginOwningView, bind: () => void) => {
      observerInvocationCount++;
      const capture = (edge: "BEFORE_OBSERVER" | "AFTER_OBSERVER") => {
        if (phaseEvidence.length >= 1024) refuse("W2_GENUINE_ORIGINAL_PHASE_EVIDENCE_BOUND");
        phaseEvidence.push(phaseEvidenceSchema.parse({
          phase, edge, invocation: observerInvocationCount,
          atMonotonicNs: String(process.hrtime.bigint()), registrationDigest: digest(actual.registration),
          workerPid: process.pid, guardianPid: actual.registration.nativeBootstrap.guardianPid,
          guestPid: actual.registration.nativeBootstrap.guestPid, jobId: actual.execution.jobId,
          claimFence: actual.execution.claimFence, lastCensusDigest: actual.lastCensus ? digest(actual.lastCensus) : null,
          originalAborted: actual.originalSignal.aborted, combinedAborted: actual.combined.aborted,
          p3Aborted: actual.p3.signal.aborted, controllerAborted: actual.controller.signal.aborted,
          socketDestroyed: actual.sourceSocket.destroyed,
        }));
      };
      try {
        if (actual.registration.enrollmentDigest !== f.enrollmentDigest
          || actual.registration.binding.originalWorkId !== f.workId
          || actual.registration.binding.originalInputId !== accepted.workInputId
          || actual.registration.binding.programmeId !== programmeId
          || actual.registration.sourcePid !== process.pid
          || actual.registration.binding.job.id !== actual.execution.jobId
          || actual.registration.binding.job.claimFence !== actual.execution.claimFence)
          refuse("W2_OWNING_OBSERVER_FOREIGN_ORIGINAL");
        state.publicationId ??= actual.registration.publicationId;
        if (state.publicationId !== actual.registration.publicationId) refuse("W2_OWNING_OBSERVER_REPLACEMENT_ORIGINAL");
        state.registration ??= immutable(structuredClone(actual.registration));
        if (digest(actual.registration) !== digest(state.registration))
          refuse("W2_OWNING_OBSERVER_REGISTRATION_CHANGED");
        bind(); signal.throwIfAborted();
        capture("BEFORE_OBSERVER");
        const beforeObserver = phaseEvidence.at(-1)!.atMonotonicNs;
        if (phase === "SOURCE_READY") {
          state.sourceReadyObserved = true;
          if (mode === "GENUINE_POSITIVE" && (!approval
            || Date.parse(approval.validUntil) <= Date.parse(actual.registration.binding.effectiveDeadline)))
            refuse("W2_OUTSIDE_MODEL_APPROVAL_DOES_NOT_ENCLOSE_ORIGINAL");
          state.qualifiedSourceReady = true;
        }
        let callbackFailure: FirstFailure | undefined;
        try { await input.observe?.(phase, actual); }
        catch (error) { callbackFailure = { error }; state.owningFailure ??= callbackFailure; }
        finally {
          if (phase === "SOURCE_READY" && mode === "ORIGIN_NEGATIVE_NO_MODEL") {
            // This mandatory stop also runs when the external observer throws.
            actual.controller.abort(Error("W2_OWNING_NO_MODEL_SOURCE_READY_STOP"));
            try { await actual.drainNegativeRecords(); }
            catch (error) { if (callbackFailure === undefined) callbackFailure = { error };
              else secondaryFailureCodes.push(safeCode(error)); }
          }
          try {
            if (negativeExpectation && phase === negativeExpectation.phase && state.qualifiedSourceReady) {
              signal.throwIfAborted();
              // Read before real handler teardown, so cleanup/P3 exit cannot
              // turn an unrelated callback exception into an expected fault.
              const raw = actual.sourceSocket.destroyed
                ? await readExistingOriginalFailureEvidence({
                  enrollment: authority!.enrollment, publicationId: actual.registration.publicationId,
                  originalSourceDigest: actual.registration.originalSourceDigest, signal,
                })
                : await actual.readActualFailureEvidence();
              const verified = await verifyActualOriginalFailureEvidence({
                enrollment: authority!.enrollment, publicationId: actual.registration.publicationId,
                originalSourceDigest: state.registration!.originalSourceDigest,
                evidence: raw, expectedRequestId: raw.requestId, expectedRegistration: state.registration!,
              });
              const through = process.hrtime.bigint(), expected = negativeExpectation;
              const origins = authority!.enrollment.body.origins;
              const first = verified.origins[0]!.snapshot.body;
              const concrete = first.basis === expected.basis && (expected.basis === "JOURNAL_CONTINUITY_LOST"
                ? first.damagedOriginIds.some(id => origins.some(origin => origin.id === id && origin.kind === expected.originKind))
                : verified.origins.some(item => origins.some(origin => origin.id === item.originId && origin.kind === expected.originKind)
                  && item.records.some(record => {
                    if (record.body.operation !== "REVOCATION") return false;
                    const fault = signedRevocationSchema.parse(record.body.value).body;
                    return fault.event === expected.event && BigInt(fault.learnedMonotonicNs) >= BigInt(beforeObserver)
                      && BigInt(fault.learnedMonotonicNs) <= through;
                  })));
              if (!concrete) refuse("W2_GENUINE_EXPECTED_LIVE_PHASE_FAULT_RECEIPT_REQUIRED");
              state.originEvidence = immutable(verified);
            }
          } catch (evidenceError) {
            if (callbackFailure === undefined) callbackFailure = { error: evidenceError };
            else secondaryFailureCodes.push(safeCode(evidenceError));
          }
          try { capture("AFTER_OBSERVER"); }
          catch (captureError) { if (callbackFailure === undefined) callbackFailure = { error: captureError };
            else secondaryFailureCodes.push(safeCode(captureError)); }
        }
        if (callbackFailure !== undefined) throw callbackFailure.error;
        if (state.originEvidence && negativeExpectation?.phase === phase)
          refuse("W2_OWNING_AUTHENTICATED_EXPECTED_PHYSICAL_NEGATIVE");
        if (phase === "SOURCE_READY" && mode === "ORIGIN_NEGATIVE_NO_MODEL")
          refuse("W2_OWNING_NEGATIVE_STOPPED_BEFORE_MODEL_POSSIBLE");
        signal.throwIfAborted();
      } catch (error) { state.owningFailure ??= { error }; throw error; }
    };
    const queue = new JobQueue(f.workerInstanceId, f.leaseSeconds);
    queue.register("run_workforce_execution_v1", async (payload, execution) => {
      const lifecycle: {
        phase: "RUNNING" | "DRAINING" | "CLOSED"; source: ActualOriginalOriginOwningView | null;
      } = { phase: "RUNNING", source: null };
      const observing = new Set<Promise<void>>();
      const abortSource = () => {
        if (lifecycle.phase === "CLOSED" || !signal.aborted || !lifecycle.source
          || lifecycle.source.controller.signal.aborted) return;
        state.owningFailure ??= { error: signal.reason };
        lifecycle.source.controller.abort(signal.reason);
      };
      const observe: OriginalOriginOwningObserver = async (phase, actual) => {
        if (lifecycle.phase !== "RUNNING") return;
        const pending = observer(phase, actual, () => {
          if (lifecycle.source && lifecycle.source.controller !== actual.controller)
            refuse("W2_OWNING_OBSERVER_REPLACEMENT_CONTROLLER");
          if (!lifecycle.source) {
            lifecycle.source = actual;
            signal.addEventListener("abort", abortSource, { once: true });
          }
          abortSource();
        });
        observing.add(pending);
        try { await pending; } finally { observing.delete(pending); }
      };
      try {
        if (!execution || payload.tenantId !== f.tenantId || payload.principalId !== f.principalId
          || payload.programId !== programmeId || !["COMPILE", "ADVANCE"].includes(String(payload.phase)))
          refuse("W2_REAL_QUEUED_ORIGINAL_HANDLER_REQUIRED");
        signal.throwIfAborted();
        await withOriginalOriginOwningFixture(observe, () => runWorkforceExecutionJob(payload, execution));
      } catch (error) {
        state.handlerFailure ??= { error }; state.owningFailure ??= state.handlerFailure; throw error;
      } finally {
        lifecycle.phase = "DRAINING";
        try {
          // Control-channel barrier observers can outlive the main worker await.
          await Promise.allSettled([...observing]);
          // Source scope owns its live drain; never probe the closed view here.
        } catch (error) {
          if (state.owningFailure === undefined && state.handlerFailure === undefined) {
            state.handlerFailure = { error }; throw error;
          }
          secondaryFailureCodes.push(safeCode(error));
        } finally {
          lifecycle.phase = "CLOSED";
          signal.removeEventListener("abort", abortSource);
          lifecycle.source = null;
        }
      }
    }, PRODUCTION_JOB_CONTRACTS.run_workforce_execution_v1);
    for (let tick = 0; tick < f.maximumTicks; tick++) {
      signal.throwIfAborted(); await queue.tick(signal); signal.throwIfAborted();
      if (state.owningFailure !== undefined) throw state.owningFailure.error;
      if (state.handlerFailure !== undefined) throw state.handlerFailure.error;
      if (state.publicationId) {
        const publicationId = state.publicationId;
        const observed = await authority.observeOriginal(publicationId); signal.throwIfAborted();
        if (observed?.candidateRow && observed.originalUpperCaptured === true) {
          if (mode !== "GENUINE_POSITIVE" || !approval || !state.sourceReadyObserved
            || !phaseEvidence.some(event => event.phase === "AFTER_ORIGINAL_FINALIZE"))
            refuse("W2_NO_SUCCESS_EPISODE_WITHOUT_AUTHORIZED_REAL_FINALIZE");
          const row = observed.candidateRow, candidate = candidateSchema.parse(row.candidate);
          const pre = observationSchema.parse(row.pre_observation), post = observationSchema.parse(observed.postObservation);
          const originalSourceDigest = digest({ intent: row.original_intent, nativeReady: row.original_sources.nativeReady });
          if (candidate.programmeId !== programmeId || candidate.originalWorkId !== f.workId
            || candidate.originalInputId !== accepted.workInputId || candidate.publicationId !== publicationId
            || candidate.enrollmentDigest !== f.enrollmentDigest || row.candidate_digest !== digest(candidate))
            refuse("W2_GENUINE_ACTUAL_ORIGINAL_CANDIDATE_IDENTITY_REQUIRED");
          const witness = await readOriginalPublicationWitness({ directory: authority.config.witnessDirectory,
            expectedDirectory: authority.config.witnessDirectory, enrollment: authority.enrollment,
            candidate, pre, post, originalSourceDigest, signal });
          assertVerifiedPublicationWitnessCurrentTails(witness); signal.throwIfAborted();
          const envelope = z.object({ clock: signed(clockSealSchema),
            origins: z.array(z.array(signed(originSealSchema))), physicalEvents: z.array(signed(z.unknown())) })
            .passthrough().parse(witness.evidence.witness);
          if (!proofSession || !projectionSession) refuse("W2_GENUINE_PREFLIGHTED_SEPARATE_SERVICES_REQUIRED");
          const request = { publicationId: candidate.publicationId, candidateDigest: digest(candidate),
            originalSourceDigest, programmeId: accepted.id, originalInputId: accepted.workInputId };
          const proof = await proofSession.run(request);
          const projection = await projectionSession.run(request);
          const actual = await authority.observeOriginal(publicationId); signal.throwIfAborted();
          const decision = actual?.decision, projected = actual?.projection;
          if (actual?.originalUpperCaptured !== true || digest(actual.candidateRow?.candidate) !== digest(candidate)
            || digest(actual.postObservation) !== digest(post)
            || decision?.schema !== "finnor.w2.verified-original-publication-decision.v1"
            || decision.status !== "ACCEPTED_ORIGINAL_COMMIT" || decision.publicationId !== publicationId
            || decision.candidateDigest !== digest(candidate) || decision.xid8 !== pre.xid8
            || decision.proposedDeltaDigest !== candidate.proposedDeltaDigest
            || decision.witnessDigest !== witness.evidenceDigest || digest(decision.interval) !== digest(witness.interval)
            || digest(decision.primary) !== digest(candidate.primary) || decision.historicalCheck?.valid !== true
            || decision.originalOnly !== true || decision.currentAuthorityGranted !== false || decision.budgetRenewed !== false
            || decision.physicalReplayPermitted !== false || projected?.status !== "APPLIED_ORIGINAL_HISTORY"
            || projected.publication_id !== publicationId || projected.tenant_id !== f.tenantId
            || projected.decision_digest !== digest(decision)
            || proof.reply.decisionDigest !== digest(decision) || projection.reply.decisionDigest !== digest(decision)
            || projection.reply.projectionDigest !== digest(projected) || proof.actualPeer.pid === projection.actualPeer.pid
            || proof.reply.status !== "ORIGINAL_DECISION_RECORDED" || projection.reply.status !== "APPLIED_ORIGINAL_HISTORY")
            refuse("W2_ACTUAL_INDEPENDENT_PROOF_PROJECTION_WITNESS_CROSS_READ_REQUIRED");
          const episode = genuineOriginalPublicationEpisodeSchema.parse({
            schema: "finnor.w2.genuine-original-publication-episode.v1", enrollmentDigest: f.enrollmentDigest,
            publicationId, originalSourceDigest, witnessDirectory: authority.config.witnessDirectory,
            candidate, pre, post, clock: envelope.clock, origins: envelope.origins, physicalEvents: envelope.physicalEvents,
          });
          produced = { episode, witnessDigest: witness.evidenceDigest, proof, projection,
            decisionDigest: digest(decision), projectionDigest: digest(projected), lane: f.lane };
          break;
        }
      }
      const uncertain = await tx(ctx, async c => (await c.query(`SELECT count(*)::integer count FROM finnor_os.w2_events
        WHERE tenant_id=$1 AND program_id=$2 AND kind IN('READ_ONLY_RECOVERY','SPECIALIST_REFUSED')`,
      [f.tenantId, programmeId])).rows[0]?.count);
      signal.throwIfAborted();
      if (uncertain) refuse("W2_ORIGINAL_UNCERTAIN_OR_REFUSED_NO_REPLACEMENT_TICK");
      await delay(250, undefined, { signal });
    }
    if (!produced) refuse("W2_GENUINE_ORIGINAL_EPISODE_OBSERVER_BOUND");
  } catch (error) {
    primary = state.owningFailure ?? state.handlerFailure ?? { error };
    const publicationId = state.publicationId, originalRegistration = state.registration;
    const authenticatedOriginEvidence = state.originEvidence;
    if (authority && publicationId) {
      if (authenticatedOriginEvidence && originalRegistration && proofSession && projectionSession) {
        try {
          originalSignal.throwIfAborted();
          const original = await authority.observeOriginal(publicationId);
          originalSignal.throwIfAborted();
          if (original?.candidateRow) {
            const row = original.candidateRow, candidate = candidateSchema.parse(row.candidate);
            const sourceDigest = digest({ intent: row.original_intent, nativeReady: row.original_sources.nativeReady });
            if (candidate.publicationId !== publicationId || candidate.enrollmentDigest !== authority.enrollment.digest
              || candidate.originalWorkId !== originalRegistration.binding.originalWorkId
              || candidate.originalInputId !== originalRegistration.binding.originalInputId
              || candidate.programmeId !== originalRegistration.binding.programmeId
              || sourceDigest !== originalRegistration.originalSourceDigest || row.candidate_digest !== digest(candidate))
              refuse("W2_NEGATIVE_ACTUAL_ORIGINAL_CANDIDATE_REQUIRED");
            const request = { publicationId: candidate.publicationId, candidateDigest: digest(candidate),
              originalSourceDigest: sourceDigest, programmeId: candidate.programmeId, originalInputId: candidate.originalInputId };
            proofOutcome = await proofSession.run(request);
            // Never project a known unexpected accepted proof in a negative case.
            if (proofOutcome.reply.status !== "ORIGINAL_NOT_PROVEN")
              refuse("W2_NEGATIVE_UNEXPECTED_ACTUAL_POSITIVE_PROOF");
            projectionOutcome = await projectionSession.run(request);
            if (projectionOutcome.reply.status !== "ORIGINAL_NOT_PROJECTED")
              refuse("W2_NEGATIVE_UNEXPECTED_ACTUAL_POSITIVE_PROJECTION");
          }
        } catch (serviceError) { secondaryFailureCodes.push(safeCode(serviceError)); }
      }
      try {
        originalSignal.throwIfAborted();
        const observed = await actualDatabaseOutcome(authority, publicationId);
        originalSignal.throwIfAborted(); databaseOutcome = observed;
      }
      catch (readbackError) { secondaryFailureCodes.push(safeCode(readbackError)); }
    }
  } finally {
    for (const session of [proofSession, projectionSession]) {
      try { session?.close(); } catch (closeError) {
        if (primary === undefined) primary = { error: closeError }; else secondaryFailureCodes.push(safeCode(closeError));
      }
    }
    try { await authority?.close(); } catch (closeError) {
      if (primary === undefined) primary = { error: closeError }; else secondaryFailureCodes.push(safeCode(closeError));
    }
  }
  const { publicationId, registration: originalRegistration, originEvidence: authenticatedOriginEvidence,
    sourceReadyObserved, qualifiedSourceReady } = state;
  if (primary === undefined && produced) {
    try {
      originalSignal.throwIfAborted();
      if (!artifacts) refuse("W2_GENUINE_ARTIFACT_RESERVATION_REQUIRED");
      const readback = await artifacts.write("genuine-original-independent-readback.json", {
        schema: "finnor.w2.genuine-original-independent-readback.v1", status: "ACTUAL_SEPARATE_PROOF_PROJECTION",
        fixtureSha256, programmeId, lane: produced.lane, witnessDigest: produced.witnessDigest,
        proof: produced.proof, projection: produced.projection, decisionDigest: produced.decisionDigest,
        projectionDigest: produced.projectionDigest, historicalProjectionChecked: true,
      });
      originalSignal.throwIfAborted();
      const receipt = await artifacts.write("genuine-original-episode.json", produced.episode);
      originalSignal.throwIfAborted();
      return Object.freeze({ episode: immutable(produced.episode), episodePath: receipt.path, episodeSha256: receipt.sha256,
        independentReadbackPath: readback.path, independentReadbackSha256: readback.sha256,
        programmeId: programmeId!, fixtureSha256: fixtureSha256!, observerInvocationCount, historicalProjectionChecked: true as const });
    } catch (error) { primary = { error }; }
  }
  primary ??= { error: Error("W2_GENUINE_ORIGINAL_PRODUCER_NO_RESULT") };
  // No exception or observer assertion alone establishes a physical negative.
  const actualNegative = qualifiedSourceReady && intakeAccepted && !!authenticatedOriginEvidence
    && !!databaseOutcome && !databaseOutcome.decisionPresent && !databaseOutcome.projectionPresent
    && (!databaseOutcome.candidatePresent || proofOutcome?.reply.status === "ORIGINAL_NOT_PROVEN"
      && projectionOutcome?.reply.status === "ORIGINAL_NOT_PROJECTED");
  let failure = genuineOriginalPublicationFailureSchema.parse({
    schema: "finnor.w2.genuine-original-publication-failure.v1",
    status: actualNegative ? "ACTUAL_NEGATIVE_OBSERVED" : qualifiedSourceReady ? "FAILED_UNQUALIFIED" : "NOT_RUN",
    fixtureSha256, publicationId, programmeId, intakeAccepted, sourceReadyObserved,
    originalSourceDigest: originalRegistration?.originalSourceDigest ?? null, negativeExpectation,
    allOriginGenesisVerified: !!authenticatedOriginEvidence, faultReceiptVerified: !!authenticatedOriginEvidence,
    authenticatedOriginEvidenceDigest: authenticatedOriginEvidence ? digest(authenticatedOriginEvidence) : null,
    authenticatedOriginEvidence,
    databaseOutcome, proofOutcome, projectionOutcome, observerInvocationCount, phaseEvidence, failureCode: safeCode(primary.error),
    secondaryFailureCodes: secondaryFailureCodes.slice(0, 32), originalOnly: true,
    modelReplayPermitted: false, qualificationGranted: false,
  });
  let artifactPath: string | null = null, artifactSha256: string | null = null;
  try {
    if (!artifacts) refuse("W2_GENUINE_FAILURE_ARTIFACT_RESERVATION_UNAVAILABLE");
    const receipt = await artifacts.write("actual-original-failure.json", failure);
    artifactPath = receipt.path; artifactSha256 = receipt.sha256; }
  catch (writeError) { failure = genuineOriginalPublicationFailureSchema.parse({ ...failure,
    secondaryFailureCodes: [...failure.secondaryFailureCodes, safeCode(writeError)].slice(0, 32) }); }
  const error: GenuineOriginalPublicationFailureError = Object.assign(Error(failure.failureCode), {
    failure: immutable(failure), artifactPath, artifactSha256, originalCause: primary.error,
  });
  actualFailures.add(error); throw Object.freeze(error);
}
