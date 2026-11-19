import type { PeMutationContext } from "../../types";
import { principal } from "../../owner-context";
import { currentInteractionAdmissionTx } from "../../../../capability-evolution/src/interaction-port";
import { withS5PortfolioTransaction as transaction } from "../../allocation-store";
import { protocolTx, eventTx } from "../../interaction-synthesis/store";
import { participantAuthorityTx, responsibleContext, termsTx } from "../../interaction-synthesis/execution-guard";
import { digest, fail, type Y3Ref } from "../../interaction-synthesis/contracts";
import { receiveParticipantWork, assertParticipantWorkTx } from
  "../../../../orchestration/src/project-z/z2-coalitions/participant-work";
import { participantWorkBinding, participantWorkEventKey, latestParticipantTermsConsentTx, readParticipantWorkTx } from "./participant-work-guard";

/** Consent, canonical Work intake and native link are separate durable commits.
 * Replay repairs a crash between them. No caller can sign for another actor. */
export async function ensureParticipantWork(ctx: PeMutationContext, protocolId: string, termsRef: Y3Ref) {
  const prepare = () => transaction(ctx, async c => {
    const row = await protocolTx(ctx, c, protocolId, false);
    await currentInteractionAdmissionTx(responsibleContext(row), c, row.id);
    await participantAuthorityTx(ctx, c, row);
    const terms = await termsTx(c, row, termsRef), binding = participantWorkBinding(row, terms, principal(ctx));
    if (!binding) return null;
    const consent = await latestParticipantTermsConsentTx(c, row, terms, principal(ctx));
    if (!consent || consent.decision !== "ACCEPT" || consent.body.rightsRevision !== row.rights_revision ||
      consent.body.principalId !== principal(ctx) || digest(consent.body.termsRef) !== digest(terms.ref))
      fail("Z2_CURRENT_SIGNED_PARTICIPANT_CONSENT_REQUIRED", 409);
    return { binding, consentId: consent.consent_id,
      existing: await readParticipantWorkTx(c, row, terms, principal(ctx)) };
  });
  const before = await prepare();
  if (!before) return null;
  if (before.existing) return before.existing;
  const started = performance.now();
  await receiveParticipantWork(before.binding);
  const wallMs = Math.ceil(performance.now()-started);
  return transaction(ctx, async c => {
    const row = await protocolTx(ctx, c, protocolId, false);
    await currentInteractionAdmissionTx(responsibleContext(row), c, row.id);
    await participantAuthorityTx(ctx, c, row);
    const terms = await termsTx(c, row, termsRef), binding = participantWorkBinding(row, terms, principal(ctx)),
      consent = await latestParticipantTermsConsentTx(c, row, terms, principal(ctx));
    if (!binding || digest(binding) !== digest(before.binding) || consent?.decision !== "ACCEPT" ||
      consent.consent_id !== before.consentId) fail("Z2_PARTICIPANT_WORK_ORIGINAL_HEAD_CHANGED", 409);
    const work = await assertParticipantWorkTx(c, binding);
    await eventTx(c, row, "Z2_PARTICIPANT_WORK", participantWorkEventKey(terms, principal(ctx), consent.consent_id),
      { binding, consentId: consent.consent_id, work, canonicalIntakeWallMs: wallMs,
        costs: { moneyUsd: null, humanSeconds: null, aggregatePeakMemoryBytes: null, status: "PARTIALLY_METERED" },
        noNewEpisodeReservationOrBudget: true, noNewJobOrEffect: true, executionAuthorityGranted: false });
    return work;
  });
}
