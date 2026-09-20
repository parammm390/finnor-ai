import { createHash } from "node:crypto";
import { jobs, withTenant } from "@finnor/db";
import {
  advanceWorkflow,
  claimStep,
  submitCommand,
} from "@finnor/workflow-runtime";
import {
  claimExternalOperation,
  claimOwnedExternalOperation,
  markProviderRequestMayHaveLeft,
  prepareProviderInvocation,
  recordProviderInvocationAcknowledged,
} from "@finnor/tools";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function requestHash(label: string): string {
  return createHash("sha256").update(`scope2-crash:${label}`).digest("hex");
}

function kill(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL unexpectedly returned");
}

async function main(): Promise<void> {
  const mode = required(process.argv[2], "mode");
  const tenantId = required(process.argv[3], "tenantId");

  if (mode === "transaction-before-commit" || mode === "transaction-after-commit") {
    const boundaryId = required(process.argv[4], "boundaryId");
    const idempotencyKey = `scope2-crash-boundary:${boundaryId}`;
    if (mode === "transaction-before-commit") {
      await withTenant(tenantId, async (db) => {
        await db.insert(jobs).values({
          type: "release_probe",
          payload: { boundaryId },
          idempotencyKey,
          retrySafety: "pure",
          protocolVersion: 1,
        }).onConflictDoNothing({ target: jobs.idempotencyKey });
        kill();
      });
      throw new Error("pre-commit transaction probe failed to kill the child");
    }
    await withTenant(tenantId, (db) => db.insert(jobs).values({
      type: "release_probe",
      payload: { boundaryId },
      idempotencyKey,
      retrySafety: "pure",
      protocolVersion: 1,
    }).onConflictDoNothing({ target: jobs.idempotencyKey }));
    kill();
  }

  if (mode === "command-pre-commit") {
    const label = required(process.argv[4], "label");
    process.env.FINNOR_CHAOS_KILL_POINT = "command_pre_commit";
    await withTenant(tenantId, (db) => submitCommand(db, {
      tenantId,
      commandType: "scope2_sigkill_command",
      payload: { label },
      workflowType: "scope2_sigkill_workflow",
      steps: [{ stepType: "scope2_sigkill_step", payload: { label } }],
      idempotencyKey: `scope2-crash-command:${label}`,
    }));
    throw new Error("command pre-commit hook failed to kill the child");
  }

  if (mode === "step-claim-post-commit") {
    const stepId = required(process.argv[4], "stepId");
    const generation = Number(required(process.argv[5], "generation"));
    process.env.FINNOR_CHAOS_KILL_POINT = "post_commit_pre_ack";
    await claimStep(tenantId, stepId, generation, {
      workerId: `scope2-crash-child:${process.pid}`,
      jobProtocolVersion: 2,
      eligibilityEvidence: { version: 1, source: "scope2_real_sigkill_certification" },
    });
    throw new Error("step post-commit hook failed to kill the child");
  }

  if (mode === "advance-mid-multi-step") {
    const runId = required(process.argv[4], "runId");
    process.env.FINNOR_CHAOS_KILL_POINT = "mid_multi_step";
    await advanceWorkflow(tenantId, runId);
    throw new Error("multi-step hook failed to kill the child");
  }

  if (mode === "provider-prepared" || mode === "provider-possible-egress") {
    const label = required(process.argv[4], "label");
    const hash = requestHash(label);
    const claimed = await claimOwnedExternalOperation(
      tenantId,
      { type: "system_job", key: `scope2-crash:${label}` },
      `member:${label}`,
      hash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      {
        protocolVersion: 2,
        targetKey: `target:${label}`,
        retrySafety: "readback_required",
        verification: "readback",
        sourceTruthRequired: false,
        idempotency: { mode: "readback", scope: "scope2-real-sigkill" },
      },
    );
    if (!claimed.claimed) throw new Error("crash child could not establish the logical provider operation");
    const invocationId = await prepareProviderInvocation({
      tenantId,
      providerOperationAttemptId: claimed.providerOperationAttemptId,
      provider: "deterministic_fault_provider",
      requestHash: hash,
      transportLayer: "fake_provider",
    }, 1);
    if (mode === "provider-possible-egress") {
      await markProviderRequestMayHaveLeft(tenantId, invocationId);
    }
    kill();
  }

  if (mode === "provider-response-before-persist") {
    const label = required(process.argv[4], "label");
    const providerUrl = required(process.argv[5], "providerUrl");
    const hash = requestHash(label);
    const claimed = await claimOwnedExternalOperation(
      tenantId,
      { type: "system_job", key: `scope2-crash:${label}` },
      `member:${label}`,
      hash,
      "deterministic_fault_provider",
      undefined,
      undefined,
      {
        protocolVersion: 2,
        targetKey: `target:${label}`,
        retrySafety: "readback_required",
        verification: "readback",
        sourceTruthRequired: false,
        idempotency: { mode: "readback", scope: "scope2-real-sigkill" },
      },
    );
    if (!claimed.claimed) throw new Error("crash child could not establish the logical provider operation");
    const invocationId = await prepareProviderInvocation({
      tenantId,
      providerOperationAttemptId: claimed.providerOperationAttemptId,
      provider: "deterministic_fault_provider",
      requestHash: hash,
      transportLayer: "fake_provider",
    }, 1);
    await markProviderRequestMayHaveLeft(tenantId, invocationId);
    const response = await fetch(providerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, idempotencyKey: claimed.operation.providerIdempotencyKey ?? null }),
    });
    if (!response.ok) throw new Error(`fake provider returned ${response.status}`);
    await response.arrayBuffer();
    // The provider response exists only in this dying process. No local receipt was
    // persisted, so restart must preserve uncertainty and must not call again.
    kill();
  }

  if (mode === "provider-ack-post-commit") {
    const label = required(process.argv[4], "label");
    const actionId = required(process.argv[5], "actionId");
    const effectId = required(process.argv[6], "effectId");
    const hash = requestHash(label);
    const claimed = await claimExternalOperation(
      tenantId,
      actionId,
      `member:${label}`,
      hash,
      "deterministic_fault_provider",
      effectId,
      undefined,
      {
        protocolVersion: 2,
        targetKey: `target:${label}`,
        retrySafety: "readback_required",
        verification: "readback",
        sourceTruthRequired: false,
        idempotency: { mode: "readback", scope: "scope2-real-sigkill" },
      },
    );
    if (!claimed.claimed) throw new Error("crash child could not establish the effect member");
    const context = {
      tenantId,
      providerOperationAttemptId: claimed.providerOperationAttemptId,
      provider: "deterministic_fault_provider",
      requestHash: hash,
      transportLayer: "fake_provider" as const,
    };
    const invocationId = await prepareProviderInvocation(context, 1);
    await markProviderRequestMayHaveLeft(tenantId, invocationId);
    await recordProviderInvocationAcknowledged(context, invocationId, { externalRecordId: `fake:${label}` });
    // ACK, logical result, and readback job are committed; the caller never receives
    // an acknowledgement because this process dies immediately afterward.
    kill();
  }

  throw new Error(`unknown crash-child mode ${mode}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
