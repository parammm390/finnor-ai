import { revalidateActionExecution } from "@finnor/authority";
import { markBrowserConnectionReauthRequired } from "@finnor/security";
import {
  awaitExternalOperationResolution,
  claimExternalOperation,
  markExternalOperationUnknown,
  reconcileExternalOperation,
} from "@finnor/tools";
import type { ComputerAuthorizedEffect, ComputerRunStatus } from "@finnor/shared-types";
import type {
  ComputerDecisionEngine,
  ComputerOriginPolicy,
  ComputerPrimitiveResult,
  ComputerProvider,
  ComputerProviderSession,
  ComputerRunTerminal,
  StructuredPageObservation,
} from "./contracts";
import { ComputerProviderError } from "./contracts";
import { ComputerBroker } from "./broker";
import { authorizedEffectHash, computerEffectOperationKey, effectsExactlyEqual } from "./effects";
import { deriveComputerOriginPolicy } from "./origins";
import {
  beginComputerStep,
  computerCancellationRequested,
  countComputerArtifacts,
  finalizeComputerRun,
  finishComputerStep,
  getComputerRunInternal,
  markComputerSessionReleased,
  persistComputerArtifact,
  persistComputerSession,
  resolveComputerRunAuth,
  transitionComputerRun,
  type ComputerRunInternal,
} from "./repository";
import { redactComputerValue } from "./redaction";

const TERMINAL: readonly ComputerRunStatus[] = ["succeeded", "blocked", "failed", "timed_out", "cancelled"];

class ComputerRunLimitError extends Error {
  constructor(readonly code: "artifact_budget" | "screenshot_budget" | "download_budget", message: string) {
    super(message);
    this.name = "ComputerRunLimitError";
  }
}

