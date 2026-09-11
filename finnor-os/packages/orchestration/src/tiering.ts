// Risk-tiered reasoning depth (Phase 8, docs/jarvis-99-phase-7-9-execution-plan.md).
// Sibling to repair.ts — a separate single-purpose module, matching how compiler.ts
// and repair.ts are already split. Pure, no DB access, safe to call from inside an
// existing transaction/insert batch with zero extra round trips.

import type { CommandGraph } from "./compiler";
import type { ReasoningTier } from "@finnor/shared-types";

// A conservative magnitude signal in addition to the structural workflow and
// approval gates. It does not itself authorize execution.
export const DEFAULT_AMOUNT_USD_THRESHOLD = 500;

export function classifyReasoningTier(input: {
  requiresConfirmation: boolean;
  compiledGraph: CommandGraph;
  payload: Record<string, unknown>;
  amountThresholdUsd?: number;
  actionType?: string;
  openScanSignals?: Array<{ scanType: string; severity: string }>;
}): ReasoningTier {
  // Tier only ever spends more reasoning on gated stakes — an action that doesn't
  // require confirmation was never going to get extra scrutiny, and scan signals
  // don't change that by design.
  if (!input.requiresConfirmation) return "low";
  const threshold = input.amountThresholdUsd ?? DEFAULT_AMOUNT_USD_THRESHOLD;
  const amount = typeof input.payload.amountUsd === "number" ? input.payload.amountUsd : null;
  if (input.compiledGraph.kind === "workflow" || (amount !== null && amount > threshold)) return "high";

  const signals = input.openScanSignals ?? [];
  const hasCritical = signals.some((s) => s.severity === "critical");
  if (hasCritical) return "high";

  return "medium";
}
