import {
  appendEmployeeConversationMessage,
  createEmployeeConversationThread,
  listEmployeePersonalMemories,
  loadEmployeeConversationThread,
  searchEmployeeConversationMessages,
  updateEmployeeConversationMessageContext,
  updateEmployeeConversationThreadContext,
  users,
  withTenant,
} from "@finnor/db";
import { mirrorConversationMessageToZep, queryConsolidatedFacts } from "@finnor/memory";
import { resolveParty } from "@finnor/read-models";
import {
  isRetiredWaterCanonicalEntity,
  partyRefToCanonicalEntityRef,
  type ConversationReference,
  type ConversationReferenceResolution,
  type ConversationResolutionProvenance,
  type EmployeeConversationChannel,
  type EmployeeConversationContext,
  type EmployeeConversationMessage,
  type TenantContext,
} from "@finnor/shared-types";
import { and, eq } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL = /\b(?:email|call|text|contact|message|send|create|update|delete|remove|notify|handoff|delegate|assign|schedule|reschedule|share|approve|reject|close|waive|continue|finish|repeat|do\s+that)\b/i;
const PRONOUN = /\b(?:him|her|them|it|that person|that contact|that work|do that|continue that)\b/i;

export type NamedExpressionCue = "party" | "history";
export interface NamedExpression {
  name: string;
  organization?: string;
  cue: NamedExpressionCue;
  index: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function key(ref: { entityType: string; entityId: string }): string {
  return `${ref.entityType}:${ref.entityId}`;
}

function provenance(
  stage: ConversationResolutionProvenance["stage"],
  source: string,
  result: ConversationResolutionProvenance["result"],
  ref?: string,
  reason?: string,
): ConversationResolutionProvenance {
  return {
    stage,
    source,
    result,
    ...(ref ? { ref } : {}),
    ...(reason ? { reason } : {}),
    asOf: new Date().toISOString(),
  };
}

function validReference(value: unknown, source: ConversationReference["source"]): ConversationReference | null {
  const candidate = record(value);
  const entityType = typeof candidate.entityType === "string" ? candidate.entityType : "";
  const entityId = typeof candidate.entityId === "string" ? candidate.entityId : "";
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(entityType) || !UUID.test(entityId) || isRetiredWaterCanonicalEntity(entityType)) {
    return null;
  }
  return {
    entityType,
    entityId,
    label: typeof candidate.label === "string" && candidate.label.trim()
      ? candidate.label.trim().slice(0, 500)
      : `${entityType.replaceAll("_", " ")} ${entityId.slice(0, 8)}`,
    source,
    ...(typeof candidate.sourceMessageId === "string" ? { sourceMessageId: candidate.sourceMessageId } : {}),
    ...(typeof candidate.mentionedAtSequence === "number" ? { mentionedAtSequence: candidate.mentionedAtSequence } : {}),
    currentTruthAsOf: new Date().toISOString(),
  };
}

export async function resolveCanonicalHumanPrincipal(ctx: TenantContext): Promise<string> {
  const candidate = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null);
  if (!candidate || ctx.userId.startsWith("system:")) throw new Error("canonical_human_principal_required");
  const active = await withTenant(ctx.tenantId, async (db) => {
    const [row] = await db.select({ id: users.id }).from(users).where(and(
      eq(users.tenantId, ctx.tenantId),
      eq(users.id, candidate),
      eq(users.status, "active"),
    )).limit(1);
    return row?.id ?? null;
  }, candidate);
  if (!active) throw new Error("canonical_human_principal_not_active");
  return active;
}

/**
 * Extract only human/business-party names. Water resource nouns such as invoice,
 * appointment, quote, proposal and household are deliberately not recognized.
 */
