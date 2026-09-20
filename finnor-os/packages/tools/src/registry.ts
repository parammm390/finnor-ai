// Tool registry (§11–12): a map of action-capable tools, each MCP-backed or stubbed.
// New integrations register new tools — orchestrator code never changes.

import { z } from "zod";
import type { ToolCallResult, RetryPolicy } from "./wrap";
import { wrappedCall, DEFAULT_RETRY } from "./wrap";
import { createHash } from "node:crypto";
import { ensureSecretsLoaded, minimizeExternalInput } from "@finnor/security";
import {
  claimExternalOperation,
  recordExternalOperationResult,
  awaitExternalOperationResolution,
  markExternalOperationUnknown,
  prepareProviderInvocation,
  markProviderRequestMayHaveLeft,
  recordProviderInvocationAcknowledged,
  recordProviderInvocationFailure,
  type ExternalOperationContract,
  type ProviderInvocationContext,
} from "./idempotent-call";
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
  workflowStepClaimId?: string;
  providerOperationAttemptId?: string;
  providerOperationRequestHash?: string;
  providerIdempotencyKey?: string;
  providerIdempotencyScope?: string;
  providerIdempotencyExpiresAt?: Date;
}

export interface ToolExecutionContract {
  effect: "read_only" | "consequential";
  retrySafety: ExternalOperationContract["retrySafety"];
  idempotency: ExternalOperationContract["idempotency"];
  verification: "acknowledgement" | "readback" | "webhook_or_readback" | "none";
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  integration: string;
  retryPolicy?: RetryPolicy;
  execution: ToolExecutionContract;
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

