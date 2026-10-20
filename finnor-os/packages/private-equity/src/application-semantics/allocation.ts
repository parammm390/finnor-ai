/** Additive S5 application domain on the existing portfolio tables and lock. */
import type { PoolClient } from "pg";
import type {
  AllocationResource, ApplicationAllocationCertificate, ApplicationAllocationConsumption,
  ApplicationResourceEnvelope, ExperimentRef,
} from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { allocationSnapshotInTransaction, readAllocationSnapshot, withS5PortfolioTransaction } from "../allocation-store";
import { allocationQuantity } from "../../../epistemic-runtime/src/allocation-contracts";
import { validateBeliefViewPin } from "../enterprise-beliefs";
import { enqueueOwnerDeliveryInTransaction } from "../../../governed-execution/src/owner-delivery-store";
import type { ApplicationPhase, ApplicationResourceDemand } from "./native-contracts";
import { sameX2Ref, x2Digest, x2Fault, x2Ref } from "./contracts";

interface ApplicationReservation {
  schema: "finnor.s5.application-reservation.v1"; ref: ExperimentRef;
  certificateRef: ExperimentRef; tenantId: string; principalId: string;
  idempotencyKey: string; requestDigest: string; createdAt: string;
  envelopes: ApplicationResourceEnvelope[]; status: string; revision: number; revocationReason: string | null;
  executionAuthorityGranted: false; protectedReceipt: null;
}
export interface ApplicationAllocation {
  certificate: ApplicationAllocationCertificate; reservation: ApplicationReservation;
  resources: AllocationResource[]; rootConsumption: ApplicationAllocationConsumption;
}
function units(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) x2Fault("X2_S5_EXACT_UNIT_REPRESENTATION");
  return BigInt(value);
}
const original = <T extends { ref: ExperimentRef }>(record: T) => {
  const { ref, ...body } = record;
  if (x2Digest(body) !== ref.contentDigest) x2Fault("X2_S5_OWNER_PREIMAGE_INTEGRITY");
  return body;
};
async function commitReference(ctx: PeMutationContext, c: PoolClient, record: { ref: ExperimentRef }, rightsRef: string) {
  const content = original(record);
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: "S5", tenantId: ctx.auth.tenantId, principalId: principal(ctx) },
    { kind: "REFERENCE", identity: record.ref.id, payload: { reference: { ...record.ref, content }, rightsRefs: [rightsRef] } });
}
export async function reserveApplicationParent(ctx: PeMutationContext, input: {
  originalParentRef: ExperimentRef; preparationRef: ExperimentRef; workId: string; rightsRef: string;
  deadlineAt: string; idempotencyKey: string; requestDigest: string; demand: ApplicationResourceDemand[];
  root: { entityType: string; entityId: string };
  onReserved?: (client: PoolClient, allocation: ApplicationAllocation) => Promise<void>;
}): Promise<ApplicationAllocation> {
  const snapshot = await readAllocationSnapshot(ctx);
  const demandIds = new Set(input.demand.map((item) => item.resourceId));
  if (demandIds.size !== input.demand.length || !input.demand.some((item) => item.unit === "request")
    || input.demand.some((item) => units(item.amount) < 1n || units(item.amount) > (item.unit === "seconds" ? 900n : 2048n))) {
    x2Fault("X2_S5_ORIGINAL_DEMAND_DOMAIN");
  }
  const resources = input.demand.map((demand) => {
    const resource = snapshot.resources.find((item) => item.resourceId === demand.resourceId);
    if (!resource || resource.ownerRef.id !== principal(ctx) || resource.unit !== demand.unit || resource.kind !== "CUMULATIVE_EXPENDITURE"
      || resource.resourceClass !== (demand.unit === "seconds" ? "HUMAN_ATTENTION" : "COMPUTE") || resource.revoked
      || resource.covenants.length || !resource.permittedRoots.some((root) => x2Digest(root) === x2Digest(input.root))
      || Date.parse(resource.validUntil) < Date.parse(input.deadlineAt)
      || Date.parse(resource.horizon.startAt) > Date.now()
      || Date.parse(resource.horizon.startAt) + resource.horizon.periodMs * resource.horizon.periods < Date.parse(input.deadlineAt)) x2Fault("X2_S5_CURRENT_RESOURCE_DOMAIN");
    return resource;
  });
  for (const resource of resources) for (const pin of resource.beliefPins) {
    if ((await validateBeliefViewPin(ctx, pin)).status !== "CURRENT") x2Fault("X2_S5_CURRENT_RESOURCE_SOURCE");
  }
  return withS5PortfolioTransaction(ctx, async (c) => {
    const prior = (await c.query<{ allocation_digest: string | null; request_digest: string }>(
      "SELECT allocation_digest,request_digest FROM finnor_os.s5_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== input.requestDigest || !prior.allocation_digest) x2Fault("X2_S5_PARENT_IDEMPOTENCY_CONFLICT");
      return readApplicationAllocationInTransaction(ctx, c, x2RefFromDigest("application-allocation", prior.allocation_digest));
    }
    if (Date.parse(input.deadlineAt) <= Date.now() || Date.parse(input.deadlineAt) > Date.now() + 3600000) x2Fault("X2_S5_ORIGINAL_DEADLINE");
    const currentSnapshot = await allocationSnapshotInTransaction(c, ctx.auth.tenantId);
    const envelopes: ApplicationResourceEnvelope[] = [];
    for (const resource of resources) {
      const current = currentSnapshot.resources.find(item => item.resourceId === resource.resourceId);
      if (!current || x2Digest(current) !== x2Digest(resource)) x2Fault("X2_S5_RESOURCE_REVISION_CHANGED");
      const demand = input.demand.find((item) => item.resourceId === resource.resourceId)!;
      const requested = units(demand.amount);
      for (let period = 0; period <= resource.horizon.periods; period++) {
        const available = resource.availability[period];
        const existing = resource.existingUse[period];
        if (!available || available.amount === null || available.basis !== "REPORTED_AVAILABLE") x2Fault("X2_S5_AVAILABLE_RESOURCE_UNKNOWN");
        if (existing === undefined) x2Fault("X2_S5_EXISTING_USE_COVERAGE");
        let used = allocationQuantity("0");
        for (const quantity of resource.existingUse.slice(0, period + 1)) used = used.add(allocationQuantity(quantity));
        for (const reservation of currentSnapshot.outstanding) {
          const envelope = reservation.envelopes.find((item) => item.resourceId === resource.resourceId && item.unit === resource.unit);
          if (envelope) {
            if (envelope.kind !== resource.kind || x2Digest(envelope.horizon) !== x2Digest(resource.horizon)
              || envelope.quantities.length !== resource.horizon.periods + 1) x2Fault("X2_S5_OUTSTANDING_HORIZON_MISMATCH");
            for (const quantity of envelope.quantities.slice(0, period + 1)) used = used.add(allocationQuantity(quantity));
          }
        }
        if (used.add(allocationQuantity(requested.toString())).compare(
          allocationQuantity(available.amount).sub(allocationQuantity(resource.safetyMargin))) > 0) x2Fault("X2_S5_SHARED_RESOURCE_EXHAUSTED");
      }
      envelopes.push({ resourceId: resource.resourceId, unit: resource.unit, kind: "CUMULATIVE_EXPENDITURE",
        horizon: resource.horizon, minimumQuantities: Array.from({ length: resource.horizon.periods + 1 }, () => "0"),
        quantities: Array.from({ length: resource.horizon.periods + 1 }, (_, period) => period === 0 ? demand.amount : "0") });
    }
    const createdAt = new Date().toISOString();
    const certificateBody: Omit<ApplicationAllocationCertificate, "ref"> = {
      schema: "finnor.s5.application-allocation.v1", tenantId: ctx.auth.tenantId, principalId: principal(ctx),
      originalParentRef: input.originalParentRef, preparationRef: input.preparationRef, rightsRef: input.rightsRef,
      workId: input.workId, deadlineAt: input.deadlineAt, createdAt, resourceRefs: resources.map((resource) => resource.ref),
      policyBindings: [{ policyRef: input.preparationRef, demandDigest: x2Digest(input.demand) }],
      check: { envelopes, exactResourceCheck: true }, protectionDomain: "DISPOSABLE_TEST_AUTHORITY", executionAuthorityGranted: false,
    };
    const certificate = { ...certificateBody, ref: x2Ref("S5", "application-allocation", certificateBody) };
    const reservationBody: Omit<ApplicationReservation, "ref"> = {
      schema: "finnor.s5.application-reservation.v1", certificateRef: certificate.ref,
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest, createdAt, envelopes, status: "RESERVED", revision: 1,
      revocationReason: null, executionAuthorityGranted: false, protectedReceipt: null,
    };
    const reservation = { ...reservationBody, ref: x2Ref("S5", "application-reservation", reservationBody) };
    await c.query("INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)",
      [ctx.auth.tenantId, principal(ctx), certificate.ref.contentDigest,
        JSON.stringify({ schema: "finnor.s5.application-resource-problem.v1", resources, demand: input.demand, originalParentRef: input.originalParentRef }), JSON.stringify(certificate)]);
    await c.query("INSERT INTO finnor_os.s5_requests(tenant_id,principal_id,idempotency_key,request_digest,allocation_digest) VALUES($1,$2,$3,$4,$5)",
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, input.requestDigest, certificate.ref.contentDigest]);
    await c.query("INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)",
      [ctx.auth.tenantId, principal(ctx), reservation.ref.id, certificate.ref.contentDigest, JSON.stringify(reservation)]);
    await c.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED',$4::jsonb)",
      [ctx.auth.tenantId, reservation.ref.id, certificate.ref.contentDigest, JSON.stringify(envelopes)]);
    const rootConsumption = await applicationConsumptionInTransaction(ctx, c, {
      originalParentRef: input.originalParentRef, certificateRef: certificate.ref, reservationRef: reservation.ref,
      preparationRef: input.preparationRef, operationRef: input.preparationRef, nodeId: "original-computation",
      idempotencyKey: `x2-parent-compute:${certificate.ref.contentDigest}`, requestDigest: input.requestDigest,
      predecessorObservationRef: input.preparationRef, envelope: envelopes,
    });
    await commitReference(ctx, c, certificate, input.rightsRef);
    await commitReference(ctx, c, reservation, input.rightsRef);
    await commitReference(ctx, c, rootConsumption, input.rightsRef);
    const allocated = { certificate, reservation, resources, rootConsumption };
    await input.onReserved?.(c, allocated);
    return allocated;
  });
}
const x2RefFromDigest = (kind: string, digest: string): ExperimentRef =>
  ({ owner: "S5", id: `${kind}:${digest}`, version: "application-operation-v1", contentDigest: digest });

