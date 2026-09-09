// §5.2 (JARVIS 95% MAESTRO PACK): the post-step runtime hook auto-ingests every
// completed workflow/receipt/report/transcript into semantic memory. This is the one
// place callers (workflow-runtime's completeStep, voice-os's closeVoiceSession) reach
// into — chunk, embed, and write, all best-effort so a memory-layer failure can never
// break the real thing (a step completing, a call ending).

import { writeSemantic } from "./semantic";
import { chunkSource } from "./chunking";

export interface IngestMemoryParams {
  tenantId: string;
  sourceDocId: string;
  documentId?: string;
  documentVersionId?: string;
  text: string;
  entityRefs?: unknown[];
  occurredAt?: Date;
  sourceKind?: string;
  provenance?: Record<string, unknown>;
}

/** Best-effort — matches the existing "receipts are logged, never able to break the
 *  step's own critical path" convention (packages/workflow-runtime/src/steps.ts).
 *  Returns the number of chunks written (0 if skipped: empty text, or a real failure
 *  such as embeddings being unconfigured — logged, never thrown to the caller). */
export async function ingestMemory(params: IngestMemoryParams): Promise<number> {
  if (!params.text.trim()) return 0;
  try {
    const chunks = chunkSource({ text: params.text, entityRefs: params.entityRefs, occurredAt: params.occurredAt }).map((chunk) => ({
      ...chunk,
      sourceKind: params.sourceKind ?? "runtime_artifact",
      documentId: params.documentId,
      documentVersionId: params.documentVersionId,
      provenance: { sourceDocId: params.sourceDocId, ...(params.provenance ?? {}) },
    }));
    if (chunks.length === 0) return 0;
    return await writeSemantic(params.tenantId, params.sourceDocId, chunks);
  } catch (err) {
    console.error(`[memory] ingestMemory skipped for ${params.sourceDocId}: ${(err as Error).message}`);
    return 0;
  }
}