export function extractNamedExpressions(instruction: string): NamedExpression[] {
  const results: NamedExpression[] = [];
  const add = (name: string | undefined, organization: string | undefined, cue: NamedExpressionCue, index: number) => {
    const clean = name?.replace(/\s+/g, " ").trim().replace(/[.,!?]+$/, "");
    if (!clean || clean.length < 2 || /^(?:the|this|that|him|her|them|it)$/i.test(clean)) return;
    const normalized = clean.toLocaleLowerCase();
    if (results.some((row) => row.name.toLocaleLowerCase() === normalized)) return;
    results.push({
      name: clean.slice(0, 160),
      cue,
      index,
      ...(organization?.trim() ? { organization: organization.trim().slice(0, 160) } : {}),
    });
  };
  const name = "([\\p{L}][\\p{L}'-]+(?:\\s+[\\p{L}][\\p{L}'-]+){0,2}?)";
  const boundary = "(?=\\s+(?:from|at|about|regarding|and|to|on|for|we|then)\\b|[,.!?]|$)";
  for (const match of instruction.matchAll(new RegExp(
    `\\b(?:email|call|text|contact|message|notify|ask|tell)\\s+(?:the\\s+)?${name}\\s+from\\s+([\\p{L}][\\p{L}\\d&.' -]{1,80}?)${boundary}`,
    "giu",
  ))) add(match[1], match[2], "party", match.index ?? 0);
  for (const match of instruction.matchAll(new RegExp(
    `\\b(?:email|call|text|contact|message|notify|ask|tell)\\s+(?:the\\s+)?${name}${boundary}`,
    "giu",
  ))) add(match[1], undefined, "party", match.index ?? 0);
  for (const match of instruction.matchAll(new RegExp(
    `\\b(?:spoke|talked|met)\\s+(?:to|with)\\s+${name}(?:\\s+from\\s+([\\p{L}][\\p{L}\\d&.' -]{1,80}?))?${boundary}`,
    "giu",
  ))) add(match[1], match[2], "history", match.index ?? 0);
  return results.sort((left, right) => left.index - right.index).slice(0, 5);
}

export interface PreparedEmployeeConversationTurn {
  threadId: string;
  employeeId: string;
  userMessage: EmployeeConversationMessage;
  duplicate: boolean;
  context: EmployeeConversationContext;
}

