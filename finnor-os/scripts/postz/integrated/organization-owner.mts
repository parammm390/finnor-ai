/** Actual signed W5 consumption. A missing original dependency or backing
 * fails closed; this owner never creates an extra shared resource grant. */
import { strict as assert } from "node:assert";
import { z } from "zod";
import { createHash, verify } from "node:crypto";
import { receiveWork } from "@finnor/db";
import type { BeliefViewPin } from "@finnor/shared-types";
import { organizationCanonical, organizationDigest } from "../../../packages/private-equity/src/organization-transformation/compiler";
import { canonical } from "../../../packages/governed-execution/src/protocol";
import { liveOrganizationObligation, organizationReference }
  from "../../../packages/private-equity/src/organization-transformation/contracts";
import type { OrganizationFixtureInput } from "../w5/fixture.mts";
import type { OrganizationBeforeTerminalReady, OrganizationLiveInput, OrganizationLivePorts } from "../w5/live-consumer.mjs";
import type { NativeProspectiveUnit } from "../w5/prospective-native.mjs";
import { runSharedOrganizationNative } from "../w5/shared-native.mjs";
import type { IntegratedOwnerPorts, NativeJourneyOutput } from "./owner-journey.mts";

export interface OrganizationParentPorts extends IntegratedOwnerPorts {
  request: OrganizationLivePorts["request"];
}
export interface OrganizationSetup {
  sourceWorkId: string; workId: string; evaluatorId: string; roles: OrganizationFixtureInput["roles"];
  originalDeadline: string;
  originalS6: OrganizationLiveInput["originalS6"] | null;
  resources: OrganizationFixtureInput["resources"] | null;
  units: NativeProspectiveUnit[];
  beforeTerminal(output: NativeJourneyOutput, ready: Readonly<OrganizationBeforeTerminalReady>,
    receipts: Readonly<Record<string, unknown>>): Promise<void>;
  onLivePhaseEnded(): void;
}

export function prepareOrganizationSourceWork(input: {
  tenantId: string; ownerId: string; companyId: string; sourceWorkId: string;
}) {
  return receiveWork({ tenantId: input.tenantId, userId: input.ownerId, workId: input.sourceWorkId,
    channel: "text", instruction: "Collect controlled organization originals for the existing shared company. No field measurement or human adoption is asserted.",
    idempotencyKey: "integrated-w5-source:" + input.sourceWorkId, requireExactIntake: true,
    entityAttachments: [{ entityType: "external_organization", entityId: input.companyId,
      relationship: "about", source: "CONTROLLED_INTEGRATED_ORGANIZATION_SOURCE" }] });
}

