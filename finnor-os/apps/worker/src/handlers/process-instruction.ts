// process_instruction job: the async entry point for Vapi transcripts — runs the full
// Planner → gate → Executor → Reflection pipeline under the tenant's context.

import type { FinnorOrchestrator } from "@finnor/orchestration";
import { economicReadForInput } from "@finnor/orchestration";
import { PLACEHOLDER_NEEDS_REAL_VALUE, type TenantContext, type Role } from "@finnor/shared-types";
import { withTenantTransaction } from "@finnor/db";
import type { JobHandler } from "../queue";

let orchestrator: FinnorOrchestrator | null = null;

export const processInstruction: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const instruction = String(payload.instruction ?? "");
  if (!tenantId || tenantId === PLACEHOLDER_NEEDS_REAL_VALUE) {
    throw new Error("process_instruction: tenantId is missing from the durable Work/job payload");
  }
  if (!instruction) throw new Error("process_instruction requires an instruction");
  if (!orchestrator) {
    const { FinnorOrchestrator } = await import("@finnor/orchestration");
    orchestrator = new FinnorOrchestrator();
  }
  // A2.T1: forward the trace id the webhook route minted at intake (queue.ts's own
  // convention, payload._correlationId) into the orchestrator's ctx — otherwise the
  // thread that runs live in Sentry/receipts for the synchronous vapi tool-calls path
  // silently goes cold for the far more common async transcript path.
  const correlationId = typeof payload._correlationId === "string" ? payload._correlationId : undefined;
  let ctx: TenantContext = {
    tenantId,
    userId: "00000000-0000-4000-8000-0000000000ee", // system principal for webhook-originated work
    role: "owner",
    correlationId,
  };
  if (economicReadForInput(instruction)) {
    // A queued read carries the authenticated original input, never service-name
    // or payload-supplied act_as authority. Normal current grants still apply.
    const original = await withTenantTransaction(tenantId, { readOnly: true }, async (_db, client) =>
      (await client.query<{ role: Role; created_by: string; instruction_text: string }>(
        `SELECT u.role,i.created_by::text,i.instruction_text FROM finnor_os.work_inputs i
           JOIN finnor_os.users u ON u.tenant_id=i.tenant_id AND u.id=i.created_by AND u.status='active'
         WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3 AND i.instruction_id=$4`,
        [tenantId, payload.workId, payload.workInputId, payload.instructionId])).rows[0]);
    if (!original || original.instruction_text !== instruction) throw Error("process_instruction: authenticated exact original read input is required");
    ctx = { tenantId, userId: original.created_by, employeeId: original.created_by, role: original.role, correlationId };
  }
  await orchestrator.handleInstruction(instruction, ctx, {
    channel: "voice",
    sessionId: typeof payload.callId === "string" ? `vapi:${payload.callId}` : undefined,
    workId: typeof payload.workId === "string" ? payload.workId : undefined,
    workInputId: typeof payload.workInputId === "string" ? payload.workInputId : undefined,
    instructionId: typeof payload.instructionId === "string" ? payload.instructionId : undefined,
  });
};
