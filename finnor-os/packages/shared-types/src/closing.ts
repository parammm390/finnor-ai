import { z } from "zod";

const Id = z.string().uuid();
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.string().datetime({ offset: true });
export const ClosingWorkContinuationSchema = z.object({
  workInputId: Id, objectiveLoopId: Id,
  objectiveRevision: z.number().int().positive().max(2147483647),
  objectiveDigest: Digest,
}).strict();
export type ClosingWorkContinuation = z.infer<typeof ClosingWorkContinuationSchema>;
const Decimal = z.string().regex(/^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/);
const BoundedJson = z.unknown().superRefine((value, ctx) => {
  const pending = [{ value, depth: 0 }]; let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8192 || item.depth > 32) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Closing JSON depth or node bound exceeded" }); return;
    }
    if (item.value === null || typeof item.value === "string" || typeof item.value === "boolean") continue;
    if (typeof item.value === "number" && Number.isFinite(item.value)) continue;
    if (typeof item.value !== "object" || (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Closing extension must be finite JSON" }); return;
    }
    for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
});

export const ClosingOwnerRefSchema = z.object({
  owner: z.string().min(1).max(128),
  kind: z.string().min(1).max(128),
  id: z.string().min(1).max(512),
  version: z.string().min(1).max(128),
  contentDigest: Digest,
}).strict();
export type ClosingOwnerRef = z.infer<typeof ClosingOwnerRefSchema>;

export const ClosingMoneySchema = z.object({
  amount: Decimal,
  currency: z.string().regex(/^[A-Z]{3}$/),
  unit: z.literal("currency"),
  entityId: Id,
  asOf: Time,
  timeBasis: z.enum(["INSTANT", "CUMULATIVE"]),
  periodEnd: Time,
  rounding: z.literal("EXACT"),
}).strict();
export type ClosingMoney = z.infer<typeof ClosingMoneySchema>;

const EvidenceRule = z.object({
  kind: z.enum([
    "DOCUMENT_EXECUTION", "OBSERVABLE_CONDITION", "PROFESSIONAL_CONDITION",
    "RECEIVING_SETTLEMENT", "RIGHTS_TRANSFER", "LEGAL_EFFECTIVENESS",
    "FUNDING_AVAILABLE", "BENEFICIARY_VALIDATED",
  ]),
  predicateDigest: Digest,
  issuerIds: z.array(Key).min(1).max(16),
  channels: z.array(Key).min(1).max(16),
  maxAgeMs: z.number().int().positive().safe(),
}).strict();
const Requirement = {
  key: Key,
  required: z.boolean(),
  dependsOn: z.array(Key).max(256),
  evidence: EvidenceRule,
};
const Actor = z.object({
  principalId: Id,
  legalEntityId: Id,
  roleRef: ClosingOwnerRefSchema,
}).strict();
const Document = z.object({
  ...Requirement,
  documentId: Id,
  documentVersionId: Id,
  documentDigest: Digest,
  approvedTermsRevision: Key,
  signers: z.array(Actor).min(1).max(64),
}).strict();
const Condition = z.object({
  ...Requirement,
  canonicalConditionId: Id.nullable(),
  statement: z.string().min(1).max(8000),
  evidenceClass: z.enum(["OBSERVABLE", "PROFESSIONALLY_ATTESTED", "UNRESOLVED"]),
  professionalScope: Key.nullable(),
  waiver: z.object({
    actorIds: z.array(Id).min(1).max(32),
    authorityRef: ClosingOwnerRefSchema,
    expiresAt: Time,
    maximumAmount: ClosingMoneySchema.nullable(),
    allowedReasonCodes: z.array(Key).min(1).max(32),
  }).strict().nullable(),
}).strict();
const Flow = z.object({
  ...Requirement,
  money: ClosingMoneySchema,
  payerEntityId: Id,
  receivingEntityId: Id,
  receivingAccountDigest: Digest,
  beneficiaryRequirementKey: Key,
  fundingKeys: z.array(Key).min(1).max(32),
  purpose: z.enum(["PURCHASE_PRICE", "DEBT_PAYOFF", "FEE", "TAX", "ESCROW", "RELEASE"]),
  operationKey: Key,
}).strict();
const Transfer = z.object({
  ...Requirement,
  fromEntityId: Id,
  toEntityId: Id,
  rightsDigest: Digest,
  quantity: Decimal,
  unit: Key,
  operationKey: Key,
}).strict();
const Effectiveness = z.object({
  ...Requirement,
  jurisdiction: Key,
  legalBasisDigest: Digest,
  professionalScope: Key,
  operationKey: Key.nullable(),
}).strict();
const Funding = z.object({
  ...Requirement,
  money: ClosingMoneySchema,
  facilityDigest: Digest,
  providerEntityId: Id,
  sourceClass: z.enum(["DEBT_FACILITY", "EQUITY_CAPITAL", "EXISTING_CASH", "THIRD_PARTY_FUNDS"]),
  continuingDutyKeys: z.array(Key).max(128).refine(keys => new Set(keys).size === keys.length, "Duplicate continuing duty reference"),
  requiredState: z.literal("EFFECTIVE_AVAILABLE"),
  drawOperationKey: Key.nullable(),
}).strict();
const Beneficiary = z.object({
  ...Requirement,
  legalEntityId: Id,
  accountDigest: Digest,
  independentValidationChannel: Key,
}).strict();
const Duty = z.object({
  key: Key,
  ownerPrincipalId: Id,
  statement: z.string().min(1).max(8000),
  dueAt: Time,
  dependencyKeys: z.array(Key).max(256),
  liability: ClosingMoneySchema.nullable(),
  obligationRef: ClosingOwnerRefSchema.nullable(),
}).strict();
export const ClosingStepSchema = z.object({
  key: Key,
  kind: z.enum([
    "REQUEST_SIGNATURE", "DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE",
    "ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL", "WAIT", "RECONCILE", "STOP",
  ]),
  requirementKey: Key,
  dependsOn: z.array(Key).max(256),
  actor: Actor,
  irreversible: z.boolean(),
  providerProfileId: Key.nullable(),
  policyRef: ClosingOwnerRefSchema.nullable(),
  allocationRef: ClosingOwnerRefSchema.nullable(),
  decision: BoundedJson.nullable(),
  failureDisposition: z.enum(["WAITING", "BLOCKED", "STOPPED", "RECONCILING"]),
  exposureCap: ClosingMoneySchema.nullable(),
  resourceBindings: z.array(z.object({
    resourceRef: ClosingOwnerRefSchema,
    quantity: Decimal,
    unit: Key,
  }).strict()).max(16).refine(bindings => new Set(bindings.map(binding => `${binding.resourceRef.owner}:${binding.resourceRef.id}`)).size === bindings.length, "Duplicate closing resource identity"),
}).strict();
export type ClosingStep = z.infer<typeof ClosingStepSchema>;

