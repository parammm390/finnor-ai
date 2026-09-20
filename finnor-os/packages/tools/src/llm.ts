// LLM provider abstraction for JARVIS. Provider choice is explicit and routed by
// purpose/channel; there is intentionally no unnamed provider default. A model can
// still be pinned per action_type via domain_policies (model_provider column), a
// config change rather than a code change.
//
// Lives in @finnor/tools (not @finnor/orchestration) specifically so domain-plugins
// can use it too — domain-plugins already depends on tools, and orchestration depends
// on domain-plugins, so a copy in orchestration would create a package cycle the
// moment a plugin needed an LLM call (the ops-overview grounded-QA action does).

import Groq from "groq-sdk";
import { withTenant, decisionReceipts, llmCalls, tenantLlmBudgets, withGovernedModelInvocation, ComputeCapacityUnavailableError } from "@finnor/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { initObservability, Sentry } from "./observability";
import { orderProvidersByHealth, recordOutcome } from "./provider-health";

export type LLMPurpose = "planning" | "critic" | "repair" | "classification" | "answer";
export type LLMChannel = "voice" | "text" | "console" | "background";
export interface LLMCallOptions {
  system: string;
  user: string;
  json?: boolean;
  model?: string;
  tenantId?: string;
  actionId?: string;
  traceId?: string;
  purpose?: LLMPurpose;
  channel?: LLMChannel;
  urgent?: boolean;
  /** Absolute Unix epoch deadline shared by every provider in a fallback chain. */
  deadlineAt?: number;
  /** Relative convenience form; converted to deadlineAt once at call entry. */
  deadlineMs?: number;
  /** Legacy alias for deadlineMs. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface LLMUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface LLMProvider {
  name: string;
  /** Usage belongs to the immediately preceding complete() call. Providers that do
   * not return it leave it undefined rather than estimating it. */
  lastUsage?: LLMUsage;
  /** The concrete provider used by the immediately preceding call. Composite
   * providers expose this so ledgers and observability do not record "composite". */
  selectedProviderName?: string;
  /** Composite providers record each attempt themselves; the outer wrapper must
   * not add a second synthetic health sample. */
  recordsHealthInternally?: boolean;
  complete(opts: LLMCallOptions): Promise<string>;
}

export class LLMProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMProviderSelectionError";
  }
}

export class LLMDeadlineExceededError extends Error {
  constructor(readonly deadlineAt: number) {
    super("LLM call deadline exceeded");
    this.name = "LLMDeadlineExceededError";
  }
}

const DEFAULT_DEADLINE_MS: Record<LLMChannel, number> = {
  voice: 3_500,
  text: 8_000,
  console: 8_000,
  background: 15_000,
};

function normalizeCallOptions(opts: LLMCallOptions): LLMCallOptions {
  if (Number.isFinite(opts.deadlineAt)) return opts;
  const relative = opts.deadlineMs ?? opts.timeoutMs ?? DEFAULT_DEADLINE_MS[opts.channel ?? "text"];
  return { ...opts, deadlineAt: Date.now() + Math.max(0, relative) };
}

function remainingMs(opts: LLMCallOptions, fallbackMs: number): number {
  const remaining = Number.isFinite(opts.deadlineAt) ? Number(opts.deadlineAt) - Date.now() : fallbackMs;
  return Math.max(0, Math.min(fallbackMs, remaining));
}

function isAbortLike(error: unknown): boolean {
  return error instanceof LLMDeadlineExceededError || (error instanceof Error && error.name === "AbortError");
}

/** Amazon Bedrock long-lived API keys are exposed by AWS as a bearer token. Keep
 * the repository's established variable name while also accepting AWS's standard
 * name so the same single Bedrock credential works in every deployment surface. */
function bedrockApiKey(): string | undefined {
  return process.env.AWS_BEDROCK_API_KEY ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
}

function assertSelectedAwsRegion(region: string): void {
  const selected = process.env.AWS_REGION ?? process.env.FINNOR_PROJECT_REGION;
  if (selected && selected !== region) throw new Error(`Bedrock model region ${region} differs from selected project Region ${selected}`);
}

/** Fetch with both the caller's signal and the shared absolute deadline. The
 * provider-specific timeout is only a ceiling; fallbacks receive the same
 * deadlineAt and therefore cannot restart the full timeout budget. */
