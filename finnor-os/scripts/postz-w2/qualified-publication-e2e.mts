/** Fixed artifact-producing owning caller, not a host/provider permission grant. */
import { getPool } from "@finnor/db";
import { produceGenuineOriginalPublicationEpisode, assertGenuineOriginalPublicationFailure,
  assertActualGenuineOriginalPublicationNegative } from "./qualified-publication-fixture.mts";
import { produceOrdinaryQueuedPreservationEpisode } from "./qualified-ordinary-queue-fixture.mts";
import { qualifiedFixtureFailureCode, refuseQualifiedFixture as refuse } from "./qualified-fixture-custody.mts";

const args = process.argv.slice(2), [operation, fixturePath, artifactDirectory, signedApprovalPath,
  existingApproverPublicKeyPath, externallyTrustedPublicKeySha256] = args;
if (process.env.FINNOR_W2_GENUINE_FIXTURE_RUNTIME_AUTHORIZED !== "EXPLICIT_EXTERNAL_RUNTIME_GRANT"
  || !fixturePath || !artifactDirectory
  || (operation === "positive" ? args.length !== 6
    : !["ordinary", "source-ready-no-model"].includes(operation ?? "") || args.length !== 3))
  refuse("W2_GENUINE_E2E_EXTERNAL_RUNTIME_GRANT_AND_FIXED_ARGUMENTS_REQUIRED");

// This opt-in prevents accidental entry. It does NOT issue external authority,
// qualify a host, or replace the separate signed paid-model approval.
const controller = new AbortController();
const stop = () => controller.abort(Error("W2_GENUINE_E2E_EXTERNAL_STOP"));
process.once("SIGTERM", stop); process.once("SIGINT", stop);
let primary: { error: unknown } | undefined;
try {
  if (operation === "ordinary") {
    const actual = await produceOrdinaryQueuedPreservationEpisode({
      fixturePath, artifactDirectory, signal: controller.signal });
    console.log(JSON.stringify({ status: actual.episode.status, episodePath: actual.episodePath,
      episodeSha256: actual.episodeSha256, observerInvocationCount: actual.episode.observerInvocationCount,
      wholePhaseQualificationGranted: false }));
  } else {
    const actual = await produceGenuineOriginalPublicationEpisode({
      fixturePath, artifactDirectory, signal: controller.signal,
      mode: operation === "positive" ? "GENUINE_POSITIVE" : "ORIGIN_NEGATIVE_NO_MODEL",
      outsideModelAuthorization: operation === "positive" ? {
        signedApprovalPath: signedApprovalPath!, existingApproverPublicKeyPath: existingApproverPublicKeyPath!,
        externallyTrustedPublicKeySha256: externallyTrustedPublicKeySha256!,
      } : undefined,
    });
    if (operation !== "positive") refuse("W2_NO_MODEL_CALLER_MUST_NOT_PRODUCE_SUCCESS_EPISODE");
    console.log(JSON.stringify({ status: "ACTUAL_GENUINE_ORIGINAL_PUBLICATION_OBSERVED",
      episodePath: actual.episodePath, episodeSha256: actual.episodeSha256,
      independentReadbackPath: actual.independentReadbackPath,
      independentReadbackSha256: actual.independentReadbackSha256, historicalProjectionChecked: true,
      wholePhaseQualificationGranted: false }));
  }
} catch (error) {
  primary = { error };
  let genuine = false;
  try { assertGenuineOriginalPublicationFailure(error); genuine = true; } catch { /* Other genuine failure, never PASS. */ }
  if (genuine) {
    assertGenuineOriginalPublicationFailure(error);
    let actualNegative = false;
    if (operation === "source-ready-no-model") {
      try { assertActualGenuineOriginalPublicationNegative(error); actualNegative = true; }
      catch { /* Missing authenticated fault/readback is NOT_RUN or FAILED_UNQUALIFIED. */ }
    }
    console.log(JSON.stringify({ status: error.failure.status, failureCode: error.failure.failureCode,
      failureArtifactPath: error.artifactPath, failureArtifactSha256: error.artifactSha256,
      sourceReadyObserved: error.failure.sourceReadyObserved, actualNegativeObserved: actualNegative,
      lateOriginCasesQualified: false, wholePhaseQualificationGranted: false }));
    if (actualNegative) primary = undefined;
  } else {
    console.error(JSON.stringify({ status: "NOT_QUALIFIED", failureCode: qualifiedFixtureFailureCode(error),
      wholePhaseQualificationGranted: false }));
  }
} finally {
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  try { await getPool().end(); }
  catch (error) {
    console.error(JSON.stringify({ status: "OWNED_CALLER_TEARDOWN_FAILED",
      secondaryFailureCode: qualifiedFixtureFailureCode(error), wholePhaseQualificationGranted: false }));
    primary ??= { error };
  }
}
if (primary !== undefined) process.exitCode = 1;
