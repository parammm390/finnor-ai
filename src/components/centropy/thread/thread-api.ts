import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import { z } from "zod"
import {
  ConversationThreadSummarySchema,
  LoadedConversationThreadSchema,
  type ConversationThreadSummary,
  type LoadedConversationThread,
} from "./thread-contract"

const InvestigationPageSchema = z.object({
  threads: ConversationThreadSummarySchema.array(),
  nextCursor: z.string().max(512).nullable(),
})

export async function listInvestigationPage(limit = 30, cursor?: string) {
  const response = await centropyGet<unknown>("threads", { limit: String(limit), ...(cursor === undefined ? {} : { cursor }) })
  return InvestigationPageSchema.parse(response)
}

/** Legacy first-page consumer; older Investigations use the cursor API above. */
export async function listInvestigations(limit = 30): Promise<ConversationThreadSummary[]> {
  return (await listInvestigationPage(limit)).threads
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
