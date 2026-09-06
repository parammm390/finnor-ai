// Graph nodes — each one mirrors a step of GatedExecutor.execute() exactly, including
// grounding and durable-operation preparation before the authority boundary.

import { interrupt } from "@langchain/langgraph";
import { withTenant, domainActions, enqueueJob } from "@finnor/db";
import { appendEpisode } from "@finnor/memory";
import { eq, and } from "drizzle-orm";
import type { DomainAction } from "@finnor/shared-types";
import { ScopedToolRegistry, tenantProviderConfigured, type ToolRegistry } from "@finnor/tools";
import type { PluginRegistry } from "../plugin-registry";
import { diagnoseFailure, buildConfirmationScript } from "../voice";
import { advanceWorkflowForActionRequired } from "../workflow";
import { executePluginViaRuntime } from "../runtime-bridge";
import type { GateState } from "./state";
import { evaluateActionAuthorityBoundary } from "../authority-runtime";
import { revalidateActionExecution } from "@finnor/authority";
import { approvalRequirementForAction } from "../../../../scripts/release/action-hardening-spec";
import {
  BusinessEffectBoundaryError,
  ensureBusinessEffect,
  recordBusinessEffectOutcome,
} from "../compiler";
import { ActionGroundingError } from "@finnor/plugins-shared";

async function setStatus(tenantId: string, actionId: string, status: DomainAction["status"]): Promise<void> {
  await withTenant(tenantId, async (db) => {
    await db
      .update(domainActions)
      .set({
        status,
        ...(status === "executing" ? { executionStartedAt: new Date() } : {}),
        ...(status === "completed" || status === "failed" || status === "blocked_integration_unavailable" || status === "needs_human_review" ? { executionStartedAt: null } : {}),
      })
      .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)));
  });
}

export function makeValidateNode(plugins: PluginRegistry) {
  return async (state: GateState): Promise<Partial<GateState>> => {
    const plugin = plugins.resolve(state.actionType);
    const validation = plugin
      ? plugin.validate(state.actionType, state.payload, state.policy)
      : { valid: false, errors: [`No plugin handles ${state.actionType}`] };
    await appendEpisode(state.tenantId, state.actionId, "validate", { payload: state.payload }, { ...validation });
    return { validation };
  };
}

export function routeAfterValidate(state: GateState): "draft" | "failed" {
  return state.validation?.valid ? "draft" : "failed";
}

export function makeDraftNode(plugins: PluginRegistry) {
  return async (state: GateState): Promise<Partial<GateState>> => {
    const plugin = plugins.resolve(state.actionType)!;
    let draft = await plugin.draft(state.actionType, state.payload, state.policy);
    draft.correlationId = state.correlationId;
    draft.domainActionId = state.actionId;
    draft.approvedBy = state.approvedBy;
    if (plugin.ground) {
      const action: DomainAction = {
        id: state.actionId,
        tenantId: state.tenantId,
        actionType: state.actionType,
        payload: state.payload,
        policyId: state.policy.id,
        policyVersion: state.policy.version,
        status: state.alreadyApproved ? "approved" : "draft",
        correlationId: state.correlationId,
        workId: state.workId ?? null,
        createdAt: new Date().toISOString(),
        initiatedBy: state.initiatedBy ?? null,
        approvedBy: state.approvedBy,
      };
      try {
        const grounded = await plugin.ground(draft, action, state.policy);
        draft = grounded.draft;
        draft.correlationId = state.correlationId;
        draft.domainActionId = state.actionId;
        draft.approvedBy = state.approvedBy;
        await withTenant(state.tenantId, (db) => db.update(domainActions).set({
          payload: draft.payload,
          groundedPayload: grounded.groundedPayload,
        }).where(and(eq(domainActions.id, state.actionId), eq(domainActions.tenantId, state.tenantId))));
        await appendEpisode(state.tenantId, state.actionId, "ground", {}, { groundedPayload: grounded.groundedPayload });
      } catch (error) {
        if (!(error instanceof ActionGroundingError)) throw error;
        const groundingError = { code: error.code, message: error.message, details: error.details };
        await setStatus(state.tenantId, state.actionId, "needs_human_review");
        await appendEpisode(state.tenantId, state.actionId, "ground_blocked", {}, groundingError);
        return { groundingError };
      }
    }
    if (plugin.prepareDurableOperation) {
      const action: DomainAction = {
        id: state.actionId,
        tenantId: state.tenantId,
        actionType: state.actionType,
        payload: draft.payload,
        policyId: state.policy.id,
        policyVersion: state.policy.version,
        status: state.alreadyApproved ? "approved" : "draft",
        correlationId: state.correlationId,
        workId: state.workId ?? null,
        createdAt: new Date().toISOString(),
        initiatedBy: state.initiatedBy ?? null,
        approvedBy: state.approvedBy,
      };
      draft = await plugin.prepareDurableOperation(draft, action, state.policy);
      draft.correlationId = state.correlationId;
      draft.domainActionId = state.actionId;
      draft.approvedBy = state.approvedBy;
    }
    await appendEpisode(state.tenantId, state.actionId, "draft", {}, { summary: draft.summary });
    return { draft, payload: draft.payload, groundingError: undefined };
  };
}