async function fetchWithCallBudget(url: string, init: RequestInit, opts: LLMCallOptions, providerCeilingMs = 8_000): Promise<Response> {
  const normalized = normalizeCallOptions(opts);
  const budgetMs = remainingMs(normalized, providerCeilingMs);
  if (budgetMs <= 0) throw new LLMDeadlineExceededError(normalized.deadlineAt ?? Date.now());

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(normalized.signal?.reason);
  if (normalized.signal?.aborted) onCallerAbort();
  else normalized.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const sharedDeadlineOwnsTimer = Number.isFinite(normalized.deadlineAt) && Number(normalized.deadlineAt) - Date.now() <= providerCeilingMs;
  const timerError = sharedDeadlineOwnsTimer
    ? new LLMDeadlineExceededError(normalized.deadlineAt ?? Date.now() + budgetMs)
    : Object.assign(new Error("LLM provider timeout"), { name: "ProviderTimeoutError" });
  const timer = setTimeout(() => controller.abort(timerError), budgetMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Keep the same physical deadline active through body consumption. Fetch
    // resolves at headers; without this a stalled response body could outlive
    // the model permit and be overlapped by its later expiry.
    const boundedResponse = typeof response.arrayBuffer === "function"
      ? new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
      : response;
    if (Number.isFinite(normalized.deadlineAt) && Date.now() >= Number(normalized.deadlineAt)) throw new LLMDeadlineExceededError(Number(normalized.deadlineAt));
    return boundedResponse;
  } catch (error) {
    if (normalized.signal?.aborted) throw normalized.signal.reason ?? Object.assign(new Error("LLM request aborted"), { name: "AbortError" });
    if (Number.isFinite(normalized.deadlineAt) && Date.now() >= Number(normalized.deadlineAt)) {
      throw new LLMDeadlineExceededError(Number(normalized.deadlineAt));
    }
    if (controller.signal.aborted) throw timerError;
    throw error;
  } finally {
    clearTimeout(timer);
    normalized.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Raised before a non-urgent call once the configured hard daily cap is reached.
 * Callers can turn this into an honest CONFIG/deferred receipt; it is never a fake
 * provider failure or a silent fallback. */
export class LLMBudgetDeferredError extends Error {
  constructor(readonly tenantId: string, readonly usedTokens: number, readonly limitTokens: number) {
    super(`LLM daily token budget reached (${usedTokens}/${limitTokens}); non-urgent work deferred to the next window`);
    this.name = "LLMBudgetDeferredError";
  }
}

export class LLMBudgetUnknownUsageError extends Error {
  constructor(readonly tenantId: string, readonly unmeteredCalls: number) {
    super(`LLM daily token budget cannot be proven because ${unmeteredCalls} completed call(s) have unknown usage`);
    this.name = "LLMBudgetUnknownUsageError";
  }
}

async function enforceBudget(opts: LLMCallOptions): Promise<void> {
  if (!opts.tenantId || opts.urgent) return;
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const budget = await withTenant(opts.tenantId, async (db) => {
    const [row] = await db.select().from(tenantLlmBudgets).where(eq(tenantLlmBudgets.tenantId, opts.tenantId!));
    if (!row) return null;
    const [usage] = await db.select({
      tokens: sql<number>`coalesce(sum(${llmCalls.inputTokens} + ${llmCalls.outputTokens}) FILTER (WHERE ${llmCalls.status}='completed'), 0)`,
      unknown: sql<number>`count(*) FILTER (WHERE ${llmCalls.status}='completed' AND (${llmCalls.inputTokens} IS NULL OR ${llmCalls.outputTokens} IS NULL))`,
    })
      .from(llmCalls).where(and(eq(llmCalls.tenantId, opts.tenantId!), gte(llmCalls.createdAt, start)));
    return { ...row, used: Number(usage?.tokens ?? 0), unknown: Number(usage?.unknown ?? 0) };
  });
  if (budget && budget.unknown > 0) throw new LLMBudgetUnknownUsageError(opts.tenantId, budget.unknown);
  if (budget && budget.used >= budget.dailyTokenBudget) throw new LLMBudgetDeferredError(opts.tenantId, budget.used, budget.dailyTokenBudget);
}

function configuredCostUsd(usage: LLMUsage | undefined): number | null {
  if (!usage || usage.inputTokens === null || usage.outputTokens === null) return null;
  // Rates are deployment configuration, never hard-coded market-price claims.
  const inputRate = Number(process.env.LLM_INPUT_USD_PER_MILLION);
  const outputRate = Number(process.env.LLM_OUTPUT_USD_PER_MILLION);
  if (!Number.isFinite(inputRate) || !Number.isFinite(outputRate)) return null;
  return (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000;
}

async function recordCall(provider: LLMProvider, opts: LLMCallOptions, status: "completed" | "deferred" | "failed", detail: Record<string, unknown> = {}): Promise<void> {
  if (!opts.tenantId) return;
  const usage = provider.lastUsage;
  const providerName = provider.selectedProviderName ?? provider.name;
  await withTenant(opts.tenantId, async (db) => {
    await db.insert(llmCalls).values({
      tenantId: opts.tenantId!, domainActionId: opts.actionId ?? null, traceId: opts.traceId ?? null,
      purpose: opts.purpose ?? "answer", provider: providerName, model: usage?.model ?? "unknown",
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      costUsd: configuredCostUsd(usage), status, detail,
    });
    // A deferred action has no external effect, but it is still a decision the
    // operator needs to see. This standalone CONFIG receipt makes that explicit.
    if (status === "deferred" && opts.actionId) {
      await db.insert(decisionReceipts).values({
        tenantId: opts.tenantId!, domainActionId: opts.actionId, objective: "LLM work deferred by a configured resource limit",
        evidence: [], policyApplied: null, riskTier: "low", proposedAction: {}, approval: { required: false },
        failure: { errorKind: "config", message: String(detail.error ?? "LLM resource unavailable"), recoveryPath: "Retry when the resource or known-usage budget is available." },
        correlationId: opts.traceId ?? null, finalizedAt: new Date(),
      });
    }
  });
}

interface OpenAICompatibleResponse {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
}

function chatContent(data: OpenAICompatibleResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("") ?? "";
}

/** Shared direct-fetch adapter for providers with the OpenAI-compatible chat API.
 * Keys are read from the process environment at provider construction time; no
 * credential is part of routing configuration or source control. */
class OpenAICompatibleProvider implements LLMProvider {
  lastUsage?: LLMUsage;

  constructor(
    public readonly name: string,
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly endpoint: string,
  ) {}

  async complete(opts: LLMCallOptions): Promise<string> {
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()}_API_KEY is not set`);
    this.lastUsage = undefined;
    const model = opts.model ?? this.model;
    return withGovernedModelInvocation({ provider: this.name, model, tenantId: opts.tenantId, channel: opts.channel }, async () => {
    const res = await fetchWithCallBudget(
      this.endpoint,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          temperature: 0.1,
          max_tokens: 700,
          // Preserve the existing contract: callers validate/parse the returned JSON;
          // the adapter only asks the provider for an object-shaped response.
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      opts,
      8_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${this.name} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as OpenAICompatibleResponse;
    this.lastUsage = {
      model,
      inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? null,
    };
    return chatContent(data);
    });
  }
}

export class MistralProvider extends OpenAICompatibleProvider {
  constructor(
    apiKey = process.env.MISTRAL_API_KEY,
    model = process.env.MISTRAL_MODEL ?? "mistral-small-latest",
    baseUrl = process.env.MISTRAL_API_BASE_URL ?? "https://api.mistral.ai/v1",
  ) {
    super("mistral", apiKey, model, `${baseUrl.replace(/\/$/, "")}/chat/completions`);
  }
}

/** Direct DeepSeek support is optional; when only AWS Bedrock is configured the
 * registry's deepseek alias uses the existing Bedrock Converse adapter instead. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    apiKey = process.env.DEEPSEEK_API_KEY,
    model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    baseUrl = process.env.DEEPSEEK_API_BASE_URL ?? "https://api.deepseek.com/v1",
  ) {
    super("deepseek", apiKey, model, `${baseUrl.replace(/\/$/, "")}/chat/completions`);
  }
}

/** Legacy explicit-only Bedrock Anthropic adapter. It is not part of any JARVIS
 * default route; GLM/Mistral/DeepSeek are the configured first-party choices. */
export class BedrockAnthropicProvider implements LLMProvider {
  name = "bedrock-anthropic";
  lastUsage?: LLMUsage;
  constructor(
    private modelId: string,
    private apiKey = bedrockApiKey(),
    private region = process.env.AWS_BEDROCK_REGION ?? "us-east-1",
  ) {}

  async complete(opts: LLMCallOptions): Promise<string> {
    if (!this.apiKey) throw new Error("AWS_BEDROCK_API_KEY or AWS_BEARER_TOKEN_BEDROCK is not set");
    assertSelectedAwsRegion(this.region);
    this.lastUsage = undefined;
    return withGovernedModelInvocation({ provider: "bedrock", model: this.modelId, tenantId: opts.tenantId, channel: opts.channel }, async () => {
    const res = await fetchWithCallBudget(
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/${this.modelId}/invoke`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 700,
          temperature: 0.1,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
        }),
      },
      opts,
      8_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bedrock (${this.modelId}) failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    this.lastUsage = { model: this.modelId, inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null };
    return data.content?.[0]?.text ?? "";
    });
  }
}

