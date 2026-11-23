/** Owning HTTP/native-worker exercise. Missing original human measurements
 * remain missing. Native packet latency is not human time or field service. */
import { strict as assert } from "node:assert";
import type { W5NativeAssignmentRecord, W5ProspectiveTrialRecord } from "../../../packages/epistemic-runtime/src/postz-w5-prospective-trial";
import type { OrganizationReference } from "../../../packages/private-equity/src/organization-transformation/contracts";
import type { OrganizationLivePorts, OrganizationOwnerRead } from "./live-consumer.mjs";

export interface NativeProspectiveUnit { workId: string; workInputId: string; workInputDigest: string }
interface ProspectivePorts extends OrganizationLivePorts { read(): Promise<OrganizationOwnerRead> }
interface ProspectiveInput {
  requestId: string; companyId: string; ownerId: string; evaluatorId: string; digitalId: string;
  originalDeadline: string; key: string; units: readonly NativeProspectiveUnit[];
  evidence: Array<{ field: string; ref: OrganizationReference }>;
}
interface TrialRead {
  access: "OWNER" | "EVALUATOR" | "PARTICIPANT"; trial: W5ProspectiveTrialRecord;
  assignments: W5NativeAssignmentRecord[]; observedAssignmentIds: string[];
  assignmentCheck: { status: string; errors: string[] };
}
const group = "organization/transformation-programs";
export async function observeNativeProspectiveAssignments(ports: ProspectivePorts, input: ProspectiveInput) {
  const checkBound = () => {
    ports.checkBound();
    assert(Date.now() < Date.parse(input.originalDeadline), "W5_PROSPECTIVE_ORIGINAL_DEADLINE_EXHAUSTED");
  };
  checkBound();
  assert(input.units.length >= 40 && input.units.length <= 512, "W5_COMPLETE_ORIGINAL_UNIT_ROSTER_REQUIRED");
  assert.equal(new Set(input.units.map(unit => unit.workId)).size, input.units.length);
  assert.equal(new Set(input.units.map(unit => unit.workInputId)).size, input.units.length);
  const request: OrganizationLivePorts["request"] = async (...args) => {
    checkBound(); const response = await ports.request(...args); checkBound(); return response;
  };
  const post = (operation: string, body: unknown, actor = input.ownerId) =>
    request("POST", group, operation, body, actor);
  const ok = async <T,>(operation: string, body: unknown, actor = input.ownerId): Promise<T> => {
    const response = await post(operation, body, actor); assert.equal(response.status, 200, JSON.stringify(response));
    return response.body as T;
  };
  const trialRead = async (actor = input.ownerId) => {
    const response = await request("GET", group, "trial?requestId=" + input.requestId, undefined, actor);
    assert.equal(response.status, 200, JSON.stringify(response)); return response.body as TrialRead;
  };
  const units = [];
  for (const unit of input.units) {
    const source = await ok<{ ref: OrganizationReference }>("source", {
      workId: unit.workId, kind: "MEASUREMENT", sourceClass: "CONTROLLED", observedAt: new Date().toISOString(),
      validUntil: input.originalDeadline, idempotencyKey: input.key + ":unit:" + unit.workInputId,
      body: { schema: "finnor.organization-prospective-unit.v1", requestId: input.requestId,
        companyId: input.companyId, processId: "resolution", ...unit },
    });
    units.push({ workId: unit.workId, workInputId: unit.workInputId, enrollmentRef: source.ref });
  }
  checkBound(); const before = await ports.read(); checkBound();
  const registrationInput = { requestId: input.requestId, expectedRevision: before.revision,
    idempotencyKey: input.key + ":register", units };
  const registered = await ok<{ trialRef: OrganizationReference; registeredUnitCount: number }>("trial", registrationInput);
  assert.equal(registered.registeredUnitCount, input.units.length);
  const pending = await trialRead(); assert.equal(pending.assignments.length, 0);
  const pendingRefusal = await post("process-use", { requestId: input.requestId, workId: input.units[0]!.workId,
    processId: "resolution", roleId: "digital", evidence: input.evidence,
    idempotencyKey: input.key + ":pending-unit-negative" }, input.digitalId);
  assert.equal(pendingRefusal.status, 409);
  assert.equal((pendingRefusal.body as { error: string }).error, "W5_PENDING_OR_OTHER_TRIAL_UNIT_CANNOT_ENTER_TRANSFORMED_USE");
  checkBound(); await ports.tick(1); checkBound();
  const assigned = await trialRead();
  assert.equal(assigned.assignmentCheck.status, "CHECKED_NATIVE_ASSIGNMENT");
  assert.deepEqual(assigned.assignmentCheck.errors, []);
  assert.equal(assigned.assignments.length, input.units.length);
  assert.deepEqual(assigned.trial.ref, registered.trialRef);
  assert.equal(assigned.trial.body.originalDeadline, input.originalDeadline);
  assert.equal(assigned.trial.body.principalId, input.ownerId);
  assert.equal(assigned.trial.body.evaluatorPrincipalId, input.evaluatorId);
  assert.equal(assigned.trial.body.transformedPrincipalId, input.digitalId);
  const roster = new Map(input.units.map(unit => [unit.workId, unit]));
  assert.equal(new Set(assigned.assignments.map(assignment => assignment.body.unit.workId)).size, input.units.length);
  for (const assignment of assigned.assignments) {
    const original = roster.get(assignment.body.unit.workId);
    assert(original, "W5_NO_REPLACEMENT_OR_SELECTED_TRIAL_UNIT");
    assert.equal(assignment.body.unit.workInputId, original.workInputId);
    assert.equal(assignment.body.unit.workInputDigest, original.workInputDigest);
    assert.deepEqual(assignment.body.trialRef, assigned.trial.ref);
    assert.deepEqual(assignment.body.nativeProvenance.originalBudgetRef, before.nativeBudgetRef);
    assert.equal(assignment.body.nativeProvenance.consumptionRef.owner, "S5");
  }
  const replay = await ok<{ trialRef: OrganizationReference; semanticReplay: boolean }>("trial", registrationInput);
  assert.equal(replay.semanticReplay, true); assert.deepEqual(replay.trialRef, registered.trialRef);
  assert.deepEqual((await trialRead()).assignments, assigned.assignments);
  const evaluator = await trialRead(input.evaluatorId); assert.equal(evaluator.access, "EVALUATOR");
  assert.deepEqual(evaluator.assignments, assigned.assignments);
  const originalArm = assigned.assignments.find(a => a.body.arm === "ORIGINAL");
  let originalArmNegative: unknown = { status: "NOT_OBSERVED_NO_ORIGINAL_UNIT_IN_GENUINE_RANDOM_DRAW" };
  if (originalArm) {
    const refused = await post("process-use", { requestId: input.requestId, workId: originalArm.body.unit.workId,
      processId: "resolution", roleId: "digital", trialAssignmentRef: originalArm.ref,
      evidence: input.evidence, idempotencyKey: input.key + ":original-arm-negative" }, input.digitalId);
    assert.equal(refused.status, 409);
    assert.equal((refused.body as { error: string }).error, "W5_ORIGINAL_ARM_OR_WRONG_ASSIGNMENT_TRANSFORMED_USE_FORBIDDEN");
    originalArmNegative = refused;
  }
  const begun = new Map<string, number>(), transformed = assigned.assignments.filter(a => a.body.arm === "TRANSFORMED");
  for (const assignment of transformed) {
    begun.set(assignment.body.assignmentId, performance.now());
    const submitted = await ok<{ approvalGranted: boolean; externalEffectRequested: boolean }>("process-use", {
      requestId: input.requestId, workId: assignment.body.unit.workId, processId: "resolution", roleId: "digital",
      trialAssignmentRef: assignment.ref, idempotencyKey: input.key + ":use:" + assignment.body.assignmentId,
      evidence: input.evidence,
    }, input.digitalId);
    assert.equal(submitted.approvalGranted, false); assert.equal(submitted.externalEffectRequested, false);
  }
  if (transformed.length) { checkBound(); await ports.tick(transformed.length); checkBound(); }
  const published = await ports.read(); checkBound();
  const publishedAt = performance.now(), observedAt = new Date().toISOString();
  const postCommitObservations: unknown[] = [];
  for (const assignment of transformed) {
    const a = assignment.body, actual = published.nativeUses.filter(u => u.work_id === a.unit.workId && u.process_id === "resolution");
    assert.equal(actual.length, 1); assert.equal(actual[0]!.result.approvalGranted, false);
    assert.equal(actual[0]!.result.externalEffectDispatched, false);
    const elapsedSeconds = Math.ceil((publishedAt - begun.get(a.assignmentId)!) / 1000);
    const source = await ok<{ ref: OrganizationReference }>("source", {
      workId: a.unit.workId, kind: "OPERATING_OBSERVATION", sourceClass: "CONTROLLED", observedAt,
      validUntil: input.originalDeadline, idempotencyKey: input.key + ":outcome-source:" + a.assignmentId,
      body: { schema: "finnor.organization-prospective-outcome.v1", requestId: input.requestId, assignmentRef: assignment.ref,
        workId: a.unit.workId, workInputId: a.unit.workInputId, processId: "resolution", arm: a.arm,
        elapsedSeconds, observedAt, humanSeconds: null, serviceRetained: null, useKey: actual[0]!.use_key },
    }, input.evaluatorId);
    const observationInput = { requestId: input.requestId, assignmentRef: assignment.ref,
      evidenceRef: source.ref, idempotencyKey: input.key + ":observation:" + a.assignmentId };
    const wrongActor = await post("trial-observation", observationInput, input.digitalId);
    assert.equal(wrongActor.status, 404);
    const observed = await ok<{ semanticReplay: boolean }>("trial-observation", observationInput, input.evaluatorId);
    assert.equal(observed.semanticReplay, false);
    const observedReplay = await ok<{ semanticReplay: boolean }>("trial-observation", observationInput, input.evaluatorId);
    assert.equal(observedReplay.semanticReplay, true);
    postCommitObservations.push({ assignmentRef: assignment.ref, sourceRef: source.ref, observed, observedReplay, wrongActor,
      elapsedSeconds, measurement: "ACTUAL_PACKET_SUBMISSION_TO_OBSERVED_NATIVE_PUBLICATION_SECONDS",
      humanSeconds: null, serviceRetained: null, qualification: "CONTROLLED_FIXTURE_OBSERVER_NOT_HUMAN_OR_FIELD_TIME" });
  }
  const final = await trialRead();
  assert.deepEqual(final.assignments, assigned.assignments);
  assert.deepEqual([...final.observedAssignmentIds].sort(), transformed.map(a => a.body.assignmentId).sort());
  const result = { schema: "finnor.w5.native-prospective-observation.v1", trialRef: assigned.trial.ref,
    registeredUnits: units, assignments: assigned.assignments, pendingRefusal, originalArmNegative,
    postCommitObservations, missingOriginalArmAssignmentIds: assigned.assignments.filter(a => a.body.arm === "ORIGINAL")
      .map(a => a.body.assignmentId),
    noResamplingOrOriginalHumanMeasurementInferred: true, sourceClass: "CONTROLLED",
    scientificAdmission: false, fieldBenefitEstablished: false, fullCostBenefitEstablished: false };
  checkBound();
  await ports.artifact("w5-live-prospective-observation.json", result);
  checkBound();
  return result;
}