export function routeAfterDraft(state: GateState): "gate" | "failed" {
  return state.groundingError ? "failed" : "gate";
}

export function makeGateNode() {
  return async (state: GateState): Promise<Partial<GateState>> => {
    const action: DomainAction = {
      id: state.actionId,
      tenantId: state.tenantId,
      actionType: state.actionType,
      payload: state.payload,
      policyId: state.policy.id,
      policyVersion: state.policy.version,
      status: state.alreadyApproved ? "approved" : "draft",
      workId: state.workId ?? null,
      createdAt: new Date().toISOString(),
      initiatedBy: state.initiatedBy ?? null,
      approvedBy: state.approvedBy,
    };
    const approval = approvalRequirementForAction(state.actionType, state.policy.requiresConfirmation, state.draft!.requiresConfirmation);
    try {
      const effect = await ensureBusinessEffect({ action, draft: state.draft!, policy: state.policy, approval });
      if (effect) await appendEpisode(state.tenantId, state.actionId, "effect_compiled", {}, { businessEffectId: effect.id, semanticHash: effect.semanticHash, scopeHash: effect.scopeHash });
    } catch (error) {
      if (!(error instanceof BusinessEffectBoundaryError)) throw error;
      await setStatus(state.tenantId, state.actionId, "needs_human_review");
      await appendEpisode(state.tenantId, state.actionId, "effect_blocked", {}, { code: error.code, message: error.message });
      return { authorityOutcome: "denied", authorityReasonCode: error.code, requiresGate: false };
    }
    const authority = await evaluateActionAuthorityBoundary(action, state.policy, state.draft!);
    if (authority.decision.outcome === "denied") return {
      authorityOutcome: "denied",
      authorityDecisionId: authority.decision.id,
      authorityReasonCode: authority.decision.reasonCode,
    };
    const needsGate = Boolean((approval.requiresConfirmation || authority.decision.outcome === "approval_required") && !state.alreadyApproved);
    if (!needsGate) {
      return { authorityOutcome: authority.decision.outcome, authorityDecisionId: authority.decision.id, authorityReasonCode: authority.decision.reasonCode, requiresGate: false };
    }
    const summary = state.draft!.businessEffect?.approval.summary ?? state.draft!.summary;
    await withTenant(state.tenantId, async (db) => {
      await db
        .update(domainActions)
        .set({ status: "pending", summary, payload: state.draft!.payload })
        .where(and(eq(domainActions.id, state.actionId), eq(domainActions.tenantId, state.tenantId)));
    });
    await appendEpisode(state.tenantId, state.actionId, "gate", {}, { gated: true, summary, businessEffectId: state.draft!.businessEffect?.id ?? null, semanticHash: state.draft!.businessEffect?.semanticHash ?? null });
    await enqueueJob(
      "send_push_notification",
      { tenantId: state.tenantId, kind: "approval-needed", actionId: state.actionId, body: summary },
      `push:approval-needed:${state.actionId}`,
      state.correlationId,
    ).catch(() => undefined);
    if (await tenantProviderConfigured(state.tenantId, "vapi")) {
      await enqueueJob(
        "voice_confirm_request",
        { tenantId: state.tenantId, actionId: state.actionId, script: buildConfirmationScript(summary) },
        `voice-confirm:${state.actionId}`,
        state.correlationId,
      ).catch(() => undefined);
    }
    return { authorityOutcome: authority.decision.outcome, authorityDecisionId: authority.decision.id, authorityReasonCode: authority.decision.reasonCode, requiresGate: true };
  };
}

// Re-derives the same boolean gate() computed — never trusts a stored flag, exactly
// matching GatedExecutor's own re-check pattern.
export function routeAfterGate(state: GateState): "pause" | "execute" | "failed" {
  if (state.authorityOutcome === "denied") return "failed";
  return state.requiresGate ? "pause" : "execute";
}

// The ONLY node that calls interrupt(). No side effects before or after it — LangGraph
// re-runs an interrupted node's entire body from the top on resume, so anything with a
// side effect here would double-fire.
export function pauseNode(_state: GateState): Partial<GateState> {
  const decision = interrupt({ awaitingApproval: true }) as "approve" | "reject";
  return { decision };
}

export function routeAfterPause(state: GateState): "execute" | "rejected" {
  return state.decision === "approve" ? "execute" : "rejected";
}

