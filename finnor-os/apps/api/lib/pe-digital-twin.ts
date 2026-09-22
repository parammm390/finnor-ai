import { z } from "zod";

const Uuid = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).max(80);
const Currency = z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase());
const Completeness = z.enum(["complete", "partial", "unknown", "conflicting", "unavailable_before_history_baseline"]);
const Evidence = z.object({ evidenceSourceId: Uuid, evidenceVersionId: Uuid }).strict();
const Interval = { validFrom: Timestamp, validTo: Timestamp.optional() } as const;
const WithEvidence = { evidence: Evidence, completeness: Completeness.optional() } as const;
const CanonicalRef = z.object({ entityType: z.string().trim().min(1).max(120), entityId: Uuid }).strict();

const Ownership = z.object({
  ownerType: z.enum(["pe_fund", "pe_vehicle", "external_organization"]), ownerId: Uuid,
  subjectType: z.enum(["external_organization", "pe_security"]), subjectId: Uuid,
  economicPercentage: Decimal.optional(), votingPercentage: Decimal.optional(), amount: Decimal.optional(),
  currencyCode: Currency.optional(), ownershipClass: z.string().trim().min(1).max(200).optional(),
  ...Interval, ...WithEvidence,
}).strict();

const MetricValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), value: Decimal }).strict(),
  z.object({ type: z.literal("text"), value: z.string().max(32_768) }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
]);

