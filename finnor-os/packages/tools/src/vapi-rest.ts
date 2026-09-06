// Vapi REST client for outbound calls (voice confirmations + spoken failure alerts).
// Wrapped like every other integration: timeout, retry, typed errors — no bare fetch.

import { wrappedCall, type ToolCallResult } from "./wrap";
import { IntegrationError } from "./errors";
import type { TenantCredentialContext } from "@finnor/security";

export type VapiCredentialContext = TenantCredentialContext<"vapi">;

export interface OutboundCallOpts {
  tenantId: string;
  /** E.164 employee or governed business-party destination. */
  destinationNumber: string;
  /** What the assistant says the moment the call connects. */
  firstMessage: string;
  /** Carried on the call object; comes back in the end-of-call webhook. */
  metadata?: Record<string, unknown>;
  /** Values consumed by {{variableName}} placeholders in the saved assistant. */
  variableValues?: Record<string, string>;
  assistantId?: string;
}

export async function placeVapiCall(opts: OutboundCallOpts, context: VapiCredentialContext): Promise<ToolCallResult> {
  return wrappedCall("vapi", async () => {
    if (context.tenantId !== opts.tenantId) throw new IntegrationError("vapi", "Vapi credential context tenant mismatch", false);
    const { apiKey, phoneNumberId } = context.credentials;
    const allowedAssistantIds = new Set([context.credentials.assistantId, ...Object.values(context.credentials.assistantIds ?? {})]);
    if (opts.assistantId && !allowedAssistantIds.has(opts.assistantId)) {
      throw new IntegrationError("vapi", "Requested assistant is not part of the tenant credential context", false);
    }
    const assistantId = opts.assistantId ?? context.credentials.assistantId;
    if (!assistantId) throw new IntegrationError("vapi", "VAPI_ASSISTANT_ID is not set", false);

    const res = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        assistantId,
        phoneNumberId,
        // `customer.number` is Vapi's wire-field name; FINNOR models this as a
        // governed destination rather than a legacy product-domain party.
        customer: { number: opts.destinationNumber },
        metadata: { ...(opts.metadata ?? {}), tenantId: opts.tenantId },
        assistantOverrides: {
          firstMessage: opts.firstMessage,
          ...(opts.variableValues ? { variableValues: opts.variableValues } : {}),
        },
      }),
    });
    if (!res.ok) {
      throw new IntegrationError("vapi", `create call failed (${res.status})`, res.status >= 500);
    }
    return (await res.json()) as Record<string, unknown>;
  });
}

export interface VapiCallRecord extends Record<string, unknown> {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
}

export async function readVapiCall(id: string, context: VapiCredentialContext): Promise<VapiCallRecord | null> {
  const response = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${context.credentials.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403;
    throw new IntegrationError("vapi", `get call failed (${response.status})`, !authFailure && (response.status === 429 || response.status >= 500), authFailure ? "auth" : "retryable");
  }
  return response.json() as Promise<VapiCallRecord>;
}

export async function listVapiCalls(
  context: VapiCredentialContext,
  options: { limit?: number; createdAtGe?: string; createdAtLt?: string } = {},
): Promise<VapiCallRecord[]> {
  const query = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, options.limit ?? 100))) });
  if (options.createdAtGe) query.set("createdAtGe", options.createdAtGe);
  if (options.createdAtLt) query.set("createdAtLt", options.createdAtLt);
  const response = await fetch(`https://api.vapi.ai/call?${query.toString()}`, {
    headers: { authorization: `Bearer ${context.credentials.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const authFailure = response.status === 401 || response.status === 403;
    throw new IntegrationError("vapi", `list calls failed (${response.status})`, !authFailure && (response.status === 429 || response.status >= 500), authFailure ? "auth" : "retryable");
  }
  const payload: unknown = await response.json();
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).results)
      ? (payload as Record<string, unknown>).results as unknown[]
      : [];
  return candidates.filter((row): row is VapiCallRecord => Boolean(row) && typeof row === "object" && typeof (row as { id?: unknown }).id === "string");
}