export function makeExecuteNode(plugins: PluginRegistry, tools: ToolRegistry) {
  return async (state: GateState): Promise<Partial<GateState>> => {
    // Consequential effects are revalidated by their persistent worker immediately
    // before the commit point. Reads remain synchronous and revalidate here.
    if (!state.draft!.businessEffect) {
      const freshAuthority = await revalidateActionExecution(state.tenantId, state.actionId);
      if (freshAuthority.outcome !== "allowed") {
        await setStatus(state.tenantId, state.actionId, "failed");
        return { result: { status: "failure", output: { authorityDecisionId: freshAuthority.id }, error: `Authority denied before execution: ${freshAuthority.reasonCode}` } };
      }
      await setStatus(state.tenantId, state.actionId, "executing");
    }
    const plugin = plugins.resolve(state.actionType)!;
    // Same idempotency scoping as the legacy GatedExecutor — see its comment.
    const identityRef = state.draft!.payload.communicationIdentityRef && typeof state.draft!.payload.communicationIdentityRef === "object"
      ? state.draft!.payload.communicationIdentityRef as Record<string, unknown>
      : null;
    const requestedCommunicationIdentityId = typeof state.draft!.payload.communicationIdentityId === "string"
      ? state.draft!.payload.communicationIdentityId
      : typeof identityRef?.communicationIdentityId === "string" ? identityRef.communicationIdentityId
        : state.draft!.businessEffect?.bindings.find((binding) => binding.communicationIdentityId)?.communicationIdentityId;
    const requestedAuthProfileRef = typeof state.draft!.payload.authProfileRef === "string" ? state.draft!.payload.authProfileRef : state.draft!.businessEffect?.bindings.find((binding) => binding.authProfileRef)?.authProfileRef;
    const accessPurpose = typeof state.draft!.payload.purpose === "string" && state.draft!.payload.purpose.trim()
      ? state.draft!.payload.purpose
      : state.actionType;
    const scopedTools = new ScopedToolRegistry(tools, {
      tenantId: state.tenantId,
      domainActionId: state.actionId,
      actorId: state.initiatedBy ?? "system:orchestration",
      purpose: accessPurpose,
      ...(requestedCommunicationIdentityId ? { communicationIdentityId: requestedCommunicationIdentityId } : {}),
      ...(requestedAuthProfileRef ? { authProfileRef: requestedAuthProfileRef } : {}),
      ...(state.draft!.businessEffect ? { businessEffectId: state.draft!.businessEffect.id, businessEffectHash: state.draft!.businessEffect.semanticHash } : {}),
    });
    // §2.5: same runtime bridge as the legacy GatedExecutor — see its comment.
    const result = await executePluginViaRuntime({
      tenantId: state.tenantId,
      actionId: state.actionId,
      actionType: state.actionType,
      correlationId: state.correlationId,
      draft: state.draft!,
      plugin,
      tools: scopedTools,
    });
    if (result.output.durableWorkerExecution === true) return { result };
    const effectVerification = state.draft!.businessEffect ? await recordBusinessEffectOutcome(state.tenantId, state.draft!.businessEffect, result) : null;
    await appendEpisode(state.tenantId, state.actionId, "execute", { draft: state.draft!.payload }, { ...result });

    const finalStatus =
      effectVerification?.state === "divergent" || effectVerification?.state === "reconciliation_required" || result.errorKind === "unknown_outcome"
        ? "needs_human_review"
        : effectVerification?.state === "partially_verified" ? "executing"
        : result.status === "success" ? "completed" : result.status === "integration_unavailable" ? "blocked_integration_unavailable" : "failed";
    await setStatus(state.tenantId, state.actionId, finalStatus);

    if (finalStatus === "completed") {
      const workflow = await advanceWorkflowForActionRequired({ tenantId: state.tenantId, actionId: state.actionId, actionType: state.actionType, payload: state.draft!.payload });
      if (!workflow.ok) {
        return {
          result: {
            status: "failure",
            output: { ...result.output, effectSucceeded: true, workflowAdvancementRecorded: false },
            error: "The action succeeded, but its required workflow state could not be advanced. Do not repeat the effect; reconcile the workflow state.",
            errorKind: "needs_human",
          },
        };
      }
      if (workflow.advanced.length > 0) {
        await appendEpisode(state.tenantId, state.actionId, "workflow", {}, { advanced: workflow.advanced });
      }
    }
    if (finalStatus === "blocked_integration_unavailable" && await tenantProviderConfigured(state.tenantId, "vapi")) {
      await enqueueJob(
        "voice_notify_failure",
        { tenantId: state.tenantId, actionId: state.actionId, script: diagnoseFailure(result.error, state.actionType) },
        `voice-fail:${state.actionId}`,
        state.correlationId,
      ).catch(() => undefined);
    }
    return { result };
  };
}

export function makeFailedNode() {
  return async (state: GateState): Promise<Partial<GateState>> => {
    await setStatus(state.tenantId, state.actionId, state.groundingError ? "needs_human_review" : "failed");
    return {
      result: {
        status: "failure",
        output: state.groundingError
          ? { groundingBlocked: true, code: state.groundingError.code, ...state.groundingError.details }
          : {},
        error: state.groundingError
          ? state.groundingError.message
          : state.authorityOutcome === "denied"
          ? `Authority denied: ${state.authorityReasonCode ?? "not authorized"}`
          : `This request is missing required details: ${(state.validation?.errors ?? []).join("; ")}`,
        ...(state.groundingError ? { errorKind: state.groundingError.code === "PE_STALE_VERSION" ? "conflict" as const : "validation" as const } : {}),
      },
    };
  };
}

export function makeRejectedNode() {
  return async (): Promise<Partial<GateState>> => ({ result: { status: "success", output: { rejected: true } } });
}
