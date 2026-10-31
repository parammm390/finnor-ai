import { receiveWork } from "@finnor/db";
import type { PoolClient } from "pg";
import { digest, fail, type Y3Ref } from "../../../../private-equity/src/interaction-synthesis/contracts";

/** A canonical Work projection of one real participant's original S4 terms.
 * This is not a new computation, reservation, consent or effect authority. */
export interface ParticipantWorkBinding {
  schema: "finnor.project-z.z2.participant-work.v1";
  tenantId: string; principalId: string; participant: string;
  originalWorkId: string; originalWorkInputId: string; originalWorkInputDigest: string;
  protocolId: string; protocolRef: Y3Ref; certificateRef: Y3Ref; termsRef: Y3Ref;
  episodeId: string; deadlineAt: string; rightsRevision: string;
  reservationRef: Y3Ref; reservationRevision: number;
  root: { entityType: string; entityId: string };
  incentiveConcept: string; coalitionLimit: string; excludedThreatClasses: string[];
  capturedAt: string;
  originalBudgetOnly: true; actualCompliance: "UNKNOWN"; executionAuthorityGranted: false;
}

function uuid(value: unknown) {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function participantWorkIntake(binding: ParticipantWorkBinding) {
  const identity = { protocolId: binding.protocolId, termsRef: binding.termsRef,
    tenantId: binding.tenantId, principalId: binding.principalId };
  const entityAttachments = [{ entityType: binding.root.entityType, entityId: binding.root.entityId,
    relationship: "about" as const, source: "project-z.z2.participant-terms" }];
  return {
    workId: uuid({ kind: "participant-work", ...identity }),
    instructionId: uuid({ kind: "participant-input", ...identity }),
    idempotencyKey: "z2-participant:"+digest(identity),
    instruction: "Review and perform only your lawful local actions under the exact original interaction terms. "+
      "Actual compliance is UNKNOWN. This Work grants no effect authority and no new computation budget.",
    entityAttachments,
    activeContext: { ...binding, entityAttachments },
    authorityContext: { schema: "finnor.project-z.z2.inherited-work-authority.v1",
      principalId: binding.principalId, rightsRevision: binding.rightsRevision,
      originalWorkId: binding.originalWorkId, episodeId: binding.episodeId,
      reservationRef: binding.reservationRef, originalBudgetOnly: true, executionAuthorityGranted: false },
  };
}

export async function receiveParticipantWork(binding: ParticipantWorkBinding) {
  const intake = participantWorkIntake(binding);
  return receiveWork({ tenantId: binding.tenantId, userId: binding.principalId,
    workId: intake.workId, instructionId: intake.instructionId, channel: "console",
    instruction: intake.instruction, idempotencyKey: intake.idempotencyKey,
    activeContext: intake.activeContext, authorityContext: intake.authorityContext,
    entityAttachments: intake.entityAttachments,
    requireExactIntake: true });
}

export async function assertParticipantWorkTx(c: PoolClient, binding: ParticipantWorkBinding) {
  const intake = participantWorkIntake(binding);
  const row = (await c.query<{
    created_by: string; current_owner_id: string; status: string; initial_instruction: string; initial_channel: string;
    active_context: unknown; authority_context: unknown; idempotency_key: string;
    input_owner: string; instruction_id: string; instruction_text: string; channel: string;
    context_snapshot: unknown; input_key: string; input_count: string; root_attached: boolean;
  }>(`SELECT w.created_by,w.current_owner_id,w.status,w.initial_instruction,w.initial_channel,w.active_context,
    w.authority_context,w.idempotency_key,i.created_by input_owner,i.instruction_id,
    i.instruction_text,i.channel,i.context_snapshot,i.idempotency_key input_key,
    (SELECT count(*)::text FROM finnor_os.work_inputs x WHERE x.tenant_id=w.tenant_id AND x.work_id=w.id) input_count,
    EXISTS(SELECT 1 FROM finnor_os.work_entity_links l WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id
      AND l.entity_type=$4 AND l.entity_id=$5 AND l.relationship='about') root_attached
    FROM finnor_os.works w JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3 FOR SHARE OF w,i`,
  [binding.tenantId, intake.workId, intake.instructionId, binding.root.entityType, binding.root.entityId])).rows[0];
  if (!row || row.created_by !== binding.principalId || row.current_owner_id !== binding.principalId ||
    !["received", "waiting"].includes(row.status) || row.initial_channel !== "console" || !row.root_attached ||
    row.input_owner !== binding.principalId ||
    row.instruction_id !== intake.instructionId || row.input_count !== "1" || row.channel !== "console" ||
    row.initial_instruction !== intake.instruction || row.instruction_text !== intake.instruction ||
    row.idempotency_key !== intake.idempotencyKey || row.input_key !== intake.idempotencyKey ||
    digest(row.active_context) !== digest(intake.activeContext) ||
    digest(row.context_snapshot) !== digest(intake.activeContext) ||
    digest(row.authority_context) !== digest(intake.authorityContext))
    fail("Z2_EXACT_CURRENT_PARTICIPANT_WORK_REQUIRED", 409);
  return { workId: intake.workId, workInputId: intake.instructionId,
    instructionId: intake.instructionId, originalWorkId: binding.originalWorkId,
    originalEpisodeId: binding.episodeId, termsRef: binding.termsRef,
    participant: binding.participant, originalBudgetOnly: true as const,
    actualCompliance: "UNKNOWN" as const, executionAuthorityGranted: false as const };
}