/**
 * Bedrock Converse is the shared request/response format for the non-Anthropic
 * models used by JARVIS (GLM, Mistral, Qwen, DeepSeek, OpenAI OSS, and Amazon Nova). Keeping this
 * adapter model-agnostic lets the routing policy change without coupling the rest of
 * the system to each vendor's InvokeModel payload shape.
 */
export class BedrockConverseProvider implements LLMProvider {
  readonly name: string;
  lastUsage?: LLMUsage;
  constructor(
    private modelId: string,
    private apiKey = bedrockApiKey(),
    private region = process.env.AWS_BEDROCK_REGION ?? "us-east-1",
    name = "bedrock-converse",
  ) {
    this.name = name;
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    if (!this.apiKey) throw new Error("AWS_BEDROCK_API_KEY or AWS_BEARER_TOKEN_BEDROCK is not set");
    assertSelectedAwsRegion(this.region);
    this.lastUsage = undefined;
    return withGovernedModelInvocation({ provider: "bedrock", model: this.modelId, tenantId: opts.tenantId, channel: opts.channel }, async () => {
    const res = await fetchWithCallBudget(
      `https://bedrock-runtime.${this.region}.amazonaws.com/model/${this.modelId}/converse`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          system: [{ text: opts.system }],
          messages: [
            { role: "user", content: [{ text: opts.user }] },
          ],
          inferenceConfig: { maxTokens: 700, temperature: 0.1 },
        }),
      },
      opts,
      8_000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bedrock (${this.modelId}) failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { output?: { message?: { content?: Array<{ text?: string }> } }; usage?: { inputTokens?: number; outputTokens?: number } };
    this.lastUsage = { model: this.modelId, inputTokens: data.usage?.inputTokens ?? null, outputTokens: data.usage?.outputTokens ?? null };
    return data.output?.message?.content?.map((block) => block.text ?? "").join("") ?? "";
    });
  }
}

