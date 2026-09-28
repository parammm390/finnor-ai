import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import {
  ConversationThreadSummarySchema,
  LoadedConversationThreadSchema,
  type ConversationThreadSummary,
  type LoadedConversationThread,
} from "./thread-contract"

export async function listInvestigations(limit = 30): Promise<ConversationThreadSummary[]> {
  const response = await centropyGet<unknown>("threads", { limit: String(limit) })
  return ConversationThreadSummarySchema.array().parse((response as { threads?: unknown })?.threads)
}

export async function createInvestigation(title?: string): Promise<ConversationThreadSummary> {
  const response = await centropyPost<unknown>("threads", title ? { title } : {})
  return ConversationThreadSummarySchema.parse((response as { thread?: unknown })?.thread)
}

export async function loadInvestigation(
  threadId: string,
  options: { limit?: number; beforeSequence?: number } = {},
): Promise<LoadedConversationThread> {
  const params: Record<string, string> = { limit: String(options.limit ?? 100) }
  if (options.beforeSequence) params.beforeSequence = String(options.beforeSequence)
  const response = await centropyGet<unknown>(`threads/${threadId}`, params)
  return LoadedConversationThreadSchema.parse(response)
}
