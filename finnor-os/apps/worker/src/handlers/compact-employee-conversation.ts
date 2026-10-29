import type { JobHandler } from "../queue";
import { compactEmployeeConversation, ConversationCompactionJobSchema } from "@finnor/orchestration";

export const compactEmployeeConversationJob: JobHandler = async (payload, execution) => {
  const input = ConversationCompactionJobSchema.parse(payload);
  if (execution && input.tenantId !== execution.tenantId) throw new Error("conversation_compaction_job_scope_mismatch");
  await compactEmployeeConversation(input);
};