async function checkStoredOrganizationReadback(ports: OrganizationParentPorts, ready: Readonly<OrganizationBeforeTerminalReady>,
  receipts: Readonly<Record<string, unknown>>) {
  const continuation = z.object({ ownerReadbackRef: organizationReference,
    ownerReadback: z.object({ handoffDigest: z.string(), signature: z.string() }) }).parse(ready.originalContinuation);
  const retained = z.object({
    handoff: z.object({ knowledgeAt: z.string().datetime() }).passthrough(),
    signature: z.string(),
  }).strict();
  const parent = z.object({ nativeHandoff: z.object({ body: retained }),
    publicAuthorities: z.object({ ledger: z.string() }) }).parse(receipts);
  const readEvidence = async (ref: z.infer<typeof organizationReference>) => {
    ports.checkBound();
    assert.equal(ref.owner, "S1");
    const rows = (await ports.admin.query<{ content: string; content_hash: string; version_number: number }>(
      `SELECT v.content,v.content_hash,v.version_number FROM finnor_os.evidence_source_versions v
       JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
       WHERE v.tenant_id=$1 AND v.id=$2 AND s.metadata->>'workId'=$3 AND s.metadata->>'authenticatedPrincipal'=$4`,
      [ports.tenant, ref.id, ready.originalS6WorkId, ports.owner])).rows;
    assert.equal(rows.length, 1, "W5_ORIGINAL_S1_READBACK_NOT_RETAINED");
    const row = rows[0]!;
    assert.equal(String(row.version_number), ref.version);
    assert.equal(row.content_hash, ref.contentDigest);
    assert.equal(createHash("sha256").update(row.content).digest("hex"), ref.contentDigest);
    assert(Buffer.byteLength(row.content) <= 262_144);
    return JSON.parse(row.content) as unknown;
  };
  const context = { requestId: z.literal(ready.requestId), originalObligationRef: organizationReference,
    executionAuthorityGranted: z.literal(false) };
  const record = z.discriminatedUnion("schema", [
    z.object({ ...context, schema: z.literal("finnor.organization-original-s6-owner-readback.v1"), actualSignedHandoff: retained }),
    z.object({ ...context, schema: z.literal("finnor.organization-original-s6-owner-readback-manifest.v1"),
      bytes: z.number().int().positive().max(2 * 1024 * 1024), sha256: z.string(),
      encoding: z.literal("ORGANIZATION_CANONICAL_JSON_UTF8"), chunks: z.array(z.object({ index: z.number().int(),
        bytes: z.number().int().positive().max(144 * 1024), ref: organizationReference })).min(2).max(15) }),
  ]).parse(await readEvidence(continuation.ownerReadbackRef));
  assert.deepEqual(record.originalObligationRef, ready.originalS6ObligationRef);
  let signed: z.infer<typeof retained>;
  let chunkCount = 0;
  if (record.schema === "finnor.organization-original-s6-owner-readback-manifest.v1") {
    const chunks = [];
    for (const [index, part] of record.chunks.entries()) {
      assert.equal(part.index, index);
      const value = z.object({ ...context, schema: z.literal("finnor.organization-original-s6-owner-readback-part.v1"),
        index: z.literal(index), base64: z.string() }).parse(await readEvidence(part.ref));
      assert.deepEqual(value.originalObligationRef, ready.originalS6ObligationRef);
      const bytes = Buffer.from(value.base64, "base64");
      assert.equal(bytes.length, part.bytes);
      assert.equal(bytes.toString("base64"), value.base64);
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, record.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256);
    signed = retained.parse(JSON.parse(bytes.toString("utf8")));
    assert(bytes.equals(Buffer.from(organizationCanonical(signed))), "W5_S1_SIGNED_READBACK_PREIMAGE_CHANGED");
    chunkCount = chunks.length;
  } else signed = record.actualSignedHandoff;
  const { knowledgeAt, ...currentHandoff } = signed.handoff;
  const { knowledgeAt: originalReadAt, ...originalHandoff } = parent.nativeHandoff.body.handoff;
  assert(Date.parse(knowledgeAt) >= Date.parse(originalReadAt), "W5_RECONSTRUCTED_READ_MUST_FOLLOW_ORIGINAL");
  assert.deepEqual(currentHandoff, originalHandoff);
  assert.equal(signed.signature, continuation.ownerReadback.signature);
  assert.equal(organizationDigest(signed.handoff), continuation.ownerReadback.handoffDigest);
  assert(verify(null, Buffer.from(canonical(signed.handoff)), parent.publicAuthorities.ledger,
    Buffer.from(signed.signature, "base64")), "W5_RECONSTRUCTED_S6_SIGNATURE_REQUIRED");
  await ports.artifact("integrated/w5/private/original-s6-evidence-reconstructed.json", {
    evidenceRef: continuation.ownerReadbackRef, chunkCount,
    bytes: Buffer.byteLength(organizationCanonical(signed)), originalOwnerSignatureVerified: true,
    originalHandoffMatches: true, originalEffectDispatchedByRead: false,
  });
}

/** The parent predeclares the exact dependency, unit roster, deadline and
 * original resource refs. Discovery is complete and conservative, never a
 * search for a favorable replacement for PAY or another possible effect. */
