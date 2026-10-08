// Optional Zep mirror for the authenticated-human conversation kernel.
//
// Canonical identity and exact history stay in Postgres. Zep is a best-effort,
// employee-private derived index: one authenticated human -> one Zep user and one
// canonical Postgres thread -> one Zep thread. Pre-Phase-6 tenant-wide users are
// quarantined and are never queried or copied by this module.

import { ZepClient } from "@getzep/zep-cloud";
import type { SemanticHit } from "./semantic";

let client: ZepClient | null = null;
const ensuredThreads = new Set<string>();

function zepConfigured(): boolean {
  return Boolean(process.env.ZEP_API_KEY);
}

export async function testZepProviderConnection(): Promise<{ configured: boolean; healthy: boolean | null; reason: string | null }> {
  if (!zepConfigured()) return { configured: false, healthy: null, reason: "ZEP_API_KEY is not configured" };
  try {
    await getZepClient().project.get({ timeoutInSeconds: 5, maxRetries: 0 });
    return { configured: true, healthy: true, reason: null };
  } catch {
    // Do not surface provider error bodies: auth failures can echo sensitive
    // request metadata. The status remains explicit and fail-closed.
    return { configured: true, healthy: false, reason: "Zep project authentication or availability check failed" };
  }
}

function getZepClient(): ZepClient {
  client ??= new ZepClient({ apiKey: process.env.ZEP_API_KEY });
  return client;
}

export function zepEmployeeUserId(tenantId: string, employeeId: string): string {
  return `finnor-human-${tenantId}-${employeeId}`;
}

export function zepCanonicalThreadId(threadId: string): string {
  return `finnor-thread-${threadId}`;
}

export const LEGACY_ZEP_GRAPH_POLICY = "quarantined_no_query_no_copy" as const;

async function ensureHumanThread(tenantId: string, employeeId: string, threadId: string): Promise<void> {
  const key = `${tenantId}:${employeeId}:${threadId}`;
  if (ensuredThreads.has(key)) return;
  const zc = getZepClient();
  const userId = zepEmployeeUserId(tenantId, employeeId);
  const canonicalThreadId = zepCanonicalThreadId(threadId);
  const ignoreConflict = async (operation: Promise<unknown>): Promise<void> => {
    try {
      await operation;
    } catch (error) {
      const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
      const status = record.statusCode ?? record.status;
      if (status !== 409) throw error;
    }
  };
  await ignoreConflict(zc.user.add({ userId }, { timeoutInSeconds: 5, maxRetries: 1 }));
  await ignoreConflict(zc.thread.create({ threadId: canonicalThreadId, userId }, { timeoutInSeconds: 5, maxRetries: 1 }));
  ensuredThreads.add(key);
}

/** Best-effort mirror. Assistant messages are retained as context but explicitly
 * excluded from graph extraction, preventing assistant output from becoming a
 * durable personal fact. */
export async function mirrorConversationMessageToZep(params: {
  tenantId: string;
  employeeId: string;
  threadId: string;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}): Promise<void> {
  if (!zepConfigured()) return;
  try {
    await ensureHumanThread(params.tenantId, params.employeeId, params.threadId);
    await getZepClient().thread.addMessages(zepCanonicalThreadId(params.threadId), {
      ...(params.role === "assistant" ? { ignoreRoles: ["assistant" as const] } : {}),
      messages: [{
        uuid: params.messageId,
        content: params.content,
        role: params.role,
        createdAt: params.createdAt,
        metadata: {
          tenantId: params.tenantId,
          employeeId: params.employeeId,
          canonicalThreadId: params.threadId,
          canonicalMessageId: params.messageId,
        },
      }],
    }, { timeoutInSeconds: 5, maxRetries: 1 });
  } catch {
    // Zep is never on the authoritative or execution path.
  }
}

/** Searches only the authenticated employee's graph. A two-argument legacy call
 * returns [] instead of falling back to the quarantined tenant-wide graph. */
export async function queryConsolidatedFacts(
  tenantId: string,
  employeeId: string,
  query?: string,
  limit = 5,
): Promise<SemanticHit[]> {
  if (!query || !zepConfigured()) return [];
  try {
    const results = await getZepClient().graph.search({
      userId: zepEmployeeUserId(tenantId, employeeId),
      query,
      limit: Math.max(1, Math.min(limit, 10)),
    }, { timeoutInSeconds: 5, maxRetries: 1 });
    return (results.edges ?? []).map((edge) => ({
      chunk: edge.fact,
      sourceDocId: edge.uuid ?? null,
      similarity: edge.score ?? edge.relevance ?? 0,
      relevanceScore: edge.score ?? edge.relevance ?? 0,
      sourceKind: "zep_employee_fact",
      provenance: {
        provider: "zep",
        employeeId,
        graphEdgeId: edge.uuid ?? null,
        legacyGraphPolicy: LEGACY_ZEP_GRAPH_POLICY,
      },
    }));
  } catch {
    return [];
  }
}
