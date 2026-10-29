import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { ConversationMemoryCheckpointSchema, type ConversationMemoryCheckpoint, type EmployeeConversationMessage } from "@finnor/shared-types";
import { conversationMessage, schema, withTenant } from "./index";

export interface PrivateConversationCut {
  tenantId: string;
  ownerEmployeeId: string;
  threadId: string;
  throughSequence: number;
}

export function conversationSourceDigest(messages: readonly EmployeeConversationMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(({ id, sequence, role, originalText }) =>
    ({ id, sequence, role, originalText })))).digest("hex");
}

export async function readConversationMessages(cut: PrivateConversationCut & { afterSequence?: number; limit?: number }): Promise<EmployeeConversationMessage[]> {
  const limit = Math.max(1, Math.min(cut.limit ?? 200, 200));
  return withTenant(cut.tenantId, async db => {
    const rows = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.tenantId, cut.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, cut.ownerEmployeeId),
      eq(schema.employeeConversationMessages.threadId, cut.threadId),
      gte(schema.employeeConversationMessages.sequence, (cut.afterSequence ?? 0) + 1),
      lte(schema.employeeConversationMessages.sequence, cut.throughSequence),
    )).orderBy(asc(schema.employeeConversationMessages.sequence)).limit(limit);
    return rows.map(conversationMessage);
  }, cut.ownerEmployeeId);
}

export async function readConversationCheckpoint(cut: PrivateConversationCut): Promise<ConversationMemoryCheckpoint | null> {
  return withTenant(cut.tenantId, async db => {
    const result = await db.execute(sql`SELECT state FROM finnor_os.employee_conversation_checkpoints
      WHERE tenant_id=${cut.tenantId} AND owner_employee_id=${cut.ownerEmployeeId} AND thread_id=${cut.threadId}
        AND through_sequence<=${cut.throughSequence} ORDER BY through_sequence DESC LIMIT 1`);
    const rows = z.array(z.object({ state: ConversationMemoryCheckpointSchema })).parse(result.rows);
    return rows[0]?.state ?? null;
  }, cut.ownerEmployeeId);
}

/** Rechecks original bytes and ownership under a short publication lock. No model call holds this lock. */
export async function publishConversationCheckpoint(candidate: ConversationMemoryCheckpoint): Promise<boolean> {
  const checkpoint = ConversationMemoryCheckpointSchema.parse(candidate);
  return withTenant(checkpoint.tenantId, async db => {
    const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(and(
      eq(schema.users.id, checkpoint.ownerEmployeeId), eq(schema.users.tenantId, checkpoint.tenantId),
      eq(schema.users.status, "active"), eq(schema.users.role, "owner"),
    )).limit(1).for("share");
    if (!owner) throw new Error("conversation_owner_not_active");
    const [thread] = await db.select({ id: schema.employeeConversationThreads.id }).from(schema.employeeConversationThreads).where(and(
      eq(schema.employeeConversationThreads.id, checkpoint.threadId),
      eq(schema.employeeConversationThreads.tenantId, checkpoint.tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, checkpoint.ownerEmployeeId),
    )).limit(1).for("update");
    if (!thread) throw new Error("conversation_thread_not_found");
    const previousResult = await db.execute(sql`SELECT state FROM finnor_os.employee_conversation_checkpoints
      WHERE tenant_id=${checkpoint.tenantId} AND owner_employee_id=${checkpoint.ownerEmployeeId}
        AND thread_id=${checkpoint.threadId} ORDER BY through_sequence DESC LIMIT 1`);
    const previous = z.array(z.object({ state: ConversationMemoryCheckpointSchema })).parse(previousResult.rows)[0]?.state;
    if ((previous?.id ?? null) !== checkpoint.parentId) return false;
    if (checkpoint.fromSequence !== (previous?.throughSequence ?? 0) + 1) throw new Error("conversation_checkpoint_gap");
    const sourceRows = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.tenantId, checkpoint.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, checkpoint.ownerEmployeeId),
      eq(schema.employeeConversationMessages.threadId, checkpoint.threadId),
      gte(schema.employeeConversationMessages.sequence, checkpoint.fromSequence),
      lte(schema.employeeConversationMessages.sequence, checkpoint.throughSequence),
    )).orderBy(asc(schema.employeeConversationMessages.sequence)).limit(201);
    const messages = sourceRows.map(conversationMessage);
    if (messages.length !== checkpoint.throughSequence - checkpoint.fromSequence + 1
      || messages.length > 200 || conversationSourceDigest(messages) !== checkpoint.sourceDigest) {
      throw new Error("conversation_checkpoint_source_changed");
    }
    const ids = new Set(checkpoint.items.map(item => item.id));
    if (ids.size !== checkpoint.items.length) throw new Error("conversation_checkpoint_duplicate_item");
    for (const prior of previous?.items ?? []) {
      const retained = checkpoint.items.find(item => item.id === prior.id);
      if (!retained || JSON.stringify({ ...retained, supersededBy: prior.supersededBy }) !== JSON.stringify(prior)) {
        throw new Error("conversation_checkpoint_retained_item_changed");
      }
      if (prior.supersededBy !== null && retained.supersededBy !== prior.supersededBy) throw new Error("conversation_checkpoint_supersession_changed");
      if (retained.supersededBy !== prior.supersededBy) {
        const correction = checkpoint.items.find(item => item.id === retained.supersededBy && (item.kind === "correction" || item.kind === "resolution"));
        if (!correction || correction.sources.some(source => source.role !== "user"
          || source.sequence <= Math.max(...prior.sources.map(old => old.sequence)))) {
          throw new Error("conversation_checkpoint_supersession_invalid");
        }
      }
    }
    const oldIds = new Set((previous?.items ?? []).map(item => item.id));
    for (const item of checkpoint.items.filter(candidate => !oldIds.has(candidate.id))) {
      if (item.supersededBy !== null) {
        const correction = checkpoint.items.find(candidate => candidate.id === item.supersededBy && (candidate.kind === "correction" || candidate.kind === "resolution"));
        if (!correction || correction.sources.some(source => source.role !== "user"
          || source.sequence <= Math.max(...item.sources.map(old => old.sequence)))) {
          throw new Error("conversation_checkpoint_supersession_invalid");
        }
      }
      for (const support of item.sources) {
        const message = messages.find(candidate => candidate.id === support.messageId);
        if (!message || message.role !== support.role || message.sequence !== support.sequence || message.createdAt !== support.recordedAt
          || !message.originalText.includes(support.quote)) throw new Error("conversation_checkpoint_quote_invalid");
        if (item.kind !== "context" && item.kind !== "assistant_proposal" && message.role !== "user") {
          throw new Error("conversation_checkpoint_assistant_promotion");
        }
      }
    }
    await db.execute(sql`INSERT INTO finnor_os.employee_conversation_checkpoints
      (id,tenant_id,owner_employee_id,thread_id,parent_id,from_sequence,through_sequence,source_digest,state)
      VALUES(${checkpoint.id},${checkpoint.tenantId},${checkpoint.ownerEmployeeId},${checkpoint.threadId},
        ${checkpoint.parentId},${checkpoint.fromSequence},${checkpoint.throughSequence},${checkpoint.sourceDigest},${JSON.stringify(checkpoint)}::jsonb)`);
    await db.update(schema.employeeConversationThreads).set({
      summary: checkpoint.narrative, summaryThroughSequence: checkpoint.throughSequence, updatedAt: new Date(),
    }).where(eq(schema.employeeConversationThreads.id, checkpoint.threadId));
    return true;
  }, checkpoint.ownerEmployeeId);
}