async function readApplicationAllocationInTransaction(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef): Promise<ApplicationAllocation> {
  if (ref.owner !== "S5" || ref.version !== "application-operation-v1" || ref.id !== `application-allocation:${ref.contentDigest}`) x2Fault("X2_S5_ALLOCATION_DOMAIN");
  const row = (await c.query<{ problem: { resources: AllocationResource[] }; certificate: ApplicationAllocationCertificate;
    origin: ApplicationReservation; revision: number; status: string; envelopes: ApplicationResourceEnvelope[]; revocation_reason: string | null }>(
    "SELECT p.problem,p.certificate,o.body origin,r.revision,r.status,r.envelopes,r.revocation_reason FROM finnor_os.s5_proposals p JOIN finnor_os.s5_reservation_origins o ON o.tenant_id=p.tenant_id AND o.allocation_digest=p.content_digest JOIN finnor_os.s5_reservations r ON r.tenant_id=o.tenant_id AND r.reservation_id=o.reservation_id WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.content_digest=$3 FOR SHARE OF r",
    [ctx.auth.tenantId, principal(ctx), ref.contentDigest])).rows[0];
  if (!row || row.certificate.schema !== "finnor.s5.application-allocation.v1" || !sameX2Ref(row.certificate.ref, ref)
    || x2Digest(original(row.certificate)) !== ref.contentDigest) x2Fault("X2_S5_ALLOCATION_INTEGRITY");
  original(row.origin);
  const root = (await c.query<{ body: ApplicationAllocationConsumption }>(
    "SELECT body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 AND node_id='original-computation'",
    [ctx.auth.tenantId, principal(ctx), row.origin.ref.id])).rows[0]?.body;
  if (!root) x2Fault("X2_S5_ORIGINAL_COMPUTATION_CONSUMPTION_REQUIRED");
  original(root);
  return { certificate: row.certificate, resources: row.problem.resources, rootConsumption: root,
    reservation: { ...row.origin, revision: row.revision, status: row.status, envelopes: row.envelopes, revocationReason: row.revocation_reason } };
}
export const readApplicationAllocation = (ctx: PeMutationContext, ref: ExperimentRef) =>
  withS5PortfolioTransaction(ctx, (c) => readApplicationAllocationInTransaction(ctx, c, ref));
