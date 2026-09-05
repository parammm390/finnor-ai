import type { CanonicalEntityRef, PartyRef } from "./company-graph";
import type { OperationalPartySummary } from "./operational-queries";
import type { OperatingIdentityAccess } from "./identity-access";
import type { OperatingInteractionContext, OperatingInteractionPrecedence } from "./operating-interaction";
import type { EmployeeConversationContext, EmployeePersonalMemory } from "./conversation-context";
import type { TenantVerticalIdentity } from "./vertical-runtime";
import type { PrivateEquityEpistemicWarning } from "./operational-queries";

/**
 * Evidence classes are deliberately ordered.  Callers may enrich a higher class
 * with a lower one, but a lower class can never replace or contradict a higher
 * class when answering a current operating-state question.
 */
export const OPERATING_TRUTH_PRECEDENCE = [
  "CANONICAL",
  "WORK",
  "PROFILE",
  "SESSION",
  "MEMORY",
  "WEB",
] as const;

export type OperatingEvidenceKind = (typeof OPERATING_TRUTH_PRECEDENCE)[number];

export interface OperatingSourceRef {
  kind: OperatingEvidenceKind;
  source: string;
  ref?: string;
  asOf: string;
  /** Context may inform a later query without being valid answer evidence. */
  role: "answer_evidence" | "context_only";
}

export interface TenantOperatingProfile {
  industry: string | null;
  niche: string | null;
  description: string | null;
  primaryGeographies: string[];
  foundedYear: number | null;
  idealCustomerProfile: Record<string, unknown>;
  businessFacts: Record<string, unknown>;
  comparisonDefaults: {
    scaleMetric?: string;
    performanceMetric?: string;
  };
  updatedAt: string | null;
}

export interface UserOperatingProfile {
  title: string | null;
  profileFacts: Record<string, unknown>;
  updatedAt: string | null;
}

export interface OperatingIntegrationHealth {
  capability: string;
  binding: string;
  source: "tenant" | "env" | "default";
  health: "ok" | "degraded" | "down" | "unknown";
  circuit: "closed" | "open";
  unavailable: boolean;
  reason: string | null;
}

export interface OperatingContextMemoryHit {
  id?: string;
  sourceDocId: string | null;
  chunk: string;
  similarity: number;
  relevanceScore?: number;
  sourceKind?: string;
  occurredAt?: string;
  entityRefs?: unknown[];
  provenance?: Record<string, unknown>;
}

/**
 * Bounded canonical company-directory context for the authenticated employee.
 * Every value is assembled from tenant-scoped Postgres rows. Profile and memory
 * may enrich the surrounding OperatingContext, but never override this data.
 */
export interface OperatingCompanyDirectory {
  employee: OperationalPartySummary | null;
  teams: OperationalPartySummary[];
  locations: OperationalPartySummary[];
  reporting: {
    manager: OperationalPartySummary | null;
    reports: OperationalPartySummary[];
    backups: OperationalPartySummary[];
    assistants: OperationalPartySummary[];
  };
  currentWork: Array<{
    id: string;
    status: string;
    instruction: string | null;
    updatedAt: string | null;
  }>;
  currentTasks: Array<{
    id: string;
    title: string;
    status: string;
    dueAt: string | null;
    authorityRole: string | null;
  }>;
  authorityRoles: string[];
  referencedParties: OperationalPartySummary[];
  sourceTables: string[];
}

export interface OperatingContext {
  version: 1;
  assembledAt: string;
  truthPrecedence: readonly OperatingEvidenceKind[];
  interactionPrecedence?: readonly OperatingInteractionPrecedence[];
  /** Authenticated, tenant-re-resolved explicit canvas state. */
  interactionContext?: OperatingInteractionContext | null;
  /** Private authenticated-human context. It is never populated for a service
   * principal and remains distinct from Work and canonical company truth. */
  conversationContext?: EmployeeConversationContext | null;
  personalMemory?: EmployeePersonalMemory[];
  tenant: {
    id: string;
    companyName: string | null;
    timezone: string | null;
    /** Present on freshly assembled contexts; optional only for replaying older
     * version-1 fixtures that predate the vertical runtime boundary. */
    vertical?: TenantVerticalIdentity;
    profile: TenantOperatingProfile;
  };
  employee: {
    userId: string;
    employeeId: string | null;
    displayName: string | null;
    role: string;
    authorityRoles: string[];
    profile: UserOperatingProfile;
  };
  activeWork: {
    id: string;
    status: string | null;
    sessionId: string | null;
    initialInstruction: string | null;
    activeContext: Record<string, unknown>;
    updatedAt: string | null;
  } | null;
  companyDirectory: OperatingCompanyDirectory;
  /** Safe governed handles available to the authenticated employee. This surface
   * never contains a credential provider/ref/version or any resolved secret. */
  identityAccess: OperatingIdentityAccess;
  universalActions?: {
    capabilities: {
      allowedChannels: string[];
      allowChannelFallback: boolean;
      maxGroupRecipients: number;
      externalDocumentSharing: boolean;
      externalCalendarMode: "internal_only" | "when_available";
      browserExecutable: false;
      computerExecutable: boolean;
    };
    activeDelegations: Array<{
      delegationRef: { delegationId: string };
      target: PartyRef;
      objective: string;
      status: string;
      workRef: { workId: string } | null;
      taskRef: { taskId: string } | null;
      acknowledgementDeadline: string | null;
      completionDeadline: string | null;
    }>;
    pendingAcknowledgements: Array<{
      acknowledgementRequestId: string;
      recipient: PartyRef;
      status: string;
      deadline: string | null;
      delegationRef: { delegationId: string } | null;
    }>;
    upcomingInternalEvents: Array<{
      internalEventRef: { internalEventId: string };
      title: string;
      status: string;
      startsAt: string;
      endsAt: string;
      participantCount: number;
    }>;
  };
  referencedEntities: CanonicalEntityRef<string>[];
  /** Decision-relevant uncertainty is additive context, never canonical state. */
  epistemicWarnings?: PrivateEquityEpistemicWarning[];
  canonicalSummaries: Array<{
    name: string;
    asOf: string;
    source: string;
    data: Record<string, unknown>;
  }>;
  memory: {
    conversation: Record<string, unknown> | null;
    semantic: OperatingContextMemoryHit[];
    episodic: Array<Record<string, unknown>>;
  };
  integrationHealth: Record<string, OperatingIntegrationHealth>;
  authority: {
    principal: string;
    employeeId: string | null;
    revision: number | null;
    roles: string[];
  };
  sources: OperatingSourceRef[];
  health: {
    status: "complete" | "partial" | "unavailable";
    missing: string[];
    errors: string[];
  };
}

export function operatingEvidenceRank(kind: OperatingEvidenceKind): number {
  return OPERATING_TRUTH_PRECEDENCE.indexOf(kind);
}
