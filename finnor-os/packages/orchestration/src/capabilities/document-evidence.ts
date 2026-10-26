import { z } from "zod";
import type { Db } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import type { CapabilityActor, CapabilityRun } from "./contracts";

/** Derived text joins the existing evidence/version/chunk owner. The full native
 * parse and all source locations remain in the immutable capability result. */
export async function persistDerivedDocumentEvidence(db: Db, actor: CapabilityActor, run: CapabilityRun, output: Record<string, unknown>, authorityRevision: number) {
  if (run.kind !== "docling_extract") return output;
  const extraction = z.object({ schema: z.literal("finnor.docling-extraction.v1"), markdown: z.string().max(1_048_576),
    anchors: z.array(z.record(z.string(), z.unknown())), warnings: z.array(z.record(z.string(), z.unknown())), status: z.string() }).passthrough().parse(output);
  const source = run.sources[0]; if (!source) throw new Error("DOCUMENT_SOURCE_REQUIRED");
  const evidence: Array<{ sourceId: string; versionId: string; contentHash: string; chunks: number; part: number }> = [];
  // Slice by Unicode code point, with a byte floor that fits the owner's native
  // 256KiB content/snapshot bounds even for four-byte characters.
  const characters = Array.from(extraction.markdown);
  for (let offset = 0, part = 0; offset < characters.length; offset += 40_000, part++) {
    const content = characters.slice(offset, offset + 40_000).join("").trim(); if (!content) continue;
    const evidenceSource = await createEvidenceSourceTx(db, actor.tenantId, { sourceKey: `document-derived:${source.documentId}:${source.versionId}:docling:${run.id}:${part}`,
      sourceType: "document_extraction", title: `Document extraction ${source.documentId}, part ${part + 1}`, publisher: "Docling", metadata: {
        documentId: source.documentId, documentVersionId: source.versionId, sourceSha256: source.sha256, capabilityRunId: run.id, extractor: "docling", part,
        capabilityPrincipalId: actor.userId, capabilityAuthorityRevision: authorityRevision } });
    const version = await appendEvidenceVersionTx(db, actor.tenantId, evidenceSource.id, { content, snapshot: {
      schema: "finnor.document-derived-evidence.v1", source, capabilityRunId: run.id, part, status: extraction.status, warnings: extraction.warnings,
      completeLocationsRef: { owner: "capability_run", id: run.id, field: "anchors", count: extraction.anchors.length },
      contentTreatment: "UNTRUSTED_EXTRACTED_EVIDENCE", canonicalTruthEstablished: false, executionAuthorityGranted: false,
    } });
    evidence.push({ sourceId: version.sourceId, versionId: version.versionId, contentHash: version.contentHash, chunks: version.chunks, part });
  }
  return { ...output, evidence, evidencePublication: "NATIVE_MEMORY_EVIDENCE_VERSIONS_AND_CHUNKS_BOUND_TO_ORIGINAL_DOCUMENT_VERSION" };
}
