import { z } from "zod";
import { CapabilityJsonTransport, CapabilityProviderError } from "./capabilities/provider-json";

const remoteId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const providerWebReference = z.string().min(1).max(4096).refine(value => {
  try { const url = new URL(value.includes(":") ? value : `https://${value}`); return ["https:", "http:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}, "INVALID_PROVIDER_WEB_REFERENCE");
const citation = z.object({ url: providerWebReference, title: z.string().nullish(), excerpts: z.array(z.string()).nullish() }).passthrough();
const basis = z.object({ field: z.string(), citations: z.array(citation).nullish().transform(value => value ?? []), reasoning: z.string().nullish(), confidence: z.unknown().optional() }).passthrough();
const taskRun = z.object({ run_id: remoteId, status: z.string(), is_active: z.boolean().optional() }).passthrough();
const taskOutput = z.object({ type: z.enum(["json", "text"]), content: z.unknown(), basis: z.array(basis).nullish().transform(value => value ?? []) }).passthrough();
const findRun = z.object({ findall_id: remoteId, status: z.object({ status: z.string(), is_active: z.boolean() }).passthrough() }).passthrough();
const monitor = z.object({ monitor_id: remoteId, status: z.string(), frequency: z.string() }).passthrough();
const findCandidate = z.object({ candidate_id: remoteId, name: z.string(), url: providerWebReference.nullish(), match_status: z.string(), basis: z.array(basis).nullish().transform(value => value ?? []) }).passthrough();

export interface ParallelConfiguration { apiKey: string; baseUrl?: string }
export type ParallelTaskProcessor = "lite" | "base" | "core" | "pro" | "ultra";
export class ParallelResearchClient {
  private readonly transport: CapabilityJsonTransport;
  constructor(config: ParallelConfiguration) {
    if (!config.apiKey.trim()) throw new CapabilityProviderError("parallel", "API_KEY_REQUIRED", "BEFORE_DISPATCH");
    this.transport = new CapabilityJsonTransport("parallel", config.baseUrl ?? "https://api.parallel.ai", { "x-api-key": config.apiKey });
  }

  private async acknowledge<T>(schema: z.ZodType<T>, pending: Promise<unknown>): Promise<T> {
    const response = await pending, parsed = schema.safeParse(response);
    if (!parsed.success) throw new CapabilityProviderError("parallel", "ACKNOWLEDGEMENT_SCHEMA_INVALID", "UNKNOWN");
    return parsed.data;
  }

  async createTask(input: { text: string; outputSchema: Record<string, unknown>; processor: ParallelTaskProcessor; correlationId: string; deadlineAt: number }) {
    return this.acknowledge(taskRun, this.transport.request({ method: "POST", path: "/v1/tasks/runs", deadlineAt: input.deadlineAt,
      body: { input: input.text, processor: input.processor, task_spec: { output_schema: { type: "json", json_schema: input.outputSchema } }, metadata: { finnor_run_id: input.correlationId } } }));
  }

  async taskStatus(id: string, deadlineAt: number) {
    return taskRun.parse(await this.transport.request({ method: "GET", path: `/v1/tasks/runs/${remoteId.parse(id)}`, deadlineAt }));
  }

  async taskResult(id: string, deadlineAt: number) {
    return z.object({ run: taskRun, output: taskOutput }).passthrough().parse(
      await this.transport.request({ method: "GET", path: `/v1/tasks/runs/${remoteId.parse(id)}/result?timeout=5`, deadlineAt }));
  }

  async createFindAll(input: { objective: string; entityType: "companies" | "people" | "products" | "other"; conditions: Array<{ name: string; description: string }>; matchLimit: number; generator?: "core" | "preview"; correlationId: string; deadlineAt: number }) {
    return this.acknowledge(findRun, this.transport.request({ method: "POST", path: "/v1beta/findall/runs", deadlineAt: input.deadlineAt,
      body: { objective: input.objective, entity_type: input.entityType, match_conditions: input.conditions, generator: input.generator ?? "core", match_limit: input.matchLimit, metadata: { finnor_run_id: input.correlationId } } }));
  }

  async findAllStatus(id: string, deadlineAt: number) {
    return findRun.parse(await this.transport.request({ method: "GET", path: `/v1beta/findall/runs/${remoteId.parse(id)}`, deadlineAt }));
  }

  async findAllResult(id: string, deadlineAt: number) {
    return z.object({ run: findRun, candidates: z.array(findCandidate), last_event_id: z.string().nullish() }).passthrough().parse(
      await this.transport.request({ method: "GET", path: `/v1beta/findall/runs/${remoteId.parse(id)}/result`, deadlineAt }));
  }

  async cancelFindAll(id: string, deadlineAt: number): Promise<void> {
    await this.transport.request({ method: "POST", path: `/v1beta/findall/runs/${remoteId.parse(id)}/cancel`, deadlineAt });
  }

  async createMonitor(input: { query: string; cadence: "hourly" | "daily" | "weekly"; correlationId: string; deadlineAt: number; webhookUrl?: string }) {
    const frequencies = { hourly: "1h", daily: "1d", weekly: "1w" } as const;
    return this.acknowledge(monitor, this.transport.request({ method: "POST", path: "/v1/monitors", deadlineAt: input.deadlineAt,
      body: { type: "event_stream", frequency: frequencies[input.cadence], processor: "lite", settings: { query: input.query }, metadata: { external_id: input.correlationId },
        ...(input.webhookUrl ? { webhook: { url: input.webhookUrl, event_types: ["monitor.event.detected"] } } : {}) } }));
  }

  async monitorStatus(id: string, deadlineAt: number) {
    return monitor.parse(await this.transport.request({ method: "GET", path: `/v1/monitors/${remoteId.parse(id)}`, deadlineAt }));
  }

  async monitorEvents(id: string, eventGroupId: string | undefined, deadlineAt: number) {
    const event = z.discriminatedUnion("event_type", [
      z.object({ event_type: z.literal("event_stream"), event_id: remoteId, event_group_id: remoteId, event_date: z.string().nullable(), output: taskOutput }).passthrough(),
      z.object({ event_type: z.literal("completion"), timestamp: z.string().datetime({ offset: true }) }).passthrough(),
      z.object({ event_type: z.literal("error"), timestamp: z.string().datetime({ offset: true }), error_message: z.string() }).passthrough(),
    ]);
    const query = eventGroupId ? `event_group_id=${encodeURIComponent(remoteId.parse(eventGroupId))}` : "include_completions=true&limit=10";
    return z.object({ events: z.array(event).max(eventGroupId ? 10_000 : 10), next_cursor: z.string().nullish() }).passthrough()
      .refine(value => !eventGroupId || value.events.every(event => event.event_type !== "event_stream" || event.event_group_id === eventGroupId), "MONITOR_EVENT_GROUP_MISMATCH").parse(
      await this.transport.request({ method: "GET", path: `/v1/monitors/${remoteId.parse(id)}/events?${query}`, deadlineAt }));
  }

  async cancelMonitor(id: string, deadlineAt: number) {
    return this.acknowledge(monitor.refine(value => value.monitor_id === id && value.status === "cancelled", "MONITOR_CANCELLATION_NOT_CONFIRMED"),
      this.transport.request({ method: "POST", path: `/v1/monitors/${remoteId.parse(id)}/cancel`, deadlineAt }));
  }
}
