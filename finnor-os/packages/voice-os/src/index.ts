// Core employee voice identity, session history, and action-bound confirmations.

import { withTenant, voiceIdentities, voiceSessions, voiceTurns, pendingConfirmations, handoffs, users } from "@finnor/db";
import { and, desc, eq, asc } from "drizzle-orm";
import { ingestMemory } from "@finnor/memory";

export type VoiceRole = "owner" | "unknown";

export interface VoiceIdentity {
  id: string;
  tenantId: string;
  phoneNumber: string;
  matchedUserId: string | null;
  role: VoiceRole;
}

/**
 * Resolves only an active owner identity. Historical Water caller associations stay
 * stored for replay, but they never confer active authority.
 */
export async function resolveVoiceIdentity(tenantId: string, phoneNumber: string): Promise<VoiceIdentity> {
  return withTenant(tenantId, async (db) => {
    const [existing] = await db
      .select()
      .from(voiceIdentities)
      .where(and(eq(voiceIdentities.tenantId, tenantId), eq(voiceIdentities.phoneNumber, phoneNumber)));
    if (existing) {
      const [matchedEmployee] = existing.matchedUserId
        ? await db.select({ id: users.id, role: users.role, status: users.status }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, existing.matchedUserId))).limit(1)
        : [];
      const activeOwner = matchedEmployee?.status === "active" && matchedEmployee.role === "owner";
      await db.update(voiceIdentities).set({ lastSeenAt: new Date() }).where(eq(voiceIdentities.id, existing.id));
      return {
        id: existing.id,
        tenantId,
        phoneNumber,
        matchedUserId: activeOwner ? matchedEmployee.id : null,
        role: activeOwner ? "owner" : "unknown",
      };
    }

    const [phoneEmployee] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.tenantId, tenantId),
        eq(users.phoneNumber, phoneNumber),
        eq(users.status, "active"),
        eq(users.role, "owner"),
      ))
      .limit(1);
    const matchedUserId = phoneEmployee?.id ?? null;
    const role: VoiceRole = matchedUserId ? "owner" : "unknown";
    const [created] = await db
      .insert(voiceIdentities)
      .values({ tenantId, phoneNumber, matchedUserId, role })
      .onConflictDoNothing({ target: [voiceIdentities.tenantId, voiceIdentities.phoneNumber] })
      .returning();
    if (created) {
      return {
        id: created.id,
        tenantId,
        phoneNumber,
        matchedUserId: created.matchedUserId,
        role,
      };
    }
    // Lost an insert race to a concurrent call from the same number — re-select.
    const [raced] = await db
      .select()
      .from(voiceIdentities)
      .where(and(eq(voiceIdentities.tenantId, tenantId), eq(voiceIdentities.phoneNumber, phoneNumber)));
    return {
      id: raced!.id,
      tenantId,
      phoneNumber,
      matchedUserId: raced!.role === "owner" ? raced!.matchedUserId : null,
      role: raced!.role === "owner" ? "owner" : "unknown",
    };
  });
}

export interface VoiceSession {
  id: string;
  tenantId: string;
  voiceIdentityId: string | null;
}

/** Idempotent by callExternalId — a live call's repeated tool-calls messages all
 *  reuse the same session row rather than opening a new one per message. */
export async function openVoiceSession(
  tenantId: string,
  callExternalId: string,
  voiceIdentityId?: string,
  employeeId?: string,
  authorityContext?: Record<string, unknown>,
): Promise<VoiceSession> {
  return withTenant(tenantId, async (db) => {
    const [existing] = await db.select().from(voiceSessions).where(eq(voiceSessions.callExternalId, callExternalId));
    if (existing) {
      if (voiceIdentityId && !existing.voiceIdentityId) {
        await db.update(voiceSessions).set({ voiceIdentityId, employeeId: employeeId ?? existing.employeeId, authorityContext: authorityContext ?? existing.authorityContext }).where(eq(voiceSessions.id, existing.id));
      }
      return { id: existing.id, tenantId, voiceIdentityId: voiceIdentityId ?? existing.voiceIdentityId };
    }
    const [created] = await db
      .insert(voiceSessions)
      .values({ tenantId, callExternalId, voiceIdentityId: voiceIdentityId ?? null, employeeId: employeeId ?? null, authorityContext: authorityContext ?? {} })
      .onConflictDoNothing({ target: voiceSessions.callExternalId })
      .returning();
    if (created) return { id: created.id, tenantId, voiceIdentityId: created.voiceIdentityId };
    const [raced] = await db.select().from(voiceSessions).where(eq(voiceSessions.callExternalId, callExternalId));
    return { id: raced!.id, tenantId, voiceIdentityId: raced!.voiceIdentityId };
  });
}

