/**
 * Active Core identity and relationship contract.
 *
 * Phase 5 deliberately excludes the retired Water extension. Historical rows may
 * still contain the old entity/party names, but active schemas, planners and
 * resolvers can address only these Core identities. Private Equity owns its typed
 * extension in `@finnor/private-equity` and validates it at its package boundary.
 */
export const CANONICAL_ENTITY_TYPES = [
  "user",
  "org_unit",
  "tenant_location",
  "external_organization",
  "external_contact",
  "document",
  "evidence_source",
  "evidence_source_version",
  "task",
  "work",
  "domain_action",
  "workflow_run",
  "workflow_step",
  "decision_receipt",
  "business_event",
  "delegation",
  "acknowledgement_request",
  "communication_delivery",
  "internal_event",
  "document_share",
  "computer_run",
] as const;

export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

export interface CanonicalEntityRef<TType extends string = CanonicalEntityType> {
  entityType: TType;
  entityId: string;
}

/** PartyRef is vertical-neutral. Customer and field-service party forms are
 * historical Water identities and are intentionally absent. */
export const PARTY_TYPES = [
  "employee",
  "team",
  "location",
  "external_organization",
  "external_contact",
] as const;

export type PartyType = (typeof PARTY_TYPES)[number];

export interface PartyRef {
  partyType: PartyType;
  partyId: string;
}

export type CompanyContextAnchor = CanonicalEntityRef | PartyRef;

const PARTY_ENTITY_TYPES: Record<PartyType, CanonicalEntityType> = {
  employee: "user",
  team: "org_unit",
  location: "tenant_location",
  external_organization: "external_organization",
  external_contact: "external_contact",
};

export function partyRefToCanonicalEntityRef(ref: PartyRef): CanonicalEntityRef {
  return { entityType: PARTY_ENTITY_TYPES[ref.partyType], entityId: ref.partyId };
}

export function canonicalEntityRefToPartyRef(ref: CanonicalEntityRef): PartyRef | null {
  switch (ref.entityType) {
    case "user": return { partyType: "employee", partyId: ref.entityId };
    case "org_unit": return { partyType: "team", partyId: ref.entityId };
    case "tenant_location": return { partyType: "location", partyId: ref.entityId };
    case "external_organization": return { partyType: "external_organization", partyId: ref.entityId };
    case "external_contact": return { partyType: "external_contact", partyId: ref.entityId };
    default: return null;
  }
}

export type PartyOperationalStatus = "active" | "inactive" | "suspended";
export type PartyResolutionStatus = "resolved" | "ambiguous" | "not_found" | "inactive";
export type PartyResolutionMethod =
  | "explicit_ref"
  | "alias"
  | "business_contact"
  | "relationship"
  | "exact_name"
  | "fuzzy"
  | "work_context";

export interface PartyCandidate {
  ref: PartyRef;
  displayName: string;
  status: PartyOperationalStatus;
  /** Bounded operational context only; never credentials or unrestricted PII. */
  description: string | null;
}

export interface PartyResolverInput {
  ref?: PartyRef;
  partyId?: string;
  query?: string;
}

export interface PartyResolverContext {
  requesterEmployeeId?: string;
  workId?: string;
}

export interface PartyResolution {
  status: PartyResolutionStatus;
  method: PartyResolutionMethod | null;
  query: string | null;
  party: PartyCandidate | null;
  candidates: PartyCandidate[];
}

export interface CanonicalRelationship {
  from: CanonicalEntityRef<string>;
  relationship: string;
  to: CanonicalEntityRef<string>;
  source: { table: string; column: string };
}

export interface CanonicalEntityNode extends CanonicalEntityRef<string> {
  label: string | null;
  status: string | null;
  occurredAt: string | null;
}

export interface CompanyContext {
  anchor: CompanyContextAnchor;
  nodes: CanonicalEntityNode[];
  relationships: CanonicalRelationship[];
  truncated: boolean;
  source: { kind: "canonical_postgres"; tables: string[] };
  asOf: string;
}

/** Work attachment is the runtime extension seam. The active registry in
 * Postgres—not this open string generic—authorizes a concrete entity type. */
export interface AttachWorkEntityInput<TType extends string = string> extends CanonicalEntityRef<TType> {
  relationship?: "about" | "target" | "result";
  source?: string;
}