export async function assertApplicationAllocationCurrent(ctx: PeMutationContext, ref: ExperimentRef, c?: PoolClient, recovery = false) {
  const inspect = async (client: PoolClient) => {
    const current = await readApplicationAllocationInTransaction(ctx, client, ref);
    if (current.reservation.status === "RELEASED" || !recovery && (current.reservation.revocationReason
      || Date.parse(current.certificate.deadlineAt) <= Date.now())) x2Fault("X2_S5_ORIGINAL_RESERVATION_NOT_CURRENT");
    if (x2Digest(current.reservation.envelopes) !== x2Digest(current.certificate.check.envelopes)) x2Fault("X2_S5_ORIGINAL_ENVELOPE_CHANGED");
    if (!recovery) for (const resource of current.resources) {
      const latest = (await client.query<{ body: AllocationResource }>(
        "SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2",
        [ctx.auth.tenantId, resource.resourceId])).rows[0]?.body;
      if (!latest || x2Digest(latest) !== x2Digest(resource) || latest.revoked || Date.parse(latest.validUntil) <= Date.now()
        || Date.parse(latest.horizon.startAt) > Date.now()
        || Date.parse(latest.horizon.startAt) + latest.horizon.periodMs * latest.horizon.periods <= Date.now()) x2Fault("X2_S5_RESOURCE_SOURCE_OR_REVISION_CHANGED");
      for (const pin of resource.beliefPins) {
        if ((await validateBeliefViewPin(ctx, pin)).status !== "CURRENT") x2Fault("X2_S5_CURRENT_RESOURCE_SOURCE");
      }
    }
    return current;
  };
  return c ? inspect(c) : withS5PortfolioTransaction(ctx, inspect);
}
type ConsumptionInput = Omit<ApplicationAllocationConsumption, "schema" | "ref" | "createdAt" | "status" | "effectRef" | "executionAuthorityGranted">;
export async function applicationConsumptionInTransaction(ctx: PeMutationContext, c: PoolClient, input: ConsumptionInput) {
  const prior = (await c.query<{ body: ApplicationAllocationConsumption; request_digest: string }>(
    "SELECT body,request_digest FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
    [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
  if (prior) {
    if (prior.request_digest !== input.requestDigest || !sameX2Ref(prior.body.reservationRef, input.reservationRef)) x2Fault("X2_S5_CONSUMPTION_IDENTITY_CONFLICT");
    original(prior.body); return prior.body;
  }
  const body: Omit<ApplicationAllocationConsumption, "ref"> = {
    ...input, schema: "finnor.s5.application-consumption.v1", createdAt: new Date().toISOString(),
    status: "INTENDED_PENDING_S6", effectRef: null, executionAuthorityGranted: false,
  };
  const record = { ...body, ref: x2Ref("S5", "application-consumption", body) };
  await c.query("INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
    [ctx.auth.tenantId, principal(ctx), record.ref.id, input.reservationRef.id, input.preparationRef.id, input.nodeId,
      input.idempotencyKey, input.requestDigest, JSON.stringify(record)]);
  await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",
    [ctx.auth.tenantId, record.ref.id]);
  return record;
}
export async function chargeApplicationParent(ctx: PeMutationContext, input: {
  allocationRef: ExperimentRef; consumptionRef: ExperimentRef; requestRef: ExperimentRef;
  phase: ApplicationPhase; key: string; units: number; recovery?: boolean;
}, client?: PoolClient): Promise<ExperimentRef> {
  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > 2048 || !input.key || input.key.length > 256) x2Fault("X2_S5_CHARGE_DOMAIN");
  const write = async (c: PoolClient) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s5-portfolio:${ctx.auth.tenantId}`]);
    const allocation = await assertApplicationAllocationCurrent(ctx, input.allocationRef, c, input.recovery);
    const requestDigest = x2Digest(input), chargeKey = "x2-unit:" + x2Digest([input.allocationRef, input.phase, input.key]);
    const prior = (await c.query<{ request_digest: string; body: { ref: ExperimentRef } }>(
      "SELECT request_digest,body FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND charge_key=$3",
      [ctx.auth.tenantId, allocation.reservation.ref.id, chargeKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) x2Fault("X2_S5_CHARGE_IDENTITY_CONFLICT");
      original(prior.body); return prior.body.ref;
    }
    const unit = input.phase === "HUMAN" ? "seconds" : "request";
    const resources = allocation.resources.filter((resource) => resource.unit === unit);
    if (resources.length !== 1) x2Fault("X2_S5_CHARGE_UNFUNDED_OR_AMBIGUOUS");
    const resource = resources[0]!, envelope = allocation.reservation.envelopes.find((item) => item.resourceId === resource.resourceId)!;
    if (!envelope?.quantities.length) x2Fault("X2_S5_ORIGINAL_ENVELOPE_REQUIRED");
    const limit = envelope.quantities.reduce((sum, value) => sum + units(value), 0n);
    const consumption = (await c.query<{ body: ApplicationAllocationConsumption }>(
      "SELECT body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND principal_id=$2 AND consumption_id=$3 AND reservation_id=$4",
      [ctx.auth.tenantId, principal(ctx), input.consumptionRef.id, allocation.reservation.ref.id])).rows[0]?.body;
    if (!consumption || !sameX2Ref(consumption.ref, input.consumptionRef)) x2Fault("X2_S5_EXACT_CHARGE_CONSUMPTION");
    const aggregate = (await c.query<{ used: string; count: string }>(
      "SELECT coalesce(sum(units),0)::text used,count(*)::text count FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 AND resource_id=$3",
      [ctx.auth.tenantId, allocation.reservation.ref.id, resource.resourceId])).rows[0]!;
    const used = units(aggregate.used);
    if (used + BigInt(input.units) > limit || units(aggregate.count) >= 2048n) x2Fault("X2_S5_ORIGINAL_BUDGET_EXHAUSTED");
    const body = { schema: "finnor.s5.application-resource-charge.v1", semanticOwner: "S5",
      tenantId: ctx.auth.tenantId, principalId: principal(ctx), originalParentRef: allocation.certificate.originalParentRef,
      allocationRef: input.allocationRef, reservationRef: allocation.reservation.ref, consumptionRef: input.consumptionRef,
      requestRef: input.requestRef, phase: input.phase, chargeKey, requestDigest, units: input.units,
      resourceId: resource.resourceId, unit, limit: limit.toString(), usedAfter: (used + BigInt(input.units)).toString(),
      createdAt: new Date().toISOString(), costs: { money: null, status: "UNMETERED", releaseSufficient: false },
      qualification: "CONSERVATIVE_ORIGINAL_OCCUPATION_NOT_BILLING", executionAuthorityGranted: false, protectedReceipt: null };
    const charge = { ...body, ref: x2Ref("S5", "application-resource-charge", body) };
    await c.query("INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      [ctx.auth.tenantId, principal(ctx), allocation.reservation.ref.id, input.consumptionRef.id, chargeKey, input.phase,
        resource.resourceId, unit, input.units, requestDigest, JSON.stringify(charge)]);
    await commitReference(ctx, c, charge, allocation.certificate.rightsRef);
    return charge.ref;
  };
  return client ? write(client) : withS5PortfolioTransaction(ctx, write);
}
export async function applicationParentCharges(ctx: PeMutationContext, allocationRef: ExperimentRef) {
  return tx(ctx, async (c) => (await c.query<{ body: Record<string, unknown> }>(
    "SELECT body FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND principal_id=$2 AND body->'allocationRef'=$3::jsonb ORDER BY created_at,charge_key LIMIT 2049",
    [ctx.auth.tenantId, principal(ctx), JSON.stringify(allocationRef)])).rows.map((row) => row.body), true);
}
