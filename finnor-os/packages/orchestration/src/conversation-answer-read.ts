import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, type LoadedEmployeeConversationThread } from "@finnor/db";
import { FinancialExplanationSchema, type TenantContext } from "@finnor/shared-types";
import { validateBeliefViewPin } from "../../private-equity/src/enterprise-beliefs";
import { PeDomainError } from "@finnor/private-equity/src/types";

const Pin = z.object({
  tenantId: z.uuid(), principalId: z.uuid(),
  root: z.object({ entityType: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), entityId: z.uuid() }).strict(),
  validAt: z.iso.datetime({ offset: true }), knowledgeAt: z.iso.datetime({ offset: true }),
  dependencyDigest: z.string().regex(/^[a-f0-9]{64}$/), rightsRevision: z.number().int().positive(),
  interpretationVersion: z.string().min(1).max(200),
}).strict();
const Witness = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("supplied_financial"), instructionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("canonical_analysis"), pin: Pin }).strict(),
]);
const Answer = z.object({
  kind: z.literal("answer"), readOnly: z.literal(true), intent: z.string(),
  spokenSummary: z.string().min(1).max(60_000), readback: Witness,
  analysis: FinancialExplanationSchema.optional(),
});
const Outcome = z.object({ kind: z.literal("answer"), spokenSummary: z.string(), answer: Answer });

async function currentAnswer(ctx: TenantContext, candidate: { instruction_text: string; final_outcome: unknown },
  client: PoolClient, pins: Map<string, boolean>): Promise<string | null> {
  const parsed = Outcome.safeParse(candidate.final_outcome);
  if (!parsed.success) return null;
  const { answer, spokenSummary } = parsed.data;
  if (answer.spokenSummary !== spokenSummary || Buffer.byteLength(spokenSummary) > 60_000) return null;
  const witness = answer.readback;
  if (witness.kind === "supplied_financial") {
    if (answer.intent !== "conversation" || !answer.analysis
      || witness.instructionDigest !== createHash("sha256").update(candidate.instruction_text).digest("hex")) return null;
  } else {
    if (answer.intent !== "pe_world_state") return null;
    const key = JSON.stringify(witness.pin);
    if (!pins.has(key)) pins.set(key, (await validateBeliefViewPin({ auth: ctx }, witness.pin, client,
      { recordExperience: false })).status === "CURRENT");
    if (!pins.get(key)) return null;
  }
  return spokenSummary;
}

export function isPrivateAnalysisAnswer(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const answer = value as Record<string, unknown>;
  return answer.analysis !== undefined || answer.readback !== undefined || answer.intent === "pe_world_state";
}

/** All retained private-answer surfaces validate the exact same accepted Work
 * answer. A missing witness cannot turn a financial reply into generic replay. */
export async function assertPrivateAnswerReadAccess(ctx: TenantContext, value: unknown,
  input: { workId: string; workInputId?: string; instructionId?: string }): Promise<void> {
  if (!isPrivateAnalysisAnswer(value)) return;
  const principal = ctx.employeeId ?? ctx.userId;
  const permitted = await withTenantTransaction(ctx.tenantId,
    { userId: principal, isolation: "repeatable read", readOnly: true }, async (_db, client) => {
      const rows = await client.query<{ instruction_text: string; final_outcome: unknown }>(`
        SELECT i.instruction_text,w.final_outcome
        FROM finnor_os.works w
        JOIN finnor_os.users u ON u.tenant_id=w.tenant_id AND u.id=$2 AND u.status='active'
        JOIN LATERAL (SELECT latest.* FROM finnor_os.work_inputs latest
          WHERE latest.tenant_id=w.tenant_id AND latest.work_id=w.id
          ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) i ON i.created_by=u.id
        JOIN finnor_os.instruction_sessions s ON s.tenant_id=i.tenant_id AND s.id=i.instruction_id
          AND s.work_id=w.id AND s.user_id=u.id
        WHERE w.tenant_id=$1 AND w.id=$3 AND w.status='completed'
          AND ($4::uuid IS NULL OR i.id=$4) AND ($5::uuid IS NULL OR i.instruction_id=$5)
          AND (w.created_by=u.id OR w.current_owner_id=u.id OR w.assigned_to=u.id)
          AND octet_length(w.final_outcome::text)<=1048576
          AND NOT EXISTS (SELECT 1 FROM finnor_os.instruction_events e
            WHERE e.tenant_id=s.tenant_id AND e.instruction_id=s.id AND e.phase='cancelled'
              AND (jsonb_typeof(e.payload->'actionId') IS DISTINCT FROM 'string'
                OR e.payload @> '{"fence":true}'::jsonb OR e.payload @> '{"canonical":true}'::jsonb))`,
      [ctx.tenantId, principal, input.workId, input.workInputId ?? null, input.instructionId ?? null]);
      const row = rows.rows[0];
      if (!row || !row.final_outcome || typeof row.final_outcome !== "object"
        || !isDeepStrictEqual((row.final_outcome as Record<string, unknown>).answer, value)) return false;
      return (await currentAnswer(ctx, row, client, new Map())) !== null;
    });
  if (!permitted) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "The original answer is unavailable under current source and permissions");
}

