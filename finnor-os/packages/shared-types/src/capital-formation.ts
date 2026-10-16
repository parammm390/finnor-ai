/** V4 public projection. All quantities are exact currency minor-unit strings. */
export const CAPITAL_INSTRUMENT_CLASSES = ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"] as const;
// Provider UUID, instrument and 512-character local identity, without truncation.
export const CAPITAL_COMMITMENT_ID_MAX_LENGTH = 640;
export const CAPITAL_DIAGNOSTIC_MAX_LENGTH = 2048;
export const CAPITAL_COMMITMENT_STATES = [
  "INDICATIVE", "APPROVAL_PENDING", "VERIFIED_CONDITIONAL", "VERIFIED_EFFECTIVE_UNDRAWN",
  "DRAW_DISPATCHED", "FUNDING_UNKNOWN", "FUNDING_OBSERVED", "EXPIRED", "WITHDRAWN", "DISPUTED",
] as const;
export const CAPITAL_PROGRAMME_STATES = ["PROGRESS", "WAITING", "BLOCKED", "STOPPED", "RECONCILING", "FAILED", "COMPLETE"] as const;
export type CapitalInstrumentClass = typeof CAPITAL_INSTRUMENT_CLASSES[number];
export type CapitalCommitmentState = typeof CAPITAL_COMMITMENT_STATES[number];
export type CapitalProgrammeState = typeof CAPITAL_PROGRAMME_STATES[number];
export interface CapitalCandidateClassification {
  commitmentId: string; providerEntityId: string; instrument: CapitalInstrumentClass; profileId: string | null;
  termsDigest: string | null; state: CapitalCommitmentState; faceMinor: string; conditionalMinor: string;
  eligibleUndrawnMinor: string; fundingReceivedMinor: string; fundingUnknownMinor: string;
  unsatisfiedConditions: string[]; unresolvedClaims: string[]; eventIds: string[]; verified: boolean;
  identityEventId?: string | null; executionEventId?: string | null; determinationEventId?: string | null;
}
export interface CapitalFinancingPackage {
  programmeId: string; basis: "EFFECTIVE_UNDRAWN_AND_RECONCILED_FUNDING" | "RECONCILED_FUNDING_ONLY"; basisRevision: string;
  currency: string; minorUnits: number; requirementMinor: string; faceMinor: string;
  conditionalCommittedMinor: string; indicativeEquityMinor: string; eligibleUndrawnMinor: string;
  reservedAllocationMinor: string; dispatchedUnknownMinor: string; fundingReceivedMinor: string;
  financingGapMinor: string; presentEligibleGapMinor: string;
  readiness: "INCOMPLETE" | "CONDITIONALLY_COMPATIBLE" | "READY_FOR_AUTHORIZED_NEXT_STEP" | "FUNDING_RECEIVED";
  conflicts: string[]; unresolvedClaims: string[]; remainingConditions: string[];
  commitments: CapitalCandidateClassification[]; raisedPrincipalIsProfit: false;
}
export interface CapitalFormationView {
  schema: "finnor.capital-formation-view.v1"; programmeId: string; workId: string; revision: number;
  root: { entityType: string; entityId: string };
  status: CapitalProgrammeState; current: boolean; package: CapitalFinancingPackage | null;
  publicationDigest: string | null; evidenceVersionId: string | null; authenticatedEventCount: number;
  budget: { contactsSpent: number; contactLimit: number; stepsSpent: number; stepLimit: number;
    humanSecondsSpent: number; humanSecondsLimit: number;
    originalDeadlineAt: string; waitingUntil: string; costCeilingMicroUSD: string; costUnknown: boolean; maxCostMicroUSD: string };
  nextStep: "PROGRESS" | "WAIT_FOR_AUTHENTICATED_EVENT" | "REQUEST_CURRENT_AUTHORITY" | "RECONCILE_ORIGINAL_OPERATION" | "STOP" | "COMPLETE";
  blockers: string[];
  commitments: Array<{ artifactId: string; contentDigest: string; state: CapitalCommitmentState;
    providerEntityId: string; instrument: CapitalInstrumentClass; sourceEventIds: string[];
    unsatisfiedConditions: string[]; expiresAt: string; continuingObligations: string[] }>;
  history: Array<{ kind: string; at: string; detail: Record<string, unknown> }>;
  qualification: { engineering: "DEVELOPMENT_RUNTIME"; admission: "NOT_ESTABLISHED"; activation: "DISABLED";
    componentGain: "NOT_EVALUATED"; fieldEconomic: "NOT_EVALUATED"; protectedGate: "NOT_ESTABLISHED" };
  executionAuthorityGranted: false;
}
