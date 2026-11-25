import { hydrateConversationMemory, scheduleConversationCompaction } from "./conversation-memory";
import { isReadOnlyConversationQuestion } from "./conversation-intent";
import { logWithTrace } from "@finnor/tools";
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
import { normalizePartyName, resolveParty } from "@finnor/read-models";
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
const CONSEQUENTIAL = /\b(?:email|call|text|contact|message|ask|tell|send|create|update|delete|remove|notify|handoff|delegate|assign|schedule|reschedule|share|approve|reject|close|waive|continue|finish|repeat|do\s+that)\b/i;
const PRONOUN = /\b(?:him|her|them|it|that person|that contact|that work|do that|continue that)\b/i;
const NEGATED_PARTY_CUE = /\b(?:(?:do|may|must|should|can|could|will|would)\s+not|(?:don|mustn|shouldn|can|couldn|won|wouldn)['’]t|cannot|never)\s+(?:ever\s+)?$/i;

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
  return parseNamedExpressions(instruction).expressions;
}

function parseNamedExpressions(instruction: string) {
  const quoted = /"(?:\\.|[^"\\])*(?:"|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|`[^`]*(?:`|$)|(?<![\p{L}\p{N}])'(?:\\.|[^'\\])*'(?![\p{L}\p{N}])/gu;
  const contentStart = /\b(?:(?:with\s+(?:(?:the|this|following)\s+)*)?(?:(?:email|message|call|text)\s+)?(?:subject|body|draft|script|message(?:\s+(?:body|text))?)\s*:|(?:saying|(?:that|which)\s+(?:says|reads))\s+)/i;
  let command = instruction.replace(quoted, (text) => "\0".repeat(text.length));
  const content = contentStart.exec(command);
  if (content) command = command.slice(0, content.index);

  const results: NamedExpression[] = [];
  const negatedQualifiedNames = new Set<string>();
  const negated = (index: number) => NEGATED_PARTY_CUE.test(command.slice(0, index));
  const partyName = (name: string | undefined) => {
    const clean = name?.replace(/\s+/g, " ").trim().replace(/[.,!?]+$/, "");
    return clean && clean.length >= 2 && !/^(?:the|this|that|him|her|them|it)$/i.test(clean) ? clean : undefined;
  };
  const add = (name: string | undefined, organization: string | undefined, cue: NamedExpressionCue, index: number) => {
    const clean = partyName(name);
    if (!clean) return;
    const normalized = clean.toLocaleLowerCase();
    if (results.some((row) => row.name.toLocaleLowerCase() === normalized)) return;
    results.push({
      name: clean.slice(0, 160),
      cue,
      index,
      ...(organization?.trim() ? { organization: organization.trim().slice(0, 160) } : {}),
    });
  };
  const partyCue = "(?:email|call|text|contact|message|notify|ask|tell)";
  const excludedAlternative = "(instead\\s+of\\s+)(?:emailing|calling|texting|contacting|messaging|notifying|asking|telling)";
  const name = "([\\p{L}][\\p{L}'-]+(?:\\s+[\\p{L}][\\p{L}'-]+){0,2}?)";
  const organization = "([\\p{L}][\\p{L}\\d&.' –—-]{1,80}?)";
  const dash = "(?:\\s+-\\s+|\\s*[–—]\\s*)";
  const dashClause = `${dash}(?:please\\s+)?${partyCue}\\s+`;
  const joinedClause = "\\b(?:and(?:\\s+then)?|then|also|but|so)\\s+(?:please\\s+)?";
  const correctionMarker = "(?:(?:sorry|I\\s+mean|actually|rather(?!\\s+than\\b))\\b\\s*,?\\s*|no\\s*,\\s*)";
  const boundary = `(?=\\s+(?:from|at|about|regarding|and|to|on|for|we|then|instead)\\b|\\s+${joinedClause}${partyCue}\\b|${dashClause}|${dash}${correctionMarker}|\\s*[\\x00,.!?;:]|\\s*$)`;
  const addressee = `(?:the\\s+)?${name}(?:\\s+from\\s+${organization})?${boundary}`;
  const destination = new RegExp(`\\s+to\\s+${addressee}`, "iyu");
  const clauseSeparator = `(?:${dash}|\\s*[,.!?;:\\r\\n]\\s*)`;
  const correctionBeforeVerb = new RegExp(`(?:^\\s*|${clauseSeparator})${correctionMarker}(?:please\\s+)?$`, "i");
  const qualifiedCorrection = new RegExp(
    `${clauseSeparator}${correctionMarker}(?!${partyCue}\\b)(?:the\\s+)?${name}\\s+from\\s+${organization}${boundary}`,
    "iyu",
  );
  const nextAddressee = new RegExp(
    `(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)(?!(?:please|then|also|instead|${partyCue})\\b|${joinedClause}${partyCue}\\b|${correctionMarker})${addressee}`,
    "iyu",
  );
  const newClause = new RegExp(`(?:[.!?;:,\\r\\n–—]|\\s-\\s)\\s*(?:please\\s+)?$|${joinedClause}$`, "i");
  let previousAddresseeEnd = 0;
  let hasRecipientCorrection = false;
  const namedOutreachClauses = new Set<string>();
  for (const match of command.matchAll(new RegExp(
    `\\b(?:${partyCue}|${excludedAlternative})\\s+${addressee}`,
    "giu",
  ))) {
    const [, alternative, recipient, qualifier] = match;
    if (match.index < previousAddresseeEnd) continue;
    const excluded = Boolean(alternative) || negated(match.index);
    const gap = command.slice(previousAddresseeEnd, match.index);
    const negation = excluded ? NEGATED_PARTY_CUE.exec(gap) : null;
    const correctsPrevious = previousAddresseeEnd > 0 && correctionBeforeVerb.test(gap.slice(0, negation?.index ?? gap.length));
    if (!excluded && previousAddresseeEnd && !correctsPrevious && !newClause.test(gap)) continue;
    const end = match.index + match[0].length;
    const artifactToRecipient = /^(?:calculation|analysis|findings|results|memo|report|summary|document|model|update|draft|note)$/i.test(recipient ?? "")
      && /^\s+to\b/i.test(command.slice(end));
    destination.lastIndex = end;
    const artifactDestination = artifactToRecipient ? destination.exec(command) : null;
    if (artifactToRecipient && !artifactDestination) continue;

    const clauseAddressees = new Set<string>();
    const recordAddressee = (name: string | undefined, organization: string | undefined, index: number) => {
      const named = partyName(name);
      if (!named) return;
      clauseAddressees.add(JSON.stringify([normalizePartyName(named), normalizePartyName(organization ?? "")]));
      if (excluded) {
        if (!artifactToRecipient && organization) negatedQualifiedNames.add(normalizePartyName(named));
      } else {
        if (!artifactToRecipient) add(named, organization, "party", index);
      }
    };
    if (artifactDestination) {
      recordAddressee(artifactDestination[1], artifactDestination[2], match.index);
      previousAddresseeEnd = destination.lastIndex;
    } else {
      recordAddressee(recipient, qualifier, match.index);
      previousAddresseeEnd = end;
    }
    nextAddressee.lastIndex = previousAddresseeEnd;
    for (let next = nextAddressee.exec(command); next; next = nextAddressee.exec(command)) {
      const [, name, organization] = next;
      if (CONSEQUENTIAL.exec(name ?? "")?.index === 0) break;
      recordAddressee(name, organization, next.index);
      previousAddresseeEnd = nextAddressee.lastIndex;
    }
    if (clauseAddressees.size) {
      if (!excluded) namedOutreachClauses.add(JSON.stringify([...clauseAddressees].sort()));
      qualifiedCorrection.lastIndex = previousAddresseeEnd;
      if (correctsPrevious || qualifiedCorrection.test(command)) hasRecipientCorrection = true;
    }
    if (!excluded && /^\s*:/.test(command.slice(previousAddresseeEnd))) {
      command = command.slice(0, previousAddresseeEnd);
      break;
    }
  }
  for (const match of command.matchAll(new RegExp(
    `\\b(?:spoke|talked|met)\\s+(?:to|with)\\s+${name}(?:\\s+from\\s+${organization})?${boundary}`,
    "giu",
  ))) add(match[1], match[2], "history", match.index ?? 0);
  return {
    expressions: results.sort((left, right) => left.index - right.index).slice(0, 5),
    negatedQualifiedNames,
    recipientConflict: namedOutreachClauses.size > 1 || hasRecipientCorrection,
    command,
  };
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
  workId?: string;
  workInputId?: string;
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
  if (params.threadId && !existing) throw new Error("conversation_thread_not_found");
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
    workId: params.workId,
    workInputId: params.workInputId,
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
    throughSequence: appended.message.sequence,
  });
  if (!loaded) throw new Error("conversation_thread_not_found");

  const history: EmployeeConversationMessage[] = [];
  const { expressions, negatedQualifiedNames, recipientConflict, command } = parseNamedExpressions(params.instruction);
  const consequential = CONSEQUENTIAL.test(command) && !isReadOnlyConversationQuestion(command.replaceAll("\0", " "));
  const named = recipientConflict ? [] : expressions;
  const needsRecipientClarification = (expression: NamedExpression) =>
    expression.cue === "party" && !expression.organization && negatedQualifiedNames.has(normalizePartyName(expression.name));
  for (const expression of named.filter((row) => row.cue === "history")) {
    const rows = await searchEmployeeConversationMessages({
      tenantId: params.ctx.tenantId,
      ownerEmployeeId: employeeId,
      query: expression.name,
      threadId: thread.id,
      limit: 10,
      throughSequence: appended.message.sequence,
    });
    for (const row of rows) if (!history.some((candidate) => candidate.id === row.id)) history.push(row);
  }

  const activeContext = record(params.activeContext);
  const rawExplicit = [
    ...(activeContext.businessRoot ? [activeContext.businessRoot] : []),
    ...(Array.isArray(activeContext.selectedEntities) ? activeContext.selectedEntities : []),
    ...(activeContext.focusedEntity ? [activeContext.focusedEntity] : []),
  ];
  const explicit = rawExplicit.flatMap((value) => {
    const ref = validReference(value, "explicit_context");
    return ref ? [ref] : [];
  });
  const carried = loaded.thread.activeReferences.flatMap((value) => {
    if (typeof value.mentionedAtSequence !== "number" || value.mentionedAtSequence >= appended.message.sequence) return [];
    const ref = validReference(value, "thread");
    return ref ? [ref] : [];
  });

  const partyCandidates: ConversationReference[] = [];
  const resolvedParties: ConversationReference[] = [];
  const unresolvedExpressions: string[] = consequential && recipientConflict ? ["outreach recipient"] : [];
  const trace: ConversationResolutionProvenance[] = [];
  for (const expression of named) {
    if (needsRecipientClarification(expression)) {
      unresolvedExpressions.push(expression.name);
      continue;
    }
    const resolution = await resolveParty(
      params.ctx.tenantId,
      { query: expression.organization ? `${expression.name} ${expression.organization}` : expression.name },
      { requesterEmployeeId: employeeId, workId: params.workId },
    );
    const resolved = resolution.status === "resolved" ? resolution.party : null;
    for (const candidate of resolution.candidates) {
      const ref = partyRefToCanonicalEntityRef(candidate.ref);
      const reference: ConversationReference = {
        ...ref,
        label: candidate.displayName,
        source: expression.cue === "history" ? "history_search" : "company_twin",
        currentTruthAsOf: new Date().toISOString(),
      };
      partyCandidates.push(reference);
      trace.push(provenance("company_twin", "active_party_directory", "candidate", key(reference)));
      if (resolved?.ref.partyType === candidate.ref.partyType && resolved.ref.partyId === candidate.ref.partyId) {
        resolvedParties.push(reference);
      }
    }
    if (resolution.status !== "resolved") unresolvedExpressions.push(expression.name);
  }

  const unique = <T extends ConversationReference>(rows: T[]) =>
    [...new Map(rows.map((row) => [key(row), row])).values()];
  const selected = recipientConflict ? [] : unique([...explicit, ...resolvedParties]);
  const candidates = unique([...explicit, ...partyCandidates, ...carried]);
  if (!recipientConflict && PRONOUN.test(command) && explicit.length === 0) {
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
      ? recipientConflict ? "Who should receive this?" : `Which active target do you mean for ${unresolved[0]}?`
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
    throughSequence: appended.message.sequence,
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
    messageLimit: 200,
    throughSequence: appended.message.sequence,
  });
  if (!refreshed) throw new Error("conversation_thread_not_found");

  const prepared: PreparedEmployeeConversationTurn = {
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
  prepared.context = await hydrateConversationMemory({ tenantId: params.ctx.tenantId, input: prepared.userMessage, context: prepared.context });
  try {
    await scheduleConversationCompaction({ tenantId: params.ctx.tenantId, ownerEmployeeId: employeeId, threadId: thread.id, throughSequence: appended.message.sequence });
  } catch (error) {
    logWithTrace({ tenantId: params.ctx.tenantId, threadId: thread.id }).warn({ errorKind: error instanceof Error ? error.name : "unknown" }, "Conversation compaction scheduling failed; original source retained");
  }
  return prepared;
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
  /** Non-sensitive stand-in REQUIRED for outcome-bearing turns (R1). */
  referenceText?: string;
}): Promise<EmployeeConversationMessage> {
  if (params.outcomeRefs.length > 0 && !params.referenceText?.trim())
    throw new Error("Outcome-bearing assistant turns persist a non-sensitive reference, never the financial prose (R1)");
  const storedText = params.outcomeRefs.length > 0 ? params.referenceText!.trim() : params.text;
  const appended = await appendEmployeeConversationMessage({
    tenantId: params.tenantId,
    ownerEmployeeId: params.employeeId,
    threadId: params.threadId,
    role: "assistant",
    channel: params.channel,
    originalText: storedText,
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
    content: storedText,
    createdAt: appended.message.createdAt,
  });
  return appended.message;
}
