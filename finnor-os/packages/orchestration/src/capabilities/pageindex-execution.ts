import { z } from "zod";
import { PageIndexClient } from "@finnor/tools/pageindex";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { CapabilityProviderError } from "@finnor/tools/capabilities/provider-json";
import type { CapabilityActor, CapabilityRun, FrozenDocumentSource } from "./contracts";
import { loadCapabilitySource } from "./repository";
import type { ProviderCheckpoint, ProviderStep } from "./provider-step";
import { executePageIndexChat } from "./pageindex-chat-execution";

const entrySchema = z.object({ indexRunId: z.string().uuid(), documentId: z.string().min(1).max(1024) }).strict();
const remoteSchema = z.object({ provider: z.literal("pageindex"), phase: z.literal("accepted"), entries: z.array(entrySchema).min(1).max(8), polls: z.number().int().min(0).max(60) }).strict();

function anchors(value: unknown, source: FrozenDocumentSource): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []; let visited = 0;
  const walk = (node: unknown, depth: number) => {
    if (++visited > 100_000 || depth > 64) throw new CapabilityEngineError("PAGEINDEX_TREE_COMPLEXITY_LIMIT");
    if (Array.isArray(node)) { for (const child of node) walk(child, depth + 1); return; }
    if (node === null || typeof node !== "object") return;
    const object = z.record(z.string(), z.unknown()).parse(node);
    const start = object.page_index ?? object.start_index, end = object.end_index ?? start;
    if (typeof object.node_id === "string" && typeof start === "number" && Number.isSafeInteger(start) && start >= 1
      && typeof end === "number" && Number.isSafeInteger(end) && end >= start) {
      result.push({ source, nodeId: object.node_id, pageStart: start, pageEnd: end });
      if (result.length > 10_000) throw new CapabilityEngineError("PAGEINDEX_ANCHOR_LIMIT");
    }
    for (const nested of Object.values(object)) if (nested && typeof nested === "object") walk(nested, depth + 1);
  };
  walk(value, 0); return result;
}

export async function executePageIndexStep(actor: CapabilityActor, run: CapabilityRun, checkpoint: ProviderCheckpoint): Promise<ProviderStep> {
  if (process.env.FINNOR_PAGEINDEX_ENABLED !== "1" || !process.env.PAGEINDEX_API_KEY) throw new CapabilityEngineError("PAGEINDEX_NOT_CONFIGURED");
  const client = new PageIndexClient({ apiKey: process.env.PAGEINDEX_API_KEY, baseUrl: process.env.FINNOR_PAGEINDEX_BASE_URL });
  const request = run.request, deadlineAt = Date.parse(run.deadlineAt);
  if (request.kind !== "pageindex_index" && request.kind !== "pageindex_retrieve") throw new CapabilityEngineError("PAGEINDEX_REQUEST_KIND_INVALID");
  if (request.kind === "pageindex_retrieve") return executePageIndexChat(actor, run, client, checkpoint);
  const entries: Array<z.infer<typeof entrySchema>> = [];
  let polls = 0;
  if (Object.keys(run.remoteState).length) {
    const saved = remoteSchema.safeParse(run.remoteState);
    if (!saved.success) return { status: "unknown", remoteState: run.remoteState, code: "PAGEINDEX_SUBMISSION_REQUIRES_RECONCILIATION" };
    entries.push(...saved.data.entries); polls = saved.data.polls;
  }
  const sourceByIndex = new Map<string, FrozenDocumentSource>();
  {
    const source = run.sources[0]; if (!source) throw new CapabilityEngineError("CAPABILITY_FROZEN_SOURCE_MISSING");
    sourceByIndex.set(run.id, source);
    if (!entries.length) {
      const bytes = await loadCapabilitySource(actor, source, deadlineAt);
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || bytes.length > 10_485_760) throw new CapabilityEngineError("PAGEINDEX_PDF_REQUIRED_WITHIN_SIZE_LIMIT");
      const marker = { provider: "pageindex", phase: "dispatching", entries: [], indexRunId: run.id, sourceSha256: source.sha256 };
      await checkpoint(marker, "PROVIDER_DISPATCH");
      try { entries.push({ indexRunId: run.id, documentId: (await client.submitDocument(bytes, deadlineAt)).doc_id }); }
      catch (error) {
        if (error instanceof CapabilityProviderError && error.disposition === "UNKNOWN") return { status: "unknown", remoteState: marker, code: "PAGEINDEX_UPLOAD_UNKNOWN" };
        throw error;
      }
      await checkpoint({ provider: "pageindex", phase: "accepted", entries, polls }, "PROVIDER_ACCEPTED");
    }
  }
  const results: Array<Record<string, unknown>> = []; let processing = false;
  for (const entry of entries) {
    const source = sourceByIndex.get(entry.indexRunId); if (!source) throw new CapabilityEngineError("PAGEINDEX_INDEX_BINDING_MISMATCH");
    try {
      const observed = await client.tree(entry.documentId, deadlineAt);
      if (observed.doc_id !== undefined && observed.doc_id !== entry.documentId) throw new CapabilityEngineError("PAGEINDEX_PROVIDER_DOCUMENT_MISMATCH");
      if (observed.status === "failed" || observed.status === "error") throw new CapabilityEngineError("PAGEINDEX_PROVIDER_PROCESSING_FAILED");
      if (observed.status !== "completed") { processing = true; continue; }
      if (observed.result === undefined) throw new CapabilityEngineError("PAGEINDEX_RESULT_MISSING");
      const locations = anchors(observed.result, source);
      results.push({ indexRunId: entry.indexRunId, source, remoteDocumentId: entry.documentId, research: observed, anchors: locations,
        warnings: locations.length ? [] : [{ code: "NO_VALID_PAGE_LOCATIONS_RETURNED" }] });
    } catch (error) {
      if (!(error instanceof CapabilityProviderError) || error.disposition === "BEFORE_DISPATCH") throw error;
      processing = true;
    }
  }
  if (!processing) return { status: "complete", result: { schema: "finnor.pageindex-evidence.v1", kind: request.kind,
    remoteDocumentId: entries[0]!.documentId, results,
    backend: { provider: "pageindex", protocol: "DOCUMENT_TREE_REST", apiVersion: "UNREPORTED" },
    qualification: "DERIVED_DOCUMENT_NAVIGATION_WITH_VERSION_BOUND_LOCATIONS", canonicalTruthEstablished: false, executionAuthorityGranted: false } };
  if (polls >= 60) return { status: "unknown", remoteState: { provider: "pageindex", phase: "accepted", entries, polls }, code: "PAGEINDEX_POLL_LIMIT_REQUIRES_RECONCILIATION" };
  return { status: "waiting", remoteState: { provider: "pageindex", phase: "accepted", entries, polls: polls + 1 }, delayMs: 5000 };
}