  executionContractFor(name: string): ToolExecutionContract | null {
    const tool = this.tools.get(name);
    if (!tool) return null;
    return tool.execution;
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
    const executionContract = this.executionContractFor(name)!;
    if (executionContract.effect === "consequential" && (!runtime.tenantId
        || !runtime.providerOperationAttemptId || !runtime.providerOperationRequestHash)) {
      return {
        ok: false,
        output: {},
        error: `Consequential tool ${name} requires a durable logical operation and provider-operation attempt`,
        errorKind: "conflict",
      };
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
    const invocationContext: ProviderInvocationContext | null = executionContract.effect === "consequential"
      ? {
          tenantId: runtime.tenantId!,
          providerOperationAttemptId: runtime.providerOperationAttemptId!,
          provider: tool.integration,
          requestHash: runtime.providerOperationRequestHash!,
          ...(runtime.providerIdempotencyKey ? { providerIdempotencyKey: runtime.providerIdempotencyKey } : {}),
          ...(runtime.providerIdempotencyScope ? { providerIdempotencyScope: runtime.providerIdempotencyScope } : {}),
          ...(runtime.providerIdempotencyExpiresAt ? { providerIdempotencyExpiresAt: runtime.providerIdempotencyExpiresAt } : {}),
          transportLayer: "wrapped_call",
        }
      : null;
    const providerIdempotencyActive = executionContract.idempotency.mode === "inherently_idempotent"
      || (executionContract.idempotency.mode === "provider_key"
        && Boolean(runtime.providerIdempotencyKey)
        && runtime.providerIdempotencyExpiresAt !== undefined
        && runtime.providerIdempotencyExpiresAt.getTime() > Date.now());
    const result = await wrappedCall(
      tool.integration,
      () => Object.keys(runtime).length > 0 ? tool.run(safeInput, runtime) : tool.run(safeInput),
      tool.retryPolicy ?? DEFAULT_RETRY,
      {
        consequential: executionContract.effect === "consequential",
        providerIdempotencyActive,
        ...(invocationContext ? {
          audit: {
            prepare: (ordinal: number) => prepareProviderInvocation(invocationContext, ordinal),
            requestMayHaveLeft: (invocationId: string) => markProviderRequestMayHaveLeft(invocationContext.tenantId, invocationId),
            acknowledged: (invocationId: string, output: Record<string, unknown>) => recordProviderInvocationAcknowledged(invocationContext, invocationId, output),
            failed: (invocationId: string, failure: { kind: string; message: string; definitePreDispatch: boolean; definiteRejection?: boolean }) => recordProviderInvocationFailure(invocationContext, invocationId, failure),
          },
        } : {}),
      },
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
  workflowStepClaimId?: string;
  /** Deterministic namespace for independently queued targets/batches of one action. */
  operationKeyPrefix?: string;
}

/**
 * Consequential calls are admitted only through an explicit semantic member key and
 * the canonical external_operations ledger. DomainAction remains the Scope-1 owner;
 * this wrapper adds the logical provider operation, its legally-authorized runtime
 * attempt, and audited physical invocations beneath it. A failed/unknown operation is
 * not replayed merely because delivery or reflection retried: reclaim requires durable
 * proof (pre-dispatch failure, definite rejection, verified absence, active provider
 * idempotency, inherent repeatability, or governed operator resolution).
 *
 * Read-only calls retain the legacy call-index fallback because they cannot create an
 * external business effect. Consequential `call()` fails closed and callers must use
 * `callIdempotent()` with target/member identity stable across restart and refactoring.
 */
export class ScopedToolRegistry extends ToolRegistry {
  // This counter is reachable only for non-consequential compatibility calls. It is
  // never accepted as the identity of a consequential provider operation.
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

  override executionContractFor(name: string): ToolExecutionContract | null {
    return this.base.executionContractFor(name);
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
      ...(this.ctx.workflowStepClaimId ? { workflowStepClaimId: this.ctx.workflowStepClaimId } : {}),
    });
  }

  override async call(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    const contract = this.base.executionContractFor(name);
    if (contract?.effect === "consequential") {
      return {
        ok: false,
        output: {},
        error: `Consequential tool ${name} requires callIdempotent() with a stable semantic member key`,
        errorKind: "conflict",
      };
    }
    if (contract?.effect === "read_only") {
      return this.base.callWithRuntimeContext(name, input, this.runtimeContext());
    }
    const operationKey = `${this.ctx.operationKeyPrefix ? `${this.ctx.operationKeyPrefix}:` : ""}${name}:${this.callIndex++}`;
    return this.callForOperation(name, input, operationKey);
  }

  override async callIdempotent(name: string, input: Record<string, unknown>, semanticKey: string): Promise<ToolCallResult> {
    const contract = this.base.executionContractFor(name);
    if (contract?.effect === "read_only") return this.base.callWithRuntimeContext(name, input, this.runtimeContext());
    const safeKey = createHash("sha256").update(semanticKey).digest("hex").slice(0, 32);
    const operationKey = `${this.ctx.operationKeyPrefix ? `${this.ctx.operationKeyPrefix}:` : ""}${name}:semantic:${safeKey}`;
    return this.callForOperation(name, input, operationKey);
  }

  private async callForOperation(name: string, input: Record<string, unknown>, operationKey: string): Promise<ToolCallResult> {
    const requestHash = hashInput(input);
    const declaredProvider = this.base.integrationFor(name) ?? undefined;
    const provider = declaredProvider;
    const executionContract = this.base.executionContractFor(name);
    if (!executionContract) {
      return { ok: false, output: {}, error: `Unknown tool: ${name}`, errorKind: "validation" };
    }
    const claim = await claimExternalOperation(
      this.ctx.tenantId,
      this.ctx.domainActionId,
      operationKey,
      requestHash,
      provider,
      this.ctx.businessEffectId,
      this.ctx.authProfileRef,
      {
        protocolVersion: 2,
        targetKey: operationKey,
        workflowStepClaimId: this.ctx.workflowStepClaimId,
        retrySafety: executionContract.retrySafety,
        idempotency: executionContract.idempotency,
        verification: executionContract.verification,
      },
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
      ...(this.ctx.workflowStepClaimId ? { workflowStepClaimId: this.ctx.workflowStepClaimId } : {}),
      providerOperationAttemptId: claim.providerOperationAttemptId,
      providerOperationRequestHash: requestHash,
      ...(claim.operation.providerIdempotencyKey ? { providerIdempotencyKey: claim.operation.providerIdempotencyKey } : {}),
      ...(claim.operation.providerIdempotencyScope ? { providerIdempotencyScope: claim.operation.providerIdempotencyScope } : {}),
      ...(claim.operation.providerIdempotencyExpiresAt ? { providerIdempotencyExpiresAt: claim.operation.providerIdempotencyExpiresAt } : {}),
    });
    await recordExternalOperationResult(
      this.ctx.tenantId,
      this.ctx.domainActionId,
      operationKey,
      result.ok ? "succeeded" : result.errorKind === "unknown_outcome" ? "unknown" : "failed",
      result.ok ? result.output : { ...result.output, ...(result.error ? { error: result.error } : {}), ...(result.errorKind ? { errorKind: result.errorKind } : {}) },
      claim.providerOperationAttemptId,
    );
    // The acknowledgement/result persistence boundary atomically inserts any
    // required observation job. Never create a post-commit scheduling window here.
    return result;
  }
}

function hashInput(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
