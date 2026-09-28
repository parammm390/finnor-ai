import { z } from "zod"

const Reference = z.record(z.unknown())

export const ConversationMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  sequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  channel: z.enum(["text", "voice", "console"]),
  originalText: z.string(),
  instructionId: z.string().uuid().nullable(),
  workId: z.string().uuid().nullable(),
  workInputId: z.string().uuid().nullable(),
  resolutionSnapshot: Reference.nullable(),
  resolutionProvenance: z.array(Reference),
  companyTruthSnapshot: Reference.nullable(),
  outcomeRefs: z.array(Reference),
  createdAt: z.string().datetime(),
})

export const ConversationThreadSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  activeWorkId: z.string().uuid().nullable(),
  activeObjectiveLoopId: z.string().uuid().nullable(),
  lastActivityAt: z.string().datetime(),
  createdAt: z.string().datetime(),
})

export const LoadedConversationThreadSchema = z.object({
  thread: ConversationThreadSummarySchema.extend({
    summaryThroughSequence: z.number().int().nonnegative(),
    activeReferences: z.array(Reference),
    unresolvedReferences: z.array(Reference),
    outcomeRefs: z.array(Reference),
  }),
  messages: z.array(ConversationMessageSchema),
})

export type ConversationMessage = z.infer<typeof ConversationMessageSchema>
export type ConversationThreadSummary = z.infer<typeof ConversationThreadSummarySchema>
export type LoadedConversationThread = z.infer<typeof LoadedConversationThreadSchema>

/** The backend is conversation truth. Merge only pages of that truth, never draft UI turns. */
export function mergeConversationMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence)
}

export function earliestMessageSequence(messages: ConversationMessage[]): number | null {
  return messages.length ? Math.min(...messages.map((message) => message.sequence)) : null
}
