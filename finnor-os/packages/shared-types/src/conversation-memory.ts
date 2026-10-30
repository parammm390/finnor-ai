import { z } from "zod";

export const ConversationMemorySourceSchema = z.object({
  messageId: z.uuid(),
  sequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  quote: z.string().min(1).max(4096),
  recordedAt: z.iso.datetime({ offset: true }),
});
export const ConversationMemoryItemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["goal", "constraint", "correction", "decision", "open_question", "artifact", "resolution", "context", "assistant_proposal"]),
  subject: z.string().min(1).max(240),
  statement: z.string().min(1).max(2000),
  sources: z.array(ConversationMemorySourceSchema).min(1).max(8),
  supersededBy: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export const ConversationMemoryCheckpointSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  tenantId: z.uuid(),
  ownerEmployeeId: z.uuid(),
  threadId: z.uuid(),
  parentId: z.uuid().nullable(),
  fromSequence: z.number().int().positive(),
  throughSequence: z.number().int().positive(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(ConversationMemoryItemSchema).max(2048),
  narrative: z.string().max(16000),
  validation: z.object({
    provenance: z.literal("exact_source_checked"),
    semantic: z.literal("model_reviewed"),
    producer: z.string().min(1),
    reviewer: z.string().min(1),
  }),
});
export const ConversationMemoryBindingSchema = z.object({
  version: z.literal(1),
  ownerEmployeeId: z.uuid(),
  threadId: z.uuid(),
  inputMessageId: z.uuid(),
  throughSequence: z.number().int().positive(),
});
export type ConversationMemoryItem = z.infer<typeof ConversationMemoryItemSchema>;
export type ConversationMemoryCheckpoint = z.infer<typeof ConversationMemoryCheckpointSchema>;
export type ConversationMemoryBinding = z.infer<typeof ConversationMemoryBindingSchema>;