export async function prepareEmployeeConversationTurn(params: {
  ctx: TenantContext;
  threadId?: string;
  instruction: string;
  instructionId: string;
  idempotencyKey?: string;
  channel: EmployeeConversationChannel;
  transportSessionId?: string;
  originTransportKey?: string;
  activeContext?: Record<string, unknown>;
}): Promise<PreparedEmployeeConversationTurn> {
  const employeeId = await resolveCanonicalHumanPrincipal(params.ctx);
  const existing = params.threadId
    ? await loadEmployeeConversationThread({
        tenantId: params.ctx.tenantId,
        ownerEmployeeId: employeeId,
        threadId: params.threadId,
        messageLimit: 1,
      })
    : null;
  const thread = existing?.thread ?? await createEmployeeConversationThread({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    originTransportKey: params.originTransportKey,
  });

  const appended = await appendEmployeeConversationMessage({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: thread.id,
    role: "user",
    channel: params.channel,
    originalText: params.instruction,
    instructionId: params.instructionId,
    idempotencyKey: `user:${params.idempotencyKey ?? params.instructionId}`,
    transportSessionId: params.transportSessionId,
    transportProvenance: {
      kind: params.channel === "voice" ? "voice_transport" : "browser_transport",
      canonical: false,
    },
  });
  await mirrorConversationMessageToZep({
    tenantId: params.ctx.tenantId,
    employeeId,
    threadId: thread.id,
    messageId: appended.message.id,
    role: "user",
    content: params.instruction,
    createdAt: appended.message.createdAt,
  });

  const loaded = await loadEmployeeConversationThread({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: thread.id,
    messageLimit: 40,
  });
  if (!loaded) throw new Error("conversation_thread_not_found");

  const history: EmployeeConversationMessage[] = [];
  const named = extractNamedExpressions(params.instruction);
  for (const expression of named.filter((row) => row.cue === "history")) {
    const rows = await searchEmployeeConversationMessages({
      tenantId: params.ctx.tenantId,
      ownerEmployeeId: employeeId,
      query: expression.name,
      threadId: thread.id,
      limit: 10,
    });
    for (const row of rows) if (!history.some((candidate) => candidate.id === row.id)) history.push(row);
  }

  const activeContext = record(params.activeContext);
  const rawExplicit = [
    ...(Array.isArray(activeContext.selectedEntities) ? activeContext.selectedEntities : []),
    ...(activeContext.focusedEntity ? [activeContext.focusedEntity] : []),
  ];
  const explicit = rawExplicit.flatMap((value) => {
    const ref = validReference(value, "explicit_context");
    return ref ? [ref] : [];
  });
  const carried = loaded.thread.activeReferences.flatMap((value) => {
    const ref = validReference(value, "thread");
    return ref ? [ref] : [];
  });

  const partyCandidates: ConversationReference[] = [];
  const unresolvedExpressions: string[] = [];
  const trace: ConversationResolutionProvenance[] = [];
  for (const expression of named) {
    const resolution = await resolveParty(
      params.ctx.tenantId,
      { query: expression.organization ? `${expression.name} ${expression.organization}` : expression.name },
      { requesterEmployeeId: employeeId, workId: loaded.thread.activeWorkId ?? undefined },
    );
    const candidates = resolution.candidates.map((candidate): ConversationReference => {
      const ref = partyRefToCanonicalEntityRef(candidate.ref);
      return {
        ...ref,
        label: candidate.displayName,
        source: expression.cue === "history" ? "history_search" : "company_twin",
        currentTruthAsOf: new Date().toISOString(),
      };
    });
    for (const candidate of candidates) {
      partyCandidates.push(candidate);
      trace.push(provenance("company_twin", "active_party_directory", "candidate", key(candidate)));
    }
    if (resolution.status !== "resolved") unresolvedExpressions.push(expression.name);
  }

  const resolvedParties = named.flatMap((expression) => {
    const matching = partyCandidates.filter((candidate) =>
      candidate.label.toLocaleLowerCase().includes(expression.name.toLocaleLowerCase()),
    );
    return matching.length === 1 ? matching : [];
  });
  const unique = <T extends ConversationReference>(rows: T[]) =>
    [...new Map(rows.map((row) => [key(row), row])).values()];
  const selected = unique([...explicit, ...resolvedParties]);
  const candidates = unique([...explicit, ...partyCandidates, ...carried]);
  const consequential = CONSEQUENTIAL.test(params.instruction);

  if (PRONOUN.test(params.instruction) && explicit.length === 0) {
    if (carried.length === 1) selected.push(carried[0]!);
    else if (consequential) unresolvedExpressions.push("referenced target");
  }
  const unresolved = [...new Set(unresolvedExpressions)];
  const ambiguous = consequential && unresolved.length > 0;
  const resolution: ConversationReferenceResolution = {
    status: ambiguous ? "clarification_required" : selected.length ? "resolved" : "none",
    originalInstruction: params.instruction,
    resolvedReferences: unique(selected),
    candidates,
    unresolvedExpressions: unresolved,
    clarificationQuestion: ambiguous
      ? `Which active target do you mean for ${unresolved[0]}?`
      : null,
    consequential,
    senderIdentityRef: null,
    provenance: trace,
  };
  const truthSnapshot = {
    asOf: new Date().toISOString(),
    source: "active_company_twin",
    references: candidates.map((ref) => ({
      entityType: ref.entityType,
      entityId: ref.entityId,
      label: ref.label,
    })),
  };

  await updateEmployeeConversationMessageContext({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: thread.id,
    messageId: appended.message.id,
    resolutionSnapshot: resolution as unknown as Record<string, unknown>,
    resolutionProvenance: trace as unknown as Array<Record<string, unknown>>,
    companyTruthSnapshot: truthSnapshot,
  });
  const activeReferences = unique([
    ...resolution.resolvedReferences.map((ref) => ({
      ...ref,
      sourceMessageId: appended.message.id,
      mentionedAtSequence: appended.message.sequence,
    })),
    ...carried,
  ]).slice(0, 100);
  await updateEmployeeConversationThreadContext({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: thread.id,
    activeReferences: activeReferences as unknown as Array<Record<string, unknown>>,
    unresolvedReferences: unresolved.map((expression) => ({
      expression,
      messageId: appended.message.id,
      sequence: appended.message.sequence,
    })),
  });

  const personalMemories = await listEmployeePersonalMemories({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    limit: 50,
  });
  const zepHits = await queryConsolidatedFacts(
    params.ctx.tenantId,
    employeeId,
    params.instruction,
    5,
  );
  const refreshed = await loadEmployeeConversationThread({
    tenantId: params.ctx.tenantId,
    ownerEmployeeId: employeeId,
    threadId: thread.id,
    messageLimit: 30,
  });
  if (!refreshed) throw new Error("conversation_thread_not_found");

  return {
    threadId: thread.id,
    employeeId,
    userMessage: {
      ...appended.message,
      resolutionSnapshot: resolution as unknown as Record<string, unknown>,
      resolutionProvenance: trace as unknown as Array<Record<string, unknown>>,
      companyTruthSnapshot: truthSnapshot,
    },
    duplicate: appended.duplicate,
    context: {
      version: 1,
      ownerEmployeeId: employeeId,
      thread: refreshed.thread,
      exactRecentMessages: refreshed.messages,
      summary: refreshed.thread.summary
        ? { text: refreshed.thread.summary, throughSequence: refreshed.thread.summaryThroughSequence }
        : null,
      olderRelevantMessages: history,
      personalMemories,
      zepFacts: zepHits.map((hit) => ({
        fact: hit.chunk,
        source: "zep_employee_graph",
        ...(hit.occurredAt ? { createdAt: hit.occurredAt } : {}),
      })),
      resolution,
    },
  };
}

