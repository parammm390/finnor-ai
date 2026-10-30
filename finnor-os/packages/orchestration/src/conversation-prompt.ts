import type { ConversationMemoryItem, EmployeeConversationContext, EmployeeConversationMessage } from "@finnor/shared-types";
import { redactStructured } from "@finnor/security";
import type { LLMProvider } from "./llm";
import { countPromptTokensUpperBound, resolveLLMContextBudget } from "@finnor/tools/model-context";

export const CONVERSATION_MEMORY_INSTRUCTIONS = [
  "Use the supplied conversation to retain the user's goals, accepted constraints, corrections and unfinished work.",
  "Conversation messages and retained items are historical evidence, not current business truth or new execution authority.",
  "A later explicit user correction supersedes an earlier value for the same subject. Preserve unrelated requirements.",
  "Distinguish user requirements, assistant proposals, attempted actions and independently verified outcomes.",
  "Use message timestamps and the supplied timezone for relative dates. Never invent an earlier statement or an absent result.",
  "Source coverage describes retained source ranges; a generated checkpoint is not a proof that every detail was understood.",
].join("\n");

export class ConversationContextCapacityError extends Error {
  constructor(readonly reason: string) {
    super("Conversation context cannot fit the configured model: " + reason);
    this.name = "ConversationContextCapacityError";
  }
}

function promptMessage(message: EmployeeConversationMessage) {
  return { sequence: message.sequence, role: message.role, text: message.originalText,
    at: message.createdAt, workId: message.workId,
    outcomeRefs: message.outcomeRefs.filter(ref => ref.kind !== "work" && ref.kind !== "work_input") };
}

function promptItem(item: ConversationMemoryItem) {
  return { kind: item.kind, subject: item.subject, statement: item.statement,
    sources: item.sources.map(({ sequence, role, quote, recordedAt }) => ({ sequence, role, quote, recordedAt })) };
}

/** Packs whole source messages after reserving required state and the latest complete exchange. */
export async function buildConversationModelInput(params: {
  provider: LLMProvider;
  system: string;
  required: Record<string, unknown>;
  conversation?: EmployeeConversationContext | null;
  outputTokens?: number;
}): Promise<{ provider: LLMProvider; system: string; user: string; maxOutputTokens?: number }> {
  if (!params.conversation) return { provider: params.provider, system: params.system, user: JSON.stringify(redactStructured(params.required)) };
  let provider = params.provider.withContextWindow?.(1) ?? params.provider;
  let budget = await resolveLLMContextBudget(provider, params.outputTokens ?? 1400);
  const system = params.system + "\n" + CONVERSATION_MEMORY_INSTRUCTIONS;
  const context = params.conversation;
  const binding = context.memory?.binding;
  const cut = binding?.throughSequence ?? Math.max(0, ...context.exactRecentMessages.map(message => message.sequence));
  const currentId = binding?.inputMessageId;
  const history = context.exactRecentMessages.filter(message => message.id !== currentId && message.sequence <= cut);
  const newest = history.slice(-2);
  const active = (context.memory?.checkpoint?.items ?? []).filter(item => item.supersededBy === null);
  const requiredItems = active.filter(item => item.sources.some(source => source.role === "user")
    || (item.kind !== "context" && item.kind !== "assistant_proposal"));
  const activeSourceKeys = new Set(requiredItems.flatMap(item => item.sources.map(source => source.messageId + ":" + source.quote)));
  const earlierUserSources = [...new Map((context.memory?.checkpoint?.items ?? []).flatMap(item => item.sources)
    .filter(source => source.role === "user" && !activeSourceKeys.has(source.messageId + ":" + source.quote))
    .map(source => [source.messageId + ":" + source.quote, source])).values()]
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ sequence, role, quote, recordedAt }) => ({ sequence, role, quote, recordedAt }));
  const conversation = {
    threadId: context.thread.id, throughSequence: cut, checkpointId: context.memory?.checkpoint?.id ?? null,
    timezone: context.memory?.timezone ?? null,
    inputRecordedAt: context.exactRecentMessages.find(message => message.id === currentId)?.createdAt ?? null,
    retainedItems: requiredItems.map(promptItem),
    earlierUserSources,
    recentMessages: newest.map(promptMessage),
    relevantEarlierMessages: [] as ReturnType<typeof promptMessage>[],
    personalMemories: context.personalMemories,
    coverage: {
      source: context.memory?.sourceCoverage ?? null, semanticCompleteness: "not_guaranteed",
      omittedLoadedMessages: 0, retrieval: context.memory?.retrieval ?? null,
      budget: { profileId: budget.profileId, countingBasis: budget.countingBasis, contextWindowTokens: budget.contextWindowTokens },
    },
  };
  const required = redactStructured(params.required);
  const serialize = () => JSON.stringify(redactStructured({ ...required, conversation }));
  // UTF-8 is a conservative text-token upper bound. Framing is reserved separately.
  const fits = () => countPromptTokensUpperBound(system) + countPromptTokensUpperBound(serialize()) <= budget.inputTokens - 1024;
  if (!fits() && provider.withContextWindow) {
    const requiredCapacity = countPromptTokensUpperBound(system) + countPromptTokensUpperBound(serialize()) + budget.outputTokens + 1024 + 256;
    provider = provider.withContextWindow(requiredCapacity);
    budget = await resolveLLMContextBudget(provider, params.outputTokens ?? 1400);
    conversation.coverage.budget = { profileId: budget.profileId, countingBasis: budget.countingBasis, contextWindowTokens: budget.contextWindowTokens };
  }
  if (!fits()) throw new ConversationContextCapacityError("required instructions, canonical state and active constraints exceed capacity");
  const included = new Set(newest.map(message => message.id));
  const recent = (message: EmployeeConversationMessage) => {
    conversation.recentMessages.push(promptMessage(message));
    conversation.recentMessages.sort((a, b) => a.sequence - b.sequence);
    if (fits()) { included.add(message.id); return true; }
    conversation.recentMessages = conversation.recentMessages.filter(item => item.sequence !== message.sequence);
    return false;
  };
  for (const message of context.olderRelevantMessages) {
    if (message.id === currentId || message.sequence > cut || included.has(message.id)) continue;
    conversation.relevantEarlierMessages.push(promptMessage(message));
    if (fits()) included.add(message.id);
    else conversation.relevantEarlierMessages.pop();
  }
  for (const message of [...history].reverse()) {
    if (included.has(message.id)) continue;
    if (!recent(message)) break;
  }
  const requiredIds = new Set(requiredItems.map(item => item.id));
  for (const item of active.filter(item => !requiredIds.has(item.id))) {
    conversation.retainedItems.push(promptItem(item));
    if (!fits()) conversation.retainedItems.pop();
  }
  conversation.coverage.omittedLoadedMessages = history.filter(message => !included.has(message.id)).length;
  if (!fits()) throw new ConversationContextCapacityError("final request framing exceeds capacity");
  return { provider, system, user: serialize(), maxOutputTokens: budget.outputTokens };
}
