/** S5 adapter over the original occupation, not a second resource ledger. */
import type { PoolClient } from "pg";
import { evaluateAuthorityTx } from "@finnor/authority";
import type { AllocationResource, ApplicationAllocationCertificate, ApplicationAllocationConsumption,
  ApplicationResourceEnvelope, ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "@finnor/private-equity/src/types";
import type { ApplicationPhase, ApplicationResourceDemand } from "@finnor/private-equity/src/application-semantics/native-contracts";
import { readAllocationSnapshotTx, validateInstitutionDemand, withS5PortfolioTransaction } from "@finnor/private-equity/src/allocation-store";
import { principal, tx } from "@finnor/private-equity/src/evidence-execution/store";
import { validateBeliefViewPin } from "@finnor/private-equity/src/enterprise-beliefs";
import { applicationArtifact, retainApplicationArtifact } from "@finnor/private-equity/src/application-semantics/store";
import { sameX2Ref, x2Digest, x2Fault, x2Ref } from "@finnor/private-equity/src/application-semantics/contracts";
import { assertInheritedCharge, exactUnits, remainingInstitutionBudget } from "./semantics";
import { assertInstitutionApplicationOriginCurrent, assertOriginalInstitutionOwnerIdle, institutionOriginRef, lockInstitutionApplicationOwners,
  type InstitutionApplicationOrigin, type InstitutionalAcquireRequest, type PreparedInstitutionOrigin } from "./institution-origin";

export type OriginalInstitutionReservation = Awaited<ReturnType<typeof validateInstitutionDemand>>["reservation"];
export interface InheritedApplicationCertificate extends ApplicationAllocationCertificate {
  institutionalOriginRef: ExperimentRef;
  originalReservationRef: ExperimentRef;
  acquisitionRequest: InstitutionalAcquireRequest;
  requestDigest: string;
  occupation: "EXISTING_ORIGINAL_X1_RESERVATION_NO_NEW_FUNDING";
}
export interface InheritedApplicationAllocation {
  certificate: InheritedApplicationCertificate; reservation: OriginalInstitutionReservation;
  resources: AllocationResource[]; rootConsumption: ApplicationAllocationConsumption;
}
export const isInheritedApplicationAllocation = (ref: ExperimentRef) =>
  ref.owner === "S5" && ref.version === "application-operation-v1"
  && ref.id === `institution-application-allocation:${ref.contentDigest}`;
type ConsumptionInput = Omit<ApplicationAllocationConsumption,
  "schema" | "ref" | "createdAt" | "status" | "effectRef" | "executionAuthorityGranted">;

async function originalReservation(ctx: PeMutationContext, ref: ExperimentRef, c: PoolClient) {
  const row = (await c.query<{ body: OriginalInstitutionReservation; status: OriginalInstitutionReservation["status"];
    revision: number; revocation_reason: string | null; envelopes: ApplicationResourceEnvelope[] }>(
    `SELECT o.body,s.status,s.revision,s.revocation_reason,s.envelopes FROM finnor_os.s5_reservation_origins o
      JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
      WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.reservation_id=$3 FOR SHARE OF o,s`,
    [ctx.auth.tenantId, principal(ctx), ref.id])).rows[0];
  if (!row || row.body.schema !== "finnor.s5.institution-reservation.v1"
    || row.body.tenantId !== ctx.auth.tenantId || row.body.principalId !== principal(ctx)
    || !sameX2Ref(row.body.ref, ref) || row.status === "RELEASED"
    || x2Digest(row.envelopes) !== x2Digest(row.body.envelopes)) x2Fault("Z0_ORIGINAL_INSTITUTION_RESERVATION_UNAVAILABLE");
  return { ...row.body, status: row.status, revision: row.revision,
    revocationReason: row.revocation_reason, envelopes: row.envelopes };
}
async function nativeDecision(ctx: PeMutationContext, workId: string, c: PoolClient) {
  const decision = await evaluateAuthorityTx(ctx.auth, { operation: "query", capability: "query:pe_world_state",
    risk: "low", workId, resources: [{ type: "work", id: workId }] }, c);
  if (decision.outcome !== "allowed" || decision.reasonCode !== "grant_allows") x2Fault("Z0_ORIGINAL_RESOURCE_AUTHORITY_REQUIRED", 403);
  return decision;
}
async function assertOriginalResources(ctx: PeMutationContext, origin: PreparedInstitutionOrigin, c: PoolClient,
  recovery = false) {
  const reservation = await originalReservation(ctx, origin.body.originalReservationRef, c);
  if (reservation.workId !== origin.body.workId || reservation.demand.demandDigest !== origin.body.originalDemandDigest) {
    x2Fault("Z0_ORIGINAL_INSTITUTION_RESERVATION_CHANGED");
  }
  const decision = await nativeDecision(ctx, origin.body.workId, c);
  if (!recovery) {
    await c.query("SELECT finnor_os.s5_assert_institution_current($1,$2)",
      [reservation.ref.id, decision.id]);
    const current = await readAllocationSnapshotTx(ctx, c);
    if (x2Digest(current.resources.map(resource => resource.ref)) !== x2Digest(reservation.resources)) {
      x2Fault("Z0_ORIGINAL_INSTITUTION_RESOURCES_CHANGED");
    }
    for (const resource of current.resources) for (const pin of resource.beliefPins) {
      if ((await validateBeliefViewPin(ctx, pin)).status !== "CURRENT") x2Fault("Z0_ORIGINAL_RESOURCE_SOURCE_CHANGED");
    }
  }
  return { reservation, decision };
}
async function storedFrame(ctx: PeMutationContext, ref: ExperimentRef, c: PoolClient, recovery: boolean) {
  if (!isInheritedApplicationAllocation(ref)) x2Fault("Z0_INHERITED_APPLICATION_ALLOCATION_DOMAIN");
  await lockInstitutionApplicationOwners(ctx, c);
  const body = await applicationArtifact<Omit<InheritedApplicationCertificate, "ref">>(ctx, ref, c);
  if (!sameX2Ref(x2Ref("S5", "institution-application-allocation", body), ref)
    || body.schema !== "finnor.s5.application-allocation.v1" || body.tenantId !== ctx.auth.tenantId
    || body.principalId !== principal(ctx) || body.occupation !== "EXISTING_ORIGINAL_X1_RESERVATION_NO_NEW_FUNDING"
    || body.requestDigest !== x2Digest(body.acquisitionRequest)
    || body.workId !== body.acquisitionRequest.workId || body.deadlineAt !== body.acquisitionRequest.deadlineAt) {
    x2Fault("Z0_INHERITED_APPLICATION_CERTIFICATE_INTEGRITY");
  }
  const originBody = await applicationArtifact<InstitutionApplicationOrigin>(ctx, body.institutionalOriginRef, c);
  const origin = { ref: body.institutionalOriginRef, body: originBody };
  if (!sameX2Ref(institutionOriginRef(originBody), origin.ref)
    || originBody.tenantId !== ctx.auth.tenantId || originBody.principalId !== principal(ctx)
    || originBody.workId !== body.workId || originBody.deadlineAt !== body.deadlineAt
    || !sameX2Ref(originBody.originalReservationRef, body.originalReservationRef)) x2Fault("Z0_INHERITED_ORIGINAL_FRAME_INTEGRITY");
  if (!recovery) await assertInstitutionApplicationOriginCurrent(ctx, origin, body.acquisitionRequest, c);
  const { reservation, decision } = await assertOriginalResources(ctx, origin, c, recovery);
  const resources: AllocationResource[] = [];
  for (const resourceRef of body.resourceRefs) {
    const resource = (await c.query<{ body: AllocationResource }>(`SELECT body FROM finnor_os.s5_resources
      WHERE tenant_id=$1 AND content_digest=$2`, [ctx.auth.tenantId, resourceRef.contentDigest])).rows[0]?.body;
    if (!resource || !sameX2Ref(resource.ref, resourceRef)
      || !reservation.resources.some(original => sameX2Ref(original, resource.ref))) x2Fault("Z0_INHERITED_RESOURCE_PREIMAGE_REQUIRED");
    resources.push(resource);
  }
  if (resources.length !== body.acquisitionRequest.resourceDemand.length
    || body.check.envelopes.length !== resources.length
    || new Set(resources.map(resource => resource.resourceId)).size !== resources.length) x2Fault("Z0_INHERITED_RESOURCE_POPULATION");
  for (const envelope of body.check.envelopes) {
    const original = reservation.envelopes.find(item => item.resourceId === envelope.resourceId && item.unit === envelope.unit);
    const demand = body.acquisitionRequest.resourceDemand.find(item => item.resourceId === envelope.resourceId && item.unit === envelope.unit);
    if (!original || !demand || x2Digest(original.horizon) !== x2Digest(envelope.horizon)
      || original.kind !== envelope.kind || envelope.quantities.length !== original.quantities.length
      || envelope.quantities.some((quantity, index) => exactUnits(quantity) > exactUnits(original.quantities[index]))
      || envelope.quantities.reduce((sum, quantity) => sum + exactUnits(quantity), 0n) !== exactUnits(demand.amount)) {
      x2Fault("Z0_CHILD_ENVELOPE_CANNOT_ENLARGE_ORIGINAL");
    }
  }
  return { certificate: { ...body, ref }, reservation, resources, origin, decision };
}
export async function readInheritedApplicationAllocation(ctx: PeMutationContext, ref: ExperimentRef,
  c: PoolClient, recovery = false): Promise<InheritedApplicationAllocation> {
  const frame = await storedFrame(ctx, ref, c, recovery);
  const root = (await c.query<{ body: ApplicationAllocationConsumption }>(`SELECT body FROM finnor_os.s5_consumptions
    WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3
      AND node_id='original-computation' AND body->'certificateRef'=$4::jsonb`,
    [ctx.auth.tenantId, principal(ctx), frame.reservation.ref.id, JSON.stringify(ref)])).rows[0]?.body;
  if (!root || !sameX2Ref(x2Ref("S5", "application-consumption", omitRef(root)), root.ref)) {
    x2Fault("Z0_ORIGINAL_APPLICATION_COMPUTATION_REQUIRED");
  }
  return { certificate: frame.certificate, reservation: frame.reservation, resources: frame.resources, rootConsumption: root };
}
const omitRef = <T extends { ref: ExperimentRef }>(value: T) => {
  const { ref: _ref, ...body } = value;
  return body;
};
export async function inheritedApplicationConsumption(ctx: PeMutationContext, c: PoolClient, input: ConsumptionInput) {
  const frame = await storedFrame(ctx, input.certificateRef, c, false);
  if (!sameX2Ref(frame.reservation.ref, input.reservationRef)
    || !sameX2Ref(frame.certificate.originalParentRef, input.originalParentRef)
    || x2Digest(input.envelope) !== x2Digest(frame.reservation.envelopes)) x2Fault("Z0_ORIGINAL_APPLICATION_CONSUMPTION_FRAME");
  const prior = (await c.query<{ body: ApplicationAllocationConsumption }>(`SELECT body FROM finnor_os.s5_consumptions
    WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0]?.body;
  if (prior) {
    const { schema: _schema, createdAt: _time, status: _status, effectRef: _effect,
      executionAuthorityGranted: _authority, ...originalInput } = omitRef(prior);
    if (x2Digest(originalInput) !== x2Digest(input)
      || !sameX2Ref(x2Ref("S5", "application-consumption", omitRef(prior)), prior.ref)) x2Fault("Z0_ORIGINAL_CONSUMPTION_REPLAY_CONFLICT");
    return prior;
  }
  const body: Omit<ApplicationAllocationConsumption, "ref"> = { ...input,
    schema: "finnor.s5.application-consumption.v1", createdAt: new Date().toISOString(),
    status: "INTENDED_PENDING_S6", effectRef: null, executionAuthorityGranted: false };
  const record = { ...body, ref: x2Ref("S5", "application-consumption", body) };
  const retained = (await c.query<{ body: ApplicationAllocationConsumption }>(
    "SELECT finnor_os.z0_s5_application_consumption($1::jsonb,$2) body", [JSON.stringify(record), frame.decision.id])).rows[0]?.body;
  if (!retained || x2Digest(retained) !== x2Digest(record)) x2Fault("Z0_S5_OWNER_CONSUMPTION_RECEIPT_REQUIRED");
  return retained;
}

export async function reserveInheritedApplicationParent(ctx: PeMutationContext, input: {
  originalParentRef: ExperimentRef; preparationRef: ExperimentRef; rightsRef: string;
  requestDigest: string; demand: ApplicationResourceDemand[]; request: InstitutionalAcquireRequest;
  origin: PreparedInstitutionOrigin;
  onReserved: (c: PoolClient, allocation: InheritedApplicationAllocation) => Promise<void>;
}): Promise<InheritedApplicationAllocation> {
  return withS5PortfolioTransaction(ctx, async c => {
    const prior = (await c.query<{ request_digest: string; allocation_ref: ExperimentRef }>(`SELECT request_digest,allocation_ref
      FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
      [ctx.auth.tenantId, principal(ctx), input.request.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== input.requestDigest) x2Fault("Z0_INSTITUTION_ACQUISITION_REPLAY_CONFLICT");
      return readInheritedApplicationAllocation(ctx, prior.allocation_ref, c, true);
    }
    await assertInstitutionApplicationOriginCurrent(ctx, input.origin, input.request, c);
    await assertOriginalInstitutionOwnerIdle(ctx, input.origin, c);
    const { reservation } = await assertOriginalResources(ctx, input.origin, c);
    const charges = (await c.query<{ resourceId: string; unit: string; units: string }>(
      `SELECT resource_id "resourceId",unit,sum(units)::text units FROM finnor_os.s5_governed_resource_charges
       WHERE tenant_id=$1 AND reservation_id=$2 GROUP BY resource_id,unit`,
      [ctx.auth.tenantId, reservation.ref.id])).rows;
    remainingInstitutionBudget(reservation.envelopes, charges, input.demand);
    const snapshot = await readAllocationSnapshotTx(ctx, c);
    const resources = input.demand.map(demand => {
      const resource = snapshot.resources.find(item => item.resourceId === demand.resourceId);
      if (!resource || resource.ownerRef.id !== principal(ctx) || resource.unit !== demand.unit
        || resource.kind !== "CUMULATIVE_EXPENDITURE" || resource.currency !== null || resource.revoked || resource.covenants.length
        || resource.resourceClass !== (demand.unit === "seconds" ? "HUMAN_ATTENTION" : "COMPUTE")
        || !reservation.envelopes.some(envelope => envelope.resourceId === resource.resourceId)
        || !resource.permittedRoots.some(root => x2Digest(root) === x2Digest(input.request.root))
        || Date.parse(resource.validUntil) < Date.parse(input.origin.body.deadlineAt)
        || Date.parse(resource.horizon.startAt) > Date.now()
        || Date.parse(resource.horizon.startAt) + resource.horizon.periodMs * resource.horizon.periods < Date.parse(input.origin.body.deadlineAt)) {
        x2Fault("Z0_INHERITED_APPLICATION_RESOURCE_DOMAIN");
      }
      return resource;
    });
    const envelopes = input.demand.map(demand => {
      const original = reservation.envelopes.find(line => line.resourceId === demand.resourceId)!;
      return { ...original, quantities: original.quantities.map((_, index) => index ? "0" : demand.amount),
        minimumQuantities: original.quantities.map(() => "0") };
    });
    const body: Omit<InheritedApplicationCertificate, "ref"> = {
      schema: "finnor.s5.application-allocation.v1", tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      originalParentRef: input.originalParentRef, preparationRef: input.preparationRef, rightsRef: input.rightsRef,
      workId: input.request.workId, deadlineAt: input.origin.body.deadlineAt, createdAt: new Date().toISOString(),
      resourceRefs: resources.map(resource => resource.ref), check: { envelopes, exactResourceCheck: true },
      policyBindings: [{ policyRef: input.preparationRef, demandDigest: x2Digest(input.demand) }],
      institutionalOriginRef: input.origin.ref, originalReservationRef: reservation.ref,
      acquisitionRequest: input.request, requestDigest: input.requestDigest,
      occupation: "EXISTING_ORIGINAL_X1_RESERVATION_NO_NEW_FUNDING",
      protectionDomain: "DISPOSABLE_TEST_AUTHORITY", executionAuthorityGranted: false,
    };
    const certificate = { ...body, ref: x2Ref("S5", "institution-application-allocation", body) };
    await retainApplicationArtifact(ctx, input.origin.ref, input.origin.body, false, c, [input.rightsRef]);
    await retainApplicationArtifact(ctx, certificate.ref, body, false, c, [input.rightsRef]);
    const rootConsumption = await inheritedApplicationConsumption(ctx, c, {
      originalParentRef: input.originalParentRef, certificateRef: certificate.ref, reservationRef: reservation.ref,
      preparationRef: input.preparationRef, operationRef: input.preparationRef, nodeId: "original-computation",
      idempotencyKey: `x2-parent-compute:${certificate.ref.contentDigest}`, requestDigest: input.requestDigest,
      predecessorObservationRef: input.preparationRef, envelope: reservation.envelopes,
    });
    const allocation = { certificate, reservation, resources, rootConsumption };
    await retainApplicationArtifact(ctx, rootConsumption.ref, omitRef(rootConsumption), false, c, [input.rightsRef]);
    await input.onReserved(c, allocation);
    return allocation;
  });
}
export async function chargeInheritedApplicationParent(ctx: PeMutationContext, input: {
  allocationRef: ExperimentRef; consumptionRef: ExperimentRef; requestRef: ExperimentRef;
  phase: ApplicationPhase; key: string; units: number; recovery?: boolean;
}, client?: PoolClient): Promise<ExperimentRef> {
  const write = async (c: PoolClient) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s5-portfolio:${ctx.auth.tenantId}`]);
    const frame = await storedFrame(ctx, input.allocationRef, c, Boolean(input.recovery));
    const requestDigest = x2Digest(input), chargeKey = "x2-unit:" + x2Digest([input.allocationRef, input.phase, input.key]);
    const prior = (await c.query<{ request_digest: string; body: { ref: ExperimentRef } }>(
      "SELECT request_digest,body FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3",
      [ctx.auth.tenantId, frame.reservation.ref.id, chargeKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest || !sameX2Ref(x2Ref("S5", "application-resource-charge", omitRef(prior.body)), prior.body.ref)) {
        x2Fault("Z0_INHERITED_CHARGE_REPLAY_CONFLICT");
      }
      return prior.body.ref;
    }
    if (!input.key || input.key.length > 256) x2Fault("Z0_ORIGINAL_CHARGE_DOMAIN");
    const unit = input.phase === "HUMAN" ? "seconds" : "request";
    const matches = frame.certificate.check.envelopes.filter(line => line.unit === unit);
    if (matches.length !== 1) x2Fault("Z0_INHERITED_CHARGE_UNFUNDED");
    const envelope = matches[0]!, original = frame.reservation.envelopes.find(line => line.resourceId === envelope.resourceId)!;
    const used = (await c.query<{ parent_used: string; child_used: string; n: string }>(
      `SELECT coalesce(sum(units),0)::text parent_used,
        coalesce(sum(units) FILTER(WHERE body->'allocationRef'=$4::jsonb),0)::text child_used,count(*)::text n
       FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND resource_id=$3`,
      [ctx.auth.tenantId, frame.reservation.ref.id, envelope.resourceId, JSON.stringify(input.allocationRef)])).rows[0]!;
    if (exactUnits(used.n) >= 1420n) x2Fault("Z0_ORIGINAL_CHARGE_POPULATION_BOUND");
    const limit = original.quantities.reduce((sum, quantity) => sum + exactUnits(quantity), 0n).toString();
    const childLimit = envelope.quantities.reduce((sum, quantity) => sum + exactUnits(quantity), 0n).toString();
    const checked = assertInheritedCharge({ parentLimit: limit, parentUsed: used.parent_used,
      childLimit, childUsed: used.child_used, units: input.units, phase: input.phase, recovery: Boolean(input.recovery) });
    const body = { schema: "finnor.s5.application-resource-charge.v1", semanticOwner: "S5",
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), originalParentRef: frame.certificate.originalParentRef,
      allocationRef: input.allocationRef, reservationRef: frame.reservation.ref, consumptionRef: input.consumptionRef,
      requestRef: input.requestRef, phase: input.phase, chargeKey, requestDigest, units: input.units,
      resourceId: envelope.resourceId, unit, limit, usedAfter: checked.parentUsedAfter,
      childLimit, childUsedAfter: checked.childUsedAfter, recovery: Boolean(input.recovery),
      createdAt: new Date().toISOString(), costs: { money: null, status: "UNMETERED", releaseSufficient: false },
      qualification: "CONSERVATIVE_ORIGINAL_OCCUPATION_NOT_BILLING", executionAuthorityGranted: false, protectedReceipt: null };
    const charge = { ...body, ref: x2Ref("S5", "application-resource-charge", body) };
    const stored = (await c.query<{ body: typeof charge }>(
      "SELECT finnor_os.z0_s5_application_charge($1::jsonb,$2) body", [JSON.stringify(charge), frame.decision.id])).rows[0]?.body;
    if (!stored || x2Digest(stored) !== x2Digest(charge)) x2Fault("Z0_S5_OWNER_CHARGE_RECEIPT_REQUIRED");
    await retainApplicationArtifact(ctx, charge.ref, body, false, c, [frame.certificate.rightsRef]);
    return charge.ref;
  };
  return client ? write(client) : withS5PortfolioTransaction(ctx, write);
}
/** The S5 owner derives effect/state from canonical S6 rows, never a caller's
 * success flag. Observations never release or downgrade parent uncertainty. */
export async function inheritedApplicationEffectState(ctx: PeMutationContext, c: PoolClient,
  obligationId: string, stage: "BOUND" | "POSSIBLE" | "OBSERVED") {
  const row = (await c.query<{ revision: number }>(
    "SELECT (finnor_os.z0_s5_application_effect_state($1,$2)->>'revision')::integer revision",
    [obligationId, stage])).rows[0];
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1) x2Fault("Z0_S5_CANONICAL_EFFECT_STATE_REQUIRED");
  return row;
}
export async function projectInheritedApplicationBudget(ctx: PeMutationContext, ref: ExperimentRef) {
  return withS5PortfolioTransaction(ctx, async c => {
    const frame = await storedFrame(ctx, ref, c, true);
    const usage = (await c.query<{ resourceId: string; unit: string; units: string }>(
      `SELECT resource_id "resourceId",unit,sum(units)::text units FROM finnor_os.s5_governed_resource_charges
       WHERE tenant_id=$1 AND reservation_id=$2 GROUP BY resource_id,unit`,
      [ctx.auth.tenantId, frame.reservation.ref.id])).rows;
    // A projection reports exhaustion instead of requiring a new positive grant.
    return { originalReservationRef: frame.reservation.ref, status: frame.reservation.status,
      newReservation: false, releaseGranted: false, originalDeadlineAt: frame.origin.body.originalDeadlineAt,
      wallDeadlineAt: frame.origin.body.wallDeadlineAt, childDeadlineAt: frame.certificate.deadlineAt,
      resources: frame.reservation.envelopes.map(envelope => {
        const limit = envelope.quantities.reduce((sum, quantity) => sum + exactUnits(quantity), 0n);
        const used = usage.filter(line => line.resourceId === envelope.resourceId && line.unit === envelope.unit)
          .reduce((sum, line) => sum + exactUnits(line.units), 0n);
        return { resourceId: envelope.resourceId, unit: envelope.unit, limit: limit.toString(),
          used: used.toString(), remaining: (limit - used).toString(), overdrawn: used > limit };
      }), monetaryCost: null, monetaryCostStatus: "UNKNOWN" };
  });
}
