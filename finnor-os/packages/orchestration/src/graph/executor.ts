// LangGraphExecutor: implements the exact same Executor interface GatedExecutor does,
// so FinnorOrchestrator.handleInstruction/draftKnownAction/runAction need zero changes
// — they already call this.executor.execute(action, policy) through the interface,
// which is exactly the seam this slots into.
//
// Three invocation shapes, all handled by one method:
//  - Fresh planned action (action.status="draft", no checkpoint yet): plain invoke().
//  - Reflection retry (action.status="approved", called directly by reflectWithRetry,
//    thread already at END — not paused): also a plain invoke(), but alreadyApproved
//    is derived from action.status so the gate is correctly skipped, mirroring the old
//    `action.status !== "approved"` check exactly.
//  - Real human-approval resume (thread IS currently paused at "pause"): a genuine
//    Command({resume}) — continues from the exact draft the human was shown, never
//    re-derives validate()/draft() (an intentional tightening vs. the old behavior).
import { Command } from "@langchain/langgraph";
import type { DomainAction, DomainPolicy, ExecutionResult } from "@finnor/shared-types";
import type { Executor } from "../executor";
import type { buildGateGraph } from "./build-graph";

export class LangGraphExecutor implements Executor {
  constructor(private graph: ReturnType<typeof buildGateGraph>) {}

  async execute(action: DomainAction, policy: DomainPolicy): Promise<ExecutionResult> {
    const config = { configurable: { thread_id: action.id } };
    const before = await this.graph.getState(config);
    const isPausedHere = (before.next ?? []).includes("pause");

    if (isPausedHere) {
      await this.graph.invoke(new Command({ resume: "approve" }), config);
    } else {
      await this.graph.invoke(
        {
          actionId: action.id,
          tenantId: action.tenantId,
          actionType: action.actionType,
          payload: action.payload,
          policy,
          alreadyApproved: action.status === "approved" || action.status === "executing",
          correlationId: action.correlationId,
          workId: action.workId ?? undefined,
          initiatedBy: action.initiatedBy ?? undefined,
          approvedBy: action.approvedBy ?? undefined,
        },
        config,
      );
    }

    const after = await this.graph.getState(config);
    if ((after.next ?? []).includes("pause")) {
      return { status: "success", output: { gated: true, pendingConfirmation: true, summary: after.values.draft?.businessEffect?.approval.summary ?? after.values.draft?.summary, businessEffectId: after.values.draft?.businessEffect?.id } };
    }
    return after.values.result as ExecutionResult;
  }

  // Reject path: best-effort close of a paused thread so it doesn't dangle waiting for
  // a resume that will never come. Never blocks the reject itself.
  async close(actionId: string): Promise<void> {
    await this.graph
      .invoke(new Command({ resume: "reject" }), { configurable: { thread_id: actionId } })
      .catch(() => undefined);
  }
}