export const ClosingSpecSchema = z.object({
  schema: z.literal("finnor.closing-spec.v1"),
  transactionId: Id,
  tenantId: Id,
  approvedTermsRevision: Key,
  approvedTermsDigest: Digest,
  profileId: Key,
  environment: z.enum(["DEVELOPMENT", "REHEARSAL", "LIVE"]),
  originalGrant: z.object({
    episodeRef: ClosingOwnerRefSchema,
    deadlineAt: Time,
    maxSteps: z.number().int().min(1).max(4096),
    maxHumanSeconds: z.number().int().min(0).max(900),
    maxComputeDataIntegrationUsd: Decimal,
  }).strict(),
  documents: z.array(Document).min(1).max(64),
  conditions: z.array(Condition).max(128),
  fundsFlows: z.array(Flow).max(64),
  rightsTransfers: z.array(Transfer).max(64),
  legalEffectiveness: z.array(Effectiveness).min(1).max(64),
  funding: z.array(Funding).max(64),
  beneficiaries: z.array(Beneficiary).max(64),
  continuingDuties: z.array(Duty).max(128),
  steps: z.array(ClosingStepSchema).max(256),
  dependencyKeys: z.array(Key).min(1).max(512),
  assumptions: z.array(z.string().min(1).max(2000)).max(64),
  unsupportedPredicates: z.array(Key).max(128),
}).strict();
export type ClosingSpec = z.infer<typeof ClosingSpecSchema>;

export interface ClosingGraphNode {
  key: string;
  kind: "REQUIREMENT" | "OPERATION" | "CONTINUING_DUTY" | "INDEPENDENT_CLOSE_CHECK";
  requirementClass: string;
  originalDigest: string;
  actorIds: string[];
  dependsOn: string[];
  irreversible: boolean;
}
export interface ClosingGraph {
  schema: "finnor.closing-graph.v1";
  specDigest: string;
  nodes: ClosingGraphNode[];
  bounds: { nodes: number; maxNodes: number; allOriginalRequirementsIncluded: boolean };
}