// Compatibility export for existing callers. All current non-Anthropic Bedrock
// routing intentionally uses Converse; new callers should use the explicit name.
export { BedrockConverseProvider as BedrockOpenAICompatProvider };

/** Tries each provider in order — different vendor, different failure modes (rate
 *  limit, outage, auth) don't correlate, so a chain is strictly more available than
 *  any single provider.
 *
 *  Health-aware ordering (Phase 13 Part B): before iterating, stable-partition the
 *  chain so non-degraded providers come first — never DROPS a provider, a degraded
 *  one is still tried as the last resort. If every provider in the chain is degraded,
 *  the "non-degraded" bucket is empty and this reduces to the original order (no
 *  special-casing needed for that — it falls out of the partition itself). This is a
 *  transport concern, not a business decision, so no action_log entry — just a Sentry
 *  breadcrumb when the order actually changes. */
export class CompositeProvider implements LLMProvider {
  name = "composite";
  recordsHealthInternally = true;
  constructor(private providers: LLMProvider[]) {}

  lastUsage?: LLMUsage;
  selectedProviderName?: string;
  async complete(opts: LLMCallOptions): Promise<string> {
    const sharedOpts = normalizeCallOptions(opts);
    this.lastUsage = undefined;
    this.selectedProviderName = undefined;
    const ordered = orderProvidersByHealth(this.providers, sharedOpts.channel);
    if (ordered.some((p, i) => p !== this.providers[i])) {
      initObservability();
      Sentry.addBreadcrumb({ category: "llm", message: "provider-reorder", data: { order: ordered.map((p) => p.name) } });
    }
    let lastError: Error | null = null;
    for (const p of ordered) {
      if (Number.isFinite(sharedOpts.deadlineAt) && Date.now() >= Number(sharedOpts.deadlineAt)) throw new LLMDeadlineExceededError(Number(sharedOpts.deadlineAt));
      if (sharedOpts.signal?.aborted) throw sharedOpts.signal.reason ?? Object.assign(new Error("LLM request aborted"), { name: "AbortError" });
      const selectedName = p.selectedProviderName ?? p.name;
      this.selectedProviderName = selectedName;
      const start = Date.now();
      try {
        const text = await p.complete(sharedOpts);
        this.lastUsage = p.lastUsage;
        // Record health at the concrete provider boundary. Nested composites already
        // record their own attempts, and the outer observability wrapper skips the
        // synthetic "composite" sample via recordsHealthInternally.
        if (!p.recordsHealthInternally) recordOutcome(selectedName, true, Date.now() - start);
        return text;
      } catch (err) {
        if (!(err instanceof ComputeCapacityUnavailableError) && !p.recordsHealthInternally) recordOutcome(selectedName, false, Date.now() - start);
        lastError = err as Error;
        if (err instanceof ComputeCapacityUnavailableError && err.resourceKey === "model:global") throw err;
        // A fallback is useful for provider failures, not for an already-aborted
        // voice request. Retrying after a shared deadline only makes latency worse.
        if (isAbortLike(err)) throw err;
      }
    }
    throw lastError ?? new Error("All providers failed");
  }
}

