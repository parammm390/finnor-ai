// Routes each action to the legacy GatedExecutor or the new LangGraphExecutor by
// actionType, via an env-var allowlist — a per-action-type migration switch, not a
// process-wide flag, so the blast radius of adding LangGraph to one more action type
// is exactly that action type. Every other FinnorOrchestrator method (handleInstruction,
// draftKnownAction, runAction, decide) calls `this.executor.execute(...)` through the
// Executor interface and needs zero changes — this class IS the single Executor they see.

import { isRetiredWaterAction, type DomainAction, type DomainPolicy, type ExecutionResult } from "@finnor/shared-types";
import type { Executor } from "../executor";

// Phase 5 retires the legacy vertical workflows. New graph actions must be opted in
// explicitly and are checked against the durable retirement ledger below.
export const DEFAULT_GRAPH_ACTION_TYPES: readonly string[] = [];

function parseAllowlist(raw: string): Set<string> {
  const values = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const retired = values.filter(isRetiredWaterAction);
  if (retired.length) throw new Error(`Retired Water graph action(s) cannot be registered: ${retired.join(", ")}`);
  return new Set(values);
}

export function graphActionTypeAllowlist(): Set<string> {
  const raw = process.env.ORCHESTRATION_ENGINE_GRAPH_ACTION_TYPES;
  return raw === undefined ? new Set(DEFAULT_GRAPH_ACTION_TYPES) : parseAllowlist(raw);
}

export class AllowlistExecutor implements Executor {
  constructor(
    private legacy: Executor,
    private graph: Executor,
    private allowlist: Set<string> = graphActionTypeAllowlist(),
  ) {}

  private resolve(actionType: string): Executor {
    return this.allowlist.has(actionType) ? this.graph : this.legacy;
  }

  execute(action: DomainAction, policy: DomainPolicy): Promise<ExecutionResult> {
    return this.resolve(action.actionType).execute(action, policy);
  }

  async close(actionId: string, tenantId: string, actionType: string): Promise<void> {
    await this.resolve(actionType).close?.(actionId, tenantId, actionType);
  }
}
