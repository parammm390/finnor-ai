import type { PoolClient } from "pg";
import type { ProtocolRow, InteractionTerms } from "../../interaction-synthesis/product-contracts";
import { digest, fail, InteractionFault } from "../../interaction-synthesis/contracts";
import type { NativeCoalitionArtifact } from "./contracts";
import { coalitionTermsBinding, assertCoalitionTerms } from "./guard";
import { assertParticipantWorkTx, type ParticipantWorkBinding } from
  "../../../../orchestration/src/project-z/z2-coalitions/participant-work";

export function participantWorkBinding(row: ProtocolRow, terms: InteractionTerms, principalId: string): ParticipantWorkBinding | null {
  const proof = (row.artifact as NativeCoalitionArtifact | null)?.coalition;
  if (!proof) return null;
  assertCoalitionTerms(row, terms);
  const party = row.request.problem.participants.find(p => p.principalId === principalId),
    visible = coalitionTermsBinding(row).coalition;
  if (!party || !visible) fail("Z2_ORIGINAL_PARTICIPANT_REQUIRED", 403);
  return { schema: "finnor.project-z.z2.participant-work.v1",
    tenantId: row.tenant_id, principalId, participant: party.id,
    originalWorkId: row.work_id, originalWorkInputId: row.work_input_id, originalWorkInputDigest: row.work_input_digest,
    protocolId: row.id, protocolRef: terms.protocolRef, certificateRef: proof.ref, termsRef: terms.ref,
    episodeId: row.episode_id, deadlineAt: row.deadline_at.toISOString(), rightsRevision: row.rights_revision,
    reservationRef: terms.reservationRef, reservationRevision: terms.reservationRevision, root: row.root,
    incentiveConcept: visible.incentiveConcept, coalitionLimit: visible.coalitionLimit,
    excludedThreatClasses: visible.excludedThreatClasses, capturedAt: terms.createdAt,
    originalBudgetOnly: true, actualCompliance: "UNKNOWN", executionAuthorityGranted: false };
}

export const participantWorkEventKey = (terms: InteractionTerms, principalId: string, consentId: string) =>
  "z2-participant-work:"+digest({ termsId: terms.id, principalId, consentId });

export async function latestParticipantTermsConsentTx(c: PoolClient, row: ProtocolRow, terms: InteractionTerms, principalId: string) {
  return (await c.query<{ consent_id: string; decision: string; body: Record<string, unknown> }>(
    `SELECT consent_id,decision,body FROM finnor_os.s4_interaction_consents
     WHERE tenant_id=$1 AND protocol_id=$2 AND terms_id=$3 AND principal_id=$4
     AND scope='TERMS' AND subject_digest=$5 ORDER BY id DESC LIMIT 1 FOR SHARE`,
    [row.tenant_id, row.id, terms.id, principalId, terms.ref.contentDigest])).rows[0] ?? null;
}

export async function readParticipantWorkTx(c: PoolClient, row: ProtocolRow, terms: InteractionTerms, principalId: string) {
  const binding = participantWorkBinding(row, terms, principalId);
  if (!binding) return null;
  const consent = await latestParticipantTermsConsentTx(c, row, terms, principalId);
  if (!consent || consent.decision !== "ACCEPT") return null;
  if (consent.body.principalId !== principalId || consent.body.participant !== binding.participant ||
    consent.body.rightsRevision !== row.rights_revision || digest(consent.body.termsRef) !== digest(terms.ref))
    fail("Z2_PARTICIPANT_WORK_CONSENT_PREIMAGE");
  const event = (await c.query<{ body: { binding: ParticipantWorkBinding; consentId: string; work: unknown } }>(
    `SELECT body FROM finnor_os.y3_events WHERE tenant_id=$1 AND protocol_id=$2
     AND kind='Z2_PARTICIPANT_WORK' AND event_key=$3 FOR SHARE`,
    [row.tenant_id, row.id, participantWorkEventKey(terms, principalId, consent.consent_id)])).rows[0];
  if (!event) return null; // Exact consent replay completes an interrupted intake/link.
  const work = await assertParticipantWorkTx(c, binding);
  if (event.body.consentId !== consent.consent_id || digest(event.body.binding) !== digest(binding) ||
    digest(event.body.work) !== digest(work)) fail("Z2_PARTICIPANT_WORK_LINK_PREIMAGE");
  return work;
}

/** Called by the existing S4 consent guard, including original effect consumers. */
export async function assertParticipantWorksTx(c: PoolClient, row: ProtocolRow, terms: InteractionTerms) {
  if (!(row.artifact as NativeCoalitionArtifact | null)?.coalition) return;
  for (const party of row.request.problem.participants)
    if (!await readParticipantWorkTx(c, row, terms, party.principalId))
      fail("Z2_ALL_CURRENT_PARTICIPANT_WORKS_REQUIRED", 409);
}

export async function participantWorkViewTx(c: PoolClient, row: ProtocolRow, terms: InteractionTerms, principalId: string) {
  try {
    const work = await readParticipantWorkTx(c, row, terms, principalId);
    return { participantWork: work, participantWorkStatus: work ? "CURRENT" : "AWAITING_YOUR_EXACT_TERMS_ACCEPTANCE_OR_REPLAY" };
  } catch (error) {
    // Withdrawal must remain reachable after a participant edits or cancels
    // their Work. Never turn this read disposition into execution authority.
    if (!(error instanceof InteractionFault)) throw error;
    return { participantWork: null, participantWorkStatus: error.code };
  }
}