export const PeDigitalTwinRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create-fund"), id: Uuid.optional(), name: z.string().trim().min(1).max(500), legalName: z.string().trim().min(1).max(500).optional(), vintageYear: z.number().int().min(1900).max(2200).optional(), baseCurrency: Currency.optional(), status: z.enum(["forming", "active", "harvesting", "liquidated"]).optional(), validFrom: Timestamp.optional(), validTo: Timestamp.optional() }).strict(),
  z.object({ operation: z.literal("transition-fund"), fundId: Uuid, expectedVersion: z.number().int().positive(), to: z.enum(["active", "harvesting", "liquidated"]) }).strict(),
  z.object({ operation: z.literal("create-vehicle"), id: Uuid.optional(), name: z.string().trim().min(1).max(500), legalName: z.string().trim().min(1).max(500).optional(), vehicleType: z.enum(["main", "feeder", "parallel", "co_invest", "blocker", "continuation", "other"]), jurisdiction: z.string().trim().min(1).max(200).optional(), status: z.enum(["forming", "active", "harvesting", "liquidated"]).optional(), validFrom: Timestamp.optional(), validTo: Timestamp.optional() }).strict(),
  z.object({ operation: z.literal("transition-vehicle"), vehicleId: Uuid, expectedVersion: z.number().int().positive(), to: z.enum(["active", "harvesting", "liquidated"]) }).strict(),
  z.object({ operation: z.literal("link-fund-vehicle"), id: Uuid.optional(), fundId: Uuid, vehicleId: Uuid, relationshipKind: z.enum(["master", "feeder", "parallel", "co_invest", "blocker", "continuation", "other"]), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("link-strategy-mandate"), id: Uuid.optional(), principalType: z.enum(["pe_fund", "pe_vehicle"]), principalId: Uuid, strategyId: Uuid, ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("create-portfolio-holding"), id: Uuid.optional(), fundId: Uuid.optional(), vehicleId: Uuid.optional(), companyId: Uuid, originDealId: Uuid, entryDate: DateOnly, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("record-company-hierarchy"), id: Uuid.optional(), parentCompanyId: Uuid, childCompanyId: Uuid, relationshipKind: z.enum(["parent_subsidiary", "holding_operating"]), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("record-company-party-role"), id: Uuid.optional(), companyId: Uuid, partyType: z.enum(["external_organization", "external_contact"]), partyId: Uuid, role: z.enum(["sponsor", "advisor"]), roleDetail: z.string().trim().min(1).max(500).optional(), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("create-security"), id: Uuid.optional(), issuerCompanyId: Uuid, securityKey: z.string().trim().min(1).max(200), securityType: z.enum(["common_equity", "preferred_equity", "convertible", "option", "warrant", "other"]), name: z.string().trim().min(1).max(500), currencyCode: Currency.optional(), seniority: z.number().int().min(0).optional(), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("create-debt-facility"), id: Uuid.optional(), borrowerCompanyId: Uuid, facilityKey: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(500), facilityType: z.enum(["revolver", "term_loan", "delayed_draw", "mezzanine", "unitranche", "notes", "other"]), committedAmount: Decimal.optional(), currencyCode: Currency.optional(), maturityDate: DateOnly.optional(), status: z.enum(["committed", "active", "repaid", "cancelled", "defaulted"]).optional(), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("link-debt-facility-lender"), id: Uuid.optional(), debtFacilityId: Uuid, lenderPartyType: z.enum(["external_organization", "external_contact"]), lenderPartyId: Uuid, lenderRole: z.enum(["agent", "arranger", "lender", "administrative_agent", "other"]), commitmentAmount: Decimal.optional(), currencyCode: Currency.optional(), ...Interval, ...WithEvidence }).strict(),
  z.object({ operation: z.literal("record-ownership"), id: Uuid.optional(), ...Ownership.shape }).strict(),
  z.object({ operation: z.literal("revise-ownership"), priorInterestId: Uuid, expectedVersion: z.number().int().positive(), validFrom: Timestamp, replacement: Ownership.omit({ validFrom: true }).extend({ id: Uuid.optional() }).strict() }).strict(),
  z.object({ operation: z.literal("create-benchmark"), id: Uuid.optional(), benchmarkKey: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(500), metricKey: z.string().trim().min(1).max(200), unit: z.string().trim().min(1).max(100), currencyCode: Currency.optional(), cohortDefinition: z.record(z.unknown()).optional() }).strict(),
  z.object({ operation: z.literal("create-metric-series"), id: Uuid.optional(), subjectType: z.enum(["external_organization", "pe_portfolio_holding"]), subjectId: Uuid, metricKey: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(500), unit: z.string().trim().min(1).max(100), currencyCode: Currency.optional(), frequency: z.enum(["instant", "daily", "weekly", "monthly", "quarterly", "annual", "event"]), benchmarkId: Uuid.optional() }).strict(),
  z.object({ operation: z.literal("record-metric-observation"), id: Uuid.optional(), metricSeriesId: Uuid, periodStart: Timestamp, periodEnd: Timestamp, value: MetricValue, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("restate-metric-observation"), priorObservationId: Uuid, expectedVersion: z.number().int().positive(), replacement: z.object({ id: Uuid.optional(), value: MetricValue, evidence: Evidence }).strict() }).strict(),
  z.object({ operation: z.literal("record-benchmark-observation"), id: Uuid.optional(), benchmarkId: Uuid, periodStart: Timestamp, periodEnd: Timestamp, value: Decimal, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("restate-benchmark-observation"), priorObservationId: Uuid, expectedVersion: z.number().int().positive(), id: Uuid.optional(), value: Decimal, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("record-outcome"), id: Uuid.optional(), subjectType: z.enum(["external_organization", "pe_portfolio_holding"]), subjectId: Uuid, decisionId: Uuid.optional(), outcomeType: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(10_000), observedValue: z.record(z.unknown()).optional(), observedAt: Timestamp, ...Interval, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("record-exit"), id: Uuid.optional(), portfolioHoldingId: Uuid, expectedHoldingVersion: z.number().int().positive(), exitType: z.enum(["strategic_sale", "sponsor_sale", "ipo", "recapitalization", "write_off", "other"]), buyerCompanyId: Uuid.optional(), status: z.enum(["announced", "signed", "closed", "cancelled"]), announcedAt: Timestamp.optional(), signedAt: Timestamp.optional(), closedAt: Timestamp.optional(), cancelledAt: Timestamp.optional(), grossProceeds: Decimal.optional(), currencyCode: Currency.optional(), observedAt: Timestamp, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("record-fact-coverage"), id: Uuid.optional(), subjectType: z.enum(["external_organization", "pe_fund", "pe_vehicle", "pe_portfolio_holding"]), subjectId: Uuid, proposition: z.enum(["company_ownership", "company_debt", "company_parent", "portfolio_membership", "ownership_total"]), coverageStatus: Completeness, ...Interval, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("revise-fact-coverage"), priorCoverageId: Uuid, expectedVersion: z.number().int().positive(), coverageStatus: Completeness, evidence: Evidence }).strict(),
  z.object({ operation: z.literal("record-identity-resolution"), decisionId: z.string().trim().min(1).max(500), sourceLinkId: Uuid, expectedObservedHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(), kind: z.enum(["merge", "split", "correction"]), fromRefs: z.array(CanonicalRef).min(1).max(100), toRefs: z.array(CanonicalRef).min(1).max(100), decision: z.string().trim().min(1).max(10_000), validFrom: Timestamp.optional(), validTo: Timestamp.optional(), authority: z.record(z.unknown()), evidence: Evidence, observedAt: Timestamp.optional() }).strict(),
  z.object({ operation: z.literal("resolve-identity-as-known"), sourceLinkId: Uuid, validAt: Timestamp, knowledgeAt: Timestamp }).strict(),
  z.object({ operation: z.literal("closed-world-claim"), subjectType: z.enum(["external_organization", "pe_fund", "pe_vehicle", "pe_portfolio_holding"]), subjectId: Uuid, proposition: z.enum(["company_ownership", "company_debt", "company_parent", "portfolio_membership", "ownership_total"]), validAt: Timestamp, knowledgeAt: Timestamp.optional() }).strict(),
]);

export type PeDigitalTwinRequest = z.infer<typeof PeDigitalTwinRequestSchema>;
