/** The 17 preregistered owning cases. Never substitutes a fake issuer/clock,
 * post-code unit fixture, callback exception or cleanup-only fault for E2E.
 * Every run needs genuine qualified inputs. This file grants no execution.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { VerifiedEnrollment } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { rootContext, tx } from "../../packages/orchestration/src/workforce-execution/store";
import { digest } from "../../packages/capability-evolution/src/contracts";
import { assertVerifiedEnrollment, assertAllOriginCoverage, encloseOriginalCommit, verifyClockSeal } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { openWorkforceSpecialistPublicationAuthority } from "../../packages/capability-evolution/src/specialist-consumer";
import { readOriginalPublicationWitness, assertVerifiedPublicationWitnessCurrentTails } from "../../packages/governed-execution/src/specialist-publication-witness";
import { readCurrentOriginalOriginCoverage, assertVerifiedCurrentOriginalOriginTails } from "../../packages/governed-execution/src/specialist-origin-collector-client";
import { signedRevocationSchema } from "../../packages/governed-execution/src/specialist-origin-contract";
import { connectRootOriginEndpoint, OriginFrames, readOriginPublicConfiguration } from "../../packages/governed-execution/src/specialist-origin-custody";
import {
  produceGenuineOriginalPublicationEpisode, genuineOriginalPublicationEpisodeSchema,
  assertGenuineOriginalPublicationFailure, assertActualGenuineOriginalPublicationNegative,
  type GenuineOriginalNegativeExpectation, type GenuineOriginalPublicationEpisodeInput,
  type ActualOriginalOriginOwningView, type OriginalOriginOwningObserver,
} from "./qualified-publication-fixture.mts";
import { ordinaryQueuedPreservationEpisodeSchema, produceOrdinaryQueuedPreservationEpisode } from "./qualified-ordinary-queue-fixture.mts";
import { callQualifiedOriginalRootFault, type originalRootFaultOperations } from "./specialist-origin-fault-driver.mts";
import { readPrivateQualifiedFixture, reserveQualifiedFixtureArtifacts } from "./qualified-fixture-custody.mts";
type Operation = typeof originalRootFaultOperations[number];
export const specialistOriginOwningCases = Object.freeze([
  [1, "all exact enrolled IDs and more than seven", true],
  [2, "existing enrolled private-key custody change", false],
  [3, "original source loss cannot be reopened", false],
  [4, "absent original source cannot give healthy empty coverage", false],
  [5, "actual corrupt/torn durable journal suffix", false],
  [6, "actual original guardian pidfd exit", false],
  [7, "actual original job claim-fence revocation", false],
  [8, "actual original P3 lease release", false],
  [9, "actual original controller and combined abort", false],
  [10, "loss of the actual original S8 reader authority", false],
  [11, "actual qualified source-byte change", false],
  [12, "delayed actual abort retains earlier effective time", false],
  [13, "actual durable journal byte-bound exhaustion", false],
  [14, "wrong original candidate/observations/clock refuse", true],
  [15, "actual correctly signed prefix rollback refuses", true],
  [16, "aborted actual current-tail collector returns no proof", true],
  [17, "actual ordinary queued handler stays observer-free", false],
] as const);
export interface SpecialistOriginOwningCaseInput {
  readonly caseNumber: number;
  readonly fixturePath: string; readonly artifactDirectory: string; readonly signal: AbortSignal;
  readonly outsideModelAuthorization?: GenuineOriginalPublicationEpisodeInput["outsideModelAuthorization"];
  readonly rootFault?: Readonly<{ socketPath: string; authorizationId: string }>;
  /** Optional actual clock-step variant; requires explicit isolated root clock authority. */
  readonly actualClockStep?: boolean;
  readonly nativeLoss?: "GUARDIAN_PIDFD_EXIT" | "CGROUP_CONTROL_LOSS";
  readonly p3Index?: 0 | 1 | 2;
}
export interface SpecialistOriginOwningCaseResult {
  readonly caseNumber: number; readonly status: "ACTUAL_OWNING_ASSERTIONS_PASSED" | "NOT_RUN" | "FAILED_UNQUALIFIED" | "FAILED";
  readonly code: string; readonly artifactPath: string | null; readonly artifactSha256: string | null;
  readonly productionApproval: false; readonly originalReplayed: false;
}
const rootOperations = new Map<number, Operation>([
  [2, "CHANGE_EXISTING_KEY_MODE"], [5, "CORRUPT_JOURNAL_SUFFIX"], [6, "KILL_ORIGINAL_GUARDIAN"],
  [11, "CHANGE_WATCHED_SOURCE_BYTE"], [13, "EXHAUST_JOURNAL_BYTE_BOUND"], [15, "ROLLBACK_SIGNED_PREFIX"],
]);
const expectations = new Map<number, GenuineOriginalNegativeExpectation>([
  [2, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "GUARDIAN", event: "SOURCE_CHANGE" }],
  [3, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "GUARDIAN", event: "SOURCE_CHANGE" }],
  [4, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "GUARDIAN", event: "SOURCE_CHANGE" }],
  [5, { basis: "JOURNAL_CONTINUITY_LOST", phase: "SOURCE_READY", originKind: "GUARDIAN" }],
  [6, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "GUARDIAN", event: "PROCESS_LOSS" }],
  [7, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "JOB", event: "AUTHORITY_LOSS" }],
  [8, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "P3", event: "AUTHORITY_LOSS" }],
  [9, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "CONTROLLER", event: "ABORT" }],
  [10, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "S8_AUTHORITY", event: "AUTHORITY_LOSS" }],
  [11, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "SOURCE_RUNTIME_HOST", event: "SOURCE_CHANGE" }],
  [12, { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "CONTROLLER", event: "ABORT" }],
  [13, { basis: "JOURNAL_CONTINUITY_LOST", phase: "SOURCE_READY", originKind: "GUARDIAN" }],
  [15, { basis: "JOURNAL_CONTINUITY_LOST", phase: "AFTER_ORIGINAL_FINALIZE", originKind: "CONTROLLER" }],
]);
function safeResult(input: SpecialistOriginOwningCaseInput, status: SpecialistOriginOwningCaseResult["status"],
  code: string, artifactPath: string | null = null, artifactSha256: string | null = null): SpecialistOriginOwningCaseResult {
  return Object.freeze({ caseNumber: input.caseNumber, status, code, artifactPath, artifactSha256,
    productionApproval: false, originalReplayed: false });
}
async function assertOriginalReopenRefused(actual: ActualOriginalOriginOwningView, signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]), requestId = randomBytes(32).toString("hex"),
    config = await readOriginPublicConfiguration(), connected = await connectRootOriginEndpoint(config.socketPath, config, bounded),
    frames = new OriginFrames(connected.socket);
  try {
    const refused = new Promise<void>((yes, no) => {
      frames.onFailure(() => no(Error("W3_REOPEN_RESULT_UNKNOWN_NOT_A_DEFINITE_REFUSAL")));
      frames.onMessage(raw => {
        try {
          assert.deepEqual(raw, { type: "SOURCE_OPEN_REFUSED", requestId,
            publicationId: actual.registration.publicationId, registrationDigest: digest(actual.registration),
            code: "SPECIALIST_ORIGIN_ORIGINAL_REGISTRATION_REPLAY", newOriginalIssued: false, newCoverageIssued: false }); yes();
        } catch { no(Error("W3_REOPEN_RETURNED_NEW_SOURCE_OR_UNKNOWN_OUTCOME")); }
      });
    });
    void refused.catch(() => undefined);
    await frames.send({ type: "SOURCE_OPEN", requestId, registration: actual.registration });
    await refused; bounded.throwIfAborted();
  } finally { frames.socket.destroy(); }
}
async function realReaderControls(input: SpecialistOriginOwningCaseInput,
  produced: Awaited<ReturnType<typeof produceGenuineOriginalPublicationEpisode>>) {
  const episode = genuineOriginalPublicationEpisodeSchema.parse(produced.episode),
    authority = await openWorkforceSpecialistPublicationAuthority("candidate", true);
  try {
    const e = authority.enrollment, args = { directory: episode.witnessDirectory, expectedDirectory: authority.config.witnessDirectory,
      enrollment: e, candidate: episode.candidate, clock: episode.clock, pre: episode.pre, post: episode.post,
      originalSourceDigest: episode.originalSourceDigest, signal: input.signal };
    assertVerifiedEnrollment(e);
    const first = await readOriginalPublicationWitness(args); assertVerifiedPublicationWitnessCurrentTails(first);
    const second = await readOriginalPublicationWitness(args); assertVerifiedPublicationWitnessCurrentTails(second);
    // Fresh nonces/heads/END tails must NEVER reprice or rewrite frozen evidence.
    assert.equal(first.evidenceDigest, second.evidenceDigest);
    assert.equal(digest(first.evidence), digest(second.evidence));
    assert.throws(() => assertVerifiedPublicationWitnessCurrentTails(JSON.parse(JSON.stringify(first))));
    const clock = verifyClockSeal(e, episode.clock), interval = encloseOriginalCommit(episode.candidate, episode.pre, episode.post, clock);
    if (input.caseNumber === 1) {
      assert.ok(e.body.origins.length > 7, "W3_GENUINE_MORE_THAN_SEVEN_IDS_REQUIRED");
      assert.equal(episode.origins.length, e.body.origins.length);
      assertAllOriginCoverage(e, episode.candidate, interval, episode.origins);
      assert.throws(() => assertAllOriginCoverage(e, episode.candidate, interval, episode.origins.slice(1)));
      assert.throws(() => assertAllOriginCoverage(e, episode.candidate, interval, [...episode.origins.slice(1), episode.origins[1]!]));
      assert.throws(() => assertVerifiedEnrollment(JSON.parse(JSON.stringify(e))));
    } else if (input.caseNumber === 14) {
      await assert.rejects(readOriginalPublicationWitness({ ...args,
        candidate: { ...episode.candidate, jobId: "foreign-original" } }));
      await assert.rejects(readOriginalPublicationWitness({ ...args,
        candidate: { ...episode.candidate, hostDigest: "0".repeat(64) } }));
      await assert.rejects(readOriginalPublicationWitness({ ...args,
        candidate: { ...episode.candidate, bounds: [] } }));
      await assert.rejects(readOriginalPublicationWitness({ ...args,
        pre: { ...episode.pre, xid8: String(BigInt(episode.pre.xid8) + 1n) } }));
      await assert.rejects(readOriginalPublicationWitness({ ...args,
        post: { ...episode.post, commitUtcMicros: String(BigInt(episode.post.commitUtcMicros!) + 1n) } }));
      await assert.rejects(readCurrentOriginalOriginCoverage({ ...args, frozenOrigins: episode.origins,
        clock: { ...episode.clock, signature: "" } }));
    } else {
      const aborted = AbortSignal.abort(Error("W3_ACTUAL_COLLECTOR_ABORT"));
      await assert.rejects(readCurrentOriginalOriginCoverage({ ...args, signal: aborted, frozenOrigins: episode.origins }));
      const metadata = await readCurrentOriginalOriginCoverage({ ...args, frozenOrigins: episode.origins });
      assertVerifiedCurrentOriginalOriginTails(metadata, { ...args, frozenOrigins: episode.origins });
      assert.throws(() => assertVerifiedCurrentOriginalOriginTails(JSON.parse(JSON.stringify(metadata)),
        { ...args, frozenOrigins: episode.origins }));
    }
    const actual = await authority.observeOriginal(episode.publicationId);
    assert.equal(actual?.decision?.status, "ACCEPTED_ORIGINAL_COMMIT");
    assert.equal(actual?.projection?.status, "APPLIED_ORIGINAL_HISTORY");
  } finally { await authority.close(); }
}
/** Each call executes ONE new original only. No retries/reset/cleanup or replay. */
export async function runSpecialistOriginOwningCase(input: SpecialistOriginOwningCaseInput): Promise<SpecialistOriginOwningCaseResult> {
  const descriptor = specialistOriginOwningCases.find(item => item[0] === input.caseNumber);
  if (!descriptor) return safeResult(input, "FAILED_UNQUALIFIED", "W3_UNKNOWN_OWNING_CASE");
  if (input.signal.aborted) return safeResult(input, "NOT_RUN", "W3_NO_AUTHORIZED_ACTIVE_CASE_SIGNAL");
  if (input.caseNumber === 17) {
    try {
      const actual = await produceOrdinaryQueuedPreservationEpisode(input),
        ordinary = ordinaryQueuedPreservationEpisodeSchema.parse(actual.episode);
      assert.equal(ordinary.observerInvocationCount, 0); assert.ok(ordinary.queuedHandlerInvocations >= 2);
      assert.equal(ordinary.providerInvoked, false); assert.equal(ordinary.protectedAuthorityUsed, false);
      return safeResult(input, "ACTUAL_OWNING_ASSERTIONS_PASSED", "W3_ACTUAL_ORDINARY_QUEUE_PRESERVED", actual.episodePath, actual.episodeSha256);
    } catch { return safeResult(input, "FAILED_UNQUALIFIED", "W3_ACTUAL_ORDINARY_QUEUE_NOT_ESTABLISHED"); }
  }
  const clockStep = input.caseNumber === 14 && input.actualClockStep === true,
    cgroupLoss = input.caseNumber === 6 && input.nativeLoss === "CGROUP_CONTROL_LOSS",
    rootOperation = clockStep ? "STEP_ISOLATED_REALTIME" as const : cgroupLoss
      ? "CHANGE_ORIGINAL_CGROUP_CONTROL" as const : rootOperations.get(input.caseNumber);
  if (rootOperation && !input.rootFault)
    return safeResult(input, "NOT_RUN", "W3_EXISTING_QUALIFIED_ROOT_FAULT_AUTHORITY_REQUIRED");
  const paid = descriptor[2] && !clockStep;
  if (paid && !input.outsideModelAuthorization)
    return safeResult(input, "NOT_RUN", "W3_SEPARATE_EXPLICIT_PAID_MODEL_APPROVAL_REQUIRED");
  const expectation = clockStep ? { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY",
    originKind: "GUARDIAN", event: "CLOCK_STEP" } as const : cgroupLoss
      ? { basis: "DURABLE_REVOCATION", phase: "SOURCE_READY", originKind: "GUARDIAN", event: "CGROUP_LOSS" } as const
      : expectations.get(input.caseNumber);
  let actionApplied = false, observerError = false, ready = false, acted = false;
  let actualEnrollment: VerifiedEnrollment | undefined;
  let positiveProduced: Awaited<ReturnType<typeof produceGenuineOriginalPublicationEpisode>> | undefined;
  let abortWindow: { before: bigint; after: bigint; reported: bigint } | undefined;
  const observe: OriginalOriginOwningObserver = async (phase, actual) => {
    if (phase === "SOURCE_READY") {
      ready = true; actualEnrollment = actual.authority.enrollment;
      if (input.caseNumber === 1) {
        // Check BEFORE paid invocation, not after spending on a seven-ID fixture.
        try { assert.ok(actualEnrollment.body.origins.length > 7, "W3_GENUINE_MORE_THAN_SEVEN_IDS_REQUIRED"); }
        catch (error) { observerError = true; throw error; }
      }
    }
    if (!expectation || phase !== expectation.phase || !ready || acted) return;
    acted = true;
    try {
      if (rootOperation) {
        if (input.caseNumber === 15) { actual.controller.abort(Error("W3_REAL_POST_UPPER_ABORT_BEFORE_PREFIX_ROLLBACK"));
          await actual.drainNegativeRecords(); }
        await callQualifiedOriginalRootFault({ ...input.rootFault!, operation: rootOperation, actual, signal: input.signal });
      } else if (input.caseNumber === 3 || input.caseNumber === 4) {
        actual.sourceSocket.destroy(); await immediate();
        if (input.caseNumber === 3) await assertOriginalReopenRefused(actual, input.signal);
      } else if (input.caseNumber === 7) {
        const e = actual.execution, r = actual.registration;
        const revoked = await tx(rootContext({ tenant_id: r.binding.tenantId, principal_id: r.binding.principalId }), c => c.query(`UPDATE finnor_os.jobs SET claim_fence=claim_fence+1
          WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 RETURNING id`,
        [e.jobId, r.binding.tenantId, e.claimToken, e.claimFence]));
        assert.equal(revoked.rowCount, 1);
      } else if (input.caseNumber === 8) {
        const lease = actual.p3.leases[input.p3Index ?? 0]!;
        const r = actual.registration;
        const released = await tx(rootContext({ tenant_id: r.binding.tenantId, principal_id: r.binding.principalId }), c => c.query(`UPDATE finnor_os.compute_resource_leases SET released_at=clock_timestamp()
          WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL RETURNING resource_key`,
        [lease.resourceKey, lease.token, lease.fence, lease.ownerId]));
        assert.equal(released.rowCount, 1);
      } else if (input.caseNumber === 9) {
        actual.controller.abort(Error("W3_ACTUAL_CONTROLLER_AND_COMBINED_ABORT"));
        assert.equal(actual.controller.signal.aborted, true); assert.equal(actual.combined.aborted, true);
      } else if (input.caseNumber === 10) {
        await actual.authority.close();
      } else if (input.caseNumber === 12) {
        actual.sourceSocket.cork();
        const before = process.hrtime.bigint();
        actual.controller.abort(Error("W3_REAL_ABORT_WITH_DELAYED_SOCKET_DELIVERY"));
        const after = process.hrtime.bigint();
        await immediate(); const reported = process.hrtime.bigint(); actual.sourceSocket.uncork();
        abortWindow = { before, after, reported };
      } else throw Error("W3_ACTUAL_CASE_ACTION_NOT_IMPLEMENTED");
      actionApplied = true;
      if (input.caseNumber !== 3 && input.caseNumber !== 4) {
        // A bounded read of the SAME original's existing negative channel, not
        // another original/clock/barrier or retry of the business operation.
        // Allow the real kernel watcher to publish its asynchronous loss.
        for (let read = 0; read < 4; read++) {
          try { await actual.readActualFailureEvidence(); break; }
          catch {
            input.signal.throwIfAborted();
            if (read === 3) throw Error("W3_ACTUAL_FAULT_DID_NOT_REACH_EXISTING_ORIGINAL_JOURNALS");
            await delay(20, undefined, { signal: input.signal });
          }
        }
      }
    } catch (error) { observerError = true; throw error; }
  };
  try {
    const produced = await produceGenuineOriginalPublicationEpisode({
      fixturePath: input.fixturePath, artifactDirectory: input.artifactDirectory, signal: input.signal, observe,
      mode: paid ? "GENUINE_POSITIVE" : "ORIGIN_NEGATIVE_NO_MODEL",
      outsideModelAuthorization: input.outsideModelAuthorization, negativeExpectation: expectation,
    });
    if (expectation) return safeResult(input, "FAILED", "W3_EXPECTED_PHYSICAL_NEGATIVE_RETURNED_A_POSITIVE");
    positiveProduced = produced;
    await realReaderControls(input, produced);
    return safeResult(input, "ACTUAL_OWNING_ASSERTIONS_PASSED", "W3_ACTUAL_ORIGINAL_READER_CONTROLS_PASSED",
      produced.episodePath, produced.episodeSha256);
  } catch (error) {
    if (positiveProduced) return safeResult(input, "FAILED", "W3_ACTUAL_READER_ASSERTION_FAILED",
      positiveProduced.episodePath, positiveProduced.episodeSha256);
    let actualNegativeClassified = false;
    try {
      assertGenuineOriginalPublicationFailure(error);
      if (!expectation || observerError || !actionApplied || !acted)
        return safeResult(input, error.failure.status === "NOT_RUN" ? "NOT_RUN" : "FAILED_UNQUALIFIED",
          "W3_NO_GENUINE_CASE_ACTION_AND_EXPECTED_ORACLE", error.artifactPath, error.artifactSha256);
      assertActualGenuineOriginalPublicationNegative(error);
      actualNegativeClassified = true;
      assert.equal(digest(error.failure.negativeExpectation), digest(expectation));
      if (input.caseNumber === 9 || input.caseNumber === 12) {
        const evidence = error.failure.authenticatedOriginEvidence!;
        const kinds = evidence.origins.filter(origin => origin.records.some(record => record.body.operation === "REVOCATION"))
          .map(origin => origin.originId);
        assert.ok(kinds.length > 0);
        if (input.caseNumber === 9) {
          assert.ok(actualEnrollment);
          for (const kind of ["CONTROLLER", "COMBINED_ABORT"] as const) {
            const ids = actualEnrollment.body.origins.filter(origin => origin.kind === kind).map(origin => origin.id);
            assert.ok(ids.length > 0);
            for (const id of ids) assert.ok(evidence.origins.find(origin => origin.originId === id)?.records.some(record =>
              record.body.operation === "REVOCATION" && signedRevocationSchema.parse(record.body.value).body.event === "ABORT"));
          }
        }
        if (abortWindow) {
          const faults = evidence.origins.flatMap(origin => origin.records.filter(record => record.body.operation === "REVOCATION")
            .map(record => signedRevocationSchema.parse(record.body.value).body));
          assert.ok(faults.some(fault => fault.event === "ABORT" && BigInt(fault.atMonotonicNs) >= abortWindow!.before
            && BigInt(fault.atMonotonicNs) <= abortWindow!.after && BigInt(fault.learnedMonotonicNs) >= abortWindow!.reported));
        }
      }
      return safeResult(input, "ACTUAL_OWNING_ASSERTIONS_PASSED", "W3_EXPECTED_ACTUAL_AUTHENTICATED_NEGATIVE",
        error.artifactPath, error.artifactSha256);
    } catch {
      return safeResult(input, actualNegativeClassified ? "FAILED" : ready ? "FAILED_UNQUALIFIED" : "NOT_RUN",
        "W3_REQUIRED_GENUINE_ORACLE_NOT_ESTABLISHED");
    }
  }
}
export const unsupportedWithoutExistingExternalSupervisor = Object.freeze([
  "Source-worker SIGKILL with branded postmortem: no in-process return is possible.",
  "A separate approved external supervisor is required; this suite never fabricates its evidence.",
]);
const absolute = z.string().min(2).max(4096).refine(isAbsolute);
export const specialistOriginOwningCasePlanSchema = z.object({
  schema: z.literal("finnor.w3.qualified-original-origin-owning-case-plan.v1"),
  caseNumber: z.number().int().min(1).max(17), fixturePath: absolute, artifactDirectory: absolute,
  maximumWallMs: z.number().int().min(1000).max(300000),
  outsideModelAuthorization: z.object({ signedApprovalPath: absolute, existingApproverPublicKeyPath: absolute,
    externallyTrustedPublicKeySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  rootFault: z.object({ socketPath: absolute, authorizationId: z.string().uuid() }).strict().optional(),
  actualClockStep: z.boolean().optional(),
  nativeLoss: z.enum(["GUARDIAN_PIDFD_EXIT", "CGROUP_CONTROL_LOSS"]).optional(),
  p3Index: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.actualClockStep && value.caseNumber !== 14 || value.nativeLoss && value.caseNumber !== 6
    || value.p3Index !== undefined && value.caseNumber !== 8)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "W3_FAULT_VARIANT_MUST_MATCH_ITS_PREREGISTERED_CASE" });
});
/** One case per explicit invocation. Missing/unknown evidence exits nonzero. */
async function owningCaseMain() {
  if (process.argv.length !== 4 || process.argv[2] !== "--run-qualified-case")
    throw Error("W3_QUALIFIED_OWNING_CASE_PLAN_REQUIRED");
  const loaded = await readPrivateQualifiedFixture(process.argv[3]!, specialistOriginOwningCasePlanSchema),
    plan = loaded.fixture, stopped = new AbortController(),
    signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(plan.maximumWallMs)]);
  const stop = () => stopped.abort(Error("W3_OWNING_CASE_OPERATOR_ABORT"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const artifacts = await reserveQualifiedFixtureArtifacts(join(dirname(plan.artifactDirectory), basename(plan.artifactDirectory) + ".owning-result"));
    const result = await runSpecialistOriginOwningCase({ ...plan, signal });
    const receipt = await artifacts.write("owning-case-result.json", {
      schema: "finnor.w3.actual-original-origin-owning-case-result.v1", planSha256: loaded.fixtureSha256,
      descriptor: specialistOriginOwningCases.find(item => item[0] === plan.caseNumber),
      variant: plan.actualClockStep ? "EXPLICIT_ISOLATED_REALTIME_STEP" : plan.nativeLoss
        ?? (plan.caseNumber === 8 ? "ORIGINAL_P3_" + (plan.p3Index ?? 0) : "PREREGISTERED_DEFAULT"),
      result, productionApproval: false, runtimeQualificationGranted: false, noOriginalReplay: true,
    });
    process.stdout.write(JSON.stringify({ ...result, resultArtifactPath: receipt.path, resultArtifactSha256: receipt.sha256 }) + "\n");
    process.exitCode = result.status === "ACTUAL_OWNING_ASSERTIONS_PASSED" ? 0 : 2;
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void owningCaseMain().catch(() => { process.stderr.write("W3_OWNING_CASE_NOT_RUN_OR_UNQUALIFIED\n"); process.exitCode = 2; });
