import { createHash } from "node:crypto";
import { z } from "zod";
import type { PageIndexClient } from "@finnor/tools/pageindex";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { CapabilityProviderError } from "@finnor/tools/capabilities/provider-json";
import type { CapabilityActor, CapabilityRun, FrozenDocumentSource } from "./contracts";
import { readCapabilityRun } from "./repository";
import type { ProviderCheckpoint, ProviderStep } from "./provider-step";

type Chat = Awaited<ReturnType<PageIndexClient["chat"]>>;
function chatAnchors(chat: Chat, documentId: string, source: FrozenDocumentSource) {
  const locations: Array<Record<string, unknown>> = [];
  for (const citation of chat.citations ?? []) {
    if ([citation.doc_id, citation.document_id].some(id => id !== undefined && id !== documentId)) throw new CapabilityEngineError("PAGEINDEX_CITATION_DOCUMENT_MISMATCH");
    if ([citation.document, citation.filename].some(id => id !== undefined && id !== documentId && id !== "source.pdf")) throw new CapabilityEngineError("PAGEINDEX_CITATION_DOCUMENT_MISMATCH");
    const bound = citation.doc_id === documentId || citation.document_id === documentId || [citation.document, citation.filename].some(id => id === documentId || id === "source.pdf");
    if (!bound) continue;
    const page = citation.page ?? citation.page_index;
    if (page !== undefined) locations.push({ source, pageStart: page, pageEnd: page, ...(citation.block_id ? { blockId: citation.block_id } : {}), ...(citation.node_id ? { nodeId: citation.node_id } : {}), providerCitation: citation });
  }
  if (!locations.length) {
    const content = chat.choices[0]?.message.content ?? "";
    for (const match of content.matchAll(/<doc=([^;>]+);page=(\d+)(?:;block=([^;>]+))?>/g)) {
      if (locations.length >= 10_000) throw new CapabilityEngineError("PAGEINDEX_ANCHOR_LIMIT");
      if (match[1] !== "source.pdf" && match[1] !== documentId) continue;
      const page = Number(match[2]);
      if (Number.isSafeInteger(page) && page >= 1 && page <= 100_000) locations.push({ source, pageStart: page, pageEnd: page, ...(match[3] ? { blockId: match[3] } : {}), citationTag: match[0] });
    }
  }
  return locations;
}

export async function executePageIndexChat(actor: CapabilityActor, run: CapabilityRun, client: PageIndexClient, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  if (run.request.kind !== "pageindex_retrieve") throw new CapabilityEngineError("PAGEINDEX_REQUEST_KIND_INVALID");
  // This API has no documented get-by-chat-ID route. Preserve any interrupted
  // receipt as uncertain rather than sending the same chat again.
  if (Object.keys(run.remoteState).length) return { status: "unknown", remoteState: run.remoteState, code: "PAGEINDEX_CHAT_RECEIPT_REQUIRES_RECONCILIATION" };
  const entries: Array<{ indexRunId: string; documentId: string; chatId: string; responseDigest: string }> = [];
  const results: Array<Record<string, unknown>> = [], deadlineAt = Date.parse(run.deadlineAt);
  for (const indexRunId of run.request.indexRunIds) {
    const original = await readCapabilityRun(actor, indexRunId);
    if (!original || original.kind !== "pageindex_index" || original.status !== "SUCCEEDED" || original.sources.length !== 1) throw new CapabilityEngineError("PAGEINDEX_INDEX_NOT_FOUND");
    const source = original.sources[0]!;
    if (!run.sources.some(item => item.documentId === source.documentId && item.versionId === source.versionId && item.sha256 === source.sha256)) throw new CapabilityEngineError("PAGEINDEX_FROZEN_SOURCE_MISMATCH");
    const remote = z.object({ remoteDocumentId: z.string().min(1).max(1024) }).passthrough().parse(original.result);
    const marker = { provider: "pageindex", phase: "dispatching", protocol: "document_scoped_chat", entries: [...entries], pendingIndexRunId: indexRunId, documentId: remote.remoteDocumentId };
    await checkpoint(marker, "PROVIDER_DISPATCH");
    let chat: Chat;
    try { chat = await client.chat(remote.remoteDocumentId, run.request.question, deadlineAt); }
    catch (error) {
      if (error instanceof CapabilityProviderError && error.disposition === "UNKNOWN") return { status: "unknown", remoteState: marker, code: "PAGEINDEX_CHAT_OUTCOME_UNKNOWN" };
      throw error;
    }
    entries.push({ indexRunId, documentId: remote.remoteDocumentId, chatId: chat.id, responseDigest: createHash("sha256").update(JSON.stringify(chat)).digest("hex") });
    await checkpoint({ provider: "pageindex", phase: "accepted", protocol: "document_scoped_chat", entries }, "PROVIDER_ACCEPTED");
    const anchors = chatAnchors(chat, remote.remoteDocumentId, source);
    results.push({ indexRunId, source, remoteDocumentId: remote.remoteDocumentId, research: chat, anchors, warnings: anchors.length ? [] : [{ code: "NO_VALID_PAGE_LOCATIONS_RETURNED" }] });
  }
  return { status: "complete", result: { schema: "finnor.pageindex-evidence.v1", kind: "pageindex_retrieve", question: run.request.question, results,
    backend: { provider: "pageindex", protocol: "DOCUMENT_SCOPED_CHAT_COMPLETIONS", apiVersion: "UNREPORTED" },
    qualification: "DERIVED_DOCUMENT_NAVIGATION_WITH_VERSION_BOUND_LOCATIONS", canonicalTruthEstablished: false, executionAuthorityGranted: false } };
}