/** Presentation only: no private prose is written back to conversation/memory.
 * One PostgreSQL snapshot binds current access, exact active input and source
 * validation. Identical pins share work only inside this read transaction. */
export async function hydrateEmployeeConversationAnswers(
  ctx: TenantContext, loaded: LoadedEmployeeConversationThread, signal?: AbortSignal,
): Promise<LoadedEmployeeConversationThread> {
  const principal = ctx.employeeId ?? ctx.userId;
  const ids = loaded.messages.filter(message => message.role === "assistant" && message.workId
    && message.workInputId && message.instructionId && message.outcomeRefs.length > 0).map(message => message.id);
  if (!ids.length) return loaded;
  if (loaded.messages.length > 200 || !z.uuid().safeParse(principal).success) throw new Error("Invalid private Thread read scope");
  const summaries = await withTenantTransaction(ctx.tenantId,
    { userId: principal, isolation: "repeatable read", readOnly: true }, async (_db, client) => {
      const candidates = await client.query<{ id: string; instruction_text: string; final_outcome: unknown }>(`
        SELECT m.id,i.instruction_text,jsonb_build_object(
          'kind',w.final_outcome->'kind','spokenSummary',w.final_outcome->'spokenSummary',
          'answer',jsonb_strip_nulls(jsonb_build_object(
            'kind',w.final_outcome #> '{answer,kind}','readOnly',w.final_outcome #> '{answer,readOnly}',
            'intent',w.final_outcome #> '{answer,intent}','spokenSummary',w.final_outcome #> '{answer,spokenSummary}',
            'readback',w.final_outcome #> '{answer,readback}','analysis',w.final_outcome #> '{answer,analysis}'
          ))) AS final_outcome
        FROM finnor_os.employee_conversation_messages m
        JOIN finnor_os.employee_conversation_threads t
          ON t.tenant_id=m.tenant_id AND t.id=m.thread_id AND t.owner_employee_id=m.owner_employee_id
        JOIN finnor_os.users u ON u.tenant_id=m.tenant_id AND u.id=m.owner_employee_id AND u.status='active'
        JOIN finnor_os.works w ON w.tenant_id=m.tenant_id AND w.id=m.work_id AND w.status='completed'
        JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id AND i.id=m.work_input_id
          AND i.instruction_id=m.instruction_id AND i.created_by=u.id
        JOIN finnor_os.instruction_sessions s ON s.tenant_id=i.tenant_id AND s.id=i.instruction_id
          AND s.work_id=w.id AND s.user_id=u.id
        JOIN LATERAL (SELECT latest.id FROM finnor_os.work_inputs latest
          WHERE latest.tenant_id=w.tenant_id AND latest.work_id=w.id
          ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) current_input ON current_input.id=i.id
        WHERE m.tenant_id=$1 AND m.thread_id=$2 AND m.owner_employee_id=$3 AND m.id=ANY($4::uuid[])
          AND m.role='assistant' AND (w.created_by=u.id OR w.current_owner_id=u.id OR w.assigned_to=u.id)
          AND octet_length(w.final_outcome #>> '{answer,spokenSummary}') BETWEEN 1 AND 60000
          AND NOT EXISTS (SELECT 1 FROM finnor_os.instruction_events e
            WHERE e.tenant_id=s.tenant_id AND e.instruction_id=s.id AND e.phase='cancelled'
              AND (jsonb_typeof(e.payload->'actionId') IS DISTINCT FROM 'string'
                OR e.payload @> '{"fence":true}'::jsonb OR e.payload @> '{"canonical":true}'::jsonb))`,
      [ctx.tenantId, loaded.thread.id, principal, ids]);
      const result = new Map<string, string>(), pins = new Map<string, boolean>();
      for (const candidate of candidates.rows) {
        signal?.throwIfAborted();
        const summary = await currentAnswer(ctx, candidate, client, pins);
        if (summary !== null) result.set(candidate.id, summary);
      }
      return result;
    });
  signal?.throwIfAborted();
  return { ...loaded, messages: loaded.messages.map(message => {
    const summary = summaries.get(message.id);
    return summary === undefined ? message : { ...message, originalText: summary, hydratedText: summary };
  }) };
}
