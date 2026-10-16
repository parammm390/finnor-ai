import type { BilateralAuthority, BilateralTerms } from "@finnor/shared-types";
import { canonical, digest } from "../../governed-execution/src/canonical";

export function bilateralContactPayload(input: {
  authority: BilateralAuthority; terms: BilateralTerms; workId: string; programmeId: string;
  candidateId: string; counterpartyId: string; actionId: string; revision: number; kind: "INQUIRE" | "APPROACH" | "CONFIRM";
}) {
  const { authority: a, terms: t } = input;
  const question = input.kind === "CONFIRM"
    ? "Please explicitly confirm consideration of this buyer and these exact nonbinding terms, with timing or an agreed permitted diligence step."
    : input.kind === "INQUIRE"
      ? "Please state your transaction objectives and constraints. Nothing here assumes willingness to sell."
      : "Would you consider this nonbinding transaction with this buyer? Please state constraints or a counterproposal; silence is not agreement.";
  const body = [
    `${a.representativeDisplayName} represents ${a.firmDisplayName}, buyer legal entity ${t.buyerEntityId}.`,
    a.automationDisclosure,
    "This is a nonbinding preliminary proposal, not an LOI, underwriting, a funding or IC approval, exclusivity, legal effectiveness or an employment guarantee.",
    t.managementContinuity === "NONE" ? "No management-continuity condition is proposed."
      : "Management continuity for 12 months is a proposed contractual condition subject to definitive agreement, not an accomplished fact or guaranteed employment.",
    question,
    `Programme ${input.programmeId}; candidate ${input.candidateId}; action ${input.actionId}; terms revision ${input.revision}; terms digest ${digest(t)}.`,
    `Exact proposed terms (amounts in currency minor units, not rounded execution amounts): ${canonical(t)}`,
    "You may refuse, opt out or withdraw consent. We will suppress further approaches across our agents and mailboxes.",
  ].join("\n");
  return { recipient: { partyType: "external_contact", partyId: input.counterpartyId }, channel: "email",
    subject: `Bilateral ${input.kind.toLowerCase()} ${input.programmeId}:${input.candidateId}:${input.revision}`,
    body, workRef: { workId: input.workId }, communicationIdentityRef: { communicationIdentityId: a.communicationIdentityId },
    purpose: "private-market-bilateral" };
}
