/**
 * Upgrade 7: the deliberately small identity/relationship contract shared by
 * JARVIS runtime layers. These names identify existing canonical Postgres rows;
 * they are not an ontology and never authorize a tenant selector from a client.
 */
export const CANONICAL_ENTITY_TYPES = [
  "household",
  "contact",
  "user",
  "technician",
  "equipment",
  "service_visit",
  "maintenance_agreement",
  "lead",
  "opportunity",
  "quote",
  "proposal",
  "work_order",
  "appointment",
  "invoice",
  "payment",
  "conversation",
  "call",
  "message",
  "communication",
  "document",
  "evidence_source",
  "evidence_source_version",
  "task",
  "work",
  "domain_action",
  "workflow_run",
  "workflow_step",
  "business_operation",
  "business_operation_target",
  "decision_receipt",
  "business_event",
  // Phase 0 Company World. `user` remains the canonical graph identity for an
  // employee; PartyRef exposes the business-facing `employee` name without
  // creating a second identity row.
  "org_unit",
  "tenant_location",
  "external_organization",
  "external_contact",
  // Phase 2 Universal Action + Delegation Fabric. These remain canonical IDs
  // inside the authenticated tenant; no reference ever carries a tenant selector.
  "delegation",
  "acknowledgement_request",
  "communication_delivery",
  "internal_event",
  "document_share",
  // Phase 2 Live Business World. These are existing canonical rows promoted to
  // the shared identity seam; no duplicate inventory or computer record exists.
  "inventory_item",
  "computer_run",
] as const;

export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

export interface CanonicalEntityRef<TType extends string = CanonicalEntityType> {
  entityType: TType;
  entityId: string;
}

/**
 * The stable business-facing reference shared by JARVIS read/planning layers.
 * It deliberately contains no tenant selector: the authenticated execution
 * context supplies tenant identity and every resolver lookup is scoped by it.
 */
export const PARTY_TYPES = [
  "employee",
  "team",
  "location",
  "household",
  "contact",
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
  household: "household",
  contact: "contact",
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
    case "household": return { partyType: "household", partyId: ref.entityId };
    case "contact": return { partyType: "contact", partyId: ref.entityId };
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
  /** A typed canonical party reference always has highest precedence. */
  ref?: PartyRef;
  /** A raw UUID may be used when the caller does not know the party type. */
  partyId?: string;
  /** Natural-language name, alias, contact value, or relationship phrase. */
  query?: string;
}

export interface PartyResolverContext {
  /** Trusted authenticated employee identity, never accepted from planner payloads. */
  requesterEmployeeId?: string;
  /** Trusted current Work identity used only for Work-dependent phrases. */
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
  from: CanonicalEntityRef;
  relationship: string;
  to: CanonicalEntityRef;
  /** Exact table/column responsible for this edge. */
  source: { table: string; column: string };
}

export interface CanonicalEntityNode extends CanonicalEntityRef {
  label: string | null;
  status: string | null;
  occurredAt: string | null;
}

export interface CompanyContext {
  anchor: CompanyContextAnchor;
  /** Present for legacy/customer-anchored journeys; null for company-only context. */
  household: {
    id: string;
    displayName: string | null;
    address: string;
  } | null;
  nodes: CanonicalEntityNode[];
  relationships: CanonicalRelationship[];
  /** True when the fixed safety cap omitted additional related rows. */
  truncated: boolean;
  source: { kind: "canonical_postgres"; tables: string[] };
  asOf: string;
}

/**
 * Work attachment is the runtime-extension seam.  Core's built-in entity union
 * remains useful for its own callers, while a registered vertical supplies its
 * own string-literal union and the database registry validates it fail-closed.
 */
export interface AttachWorkEntityInput<TType extends string = string> extends CanonicalEntityRef<TType> {
  relationship?: "about" | "target" | "result";
  source?: string;
}
