import type { CanonicalEntityRef, PartyRef } from "./company-graph";

/** The Phase 2 action catalog is deliberately explicit. Keep the original 44 action
 * contracts intact and append these 14; callers never infer an action from a route. */
export const UNIVERSAL_ACTION_TYPES = [
  "send_message",
  "place_call",
  "request_acknowledgement",
  "notify_group",
  "create_task",
  "assign_task",
  "update_task",
  "handoff_work",
  "delegate_objective",
  "escalate_work",
  "cancel_delegation",
  "schedule_internal_event",
  "reschedule_internal_event",
  "share_document",
] as const;

export type UniversalActionType = (typeof UNIVERSAL_ACTION_TYPES)[number];
export type UniversalCommunicationChannel = "internal" | "email" | "sms" | "voice";

// Typed refs contain only a canonical row ID. Tenant identity is always supplied by
// the authenticated execution scope and cannot be selected by a planner payload.
export interface WorkRef { workId: string }
export interface TaskRef { taskId: string }
export interface DocumentRef { documentId: string }
export interface LocationRef { locationId: string }
export interface DelegationRef { delegationId: string }
export interface InternalEventRef { internalEventId: string }
export interface ObjectiveLoopRef { objectiveLoopId: string }
export interface CommunicationIdentityRef { communicationIdentityId: string }

export type ExecutionRoute = "native" | "api" | "browser" | "computer" | "manual";
export type RouteReasonCode =
  | "native_system_of_record"
  | "configured_api_adapter"
  | "provider_not_configured"
  | "external_sharing_disallowed"
  | "unsupported_channel"
  | "manual_required";

export interface ExecutionRouteDecision {
  route: ExecutionRoute;
  executable: boolean;
  reasonCode: RouteReasonCode;
  provider: string | null;
  /** native < api < browser < computer < manual. Browser and computer are typed
   * possibilities only in Phase 2 and are never executable. */
  hierarchyRank: 0 | 1 | 2 | 3 | 4;
}

export interface UniversalRouteInput {
  actionType: UniversalActionType;
  channel?: UniversalCommunicationChannel;
  recipient?: PartyRef;
  apiAvailable?: boolean;
  provider?: string | null;
  externalSharingAllowed?: boolean;
}

const EXTERNAL_PARTIES = new Set<PartyRef["partyType"]>(["external_organization", "external_contact"]);
const COMMUNICATION_ACTIONS = new Set<UniversalActionType>(["send_message", "place_call", "notify_group"]);

/** Pure, auditable route selection. Payloads never select a route. Missing providers
 * result in an honest non-executable manual route; Phase 2 does not pretend browser
 * or computer execution exists. */
export function decideUniversalActionRoute(input: UniversalRouteInput): ExecutionRouteDecision {
  if (COMMUNICATION_ACTIONS.has(input.actionType)) {
    const channel = input.actionType === "place_call" ? "voice" : input.channel;
    if (!channel || !(["internal", "email", "sms", "voice"] as const).includes(channel)) {
      return { route: "manual", executable: false, reasonCode: "unsupported_channel", provider: null, hierarchyRank: 4 };
    }
    if (channel === "internal") {
      return { route: "native", executable: true, reasonCode: "native_system_of_record", provider: null, hierarchyRank: 0 };
    }
    if (input.provider === "native") {
      return { route: "native", executable: true, reasonCode: "native_system_of_record", provider: "native", hierarchyRank: 0 };
    }
    return input.apiAvailable
      ? { route: "api", executable: true, reasonCode: "configured_api_adapter", provider: input.provider ?? null, hierarchyRank: 1 }
      : { route: "manual", executable: false, reasonCode: "provider_not_configured", provider: input.provider ?? null, hierarchyRank: 4 };
  }

  if (input.actionType === "share_document" && input.recipient && EXTERNAL_PARTIES.has(input.recipient.partyType)) {
    if (!input.externalSharingAllowed) {
      return { route: "manual", executable: false, reasonCode: "external_sharing_disallowed", provider: null, hierarchyRank: 4 };
    }
    return input.apiAvailable
      ? { route: "api", executable: true, reasonCode: "configured_api_adapter", provider: input.provider ?? null, hierarchyRank: 1 }
      : { route: "manual", executable: false, reasonCode: "provider_not_configured", provider: input.provider ?? null, hierarchyRank: 4 };
  }

  return { route: "native", executable: true, reasonCode: "native_system_of_record", provider: null, hierarchyRank: 0 };
}

export type DelegationStatus =
  | "created"
  | "sent"
  | "delivered"
  | "acknowledged"
  | "accepted"
  | "completed"
  | "declined"
  | "overdue"
  | "escalated"
  | "cancelled"
  | "failed_delivery";

export interface DelegationRecord {
  id: string;
  target: PartyRef;
  objective: string;
  status: DelegationStatus;
  workRef: WorkRef | null;
  taskRef: TaskRef | null;
  objectiveLoopRef: ObjectiveLoopRef | null;
  acknowledgementDeadline: string | null;
  completionDeadline: string | null;
}

export interface UniversalActionEvidence {
  actionType: UniversalActionType;
  domainActionId: string;
  subject?: CanonicalEntityRef | PartyRef;
  route: ExecutionRouteDecision;
  evidenceRefs: CanonicalEntityRef[];
}
