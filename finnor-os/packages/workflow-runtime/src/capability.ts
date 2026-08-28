// Capability contract + binding types, and the generic execution wrapper that claims an
// integration_operations row before calling out. This generalizes the existing
// external_operations claim/reclaim dance (packages/tools/src/idempotent-call.ts) from
// being keyed by domain_action_id to being keyed by workflow_step_id.
//
// RetryPolicy is redeclared here (not imported from @finnor/tools) deliberately: contract
// implementations live in @finnor/tools/src/capabilities/* and import CapabilityContract/
// CapabilityBinding FROM this package, so this package must not depend back on
// @finnor/tools — that would be circular. The shape is intentionally identical to
// packages/tools/src/wrap.ts's RetryPolicy.

import { enqueueJob, withTenant, integrationOperations, reconciliationCases, tenantIntegrations, workflowSteps } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { maybeChaosKill } from "./chaos";

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
}

export interface CapabilityContract<TIn, TOut> {
  domain: "scheduling" | "communications" | "crm" | "accounting" | "marketing" | "inventory" | "documents";
  capability: string;
  version: number;
  idempotencyKeyFrom(input: TIn): string;
  retryPolicy: RetryPolicy;
  requiredPermission: string;
  piiAllowlist: readonly string[];
  /** false ⇒ a post-commit-pre-ack crash always opens a reconciliation_case; the
   *  runtime never auto-retries a call whose real-world delivery is unknown. */
  retryOnUnknown: boolean;
}

export interface CapabilityBinding<TIn, TOut> {
  name: string;
  call(input: TIn): Promise<TOut>;
  reconcile?(operationKey: string): Promise<"delivered" | "not_delivered" | "unknown">;
  compensate?(input: TIn, output: TOut): Promise<void>;
}

function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export type CapabilityResult<TOut> =
  | { ok: true; output: TOut; awaitingObservation: boolean; integrationOperationId: string }
  | { ok: false; error: string; unknownOutcome?: boolean };

class CapabilityOutcomeUnknownError extends Error {
  readonly retryable = false;
  readonly kind = "unknown_outcome";
}

/**
 * Applies the contract's retryPolicy around a binding call — timeout per attempt, then
 * exponential backoff only when the contract permits replay after an ambiguous outcome.
 * Explicit non-retryable errors remain known failures; every other exhausted or forbidden
 * replay is surfaced as unknown so the caller reconciles instead of claiming failure.
 */