export interface ComputerRunnerOptions {
  broker: ComputerBroker;
  decisionEngine: ComputerDecisionEngine;
  now?: () => number;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Conservative, deterministic post-state proof. The target and every authorized
 * scalar value must be literally observable after the effect. The micro-planner's
 * assertion alone is never accepted as proof. */
export function observationVerifiesEffect(observation: StructuredPageObservation, effect: ComputerAuthorizedEffect): boolean {
  const haystack = normalizedText(`${observation.title}\n${observation.text}`);
  if (!haystack.includes(normalizedText(effect.target.identifier))) return false;
  return Object.values(effect.changes).every((value) => value === null || haystack.includes(normalizedText(value)));
}

function reportedScalarValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [normalizedText(value)];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((item) => reportedScalarValues(item, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).slice(0, 100).flatMap((item) => reportedScalarValues(item, depth + 1));
  return [];
}

function observationSupportsReportedResult(observation: StructuredPageObservation, result: Record<string, unknown>): boolean {
  const haystack = normalizedText(`${observation.title}\n${observation.text}`);
  const values = reportedScalarValues(result).filter(Boolean);
  return values.length > 0 && values.every((value) => haystack.includes(value));
}

function observationSupportsReadResult(observation: StructuredPageObservation, targetIdentifier: string, evidenceText: string, result: Record<string, unknown>): boolean {
  const haystack = normalizedText(`${observation.title}\n${observation.text}`);
  const evidence = normalizedText(evidenceText);
  return Boolean(evidence)
    && haystack.includes(normalizedText(targetIdentifier))
    && haystack.includes(evidence)
    && observationSupportsReportedResult(observation, result);
}

function resultSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function terminalStep(
  run: ComputerRunInternal,
  status: ComputerRunTerminal["status"],
  operation: string,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const step = await beginComputerStep({ tenantId: run.tenantId, runId: run.id, phase: status, operation, summary, detail });
  await finishComputerStep(run.tenantId, step.id, status === "succeeded" ? "succeeded" : status === "blocked" || status === "cancelled" ? "blocked" : "failed", detail);
}

async function storePrimitiveArtifacts(run: ComputerRunInternal, stepId: string, output: ComputerPrimitiveResult): Promise<void> {
  const counts = await countComputerArtifacts(run.tenantId, run.id);
  const runLimits = run.limits as unknown as { maxArtifacts: number; maxScreenshots: number; maxDownloadBytes: number };
  if (output.screenshot) {
    if (counts.total >= runLimits.maxArtifacts) throw new ComputerRunLimitError("artifact_budget", "Computer artifact budget reached");
    if (counts.screenshots >= runLimits.maxScreenshots) throw new ComputerRunLimitError("screenshot_budget", "Computer screenshot budget reached");
    await persistComputerArtifact({ tenantId: run.tenantId, runId: run.id, stepId, kind: "screenshot", mimeType: "image/png", bytes: output.screenshot, metadata: { source: "provider_step" } });
    counts.total += 1;
    counts.screenshots += 1;
  }
  if (output.download) {
    if (output.download.bytes.byteLength > runLimits.maxDownloadBytes) throw new ComputerRunLimitError("download_budget", "Computer download exceeds the governed byte limit");
    if (counts.total >= runLimits.maxArtifacts) throw new ComputerRunLimitError("artifact_budget", "Computer artifact budget reached");
    await persistComputerArtifact({ tenantId: run.tenantId, runId: run.id, stepId, kind: "download", mimeType: output.download.mimeType, bytes: output.download.bytes, metadata: { filename: output.download.filename } });
  }
}

async function verifyCurrentAuthority(run: ComputerRunInternal): Promise<string> {
  // Computer runs are durable children of the DomainAction, not rows in the existing
  // business_operations table. Revalidate the action execution boundary directly;
  // do not forge a business-operation id into authority_decisions.operation_id.
  const decision = await revalidateActionExecution(run.tenantId, run.domainActionId, "execution");
  if (decision.outcome !== "allowed") throw new Error(`Current authority does not permit computer execution: ${decision.reasonCode}`);
  return decision.id;
}

async function verifyCurrentProfile(run: ComputerRunInternal) {
  const access = await resolveComputerRunAuth(run);
  if (access.profileId !== run.authProfileId || access.applicationAccountId !== run.applicationAccountId || access.authProfileRef !== run.authProfileRef) {
    throw new Error("The governed application/auth profile binding changed while the run was pending");
  }
  const currentOrigins = deriveComputerOriginPolicy(access.accountMetadata, access.restrictions);
  const persistedAllowed = Array.isArray(run.allowedOrigins) ? run.allowedOrigins.filter((value): value is string => typeof value === "string") : [];
  const persistedAuth = Array.isArray(run.authOrigins) ? run.authOrigins.filter((value): value is string => typeof value === "string") : [];
  if (!sameStrings(currentOrigins.allowedOrigins, persistedAllowed) || !sameStrings(currentOrigins.authOrigins, persistedAuth)) {
    throw new Error("The governed application origin policy changed while the run was pending");
  }
  return { access, origins: currentOrigins };
}

export class ComputerRunner {
  private readonly now: () => number;

