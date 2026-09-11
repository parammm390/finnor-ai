// Explicit plugin registration at startup (§13). Each domain engine registers its
// action_types here; the orchestrator routes by action_type, nothing else.

import type { DomainEnginePlugin } from "@finnor/plugins-shared";
import {
  OPERATIONAL_QUERY_INTENTS,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  PRIVATE_EQUITY_VERTICAL,
  assertExecutableVertical,
  type DomainPolicy,
  type SimulationResult,
} from "@finnor/shared-types";
import { ACTION_HARDENING_SPEC } from "../../../scripts/release/action-hardening-spec";
import { zodToJsonSchema } from "zod-to-json-schema";
import webResearchPlugin from "../../domain-plugins/web-research/index";
import { clarificationPlugin } from "../../domain-plugins/clarification/index";
import universalActionsPlugin from "../../domain-plugins/universal-actions/index";
import computerTaskPlugin from "../../domain-plugins/computer-task/index";
import privateEquityPlugin, { PRIVATE_EQUITY_ACTION_TYPES } from "../../domain-plugins/private-equity/index";

export class PluginRegistry {
  private byActionType = new Map<string, DomainEnginePlugin>();

  register(plugin: DomainEnginePlugin): void {
    if (!Array.isArray(plugin.actionTypes)) {
      throw new Error(
        `plugin ${plugin?.name ?? "<unnamed>"}.actionTypes is not an array: ${JSON.stringify(plugin.actionTypes)} (plugin keys: ${plugin ? Object.keys(plugin).join(",") : "<no plugin>"})`,
      );
    }
    for (const t of plugin.actionTypes) {
      if (this.byActionType.has(t)) {
        throw new Error(`action_type ${t} already registered by ${this.byActionType.get(t)!.name}`);
      }
      this.byActionType.set(t, plugin);
    }
  }

  resolve(actionType: string): DomainEnginePlugin | undefined {
    return this.byActionType.get(actionType);
  }

  /** Every plugin is simulatable. Plugins with a domain-specific implementation may
   * read real tenant data, but the fallback deliberately reports only schema/input
   * facts and never pretends it knows a side effect's eventual result. */
  async simulate(actionType: string, payload: Record<string, unknown>, policy: DomainPolicy): Promise<SimulationResult> {
    const plugin = this.resolve(actionType);
    if (!plugin) {
      return { mode: "schema", summary: `No plugin is registered for ${actionType}; no execution is predicted.`, predicted: { actionType, fieldChanges: [] } };
    }
    if (plugin.simulate) return plugin.simulate(actionType, payload, policy);
    const validation = plugin.validate(actionType, payload, policy);
    return {
      mode: "schema",
      summary: validation.valid
        ? `${actionType.replaceAll("_", " ")} is schema-valid; this default prediction makes no claim about external effects.`
        : `${actionType.replaceAll("_", " ")} is not schema-valid and will not execute until corrected.`,
      predicted: {
        actionType,
        valid: validation.valid,
        validationErrors: validation.errors,
        // Inputs are named rather than presented as changed persisted fields: the
        // default knows the schema, not a domain's mutation semantics.
        inputFields: Object.keys(payload).sort(),
        fieldChanges: [],
      },
    };
  }

  actionTypes(): string[] {
    return [...this.byActionType.keys()];
  }

  private specCache = new Map<string, string>();

  /** Compact payload spec for the Planner prompt: one line per action type,
   *  `field*` = required, `field?` = optional, `field:enum(a|b)` for enums.
   *  ~10x fewer tokens than full JSON Schema — lower latency, no TPM stalls —
   *  while still telling the model exactly which field names to emit.
   *  Cached: plugins register once at startup, so this is stable per process. */
  payloadSpecJson(allowedActionTypes?: readonly string[]): string {
    const allowed = allowedActionTypes ? new Set(allowedActionTypes) : null;
    const cacheKey = allowed ? [...allowed].sort().join("\u0000") : "*";
    const cached = this.specCache.get(cacheKey);
    if (cached) return cached;
    const lines: string[] = [];
    for (const [actionType, plugin] of this.byActionType) {
      if (allowed && !allowed.has(actionType)) continue;
      const schema = plugin.payloadSchemas?.[actionType];
      if (!schema) {
        lines.push(`${actionType}: (free-form object)`);
        continue;
      }
      const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as {
        properties?: Record<string, { type?: string; enum?: unknown[]; format?: string }>;
        required?: string[];
      };
      const required = new Set(json.required ?? []);
      const fields = Object.entries(json.properties ?? {}).map(([name, def]) => {
        const mark = required.has(name) ? "*" : "?";
        if (def.enum) return `${name}${mark}:enum(${def.enum.join("|")})`;
        const t = def.format === "uuid" ? "uuid" : (def.type ?? "any");
        return `${name}${mark}:${t}`;
      });
      lines.push(`${actionType}: ${fields.join(", ")}`);
    }
    const result = lines.join("\n");
    this.specCache.set(cacheKey, result);
    return result;
  }
}

