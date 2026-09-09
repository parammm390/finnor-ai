/** Provider-neutral contracts for the Phase 4 company-twin truth loop. Provider
 * pagination and payload mechanics stay in adapters; these types describe what
 * FINNOR must know before it may call canonical state fresh or an effect verified. */

export type SourceSystem = "ghl" | "quickbooks" | "stripe" | "vapi" | "docusign" | string;
export type SourceFreshnessState = "unknown" | "fresh" | "stale" | "expired";
export type SourceCoverageState =
  | "INITIALIZING"
  | "COMPLETE"
  | "PARTIAL"
  | "RECOVERING"
  | "BLOCKED_AUTH"
  | "BLOCKED_PERMISSION"
  | "HISTORY_LIMITED"
  | "NOT_CONFIGURED"
  | "DISABLED";
export type SourceRecoveryStrength =
  | "EXACT_DELTA"
  | "BOUNDED_RECONCILIATION"
  | "BEST_EFFORT_NOTIFICATION_RECOVERY";
export type ProviderObservationIngestionMode =
  | "initial_backfill"
  | "incremental"
  | "recovery"
  | "exact_read";
export type Microsoft365SourceKind =
  | "outlook_mail_folder"
  | "outlook_calendar_view"
  | "teams_channel"
  | "teams_chat"
  | "teams_user_chat_feed"
  | "teams_transcript_organizer"
  | "sharepoint_drive"
  | "sharepoint_list";
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

/** Exact provider relationship used for deterministic identity/root inheritance.
 * It is a provider reference, never a canonical FINNOR assertion. */
export interface ProviderObservationParentRef {
  resourceKind: string;
  externalObjectType: string;
  externalObjectId: string;
  relationship: "parent" | "thread" | "series" | "meeting" | "container";
}

/**
 * Immutable transport boundary between a provider adapter and a vertical mapper.
 * `payload` and `providerMetadata` are bounded by the adapter and database. Provider
 * text is untrusted evidence and is structurally ineligible to become an instruction.
 */
export interface ProviderObservation {
  tenantId: string;
  integrationId: string;
  sourceScopeId: string;
  provider: SourceSystem;
  resourceKind: string;
  externalObjectType: string;
  externalObjectId: string;
  providerParentRefs: readonly ProviderObservationParentRef[];
  providerVersion?: string | null;
  /** Only present for a genuinely provider-monotonic sequence. Never synthesized. */
  providerSequence?: string | null;
  observedAt: string;
  /** One timestamp captured after a successful provider read and carried unchanged. */
  retrievedAt: string;
  deleted: boolean;
  payloadHash: string;
  payload: Readonly<Record<string, unknown>>;
  providerMetadata: Readonly<Record<string, unknown>>;
  ingestionMode: ProviderObservationIngestionMode;
  traceId: string;
}

export interface ProviderObservationSyncPage {
  sourceScopeId: string;
  sourceScope: string;
  observations: ProviderObservation[];
  nextCursor: SourceSyncCursor;
  hasMore: boolean;
  highWatermark?: string;
  coverage?: {
    state: SourceCoverageState;
    region: Readonly<Record<string, unknown>>;
    reason?: string;
  };
  rateLimit?: { remaining?: number; resetAt?: string; retryAfterSeconds?: number };
}

export interface SourceCoverageSnapshot {
  sourceScopeId: string;
  sourceKind: string;
  state: SourceCoverageState;
  recoveryStrength: SourceRecoveryStrength;
  region: Readonly<Record<string, unknown>>;
  recordedAt: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  reason?: string | null;
  baselineStartedAt?: string | null;
  baselineCompletedAt?: string | null;
  earliestProviderAt?: string | null;
  latestProviderAt?: string | null;
  unresolvedObservations: number;
  ambiguousObservations: number;
  /** Safe immutable source/root/permission/freshness context captured with the
   * coverage fact. Empty only for facts created before descriptor history. */
  sourceDescriptor: Readonly<Record<string, unknown>>;
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
