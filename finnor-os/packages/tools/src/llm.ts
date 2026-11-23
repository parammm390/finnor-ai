// LLM provider abstraction for CENTROPY. Provider choice is explicit and routed by
// purpose/channel; there is intentionally no unnamed provider default. A model can
// still be pinned per action_type via domain_policies (model_provider column), a
// config change rather than a code change.
//
// Lives in @finnor/tools (not @finnor/orchestration) specifically so domain-plugins
// can use it too — domain-plugins already depends on tools, and orchestration depends
// on domain-plugins, so a copy in orchestration would create a package cycle the
// moment a plugin needed an LLM call (the ops-overview grounded-QA action does).

import Groq from "groq-sdk";
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ServiceInputTypes, type ServiceOutputTypes } from "@aws-sdk/client-bedrock-runtime";
import type { DeserializeMiddleware, FinalizeRequestMiddleware } from "@smithy/types";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { withTenant, decisionReceipts, llmCalls, tenantLlmBudgets, withGovernedModelInvocation, ComputeCapacityUnavailableError } from "@finnor/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { initObservability, Sentry } from "./observability";
import { observeAiOperation } from "./langfuse";
import { orderProvidersByHealth, recordOutcome } from "./provider-health";
import { compositeContextWindowTokens, LLMContextBudgetError } from "./model-context";
import type { ComputeResourceLease } from "@finnor/db";
import type { SpecialistIamSessionLease } from "../../governed-execution/src/specialist-contract";

export { countPromptTokensUpperBound, resolveLLMContextBudget, LLMContextBudgetError, type LLMContextBudget, type LLMContextBudgetErrorCode } from "./model-context";

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
  /** Explicit bounded output allowance; defaults retain each native adapter profile. */
  maxOutputTokens?: number;
  /** Opt-in streamed bound, before the adapter buffers or parses response data. */
  maxResponseBytes?: number;
  /** Opt-in mandatory P3 permits in every environment, not protected admission. */
  requireGovernance?: boolean;
  /** Native owner persists its fenced possible-call intent immediately before
   * I/O, after actual P3 acquisition. Never disclosed to the model/guest. */
  beforeInvocation?: (context: { signal: AbortSignal; leases: readonly ComputeResourceLease[] }) => Promise<void>;
  /** Native per-invocation receipt. Do not infer concurrent usage from lastUsage. */
  onBoundedUsage?: (usage: Readonly<LLMUsage>) => void;
  /** Opt-in native bounded response owner. Runs before the original P3 permits
   * are released, under the original wire signal, never a renewed lifetime. */
  onBoundedResponse?: (context: { text: string; usage: Readonly<LLMUsage>;
    signal: AbortSignal; leases: readonly ComputeResourceLease[] }) => Promise<void>;
  /** Opaque existing-session custody. Never a credential/provider or model input. */
  specialistIamSession?: SpecialistIamSessionLease;
  reasoningEffort?: "low" | "medium" | "high";
}
export interface LLMUsage {
  model: string;
  /** Exact model identifier returned by the adapter response, when supplied. */
  returnedModel?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Raw response body bytes observed before native SDK parsing, not TLS bytes. */
  responseBytes?: number | null;
}
export type LLMProviderQualificationIdentity =
  | { transport: "openai-compatible"; name: string; model: string; endpointSha256: string }
  | { transport: "bedrock-invoke" | "bedrock-converse"; name: string; model: string; region: string }
  | { transport: "groq"; name: string; models: string[]; endpointSha256: string }
  | { transport: "composite"; members: LLMProviderQualificationIdentity[] }
  | { transport: "custom"; name: string; revision: string };
export interface LLMProvider {
  readonly qualificationIdentity?: LLMProviderQualificationIdentity;
  /** Explicit supported ceiling for custom providers; all fallbacks must fit it. */
  readonly contextWindowTokens?: number;
  withContextWindow?(minimumTokens: number): LLMProvider;
  name: string;
  /** Usage belongs to the immediately preceding complete() call. Providers that do
   * not return it leave it undefined rather than estimating it. */
  lastUsage?: LLMUsage;
  /** Observable physical adapter attempts; unavailable detail stays unknown. */
  lastAttempts?: Array<Record<string, unknown>>;
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
  if (opts.maxOutputTokens !== undefined && (!Number.isInteger(opts.maxOutputTokens) || opts.maxOutputTokens < 1 || opts.maxOutputTokens > 4096)) throw new Error("LLM_OUTPUT_TOKEN_BOUND");
  if (opts.maxResponseBytes !== undefined && (!Number.isSafeInteger(opts.maxResponseBytes)
    || opts.maxResponseBytes < 256 || opts.maxResponseBytes > 65536)) throw new Error("LLM_RESPONSE_BYTE_BOUND");
  if ((opts.beforeInvocation || opts.onBoundedUsage || opts.specialistIamSession) && (!opts.requireGovernance || opts.maxResponseBytes === undefined
    || !opts.signal || !Number.isFinite(opts.deadlineAt))) throw new Error("LLM_BOUNDED_INVOCATION_CONTRACT_REQUIRED");
  if (Number.isFinite(opts.deadlineAt)) return opts;
  const relative = opts.deadlineMs ?? opts.timeoutMs ?? DEFAULT_DEADLINE_MS[opts.channel ?? "text"];
  return { ...opts, deadlineAt: Date.now() + Math.max(0, relative) };
}