const UNIVERSAL_PLANNER_ACTIONS = [
  "send_message", "place_call", "request_acknowledgement", "notify_group",
  "create_task", "assign_task", "update_task", "handoff_work",
  "delegate_objective", "escalate_work", "cancel_delegation",
  "schedule_internal_event", "reschedule_internal_event", "share_document",
] as const;
const SHARED_PLANNER_ACTIONS = ["clarification_request", "search_web", "computer_task", ...UNIVERSAL_PLANNER_ACTIONS] as const;

/** These capabilities terminate at explicit human-authored APIs. They are not
 * recoverable by adding an approval gate to a model proposal. */
export const HUMAN_ONLY_PLANNING_CAPABILITIES = [
  "configure_ic_committee",
  "record_ic_vote",
  "cast_ic_vote",
  "record_ic_dissent",
  "waive_ic_question",
  "waive_ic_condition",
  "open_ic_voting",
  "close_ic_voting",
  "finalize_ic_decision",
  "waive_closing_condition",
  "verify_closing_item",
] as const;

export interface PlanningCapabilityManifestEntry {
  capability: string;
  kind: "query" | "action" | "wait" | "check";
  modelProposable: boolean;
  available: boolean;
  health: "available" | "degraded" | "unavailable";
  risk: "low" | "medium" | "high";
  irreversible: boolean;
  requiredReferences: string[];
  effectClass: string | null;
  observationStrategy: "operational_query" | "business_effect" | "decision_receipt" | "provider_observation" | "integration_event" | "objective_success";
  reversibility: "read_only" | "reversible" | "compensatable" | "irreversible" | "unknown_provider_dependent";
  supportedRecoveryModes: Array<"retry" | "replan" | "recover" | "compensate" | "escalate">;
  externalSideEffect: boolean;
  authorityRequirement: "query" | "policy" | "approval" | "typed_approval" | "human_attestation";
}

function actionRisk(actionType: string): Pick<PlanningCapabilityManifestEntry, "risk" | "irreversible"> {
  const spec = ACTION_HARDENING_SPEC.find((row) => row.actionType === actionType);
  if (!spec) return { risk: "high", irreversible: true };
  const irreversible = spec.external || ["FINANCIAL_WRITE", "EXTERNAL_SPEND", "BATCH_EXTERNAL"].includes(spec.profile);
  const risk = irreversible || spec.profile === "DURABLE_WORKFLOW"
    ? "high"
    : ["OPERATIONAL_CHANGE", "INTERNAL_WRITE"].includes(spec.profile) ? "medium" : "low";
  return { risk, irreversible };
}

function requiredReferenceFields(registry: PluginRegistry, actionType: string): string[] {
  const schema = registry.resolve(actionType)?.payloadSchemas?.[actionType];
  if (!schema) return [];
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as { required?: string[] };
  return (json.required ?? []).filter((field) => /(?:Id|Ref|recipient|target)$/i.test(field)).sort();
}

function actionPlanningMetadata(registry: PluginRegistry, actionType: string): Omit<PlanningCapabilityManifestEntry,
  "capability" | "kind" | "modelProposable" | "available" | "health" | "risk" | "irreversible"
> {
  const spec = ACTION_HARDENING_SPEC.find((row) => row.actionType === actionType);
  const readOnly = spec?.profile === "READ_ONLY" || spec?.profile === "META_NO_SIDE_EFFECT";
  const irreversible = Boolean(spec?.external || spec && ["FINANCIAL_WRITE", "EXTERNAL_SPEND", "BATCH_EXTERNAL"].includes(spec.profile));
  return {
    requiredReferences: requiredReferenceFields(registry, actionType),
    effectClass: readOnly ? null : spec?.profile ?? null,
    observationStrategy: actionType === "search_web" ? "provider_observation" : readOnly ? "decision_receipt" : "business_effect",
    reversibility: readOnly ? "read_only" : irreversible ? "irreversible" : "unknown_provider_dependent",
    supportedRecoveryModes: readOnly ? ["retry", "replan", "escalate"] : irreversible ? ["replan", "recover", "escalate"] : ["retry", "replan", "recover", "escalate"],
    externalSideEffect: spec?.external ?? false,
    authorityRequirement: spec?.approvalFloor === "TYPED_REQUIRED" ? "typed_approval" : spec?.approvalFloor === "REQUIRED" ? "approval" : "policy",
  };
}

