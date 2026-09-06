// Tool registry (§11–12): a map of action-capable tools, each MCP-backed or stubbed.
// New integrations register new tools — orchestrator code never changes.

import { z } from "zod";
import type { ToolCallResult, RetryPolicy } from "./wrap";
import { wrappedCall, DEFAULT_RETRY } from "./wrap";
import { createHash } from "node:crypto";
import { ensureSecretsLoaded, minimizeExternalInput } from "@finnor/security";
import { claimExternalOperation, recordExternalOperationResult, awaitExternalOperationResolution, markExternalOperationUnknown } from "./idempotent-call";
import { initObservability, Sentry } from "./observability";

/** Trusted execution metadata injected by an action/workflow boundary. It is never
 * parsed from planner/tool input and never forwarded to an external provider. */
export interface ToolRuntimeContext {
  tenantId?: string;
  actorId?: string;
  purpose?: string;
  domainActionId?: string;
  communicationIdentityId?: string;
  authProfileRef?: string;
  /** Frozen semantic effect identity. Trusted execution metadata only: plugins and
   * providers cannot replace it through their payload. */
  businessEffectId?: string;
  businessEffectHash?: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  integration: string;
  retryPolicy?: RetryPolicy;
  /** Fields actually forwarded to this external provider. Omitted = today's
   *  pass-through behavior (opt-in per tool). Every builtin tool schema uses
   *  .passthrough(), so without this a stray field (deal notes, an SSN some
   *  future planner payload attaches) flows straight to the external adapter. */
  piiAllowlist?: readonly string[];
  run(input: Record<string, unknown>, runtime?: Readonly<ToolRuntimeContext>): Promise<Record<string, unknown>>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  /** Presentation-safe provenance for the implementation that will receive a tool
   * call. Inputs, credentials, and provider responses are deliberately absent. */
  integrationFor(name: string): string | null {
    return this.tools.get(name)?.integration ?? null;
  }

  /** Trusted execution metadata is absent on an unscoped registry. Plugins may read
   * it only after GatedExecutor constructs a ScopedToolRegistry. */
  runtimeContext(): Readonly<ToolRuntimeContext> | undefined {
    return undefined;
  }

  /** Stable semantic idempotency is meaningful only in a scoped execution. The base
   * registry keeps compatibility for tests/tools that intentionally run unscoped. */
  async callIdempotent(name: string, input: Record<string, unknown>, _semanticKey: string): Promise<ToolCallResult> {
    return this.call(name, input);
  }

  /** Every call goes through secrets loading, validation, PII minimization (if the
   *  tool opts in), and the timeout/retry wrapper. Never bare. Observability rides on
   *  this same chokepoint: a breadcrumb per call (tool name, integration, latency,
   *  ok/fail — never the input/output itself, respecting the PII-minimization above),
   *  and a captured message on failure. No-ops harmlessly without SENTRY_DSN. */
  async call(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    return this.callWithRuntimeContext(name, input, {});
  }

