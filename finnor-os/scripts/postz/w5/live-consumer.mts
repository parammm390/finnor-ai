/** Parent-owned S6 live-phase consumer. This module never invokes the S6
 * helper, creates authority/resources, dispatches an original effect or closes
 * borrowed processes. The parent owns the final negative and final verdict. */
import { strict as assert } from "node:assert";
import type { readEnterpriseDurableObligation } from "../../../packages/private-equity/src/enterprise-obligations";
import { organizationDigest } from "../../../packages/private-equity/src/organization-transformation/compiler";
import type { LiveOrganizationObligation, OrganizationReference, OrganizationTransformationProgram } from "../../../packages/private-equity/src/organization-transformation/contracts";
import { prepareOrganizationFixture, type OrganizationFixtureInput } from "./fixture.mjs";
import { observeNativeProspectiveAssignments, type NativeProspectiveUnit } from "./prospective-native.mjs";

type OriginalS6 = Awaited<ReturnType<typeof readEnterpriseDurableObligation>>;
export interface OrganizationLivePorts {
  request(method: "GET" | "POST", group: string, operation: string, body: unknown, actor: string):
    Promise<{ status: number; body: unknown }>;
  tick(maximumTicks: number): Promise<unknown>;
  artifact(name: string, value: unknown): Promise<unknown>;
  /** The original parent clock, never a new allowance at hook entry. */
  checkBound(): void;
}
export interface OrganizationLiveInput {
  tenantId: string;
  originalS6: OriginalS6;
  fixture: Omit<OrganizationFixtureInput, "obligations" | "resourceConstraints">;
  retainedObligations: LiveOrganizationObligation[];
  retainedReservationRefs: OrganizationReference[];
  units: NativeProspectiveUnit[];
}
export interface OrganizationOwnerRead {
  access: "OWNER"; requestId: string; workId: string; workInputId: string; revision: number;
  originalDeadline: string; nativeBudgetRef: OrganizationReference; program: OrganizationTransformationProgram | null;
  pendingNativeWork: boolean;
  nativeUses: Array<{ work_id: string; process_id: string; use_key: string; result: Record<string, unknown> }>;
}
export interface OrganizationBeforeTerminalReady {
  schema: "finnor.w5.shared-live-consumption.v1";
  status: "PENDING_S6_TERMINAL_NEGATIVE";
  tenantId: string; companyId: string; ownerId: string; requestId: string;
  programmeWorkId: string; programmeWorkInputId: string; originalDeadline: string;
  originalBudgetRef: OrganizationReference; originalS6ObligationRef: OrganizationReference;
  originalS6WorkId: string; originalS6EffectId: string;
  originalControlReadRef: unknown; originalContinuation: unknown; prospectiveObservation: unknown;
  evaluation: unknown; finalOwnerRead: OrganizationOwnerRead;
  qualificationGaps: readonly string[]; fullW5Qualification: false;
}
export type OrganizationBeforeTerminalParent = (ready: Readonly<OrganizationBeforeTerminalReady>,
  genuineS6Receipts: Readonly<Record<string, unknown>>) => Promise<void>;
const group = "organization/transformation-programs";
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "W5_NATIVE_OBJECT_REQUIRED");
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Call before the parent's single helper invocation. The returned one-shot
 * function runs only in that helper's genuine pre-terminal hook. */
