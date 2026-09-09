import type {
  Microsoft365SourceKind,
  ProviderObservationIngestionMode,
  SourceCoverageState,
  SourceFreshnessPolicy,
  SourceRecoveryStrength,
  SourceSyncCursor,
} from "@finnor/shared-types";

export const MICROSOFT_GRAPH_PROVIDER = "microsoft_graph" as const;
export const MICROSOFT_GRAPH_HOST = "graph.microsoft.com" as const;
export const MICROSOFT_LOGIN_HOST = "login.microsoftonline.com" as const;

export type MicrosoftPermissionMode = "SCOPED" | "BROAD";

export interface Microsoft365SourceCapability {
  sourceKind: Microsoft365SourceKind;
  family: "outlook_mail" | "outlook_calendar" | "teams_channel" | "teams_chat" | "teams_transcript" | "sharepoint_drive" | "sharepoint_list";
  coverageUnit: readonly string[];
  supportsInitialEnumeration: true;
  supportsDelta: boolean;
  deltaScope?: string;
  supportsExactRead: boolean;
  supportsChangeNotifications: boolean;
  supportsLifecycleReauthorization: boolean;
  supportsLifecycleSubscriptionRemoved: boolean;
  supportsLifecycleMissed: boolean;
  supportsProviderDeletes: boolean;
  supportsImmutableId: boolean;
  historyLimit: { kind: "none" } | { kind: "rolling_months"; months: number } | { kind: "configured_window" } | { kind: "provider_availability" };
  recoveryStrength: SourceRecoveryStrength;
  permissionProfiles: Readonly<Record<MicrosoftPermissionMode, readonly string[] | null>>;
  providerRestriction: Readonly<Record<MicrosoftPermissionMode, string>>;
  defaultFreshnessPolicy: SourceFreshnessPolicy;
  maxSubscriptionMinutes?: number;
  subscriptionResource?(scope: Microsoft365SourceScope): string;
}

export interface Microsoft365SourceScope {
  id: string;
  tenantId: string;
  integrationId: string;
  provider: typeof MICROSOFT_GRAPH_PROVIDER;
  sourceKind: Microsoft365SourceKind;
  scopeKey: string;
  providerResourceId: string;
  providerParentId?: string | null;
  permissionMode: MicrosoftPermissionMode;
  coveragePolicy: Readonly<Record<string, unknown>>;
  freshnessPolicy: Readonly<Record<string, unknown>>;
  configuration: Readonly<Record<string, unknown>>;
}

export interface MicrosoftSourceCursor extends SourceSyncCursor {
  phase?: "initial" | "catchup" | "incremental" | "recovery";
  token?: string;
  baselineStartedAt?: string;
  baselineCompletedAt?: string;
  windowStart?: string;
  windowEnd?: string;
  historyBoundary?: string;
  reconciliationStartedAt?: string;
}

export interface GraphCollectionPage<T extends Record<string, unknown> = Record<string, unknown>> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
  "@odata.count"?: number;
}

export interface Microsoft365ReadContext {
  /** Persisted account identity resolved through FINNOR's tenant-bound auth chain. */
  directoryTenantId: string;
  ingestionMode: ProviderObservationIngestionMode;
  traceId: string;
  signal?: AbortSignal;
}

export interface Microsoft365PageResult {
  observations: import("@finnor/shared-types").ProviderObservation[];
  nextCursor: MicrosoftSourceCursor;
  hasMore: boolean;
  highWatermark?: string;
  coverage: {
    state: SourceCoverageState;
    region: Readonly<Record<string, unknown>>;
    reason?: string;
  };
}

export interface MicrosoftGraphSubscriptionInput {
  resource: string;
  changeTypes: readonly string[];
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  requestedExpirationAt: string;
  clientState: string;
}

export interface MicrosoftGraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  expirationDateTime: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
}

export type MicrosoftGraphLogEvent = Readonly<{
  operation: string;
  status?: number;
  durationMs: number;
  retryAfterMs?: number;
  requestId?: string;
  clientRequestId: string;
}>;

export type MicrosoftGraphLogger = (event: MicrosoftGraphLogEvent) => void;
