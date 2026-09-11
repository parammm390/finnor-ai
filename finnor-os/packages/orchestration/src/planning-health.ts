// Tenant-level integration health is intentionally small after the Water
// retirement. Exact communication action readiness is resolved separately through
// the Universal Actions route owner because governed Gmail/Vapi identities are
// actor-scoped and cannot be inferred from a tenant-level provider flag.

import { circuitSnapshot, tenantProviderConfigured } from "@finnor/tools";
import { inspectCommunicationActionAvailability } from "../../domain-plugins/universal-actions/index";

export type ActivePlanningCapability = "employee_voice" | "transactional_email";

export interface PlanningCapabilityHealth {
  capability: ActivePlanningCapability;
  binding: "vapi" | "resend";
  source: "tenant";
  health: "ok" | "down" | "unknown";
  circuit: "closed" | "open";
  unavailable: boolean;
  reason: string | null;
}

export type PlanningHealthContext = Record<ActivePlanningCapability, PlanningCapabilityHealth>;

export type ActionPlanningCapability = "governed_email" | "governed_voice" | "governed_sms";

export interface ActionPlanningHealth {
  capability: ActionPlanningCapability;
  health: "available" | "unavailable";
  provider: string | null;
  selectedChannel: "internal" | "email" | "sms" | "voice" | null;
  reason: string | null;
}

/** Map only transport requirements that the current runtime can prove from its
 * existing tenant-scoped health owners. Internal messages deliberately have no
 * provider dependency; unsupported/other channels continue to be resolved by the
 * execution route rather than guessed here. */
export function requiredPlanningHealthCapability(
  actionType: string,
  payload: Record<string, unknown>,
): ActionPlanningCapability | null {
  if (actionType === "place_call") return "governed_voice";
  if ((actionType === "send_message" || actionType === "notify_group") && payload.channel === "email") {
    return "governed_email";
  }
  if ((actionType === "send_message" || actionType === "notify_group") && payload.channel === "sms") {
    return "governed_sms";
  }
  return null;
}

/** Inspect the exact route execution would select now. The result is secret-free,
 * but includes the selected provider/channel so compiled plans bind to real
 * execution capability rather than a similarly named tenant integration. */
export async function planningHealthForAction(params: {
  tenantId: string;
  actorId?: string;
  actionType: string;
  payload: Record<string, unknown>;
}): Promise<ActionPlanningHealth | null> {
  const capability = requiredPlanningHealthCapability(params.actionType, params.payload);
  if (!capability) return null;
  if (params.actionType !== "send_message" && params.actionType !== "notify_group" && params.actionType !== "place_call") {
    return { capability, health: "unavailable", provider: null, selectedChannel: null, reason: `${capability} route is unsupported` };
  }
  const current = await inspectCommunicationActionAvailability({
    tenantId: params.tenantId,
    ...(params.actorId ? { actorId: params.actorId } : {}),
    actionType: params.actionType,
    payload: params.payload,
  }).catch((error) => ({
    available: false,
    provider: null,
    selectedChannel: null,
    reason: error instanceof Error ? error.message : `${capability} route health is unavailable`,
  }));
  return {
    capability,
    health: current.available ? "available" : "unavailable",
    provider: current.provider,
    selectedChannel: current.selectedChannel,
    reason: current.reason,
  };
}

async function capabilityHealth(
  tenantId: string,
  capability: ActivePlanningCapability,
  provider: "vapi" | "resend",
): Promise<PlanningCapabilityHealth> {
  const [configured, circuit] = await Promise.all([
    tenantProviderConfigured(tenantId, provider),
    circuitSnapshot(provider, tenantId),
  ]);
  const open = circuit.state === "open";
  const unavailable = !configured || open;
  return {
    capability,
    binding: provider,
    source: "tenant",
    health: open ? "down" : configured ? "ok" : "unknown",
    circuit: open ? "open" : "closed",
    unavailable,
    reason: open ? `${provider} circuit breaker is open` : configured ? null : `${provider} is not configured`,
  };
}

export async function buildPlanningHealthContext(tenantId: string): Promise<PlanningHealthContext> {
  const [employeeVoice, transactionalEmail] = await Promise.all([
    capabilityHealth(tenantId, "employee_voice", "vapi"),
    capabilityHealth(tenantId, "transactional_email", "resend"),
  ]);
  return { employee_voice: employeeVoice, transactional_email: transactionalEmail };
}

// Runtime route resolution remains the authoritative transport gate. There is no
// Retired-vertical fallback actions are never synthesized when a provider is absent.
export function manualStepForUnavailableIntegration(
  _actionType: string,
  _payload: Record<string, unknown>,
  _health: PlanningHealthContext,
): null {
  return null;
}