export class GroqProvider implements LLMProvider {
  name = "groq";
  private client: Groq;
  private models: string[];
  lastUsage?: LLMUsage;

  constructor(apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile") {
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    // No SDK-level retries: a throttled call fails in milliseconds and we fail over
    // to the next model, whose rate-limit bucket is separate — instead of sitting
    // out a 20-40s retry-after on the free tier.
    this.client = new Groq({ apiKey, timeout: 8_000, maxRetries: 0 });
    // 70B first: this model's whole job is precise structured-field extraction (which
    // action_type, which exact payload fields) — the 8B model is fast but was
    // regularly stuffing entire sentences into single fields and misrouting between
    // similarly-named actions. 8B stays as the fallback for when 70B is rate-limited,
    // not the default.
    const fallbacks = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    this.models = [model, ...fallbacks.filter((m) => m !== model)];
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    const sharedOpts = normalizeCallOptions(opts);
    this.lastUsage = undefined;
    let lastError: Error | null = null;
    for (const model of this.models) {
      const timeout = remainingMs(sharedOpts, 8_000);
      if (timeout <= 0) throw new LLMDeadlineExceededError(sharedOpts.deadlineAt ?? Date.now());
      try {
        const res = await withGovernedModelInvocation({ provider: "groq", model, tenantId: sharedOpts.tenantId, channel: sharedOpts.channel }, () => this.client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: sharedOpts.system },
              { role: "user", content: sharedOpts.user },
            ],
            temperature: 0.1,
            max_tokens: 700,
            ...(sharedOpts.json ? { response_format: { type: "json_object" as const } } : {}),
          },
          { signal: sharedOpts.signal, timeout },
        ));
        this.lastUsage = { model, inputTokens: res.usage?.prompt_tokens ?? null, outputTokens: res.usage?.completion_tokens ?? null };
        return res.choices[0]?.message?.content ?? "";
      } catch (err) {
        lastError = err as Error;
        if (err instanceof ComputeCapacityUnavailableError) throw err;
        if (isAbortLike(err)) throw err;
        // 429 / 5xx / timeout → next model, next bucket. Hard auth errors don't retry.
        const status = (err as { status?: number }).status;
        if (status === 401 || status === 403) break;
      }
    }
    throw lastError ?? new Error("All Groq models failed");
  }
}

const BEDROCK_QWEN_PLANNING_MODEL_ID = () => process.env.AWS_BEDROCK_QWEN_PLANNING_MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0";
const BEDROCK_QWEN_FAST_MODEL_ID = () => process.env.AWS_BEDROCK_QWEN_FAST_MODEL_ID ?? "qwen.qwen3-32b-v1:0";
// These are the Bedrock model IDs for the single-key JARVIS provider chain. Each
// can be overridden when an account pins a different active model revision.
const BEDROCK_GLM_MODEL_ID = () => process.env.AWS_BEDROCK_GLM_MODEL_ID ?? "zai.glm-4.7";
const BEDROCK_MISTRAL_MODEL_ID = () => process.env.AWS_BEDROCK_MISTRAL_MODEL_ID ?? "mistral.mistral-small-2402-v1:0";
const BEDROCK_DEEPSEEK_MODEL_ID = () => process.env.AWS_BEDROCK_DEEPSEEK_MODEL_ID ?? "deepseek.v3.2";
const BEDROCK_OPENAI_OSS_MODEL_ID = () => process.env.AWS_BEDROCK_OPENAI_OSS_MODEL_ID ?? "openai.gpt-oss-120b-1:0";
const BEDROCK_NOVA_MICRO_MODEL_ID = () => process.env.AWS_BEDROCK_NOVA_MICRO_MODEL_ID ?? "amazon.nova-micro-v1:0";
// Qwen 235B is not served from us-east-1. Keep a separate override so the rest of
// the Bedrock fleet can remain in the deployment's primary region.
const BEDROCK_QWEN_PLANNING_REGION = () => process.env.AWS_BEDROCK_QWEN_PLANNING_REGION ?? process.env.AWS_REGION ?? "us-east-1";

