import {
  resolveSystemCredentialContext,
  resolveTenantCredentialContext,
  TenantCredentialError,
  type TenantCredentialContext,
} from "@finnor/security";
import type { ProviderHealth } from "./errors";
import { testVapiAssistants, testVapiConnection, type VoiceAssistantHealth } from "./health";

export type ActiveTenantProvider = "vapi" | "resend";

function resolutionHealth(error: unknown, provider: ActiveTenantProvider): ProviderHealth {
  if (error instanceof TenantCredentialError) {
    if (error.code === "integration_not_bound") return { configured: false, healthy: null };
    return { configured: false, healthy: false, error: `${provider} tenant credentials are unavailable (${error.code})` };
  }
  return { configured: false, healthy: false, error: `${provider} tenant credential resolution failed` };
}

export function resolveTenantVapiContext(tenantId: string): Promise<TenantCredentialContext<"vapi">> {
  return resolveTenantCredentialContext(tenantId, "vapi");
}

export async function resolveTenantResendContext(tenantId: string): Promise<TenantCredentialContext<"resend">> {
  try {
    return await resolveTenantCredentialContext(tenantId, "resend");
  } catch (error) {
    // A missing tenant binding may use the explicitly enabled system sender.
    // Invalid tenant references never fall through to shared credentials.
    if (error instanceof TenantCredentialError && error.code === "integration_not_bound") {
      return resolveSystemCredentialContext(tenantId, "resend");
    }
    throw error;
  }
}

export async function tenantProviderConfigured(tenantId: string, provider: ActiveTenantProvider): Promise<boolean> {
  try {
    if (provider === "resend") await resolveTenantResendContext(tenantId);
    else await resolveTenantVapiContext(tenantId);
    return true;
  } catch {
    return false;
  }
}

export async function testTenantVapiConnection(tenantId: string): Promise<ProviderHealth> {
  try {
    return testVapiConnection(await resolveTenantVapiContext(tenantId));
  } catch (error) {
    return resolutionHealth(error, "vapi");
  }
}

export async function testTenantVapiAssistants(tenantId: string): Promise<VoiceAssistantHealth[]> {
  try {
    return testVapiAssistants(await resolveTenantVapiContext(tenantId));
  } catch (error) {
    const health = resolutionHealth(error, "vapi");
    return [{ agentKey: "jarvis", personaKey: "main", ...health }];
  }
}

export async function tenantResendStatus(tenantId: string): Promise<ProviderHealth> {
  try {
    await resolveTenantResendContext(tenantId);
    return { configured: true, healthy: null };
  } catch (error) {
    return resolutionHealth(error, "resend");
  }
}
