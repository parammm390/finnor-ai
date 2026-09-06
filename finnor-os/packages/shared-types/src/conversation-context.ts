import type { CanonicalEntityRef } from "./company-graph";

export type EmployeeConversationRole = "user" | "assistant";
export type EmployeeConversationChannel = "voice" | "text" | "console";

export interface ConversationReference extends CanonicalEntityRef<string> {
  label: string;
  source: "explicit_context" | "thread" | "work" | "recent_message" | "history_search" | "company_twin";
  sourceMessageId?: string;
  mentionedAtSequence?: number;
  currentTruthAsOf: string;
}

export interface ConversationResolutionProvenance {
  stage: "explicit" | "thread" | "work" | "history" | "personal_memory" | "zep" | "company_twin" | "sender_identity";
  source: string;
  ref?: string;
  asOf: string;
  result: "candidate" | "selected" | "rejected" | "unavailable" | "superseded";
  reason?: string;
}

export interface ConversationReferenceResolution {
  status: "none" | "resolved" | "clarification_required";
  originalInstruction: string;
  resolvedReferences: ConversationReference[];
  candidates: ConversationReference[];
  unresolvedExpressions: string[];
  clarificationQuestion: string | null;
  consequential: boolean;
  senderIdentityRef: { communicationIdentityId: string; channel: "email" | "sms" | "voice"; purpose: string } | null;
  provenance: ConversationResolutionProvenance[];
}

export interface EmployeeConversationMessage {
  id: string;
  threadId: string;
  sequence: number;
  role: EmployeeConversationRole;
  channel: EmployeeConversationChannel;
  originalText: string;
  instructionId: string | null;
  workId: string | null;
  workInputId: string | null;
  resolutionSnapshot?: Record<string, unknown> | null;
  resolutionProvenance?: Array<Record<string, unknown>>;
  companyTruthSnapshot?: Record<string, unknown> | null;
  outcomeRefs: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface EmployeeConversationThreadSummary {
  id: string;
  title: string | null;
  summary: string | null;
  revision: number;
  activeWorkId: string | null;
  activeObjectiveLoopId: string | null;
  lastActivityAt: string;
  createdAt: string;
  messageCount?: number;
  lastMessage?: Pick<EmployeeConversationMessage, "role" | "originalText" | "createdAt"> | null;
}

export interface EmployeePersonalMemory {
  id: string;
  memoryType: "preference" | "proposition";
  subjectKey: string;
  proposition: string;
  structuredValue: Record<string, unknown>;
  sourceThreadId: string;
  sourceMessageId: string;
  provenance: Record<string, unknown>;
  validFrom: string;
  supersededAt: string | null;
  supersededById: string | null;
}

/**
 * The private context handed to the existing routing/planning spine. Current
 * company truth and current authority remain external, higher-precedence inputs.
 */
export interface EmployeeConversationContext {
  version: 1;
  ownerEmployeeId: string;
  thread: EmployeeConversationThreadSummary;
  exactRecentMessages: EmployeeConversationMessage[];
  summary: { text: string; throughSequence: number } | null;
  olderRelevantMessages: EmployeeConversationMessage[];
  personalMemories: EmployeePersonalMemory[];
  zepFacts: Array<{ fact: string; source: string; createdAt?: string }>;
  resolution: ConversationReferenceResolution;
}