interface ProviderRegistration {
  factory: () => LLMProvider;
  configured: () => boolean;
}

class UnavailableProvider implements LLMProvider {
  lastUsage?: LLMUsage;
  constructor(public readonly name: string, private readonly reason: string) {}

  async complete(): Promise<string> {
    throw new LLMProviderSelectionError(`${this.name} is unavailable: ${this.reason}`);
  }
}

/** Registry entries are lazy so importing @finnor/tools and constructing an
 * orchestrator never requires provider credentials. */
const providers = new Map<string, ProviderRegistration>();
function addProvider(name: string, factory: () => LLMProvider, configured: () => boolean): void {
  providers.set(name, { factory, configured });
}

const bedrockConfigured = () => Boolean(bedrockApiKey());
const mistralConfigured = () => Boolean(process.env.MISTRAL_API_KEY);
const deepseekConfigured = () => Boolean(process.env.DEEPSEEK_API_KEY || bedrockConfigured());
const groqConfigured = () => Boolean(process.env.GROQ_API_KEY);

const singleKeyMistralConfigured = () => Boolean(mistralConfigured() || bedrockConfigured());
const singleKeyBedrockProvider = (modelId: string, name: string) => new BedrockConverseProvider(modelId, undefined, undefined, name);

// Prefer the one configured Bedrock credential when present. Direct vendor keys
// remain a compatibility fallback for explicitly separate deployments, but a
// Bedrock-configured deployment never silently leaves the approved provider path.
addProvider("glm", () => singleKeyBedrockProvider(BEDROCK_GLM_MODEL_ID(), "glm"), bedrockConfigured);
addProvider("mistral", () => bedrockConfigured() ? singleKeyBedrockProvider(BEDROCK_MISTRAL_MODEL_ID(), "mistral") : new MistralProvider(), singleKeyMistralConfigured);
addProvider("deepseek", () => bedrockConfigured() ? singleKeyBedrockProvider(BEDROCK_DEEPSEEK_MODEL_ID(), "deepseek") : new DeepSeekProvider(), deepseekConfigured);
// Legacy providers remain available only when named explicitly or selected by an
// explicit route override. None is a default fallback in the JARVIS route table.
addProvider("groq", () => new GroqProvider(), groqConfigured);
addProvider("bedrock-qwen-planning", () => new BedrockConverseProvider(BEDROCK_QWEN_PLANNING_MODEL_ID(), undefined, BEDROCK_QWEN_PLANNING_REGION(), "bedrock-qwen-planning"), bedrockConfigured);
addProvider("bedrock-qwen-fast", () => new BedrockConverseProvider(BEDROCK_QWEN_FAST_MODEL_ID(), undefined, undefined, "bedrock-qwen-fast"), bedrockConfigured);
addProvider("bedrock-deepseek", () => new BedrockConverseProvider(BEDROCK_DEEPSEEK_MODEL_ID(), undefined, undefined, "bedrock-deepseek"), bedrockConfigured);
addProvider("bedrock-openai-oss", () => new BedrockConverseProvider(BEDROCK_OPENAI_OSS_MODEL_ID(), undefined, undefined, "bedrock-openai-oss"), bedrockConfigured);
addProvider("bedrock-nova-micro", () => new BedrockConverseProvider(BEDROCK_NOVA_MICRO_MODEL_ID(), undefined, undefined, "bedrock-nova-micro"), bedrockConfigured);
addProvider("planning", () => {
  const chain: LLMProvider[] = [];
  if (bedrockConfigured()) chain.push(new BedrockConverseProvider(BEDROCK_QWEN_PLANNING_MODEL_ID(), undefined, BEDROCK_QWEN_PLANNING_REGION(), "bedrock-qwen-planning"));
  if (groqConfigured()) chain.push(new GroqProvider());
  return chain.length > 0 ? new CompositeProvider(chain) : new UnavailableProvider("planning", "no explicitly configured legacy planning provider");
}, () => bedrockConfigured() || groqConfigured());
addProvider("high-risk-second-candidate", () => {
  const chain: LLMProvider[] = [];
  if (bedrockConfigured()) {
    chain.push(new BedrockConverseProvider(BEDROCK_DEEPSEEK_MODEL_ID(), undefined, undefined, "bedrock-deepseek"));
    chain.push(new BedrockConverseProvider(BEDROCK_OPENAI_OSS_MODEL_ID(), undefined, undefined, "bedrock-openai-oss"));
  }
  return chain.length > 0 ? new CompositeProvider(chain) : new UnavailableProvider("high-risk-second-candidate", "AWS_BEDROCK_API_KEY is not set");
}, bedrockConfigured);