  constructor(private readonly options: ComputerRunnerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Always resolves to a terminal outcome. A process kill is the only exception;
   * the persistent job lease then retries and the persisted session/effect state is
   * reconciled before any further consequential action. */
  async run(tenantId: string, runId: string): Promise<ComputerRunTerminal> {
    let run = await getComputerRunInternal(tenantId, runId);
    if (!run) return { status: "failed", code: "run_not_found", reason: "Computer run was not found" };
    if (TERMINAL.includes(run.status as ComputerRunStatus)) {
      return run.status === "succeeded"
        ? { status: "succeeded", result: (run.result ?? {}) as Record<string, unknown> }
        : { status: run.status as Exclude<ComputerRunTerminal["status"], "succeeded">, code: run.failureCode ?? "terminal", reason: run.blockReason ?? "Computer run already ended" };
    }
    if (await computerCancellationRequested(tenantId, runId)) {
      const cancelled: ComputerRunTerminal = { status: "cancelled", code: "cancelled", reason: "Computer run was cancelled before provider provisioning" };
      await terminalStep(run, "cancelled", "cancel", "Stopped at the durable cancellation boundary", {});
      await finalizeComputerRun(tenantId, runId, cancelled);
      return cancelled;
    }

    const limits = run.limits as unknown as { maxSteps: number; timeoutMs: number; maxProviderCredits: number; maxArtifacts: number; maxOutputBytes: number };
    const startedAt = run.startedAt?.getTime() ?? this.now();
    let provider: ComputerProvider | null = null;
    let session: ComputerProviderSession | null = run.providerSessionRef ? {
      sessionRef: run.providerSessionRef,
      executionMode: run.mode as "READ_ONLY" | "WRITE",
      downloadLimitBytes: (run.limits as unknown as { maxDownloadBytes: number }).maxDownloadBytes,
    } : null;
    let terminal: ComputerRunTerminal | null = null;

    try {
      run = await transitionComputerRun(tenantId, runId, "authorizing");
      const authorizeStep = await beginComputerStep({ tenantId, runId, phase: "authorizing", operation: "authorize", summary: "Revalidating employee authority and governed application profile" });
      let authorityDecisionId: string;
      let profile: Awaited<ReturnType<typeof verifyCurrentProfile>>;
      try {
        authorityDecisionId = await verifyCurrentAuthority(run);
        profile = await verifyCurrentProfile(run);
        await finishComputerStep(tenantId, authorizeStep.id, "succeeded", { authorityDecisionId, application: run.application, authProfileRef: run.authProfileRef });
      } catch (error) {
        await finishComputerStep(tenantId, authorizeStep.id, "blocked", { code: "authorization_changed" }).catch(() => undefined);
        throw error;
      }
      const { access, origins } = profile;

      provider = this.options.broker.negotiate(run.provider, ["cloud_session", "cdp", "structured_page", "screenshot", "persistent_profile"]);
      const recoveredSession = Boolean(session);
      if (!session) {
        run = await transitionComputerRun(tenantId, runId, "provisioning");
        const provisionStep = await beginComputerStep({ tenantId, runId, phase: "provisioning", operation: "create_session", summary: "Creating an isolated Steel browser" });
        try {
          session = await provider.createSession({ tenantId, runId, auth: access.steelSessionAuth, mode: run.mode as "READ_ONLY" | "WRITE", origins, limits: run.limits as never });
          await persistComputerSession(tenantId, runId, session);
          await finishComputerStep(tenantId, provisionStep.id, "succeeded", { provider: provider.name, isolated: true, liveViewAvailable: Boolean(session.liveViewUrl) });
        } catch (error) {
          await finishComputerStep(tenantId, provisionStep.id, "failed", { code: error instanceof ComputerProviderError ? error.code : "provisioning_failed" }).catch(() => undefined);
          throw error;
        }
      } else {
        const recoverStep = await beginComputerStep({ tenantId, runId, phase: "reconciling", operation: "recover_session", summary: "Recovering the isolated provider session after worker interruption" });
        await finishComputerStep(tenantId, recoverStep.id, "succeeded", { provider: provider.name });
      }

      let initialObservation: StructuredPageObservation;
      if (recoveredSession && run.mode === "WRITE" && (run.effectStatus === "dispatching" || run.effectStatus === "unknown")) {
        // Preserve the page that may contain post-submit state. Navigating home first
        // could destroy the only deterministic evidence needed to reconcile safely.
        run = await transitionComputerRun(tenantId, runId, "reconciling", { effectStatus: "unknown" });
        const inspectStep = await beginComputerStep({ tenantId, runId, phase: "reconciling", operation: "inspect_recovered_state", summary: "Inspecting recovered external state before any navigation or retry" });
        try {
          initialObservation = await provider.observe(session, origins);
          await finishComputerStep(tenantId, inspectStep.id, "succeeded", { pageTitle: initialObservation.title }, initialObservation.url);
        } catch (error) {
          await finishComputerStep(tenantId, inspectStep.id, "failed", { code: error instanceof ComputerProviderError ? error.code : "recovery_observation_failed" }).catch(() => undefined);
          throw error;
        }
      } else {
        run = await transitionComputerRun(tenantId, runId, "authenticating");
        const authStep = await beginComputerStep({ tenantId, runId, phase: "authenticating", operation: "open_application", summary: "Opening the governed application and restoring authenticated state" });
        try {
          const opened = await provider.perform(session, { kind: "navigate", url: origins.homeUrl }, origins);
          initialObservation = await provider.observe(session, origins);
          await finishComputerStep(tenantId, authStep.id, "succeeded", { pageTitle: initialObservation.title }, opened.pageUrl);
        } catch (error) {
          await finishComputerStep(tenantId, authStep.id, "failed", { code: error instanceof ComputerProviderError ? error.code : "application_open_failed" }).catch(() => undefined);
          throw error;
        }
      }
      run = await transitionComputerRun(tenantId, runId, "running");

      let observation = initialObservation;
      for (let stepNumber = 1; stepNumber <= limits.maxSteps; stepNumber += 1) {
        if (await computerCancellationRequested(tenantId, runId)) {
          terminal = { status: "cancelled", code: "cancelled", reason: "Computer run was cancelled" };
          await terminalStep(run, "cancelled", "cancel", "Stopped at the durable cancellation boundary", {});
          break;
        }
        if (this.now() - startedAt >= limits.timeoutMs) {
          terminal = { status: "timed_out", code: "wall_clock_timeout", reason: "Computer run reached its wall-clock timeout" };
          await terminalStep(run, "timed_out", "timeout", "Stopped at the governed wall-clock limit", { timeoutMs: limits.timeoutMs });
          break;
        }
        const cost = await provider.cost(session);
        if (cost.creditsUsed >= limits.maxProviderCredits) {
          terminal = { status: "timed_out", code: "provider_budget", reason: "Computer run reached its provider credit budget" };
          await terminalStep(run, "timed_out", "budget", "Stopped at the governed provider-cost limit", { creditsUsed: cost.creditsUsed, maxProviderCredits: limits.maxProviderCredits });
          break;
        }

        run = (await getComputerRunInternal(tenantId, runId)) ?? run;
        const authorizedEffect = run.authorizedEffect as ComputerAuthorizedEffect | null;
        if (run.mode === "WRITE" && authorizedEffect && (run.effectStatus === "dispatching" || run.effectStatus === "unknown")) {
          run = await transitionComputerRun(tenantId, runId, "reconciling", { effectStatus: "unknown" });
          const reconcileStep = await beginComputerStep({ tenantId, runId, phase: "reconciling", operation: "reconcile_effect", summary: "Checking external state before any write retry", effectCandidateHash: authorizedEffectHash(authorizedEffect) });
          observation = await provider.observe(session, origins);
          if (observationVerifiesEffect(observation, authorizedEffect)) {
            const operationKey = run.effectOperationKey ?? computerEffectOperationKey(authorizedEffect);
            await reconcileExternalOperation(tenantId, run.domainActionId, operationKey, "succeeded", { verified: true, pageUrl: observation.url });
            run = await transitionComputerRun(tenantId, runId, "running", { effectStatus: "succeeded", effectOperationKey: operationKey });
            await finishComputerStep(tenantId, reconcileStep.id, "succeeded", { verified: true }, observation.url);
          } else {
            await finishComputerStep(tenantId, reconcileStep.id, "blocked", { verified: false }, observation.url);
            terminal = { status: "blocked", code: "effect_outcome_unknown", reason: "The possible external write could not be reconciled safely; manual review is required before retry" };
            break;
          }
        }

        const decision = await this.options.decisionEngine.decide({
          task: run.taskInput,
          observation,
          stepNumber,
          effectStatus: run.effectStatus as "none" | "pending" | "dispatching" | "succeeded" | "failed" | "unknown",
        });

        if (decision.kind === "block") {
          if (/auth|login|sign.?in|session.?expired|mfa|captcha/i.test(`${decision.code} ${decision.reason}`)) {
            await markBrowserConnectionReauthRequired({
              tenantId,
              authProfileId: run.authProfileId,
              actorId: run.actorId,
              reasonCode: decision.code,
            });
          }
          terminal = { status: "blocked", code: decision.code.slice(0, 120), reason: decision.reason.slice(0, 2000) };
          await terminalStep(run, "blocked", "manual_fallback", decision.summary, { code: decision.code });
          break;
        }

        if (decision.kind === "complete") {
          const verified = run.mode === "WRITE"
            ? run.effectStatus === "succeeded" && Boolean(run.authorizedEffect) && observationVerifiesEffect(observation, run.authorizedEffect as ComputerAuthorizedEffect) && observationSupportsReportedResult(observation, decision.result)
            : observationSupportsReadResult(observation, run.target && typeof run.target === "object" ? String((run.target as { identifier?: unknown }).identifier ?? "") : "", decision.evidenceText, decision.result);
          if (!verified) {
            terminal = { status: "blocked", code: "result_not_observed", reason: "The claimed business result was not present in the observed application state" };
            await terminalStep(run, "blocked", "verify_result", "Could not verify the claimed business result", { observed: false });
            break;
          }
          const safeResult = redactComputerValue(decision.result) as Record<string, unknown>;
          if (resultSize(safeResult) > limits.maxOutputBytes) {
            terminal = { status: "timed_out", code: "output_budget", reason: "Computer result exceeded its governed output limit" };
            await terminalStep(run, "timed_out", "output_limit", "Stopped at the governed output limit", { maxOutputBytes: limits.maxOutputBytes });
            break;
          }
          const counts = await countComputerArtifacts(tenantId, runId);
          if (counts.total >= limits.maxArtifacts) {
            terminal = { status: "timed_out", code: "artifact_budget", reason: "No artifact budget remained for required result evidence" };
            await terminalStep(run, "timed_out", "artifact_limit", "Stopped at the governed artifact limit", { maxArtifacts: limits.maxArtifacts });
            break;
          }
          const evidenceStep = await beginComputerStep({ tenantId, runId, phase: "succeeded", operation: "capture_evidence", summary: decision.summary, pageUrl: observation.url });
          const evidence = Buffer.from(JSON.stringify(redactComputerValue({ pageUrl: observation.url, title: observation.title, evidenceText: decision.evidenceText, result: safeResult })), "utf8");
          await persistComputerArtifact({ tenantId, runId, stepId: evidenceStep.id, kind: "result_evidence", mimeType: "application/json", bytes: evidence, metadata: { verified: true, mode: run.mode } });
          await finishComputerStep(tenantId, evidenceStep.id, "succeeded", { verified: true }, observation.url);
          terminal = { status: "succeeded", result: { ...safeResult, verified: true, evidenceCaptured: true } };
          break;
        }

        const isEffect = decision.kind === "effect";
        const operation = decision.primitive.kind;
        if ((operation === "visual_click" || operation === "visual_type") && observation.elements.some((element) => !element.disabled && Boolean(element.name || element.text))) {
          terminal = { status: "blocked", code: "structured_interaction_available", reason: "Visual fallback was refused because structured page controls are available" };
          await terminalStep(run, "blocked", "intercept_visual_fallback", "Kept execution on the structured interaction path", { primitive: operation });
          break;
        }
        if (isEffect && run.mode === "READ_ONLY") {
          terminal = { status: "blocked", code: "read_only_mutation", reason: "A READ_ONLY computer task reached a consequential mutation boundary" };
          await terminalStep(run, "blocked", "intercept_effect", "Blocked a mutation in READ_ONLY mode", { primitive: operation });
          break;
        }
        if (isEffect) {
          const authorized = run.authorizedEffect as ComputerAuthorizedEffect | null;
          if (!authorized || !effectsExactlyEqual(decision.effect, authorized)) {
            terminal = { status: "blocked", code: "effect_broader_than_authorized", reason: "The candidate external effect differs from the exact approved effect" };
            await terminalStep(run, "blocked", "intercept_effect", "Blocked an effect outside the approved contract", { candidateHash: authorizedEffectHash(decision.effect) });
            break;
          }
          const authorityDecisionId = await verifyCurrentAuthority(run);
          await verifyCurrentProfile(run);
          const operationKey = computerEffectOperationKey(authorized);
          const effectHash = authorizedEffectHash(authorized);
          const claim = await claimExternalOperation(tenantId, run.domainActionId, operationKey, effectHash);
          if (!claim.claimed) {
            const settled = await awaitExternalOperationResolution(tenantId, run.domainActionId, operationKey, claim.existing);
            if (settled.status === "succeeded") {
              run = await transitionComputerRun(tenantId, runId, "running", { effectStatus: "succeeded", effectOperationKey: operationKey });
              observation = await provider.observe(session, origins);
              continue;
            }
            run = await transitionComputerRun(tenantId, runId, "reconciling", { effectStatus: "unknown", effectOperationKey: operationKey });
            observation = await provider.observe(session, origins);
            continue;
          }
          run = await transitionComputerRun(tenantId, runId, "running", { effectStatus: "dispatching", effectOperationKey: operationKey });
          const effectStep = await beginComputerStep({ tenantId, runId, phase: "running", operation, summary: decision.summary, pageUrl: observation.url, effectCandidateHash: effectHash, authorityDecisionId });
          try {
            const output = await provider.perform(session, decision.primitive, origins);
            await storePrimitiveArtifacts(run, effectStep.id, output);
            // Dispatch success is not business success. Mark unknown until post-state
            // observation proves the exact authorized change.
            await markExternalOperationUnknown(tenantId, run.domainActionId, operationKey, { dispatched: true, pageUrl: output.pageUrl ?? observation.url });
            run = await transitionComputerRun(tenantId, runId, "reconciling", { effectStatus: "unknown", effectOperationKey: operationKey });
            await finishComputerStep(tenantId, effectStep.id, "succeeded", { dispatched: true, awaitingPostStateVerification: true }, output.pageUrl);
            observation = await provider.observe(session, origins);
          } catch (error) {
            await markExternalOperationUnknown(tenantId, run.domainActionId, operationKey, { dispatchStarted: true });
            run = await transitionComputerRun(tenantId, runId, "reconciling", { effectStatus: "unknown", effectOperationKey: operationKey });
            await finishComputerStep(tenantId, effectStep.id, "failed", { outcomeUnknown: true });
            observation = await provider.observe(session, origins).catch(() => observation);
          }
          continue;
        }

        const step = await beginComputerStep({ tenantId, runId, phase: "running", operation, summary: decision.summary, pageUrl: observation.url });
        try {
          const output = await provider.perform(session, decision.primitive, origins);
          await storePrimitiveArtifacts(run, step.id, output);
          try {
            observation = await provider.observe(session, origins);
          } catch (observeError) {
            if (!/execution context was destroyed|navigation/i.test(observeError instanceof Error ? observeError.message : "")) throw observeError;
            await provider.perform(session, { kind: "wait", milliseconds: 500 }, origins);
            observation = await provider.observe(session, origins);
          }
          await finishComputerStep(tenantId, step.id, "succeeded", { result: output.summary }, output.pageUrl ?? observation.url);
        } catch (error) {
          await finishComputerStep(tenantId, step.id, "failed", { error: error instanceof ComputerProviderError ? error.code : "operation_failed" });
          throw error;
        }
      }

      if (!terminal) {
        terminal = { status: "timed_out", code: "step_limit", reason: `Computer run reached its ${limits.maxSteps}-step limit` };
        await terminalStep(run, "timed_out", "step_limit", "Stopped at the governed step limit", { maxSteps: limits.maxSteps });
      }
    } catch (error) {
      const providerError = error instanceof ComputerProviderError ? error : null;
      const limitError = error instanceof ComputerRunLimitError || providerError?.code === "limit_exceeded";
      const originBlocked = (error as { code?: string })?.code === "origin_blocked" || providerError?.code === "origin_blocked";
      const readOnlyMutation = providerError?.code === "read_only_mutation";
      const configurationBlocked = providerError?.code === "provider_unavailable" || providerError?.code === "capability_unavailable";
      const authorityBlocked = /authority|auth profile|application\/auth profile|origin policy/i.test(error instanceof Error ? error.message : "");
      terminal = {
        status: limitError ? "timed_out" : originBlocked || readOnlyMutation || authorityBlocked || configurationBlocked ? "blocked" : "failed",
        code: limitError ? (error instanceof ComputerRunLimitError ? error.code : "provider_limit") : originBlocked ? "origin_blocked" : readOnlyMutation ? "read_only_mutation" : authorityBlocked ? "authorization_changed" : configurationBlocked ? "blocked_config" : providerError?.code ?? "computer_failure",
        reason: error instanceof Error ? error.message.slice(0, 2000) : "Computer execution failed",
      };
      await terminalStep(run, terminal.status, "terminal_failure", terminal.reason, { code: terminal.code }).catch(() => undefined);
    } finally {
      if (session && provider) {
        const cleanup = await beginComputerStep({ tenantId, runId, phase: terminal?.status ?? "failed", operation: "release_session", summary: "Releasing the ephemeral provider session" }).catch(() => null);
        try {
          await provider.release(session);
          await markComputerSessionReleased(tenantId, runId);
          if (cleanup) await finishComputerStep(tenantId, cleanup.id, "succeeded", { released: true });
        } catch {
          if (cleanup) await finishComputerStep(tenantId, cleanup.id, "failed", { released: false, orphanCleanupRequired: true }).catch(() => undefined);
        }
      }
    }

    terminal ??= { status: "failed", code: "computer_failure", reason: "Computer execution ended without a terminal result" };
    await finalizeComputerRun(tenantId, runId, terminal);
    return terminal;
  }
}
