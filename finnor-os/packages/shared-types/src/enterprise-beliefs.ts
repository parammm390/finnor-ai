/** S1's permissioned projection contract. Canonical records stay with their
 * semantic owners. A record commitment establishes integrity, not business truth. */
export interface BeliefOwnerRef {
  owner: string;
  entityType: string;
  id: string;
  revisionId: string;
  contentDigest: string;
}
export type BeliefClaimKind = "CANONICAL_ASSERTION" | "OBSERVED_RECORD" | "SOURCE_ASSERTION" | "ASSUMPTION" | "MODEL_CONDITIONAL" | "DERIVED" | "UNKNOWN";
export interface BeliefClaim {
  id: string;
  ownerRef: BeliefOwnerRef;
  kind: BeliefClaimKind;
  value: Record<string, unknown>;
  /** Exact PostgreSQL JSON representation committed by the owner. Nested numeric
   * computation is not certified merely by decoding JSON into JavaScript. */
  exactSnapshotJson?: string;
  validFrom: string | null;
  validTo: string | null;
  knowledgeAt: string;
  provenance: BeliefOwnerRef[];
  dependencyRefs: string[];
  uncertainty: { representation: "QUALIFIED_RECORD" | "ALTERNATIVES" | "UNKNOWN"; calibratedProbability: false; reasons: string[] };
  horizon: "H0" | "H1";
}
export interface BeliefDecisionContext {
  id: string;
  version: string;
  /** The independently supplied decision evaluates registered canonical records,
   * not the completeness or truth of the real enterprise. */
  evidenceUniverse: "registered_canonical_records";
  requirements: Array<{
    id: string;
    subject: { entityType: string; entityId: string };
    metricKey: string;
    unit: string;
    currencyCode: string | null;
    periodStart: string;
    periodEnd: string;
    operator: "gte" | "lte" | "eq";
    threshold: string;
    maximumAgeMs?: number;
  }>;
}
export interface BeliefResolution {
  status: "SUFFICIENT" | "INSUFFICIENT_RESOLUTION" | "NOT_REQUESTED";
  decisionRef: { id: string; version: string; contentDigest: string } | null;
  errorBound: { maximumPredicateError: 0; domain: "registered_canonical_records" } | null;
  results: Array<{ requirementId: string; status: "MATCHES" | "DOES_NOT_MATCH" | "UNKNOWN"; claimRefs: string[]; reasons: string[] }>;
  reasons: string[];
  refinement: "REQUEST_FULL_PERMITTED_VIEW" | "NO_SUPPORTED_REFINEMENT" | null;
}
export interface BeliefViewPin {
  tenantId: string;
  principalId: string;
  root: { entityType: string; entityId: string };
  validAt: string;
  knowledgeAt: string;
  dependencyDigest: string;
  rightsRevision: number;
  interpretationVersion: string;
}
/** A read-only dependency check. CURRENT is never execution admission. */
export interface BeliefViewPinValidation {
  status: "CURRENT" | "INVALIDATED" | "UNAVAILABLE";
  reason: string;
  executionAuthorityGranted: false;
  experience?: BeliefView["experience"];
}
export interface S1ExperienceEvent {
  schema: "finnor.s1.experience.v1";
  eventId: string;
  episodeId: string;
  semanticOwner: "S1";
  type: "BELIEF_VIEW" | "BELIEF_INVALIDATION";
  tenantId: string;
  principalId: string;
  rightsRef: string;
  causalParents: string[];
  revisionRef: string;
  contentDigest: string;
  validAt: string;
  knowledgeAt: string;
  dependencyRefs: string[];
  freshnessRef: string;
  uncertainty: "QUALIFIED_RECORDS_NO_CALIBRATION";
  horizon: "H0";
  provenanceRefs: BeliefOwnerRef[];
  modelCompute: null;
  invalidation?: { priorDependencyDigest: string; currentDependencyDigest: string; pinWitnessDigest: string; reason: string };
}
export interface BeliefView {
  schema: "finnor.belief-view.v1";
  semanticOwner: "S1";
  id: string;
  contentDigest: string;
  dependencyDigest: string;
  interpretationVersion: string;
  tenantId: string;
  principalId: string;
  root: { entityType: string; entityId: string };
  validAt: string;
  knowledgeAt: string;
  rights: { revision: number; ref: string; evaluatedAt: string; scope: "CURRENT_AUTHORIZED_RESOURCES" };
  sourceCuts: Array<{ owner: string; knownThrough: string; consistency: "POSTGRES_REPEATABLE_READ" | "PROVIDER_RECORDED_CUT"; atomicAcrossProviders: false; lagMs: number | null }>;
  claims: BeliefClaim[];
  contradictions: Array<{ claimRefs: string[]; resolution: "UNRESOLVED"; reason: string }>;
  coverage: {
    status: "COMPLETE" | "PARTIAL" | "UNAVAILABLE_BEFORE_BASELINE";
    canonicalStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE_BEFORE_BASELINE";
    /** Never an absence certificate for the enterprise. */
    absenceClaimsPermitted: false;
    omittedScope: string[];
    reasons: string[];
    truncated: boolean;
  };
  resolution: BeliefResolution;
  pin: BeliefViewPin;
  experience: { status: "BLOCKED_EXTERNAL"; event: S1ExperienceEvent; receipt: null; appendAuthorityGranted: false; executionAuthorityGranted: false; reason: string };
}