export function registerProvider(name: string, factory: () => LLMProvider, configured: () => boolean = () => true): void {
  providers.set(name, { factory, configured });
}

/** Wraps a provider with a Sentry breadcrumb per complete() call (provider name,
 *  latency, ok/fail) — never the prompt/response text itself, which may carry
 *  redacted-but-still-sensitive business content (respects the same discipline
 *  ToolRegistry.call()'s tool breadcrumbs follow). No-ops harmlessly without
 *  SENTRY_DSN. */
function withObservability(provider: LLMProvider): LLMProvider {
  return {
    name: provider.name,
    get lastUsage() { return provider.lastUsage; },
    get selectedProviderName() { return provider.selectedProviderName; },
    // This wrapper owns the health sample for ordinary providers. Composite
    // providers also report their concrete attempts internally, so an outer
    // wrapper must treat them as already accounted for.
    recordsHealthInternally: true,
    async complete(opts) {
      const sharedOpts = normalizeCallOptions(opts);
      initObservability();
      const start = Date.now();
      try {
        await enforceBudget(sharedOpts);
        const text = await provider.complete(sharedOpts);
        const ms = Date.now() - start;
        const providerName = provider.selectedProviderName ?? provider.name;
        Sentry.addBreadcrumb({ category: "llm", message: providerName, data: { ok: true, ms } });
        if (!provider.recordsHealthInternally) recordOutcome(providerName, true, ms);
        await recordCall(provider, sharedOpts, "completed").catch(() => undefined);
        return text;
      } catch (err) {
        const ms = Date.now() - start;
        const providerName = provider.selectedProviderName ?? provider.name;
        Sentry.addBreadcrumb({ category: "llm", message: providerName, data: { ok: false, ms } });
        Sentry.captureMessage(`llm_failed:${providerName}`, { level: "warning" });
        const deferred = err instanceof LLMBudgetDeferredError
          || err instanceof LLMBudgetUnknownUsageError
          || err instanceof ComputeCapacityUnavailableError;
        if (!deferred && !provider.recordsHealthInternally) recordOutcome(providerName, false, ms);
        await recordCall(provider, sharedOpts, deferred ? "deferred" : "failed", { error: (err as Error).message }).catch(() => undefined);
        throw err;
      }
    },
  };
}

export function resolveProvider(name?: string): LLMProvider {
  if (!name) throw new LLMProviderSelectionError("No LLM provider selected; use resolveProviderForPurpose() or provide an explicit provider name");
  const registration = providers.get(name);
  if (!registration) throw new LLMProviderSelectionError(`Unknown LLM provider "${name}"`);
  return withObservability(registration.factory());
}

