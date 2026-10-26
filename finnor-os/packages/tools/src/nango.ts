import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CapabilityJsonTransport, CapabilityProviderError } from "./capabilities/provider-json";

const opaqueId = z.string().min(1).max(512).refine(value => !/[\r\n]/.test(value));
export const NangoSourceBindingSchema = z.object({
  tenantId: z.string().uuid(), integrationId: z.string().uuid(), sourceScopeId: z.string().uuid(),
  providerConfigKey: opaqueId, connectionId: opaqueId, models: z.array(z.string().min(1).max(128)).min(1).max(32),
  readOnly: z.literal(true), connectionEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type NangoSourceBinding = z.infer<typeof NangoSourceBindingSchema>;
const recordMetadata = z.object({
  cursor: z.string().min(1).max(4096), last_action: z.enum(["ADDED", "UPDATED", "DELETED"]),
  first_seen_at: z.string(), last_modified_at: z.string(), deleted_at: z.string().nullable(), pruned_at: z.string().nullish(),
}).passthrough();
const record = z.object({ id: z.union([z.string(), z.number().finite()]).transform(String), _nango_metadata: recordMetadata }).passthrough();
const recordsPage = z.object({ records: z.array(record).max(100), next_cursor: z.string().nullable() }).strict();
export type NangoRecordsPage = z.infer<typeof recordsPage>;
const connectSession = z.object({ data: z.object({ token: z.string().min(1), expires_at: z.string(), connect_link: z.string().url().optional() }) });

export class NangoReadOnlyClient {
  private readonly transport: CapabilityJsonTransport;
  constructor(config: { apiKey: string; baseUrl?: string }) {
    if (!config.apiKey.trim()) throw new CapabilityProviderError("nango", "API_KEY_REQUIRED", "BEFORE_DISPATCH");
    this.transport = new CapabilityJsonTransport("nango", config.baseUrl ?? "https://api.nango.dev", { authorization: `Bearer ${config.apiKey}` });
    this.config = config;
  }
  private readonly config: { apiKey: string; baseUrl?: string };

  async createConnectSession(input: { tenantId: string; principalId: string; bindingIntentId: string; providerConfigKey: string; deadlineAt: number }) {
    const raw = await this.transport.request({ method: "POST", path: "/connect/sessions", deadlineAt: input.deadlineAt,
      body: { allowed_integrations: [input.providerConfigKey], tags: { organization_id: input.tenantId, end_user_id: input.principalId, finnor_binding_intent: input.bindingIntentId } } });
    const parsed = connectSession.safeParse(raw);
    if (!parsed.success) throw new CapabilityProviderError("nango", "CONNECT_ACKNOWLEDGEMENT_INVALID", "UNKNOWN");
    return parsed.data.data;
  }

  async connectionStatus(input: { providerConfigKey: string; connectionId: string; deadlineAt: number }) {
    const query = new URLSearchParams({ provider_config_key: input.providerConfigKey, refresh_token: "false" });
    try {
      const raw = await this.transport.request({ method: "GET", path: `/connections/${encodeURIComponent(input.connectionId)}?${query}`, deadlineAt: input.deadlineAt, maxBytes: 262_144 });
      // Credentials can exist in this provider response. Parse only identity and
      // health; no caller, log or durable object receives those credentials.
      const value = z.object({ connection_id: z.literal(input.connectionId), provider_config_key: z.literal(input.providerConfigKey), tags: z.record(z.string(), z.string()),
        errors: z.array(z.object({ type: z.string() }).strip()).max(100) }).strip().parse(raw);
      return { state: value.errors.some(error => error.type === "auth") ? "AUTH_ERROR" as const : "HEALTHY" as const, tags: value.tags };
    } catch (error) {
      if (error instanceof CapabilityProviderError && error.httpStatus === 404) return { state: "MISSING" as const, tags: null };
      if (error instanceof CapabilityProviderError && error.httpStatus === 424) return { state: "AUTH_ERROR" as const, tags: null };
      throw error;
    }
  }

  async readRecords(input: { binding: NangoSourceBinding; tenantId: string; model: string; cursor: string | null; deadlineAt: number }): Promise<NangoRecordsPage> {
    const binding = NangoSourceBindingSchema.parse(input.binding);
    if (binding.tenantId !== input.tenantId || !binding.models.includes(input.model))
      throw new CapabilityProviderError("nango", "SOURCE_BINDING_DENIED", "BEFORE_DISPATCH");
    const query = new URLSearchParams({ model: input.model, limit: "100", ...(input.cursor ? { cursor: input.cursor } : {}) });
    const scoped = new CapabilityJsonTransport("nango", this.config.baseUrl ?? "https://api.nango.dev", {
      authorization: `Bearer ${this.config.apiKey}`, "Connection-Id": binding.connectionId, "Provider-Config-Key": binding.providerConfigKey,
    });
    // No action filter: deletions must travel through the same durable stream.
    const page = recordsPage.parse(await scoped.request({ method: "GET", path: `/records?${query}`, deadlineAt: input.deadlineAt }));
    if (input.cursor !== null && page.next_cursor === input.cursor) throw new CapabilityProviderError("nango", "CURSOR_NOT_ADVANCING", "REJECTED");
    return page;
  }
}

export const NangoWebhookSchema = z.object({
  type: z.string(), connectionId: opaqueId.optional(), providerConfigKey: opaqueId.optional(),
  operation: z.string().optional(), success: z.boolean().optional(), model: z.string().optional(),
  syncName: z.string().optional(), tags: z.record(z.string(), z.string()).optional(),
}).passthrough();

/** The distinct webhook signing key is required. Do not fall back to the API key
 * or the legacy plain-hash signature. Verify exact raw bytes before JSON parsing. */
export function verifyNangoWebhook(raw: Buffer, signature: string | null, signingKey: string): boolean {
  if (!signingKey || !signature || !/^[a-fA-F0-9]{64}$/.test(signature) || raw.length > 1_048_576) return false;
  const expected = createHmac("sha256", signingKey).update(raw).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