function providerCallCeiling(opts: LLMCallOptions, defaultMs: number): number {
  return opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs)
    ? Math.max(0, Math.min(25_000, opts.timeoutMs)) : defaultMs;
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
async function fetchWithCallBudget(url: string, init: RequestInit, opts: LLMCallOptions, providerCeilingMs = 8_000,
  beforeFetch?: (signal: AbortSignal) => Promise<void>): Promise<Response> {
  const normalized = normalizeCallOptions(opts);
  providerCeilingMs = providerCallCeiling(normalized, providerCeilingMs);
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
    await beforeFetch?.(controller.signal);
    controller.signal.throwIfAborted();
    const response = await fetch(url, { ...init, ...(normalized.maxResponseBytes !== undefined
      ? { redirect: "error" as const, credentials: "omit" as const } : {}), signal: controller.signal });
    // Keep the same physical deadline active through body consumption. Fetch
    // resolves at headers; without this a stalled response body could outlive
    // the model permit and be overlapped by its later expiry.
    const boundedResponse = normalized.maxResponseBytes !== undefined
      ? new Response(await readBoundedResponse(response, normalized.maxResponseBytes, controller.signal),
        { status: response.status, headers: response.headers })
      : typeof response.arrayBuffer === "function"
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

async function readBoundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("LLM_RESPONSE_BYTE_BOUND");
  }
  if (!response.body) throw new Error("LLM_BOUNDED_RESPONSE_BODY_REQUIRED");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (next.value.length > limit - size) throw new Error("LLM_RESPONSE_BYTE_BOUND");
      size += next.value.length; chunks.push(next.value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

const providerWrappers = new WeakMap<LLMProvider, { provider: LLMProvider; complete: LLMProvider["complete"] }>();
const nativeBoundedAdapters = new WeakMap<LLMProvider, string>();
const boundedOptions = (opts: LLMCallOptions) => opts.maxResponseBytes !== undefined
  || opts.requireGovernance === true || opts.beforeInvocation !== undefined || opts.onBoundedUsage !== undefined
  || opts.specialistIamSession !== undefined;
function refuseUnsupportedBoundedAdapter(opts: LLMCallOptions) {
  if (boundedOptions(opts)) throw new Error("LLM_BOUNDED_ADAPTER_UNSUPPORTED");
}

export type NativeBoundedLLMProviderIdentity =
  | Extract<LLMProviderQualificationIdentity, { transport: "openai-compatible" }>
  | { transport: "bedrock-converse"; name: string; model: string; region: string;
    authMode: "IAM"; endpointSha256: string };

/** Actual native adapters, not a reported name or a fallback's first member. */
export function assertNativeBoundedLLMProvider(provider: LLMProvider): NativeBoundedLLMProviderIdentity {
  let native = provider;
  for (let depth = 0; providerWrappers.has(native) && depth < 4; depth++) {
    const wrapper = providerWrappers.get(native)!;
    if (native.complete !== wrapper.complete) throw new Error("LLM_BOUNDED_ADAPTER_UNSUPPORTED");
    native = wrapper.provider;
  }
  const identity = native.qualificationIdentity;
  if (nativeBoundedAdapters.get(native) !== JSON.stringify(identity)
    || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("LLM_BOUNDED_ADAPTER_UNSUPPORTED");
  if (native instanceof OpenAICompatibleProvider && native.complete === nativeOpenAIComplete
    && identity?.transport === "openai-compatible") return { ...identity };
  if (native instanceof BedrockConverseProvider && native.complete === nativeBedrockComplete
    && identity?.transport === "bedrock-converse" && process.env.AWS_BEDROCK_AUTH_MODE === "iam") {
    assertSelectedAwsRegion(identity.region);
    return { ...identity, transport: "bedrock-converse", authMode: "IAM",
      endpointSha256: createHash("sha256").update(`https://bedrock-runtime.${identity.region}.amazonaws.com`).digest("hex") };
  }
  throw new Error("LLM_BOUNDED_ADAPTER_UNSUPPORTED");
}

async function readBoundedNodeResponse(body: unknown, maximum: number, signal: AbortSignal): Promise<Buffer> {
  // Require the raw stream from the source-pinned installed transport, rather
  // than an already buffered body. Readable alone does not prove handler identity.
  if (!(body instanceof Readable)) throw new Error("LLM_BOUNDED_SDK_STREAM_REQUIRED");
  const cancel = () => { body.destroy(); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of body) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new Error("LLM_BOUNDED_SDK_STREAM_REQUIRED");
      if (chunk.byteLength > maximum - size) throw new Error("LLM_RESPONSE_BYTE_BOUND");
      size += chunk.byteLength; chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", cancel); body.destroy(); }
}

/** Only an authenticated existing-session lease, never a credential chain.
 * This helper grants no admission, credential, refresh or model-spend authority. */
async function completeBoundedBedrockIam(session: SpecialistIamSessionLease, input: ConverseCommandInput, region: string,
  opts: LLMCallOptions, capacitySignal: AbortSignal, leases: readonly ComputeResourceLease[]) {
  const modelId = input.modelId;
  if (process.env.AWS_BEDROCK_AUTH_MODE !== "iam" || opts.maxResponseBytes === undefined
    || !opts.requireGovernance || !opts.beforeInvocation || !opts.onBoundedUsage || !opts.signal
    || opts.maxOutputTokens === undefined || !Number.isFinite(opts.deadlineAt)
    || region !== "us-east-1" || opts.model === undefined || typeof modelId !== "string" || modelId !== opts.model)
    throw new Error("LLM_BOUNDED_IAM_CONTRACT_REQUIRED");
  const budgetMs = remainingMs(opts, 8_000);
  if (budgetMs <= 0) throw new LLMDeadlineExceededError(opts.deadlineAt!);
  const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), capacitySignal, ...(opts.signal ? [opts.signal] : [])]);
  // Load this source port only for the opt-in protected branch. Ordinary clients
  // keep their existing default chain; protected clients cannot reach it.
  const { assertAdmittedSpecialistIamSessionCurrent, consumeAdmittedSpecialistIamSession } =
    await import("../../governed-execution/src/specialist-iam-session");
  await assertAdmittedSpecialistIamSessionCurrent(session, signal);
  const credentials = consumeAdmittedSpecialistIamSession(session, { model: modelId, region,
    tenantId: opts.tenantId, deadlineAt: opts.deadlineAt, signal: opts.signal });
  const hostname = `bedrock-runtime.${region}.amazonaws.com`;
  const client = new BedrockRuntimeClient({ region, credentials: { ...credentials }, endpoint: `https://${hostname}`, maxAttempts: 1,
    authSchemePreference: ["aws.auth#sigv4"], useDualstackEndpoint: false, useFipsEndpoint: false,
    requestHandler: { requestTimeout: budgetMs, connectionTimeout: Math.min(2000, budgetMs) } });
  let wireCount = 0, boundedBodies = 0, responseBytes: number | null = null;
  const attestWire: FinalizeRequestMiddleware<ServiceInputTypes, ServiceOutputTypes> = next => async args => {
    const request = args.request as { protocol?: string; hostname?: string; port?: number; method?: string;
      path?: string; query?: Record<string, unknown>; headers?: Record<string, string> };
    const authorization = Object.entries(request.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
    const path = "/model/" + encodeURIComponent(modelId).replace(/[!'()*]/g,
      value => "%" + value.charCodeAt(0).toString(16).toUpperCase()) + "/converse";
    if (++wireCount !== 1 || request.protocol !== "https:" || request.hostname !== hostname
      || request.port !== undefined && request.port !== 443 || request.method !== "POST" || request.path !== path
      || Object.keys(request.query ?? {}).length || !authorization?.startsWith("AWS4-HMAC-SHA256 ")
      || !authorization.includes(`/${region}/bedrock/aws4_request`))
      throw new Error("LLM_BOUNDED_IAM_WIRE_SUBSTITUTION_OR_REPLAY");
    signal.throwIfAborted();
    await assertAdmittedSpecialistIamSessionCurrent(session, signal);
    await opts.beforeInvocation!({ signal, leases });
    await assertAdmittedSpecialistIamSessionCurrent(session, signal);
    signal.throwIfAborted();
    return next(args);
  };
  client.middlewareStack.addRelativeTo(attestWire,
    { name: "finnorBoundedIamWire", relation: "after", toMiddleware: "httpSigningMiddleware" });
  const boundResponse: DeserializeMiddleware<ServiceInputTypes, ServiceOutputTypes> = next => async args => {
    const result = await next(args);
    const response = result.response as { body: unknown; headers?: Record<string, string> };
    if (++boundedBodies !== 1) throw new Error("LLM_BOUNDED_IAM_RESPONSE_REPLAY");
    const declared = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === "content-length")?.[1];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > opts.maxResponseBytes!)) {
      if (response.body instanceof Readable) response.body.destroy();
      throw new Error("LLM_RESPONSE_BYTE_BOUND");
    }
    const body = await readBoundedNodeResponse(response.body, opts.maxResponseBytes!, signal);
    responseBytes = body.byteLength; response.body = body;
    return result;
  };
  client.middlewareStack.addRelativeTo(boundResponse,
    { name: "finnorBoundedIamResponse", relation: "after", toMiddleware: "deserializerMiddleware" });
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason ?? Object.assign(new Error("LLM request aborted"), { name: "AbortError" }));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    signal.throwIfAborted();
    // SDK bookkeeping cannot retain a renewing P3 permit forever. Credentials
    // are already literal; no credential provider or refresh runs in this call.
    const result = await Promise.race([client.send(new ConverseCommand(input), { abortSignal: signal }), cancelled]);
    signal.throwIfAborted();
    if (wireCount !== 1 || boundedBodies !== 1 || responseBytes === null) throw new Error("LLM_BOUNDED_IAM_BOUNDARY_NOT_OBSERVED");
    if (Date.now() >= opts.deadlineAt!) throw new LLMDeadlineExceededError(opts.deadlineAt!);
    return { output: result, responseBytes, signal };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? Object.assign(new Error("LLM request aborted"), { name: "AbortError" });
    throw error;
  } finally { if (cancel) signal.removeEventListener("abort", cancel); client.destroy(); }
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

