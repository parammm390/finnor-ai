import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import type { OrganizationReference, OrganizationTransformationProgram } from "./contracts";
import { organizationDigest } from "./compiler";
import { organizationPacketQuery, organizationPacketRead } from "./native-contracts";
import { organizationSelfContractTx, type OrganizationSelfOffer } from "./audience";
import { readOrganizationEvidenceTx } from "./sources";
import { orgActor, orgEvidence, orgFail, orgTx, principal, rawDigest, type OrganizationRequestRow } from "./store";

interface EvidenceField { field: string; ref: OrganizationReference }
interface ControlDisclosure {
  schema: "finnor.organization-original-control-packet.v1";
  requestId: string; useKey: string; processId: string; originalWorkId: string; originalMeaningDigest: string;
  control: { id: string; kind: string; roleId: string; mandatory: boolean; requiredEvidence: string[] };
  preparedByRoleId: string; preparedEvidence: EvidenceField[];
  approvalGranted: false; externalEffectRequested: false; sourceDocumentsReviewed: false;
  qualification: "PREPARED_REFERENCE_PACKET_NOT_UNDERLYING_DOCUMENT_REVIEW_OR_APPROVAL";
}
interface DeliveryRow {
  request_id: string; principal_id: string; use_key: string; process_id: string; work_id: string;
  control_id: string; role_id: string; recipient_id: string; terms_digest: string;
  packet_ref: OrganizationReference; disclosure: ControlDisclosure; disclosure_digest: string;
  created_at: Date; offer: OrganizationSelfOffer;
}

/** Called only by the claimed owner worker, in the same transaction as the
 * accepted use. Recipients come from unchanged original nodes, never the caller. */
export async function deliverOrganizationPacketsTx(ctx: TenantContext, q: OrganizationRequestRow,
  program: OrganizationTransformationProgram, request: {
    workId: string; processId: string; roleId: string; packetRef: OrganizationReference; evidence: EvidenceField[];
  }, useKey: string, c: PoolClient) {
  const alternative = program.alternatives.find(a => a.id === program.selectedAlternativeId);
  const original = q.original.organization.processes.find(p => p.id === request.processId);
  if (!alternative || !original) orgFail("W5_ORIGINAL_CONTROL_PROCESS_REQUIRED");
  const work = (await c.query(`SELECT w.initial_instruction FROM finnor_os.works w
    WHERE w.tenant_id=$1 AND w.id=$2 AND EXISTS(SELECT 1 FROM finnor_os.work_entity_links l
      WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id AND l.entity_type='external_organization' AND l.entity_id=$3)
    FOR SHARE OF w`, [ctx.tenantId, request.workId, q.company_id])).rows[0];
  if (!work) orgFail("W5_PROCESS_USE_MUST_RETAIN_ACTUAL_ORIGINAL_COMPANY_WORK");
  const targets = original.nodes.filter(node => alternative.constructedAssets.some(asset =>
    asset.processId === original.id && asset.outputFields.includes("prepared_for:" + node.id) &&
    alternative.processes.some(process => process.id === original.id &&
      process.nodes.some(gate => gate.id === asset.nodeId && gate.roleId === request.roleId))));
  if (!targets.length) orgFail("W5_ORIGINAL_PACKET_RECIPIENT_NOT_CONSTRUCTED");
  for (const control of targets) {
    const role = q.original.organization.roles.find(r => r.id === control.roleId);
    const offer = (await c.query<OrganizationSelfOffer>(`SELECT * FROM finnor_os.w5_role_offers
      WHERE tenant_id=$1 AND request_id=$2 AND role_id=$3 AND revoked_at IS NULL
        AND expires_at>clock_timestamp() FOR SHARE`, [ctx.tenantId, q.id, control.roleId])).rows[0];
    const adoption = program.adoptions.find(a => a.roleId === control.roleId);
    if (!role || !offer || offer.participant_id !== role.principalId || offer.alternative_id !== alternative.id ||
        adoption?.state !== "ADOPTED" || adoption.principalId !== role.principalId ||
        adoption.termsDigest !== offer.terms_digest) orgFail("W5_UNCHANGED_SELF_ADOPTED_ORIGINAL_RECIPIENT_REQUIRED");
    const preparedEvidence = request.evidence.filter(item => control.requiredEvidence.includes(item.field));
    if (control.requiredEvidence.some(field => !preparedEvidence.some(item => item.field === field)))
      orgFail("W5_ORIGINAL_CONTROL_REQUIRED_EVIDENCE_NOT_PREPARED");
    const disclosure: ControlDisclosure = {
      schema: "finnor.organization-original-control-packet.v1", requestId: q.id, useKey,
      processId: original.id, originalWorkId: request.workId, originalMeaningDigest: rawDigest(work.initial_instruction),
      control: { id: control.id, kind: control.kind, roleId: control.roleId,
        mandatory: control.mandatory, requiredEvidence: control.requiredEvidence },
      preparedByRoleId: request.roleId, preparedEvidence, approvalGranted: false,
      externalEffectRequested: false, sourceDocumentsReviewed: false,
      qualification: "PREPARED_REFERENCE_PACKET_NOT_UNDERLYING_DOCUMENT_REVIEW_OR_APPROVAL",
    };
    await c.query(`INSERT INTO finnor_os.w5_control_deliveries(tenant_id,request_id,principal_id,use_key,process_id,
      work_id,control_id,role_id,recipient_id,alternative_id,terms_digest,packet_ref,disclosure,disclosure_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`, [ctx.tenantId, q.id, q.principal_id,
      useKey, original.id, request.workId, control.id, control.roleId, role.principalId, alternative.id,
      offer.terms_digest, JSON.stringify(request.packetRef), JSON.stringify(disclosure), organizationDigest(disclosure)]);
  }
  return targets.length;
}