/** One executable capability inventory. Constraint construction, prompting, and
 * deterministic compilation all consume this exact manifest. */
export function planningCapabilitiesForVertical(registry: PluginRegistry, verticalKey: string): PlanningCapabilityManifestEntry[] {
  assertExecutableVertical(verticalKey);
  const registered = new Set(registry.actionTypes());
  const humanOnly = new Set<string>(HUMAN_ONLY_PLANNING_CAPABILITIES);
  const actionUniverse = verticalKey === PRIVATE_EQUITY_VERTICAL
    ? [...SHARED_PLANNER_ACTIONS, ...PRIVATE_EQUITY_ACTION_TYPES]
    : [...SHARED_PLANNER_ACTIONS];
  const queryUniverse = verticalKey === PRIVATE_EQUITY_VERTICAL
    ? [...OPERATIONAL_QUERY_INTENTS]
    : OPERATIONAL_QUERY_INTENTS.filter((intent) => !PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS.includes(intent as (typeof PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS)[number]));
  const actions = [...new Set([...actionUniverse, ...HUMAN_ONLY_PLANNING_CAPABILITIES])].map((capability) => {
    const isRegistered = registered.has(capability);
    return {
      capability,
      kind: "action" as const,
      modelProposable: isRegistered && !humanOnly.has(capability),
      available: isRegistered,
      health: isRegistered ? "available" as const : "unavailable" as const,
      ...actionRisk(capability),
      ...actionPlanningMetadata(registry, capability),
      ...(!isRegistered && humanOnly.has(capability) ? {
        observationStrategy: "objective_success" as const,
        reversibility: "irreversible" as const,
        supportedRecoveryModes: ["escalate"] as Array<"escalate">,
        authorityRequirement: "human_attestation" as const,
      } : {}),
    };
  });
  return [
    ...actions,
    ...queryUniverse.map((intent) => ({ capability: `query:${intent}`, kind: "query" as const, modelProposable: true, available: true, health: "available" as const, risk: "low" as const, irreversible: false, requiredReferences: PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS.includes(intent as (typeof PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS)[number]) ? ["dealId"] : [], effectClass: null, observationStrategy: "operational_query" as const, reversibility: "read_only" as const, supportedRecoveryModes: ["retry", "replan", "escalate"] as Array<"retry" | "replan" | "escalate">, externalSideEffect: false, authorityRequirement: "query" as const })),
    { capability: "wait:event", kind: "wait", modelProposable: true, available: true, health: "available", risk: "medium", irreversible: false, requiredReferences: ["correlation"], effectClass: null, observationStrategy: "integration_event", reversibility: "read_only", supportedRecoveryModes: ["replan", "recover", "escalate"], externalSideEffect: false, authorityRequirement: "policy" },
    { capability: "check:objective_success", kind: "check", modelProposable: true, available: true, health: "available", risk: "low", irreversible: false, requiredReferences: ["criterionId"], effectClass: null, observationStrategy: "objective_success", reversibility: "read_only", supportedRecoveryModes: ["replan", "escalate"], externalSideEffect: false, authorityRequirement: "query" },
  ];
}
/** Action manifests are composed only from executable verticals. Historical action
 * identity is rendered from durable rows and never requires executable registration. */
export function plannerActionTypesForVertical(registry: PluginRegistry, verticalKey: string): string[] {
  return planningCapabilitiesForVertical(registry, verticalKey)
    .filter((entry) => entry.kind === "action" && entry.modelProposable)
    .map((entry) => entry.capability);
}

export const actionTypesForVertical = plannerActionTypesForVertical;

export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of [
    webResearchPlugin,
    clarificationPlugin,
    universalActionsPlugin,
    computerTaskPlugin,
    privateEquityPlugin,
  ]) {
    registry.register(plugin);
  }
  return registry;
}
