// Active planning health is intentionally small after the Water retirement.
// Private Equity mutations are canonical database operations; the only external
// transports exposed to the general planner are Core employee voice and email.

import { circuitSnapshot, tenantProviderConfigured } from "@finnor/tools";

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
