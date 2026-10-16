import { processWorkEventWaitDeadline } from "@finnor/orchestration/event-waits";
import type { JobHandler } from "../queue";

/** Targeted durable timer. It can only persist deadline.reached, atomically time out
 * one exact wait, and enqueue the existing Objective Loop. Escalation remains a
 * later bounded Objective decision through the normal authority/action path. */
export const processWorkEventWaitDeadlineHandler: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const waitId = typeof payload.waitId === "string" ? payload.waitId : "";
  if (!tenantId || !waitId) throw new Error("process_work_event_wait_deadline requires tenantId and waitId");
  await processWorkEventWaitDeadline(tenantId, waitId);
};
