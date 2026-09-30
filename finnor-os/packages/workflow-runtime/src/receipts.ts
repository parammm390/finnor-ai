// DecisionReceipt persistence (§2.2 contracts / §2.4 wiring). One row per
// workflow_step, created at proposal time and finalized in place at completion — see
// packages/db/schema.ts's decisionReceipts table and its unique(workflowStepId).

import { withTenant, decisionReceipts, llmCalls, type Db } from "@finnor/db";
import { eq, and, desc, sql } from "drizzle-orm";
import type { BusinessEffectVerification, ReceiptEvidence, ReceiptApproval, ReceiptFailure } from "@finnor/shared-types";

export interface OpenReceiptParams {
  tenantId: string;
  workflowRunId?: string;
  workflowStepId?: string;
  domainActionId?: string;
  businessEffectId?: string;
  intendedEffectHash?: string;
  authorizedEffectHash?: string;
  workId?: string;
  objective: string;
  evidence: ReceiptEvidence[];
  policyApplied: { id: string; version: number } | null;
  riskTier: "low" | "medium" | "high";
  proposedAction: Record<string, unknown>;
  approval: ReceiptApproval;
  expectedResult?: Record<string, unknown>;
  correlationId?: string;
}

export type FinalizeReceiptResult = ({ actualResult: Record<string, unknown>; evidence?: ReceiptEvidence[] } | { failure: ReceiptFailure; evidence?: ReceiptEvidence[] }) & {
  executedEffectHash?: string;
  effectVerification?: BusinessEffectVerification;
  recoveryEffectId?: string;
};

/** Transaction-owned form used when the receipt is part of the same correctness
 * boundary as a step or control transition. */
export async function openReceiptTx(db: Db, params: OpenReceiptParams): Promise<{ receiptId: string }> {
  const [cost] = params.domainActionId
    ? await db.select({ total: sql<number | null>`sum(${llmCalls.costUsd})` }).from(llmCalls)
        .where(and(eq(llmCalls.tenantId, params.tenantId), eq(llmCalls.domainActionId, params.domainActionId)))
    : [{ total: null }];
  const [row] = await db
    .insert(decisionReceipts)
    .values({
      tenantId: params.tenantId,
      workflowRunId: params.workflowRunId ?? null,
      workflowStepId: params.workflowStepId ?? null,
      domainActionId: params.domainActionId ?? null,
      businessEffectId: params.businessEffectId ?? null,
      intendedEffectHash: params.intendedEffectHash ?? null,
      authorizedEffectHash: params.authorizedEffectHash ?? null,
      workId: params.workId ?? null,
      objective: params.objective,
      evidence: params.evidence,
      policyApplied: params.policyApplied,
      riskTier: params.riskTier,
      proposedAction: params.proposedAction,
      approval: params.approval,
      expectedResult: params.expectedResult ?? null,
      correlationId: params.correlationId ?? null,
      llmCostUsd: cost?.total === null || cost?.total === undefined ? null : Number(cost.total),
    })
    .returning({ id: decisionReceipts.id });
  if (!row) throw new Error("DecisionReceipt insert did not return a durable row");
  return { receiptId: row.id };
}

/** Called before the step's external effect runs — the receipt exists whether or not
 *  the effect ultimately succeeds, so "no receipt" can never mean "nothing happened,
 *  we just didn't record it." */
export async function openReceipt(params: OpenReceiptParams): Promise<{ receiptId: string }> {
  return withTenant(params.tenantId, (db) => openReceiptTx(db, params));
}

/** Finalizes a receipt with what actually happened. Idempotent to call twice with the
 *  same result (a recovered/resumed step re-finalizing) — it's a plain UPDATE, not an
 *  append, so the second call just overwrites with the same values.
 *
 *  §5.3: optional `evidence` overwrites the receipt's generic open-time placeholder
 *  (`[{source:"workflow_step",...}]`, set by openReceiptForFirstClaim before the real
 *  work has happened) with the REAL citations the execution actually relied on. Every
 *  AI answer's receipt carries real citations this way, not a placeholder pointer. */
