// Uniform wrapper for every tool call: timeout, retry with backoff, typed result (§22, §30).
// Reflection evaluates the structured result — no tool is called "bare".

import { IntegrationError, IntegrationTimeoutError } from "./errors";
import type { ErrorKind } from "@finnor/shared-types";

export interface ToolCallResult {
  ok: boolean;
  output: Record<string, unknown>;
  error?: string;
  integrationUnavailable?: boolean;
  errorKind?: ErrorKind;
}

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

export interface InvocationAuditHooks {
  prepare(ordinal: number): Promise<string>;
  requestMayHaveLeft(invocationId: string): Promise<void>;
  acknowledged(invocationId: string, output: Record<string, unknown>): Promise<void>;
  failed(invocationId: string, failure: { kind: string; message: string; definitePreDispatch: boolean; definiteRejection?: boolean }): Promise<void>;
}

export interface WrappedCallExecution {
  consequential?: boolean;
  /** True only while the provider's documented key scope/TTL still guarantees
   * equivalent replay. Merely possessing an old key is insufficient. */
  providerIdempotencyActive?: boolean;
  audit?: InvocationAuditHooks;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 500, timeoutMs: 15_000 };

async function withTimeout<T>(integration: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IntegrationTimeoutError(integration, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function wrappedCall(
  integration: string,
  fn: () => Promise<Record<string, unknown>>,
  policy: RetryPolicy = DEFAULT_RETRY,
  execution: WrappedCallExecution = {},
): Promise<ToolCallResult> {
  let lastError: Error | null = null;
  let finalKind: ErrorKind = "retryable";
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    let invocationId: string | null = null;
    try {
      if (execution.audit) {
        invocationId = await execution.audit.prepare(attempt);
        // The generic wrapper cannot see the exact byte-write boundary inside every
        // SDK/client. Mark conservatively before adapter entry: no possible effect is
        // ever invisible, while provider-specific hooks may later sharpen the fact.
        await execution.audit.requestMayHaveLeft(invocationId);
      }
      const output = await withTimeout(integration, policy.timeoutMs, fn());
      if (invocationId && execution.audit) await execution.audit.acknowledged(invocationId, output);
      return { ok: true, output };
    } catch (err) {
      lastError = err as Error;
      const definitePreDispatch = err instanceof IntegrationError
        && err.requestDisposition === "definite_pre_dispatch";
      finalKind = execution.consequential && !definitePreDispatch
        ? "unknown_outcome"
        : err instanceof IntegrationError ? err.kind : execution.consequential ? "unknown_outcome" : "retryable";
      if (invocationId && execution.audit) {
        await execution.audit.failed(invocationId, {
          kind: finalKind,
          message: lastError.message,
          definitePreDispatch,
        });
      }
      // Only provider adapters that normalized an error as retryable may trigger an
      // inline retry. An arbitrary exception can represent a validation bug or an
      // unknown consequential outcome; guessing "transient" here could duplicate a
      // real-world effect.
      const retryable = err instanceof IntegrationError ? err.retryable : false;
      const repetitionProvenSafe = !execution.consequential
        || definitePreDispatch
        || execution.providerIdempotencyActive === true;
      if (!retryable || !repetitionProvenSafe || attempt === policy.attempts) break;
      await new Promise((r) => setTimeout(r, policy.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  return {
    ok: false,
    output: {},
    error: lastError?.message ?? "unknown integration failure",
    // Continued failure → caller sets domain_action status blocked_integration_unavailable (§30).
    integrationUnavailable: true,
    errorKind: finalKind,
  };
}