export const ClosingObservationSchema = z.object({
  schema: z.literal("finnor.closing-observation.v1"),
  factId: Id,
  tenantId: Id,
  transactionId: Id,
  specDigest: Digest,
  approvedTermsRevision: Key,
  requirementKey: Key,
  predicateDigest: Digest,
  kind: z.enum([
    "LEGAL_SPEC_ACCEPTANCE", "DOCUMENT_EXECUTION", "OBSERVABLE_CONDITION",
    "PROFESSIONAL_CONDITION", "RECEIVING_SETTLEMENT", "RIGHTS_TRANSFER",
    "LEGAL_EFFECTIVENESS", "FUNDING_AVAILABLE", "BENEFICIARY_VALIDATED",
    "WAIVER", "OPERATION_ABSENT",
  ]),
  issuerId: Key,
  channel: Key,
  actorId: Id,
  professionalScope: Key.nullable(),
  status: z.enum(["CONFIRMED", "FAILED", "PARTIAL", "UNKNOWN", "REVOKED", "ABSENT"]),
  observedAt: Time,
  validUntil: Time,
  claims: z.record(z.string(), z.unknown()).and(BoundedJson),
  supersedesFactIds: z.array(Id).max(128),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type ClosingObservation = z.infer<typeof ClosingObservationSchema>;

export interface ClosingEvidenceRef {
  sourceId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  snapshotHash: string;
}
export interface ClosingIssuer {
  id: string;
  publicKeyPem: string;
  actorId: string;
  status: "ACTIVE" | "REVOKED";
  qualifiedScopes: string[];
  kinds: ClosingObservation["kind"][];
  channels: string[];
  validUntil: string;
  environment: ClosingSpec["environment"];
  qualificationRef: ClosingOwnerRef;
}
export type ClosingDisposition =
  | "PROPOSED" | "WAITING" | "BLOCKED" | "STOPPED" | "FAILED"
  | "EXECUTING" | "RECONCILING" | "READY_FOR_PUBLICATION" | "CLOSED" | "REOPENED";

export interface ClosingCheck {
  schema: "finnor.independent-close-check.v1";
  specDigest: string;
  graphDigest: string;
  checkedAt: string;
  validUntil: string;
  accepted: boolean;
  disposition: ClosingDisposition;
  reasons: string[];
  acceptedEvidence: Array<{ requirementKey: string; kind: string; ref: ClosingEvidenceRef }>;
  verifiedOperationSettlements: Array<{
    businessEffectId: string; operationKey: string; originalSpecDigest: string; ref: ClosingEvidenceRef;
  }>;
  readyOperationKeys: string[];
  closeConjunction: {
    executedDocuments: boolean;
    conditionsSatisfiedOrValidlyWaived: boolean;
    receivingSettlement: boolean;
    rightsTransfer: boolean;
    legalEffectiveness: boolean;
    noUnreconciledMaterialExposure: boolean;
    continuingDutiesHandedOff: boolean;
  };
  interpretationVersion: string;
  exclusions: string[];
}

export interface VerifiedClosedTransaction {
  schema: "finnor.verified-closed-transaction.v1";
  artifactType: "VerifiedClosedTransaction";
  transactionIdentity: { tenantId: string; transactionId: string; workId: string };
  approvedTermsRevision: string;
  programmeRef: ClosingOwnerRef;
  closingSpecRef: ClosingOwnerRef;
  typedPayload: ClosingCheck;
  evidenceAndDerivationRefs: ClosingEvidenceRef[];
  professionalAttestationRefs: ClosingEvidenceRef[];
  counterfactualConstraintsAndAssumptions: string[];
  validityAndSupersession: {
    acceptedAt: string;
    validUntil: string;
    dependencyDigest: string;
    immutableHistoricalCertificate: true;
    presentValidityOwner: "@finnor/private-equity";
  };
  authorityReferences: string[];
  fundingAndReservationReferences: ClosingOwnerRef[];
  dependencyPins: Array<{ key: string; revision: number }>;
  continuationAndInvalidationReferences: string[];
  receiptAndCurrentness: { checkId: string; checkerDigest: string; observationCutDigest: string };
  evidenceEnvironmentAndCurrentStatus: {
    environment: ClosingSpec["environment"];
    label: "DEVELOPMENT_VERIFIED" | "REHEARSAL_ACCEPTED" | "LIVE_VERIFIED";
    statusAtIssuance: "CLOSED";
    excludedFromLiveCounts: boolean;
  };
  continuingObligations: ClosingSpec["continuingDuties"];
}

export interface ClosingProjection {
  schema: "finnor.v3.closing-projection.v1";
  programmeId: string; transactionId: string; workId: string; workInputId: string;
  planRevisionId: string | null; specDigest: string; approvedTermsRevision: string;
  status: ClosingDisposition; spec: ClosingSpec; graph: ClosingGraph;
  check: ClosingCheck | null; checkCurrent: boolean;
  certificate: { id: string; historical: true; currentlyValid: boolean; body: VerifiedClosedTransaction } | null;
  pendingPredicates: string[];
  unresolvedEffects: Array<{
    effectId: string; operationId: string; programmeId: string; nodeKey: string;
    status: "RECONCILIATION_REQUIRED"; nativeVerificationStatus: string;
    money: ClosingMoney | null; retryPermitted: false; reservationRetained: true;
  }>;
  children: Array<{ nodeKey: string; actionId: string; actionStatus: string; effectId?: string; effectStatus?: string }>;
  continuingDuties: Array<{ key: string; taskId: string; ownerPrincipalId: string; dueAt: string;
    liability: ClosingMoney | null; taskStatus: string; obligationRef: ClosingOwnerRef }>;
  nativeBudget: { stepCount: number; maxSteps: number; actionCount: number; maxActions: number;
    queryCount: number; maxQueries: number; deadlineAt: string; state: string } | null;
  reason: string | null; environment: ClosingSpec["environment"];
  qualification: { engineering: string; protectedAdmission: string; liveCountsEligible: boolean; economicGain: "NOT_ESTABLISHED" };
  costs: { usd: null; status: "UNMETERED"; financingPrincipalIsProfit: false };
}
