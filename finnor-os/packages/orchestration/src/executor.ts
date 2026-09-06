// Executor (§9): enforces the confirmation gate — a security boundary, not UX (§28
// blueprint). If policy.requires_confirmation, the action is written as status=pending
// and NOTHING executes until POST /confirm flips it to approved. No tool call before
// the gate clears, on any path.

import type { DomainAction, DomainPolicy, ExecutionResult } from "@finnor/shared-types";
import { withTenant, domainActions, enqueueJob, reconcileWorkStatus, transitionWork } from "@finnor/db";
import { appendEpisode } from "@finnor/memory";
import { eq, and } from "drizzle-orm";
import { ScopedToolRegistry, tenantProviderConfigured, type ToolRegistry } from "@finnor/tools";
import type { PluginRegistry } from "./plugin-registry";
import { diagnoseFailure, buildConfirmationScript } from "./voice";
import { advanceWorkflowForActionRequired } from "./workflow";
import { classifyExecutionFailure, executePluginViaRuntime } from "./runtime-bridge";
import { finalizeReceipt, openReceipt } from "@finnor/workflow-runtime";
import { redactStructured } from "@finnor/security";
import { approvalRequirementForAction } from "../../../scripts/release/action-hardening-spec";
import { evaluateActionAuthorityBoundary } from "./authority-runtime";
import {
  BusinessEffectBoundaryError,
  ensureBusinessEffect,
  recordBusinessEffectOutcome,
} from "./compiler";
import { evaluateEffectAutonomy, recordShadowEffect } from "./autonomy";
import { ActionGroundingError } from "@finnor/plugins-shared";

export interface Executor {
  execute(action: DomainAction, policy: DomainPolicy): Promise<ExecutionResult>;
  /** Optional: best-effort cleanup on reject (e.g. closing a paused graph thread). */
  close?(actionId: string, tenantId: string, actionType: string): Promise<void>;
}

export class GatedExecutor implements Executor {
  constructor(
    private plugins: PluginRegistry,
    private tools: ToolRegistry,
  ) {}