async function currentPacketTx(ctx: TenantContext, delivery: DeliveryRow, c: PoolClient) {
  if (delivery.recipient_id !== principal(ctx) || delivery.disclosure_digest !== organizationDigest(delivery.disclosure) ||
      delivery.disclosure.requestId !== delivery.request_id || delivery.disclosure.useKey !== delivery.use_key ||
      delivery.disclosure.originalWorkId !== delivery.work_id || delivery.disclosure.control.id !== delivery.control_id ||
      delivery.disclosure.control.roleId !== delivery.role_id) orgFail("W5_ORIGINAL_PACKET_PREIMAGE_CHANGED");
  const head = await organizationSelfContractTx(ctx, delivery.offer, c);
  if (head.status !== "CURRENT" || !["TRIAL", "ACTIVE"].includes(head.phase ?? "") ||
      head.revision === null || delivery.terms_digest !== delivery.offer.terms_digest) return null;
  const adopted = (await c.query(`SELECT decision,terms_digest FROM finnor_os.w5_adoption_decisions
    WHERE tenant_id=$1 AND request_id=$2 AND participant_id=$3 AND role_id=$4
    ORDER BY created_at DESC,id DESC LIMIT 1`, [ctx.tenantId, delivery.request_id, principal(ctx), delivery.role_id])).rows[0];
  if (adopted?.decision !== "ADOPT" || adopted.terms_digest !== delivery.terms_digest) return null;
  if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: "query", capability: "query:work",
    workId: delivery.work_id, resource: { type: "work", id: delivery.work_id }, risk: "low" }, c)) return null;
  const packet = await readOrganizationEvidenceTx(ctx, delivery.packet_ref, c);
  if (packet.record.schema !== "finnor.organization-prepared-packet.v1" ||
      packet.record.requestId !== delivery.request_id || packet.record.workId !== delivery.work_id ||
      packet.record.processId !== delivery.process_id || !Array.isArray(packet.record.preparedEvidence) ||
      delivery.disclosure.preparedEvidence.some(item => !packet.record.preparedEvidence.some((original: EvidenceField) =>
        original.field === item.field && organizationDigest(original.ref) === organizationDigest(item.ref))))
    orgFail("W5_ACTUAL_ORIGINAL_PREPARED_PACKET_REQUIRED");
  for (const item of delivery.disclosure.preparedEvidence) await readOrganizationEvidenceTx(ctx, item.ref, c);
  return head;
}

