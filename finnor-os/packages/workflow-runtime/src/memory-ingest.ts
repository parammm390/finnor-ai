// §5.2 (CENTROPY 95% MAESTRO PACK): turns a finalized DecisionReceipt into a real,
// citable semantic-memory chunk. Shared by two callers that must never diverge: the
// live post-step hook in steps.ts (fires the moment a step completes) and
// scripts/backfill-embeddings.ts (a one-off pass over receipts that finalized before
// this phase shipped, or before a real embeddings key existed).

import { withTenant, decisionReceipts } from "@finnor/db";
import { eq } from "drizzle-orm";
import { ingestMemory } from "@finnor/memory";

/** Renders a receipt's actualResult into "key: value" lines — reads better in a chunk
 *  (and embeds more meaningfully) than raw JSON. */
function describeResult(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const output = (result.output ?? result) as Record<string, unknown>;
  if (typeof output !== "object" || output === null) return String(output);
  return Object.entries(output)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

/** Ingests one already-finalized, successful receipt. No-op (returns 0) for a receipt
 *  with no actualResult (a failure, or one not yet finalized) — nothing honest to cite
 *  from a failure. Best-effort: never throws. */
export async function ingestReceipt(tenantId: string, receipt: {
  id: string;
  objective: string;
  actualResult: Record<string, unknown> | null;
  domainActionId: string | null;
  workflowRunId: string | null;
  finalizedAt: Date | null;
}): Promise<number> {
  if (!receipt.finalizedAt || !receipt.actualResult) return 0;
  const text = `${receipt.objective}\n\n${describeResult(receipt.actualResult)}`;
  const entityRefs = [
    receipt.domainActionId ? { type: "domain_action", id: receipt.domainActionId } : null,
    receipt.workflowRunId ? { type: "workflow_run", id: receipt.workflowRunId } : null,
  ].filter(Boolean);
  return ingestMemory({
    tenantId,
    sourceDocId: `receipt:${receipt.id}`,
    text,
    entityRefs,
    occurredAt: receipt.finalizedAt,
    sourceKind: "decision_receipt",
    provenance: { receiptId: receipt.id, domainActionId: receipt.domainActionId, workflowRunId: receipt.workflowRunId },
  });
}

/** Looks up a receipt by id and ingests it — the one lookup+ingest path both the live
 *  hook (which already has a receipt id from findReceiptByStep) and the backfill
 *  script (iterating historical receipt ids) share. */
export async function ingestReceiptById(tenantId: string, receiptId: string): Promise<number> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(decisionReceipts).where(eq(decisionReceipts.id, receiptId)));
  if (!row) return 0;
  return ingestReceipt(tenantId, row as unknown as Parameters<typeof ingestReceipt>[1]);
}