  /** ScopedToolRegistry is the only production caller that supplies this context.
   * Keeping it out of input validation prevents a forged payload from replacing the
   * authenticated actor, tenant, identity handle, or authProfileRef. */
  async callWithRuntimeContext(
    name: string,
    input: Record<string, unknown>,
    runtime: Readonly<ToolRuntimeContext>,
  ): Promise<ToolCallResult> {
    initObservability();
    await ensureSecretsLoaded();
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: {}, error: `Unknown tool: ${name}` };
    }
    const effectiveInput = runtime.tenantId ? { ...input, tenantId: runtime.tenantId } : input;
    const parsed = tool.inputSchema.safeParse(effectiveInput);
    if (!parsed.success) {
      return {
        ok: false,
        output: {},
        error: `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      };
    }
    const safeInput = tool.piiAllowlist ? minimizeExternalInput(parsed.data, tool.piiAllowlist) : parsed.data;
    const start = Date.now();
    const result = await wrappedCall(
      tool.integration,
      () => Object.keys(runtime).length > 0 ? tool.run(safeInput, runtime) : tool.run(safeInput),
      tool.retryPolicy ?? DEFAULT_RETRY,
    );
    const ms = Date.now() - start;
    Sentry.addBreadcrumb({ category: "tool", message: name, data: { integration: tool.integration, ok: result.ok, ms } });
    if (!result.ok) Sentry.captureMessage(`tool_failed:${name}`, { level: "warning" });
    return result;
  }
}

export interface ToolCallContext {
  tenantId: string;
  domainActionId: string;
  actorId?: string;
  purpose?: string;
  communicationIdentityId?: string;
  authProfileRef?: string;
  businessEffectId?: string;
  businessEffectHash?: string;
  /** Deterministic namespace for independently queued targets/batches of one action. */
  operationKeyPrefix?: string;
}

/**
 * Wraps a real ToolRegistry with an idempotency claim against the external_operations
 * ledger (packages/db/schema.ts) — one row per (domainActionId, tool-name+call-index),
 * so a retried execution (reflection retry, a resumed LangGraph thread) never re-fires
 * a side effect that already SUCCEEDED, while a call that previously FAILED is always
 * allowed to actually retry (that's exactly what reflection is for — a failed attempt
 * didn't deliver anything, so re-running it isn't a duplicate). Subclasses ToolRegistry
 * (not a duck-typed wrapper) because `tools` is a private field — every plugin's
 * `execute(draft, tools: ToolRegistry)` already accepts this structurally, so this
 * requires zero plugin signature changes. Constructed fresh per action execution at
 * the two chokepoints that call plugin.execute() — GatedExecutor and
 * makeExecuteNode() — after the confirmation gate has already cleared. Relies on
 * plugins' execute() being deterministic (same draft → same sequence of tool calls),
 * which holds for every plugin in this codebase today — a retry's Nth call lands on
 * the same operationKey as the original attempt's Nth call.
 */
export class ScopedToolRegistry extends ToolRegistry {
  // Per-instance call counter, not per-tool: several plugins (bulk_notify_existing_
  // customers, proposal-batch) call the SAME tool once per target in a loop within one
  // execute() — keying purely on tool name would make target #2's send look like a
  // duplicate of target #1's and silently skip it. A fresh ScopedToolRegistry is
  // constructed per execute() call (see executor.ts/graph/nodes.ts), so a reflection
  // retry that replays the same deterministic call sequence lands on the SAME
  // operationKey per call, letting claimExternalOperation's failed->retry logic work
  // per-call: a call that already succeeded is never re-run, one that failed is.
  private callIndex = 0;

  constructor(
    private base: ToolRegistry,
    private ctx: ToolCallContext,
  ) {
    super();
  }

  override has(name: string): boolean {
    return this.base.has(name);
  }

  override list(): string[] {
    return this.base.list();
  }

  override integrationFor(name: string): string | null {
    return this.base.integrationFor(name);
  }

  override runtimeContext(): Readonly<ToolRuntimeContext> {
    return Object.freeze({
      tenantId: this.ctx.tenantId,
      domainActionId: this.ctx.domainActionId,
      ...(this.ctx.actorId ? { actorId: this.ctx.actorId } : {}),
      ...(this.ctx.purpose ? { purpose: this.ctx.purpose } : {}),
      ...(this.ctx.communicationIdentityId ? { communicationIdentityId: this.ctx.communicationIdentityId } : {}),
      ...(this.ctx.authProfileRef ? { authProfileRef: this.ctx.authProfileRef } : {}),
      ...(this.ctx.businessEffectId ? { businessEffectId: this.ctx.businessEffectId } : {}),
      ...(this.ctx.businessEffectHash ? { businessEffectHash: this.ctx.businessEffectHash } : {}),
    });
  }

  override async call(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const operationKey = `${this.ctx.operationKeyPrefix ? `${this.ctx.operationKeyPrefix}:` : ""}${name}:${this.callIndex++}`;
    return this.callForOperation(name, input, operationKey);
  }

  override async callIdempotent(name: string, input: Record<string, unknown>, semanticKey: string): Promise<ToolCallResult> {
    const safeKey = createHash("sha256").update(semanticKey).digest("hex").slice(0, 32);
    const operationKey = `${this.ctx.operationKeyPrefix ? `${this.ctx.operationKeyPrefix}:` : ""}${name}:semantic:${safeKey}`;
    return this.callForOperation(name, input, operationKey);
  }

  private async callForOperation(name: string, input: Record<string, unknown>, operationKey: string): Promise<ToolCallResult> {
    const requestHash = hashInput(input);
    const declaredProvider = this.base.integrationFor(name) ?? undefined;
    const provider = declaredProvider;
    const claim = await claimExternalOperation(
      this.ctx.tenantId,
      this.ctx.domainActionId,
      operationKey,
      requestHash,
      provider,
      this.ctx.businessEffectId,
      this.ctx.authProfileRef,
    );
    if (!claim.claimed) {
      if (claim.existing.requestHash !== requestHash) {
        return {
          ok: false,
          output: {},
          error: `Idempotency conflict: ${name} already ran for this action with different input — refusing to re-run with new input`,
          errorKind: "conflict",
        };
      }
      // The winner of the claim race may still be mid-call — wait for it to settle
      // rather than reporting a false "not ok" for a call that's genuinely in progress.
      const settled = await awaitExternalOperationResolution(this.ctx.tenantId, this.ctx.domainActionId, operationKey, claim.existing);
      // Match wrappedCall's own convention exactly (wrap.ts): integrationUnavailable is
      // only ever present on a failure, never as an explicit `false` on success.
      if (settled.status === "succeeded") {
        return { ok: true, output: (settled.response ?? {}) as Record<string, unknown> };
      }
      if (settled.status === "unknown") {
        return { ok: false, output: (settled.response ?? {}) as Record<string, unknown>, error: "Provider outcome is unknown; reconcile before retrying", integrationUnavailable: true, errorKind: "unknown_outcome" };
      }
      if (settled.status === "running") {
        await markExternalOperationUnknown(this.ctx.tenantId, this.ctx.domainActionId, operationKey, { reason: "claim_owner_did_not_settle" });
        return { ok: false, output: {}, error: "Prior provider attempt did not settle; outcome requires reconciliation", integrationUnavailable: true, errorKind: "unknown_outcome" };
      }
      return { ok: false, output: (settled.response ?? {}) as Record<string, unknown>, integrationUnavailable: true, errorKind: "retryable" };
    }
    const result = await this.base.callWithRuntimeContext(name, input, {
      tenantId: this.ctx.tenantId,
      domainActionId: this.ctx.domainActionId,
      ...(this.ctx.actorId ? { actorId: this.ctx.actorId } : {}),
      ...(this.ctx.purpose ? { purpose: this.ctx.purpose } : {}),
      ...(this.ctx.communicationIdentityId ? { communicationIdentityId: this.ctx.communicationIdentityId } : {}),
      ...(this.ctx.authProfileRef ? { authProfileRef: this.ctx.authProfileRef } : {}),
      ...(this.ctx.businessEffectId ? { businessEffectId: this.ctx.businessEffectId } : {}),
      ...(this.ctx.businessEffectHash ? { businessEffectHash: this.ctx.businessEffectHash } : {}),
    });
    const operation = await recordExternalOperationResult(
      this.ctx.tenantId,
      this.ctx.domainActionId,
      operationKey,
      result.ok ? "succeeded" : result.errorKind === "unknown_outcome" ? "unknown" : "failed",
      result.ok ? result.output : { ...result.output, ...(result.error ? { error: result.error } : {}), ...(result.errorKind ? { errorKind: result.errorKind } : {}) },
    );
    if (result.ok && operation?.verificationStatus === "awaiting_observation" && this.ctx.businessEffectId) {
      const { enqueueJob } = await import("@finnor/db");
      await enqueueJob(
        "observe_external_effect",
        { tenantId: this.ctx.tenantId, externalOperationKey: operation.operationKey, domainActionId: this.ctx.domainActionId, attempt: 1 },
        `observe-effect:${this.ctx.tenantId}:${this.ctx.domainActionId}:${operation.operationKey}:1`,
      );
    }
    return result;
  }
}

function hashInput(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
