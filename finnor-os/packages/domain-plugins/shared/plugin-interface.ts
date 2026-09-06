// DomainEnginePlugin (§13): the one interface all nine domain engines implement.
// validate/draft are pure; side effects are isolated to execute (§22).

import type {
  ValidationResult,
  DraftAction,
  ExecutionResult,
  DomainPolicy,
  DomainAction,
} from "@finnor/shared-types";
import type { ToolRegistry } from "@finnor/tools";

export interface DomainActionGrounding {
  draft: DraftAction;
  groundedPayload: Array<{
    field: string;
    status: "verified" | "not_found" | "unverifiable";
  }>;
}

/** A typed, expected refusal at the intent -> execution-truth boundary. */
export class ActionGroundingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ActionGroundingError";
  }
}

export interface DomainEnginePlugin {
  /** Human-readable plugin name, for logs and the audit view. */
  name: string;
  actionTypes: string[];
  /** Optional zod payload schema per action type — fed to the Planner so the LLM
   *  emits payloads that pass validate() on the first try. */
  payloadSchemas?: Record<string, import("zod").ZodTypeAny>;
  canHandle(actionType: string): boolean;
  validate(actionType: string, payload: unknown, policy: DomainPolicy): ValidationResult;
  // Async allowed: batch plugins read tenant data (read-only!) to build the spoken
  // summary. Side effects still belong exclusively in execute().
  draft(actionType: string, payload: unknown, policy: DomainPolicy): DraftAction | Promise<DraftAction>;
  /** Resolve planner intent to current canonical identifiers/state before a
   * BusinessEffect is compiled or authority is evaluated. Plugins that omit this
   * hook retain the established compiler-only grounding path. */
  ground?(draft: DraftAction, action: DomainAction, policy: DomainPolicy): Promise<DomainActionGrounding>;
  /** Upgrade 6: optional proposal-time hook for the small set of actions whose
   * approved work must outlive the approval request. It freezes an inspectable
   * operation/cohort before the gate and returns the operation id in the draft.
   * Ordinary actions never implement this and retain their existing path. */
  prepareDurableOperation?(draft: DraftAction, action: DomainAction, policy: DomainPolicy): Promise<DraftAction>;
  /** Optional domain-specific no-write forecast. Registry fallback is a labeled
   * schema-level prediction, so every plugin remains simulatable. */
  simulate?(actionType: string, payload: unknown, policy: DomainPolicy): import("@finnor/shared-types").SimulationResult | Promise<import("@finnor/shared-types").SimulationResult>;
  execute(draft: DraftAction, tools: ToolRegistry): Promise<ExecutionResult>;
}

/** True if any value anywhere in the policy is the placeholder marker. */
export function containsPlaceholder(value: unknown): boolean {
  if (value === "PLACEHOLDER_NEEDS_REAL_VALUE") return true;
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsPlaceholder);
  }
  return false;
}

/** Every placeholder location as a dot-path, for surfacing "which field" in a readiness UI. */
export function findPlaceholderPaths(value: unknown, path = ""): string[] {
  if (value === "PLACEHOLDER_NEEDS_REAL_VALUE") return [path || "(root)"];
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholderPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => findPlaceholderPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** Render a {{placeholder}} confirmation template against a payload — plain language for the queue. */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = values[key];
    return v === undefined || v === null ? `(${key} not set)` : String(v);
  });
}

/** §5.5: "thresholds live in policy rows, not code." Every answer action reads its
 *  retrieval confidence threshold the same way — a plain number under
 *  domain_policies.policy.retrievalConfidenceThreshold, shared by all four answer
 *  actions so a dealer configures this once per action type, not per plugin's own
 *  bespoke config key. Returns undefined (not a fabricated default) when unset —
 *  hybridRetrieve's own DEFAULT_CONFIDENCE_THRESHOLD applies in that case. */
export function readConfidenceThreshold(policy: DomainPolicy): number | undefined {
  const raw = (policy.policy as Record<string, unknown> | undefined)?.retrievalConfidenceThreshold;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * Stub plugin factory (§31 pattern): valid, typed, placeholder-marked. Registers its
 * action types, validates/drafts real drafts, and returns an explicit not_implemented
 * ExecutionResult — never a silent no-op, never a missing function body.
 */
export function createStubPlugin(name: string, actionTypes: string[]): DomainEnginePlugin {
  return {
    name,
    actionTypes,
    canHandle: (t) => actionTypes.includes(t),
    validate(actionType, payload) {
      if (!actionTypes.includes(actionType)) {
        return { valid: false, errors: [`${name} cannot handle ${actionType}`] };
      }
      if (payload !== null && typeof payload === "object") return { valid: true, errors: [] };
      return { valid: false, errors: ["payload must be an object"] };
    },
    draft(actionType, payload, policy) {
      const unconfigured = Object.keys(policy.policy).length === 0 || containsPlaceholder(policy.policy);
      return {
        actionType,
        summary: unconfigured
          ? `${actionType.replaceAll("_", " ")} — not yet configured for this dealer. Add the business rules in the Policy Editor before this can run.`
          : policy.confirmationTemplate ??
            `${name}: ${actionType} — ready to run per your configured policy.`,
        payload: (payload ?? {}) as Record<string, unknown>,
        // A placeholder-configured action is NEVER auto-executed, whatever the policy row says.
        requiresConfirmation: unconfigured ? true : policy.requiresConfirmation,
      };
    },
    async execute(draft) {
      return {
        status: "not_implemented",
        output: { actionType: draft.actionType },
        error: `${name} has no dealer-specific business rules configured yet. Populate domain_policies via the policy editor or ingestion pipeline.`,
      };
    },
  };
}
