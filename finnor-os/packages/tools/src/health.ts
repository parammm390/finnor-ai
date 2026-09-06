// Shared integration health-check helpers — factored out of the /api/integrations/status
// route so /api/setup/status can reuse the exact same checks without duplicating them.

import { connectVapi } from "./mcp-client";
import { type VoiceAgentKey, type VoicePersona } from "./voice-personas";
import type { TenantCredentialContext } from "@finnor/security";

export interface HealthEntry {
  configured: boolean;
  healthy: boolean | null;
  error?: string;
  note?: string;
}

export async function testVapiConnection(context: TenantCredentialContext<"vapi">): Promise<HealthEntry> {
  try {
    const conn = await connectVapi(context);
    await conn.close().catch(() => undefined);
    return { configured: true, healthy: true };
  } catch {
    return { configured: true, healthy: false, error: "Vapi authenticated connection failed" };
  }
}

export interface VoiceAssistantHealth extends HealthEntry {
  agentKey: VoiceAgentKey;
  personaKey: VoicePersona;
}

/** Verifies each bounded assistant binding without exposing provider assistant IDs.
 * Vapi documents GET /assistant/:id as the authoritative existence/read check. */
export async function testVapiAssistants(context: TenantCredentialContext<"vapi">): Promise<VoiceAssistantHealth[]> {
  try {
    const response = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(context.credentials.assistantId)}`, {
      headers: { authorization: `Bearer ${context.credentials.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return [{
      agentKey: "jarvis",
      personaKey: "main",
      configured: true,
      healthy: response.ok,
      ...(response.ok ? {} : { error: `Assistant verification failed (${response.status})` }),
    }];
  } catch {
    return [{ agentKey: "jarvis", personaKey: "main", configured: true, healthy: false, error: "Assistant verification request failed" }];
  }
}