export async function createSharedOrganizationLiveConsumer(ports: OrganizationLivePorts,
  supplied: OrganizationLiveInput, parentBeforeTerminal: OrganizationBeforeTerminalParent) {
  const declaredStart = performance.now();
  ports.checkBound();
  const input = freeze(structuredClone(supplied)), original = input.originalS6;
  const originalWorkId = original.workLineage?.workId;
  assert(originalWorkId, "W5_PARENT_S6_SOURCE_REQUIRES_CANONICAL_ORIGINAL_WORK");
  assert.equal(input.tenantId, original.tenantId); assert.equal(input.fixture.ownerId, original.principalId);
  assert.notEqual(input.fixture.workId, originalWorkId, "W5_CANNOT_REPLACE_THE_ORIGINAL_S6_WORK_INPUT");
  assert.notEqual(input.fixture.sourceWorkId, originalWorkId);
  assert.notEqual(input.fixture.sourceWorkId, input.fixture.workId);
  assert.equal(new Set([input.fixture.ownerId, input.fixture.evaluatorId, ...Object.values(input.fixture.roles)]).size, 6,
    "W5_ORIGINAL_DISTINCT_AUTHENTICATED_PARTICIPANTS_AND_EVALUATOR_REQUIRED");
  assert(input.fixture.key.length > 0 && input.fixture.key.length <= 64, "W5_FINITE_DERIVED_IDEMPOTENCY_KEYS");
  assert(original.intervention.targets.length && original.intervention.targets.every(t =>
    t.entityType === "external_organization" && t.entityId === input.fixture.companyId));
  assert(Date.parse(input.fixture.originalDeadline) <= Date.parse(original.deadline.businessPeriodEndAt),
    "W5_PARENT_ORIGINAL_DEADLINE_CANNOT_BE_RENEWED");
  assert(input.units.length >= 40 && input.units.length <= 512, "W5_ORIGINAL_FINITE_UNIT_ROSTER_REQUIRED");
  assert(input.units.length <= (input.fixture.trialMaximumUnits ?? 80), "W5_ORIGINAL_PREREGISTERED_UNIT_CEILING");
  assert.equal(new Set(input.units.map(u => u.workId)).size, input.units.length);
  assert.equal(new Set(input.units.map(u => u.workInputId)).size, input.units.length);
  assert(input.units.every(u => u.workId !== originalWorkId && u.workId !== input.fixture.workId));
  const declaration = { schema: "finnor.w5.shared-live-original-input.v1", declaredAt: new Date().toISOString(),
    input, inputDigest: organizationDigest(input), parentOwnsOnlyS6Invocation: true,
    qualification: "BEFORE_OWN_CONSUMPTION_NOT_RETROACTIVE_S6_AUTHORITY", disposition: "NOT_RUN" };
  await ports.artifact("w5-live-original-declaration.json", declaration);
  ports.checkBound();
  let consumed = false;
  return async (genuineS6Receipts: Readonly<Record<string, unknown>>): Promise<Readonly<OrganizationBeforeTerminalReady>> => {
    assert(!consumed, "W5_SHARED_LIVE_PHASE_IS_ONE_SHOT_NO_NEW_EPISODE"); consumed = true;
    const bound = () => {
      ports.checkBound();
      assert(performance.now() - declaredStart < 300000, "W5_LIVE_ORIGINAL_300_SECOND_DECLARATION_BOUND");
      assert(Date.now() < Date.parse(input.fixture.originalDeadline), "W5_LIVE_ORIGINAL_DEADLINE_EXHAUSTED");
    };
    bound();
    assert(Object.isFrozen(genuineS6Receipts), "W5_ACTUAL_IMMUTABLE_PARENT_S6_CONTEXT_REQUIRED");
    assert.equal(organizationDigest(genuineS6Receipts.obligation), organizationDigest(original));
    const native = object(genuineS6Receipts.nativeHandoff);
    assert.equal(native.status, 200);
    const nativeHandoff = object(object(native.body).handoff);
    assert.equal(organizationDigest(nativeHandoff.obligation), organizationDigest(original));
    assert.equal(object(nativeHandoff.consumer).semanticOwner, "S6");
    const downstream = object(genuineS6Receipts.downstream);
    assert.equal(downstream.status, 200);
    const downstreamHandoff = object(object(downstream.body).handoff);
    assert.equal(object(downstreamHandoff.consumer).semanticOwner, "S7");
    assert.equal(downstreamHandoff.attributionGranted, false);
    assert.deepEqual(downstreamHandoff.history, genuineS6Receipts.history);
    assert.equal(object(genuineS6Receipts.finalBudgets).status, 200);
    const request: OrganizationLivePorts["request"] = async (method, domain, operation, body, actor) => {
      bound(); const response = await ports.request(method, domain, operation, body, actor); bound(); return response;
    };
    const post = (operation: string, body: unknown, actor = input.fixture.ownerId) =>
      request("POST", group, operation, body, actor);
    const ok = async <T,>(operation: string, body: unknown, actor = input.fixture.ownerId): Promise<T> => {
      const response = await post(operation, body, actor); assert.equal(response.status, 200, JSON.stringify(response));
      return response.body as T;
    };
    const read = async (): Promise<OrganizationOwnerRead> => {
      const response = await request("GET", group, "read?requestId=" + requestId, undefined, input.fixture.ownerId);
      assert.equal(response.status, 200, JSON.stringify(response));
      const view = response.body as OrganizationOwnerRead;
      assert.equal(view.access, "OWNER"); assert.equal(view.requestId, requestId);
      assert.equal(view.workId, input.fixture.workId); assert.equal(view.originalDeadline, input.fixture.originalDeadline);
      return view;
    };
    const tick = async (n = 1) => {
      bound(); assert(Number.isInteger(n) && n > 0 && n <= input.units.length + 12);
      const result = await ports.tick(n); bound(); return result;
    };
    const main = await ok<{ obligation: LiveOrganizationObligation; nativeReadback: { originPreimageDigest: string } }>(
      "compose-obligation", { companyId: input.fixture.companyId, obligationRef: original.ref,
        reservationRef: original.reservationRef, accountableRoleId: "provider", processId: "resolution", nodeId: "original-delivery" });
    assert.equal(main.nativeReadback.originPreimageDigest, organizationDigest(original));
    assert.equal(main.obligation.workId, originalWorkId);
    const constraints = [];
    for (const reservationRef of input.retainedReservationRefs) {
      const result = await ok<{ constraint: NonNullable<OrganizationFixtureInput["resourceConstraints"]>[number] }>(
        "compose-resource-constraint", { companyId: input.fixture.companyId, reservationRef });
      constraints.push(result.constraint);
    }
    const fixture = await prepareOrganizationFixture({
      http: async (domain, operation, body, actor = input.fixture.ownerId) => request("POST", domain, operation, body, actor),
      artifact: ports.artifact,
    }, { ...input.fixture, obligations: [main.obligation, ...input.retainedObligations], resourceConstraints: constraints });
    const intake = await ok<{ requestId: string; workId: string }>("intake", fixture.intake);
    const requestId = intake.requestId;
    assert.equal(intake.workId, input.fixture.workId);
    const replay = await ok<{ requestId: string; semanticReplay: boolean }>("intake", fixture.intake);
    assert.equal(replay.requestId, requestId); assert.equal(replay.semanticReplay, true);
    await tick();
    let view = await read(); assert(view.program);
    const originalBudget = structuredClone(view.nativeBudgetRef), originalInputId = view.workInputId;
    const selected = view.program.alternatives.find(a => a.kind === "PREPARED_HANDOFF");
    assert(selected && selected.constructedAssets.some(a => a.kind === "EVIDENCE_CONTRACT"));
    assert.equal(selected.roles.find(r => r.id === "approver")?.principalId, input.fixture.roles.approver);
    assert(selected.processes.find(p => p.id === "resolution")?.nodes.find(n => n.id === "original-approval")?.mandatory);
    await ok("action", { requestId, expectedRevision: view.revision, idempotencyKey: input.fixture.key + ":select",
      action: { kind: "SELECT", alternativeId: selected.id } });
    await tick();
    for (const actor of Object.values(input.fixture.roles)) {
      const response = await request("GET", group, "read?requestId=" + requestId, undefined, actor);
      assert.equal(response.status, 200);
      const self = object(response.body); assert.equal(self.access, "PARTICIPANT"); assert.equal(self.parentPrivateDataDisclosed, false);
      assert.equal(self.program, undefined);
      const offers = self.offers as Array<Record<string, unknown>>;
      assert.equal(offers.length, 1);
      const offer = offers[0]!;
      await ok("adoption", { requestId, roleId: offer.role_id, alternativeId: offer.alternative_id,
        termsDigest: offer.terms_digest, decision: "ADOPT", idempotencyKey: input.fixture.key + ":self-adopt" }, actor);
    }
    await tick(4); view = await read(); assert.equal(view.program?.status, "ADOPTED");
    await ok("action", { requestId, expectedRevision: view.revision, idempotencyKey: input.fixture.key + ":trial",
      action: { kind: "MIGRATE", stage: "TRIAL" } });
    await tick(); view = await read(); assert.equal(view.program?.status, "TRIAL");
    await ok("process-use", { requestId, workId: originalWorkId, processId: "resolution", roleId: "digital",
      idempotencyKey: input.fixture.key + ":original-packet", evidence: fixture.evidence }, input.fixture.roles.digital);
    await tick(); view = await read();
    const originalUses = view.nativeUses.filter(use => use.work_id === originalWorkId && use.process_id === "resolution");
    assert.equal(originalUses.length, 1);
    const use = originalUses[0]!;
    assert.equal(use.result.approvalGranted, false); assert.equal(use.result.externalEffectDispatched, false);
    const packets = await request("GET", group, "packets?requestId=" + requestId + "&workId=" + originalWorkId,
      undefined, input.fixture.roles.approver);
    assert.equal(packets.status, 200);
    const packet = (object(packets.body).packets as Array<Record<string, unknown>>).find(p =>
      object(p.control).id === "original-approval" && p.useKey === use.use_key);
    assert(packet, "W5_ACTUAL_ORIGINAL_APPROVER_PACKET_REQUIRED");
    const readInput = { requestId, useKey: use.use_key, controlId: "original-approval", termsDigest: packet.termsDigest,
      packetRef: packet.packetRef, disclosureDigest: packet.disclosureDigest, idempotencyKey: input.fixture.key + ":control-read" };
    const denied = await post("packet-read", readInput);
    assert.equal(denied.status, 403, "W5_OWNER_CANNOT_ACKNOWLEDGE_ANOTHER_ACTOR_CONTROL");
    const control = await ok<Record<string, unknown>>("packet-read", readInput, input.fixture.roles.approver);
    assert.equal(control.approvalGranted, false); assert.equal(control.externalEffectDispatched, false);
    const controlReplay = await ok<Record<string, unknown>>("packet-read", readInput, input.fixture.roles.approver);
    assert.equal(controlReplay.semanticReplay, true); assert.deepEqual(controlReplay.readRef, control.readRef);
    const prospective = await observeNativeProspectiveAssignments({ request, tick, artifact: ports.artifact, read, checkBound: bound },
      { requestId, companyId: input.fixture.companyId, ownerId: input.fixture.ownerId, evaluatorId: input.fixture.evaluatorId,
        digitalId: input.fixture.roles.digital, originalDeadline: input.fixture.originalDeadline, key: input.fixture.key,
        units: input.units, evidence: fixture.evidence });
    view = await read();
    const continuation = await ok<Record<string, unknown>>("continuation", {
      requestId, workId: originalWorkId, processId: "resolution", useKey: use.use_key, obligationId: original.ref.id,
      expectedRevision: view.revision, idempotencyKey: input.fixture.key + ":original-continuation" });
    assert.equal(continuation.originalWorkId, originalWorkId); assert.equal(continuation.originalActionId, original.domainActionId);
    assert.equal(object(continuation.originalEffectRef).id, original.effectRef.id);
    assert.equal(object(continuation.originalEffectRef).contentDigest, original.effectRef.semanticHash);
    assert.equal(continuation.status, "ORIGINAL_S6_VERIFIED_READBACK_LIABILITIES_RETAINED");
    assert.equal(continuation.resourcesReleased, false); assert.equal(continuation.resourcesRenewed, false);
    assert.equal(continuation.effectsRetried, false); assert.equal(continuation.executionAuthorityGranted, false);
    const ownerReadback = object(continuation.ownerReadback);
    assert.equal(ownerReadback.status, "AUTHENTICATED_ORIGINAL_S6_HANDOFF");
    assert.equal(ownerReadback.originalVerificationObserved, true);
    assert.deepEqual(ownerReadback.checkpoint, nativeHandoff.checkpoint);
    assert.deepEqual(ownerReadback.release, nativeHandoff.release);
    assert.equal(organizationDigest(continuation.originalConsumptionRef), organizationDigest(original.consumptionRef));
    assert(continuation.ownerReadbackRef, "W5_ACTUAL_SIGNED_ORIGINAL_READBACK_S1_RECEIPT_REQUIRED");
    const evaluation = await ok<Record<string, unknown>>("evaluation",
      { requestId, idempotencyKey: input.fixture.key + ":native-evaluation" });
    assert.equal(evaluation.status, "UNIDENTIFIED"); assert.equal(evaluation.fieldBenefitEstablished, false);
    assert.equal(object(evaluation.causalContext).assignmentVerified, true);
    assert.equal(object(evaluation.causalContext).causalBenefitEstablished, false);
    assert.equal(object(evaluation.fullCost).monetaryCostMinor, null);
    assert.equal(object(evaluation.fullCost).humanSupervisionSeconds, null);
    assert.equal(object(evaluation.fullCost).sourceDeclarationsAreInvoices, false);
    assert.equal(object(evaluation.economicRecordRef).owner, "S7", "W5_ACTUAL_S7_ASSESSMENT_REQUIRED");
    assert(Array.isArray(evaluation.gaps) && evaluation.gaps.every(gap => typeof gap === "string"));
    const finalOwnerRead = await read(); assert.equal(finalOwnerRead.pendingNativeWork, false);
    assert.equal(finalOwnerRead.workInputId, originalInputId); assert.deepEqual(finalOwnerRead.nativeBudgetRef, originalBudget);
    const ready = freeze<OrganizationBeforeTerminalReady>({
      schema: "finnor.w5.shared-live-consumption.v1", status: "PENDING_S6_TERMINAL_NEGATIVE",
      tenantId: input.tenantId, companyId: input.fixture.companyId, ownerId: input.fixture.ownerId, requestId,
      programmeWorkId: input.fixture.workId, programmeWorkInputId: originalInputId,
      originalDeadline: input.fixture.originalDeadline, originalBudgetRef: originalBudget,
      originalS6ObligationRef: original.ref, originalS6WorkId: originalWorkId, originalS6EffectId: original.effectRef.id,
      originalControlReadRef: control.readRef, originalContinuation: continuation, prospectiveObservation: prospective,
      evaluation, finalOwnerRead, fullW5Qualification: false,
      qualificationGaps: ["CONTROLLED_NATIVE_CONSUMPTION_IS_NOT_FULL_W5_QUALIFICATION",
        ...(evaluation.gaps as string[]),
        "SEPARATE_OWNER_HEAD_INTERRUPTION_COLD_AND_STRUCTURAL_CAMPAIGNS_REQUIRED"],
    });
    await ports.artifact("w5-live-before-parent-custody.json", ready);
    // Last dependent operation. The parent must write its actual fifth record
    // and live original custody here. No native/budget reads follow this call.
    bound(); await parentBeforeTerminal(ready, genuineS6Receipts); bound();
    await ports.artifact("w5-live-parent-custody-callback-completed.json",
      { requestId, status: "PENDING_S6_TERMINAL_NEGATIVE", nativeOperationsAfterCallback: 0 });
    return ready;
  };
}