export async function findWorkInputConversation(params: { tenantId: string; workId: string; workInputId: string; ownerEmployeeId: string }) {
  return withTenant(params.tenantId, async db => {
    const [row] = await db.select({ message: schema.employeeConversationMessages, input: schema.workInputs }).from(schema.employeeConversationMessages)
      .innerJoin(schema.workInputs, and(eq(schema.workInputs.id, schema.employeeConversationMessages.workInputId),
        eq(schema.workInputs.tenantId, schema.employeeConversationMessages.tenantId))).where(and(
        eq(schema.employeeConversationMessages.tenantId, params.tenantId),
        eq(schema.employeeConversationMessages.ownerEmployeeId, params.ownerEmployeeId),
        eq(schema.employeeConversationMessages.workId, params.workId),
        eq(schema.workInputs.id, params.workInputId), eq(schema.workInputs.workId, params.workId),
        eq(schema.workInputs.createdBy, params.ownerEmployeeId), eq(schema.employeeConversationMessages.role, "user"),
      )).limit(1);
    return row ? conversationMessage(row.message) : null;
  }, params.ownerEmployeeId);
}

/** General private search uses OR-ranked terms; names and IDs do not need a special history phrase. */
export async function searchConversationEvidence(cut: PrivateConversationCut & { terms: string[]; limit?: number }): Promise<EmployeeConversationMessage[]> {
  const terms = [...new Set(cut.terms.flatMap(term => term.toLocaleLowerCase().match(/[\p{L}\p{N}_@.-]{2,100}/gu) ?? []))].slice(0, 32);
  if (!terms.length) return [];
  const query = terms.map(term => "'" + term.replaceAll("'", "''") + "'").join(" | ");
  return withTenant(cut.tenantId, async db => {
    const document = sql`to_tsvector('simple',${schema.employeeConversationMessages.originalText})`;
    const tsquery = sql`to_tsquery('simple',${query})`;
    const rows = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.tenantId, cut.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, cut.ownerEmployeeId),
      eq(schema.employeeConversationMessages.threadId, cut.threadId),
      lte(schema.employeeConversationMessages.sequence, cut.throughSequence),
      sql`${document} @@ ${tsquery}`,
    )).orderBy(sql`ts_rank_cd(${document},${tsquery}) DESC`, desc(schema.employeeConversationMessages.sequence))
      .limit(Math.max(1, Math.min(cut.limit ?? 12, 40)));
    return rows.map(conversationMessage);
  }, cut.ownerEmployeeId);
}
