import { z } from "zod";
import { ExpectedEnvironment, ObservedEnvironment } from "./scoring";

const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const signed = <T extends z.ZodTypeAny>(body: T) => z.object({ body, keyId: text,
  signature: z.string().min(1).max(128) }).strict();
const key = z.object({ id: text, principalId: text, publicKey: text,
  validAfter: instant, validUntil: instant, revoked: z.boolean() }).strict();
const cut = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/),
  dependencyLockDigest: hex, compilerMethodDigest: hex, runtimeDigest: hex }).strict();
const limit = z.number().nonnegative().finite();
const aggregateEnvelope = z.object({ ref: text, digest: hex, maxCostUsd: limit,
  maxHumanSeconds: limit, maxAggregatePeakMemoryBytes: z.number().int().positive(),
  maxAcquisitionCalls: z.number().int().positive(), maxNativeDeliveries: z.number().int().positive(),
  maxWallSeconds: z.number().positive().finite() }).strict();
const environment = z.object({ id: text, oracleDigest: hex, unseenCustodyCommitment: hex, publicInputDigest: hex,
  systems: z.array(z.object({ id: text, sourceClass: text, protocol: text, applicationFingerprint: hex }).strict()).min(8).max(16),
  randomization: z.object({ identifiers: hex, schemaOrganization: hex, dateConventions: hex,
    permissions: hex, processVariants: hex }).strict(),
  replayJournalCommitment: hex,
}).strict();
export const QualificationProtocol = z.object({ schema: z.literal("finnor.x1.qualification-protocol.v1"),
  id: text, candidatePrincipalId: text, custodianPrincipalId: text, observerPrincipalId: text,
  registeredAt: instant, candidateExposureAt: instant, profileDigest: hex, candidateCut: cut,
  environments: z.array(environment).length(10),
  envelopes: z.object({ setup: aggregateEnvelope, replay: aggregateEnvelope, soak: aggregateEnvelope,
    validation: aggregateEnvelope }).strict(),
  allocationConventionDigest: hex, originalFinancialAndComparatorContractsDigest: hex,
  replayDays: z.literal(30), elapsedLiveDays: z.literal(7),
  scoringRevision: z.literal("finnor.x1.environment-score.v1"),
  qualificationDoesNotAdmitOrActivate: z.literal(true),
}).strict();
export const SignedQualificationProtocol = signed(QualificationProtocol);
export const OracleLedger = z.object({ schema: z.literal("finnor.x1.protected-oracle-ledger.v1"),
  protocolId: text, environmentId: text, frozenAt: instant,
  expected: z.object({ replay: ExpectedEnvironment, soak: ExpectedEnvironment }).strict(), criticalCasesFrozen: z.literal(true),
  unseenCustodyCommitment: hex, replayJournalCommitment: hex,
}).strict();
export const SignedOracleLedger = signed(OracleLedger);
const measurement = z.object({ moneyUsd: limit.nullable(), humanSeconds: limit.nullable(),
  aggregatePeakMemoryBytes: limit.nullable(), acquisitionCalls: z.number().int().nonnegative(),
  nativeDeliveries: z.number().int().nonnegative(), wallSeconds: limit,
  costReceiptDigests: z.array(hex).max(4096), completeLifecycleCoverage: z.boolean() }).strict();
export const ObservationPacket = z.object({ schema: z.literal("finnor.x1.qualification-observation.v1"),
  protocolId: text, environmentId: text, revision: z.number().int().positive(), previousPacketDigest: hex.nullable(),
  observerPrincipalId: text, observedAt: instant, candidateCut: cut,
  observed: z.object({ replay: ObservedEnvironment, soak: ObservedEnvironment }).strict(),
  replay: z.object({ replicaStart: instant, replicaEnd: instant, journalCommitment: hex,
    completeExpectedEventCoverage: z.boolean(), independentReceiptDigest: hex }).strict(),
  live: z.object({ segments: z.array(z.object({ id: text, startedAt: instant, endedAt: instant,
    monotonicElapsedMs: limit, serviceFingerprint: hex, independentlyObservedUnattended: z.boolean(),
    receiptDigest: hex }).strict()).max(4096), liveClockIndependentOfReplica: z.literal(true) }).strict(),
  resources: z.object({ replay: measurement, soak: measurement }).strict(),
  originalEpisodes: z.array(z.object({ id: text, originalGrantDigest: hex, originalDeadline: instant,
    moneyUsd: limit.nullable(), humanSeconds: limit.nullable(), aggregatePeakMemoryBytes: limit.nullable(),
    initialResponseMs: limit.nullable(), wallMs: limit.nullable(), receipts: z.array(hex).min(1).max(256) }).strict()).min(1).max(3840),
  completionObservationsIndependentOfProducer: z.literal(true),
  expectedAndObservedPopulationComplete: z.boolean(),
}).strict();
export const SignedObservationPacket = signed(ObservationPacket);
export const QualificationTrustPolicy = z.object({ schema: z.literal("finnor.x1.qualification-trust-policy.v1"),
  policyId: text, custodianKeys: z.array(key).min(1).max(64), observerKeys: z.array(key).min(1).max(64),
  independentlyManagedCustodyReceiptDigest: hex, candidateCannotReadOracleReceiptDigest: hex,
  policyValidUntil: instant, profileDigest: hex,
}).strict();
export const LifecycleCostPacket = signed(z.object({ schema: z.literal("finnor.x1.qualification-lifecycle-costs.v1"),
  protocolId: text, allocationConventionDigest: hex, observedAt: instant,
  setup: measurement, validation: measurement }).strict());