export async function linkEmployeeConversationTurnToWork(params: {
  tenantId: string;
  employeeId: string;
  threadId: string;
  userMessageId: string;
  workId: string;
  workInputId?: string;
  objectiveLoopId?: string;
}): Promise<void> {
  await updateEmployeeConversationMessageContext({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    messageId: params.userMessageId,
    workId: params.workId,
    ...(params.workInputId ? { workInputId: params.workInputId } : {}),
  });
  await updateEmployeeConversationThreadContext({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    activeWorkId: params.workId,
    ...(params.objectiveLoopId ? { activeObjectiveLoopId: params.objectiveLoopId } : {}),
  });
}

export async function persistEmployeeAssistantTurn(params: {
  tenantId: string;
  employeeId: string;
  threadId: string;
  instructionId: string;
  channel: EmployeeConversationChannel;
  text: string;
  workId?: string;
  workInputId?: string;
  outcomeRefs: Array<Record<string, unknown>>;
}): Promise<EmployeeConversationMessage> {
  const appended = await appendEmployeeConversationMessage({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    role: "assistant",
    channel: params.channel,
    originalText: params.text,
    instructionId: params.instructionId,
    workId: params.workId,
    workInputId: params.workInputId,
    idempotencyKey: `assistant:${params.instructionId}`,
    outcomeRefs: params.outcomeRefs,
    transportProvenance: { kind: "assistant_response", canonical: true },
  });
  await updateEmployeeConversationThreadContext({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    ...(params.workId ? { activeWorkId: params.workId } : {}),
    outcomeRefs: params.outcomeRefs,
  });
  await mirrorConversationMessageToZep({
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    threadId: params.threadId,
    messageId: appended.message.id,
    role: "assistant",
    content: params.text,
    createdAt: appended.message.createdAt,
  });
  return appended.message;
}