export async function closeVoiceSession(tenantId: string, sessionId: string): Promise<void> {
  await withTenant(tenantId, (db) =>
    db.update(voiceSessions).set({ status: "ended", endedAt: new Date() }).where(eq(voiceSessions.id, sessionId)),
  );
  await ingestCallTranscript(tenantId, sessionId).catch((err) =>
    console.error(`[memory] transcript auto-ingest failed for voice session ${sessionId}`, err),
  );
}

/** §5.2: auto-ingests the whole call as one semantic-memory document at close — a
 *  transcript is naturally a per-call unit, not per-turn (chunkText still splits it
 *  further if it runs long). Best-effort: a memory-layer failure must never affect the
 *  call itself, which has already ended by the time this runs. Exported (not just
 *  called from closeVoiceSession) so controlled history tooling can re-ingest
 *  already-ended sessions without duplicating this logic. */
export async function ingestCallTranscript(tenantId: string, sessionId: string): Promise<number> {
  const turns = await withTenant(tenantId, (db) =>
    db
      .select({ role: voiceTurns.role, transcriptText: voiceTurns.transcriptText })
      .from(voiceTurns)
      .where(eq(voiceTurns.voiceSessionId, sessionId))
      .orderBy(asc(voiceTurns.sequence)),
  );
  if (turns.length === 0) return 0;
  const text = turns.map((t) => `${t.role}: ${t.transcriptText}`).join("\n");
  return ingestMemory({
    tenantId,
    sourceDocId: `voice_session:${sessionId}`,
    text,
    entityRefs: [{ type: "voice_session", id: sessionId }],
    sourceKind: "voice_transcript",
    provenance: { voiceSessionId: sessionId },
  });
}

export async function appendVoiceTurn(params: {
  tenantId: string;
  voiceSessionId: string;
  role: "caller" | "assistant";
  transcriptText: string;
  resolvedActionIds?: string[];
}): Promise<void> {
  await withTenant(params.tenantId, async (db) => {
    const [last] = await db
      .select({ sequence: voiceTurns.sequence })
      .from(voiceTurns)
      .where(eq(voiceTurns.voiceSessionId, params.voiceSessionId))
      .orderBy(desc(voiceTurns.sequence))
      .limit(1);
    await db.insert(voiceTurns).values({
      tenantId: params.tenantId,
      voiceSessionId: params.voiceSessionId,
      sequence: (last?.sequence ?? 0) + 1,
      role: params.role,
      transcriptText: params.transcriptText,
      resolvedActionIds: params.resolvedActionIds ?? [],
    });
  });
}

export async function createPendingConfirmation(params: {
  tenantId: string;
  voiceSessionId: string;
  domainActionId: string;
  promptText: string;
}): Promise<{ id: string }> {
  const [row] = await withTenant(params.tenantId, (db) =>
    db
      .insert(pendingConfirmations)
      .values({
        tenantId: params.tenantId,
        voiceSessionId: params.voiceSessionId,
        domainActionId: params.domainActionId,
        promptText: params.promptText,
      })
      .returning({ id: pendingConfirmations.id }),
  );
  return { id: row!.id };
}

/**
 * Resolves this session's own OPEN pending_confirmations — never the tenant's
 * newest-pending domain_actions. This is the fix for the cross-caller/cross-session
 * bug: a "yes" only ever applies to what THIS call's own instruction actually drafted.
 */
export async function resolveOpenConfirmations(
  tenantId: string,
  voiceSessionId: string,
): Promise<Array<{ id: string; domainActionId: string }>> {
  const rows = await withTenant(tenantId, (db) =>
    db
      .select({ id: pendingConfirmations.id, domainActionId: pendingConfirmations.domainActionId })
      .from(pendingConfirmations)
      .where(and(eq(pendingConfirmations.voiceSessionId, voiceSessionId), eq(pendingConfirmations.status, "awaiting"))),
  );
  return rows;
}

export async function markConfirmationsResolved(
  tenantId: string,
  confirmationIds: string[],
  decision: "confirmed" | "rejected",
): Promise<void> {
  if (confirmationIds.length === 0) return;
  await withTenant(tenantId, async (db) => {
    for (const id of confirmationIds) {
      await db
        .update(pendingConfirmations)
        .set({ status: decision, resolvedAt: new Date() })
        .where(eq(pendingConfirmations.id, id));
    }
  });
}

export async function createHandoff(params: {
  tenantId: string;
  voiceSessionId: string;
  reason: string;
  toRole?: string;
  toUserId?: string;
}): Promise<{ id: string }> {
  const [row] = await withTenant(params.tenantId, (db) =>
    db
      .insert(handoffs)
      .values({
        tenantId: params.tenantId,
        voiceSessionId: params.voiceSessionId,
        reason: params.reason,
        toRole: params.toRole ?? null,
        toUserId: params.toUserId ?? null,
      })
      .returning({ id: handoffs.id }),
  );
  return { id: row!.id };
}
