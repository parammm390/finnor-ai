export * from "./errors";
export * from "./wrap";
export * from "./registry";
export * from "./idempotent-call";
export * from "./mcp-client";
export * from "./builtin-tools";

import { ToolRegistry } from "./registry";
import { registerBuiltinTools } from "./builtin-tools";

/** Standard startup registry: built-ins registered once, extensible by callers. */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  return registry;
}
export * from "./vapi-rest";
export * from "./email";
export * from "./resend";
export * from "./backup-storage-github";
export * from "./exa";
export * from "./firecrawl";
export * from "./llm";
export * from "./voice-personas";
export * from "./health";
export * from "./observability";
export * from "./release";
export * from "./logger";
export * from "./provider-health";
export * from "./provider-circuit-breaker";
export * from "./provider-budget";
export * from "./emulators/fault-injection";
export * from "./emulators/apply-env-faults";
export * from "./tenant-provider";
export * from "./source-adapters";
export * from "./source-truth-health";
