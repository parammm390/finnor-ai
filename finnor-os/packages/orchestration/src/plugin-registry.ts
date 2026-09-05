// Explicit plugin registration at startup (§13). Each domain engine registers its
// action_types here; the orchestrator routes by action_type, nothing else.

import type { DomainEnginePlugin } from "@finnor/plugins-shared";
import type { DomainPolicy, SimulationResult } from "@finnor/shared-types";
import { zodToJsonSchema } from "zod-to-json-schema";
import waterTestPlugin from "../../domain-plugins/water-test/index";
import maintenanceAgreementPlugin from "../../domain-plugins/maintenance-agreement/index";
import crmPlugin from "../../domain-plugins/crm/index";
import inventoryPlugin from "../../domain-plugins/inventory/index";
import schedulingPlugin from "../../domain-plugins/scheduling/index";
import quotationPlugin from "../../domain-plugins/quotation/index";
import accountingPlugin from "../../domain-plugins/accounting/index";
import marketingPlugin from "../../domain-plugins/marketing/index";
import customerCommPlugin from "../../domain-plugins/customer-comm/index";
import waterDomainKnowledgePlugin from "../../domain-plugins/water-domain-knowledge/index";
import proposalBatchPlugin from "../../domain-plugins/proposal-batch/index";
import bulkNotifyPlugin from "../../domain-plugins/bulk-notify/index";
import technicianReportsPlugin from "../../domain-plugins/technician-reports/index";
import serviceRemindersPlugin from "../../domain-plugins/service-reminders/index";
import complianceDocumentationPlugin from "../../domain-plugins/compliance-documentation/index";
import webResearchPlugin from "../../domain-plugins/web-research/index";
import opsOverviewPlugin from "../../domain-plugins/ops-overview/index";
import leadToWaterTestPlugin from "../../domain-plugins/lead-to-water-test/index";
import proposalSignaturePlugin from "../../domain-plugins/proposal-signature/index";
import proposalToInstallationPlugin from "../../domain-plugins/proposal-to-installation/index";
import invoiceToCashPlugin from "../../domain-plugins/invoice-to-cash/index";
import { clarificationPlugin } from "../../domain-plugins/clarification/index";
import { manualStepPlugin } from "../../domain-plugins/manual-step/index";
import { routeOptimizationPlugin } from "../../domain-plugins/route-optimization/index";
import universalActionsPlugin from "../../domain-plugins/universal-actions/index";
import computerTaskPlugin from "../../domain-plugins/computer-task/index";

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

const PRIVATE_EQUITY_PLANNER_ACTIONS = ["clarification_request", "search_web"] as const;

/** PE3 deliberately has no PE mutation action catalog. Deterministic Deal reads
 * are consumed before planning; only clarification and public research survive. */
export function plannerActionTypesForVertical(registry: PluginRegistry, verticalKey: string): string[] {
  const registered = new Set(registry.actionTypes());
  return verticalKey === "private_equity"
    ? PRIVATE_EQUITY_PLANNER_ACTIONS.filter((actionType) => registered.has(actionType))
    : registry.actionTypes();
}

export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of [
    waterTestPlugin,
    maintenanceAgreementPlugin,
    crmPlugin,
    inventoryPlugin,
    schedulingPlugin,
    quotationPlugin,
    accountingPlugin,
    marketingPlugin,
    customerCommPlugin,
    waterDomainKnowledgePlugin,
    proposalBatchPlugin,
    bulkNotifyPlugin,
    technicianReportsPlugin,
    serviceRemindersPlugin,
    complianceDocumentationPlugin,
    webResearchPlugin,
    opsOverviewPlugin,
    leadToWaterTestPlugin,
    proposalSignaturePlugin,
    proposalToInstallationPlugin,
    invoiceToCashPlugin,
    clarificationPlugin,
    manualStepPlugin,
    routeOptimizationPlugin,
    universalActionsPlugin,
    computerTaskPlugin,
  ]) {
    registry.register(plugin);
  }
  return registry;
}