export async function finalizeReceiptTx(db: Db, tenantId: string, receiptId: string, result: FinalizeReceiptResult): Promise<void> {
  const [updated] = await db
      .update(decisionReceipts)
      .set({
        actualResult: "actualResult" in result ? result.actualResult : null,
        failure: "failure" in result ? result.failure : null,
        // A worker may have already attached execution/verification evidence before
        // completeStep finalizes the ordinary result. Omitted optional fields mean
        // "preserve existing causal evidence", never "erase it with null".
        ...(result.executedEffectHash !== undefined ? { executedEffectHash: result.executedEffectHash } : {}),
        ...(result.effectVerification !== undefined ? { verification: result.effectVerification } : {}),
        ...(result.recoveryEffectId !== undefined ? { recoveryEffectId: result.recoveryEffectId } : {}),
        ...("evidence" in result && result.evidence ? { evidence: result.evidence } : {}),
        finalizedAt: new Date(),
      })
      .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.id, receiptId)))
      .returning({ id: decisionReceipts.id });
  if (!updated) throw new Error(`DecisionReceipt ${receiptId} was not found for finalization`);
}

export async function finalizeReceipt(tenantId: string, receiptId: string, result: FinalizeReceiptResult): Promise<void> {
  await withTenant(tenantId, (db) => finalizeReceiptTx(db, tenantId, receiptId, result));
}

export async function findReceiptByStepTx(db: Db, workflowStepId: string): Promise<{
  id: string;
  objective: string;
  domainActionId: string | null;
  workflowRunId: string | null;
  workId: string | null;
  policyApplied: unknown;
  riskTier: "low" | "medium" | "high";
  actualResult: unknown;
} | null> {
  const [row] = await db
    .select({
      id: decisionReceipts.id,
      objective: decisionReceipts.objective,
      domainActionId: decisionReceipts.domainActionId,
      workflowRunId: decisionReceipts.workflowRunId,
      workId: decisionReceipts.workId,
      policyApplied: decisionReceipts.policyApplied,
      riskTier: decisionReceipts.riskTier,
      actualResult: decisionReceipts.actualResult,
    })
    .from(decisionReceipts)
    .where(eq(decisionReceipts.workflowStepId, workflowStepId));
  return row ?? null;
}

/** Computer-backed actions first finalize their single-action receipt with the
 * durable queue result, then the worker owns the real terminal observation. This
 * helper settles that same newest action receipt when the governed computer run is
 * terminal, preserving one causal receipt rather than claiming queueing was success. */
export async function finalizeLatestReceiptForAction(
  tenantId: string,
  domainActionId: string,
  result: ({ actualResult: Record<string, unknown>; evidence?: ReceiptEvidence[] } | { failure: ReceiptFailure; evidence?: ReceiptEvidence[] }) & {
    executedEffectHash?: string;
    effectVerification?: BusinessEffectVerification;
    recoveryEffectId?: string;
  },
): Promise<string | null> {
  const [receipt] = await withTenant(tenantId, (db) => db
    .select({ id: decisionReceipts.id })
    .from(decisionReceipts)
    .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.domainActionId, domainActionId)))
    .orderBy(desc(decisionReceipts.createdAt))
    .limit(1));
  if (!receipt) return null;
  await finalizeReceipt(tenantId, receipt.id, result);
  return receipt.id;
}

/** Looks up the receipt already opened for a step (finalizeReceipt needs the id;
 *  recovery paths that resume a step need to find its existing receipt rather than
 *  opening a second one — workflowStepId is unique in the table). Carries objective/
 *  domainActionId/workflowRunId too (§5.2: completeStep's auto-ingest hook needs real
 *  provenance for the chunk it writes, not just the id). */
export async function findReceiptByStep(
  tenantId: string,
  workflowStepId: string,
): Promise<{
  id: string;
  objective: string;
  domainActionId: string | null;
  workflowRunId: string | null;
  workId: string | null;
  policyApplied: unknown;
  riskTier: "low" | "medium" | "high";
  actualResult: unknown;
} | null> {
  return withTenant(tenantId, (db) => findReceiptByStepTx(db, workflowStepId));
}