async function selfDeliveriesTx(ctx: TenantContext, input: { requestId?: string; workId?: string }, c: PoolClient) {
  const rows = (await c.query<DeliveryRow>(`SELECT d.*,to_jsonb(o) offer FROM finnor_os.w5_control_deliveries d
    JOIN finnor_os.w5_role_offers o ON o.tenant_id=d.tenant_id AND o.request_id=d.request_id AND o.role_id=d.role_id
    WHERE d.tenant_id=$1 AND d.recipient_id=$2 AND o.participant_id=$2
      AND ($3::uuid IS NULL OR d.request_id=$3) AND ($4::uuid IS NULL OR d.work_id=$4)
    ORDER BY d.created_at,d.request_id,d.use_key,d.control_id LIMIT 129`,
    [ctx.tenantId, principal(ctx), input.requestId ?? null, input.workId ?? null])).rows;
  if (rows.length > 128) orgFail("W5_COMPLETE_ORIGINAL_PACKET_POPULATION_REQUIRED");
  return rows;
}
export async function readOrganizationPackets(ctx: TenantContext, value: unknown) {
  const input = organizationPacketQuery.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c);
    const deliveries = await selfDeliveriesTx(ctx, input, c), packets = [];
    for (const row of deliveries) {
      const current = await currentPacketTx(ctx, row, c);
      if (!current) continue;
      const read = (await c.query(`SELECT source_ref,created_at FROM finnor_os.w5_control_reads
        WHERE tenant_id=$1 AND request_id=$2 AND use_key=$3 AND control_id=$4 AND participant_id=$5`,
        [ctx.tenantId, row.request_id, row.use_key, row.control_id, principal(ctx)])).rows[0];
      packets.push({ requestId: row.request_id, useKey: row.use_key, processId: row.process_id, workId: row.work_id,
        recipientPrincipalId: row.recipient_id, control: row.disclosure.control, termsDigest: row.terms_digest, packetRef: row.packet_ref,
        disclosure: row.disclosure, disclosureDigest: row.disclosure_digest, currentness: current,
        read: read ? { readRef: read.source_ref, acknowledgedAt: read.created_at } : null });
    }
    return { access: "ORIGINAL_CONTROL_RECIPIENT" as const, packets, unavailablePacketCount: deliveries.length - packets.length,
      parentPrivateDataDisclosed: false, approvalGranted: false, externalEffectDispatched: false,
      qualification: "SELF_SCOPED_PREPARED_REFERENCE_PACKETS_NOT_CORE_APPROVAL" };
  });
}

export async function acknowledgeOrganizationPacket(ctx: TenantContext, value: unknown) {
  const input = organizationPacketRead.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      ["w5-control-read:" + ctx.tenantId + ":" + input.requestId + ":" + principal(ctx)]);
    const deliveries = await selfDeliveriesTx(ctx, { requestId: input.requestId }, c);
    const delivery = deliveries.find(row => row.use_key === input.useKey && row.control_id === input.controlId);
    if (!delivery) orgFail("W5_EXACT_ORIGINAL_CONTROL_SELF_RECIPIENT_REQUIRED", 403);
    if (delivery.terms_digest !== input.termsDigest || delivery.disclosure_digest !== input.disclosureDigest ||
        organizationDigest(delivery.packet_ref) !== organizationDigest(input.packetRef))
      orgFail("W5_EXACT_DELIVERED_PACKET_AND_TERMS_REQUIRED");
    if (!await currentPacketTx(ctx, delivery, c)) orgFail("W5_CURRENT_ORIGINAL_CONTROL_PACKET_REQUIRED");
    const byKey = (await c.query(`SELECT * FROM finnor_os.w5_control_reads WHERE tenant_id=$1
      AND request_id=$2 AND participant_id=$3 AND idempotency_key=$4`,
      [ctx.tenantId, input.requestId, principal(ctx), input.idempotencyKey])).rows[0];
    if (byKey && byKey.request_digest !== organizationDigest(input)) orgFail("W5_PACKET_READ_IDEMPOTENCY_CONFLICT");
    const prior = byKey ?? (await c.query(`SELECT * FROM finnor_os.w5_control_reads WHERE tenant_id=$1
      AND request_id=$2 AND participant_id=$3 AND use_key=$4 AND control_id=$5`,
      [ctx.tenantId, input.requestId, principal(ctx), input.useKey, input.controlId])).rows[0];
    if (prior) return { readRef: prior.source_ref, semanticReplay: true,
      approvalGranted: false, externalEffectDispatched: false };
    const source = await orgEvidence(ctx, delivery.work_id, "control-read:" + input.requestId + ":" +
      principal(ctx) + ":" + input.idempotencyKey, {
        schema: "finnor.organization-original-control-self-read.v1", ...input, authenticatedPrincipalId: principal(ctx),
        controlRoleId: delivery.role_id, originalWorkId: delivery.work_id,
        underlyingDocumentsReviewed: false, approvalGranted: false, externalEffectDispatched: false,
      }, c);
    await c.query(`INSERT INTO finnor_os.w5_control_reads(tenant_id,id,request_id,principal_id,participant_id,
      use_key,control_id,idempotency_key,terms_digest,packet_ref,disclosure_digest,request_digest,source_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`, [ctx.tenantId, randomUUID(), input.requestId,
      delivery.principal_id, principal(ctx), input.useKey, input.controlId, input.idempotencyKey,
      input.termsDigest, JSON.stringify(input.packetRef), input.disclosureDigest, organizationDigest(input), JSON.stringify(source.ref)]);
    return { readRef: source.ref, semanticReplay: false, approvalGranted: false, externalEffectDispatched: false,
      qualification: "AUTHENTICATED_SELF_ACKNOWLEDGED_REFERENCE_PACKET_NOT_UNDERLYING_DOCUMENT_REVIEW_OR_APPROVAL" };
  });
}
