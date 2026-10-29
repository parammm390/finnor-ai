import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LLMProvider, LLMProviderQualificationIdentity } from "./llm";

const PROFILE_REVISION = "finnor-model-context/2026-10-29/v1";
const CAPACITY = z.number().int().positive().safe();
const CONFIGURATION = z.record(z.string().min(1), CAPACITY);

export type LLMContextBudgetErrorCode =
  | "UNKNOWN_CAPACITY"
  | "INVALID_CAPACITY"
  | "INVALID_CONFIGURATION"
  | "INVALID_OUTPUT_RESERVE"
  | "OUTPUT_EXCEEDS_CONTEXT";

export class LLMContextBudgetError extends Error {
  constructor(readonly code: LLMContextBudgetErrorCode, readonly subject: string) {
    super(`LLM_CONTEXT_${code}: ${subject}`);
    this.name = "LLMContextBudgetError";
  }
}

export interface LLMContextBudget {
  profileId: string;
  contextWindowTokens: number;
  outputTokens: number;
  /** Input content plus caller-reserved native message framing must fit here. */
  inputTokens: number;
  countingBasis: string;
}

interface CapacityProfile {
  tokens: number;
  source: string;
}

// Versioned supported ceilings, sometimes below documented maxima. Capacity is
// distinct from model availability, authorization, quality, and rate limits.
const BEDROCK_PROFILES: ReadonlyMap<string, CapacityProfile> = new Map([
  ["mistral.mistral-small-2402-v1:0", { tokens: 32_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-small.html" }],
  ["mistral.mistral-large-3-675b-instruct", { tokens: 256_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-large-3.html" }],
  ["zai.glm-4.7", { tokens: 200_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7.html" }],
  ["zai.glm-5", { tokens: 200_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5.html" }],
  ["deepseek.v3.2", { tokens: 160_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html" }],
  ["qwen.qwen3-32b-v1:0", { tokens: 32_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-32b.html" }],
  ["qwen.qwen3-235b-a22b-2507-v1:0", { tokens: 128_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards-qwen.html" }],
  ["openai.gpt-oss-120b-1:0", { tokens: 128_000, source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html" }],
  ["amazon.nova-micro-v1:0", { tokens: 128_000, source: "https://docs.aws.amazon.com/nova/latest/userguide/" }],
]);

const GROQ_PROFILES: ReadonlyMap<string, CapacityProfile> = new Map([
  ["llama-3.3-70b-versatile", { tokens: 131_072, source: "https://console.groq.com/docs/models" }],
  ["llama-3.1-8b-instant", { tokens: 131_072, source: "https://console.groq.com/docs/models" }],
  ["openai/gpt-oss-120b", { tokens: 131_072, source: "https://console.groq.com/docs/models" }],
  ["openai/gpt-oss-20b", { tokens: 131_072, source: "https://console.groq.com/docs/models" }],
]);

const MISTRAL_PROFILES: ReadonlyMap<string, CapacityProfile> = new Map([
  ["mistral-small-2603", { tokens: 256_000, source: "https://docs.mistral.ai/models/mistral-small-4-0-26-03" }],
  ["mistral-small-latest", { tokens: 128_000, source: "https://docs.mistral.ai/vibe/code/cli/configuration" }],
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredCapacities(): Record<string, number> {
  // Keys are exact identity keys such as "bedrock:vendor.model", "groq:model",
  // or "openai-compatible:provider:endpointSha256:model". No key is a secret.
  const raw = process.env.FINNOR_LLM_CONTEXT_WINDOWS;
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LLMContextBudgetError("INVALID_CONFIGURATION", "FINNOR_LLM_CONTEXT_WINDOWS must be a JSON object of positive integer capacities");
  }
  const validated = CONFIGURATION.safeParse(parsed);
  if (!validated.success) throw new LLMContextBudgetError("INVALID_CONFIGURATION", "FINNOR_LLM_CONTEXT_WINDOWS must be a JSON object of positive integer capacities");
  return validated.data;
}

function capacityForModel(key: string, known: CapacityProfile | undefined, configured: Record<string, number>): number {
  const declared = configured[key];
  if (declared !== undefined) return known ? Math.min(declared, known.tokens) : declared;
  if (known) return known.tokens;
  throw new LLMContextBudgetError("UNKNOWN_CAPACITY", key);
}

function minimum(capacities: number[], subject: string): number {
  if (capacities.length === 0) throw new LLMContextBudgetError("UNKNOWN_CAPACITY", subject);
  return Math.min(...capacities);
}

function identityCapacity(identity: LLMProviderQualificationIdentity, configured: Record<string, number>): number {
  switch (identity.transport) {
    case "bedrock-converse":
    case "bedrock-invoke": {
      const prefix = `arn:aws:bedrock:${identity.region}::foundation-model/`;
      const model = identity.model.startsWith(prefix) ? identity.model.slice(prefix.length) : identity.model;
      return capacityForModel(`bedrock:${model}`, BEDROCK_PROFILES.get(model), configured);
    }
    case "groq": {
      const officialEndpoint = identity.endpointSha256 === hash("https://api.groq.com");
      return minimum(identity.models.map(model => capacityForModel(
        officialEndpoint ? `groq:${model}` : `groq:${identity.endpointSha256}:${model}`,
        officialEndpoint ? GROQ_PROFILES.get(model) : undefined,
        configured,
      )), identity.name);
    }
    case "openai-compatible": {
      const officialMistral = identity.name === "mistral"
        && identity.endpointSha256 === hash("https://api.mistral.ai/v1/chat/completions");
      return capacityForModel(
        `openai-compatible:${identity.name}:${identity.endpointSha256}:${identity.model}`,
        officialMistral ? MISTRAL_PROFILES.get(identity.model) : undefined,
        configured,
      );
    }
    case "composite":
      return minimum(identity.members.map(member => identityCapacity(member, configured)), "composite");
    case "custom":
      return capacityForModel(`custom:${identity.name}:${identity.revision}`, undefined, configured);
    default: {
      const exhaustive: never = identity;
      return exhaustive;
    }
  }
}

function providerCapacity(provider: LLMProvider, configured: Record<string, number>): number {
  const declared = provider.contextWindowTokens;
  if (declared !== undefined) {
    if (!CAPACITY.safeParse(declared).success) throw new LLMContextBudgetError("INVALID_CAPACITY", provider.name);
    if (provider.qualificationIdentity) {
      try {
        return Math.min(declared, identityCapacity(provider.qualificationIdentity, configured));
      } catch (error) {
        if (!(error instanceof LLMContextBudgetError) || error.code !== "UNKNOWN_CAPACITY") throw error;
      }
    }
    return declared;
  }
  if (provider.qualificationIdentity) return identityCapacity(provider.qualificationIdentity, configured);
  return capacityForModel(`custom:${provider.name}`, undefined, configured);
}

/** Used by CompositeProvider so explicit capacities on custom members survive. */
export function compositeContextWindowTokens(providers: readonly LLMProvider[]): number {
  const configured = configuredCapacities();
  return minimum(providers.map(provider => providerCapacity(provider, configured)), "composite");
}

/** A text-content upper bound for byte-tokenized models, excluding native framing. */
export function countPromptTokensUpperBound(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export async function resolveLLMContextBudget(provider: LLMProvider, outputTokens = 1400): Promise<LLMContextBudget> {
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 4096) {
    throw new LLMContextBudgetError("INVALID_OUTPUT_RESERVE", provider.name);
  }
  const contextWindowTokens = providerCapacity(provider, configuredCapacities());
  if (contextWindowTokens <= outputTokens) throw new LLMContextBudgetError("OUTPUT_EXCEEDS_CONTEXT", provider.name);
  const identity = provider.qualificationIdentity ?? { name: provider.name };
  return {
    profileId: `${PROFILE_REVISION}:${hash(JSON.stringify({ identity, contextWindowTokens })).slice(0, 24)}`,
    contextWindowTokens,
    outputTokens,
    inputTokens: contextWindowTokens - outputTokens,
    countingBasis: "UTF8_BYTES_UPPER_BOUND; NATIVE_MESSAGE_FRAMING_RESERVED_BY_CALLER",
  };
}