  async execute(action: DomainAction, policy: DomainPolicy): Promise<ExecutionResult> {
    const plugin = this.plugins.resolve(action.actionType);
    if (!plugin) {
      return { status: "failure", output: {}, error: `No plugin handles ${action.actionType}` };
    }

    const validation = plugin.validate(action.actionType, action.payload, policy);
    await appendEpisode(action.tenantId, action.id, "validate", { payload: action.payload }, { ...validation });
    if (!validation.valid) {
      await this.setStatus(action, "failed");
      return {
        status: "failure",
        output: {},
        error: `This request is missing required details: ${validation.errors.join("; ")}`,
      };
    }

    let draft = await plugin.draft(action.actionType, action.payload, policy);
    draft.correlationId = action.correlationId;
    draft.approvedBy = action.approvedBy;
    draft.domainActionId = action.id;
    if (plugin.ground) {
      try {
        const grounded = await plugin.ground(draft, action, policy);
        draft = grounded.draft;
        draft.correlationId = action.correlationId;
        draft.approvedBy = action.approvedBy;
        draft.domainActionId = action.id;
        action.payload = draft.payload;
        action.groundedPayload = grounded.groundedPayload;
        await withTenant(action.tenantId, (db) => db.update(domainActions).set({
          payload: draft.payload,
          groundedPayload: grounded.groundedPayload,
        }).where(and(eq(domainActions.id, action.id), eq(domainActions.tenantId, action.tenantId))));
        await appendEpisode(action.tenantId, action.id, "ground", {}, {
          groundedPayload: grounded.groundedPayload,
        });
      } catch (error) {
        if (!(error instanceof ActionGroundingError)) throw error;
        await this.setStatus(action, "needs_human_review");
        await appendEpisode(action.tenantId, action.id, "ground_blocked", {}, {
          code: error.code,
          message: error.message,
          details: error.details,
        });
        return {
          status: "failure",
          output: { groundingBlocked: true, code: error.code, ...error.details },
          error: error.message,
          errorKind: error.code === "PE_STALE_VERSION" ? "conflict" : "validation",
        };
      }
    }
    if (plugin.prepareDurableOperation) {
      draft = await plugin.prepareDurableOperation(draft, action, policy);
      // Hooks return a draft so they can add the durable operation id. Re-stamp the
      // immutable executor context in case an implementation rebuilt the object.
      draft.correlationId = action.correlationId;
      draft.approvedBy = action.approvedBy;
      draft.domainActionId = action.id;
    }
    await appendEpisode(action.tenantId, action.id, "draft", {}, { summary: draft.summary });

    const approval = approvalRequirementForAction(action.actionType, policy.requiresConfirmation, draft.requiresConfirmation);
    let effect;
    try {
      effect = await ensureBusinessEffect({ action, draft, policy, approval });
    } catch (error) {
      if (!(error instanceof BusinessEffectBoundaryError)) throw error;
      await this.setStatus(action, "needs_human_review");
      await appendEpisode(action.tenantId, action.id, "effect_blocked", {}, { code: error.code, message: error.message });
      return { status: "failure", output: { effectBoundary: error.code }, error: error.message, errorKind: "conflict" };
    }
    if (effect) await appendEpisode(action.tenantId, action.id, "effect_compiled", {}, { businessEffectId: effect.id, semanticHash: effect.semanticHash, scopeHash: effect.scopeHash });
    const authority = await evaluateActionAuthorityBoundary(action, policy, draft);
    if (authority.decision.outcome === "denied" || ((action.status === "approved" || action.status === "executing") && authority.decision.outcome !== "allowed")) {
      await this.setStatus(action, "failed");
      await appendEpisode(action.tenantId, action.id, "authority_denied", { capability: authority.request.capability }, {
        decisionId: authority.decision.id,
        revision: authority.decision.authorityRevision,
        reasonCode: authority.decision.reasonCode,
      });
      return { status: "failure", output: { authorityDecisionId: authority.decision.id }, error: `Authority denied: ${authority.decision.reasonCode}` };
    }
    const requiresAuthorityGate = authority.decision.outcome === "approval_required";
    const autonomy = effect ? await evaluateEffectAutonomy({ action, effect, authority: authority.decision }) : null;
    // Approval mode keeps the existing policy/authority floors exactly as-is. This
    // extra gate applies only when an Autopilot attempt reaches a permanent or
    // current-policy approval boundary; Autopilot may add restrictions, never lower
    // or replace the established permission engine.
    const requiresAutonomyGate = autonomy?.mode === "autopilot" && autonomy.outcome === "approval_required";
    if (autonomy) {
      await appendEpisode(action.tenantId, action.id, "autonomy_evaluated", {
        mode: autonomy.mode,
        packId: autonomy.packId,
        grantId: autonomy.grantId,
      }, {
        outcome: autonomy.outcome,
        eligible: autonomy.eligible,
        reasonCodes: autonomy.reasonCodes,
        certificationFingerprint: autonomy.certificationFingerprint,
      });
    }
    if (effect && autonomy?.outcome === "shadow_only") {
      await recordShadowEffect({ action, effect });
      return {
        status: "success",
        output: {
          shadow: true,
          consequentialMutation: false,
          hypotheticalBusinessEffectId: effect.id,
          semanticHash: effect.semanticHash,
          autonomy,
        },
        expected: { hypotheticalOnly: true },
      };
    }
    if (effect && autonomy?.mode === "autopilot" && autonomy.outcome === "blocked") {
      await this.setStatus(action, "needs_human_review");
      return {
        status: "failure",
        output: { autonomy },
        error: `Autopilot failed closed: ${autonomy.reasonCodes.join(", ")}`,
        errorKind: "config",
      };
    }

    // ---------------- THE CONFIRMATION GATE ----------------
    // The fixed release floor is authoritative: a plugin draft cannot lower a
    // required floor or turn a no-side-effect action into an approval item.
    if ((approval.requiresConfirmation || requiresAuthorityGate || requiresAutonomyGate) && action.status !== "approved" && action.status !== "executing") {
      await withTenant(action.tenantId, async (db) => {
        await db
          .update(domainActions)
          .set({ status: "pending", summary: effect?.approval.summary ?? draft.summary, payload: draft.payload })
          .where(and(eq(domainActions.id, action.id), eq(domainActions.tenantId, action.tenantId)));
      });
      await appendEpisode(action.tenantId, action.id, "gate", {}, { gated: true, summary: effect?.approval.summary ?? draft.summary, businessEffectId: effect?.id ?? null, semanticHash: effect?.semanticHash ?? null });
      await enqueueJob(
        "send_push_notification",
        { tenantId: action.tenantId, kind: "approval-needed", actionId: action.id, body: effect?.approval.summary ?? draft.summary },
        `push:approval-needed:${action.id}`,
        action.correlationId,
      ).catch(() => undefined); // a push is a nudge, never the gate itself
      // Voice-native confirmation: if Vapi is configured, have it read the draft to the
      // owner and capture the spoken yes/no. The queue UI remains the audit/fallback view.
      if (await tenantProviderConfigured(action.tenantId, "vapi")) {
        await enqueueJob(
          "voice_confirm_request",
          { tenantId: action.tenantId, actionId: action.id, script: buildConfirmationScript(effect?.approval.summary ?? draft.summary) },
          `voice-confirm:${action.id}`,
          action.correlationId,
        ).catch(() => undefined); // queue trouble must never break the gate itself
      }
      // Stop here. Execution resumes only via POST /actions/:id/confirm or a spoken yes.
      return {
        status: "success",
        output: { gated: true, pendingConfirmation: true, summary: effect?.approval.summary ?? draft.summary, businessEffectId: effect?.id, ...(autonomy ? { autonomy } : {}) },
      };
    }
    // --------------------------------------------------------

    // A policy may deliberately permit a read-only action without a human
    // confirmation. Record that authorization immutably before claiming it so the
    // runtime bridge can distinguish this legitimate path from a forged SQL status.
    // Confirmation-required actions instead carry the `confirmed` episode written
    // by decide(), which the bridge validates independently.
    if (!approval.requiresConfirmation && !requiresAuthorityGate && !requiresAutonomyGate) {
      // Consequential policy authorization is persisted by runtime-bridge in the
      // same transaction as its command/first job. Reads have no Business Effect and
      // retain the small synchronous authorization episode used below.
      if (!effect) {
        await appendEpisode(action.tenantId, action.id, "policy_ungated_authorized", { policyId: policy.id ?? null }, {
          actionType: action.actionType,
          approvalFloor: approval.approvalFloor,
          reason: "fixed action floor does not require confirmation",
        });
      }
    }
    if (!effect) await this.setStatus(action, "executing");
    // Scoped per action execution: claims each external tool call against the
    // external_operations ledger so a reflection retry never re-fires an
    // already-completed side effect (for example, delivering a message twice).
    const identityRef = draft.payload.communicationIdentityRef && typeof draft.payload.communicationIdentityRef === "object"
      ? draft.payload.communicationIdentityRef as Record<string, unknown>
      : null;
    const requestedCommunicationIdentityId = typeof draft.payload.communicationIdentityId === "string"
      ? draft.payload.communicationIdentityId
      : typeof identityRef?.communicationIdentityId === "string" ? identityRef.communicationIdentityId
        : effect?.bindings.find((binding) => binding.communicationIdentityId)?.communicationIdentityId;
    const requestedAuthProfileRef = typeof draft.payload.authProfileRef === "string" ? draft.payload.authProfileRef : effect?.bindings.find((binding) => binding.authProfileRef)?.authProfileRef;
    const accessPurpose = typeof draft.payload.purpose === "string" && draft.payload.purpose.trim() ? draft.payload.purpose : action.actionType;
    const scopedTools = new ScopedToolRegistry(this.tools, {
      tenantId: action.tenantId,
      domainActionId: action.id,
      ...(action.initiatedBy ? { actorId: action.initiatedBy } : { actorId: "system:orchestration" }),
      purpose: accessPurpose,
      ...(requestedCommunicationIdentityId ? { communicationIdentityId: requestedCommunicationIdentityId } : {}),
      ...(requestedAuthProfileRef ? { authProfileRef: requestedAuthProfileRef } : {}),
      ...(effect ? { businessEffectId: effect.id, businessEffectHash: effect.semanticHash } : {}),
    });
    // §2.5: routes through @finnor/workflow-runtime (command/step + DecisionReceipt)
    // instead of calling plugin.execute() bare — same real result, now with a durable
    // record. See runtime-bridge.ts's header comment for why this is synchronous.
    const result = await executePluginViaRuntime({
      tenantId: action.tenantId,
      actionId: action.id,
      actionType: action.actionType,
      correlationId: action.correlationId,
      draft,
      plugin,
      tools: scopedTools,
    });
    if (autonomy) result.output.autonomy = autonomy;
    if (result.output.durableWorkerExecution === true) {
      if (action.workId) await transitionWork(action.tenantId, action.workId, "executing", "action_execution_authorized", {
        actionId: action.id,
        workflowRunId: result.output.workflowRunId,
        queued: true,
      });
      return result;
    }
    if (!effect) {
      const { receiptId } = await openReceipt({
        tenantId: action.tenantId,
        workId: action.workId ?? undefined,
        domainActionId: action.id,
        objective: `${action.actionType}: synchronous non-consequential execution`,
        evidence: [{ source: "domain_action", ref: action.id, timestamp: new Date().toISOString() }],
        policyApplied: policy.version > 0 && policy.id ? { id: policy.id, version: policy.version } : null,
        riskTier: "low",
        proposedAction: { actionType: action.actionType, summary: draft.summary },
        approval: { required: false, at: new Date().toISOString() },
        expectedResult: result.expected,
      });
      if (result.status === "success") {
        await finalizeReceipt(action.tenantId, receiptId, { actualResult: { status: result.status, output: redactStructured(result.output) } });
      } else {
        const failure = classifyExecutionFailure(result);
        await finalizeReceipt(action.tenantId, receiptId, { failure: { errorKind: failure.errorKind, message: failure.reason, recoveryPath: "Review the action result and submit a corrected request if needed." } });
      }
    }
    const effectVerification = effect ? await recordBusinessEffectOutcome(action.tenantId, effect, result) : null;
    await appendEpisode(action.tenantId, action.id, "execute", { draft: draft.payload }, { ...result });

    // computer_task's synchronous action result means "durably queued", not
    // "business task succeeded". The worker owns the executing -> terminal action
    // transition after it observes verifiable external evidence.
    if (result.status === "success" && result.output.pendingComputerRun === true) {
      return result;
    }

    const finalStatus =
      effectVerification?.state === "divergent" || effectVerification?.state === "reconciliation_required" || result.errorKind === "unknown_outcome"
        ? "needs_human_review"
        : effectVerification?.state === "partially_verified"
          ? "executing"
        : result.status === "success"
        ? "completed"
        : result.status === "integration_unavailable"
          ? "blocked_integration_unavailable"
          : "failed";
    await this.setStatus(action, finalStatus);
    if (finalStatus === "completed") {
      // Advance the relevant workflow state machine (§14) — state lives in the DB.
      const workflow = await advanceWorkflowForActionRequired({
        tenantId: action.tenantId,
        actionId: action.id,
        actionType: action.actionType,
        payload: (draft.payload ?? action.payload) as Record<string, unknown>,
      });
      if (!workflow.ok) {
        return {
          status: "failure",
          output: { ...result.output, effectSucceeded: true, workflowAdvancementRecorded: false },
          error: "The action succeeded, but its required workflow state could not be advanced. Do not repeat the effect; reconcile the workflow state.",
          errorKind: "needs_human",
        };
      }
      if (workflow.advanced.length > 0) {
        await appendEpisode(action.tenantId, action.id, "workflow", {}, { advanced: workflow.advanced });
      }
    }
    if (finalStatus === "blocked_integration_unavailable" && await tenantProviderConfigured(action.tenantId, "vapi")) {
      // Spoken failure diagnosis: name the failing integration out loud, in addition to
      // the audit entry and the blocked queue card. Never instead of them.
      await enqueueJob(
        "voice_notify_failure",
        { tenantId: action.tenantId, actionId: action.id, script: diagnoseFailure(result.error, action.actionType) },
        `voice-fail:${action.id}`,
        action.correlationId,
      ).catch(() => undefined);
    }
    return result;
  }

  private async setStatus(action: DomainAction, status: DomainAction["status"]): Promise<void> {
    await withTenant(action.tenantId, async (db) => {
      await db
        .update(domainActions)
        .set({
          status,
          ...(status === "executing" ? { executionStartedAt: new Date() } : {}),
          ...(status === "completed" || status === "failed" || status === "blocked_integration_unavailable" || status === "needs_human_review" ? { executionStartedAt: null } : {}),
        })
        .where(and(eq(domainActions.id, action.id), eq(domainActions.tenantId, action.tenantId)));
    });
    if (action.workId) {
      if (status === "executing") {
        await transitionWork(action.tenantId, action.workId, "executing", "action_execution_started", { actionId: action.id });
      } else {
        await reconcileWorkStatus(action.tenantId, action.workId);
      }
    }
  }
}
