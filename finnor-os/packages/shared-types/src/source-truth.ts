/** Provider-neutral contracts for the Phase 4 company-twin truth loop. Provider
 * pagination and payload mechanics stay in adapters; these types describe what
 * FINNOR must know before it may call canonical state fresh or an effect verified. */

export type SourceSystem = "ghl" | "quickbooks" | "stripe" | "vapi" | "docusign" | string;
export type SourceFreshnessState = "unknown" | "fresh" | "stale" | "expired";
export type SourceMappingStatus = "mapped" | "unresolved" | "ambiguous" | "tombstoned";
export type SourceConflictState =
  | "none"
  | "canonical_newer"
  | "external_newer"
  | "divergent"
  | "ambiguous"
  | "manual_resolution_required";
export type SourceAuthority = "finnor" | "external" | "manual";

export interface SourceOwnershipPolicy {
  /** Default authority for fields not listed in `fields`. */
  default: SourceAuthority;
  /** Optional field-level exceptions. No implicit last-write-wins exists. */
  fields?: Readonly<Record<string, SourceAuthority>>;
  /** Direction permitted when deterministic reconciliation is safe. */
  direction: "inbound" | "outbound" | "bidirectional_governed";
}

export interface SourceFreshnessPolicy {
  scope: string;
  maxAgeSeconds: number;
  criticality: "informational" | "operational" | "consequential";
  staleBehavior: "allow_with_warning" | "refresh_then_degrade" | "refresh_then_block";
}

export interface SourceRelationshipRef {
  entity: string;
  required?: boolean;
  canonicalId?: string;
  externalObjectType?: string;
  externalId?: string;
}

/** A normalized provider observation. Raw provider payloads never become planner or
 * realtime content; adapters retain only the bounded fields needed to materialize
 * canonical truth and explain provenance. */
export interface CanonicalSourceRecord {
  tenantId: string;
  integrationId: string;
  provider: SourceSystem;
  sourceScope: string;
  externalObjectType: string;
  externalId: string;
  canonicalEntity: string;
  sourceVersion?: string;
  /** Provider-monotonic sequence when one exists. Serialized as decimal text. */
  sourceSequence?: string;
  observedAt: string;
  deleted?: boolean;
  identityKey?: string;
  candidateCanonicalIds?: string[];
  data: Record<string, unknown>;
  relationships?: Readonly<Record<string, SourceRelationshipRef>>;
  ownership: SourceOwnershipPolicy;
  provenance?: Record<string, unknown>;
  /** Correlates a read-back/event to the immutable Phase 1 effect. */
  businessEffectId?: string;
  /** `observe_only` retains Source Truth ordering/dedupe/tombstone semantics but
   * deliberately never invokes a canonical import writer. PE uses this for
   * assertions about an already-resolved Deal entity: evidence is not state. */
  materialization?: "governed" | "observe_only";
}

export interface SourceSyncCursor {
  version: 1;
  token?: string;
  afterId?: string;
  changedSince?: string;
  page?: number;
  [key: string]: unknown;
}

export interface SourceSyncPage {
  scope: string;
  records: CanonicalSourceRecord[];
  nextCursor: SourceSyncCursor;
  hasMore: boolean;
  highWatermark?: string;
  rateLimit?: { remaining?: number; resetAt?: string; retryAfterSeconds?: number };
}

export type ExternalObservationClassification = "present" | "absent" | "divergent" | "unknown";

export interface ExternalEffectObservation {
  tenantId: string;
  businessEffectId: string;
  integrationId: string;
  provider: SourceSystem;
  externalObjectType: string;
  externalId?: string;
  observedAt: string;
  classification: ExternalObservationClassification;
  expected: Record<string, unknown>;
  observed?: Record<string, unknown>;
  mismatches?: Array<{ path: string; expected: unknown; observed: unknown }>;
  evidence: { mechanism: "read_after_write" | "webhook" | "poll" | "provider_event"; providerEventId?: string };
}

export interface SourceTruthSummary {
  configured: boolean;
  authenticated: boolean;
  reachable: boolean;
  syncInitialized: boolean;
  lastSuccessfulSyncAt?: string;
  freshness: SourceFreshnessState;
  webhook: "unknown" | "healthy" | "degraded" | "disabled";
  reconciliation: "unknown" | "healthy" | "degraded" | "blocked";
  sourceLagMs?: number;
  unresolvedConflicts: number;
  state: "connected" | "synced" | "fresh" | "degraded" | "blocked";
}