export async function runOrganizationOwner(ports: OrganizationParentPorts, setup: OrganizationSetup): Promise<NativeJourneyOutput> {
  ports.checkBound();
  assert.equal(new Set([setup.sourceWorkId, setup.workId, ports.serviceWorkId]).size, 3);
  const works = (await ports.admin.query<{ id: string }>(`SELECT w.id FROM finnor_os.works w
    WHERE w.tenant_id=$1 AND EXISTS(SELECT 1 FROM finnor_os.work_entity_links l
      WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id AND l.entity_type='external_organization' AND l.entity_id=$2)
    ORDER BY w.id LIMIT 1025`, [ports.tenant, ports.companyId])).rows;
  assert(works.length && works.length <= 1024, "W049_W5_COMPLETE_ORIGINAL_WORK_DISCOVERY_BOUND");
  const workIds = works.map(work => work.id);
  const origins = (await ports.admin.query<{ obligation_id: string; obligationRef: unknown; reservationRef: unknown }>(
    `SELECT o.obligation_id,o.body->'ref' "obligationRef",o.body->'reservationRef' "reservationRef"
    FROM finnor_os.s6_obligation_origins o LEFT JOIN finnor_os.domain_actions d
      ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
    WHERE o.tenant_id=$1 AND (d.work_id=ANY($2::uuid[]) OR o.body#>>'{workLineage,workId}'=ANY($2::text[])
      OR o.effect_id IN(SELECT e.id FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a
        ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id WHERE e.tenant_id=$1 AND a.work_id=ANY($2::uuid[])))
    ORDER BY o.obligation_id LIMIT 1025`, [ports.tenant, workIds])).rows;
  const reservations = (await ports.admin.query<{ reservation_id: string; ref: unknown; status: string; revision: number }>(
    `SELECT r.reservation_id,o.body->'ref' ref,r.status,r.revision FROM finnor_os.s5_reservations r
    LEFT JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
    WHERE r.tenant_id=$1 ORDER BY r.reservation_id LIMIT 1025`, [ports.tenant])).rows;
  const resourceSnapshot = await ports.request("POST", "allocations", "resources", {}, ports.owner);
  await ports.artifact("integrated/w5/private/canonical-input-discovery.json", {
    companyId: ports.companyId, workIds, origins, reservations, resourceSnapshot,
    proposedOriginalDependency: setup.originalS6?.ref ?? null, predeclaredResources: setup.resources,
    declaredUnitRoster: setup.units, originalDeadline: setup.originalDeadline,
    discoveryOnly: true, signedOwnerCompositionRequired: true, tenantReservationScopeIsConservative: true,
    missingOriginalOrBackingIsFailClosedNotExternalPermission: true,
  });
  assert(origins.length && origins.length <= 1024, "W049_W5_COMPLETE_S6_ORIGINAL_DISCOVERY_BOUND");
  assert(reservations.length && reservations.length <= 1024, "W049_W5_COMPLETE_S5_ORIGINAL_DISCOVERY_BOUND");
  assert.equal(resourceSnapshot.status, 200, JSON.stringify(resourceSnapshot));
  assert(setup.originalS6, "W049_W5_PREDECLARED_NEVER_DISPATCHED_SEPARATE_ORIGINAL_REQUIRED_NO_PAY_REPLAY");
  assert(setup.resources, "W049_W5_PREDECLARED_ORIGINAL_BACKING_REQUIRED_NO_EXTRA_GRANT");
  const original = setup.originalS6, originalWorkId = original.workLineage?.workId;
  assert(originalWorkId && workIds.includes(originalWorkId));
  assert.equal(original.tenantId, ports.tenant); assert.equal(original.principalId, ports.owner);
  assert(origins.some(origin => organizationDigest(origin.obligationRef) === organizationDigest(original.ref) &&
    organizationDigest(origin.reservationRef) === organizationDigest(original.reservationRef)));
  assert(Date.now() < Date.parse(setup.originalDeadline) &&
    Date.parse(setup.originalDeadline) <= Date.parse(original.deadline.authorityExpiresAt) &&
    Date.parse(setup.originalDeadline) <= Date.parse(original.deadline.businessPeriodEndAt),
  "W049_W5_ORIGINAL_DEADLINE_CANNOT_BE_RENEWED");
  assert(setup.units.length >= 40 && setup.units.length <= 512);
  assert(setup.units.every(unit => workIds.includes(unit.workId) && unit.workId !== originalWorkId));
  const snapshot = resourceSnapshot.body as { resources: Array<{
    ref: unknown; resourceClass: string; unit: string; permittedRoots: Array<{ entityType: string; entityId: string }>;
    beliefPins: BeliefViewPin[];
  }> };
  assert(Array.isArray(snapshot.resources));
  for (const ref of setup.resources.resourceRefs) {
    const resource = snapshot.resources.find(candidate => organizationDigest(candidate.ref) === organizationDigest(ref));
    assert(resource?.resourceClass === "COMPUTE" && resource.unit === "request" &&
      resource.permittedRoots.some(root => root.entityType === "work" && root.entityId === setup.workId),
    "W049_W5_ACTUAL_ORIGINAL_WORK_ROOT_RESOURCE_REQUIRED_NO_REDECLARATION");
  }
  const originalPins = new Map(snapshot.resources.flatMap(resource => resource.beliefPins)
    .map(pin => [organizationDigest(pin), pin]));
  const observeSourceCuts = async (stage: string) => {
    ports.checkBound();
    assert(originalPins.size <= 64, "W5_ORIGINAL_SOURCE_CUT_DIAGNOSTIC_BOUND");
    const cuts = [];
    for (const pin of originalPins.values()) {
      const current = await ports.request("POST", "company-brain", "belief-view",
        { root: pin.root, validAt: pin.validAt }, ports.owner);
      const witness = z.object({ dependencyDigest: z.string().regex(/^[a-f0-9]{64}$/),
        rights: z.object({ revision: z.number().int().positive() }) }).safeParse(current.body);
      cuts.push({ pin, current, matchesOriginal: current.status === 200 && witness.success
        && witness.data.dependencyDigest === pin.dependencyDigest
        && witness.data.rights.revision === pin.rightsRevision });
    }
    await ports.artifact("integrated/w5/private/source-cuts-" + stage + ".json", {
      cuts, observationsOnly: true, originalPinsChanged: false, authorityGranted: false });
    ports.checkBound();
  };
  await observeSourceCuts("before-source-intake");
  const source = await prepareOrganizationSourceWork({ tenantId: ports.tenant, ownerId: ports.owner,
    sourceWorkId: setup.sourceWorkId, companyId: ports.companyId });
  assert.equal(source.workId, setup.sourceWorkId);
  assert.equal(source.duplicate, true, "W5_SOURCE_WORK_MUST_PRECEDE_ORIGINAL_MODEL_AND_RESOURCE_PINS");
  await observeSourceCuts("after-source-intake");
  const retainedObligations: OrganizationLiveInput["retainedObligations"] = [];
  const retainedReservationRefs: OrganizationLiveInput["retainedReservationRefs"] = [];
  for (const [index, origin] of origins.entries()) {
    const obligationRef = organizationReference.parse(origin.obligationRef);
    assert.equal(obligationRef.id, origin.obligation_id);
    const reservationRef = organizationReference.parse(origin.reservationRef);
    if (obligationRef.id === original.ref.id) continue;
    const composed = await ports.request("POST", "organization/transformation-programs", "compose-obligation", {
      companyId: ports.companyId, obligationRef, reservationRef,
      accountableRoleId: "provider", processId: "resolution", nodeId: "original-delivery",
    }, ports.owner);
    await ports.artifact("integrated/w5/private/retained-obligation-" + index + ".json", composed);
    assert.equal(composed.status, 200, JSON.stringify(composed));
    const obligation = liveOrganizationObligation.parse((composed.body as { obligation: unknown }).obligation);
    assert.deepEqual(obligation.canonical?.obligationRef, obligationRef);
    assert.deepEqual(obligation.reservationRef, reservationRef);
    retainedObligations.push(obligation);
  }
  for (const reservation of reservations) {
    const ref = organizationReference.parse(reservation.ref);
    assert.equal(ref.id, reservation.reservation_id);
    retainedReservationRefs.push(ref);
  }
  const custody: { captured?: NativeJourneyOutput } = {};
  await runSharedOrganizationNative({
    request: ports.request, tick: ports.tick, artifact: ports.artifact, checkBound: ports.checkBound,
  }, {
    admin: ports.admin, onLivePhaseEnded: setup.onLivePhaseEnded,
    mapping: { field: "serviceTransition", recordPrefix: "w5-original-continuation",
      dose: 0.15, operation: "SERVICE_TRANSITION_V1", unit: "service_transition" },
    live: {
      tenantId: ports.tenant, originalS6: original, units: setup.units, retainedObligations, retainedReservationRefs,
      fixture: { sourceWorkId: source.workId, workId: setup.workId, evaluatorId: setup.evaluatorId, roles: setup.roles,
        ownerId: ports.owner, companyId: ports.companyId, resources: setup.resources,
        originalDeadline: setup.originalDeadline, key: "integrated-w5:" + setup.workId },
    },
  }, async (ready, receipts) => {
    ports.checkBound();
    await checkStoredOrganizationReadback(ports, ready, receipts);
    const foreign = await ports.request("GET", "organization/transformation-programs",
      "read?requestId=" + encodeURIComponent(ready.requestId), undefined, ports.foreign);
    assert.equal(foreign.status, 404);
    const row = (await ports.admin.query(`SELECT q.*,w.status work_status,i.instruction_text
      FROM finnor_os.w5_requests q JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id
      JOIN finnor_os.work_inputs i ON i.tenant_id=q.tenant_id AND i.work_id=q.work_id AND i.id=q.work_input_id
      WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id=$3`,
    [ports.tenant, ports.owner, ready.requestId])).rows[0];
    assert(row, "W049_W5_ACTUAL_DURABLE_PROGRAM_REQUIRED");
    assert.equal(row.company_id, ports.companyId); assert.equal(row.work_id, setup.workId);
    assert.equal(row.work_input_id, ready.programmeWorkInputId);
    assert.equal(row.original_deadline.toISOString(), setup.originalDeadline);
    assert.equal(createHash("sha256").update(row.instruction_text).digest("hex"), row.original_input_digest);
    assert.equal(organizationDigest(row.program), row.program_digest);
    assert.deepEqual(row.program, ready.finalOwnerRead.program);
    assert.equal(row.check_result.status, "CHECKED");
    const output: NativeJourneyOutput = {
      engine: "W5", schema: row.program.schema, tenantId: ports.tenant, principalId: ports.owner,
      companyId: ports.companyId, workId: setup.workId, workInputId: ready.programmeWorkInputId, requestId: ready.requestId,
      ref: { owner: "W5", id: ready.requestId, version: row.program.schema, contentDigest: row.program_digest },
      consumedBy: { owner: "NATIVE_ORGANIZATION_TRANSFORMATION_RUNTIME", independentCheck: row.check_result,
        nativeUses: ready.finalOwnerRead.nativeUses, originalSignedContinuation: ready.originalContinuation,
        nativeProspectiveObservation: ready.prospectiveObservation, nativeEvaluation: ready.evaluation },
      evidence: { beforeTerminal: ready, genuineOriginalS6Receipts: receipts, original: JSON.parse(row.instruction_text),
        workStatus: row.work_status, originalEffectContinuationProven: true,
        causalFullCostEvaluationProven: false, completeMonetaryCost: null, genuineHumanAdoptionProven: false,
        independentProtectedCustody: false, fieldValidated: false, fullW5Qualification: false },
    };
    await ports.artifact("integrated/w5/private-live-native-output.json", output);
    await setup.beforeTerminal(output, ready, receipts);
    custody.captured = output;
  });
  // The terminal original S6 negative has completed. No native reads below.
  assert(custody.captured, "W049_W5_ACTUAL_PRETERMINAL_PARENT_OUTPUT_REQUIRED");
  return custody.captured;
}