export interface LLMRouteRequest {
  purpose: LLMPurpose;
  channel?: LLMChannel;
  /** Explicit policy/config pin. This bypasses fallback ordering by design. */
  provider?: string;
  deadlineAt?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface LLMRouteDescription {
  purpose: LLMPurpose;
  channel: LLMChannel;
  providerNames: string[];
  deadlineMs: number;
}

const DEFAULT_ROUTE_ORDER: Record<LLMPurpose, Record<LLMChannel, string[]>> = {
  planning: {
    voice: ["mistral", "deepseek", "glm"],
    text: ["mistral", "deepseek", "glm"],
    console: ["mistral", "deepseek", "glm"],
    background: ["deepseek", "mistral", "glm"],
  },
  critic: {
    voice: ["deepseek", "mistral", "glm"],
    text: ["deepseek", "mistral", "glm"],
    console: ["deepseek", "mistral", "glm"],
    background: ["deepseek", "mistral", "glm"],
  },
  repair: {
    voice: ["deepseek", "mistral", "glm"],
    text: ["deepseek", "mistral", "glm"],
    console: ["deepseek", "mistral", "glm"],
    background: ["deepseek", "mistral", "glm"],
  },
  classification: {
    voice: ["mistral", "deepseek", "glm"],
    text: ["mistral", "deepseek", "glm"],
    console: ["mistral", "deepseek", "glm"],
    background: ["mistral", "deepseek", "glm"],
  },
  answer: {
    voice: ["mistral", "deepseek", "glm"],
    text: ["mistral", "deepseek", "glm"],
    console: ["mistral", "deepseek", "glm"],
    background: ["deepseek", "mistral", "glm"],
  },
};

/** Returns null only when no route override key exists. An explicitly set but
 * unknown/unconfigured override is intentionally returned as an empty route so
 * it cannot silently fall through to the safe defaults. */
function envRouteOverride(purpose: LLMPurpose, channel: LLMChannel): string[] | null {
  const suffixes = [`${purpose.toUpperCase()}_${channel.toUpperCase()}`, purpose.toUpperCase()];
  for (const suffix of suffixes) {
    const providerKey = `LLM_PROVIDER_${suffix}`;
    const modelKey = `LLM_MODEL_${suffix}`;
    const selected = process.env[providerKey] ?? process.env[modelKey];
    if (selected === undefined) continue;
    const fallback = process.env[`LLM_FALLBACKS_${suffix}`] ?? "";
    return [selected, ...fallback.split(",").map((name) => name.trim()).filter(Boolean)];
  }
  return null;
}

function routeNames(purpose: LLMPurpose, channel: LLMChannel): string[] {
  const override = envRouteOverride(purpose, channel);
  const configured = (candidates: string[]) => [...new Set(candidates)].filter((name) => providers.get(name)?.configured() === true);
  // An explicit route is authoritative: unknown/unconfigured names yield an
  // unavailable route instead of silently switching to a different provider.
  if (override !== null) {
    const names = [...new Set(override)];
    return names.length > 0 && names.every((name) => providers.get(name)?.configured() === true) ? names : [];
  }
  return configured(DEFAULT_ROUTE_ORDER[purpose][channel]);
}

export function describeLLMRoute(purpose: LLMPurpose, channel: LLMChannel = "text"): LLMRouteDescription {
  return { purpose, channel, providerNames: routeNames(purpose, channel), deadlineMs: DEFAULT_DEADLINE_MS[channel] };
}

export function isProviderConfigured(name: string): boolean {
  return providers.get(name)?.configured() === true;
}

export function isPurposeConfigured(purpose: LLMPurpose, channel: LLMChannel = "text"): boolean {
  return routeNames(purpose, channel).length > 0;
}

export function resolveProviderForRequest(request: LLMRouteRequest): LLMProvider {
  const channel = request.channel ?? "text";
  if (request.provider) return resolveProvider(request.provider);
  const names = routeNames(request.purpose, channel);
  if (names.length === 0) {
    return withObservability(new UnavailableProvider(`route:${request.purpose}:${channel}`, "no configured provider matched the safe route"));
  }
  const selected = names.map((name) => providers.get(name)!.factory());
  const provider = selected.length === 1 ? selected[0]! : new CompositeProvider(selected);
  const boundProvider: LLMProvider = {
    name: provider.name,
    get lastUsage() { return provider.lastUsage; },
    get selectedProviderName() { return provider.selectedProviderName; },
    get recordsHealthInternally() { return provider.recordsHealthInternally; },
    complete(opts) {
      return provider.complete({
        ...opts,
        purpose: opts.purpose ?? request.purpose,
        channel: opts.channel ?? channel,
        ...(opts.deadlineAt === undefined && request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}),
        ...(opts.deadlineMs === undefined && request.deadlineMs !== undefined ? { deadlineMs: request.deadlineMs } : {}),
        ...(opts.signal === undefined && request.signal !== undefined ? { signal: request.signal } : {}),
      });
    },
  };
  return withObservability(boundProvider);
}

/** Purpose/channel-aware resolver used by orchestration and answer plugins. The
 * string overload keeps existing call sites source-compatible while making the
 * channel explicit wherever latency matters. */
export function resolveProviderForPurpose(purpose: LLMPurpose, channelOrRequest: LLMChannel | Omit<LLMRouteRequest, "purpose"> = "text"): LLMProvider {
  const request = typeof channelOrRequest === "string" ? { purpose, channel: channelOrRequest } : { purpose, ...channelOrRequest };
  return resolveProviderForRequest(request);
}

export function resolveProviderForChannel(purpose: LLMPurpose, channel: LLMChannel): LLMProvider {
  return resolveProviderForPurpose(purpose, channel);
}
