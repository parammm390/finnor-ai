import { createHash } from "node:crypto";
import { runtimeOperatorControls, type Db } from "@finnor/db";
import { and, eq } from "drizzle-orm";

export type RuntimeOperatorControlType =
  | "step_redrive"
  | "dlq_replay"
  | "dlq_discard"
  | "reconciliation_resolution"
  | "compensation_initiation";

export type RuntimeOperatorTargetType =
  | "workflow_step"
  | "dead_letter"
  | "reconciliation_case"
  | "compensation_case";

export interface RuntimeOperatorAuthority {
  actorId: string;
  /** Durable AuthorityDecision created at the authenticated control boundary. */
  authorityDecisionId: string;
}

export interface RuntimeOperatorControlRequest extends RuntimeOperatorAuthority {
  controlKey?: string;
  expectedVersion: number;
  reason: string;
}

export interface RuntimeOperatorControlEvidence {
  controlType: RuntimeOperatorControlType;
  targetType: RuntimeOperatorTargetType;
  targetId: string;
  expectedVersion: number;
  observedFence?: number | null;
  actorId: string;
  authorityDecisionId: string;
  reason: string;
  evidence: Record<string, unknown>;
  outcome: "applied" | "conflict" | "rejected" | "blocked";
  controlKey?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

/** Stable across HTTP/operator retries. A different request under the same key is a
 * hard conflict, never a second unaudited mutation. */
export function runtimeOperatorControlKey(input: Pick<RuntimeOperatorControlEvidence,
  "controlType" | "targetId" | "expectedVersion" | "actorId">): string {
  return `${input.controlType}:${input.targetId}:v${input.expectedVersion}:${digest(input.actorId).slice(0, 16)}`;
}

export async function findRuntimeOperatorControlTx(
  db: Db,
  tenantId: string,
  controlKey: string,
): Promise<typeof runtimeOperatorControls.$inferSelect | null> {
  const [row] = await db.select().from(runtimeOperatorControls).where(and(
    eq(runtimeOperatorControls.tenantId, tenantId),
    eq(runtimeOperatorControls.controlKey, controlKey),
  )).limit(1);
  return row ?? null;
}

export async function recordRuntimeOperatorControlTx(
  db: Db,
  tenantId: string,
  input: RuntimeOperatorControlEvidence,
): Promise<{ id: string; duplicate: boolean }> {
  if (!input.actorId || !input.authorityDecisionId) throw new Error("Runtime operator control requires authenticated actor and durable AuthorityDecision");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("Runtime operator control requires a non-negative expected version");
  if (!input.reason.trim()) throw new Error("Runtime operator control requires a reason");
  const controlKey = input.controlKey ?? runtimeOperatorControlKey(input);
  const request = {
    controlType: input.controlType,
    targetType: input.targetType,
    targetId: input.targetId,
    expectedVersion: input.expectedVersion,
    actorId: input.actorId,
    reason: input.reason,
  };
  // A transport retry is re-authorized and therefore normally receives a new
  // AuthorityDecision row. That new evidence row must not turn the same immutable
  // operator request into an idempotency conflict. The originally applied control
  // retains its exact authorityDecisionId; request identity is the actor + target +
  // expected version + requested transition/reason.
  const requestHash = `sha256:${digest(request)}`;
  const [inserted] = await db.insert(runtimeOperatorControls).values({
    tenantId,
    controlKey,
    controlType: input.controlType,
    actorId: input.actorId,
    authorityDecisionId: input.authorityDecisionId,
    targetType: input.targetType,
    targetId: input.targetId,
    expectedVersion: input.expectedVersion,
    observedFence: input.observedFence ?? null,
    requestHash,
    reason: input.reason,
    evidence: input.evidence,
    outcome: input.outcome,
  }).onConflictDoNothing({
    target: [runtimeOperatorControls.tenantId, runtimeOperatorControls.controlKey],
  }).returning({ id: runtimeOperatorControls.id });
  if (inserted) return { id: inserted.id, duplicate: false };
  const [existing] = await db.select({
    id: runtimeOperatorControls.id,
    requestHash: runtimeOperatorControls.requestHash,
  }).from(runtimeOperatorControls).where(and(
    eq(runtimeOperatorControls.tenantId, tenantId),
    eq(runtimeOperatorControls.controlKey, controlKey),
  )).limit(1);
  if (!existing || existing.requestHash !== requestHash) {
    throw new Error("Operator control idempotency conflict: control key was already used for a different authorized request");
  }
  return { id: existing.id, duplicate: true };
}
