// Re-exported from @finnor/tools, where this now lives — domain-plugins needs the
// same LLMProvider abstraction (the grounded-QA action in ops-overview calls it),
// and domain-plugins -> orchestration would be a package cycle. @finnor/tools has no
// dependency on orchestration or domain-plugins, so it's the correct home. Kept as a
// named re-export here (not `export *`) so nothing inside orchestration (planner.ts,
// index.ts) had to change, without also re-exporting all of @finnor/tools' unrelated
// surface (ToolRegistry, registerBuiltinTools, etc.) through orchestration's API.
export {
  type LLMProvider,
  type LLMChannel,
  type LLMPurpose,
  type LLMCallOptions,
  type LLMRouteRequest,
  type LLMRouteDescription,
  BedrockAnthropicProvider,
  BedrockOpenAICompatProvider,
  DeepSeekProvider,
  MistralProvider,
  CompositeProvider,
  GroqProvider,
  LLMDeadlineExceededError,
  LLMProviderSelectionError,
  registerProvider,
  resolveProvider,
  resolveProviderForChannel,
  resolveProviderForRequest,
  resolveProviderForPurpose,
  describeLLMRoute,
  isProviderConfigured,
  isPurposeConfigured,
  LLMBudgetDeferredError,
} from "@finnor/tools/llm";