export async function withRetryAndTimeout<T>(fn: () => Promise<T>, policy: RetryPolicy, retryOnUnknown: boolean): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new CapabilityOutcomeUnknownError(`capability call timed out after ${policy.timeoutMs}ms; provider outcome is unknown`)), policy.timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } catch (err) {
      lastErr = err;
      const explicitlyUnknown = (err as { kind?: unknown }).kind === "unknown_outcome";
      const potentiallyDispatched = explicitlyUnknown || (err as { retryable?: boolean }).retryable !== false;
      if (!potentiallyDispatched) throw err;
      if (!retryOnUnknown || attempt === policy.attempts) {
        if (explicitlyUnknown) throw err;
        throw new CapabilityOutcomeUnknownError(
          `${err instanceof Error ? err.message : String(err)}; provider outcome is unknown`,
        );
      }
      await new Promise((r) => setTimeout(r, policy.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function executeCapability<TIn, TOut>(
  tenantId: string,
  workflowStepId: string,
  contract: CapabilityContract<TIn, TOut>,
  binding: CapabilityBinding<TIn, TOut>,
  input: TIn,
): Promise<CapabilityResult<TOut>> {
  const operationKey = contract.idempotencyKeyFrom(input);
  const requestHash = hashInput(input);
  const [step] = await withTenant(tenantId, (db) => db.select({ businessEffectId: workflowSteps.businessEffectId }).from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.id, workflowStepId))).limit(1));
  const externalProvider = new Set([
    "ghl", "quickbooks", "stripe", "vapi", "docusign", "gmail", "resend", "meta_ads", "google_ads",
  ]).has(binding.name);
  const integrationCapability = contract.capability === "book_provider_appointment" ? "scheduling"
    : binding.name === "stripe" ? "payments"
    : binding.name === "docusign" ? "esign"
      : contract.domain;
  const integrationCandidates = externalProvider
    ? await withTenant(tenantId, (db) => db.select({ id: tenantIntegrations.id, capability: tenantIntegrations.capability }).from(tenantIntegrations).where(and(
        eq(tenantIntegrations.tenantId, tenantId),
        eq(tenantIntegrations.binding, binding.name),
      )).limit(3))
    : [];
  const integration = integrationCandidates.find((candidate) => candidate.capability === integrationCapability)
    ?? (integrationCandidates.length === 1 ? integrationCandidates[0] : undefined);
  if (externalProvider && !integration) {
    return { ok: false, error: `No exact tenant integration/account is configured for ${binding.name}/${integrationCapability}` };
  }

  const claim = await withTenant(tenantId, async (db) => {
    const [row] = await db
      .insert(integrationOperations)
      .values({ tenantId, workflowStepId, businessEffectId: step?.businessEffectId ?? null, integrationId: integration?.id ?? null, operationKey, capability: contract.capability, provider: binding.name, requestHash, status: "running" })
      .onConflictDoNothing({ target: [integrationOperations.workflowStepId, integrationOperations.operationKey] })
      .returning();
    if (row) return { claimed: true as const, row };
    const [existing] = await db
      .select()
      .from(integrationOperations)
      .where(and(eq(integrationOperations.workflowStepId, workflowStepId), eq(integrationOperations.operationKey, operationKey)));
    return { claimed: false as const, existing };
  });

  if (!claim.claimed) {
    const existing = claim.existing!;
    if ((existing.businessEffectId ?? null) !== (step?.businessEffectId ?? null)) throw new Error("Integration operation effect conflict");
    if (existing.status === "succeeded") return {
      ok: true,
      output: existing.response as TOut,
      awaitingObservation: existing.verificationStatus === "awaiting_observation",
      integrationOperationId: existing.id,
    };
    if (existing.status === "running") {
      // A second worker cannot know whether the first worker has already crossed
      // the provider boundary. Convert the local in-flight marker to an explicit
      // unknown outcome and require reconciliation; never report a harmless
      // "already in flight" state that lets a later retry blindly replay it.
      const [unknown] = await withTenant(tenantId, async (db) => {
        const [updated] = await db
          .update(integrationOperations)
          .set({
            status: "unknown",
            response: { error: "Concurrent retry observed a running provider operation; external outcome is unknown" },
            verificationStatus: "unknown",
            updatedAt: new Date(),
          })
          .where(and(
            eq(integrationOperations.tenantId, tenantId),
            eq(integrationOperations.id, existing.id),
            eq(integrationOperations.status, "running"),
          ))
          .returning();
        if (updated) {
          const [openCase] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
            eq(reconciliationCases.tenantId, tenantId),
            eq(reconciliationCases.relatedStepId, workflowStepId),
            eq(reconciliationCases.status, "open"),
          )).limit(1);
          if (!openCase) await db.insert(reconciliationCases).values({
            tenantId,
            caseType: "unknown_delivery",
            relatedStepId: workflowStepId,
            businessEffectId: step?.businessEffectId ?? null,
            integrationId: integration?.id ?? null,
            classification: "provider_outcome_unknown",
            authoritativeSide: "external",
            details: { provider: binding.name, capability: contract.capability, operationKey },
          });
        }
        return [updated] as const;
      });
      if (unknown) return { ok: false, error: "provider outcome is unknown; reconcile before retrying", unknownOutcome: true };
      // The original worker settled between our read and the guarded update.
      const [latest] = await withTenant(tenantId, (db) => db.select().from(integrationOperations).where(and(
        eq(integrationOperations.tenantId, tenantId),
        eq(integrationOperations.id, existing.id),
      )).limit(1));
      if (latest?.status === "succeeded") return {
        ok: true,
        output: latest.response as TOut,
        awaitingObservation: latest.verificationStatus === "awaiting_observation",
        integrationOperationId: latest.id,
      };
      return { ok: false, error: "provider outcome is unknown; reconcile before retrying", unknownOutcome: true };
    }
    // Unknown means the provider may already have accepted the mutation. Only an
    // explicit reconciliation transition may turn it into succeeded/failed; never
    // convert uncertainty into a blind provider retry here.
    if (existing.status === "unknown") {
      return { ok: false, error: "provider outcome is unknown; reconcile before retrying", unknownOutcome: true };
    }
    // A known failed attempt delivered no effect and is safe to retry.
    const [reclaimed] = await withTenant(tenantId, (db) =>
      db
        .update(integrationOperations)
        .set({ status: "running", provider: binding.name, requestHash, response: null, updatedAt: new Date() })
        .where(and(
          eq(integrationOperations.tenantId, tenantId),
          eq(integrationOperations.id, existing.id),
          eq(integrationOperations.status, "failed"),
        ))
        .returning(),
    );
    if (!reclaimed) {
      // Another retry won the only legal failed -> running transition. Do not
      // proceed to the provider from this loser, even if our earlier read saw
      // `failed`.
      return { ok: false, error: "retry claim was lost; no provider call was made" };
    }
  }

  let output: TOut;
  try {
    output = await withRetryAndTimeout(() => binding.call(input), contract.retryPolicy, contract.retryOnUnknown);
  } catch (err) {
    const unknownOutcome = (err as { kind?: unknown }).kind === "unknown_outcome";
    await withTenant(tenantId, (db) =>
      db
        .update(integrationOperations)
        .set({
          status: unknownOutcome ? "unknown" : "failed",
          response: { error: (err as Error).message },
          verificationStatus: unknownOutcome ? "unknown" : "not_required",
          updatedAt: new Date(),
        })
        .where(and(eq(integrationOperations.workflowStepId, workflowStepId), eq(integrationOperations.operationKey, operationKey))),
    );
    if (unknownOutcome) {
      await withTenant(tenantId, async (db) => {
        const [existing] = await db.select({ id: reconciliationCases.id }).from(reconciliationCases).where(and(
          eq(reconciliationCases.tenantId, tenantId),
          eq(reconciliationCases.relatedStepId, workflowStepId),
          eq(reconciliationCases.status, "open"),
        )).limit(1);
        if (!existing) await db.insert(reconciliationCases).values({
          tenantId,
          caseType: "unknown_delivery",
          relatedStepId: workflowStepId,
          businessEffectId: step?.businessEffectId ?? null,
          integrationId: integration?.id ?? null,
          classification: "provider_outcome_unknown",
          authoritativeSide: "external",
          details: { provider: binding.name, capability: contract.capability, operationKey },
        });
      });
    }
    return { ok: false, error: (err as Error).message, ...(unknownOutcome ? { unknownOutcome: true } : {}) };
  }

  // The real effect above already happened. Simulate the process dying before this
  // result is ever written back, to prove the recovery path treats it as "unknown
  // delivery" rather than either a silent duplicate or a lost update.
  maybeChaosKill("post_commit_pre_ack");

  await withTenant(tenantId, (db) =>
    db
      .update(integrationOperations)
      .set({
        status: "succeeded",
        response: output as Record<string, unknown>,
        providerAcknowledgedAt: externalProvider ? new Date() : null,
        verificationStatus: externalProvider ? "awaiting_observation" : "verified",
        externalObservedAt: externalProvider ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(integrationOperations.workflowStepId, workflowStepId), eq(integrationOperations.operationKey, operationKey))),
  );
  const [recorded] = await withTenant(tenantId, (db) => db.select({ id: integrationOperations.id }).from(integrationOperations).where(and(
    eq(integrationOperations.tenantId, tenantId),
    eq(integrationOperations.workflowStepId, workflowStepId),
    eq(integrationOperations.operationKey, operationKey),
  )).limit(1));
  if (!recorded) throw new Error("integration operation acknowledgement was not recorded");
  if (externalProvider) {
    await enqueueJob(
      "observe_external_effect",
      { tenantId, workflowStepId, integrationOperationId: recorded.id, attempt: 1 },
      `observe-effect:${tenantId}:${recorded.id}:1`,
    );
  }
  return { ok: true, output, awaitingObservation: externalProvider, integrationOperationId: recorded.id };
}