type BoundedCallMetering = { usage: LLMUsage | undefined; moneyUnknown: true };
async function recordCall(provider: LLMProvider, opts: LLMCallOptions, status: "completed" | "deferred" | "failed",
  detail: Record<string, unknown> = {}, bounded?: BoundedCallMetering): Promise<void> {
  if (!opts.tenantId) return;
  const usage = bounded ? bounded.usage : provider.lastUsage;
  const providerName = provider.selectedProviderName ?? provider.name;
  await withTenant(opts.tenantId, async (db) => {
    await db.insert(llmCalls).values({
      tenantId: opts.tenantId!, domainActionId: opts.actionId ?? null, traceId: opts.traceId ?? null,
      purpose: opts.purpose ?? "answer", provider: providerName, model: usage?.model ?? "unknown",
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      costUsd: bounded?.moneyUnknown ? null : configuredCostUsd(usage), status,
      detail: bounded ? { ...detail, accountingQualification: "OWN_NATIVE_USAGE_MONEY_UNKNOWN" } : detail,
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
  model?: string;
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
}

function chatContent(data: OpenAICompatibleResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
const boundedTokenCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

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
  ) { nativeBoundedAdapters.set(this, JSON.stringify(this.qualificationIdentity)); }

  get qualificationIdentity(): LLMProviderQualificationIdentity {
    return { transport: "openai-compatible", name: this.name, model: this.model,
      endpointSha256: createHash("sha256").update(this.endpoint).digest("hex") };
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    const normalized = normalizeCallOptions(opts);
    if (opts.specialistIamSession !== undefined) throw new Error("LLM_BOUNDED_IAM_PROVIDER_REQUIRED");
    if (boundedOptions(normalized)) {
      const identity = assertNativeBoundedLLMProvider(this);
      if (opts.model !== undefined && opts.model !== identity.model) throw new Error("LLM_BOUNDED_MODEL_SUBSTITUTION");
      const endpoint = new URL(this.endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
        throw new Error("LLM_BOUNDED_ENDPOINT_UNSUPPORTED");
    }
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()}_API_KEY is not set`);
    this.lastUsage = undefined;
    const model = opts.model ?? this.model;
    return withGovernedModelInvocation({ provider: this.name, model, tenantId: opts.tenantId, channel: opts.channel,
      requireGovernance: opts.requireGovernance, deadlineAt: normalized.deadlineAt }, async (capacitySignal, leases) => {
    const signal = opts.signal ? AbortSignal.any([opts.signal, capacitySignal]) : capacitySignal;
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
          max_tokens: opts.maxOutputTokens ?? 700,
          // Preserve the existing contract: callers validate/parse the returned JSON;
          // the adapter only asks the provider for an object-shaped response.
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
      },
      { ...normalized, signal },
      8_000,
      opts.beforeInvocation ? physicalSignal => opts.beforeInvocation!({ signal: physicalSignal, leases }) : undefined,
    );
    if (!res.ok) {
      if (opts.maxResponseBytes !== undefined) throw new Error(`LLM_BOUNDED_PROVIDER_HTTP_${res.status}`);
      const body = await res.text().catch(() => "");
      throw new Error(`${this.name} failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as OpenAICompatibleResponse;
    const usage: LLMUsage = {
      model,
      ...(typeof data.model === "string" ? { returnedModel: data.model } : {}),
      inputTokens: boundedOptions(opts) ? boundedTokenCount(data.usage?.prompt_tokens ?? data.usage?.input_tokens)
        : data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? null,
      outputTokens: boundedOptions(opts) ? boundedTokenCount(data.usage?.completion_tokens ?? data.usage?.output_tokens)
        : data.usage?.completion_tokens ?? data.usage?.output_tokens ?? null,
    };
    this.lastUsage = usage;
    opts.onBoundedUsage?.(Object.freeze({ ...usage }));
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

/** Legacy explicit-only Bedrock Anthropic adapter. It is not part of any CENTROPY
 * default route; GLM/Mistral/DeepSeek are the configured first-party choices. */
export class BedrockAnthropicProvider implements LLMProvider {
  name = "bedrock-anthropic";
  lastUsage?: LLMUsage;
  constructor(
    private modelId: string,
    private apiKey = bedrockApiKey(),
    private region = process.env.AWS_BEDROCK_REGION ?? "us-east-1",
  ) {}

  get qualificationIdentity(): LLMProviderQualificationIdentity {
    return { transport: "bedrock-invoke", name: this.name, model: this.modelId, region: this.region };
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    refuseUnsupportedBoundedAdapter(opts);
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
          max_tokens: opts.maxOutputTokens ?? 700,
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
 * models used by CENTROPY (GLM, Mistral, Qwen, DeepSeek, OpenAI OSS, and Amazon Nova). Keeping this
 * adapter model-agnostic lets the routing policy change without coupling the rest of
 * the system to each vendor's InvokeModel payload shape.
 */
export class BedrockConverseProvider implements LLMProvider {
  readonly name: string;
  lastUsage?: LLMUsage;
  private client?: BedrockRuntimeClient;
  constructor(
    private modelId: string,
    private apiKey = bedrockApiKey(),
    private region = process.env.AWS_BEDROCK_REGION ?? "us-east-1",
    name = "bedrock-converse",
  ) {
    this.name = name;
    nativeBoundedAdapters.set(this, JSON.stringify(this.qualificationIdentity));
  }

  get qualificationIdentity(): LLMProviderQualificationIdentity {
    return { transport: "bedrock-converse", name: this.name, model: this.modelId, region: this.region };
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    if (boundedOptions(opts)) {
      const identity = assertNativeBoundedLLMProvider(this);
      if (identity.transport !== "bedrock-converse" || opts.maxResponseBytes === undefined
        || opts.model !== undefined && opts.model !== this.modelId)
        throw new Error("LLM_BOUNDED_IAM_CONTRACT_REQUIRED");
    }
    const iam = process.env.AWS_BEDROCK_AUTH_MODE === "iam";
    if (!iam && !this.apiKey) throw new Error("Bedrock requires explicit IAM authentication or a Bedrock API key");
    assertSelectedAwsRegion(this.region);
    if (/^(us|eu|apac|global|us-gov|au|jp|ca)\./.test(this.modelId)
      || (this.modelId.startsWith("arn:") && !this.modelId.startsWith(`arn:aws:bedrock:${this.region}::foundation-model/`))) {
      throw new Error("Bedrock requires an in-Region foundation model");
    }
    opts = normalizeCallOptions(opts);
    this.lastUsage = undefined;
    const planningCall = opts.purpose === "planning" && opts.channel !== "voice";
    return withGovernedModelInvocation({ provider: "bedrock", model: this.modelId, tenantId: opts.tenantId, channel: opts.channel,
      requireGovernance: opts.requireGovernance, deadlineAt: opts.deadlineAt }, async (capacitySignal, leases) => {
      const payload = {
        system: [{ text: opts.system }],
        messages: [{ role: "user" as const, content: [{ text: opts.user }] }],
        inferenceConfig: { maxTokens: opts.maxOutputTokens ?? (planningCall ? 1400 : 700), temperature: 0.1 },
      };
      let data: { output?: { message?: { content?: Array<{ text?: string }> } }; usage?: { inputTokens?: number; outputTokens?: number }; stopReason?: string };
      let responseBytes: number | null = null;
      let boundedSignal: AbortSignal | undefined;
      if (iam) {
        if (boundedOptions(opts)) {
          if (!opts.specialistIamSession) throw new Error("LLM_BOUNDED_IAM_EXISTING_SESSION_REQUIRED");
          const bounded = await completeBoundedBedrockIam(opts.specialistIamSession,
            { modelId: this.modelId, ...payload }, this.region, opts, capacitySignal, leases);
          data = bounded.output; responseBytes = bounded.responseBytes; boundedSignal = bounded.signal;
        } else {
        const budgetMs = remainingMs(opts, providerCallCeiling(opts, planningCall ? 25_000 : 8_000));
        if (budgetMs <= 0) throw new LLMDeadlineExceededError(opts.deadlineAt!);
        // Routing owns retries and one shared deadline across every physical attempt.
        this.client ??= new BedrockRuntimeClient({ region: this.region, maxAttempts: 1, authSchemePreference: ["aws.auth#sigv4"] });
        const signal = AbortSignal.any([AbortSignal.timeout(budgetMs), ...(opts.signal ? [opts.signal] : [])]);
        try {
          data = await this.client.send(new ConverseCommand({ modelId: this.modelId, ...payload }), { abortSignal: signal });
          if (Date.now() >= opts.deadlineAt!) throw new LLMDeadlineExceededError(opts.deadlineAt!);
        } catch (error) {
          if (opts.signal?.aborted) throw opts.signal.reason ?? Object.assign(new Error("LLM request aborted"), { name: "AbortError" });
          if (Date.now() >= opts.deadlineAt!) throw new LLMDeadlineExceededError(opts.deadlineAt!);
          if (signal.aborted) throw Object.assign(new Error("LLM provider timeout"), { name: "ProviderTimeoutError" });
          throw error;
        }
        }
      } else {
        const response = await fetchWithCallBudget(
          `https://bedrock-runtime.${this.region}.amazonaws.com/model/${this.modelId}/converse`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
          opts,
          planningCall ? 25_000 : 8_000,
        );
        if (!response.ok) throw new Error(`Bedrock (${this.modelId}) failed (${response.status})`);
        data = await response.json() as typeof data;
      }
      const usage: LLMUsage = { model: opts.model ?? this.modelId,
        inputTokens: boundedOptions(opts) ? boundedTokenCount(data.usage?.inputTokens) : data.usage?.inputTokens ?? null,
        outputTokens: boundedOptions(opts) ? boundedTokenCount(data.usage?.outputTokens) : data.usage?.outputTokens ?? null,
        ...(boundedOptions(opts) ? { responseBytes } : {}) };
      this.lastUsage = usage;
      opts.onBoundedUsage?.(Object.freeze({ ...usage }));
      if (boundedOptions(opts) && (data.stopReason !== "end_turn" && data.stopReason !== "stop_sequence"))
        throw new Error("LLM_BOUNDED_IAM_INCOMPLETE_ANALYSIS");
      const text = data.output?.message?.content?.map((block) => block.text ?? "").join("") ?? "";
      if (opts.onBoundedResponse) {
        if (!boundedOptions(opts) || !iam || !boundedSignal) throw new Error("LLM_NATIVE_BOUNDED_RESPONSE_OWNER_REQUIRED");
        boundedSignal.throwIfAborted();
        await opts.onBoundedResponse({ text, usage: Object.freeze({ ...usage }), signal: boundedSignal, leases });
        boundedSignal.throwIfAborted();
      }
      return text;
    });
  }
}
// Capture the loaded methods, not mutable prototype properties at assertion time.
const nativeOpenAIComplete = OpenAICompatibleProvider.prototype.complete;
const nativeBedrockComplete = BedrockConverseProvider.prototype.complete;

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

  get contextWindowTokens(): number {
    return compositeContextWindowTokens(this.providers);
  }

  withContextWindow(minimumTokens: number): LLMProvider {
    const eligible = this.providers.filter(provider => {
      try { return compositeContextWindowTokens([provider]) >= minimumTokens; }
      catch (error) {
        if (error instanceof LLMContextBudgetError && error.code === "UNKNOWN_CAPACITY") return false;
        throw error;
      }
    });
    if (!eligible.length) throw new LLMProviderSelectionError("No configured provider can fit the required conversation context");
    return new CompositeProvider(eligible);
  }

  lastUsage?: LLMUsage;
  lastAttempts: Array<Record<string, unknown>> = [];
  selectedProviderName?: string;
  get qualificationIdentity(): LLMProviderQualificationIdentity | undefined {
    const members: LLMProviderQualificationIdentity[] = [];
    for (const provider of this.providers) {
      if (!provider.qualificationIdentity) return undefined;
      members.push(provider.qualificationIdentity);
    }
    return { transport: "composite", members };
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    refuseUnsupportedBoundedAdapter(opts);
    const sharedOpts = normalizeCallOptions(opts);
    this.lastUsage = undefined;
    this.selectedProviderName = undefined;
    this.lastAttempts = [];
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
        this.selectedProviderName = p.selectedProviderName ?? p.name;
        this.lastUsage = p.lastUsage;
        this.lastAttempts.push(...(p.lastAttempts?.length ? p.lastAttempts : [{ invocationId: randomUUID(), provider: selectedName, status: "COMPLETED", usage: p.lastUsage ?? null, scope: "ADAPTER_CALL_PHYSICAL_DELIVERY_UNKNOWN", costUSD: null }]));
        // Record health at the concrete provider boundary. Nested composites already
        // record their own attempts, and the outer observability wrapper skips the
        // synthetic "composite" sample via recordsHealthInternally.
        if (!p.recordsHealthInternally) recordOutcome(selectedName, true, Date.now() - start);
        return text;
      } catch (err) {
        this.lastAttempts.push(...(p.lastAttempts?.length ? p.lastAttempts : [{ invocationId: randomUUID(), provider: selectedName, status: "FAILED", predicate: (err as Error).name, elapsedMs: Date.now() - start, deadlineAt: sharedOpts.deadlineAt, scope: "ADAPTER_CALL_PHYSICAL_DELIVERY_UNKNOWN", costUSD: null }]));
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
  lastAttempts: Array<Record<string, unknown>> = [];

  constructor(apiKey = process.env.GROQ_API_KEY, model = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b") {
    if (process.env.AWS_BEDROCK_AUTH_MODE === "iam") throw new LLMProviderSelectionError("Groq is disabled in Bedrock IAM deployments");
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    // No SDK-level retries: a throttled call fails in milliseconds and we fail over
    // to the next model, whose rate-limit bucket is separate — instead of sitting
    // out a 20-40s retry-after on the free tier.
    this.client = new Groq({ apiKey, timeout: 8_000, maxRetries: 0 });
    // Keep configured primary identity; current supported fallbacks have a
    // documented 131,072-token window and independent rate-limit buckets.
    const fallbacks = (process.env.GROQ_FALLBACK_MODELS ?? "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map(value => value.trim()).filter(Boolean);
    this.models = [model, ...fallbacks.filter((m) => m !== model)];
  }

  get qualificationIdentity(): LLMProviderQualificationIdentity {
    return { transport: "groq", name: this.name, models: [...this.models], endpointSha256: createHash("sha256").update(this.client.baseURL).digest("hex") };
  }

  async complete(opts: LLMCallOptions): Promise<string> {
    refuseUnsupportedBoundedAdapter(opts);
    const sharedOpts = normalizeCallOptions(opts);
    this.lastUsage = undefined;
    this.lastAttempts = [];
    let lastError: Error | null = null;
    for (const model of this.models) {
      const timeout = remainingMs(sharedOpts, 8_000);
      if (timeout <= 0) throw new LLMDeadlineExceededError(sharedOpts.deadlineAt ?? Date.now());
      const invocationId = randomUUID(), begun = Date.now();
      let invoked = false;
      try {
        const res = await withGovernedModelInvocation({ provider: this.name, model, tenantId: sharedOpts.tenantId, channel: sharedOpts.channel, ownerId: invocationId }, () => {
          invoked = true;
          return this.client.chat.completions.create(
          {
            model,
            messages: [
              { role: "system", content: sharedOpts.system },
              { role: "user", content: sharedOpts.user },
            ],
            temperature: 0.1,
            max_tokens: sharedOpts.maxOutputTokens ?? 700,
            ...(/^openai\/gpt-oss-(?:20b|120b)$/.test(model) && sharedOpts.reasoningEffort ? { reasoning_effort: sharedOpts.reasoningEffort } : {}),
            ...(sharedOpts.json ? { response_format: { type: "json_object" as const } } : {}),
          },
          { signal: sharedOpts.signal, timeout },
          );
        });
        this.lastUsage = { model, returnedModel: res.model ?? null, inputTokens: res.usage?.prompt_tokens ?? null, outputTokens: res.usage?.completion_tokens ?? null };
        this.lastAttempts.push({ invocationId, provider: this.name, requestedModel: model, returnedModel: res.model ?? null, status: "COMPLETED", invoked, usage: this.lastUsage, elapsedMs: Date.now() - begun, deadlineAt: sharedOpts.deadlineAt, outputTokenBound: sharedOpts.maxOutputTokens ?? 700, costUSD: null });
        return res.choices[0]?.message?.content ?? "";
      } catch (err) {
        const credential = process.env.GROQ_API_KEY;
        const detail = credential ? String((err as Error).message).split(credential).join("[REDACTED_CREDENTIAL]") : String((err as Error).message);
        this.lastAttempts.push({ invocationId, provider: this.name, requestedModel: model, returnedModel: null, status: "FAILED", invoked, statusCode: (err as { status?: number }).status ?? null, predicate: (err as Error).name, detail: detail.slice(0, 500), elapsedMs: Date.now() - begun, deadlineAt: sharedOpts.deadlineAt, outputTokenBound: sharedOpts.maxOutputTokens ?? 700, costUSD: null });
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
// These are the Bedrock model IDs for the single-key CENTROPY provider chain. Each
// can be overridden when an account pins a different active model revision.
const BEDROCK_GLM_MODEL_ID = () => process.env.AWS_BEDROCK_GLM_MODEL_ID ?? (process.env.AWS_BEDROCK_AUTH_MODE === "iam" ? "zai.glm-5" : "zai.glm-4.7");
const BEDROCK_MISTRAL_MODEL_ID = () => process.env.AWS_BEDROCK_MISTRAL_MODEL_ID ?? (process.env.AWS_BEDROCK_AUTH_MODE === "iam" ? "mistral.mistral-large-3-675b-instruct" : "mistral.mistral-small-2402-v1:0");
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

const bedrockConfigured = () => process.env.AWS_BEDROCK_AUTH_MODE === "iam" || Boolean(bedrockApiKey());
const mistralConfigured = () => Boolean(process.env.MISTRAL_API_KEY);
const deepseekConfigured = () => Boolean(process.env.DEEPSEEK_API_KEY || bedrockConfigured());
const groqConfigured = () => process.env.AWS_BEDROCK_AUTH_MODE !== "iam" && Boolean(process.env.GROQ_API_KEY);

const singleKeyMistralConfigured = () => Boolean(mistralConfigured() || bedrockConfigured());
const singleKeyBedrockProvider = (modelId: string, name: string) => new BedrockConverseProvider(modelId, undefined, undefined, name);

// Prefer the one configured Bedrock credential when present. Direct vendor keys
// remain a compatibility fallback for explicitly separate deployments, but a
// Bedrock-configured deployment never silently leaves the approved provider path.
addProvider("glm", () => singleKeyBedrockProvider(BEDROCK_GLM_MODEL_ID(), "glm"), bedrockConfigured);
addProvider("mistral", () => bedrockConfigured() ? singleKeyBedrockProvider(BEDROCK_MISTRAL_MODEL_ID(), "mistral") : new MistralProvider(), singleKeyMistralConfigured);
addProvider("deepseek", () => bedrockConfigured() ? singleKeyBedrockProvider(BEDROCK_DEEPSEEK_MODEL_ID(), "deepseek") : new DeepSeekProvider(), deepseekConfigured);
// Legacy providers remain available only when named explicitly or selected by an
// explicit route override. None is a default fallback in the CENTROPY route table.
addProvider("groq", () => new GroqProvider(), groqConfigured);
addProvider("bedrock-qwen-planning", () => new BedrockConverseProvider(BEDROCK_QWEN_PLANNING_MODEL_ID(), undefined, BEDROCK_QWEN_PLANNING_REGION(), "bedrock-qwen-planning"), bedrockConfigured);
addProvider("bedrock-qwen-fast", () => new BedrockConverseProvider(BEDROCK_QWEN_FAST_MODEL_ID(), undefined, undefined, "bedrock-qwen-fast"), bedrockConfigured);
addProvider("bedrock-deepseek", () => new BedrockConverseProvider(BEDROCK_DEEPSEEK_MODEL_ID(), undefined, undefined, "bedrock-deepseek"), bedrockConfigured);
addProvider("bedrock-openai-oss", () => new BedrockConverseProvider(BEDROCK_OPENAI_OSS_MODEL_ID(), undefined, undefined, "bedrock-openai-oss"), bedrockConfigured);
addProvider("bedrock-nova-micro", () => new BedrockConverseProvider(BEDROCK_NOVA_MICRO_MODEL_ID(), undefined, undefined, "bedrock-nova-micro"), bedrockConfigured);
addProvider("planning", () => {
  if (process.env.AWS_BEDROCK_AUTH_MODE === "iam") {
    return new CompositeProvider(DEFAULT_ROUTE_ORDER.planning.console.map(name => providers.get(name)!.factory()));
  }
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
  const wrapped: LLMProvider = {
    name: provider.name,
    get qualificationIdentity() { return provider.qualificationIdentity; },
    get contextWindowTokens() { return provider.contextWindowTokens; },
    ...(provider.withContextWindow ? { withContextWindow: (minimum: number) => withObservability(provider.withContextWindow!(minimum)) } : {}),
    get lastUsage() { return provider.lastUsage; },
    get lastAttempts() { return provider.lastAttempts; },
    get selectedProviderName() { return provider.selectedProviderName; },
    // This wrapper owns the health sample for ordinary providers. Composite
    // providers also report their concrete attempts internally, so an outer
    // wrapper must treat them as already accounted for.
    recordsHealthInternally: true,
    async complete(opts) {
      const sharedOpts = normalizeCallOptions(opts);
      const bounded: BoundedCallMetering | undefined = boundedOptions(sharedOpts)
        ? { usage: undefined, moneyUnknown: true } : undefined;
      if (bounded) assertNativeBoundedLLMProvider(provider);
      const callOpts = bounded && sharedOpts.requireGovernance && sharedOpts.maxResponseBytes !== undefined
        && sharedOpts.signal && Number.isFinite(sharedOpts.deadlineAt)
        ? { ...sharedOpts, onBoundedUsage: (usage: Readonly<LLMUsage>) => {
            if (bounded.usage) throw new Error("LLM_BOUNDED_USAGE_RECEIPT_REPLAY");
            bounded.usage = { ...usage };
            sharedOpts.onBoundedUsage?.(Object.freeze({ ...usage }));
          } } : sharedOpts;
      return observeAiOperation({ kind: "generation", name: `llm:${sharedOpts.purpose ?? "answer"}`, tenantId: sharedOpts.tenantId, correlationId: sharedOpts.traceId, actionId: sharedOpts.actionId, purpose: sharedOpts.purpose, channel: sharedOpts.channel, model: sharedOpts.model }, async () => {
      initObservability();
      const start = Date.now();
      try {
        await enforceBudget(sharedOpts);
        const text = await provider.complete(callOpts);
        const ms = Date.now() - start;
        const providerName = provider.selectedProviderName ?? provider.name;
        Sentry.addBreadcrumb({ category: "llm", message: providerName, data: { ok: true, ms } });
        if (!provider.recordsHealthInternally) recordOutcome(providerName, true, ms);
        await recordCall(provider, sharedOpts, "completed", {}, bounded).catch(() => undefined);
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
        await recordCall(provider, sharedOpts, deferred ? "deferred" : "failed",
          { error: (err as Error).message }, bounded).catch(() => undefined);
        throw err;
      }
      }, () => bounded ? bounded.usage : provider.lastUsage);
    },
  };
  providerWrappers.set(wrapped, { provider, complete: wrapped.complete });
  return wrapped;
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
  providerIdentities: Array<{ alias: string; identity: LLMProviderQualificationIdentity | null }>;
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
  const providerNames = routeNames(purpose, channel);
  return { purpose, channel, providerNames, providerIdentities: providerNames.map(alias => ({ alias,
    identity: providers.get(alias)?.factory().qualificationIdentity ?? null })), deadlineMs: DEFAULT_DEADLINE_MS[channel] };
}

export function isProviderConfigured(name: string): boolean {
  return providers.get(name)?.configured() === true;
}

export function isPurposeConfigured(purpose: LLMPurpose, channel: LLMChannel = "text"): boolean {
  return routeNames(purpose, channel).length > 0;
}

/** Configuration evidence only. Provider authorization and model quality still
 * require a physical invocation; neither is inferred from an IAM opt-in. */
export function describeLLMReadiness(): { configured: boolean; unavailableRoutes: string[] } {
  const unavailableRoutes: string[] = [];
  for (const purpose of Object.keys(DEFAULT_ROUTE_ORDER) as LLMPurpose[]) {
    for (const channel of Object.keys(DEFAULT_ROUTE_ORDER[purpose]) as LLMChannel[]) {
      if (!isPurposeConfigured(purpose, channel)) unavailableRoutes.push(`${purpose}:${channel}`);
    }
  }
  return { configured: unavailableRoutes.length === 0, unavailableRoutes };
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
  return withObservability(bindProviderToRequest(provider, request));
}

function bindProviderToRequest(provider: LLMProvider, request: LLMRouteRequest): LLMProvider {
  const channel = request.channel ?? "text";
  const wrapped: LLMProvider = {
    name: provider.name,
    get qualificationIdentity() { return provider.qualificationIdentity; },
    get contextWindowTokens() { return provider.contextWindowTokens; },
    ...(provider.withContextWindow ? { withContextWindow: (minimum: number) => bindProviderToRequest(provider.withContextWindow!(minimum), request) } : {}),
    get lastUsage() { return provider.lastUsage; },
    get lastAttempts() { return provider.lastAttempts; },
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
  providerWrappers.set(wrapped, { provider, complete: wrapped.complete });
  return wrapped;
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
