// A4.T3: recomputes suggested_disposition/suggestion_reason on every open dead_letters
// row for a tenant. Thin wiring only — the actual rule lives in
// packages/workflow-runtime/src/dlq-triage.ts (pure, unit-tested there).

import { triageOpenDeadLetters } from "@finnor/workflow-runtime/dlq-triage";
import type { JobHandler } from "../queue";

export const scanDlqTriage: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("scan_dlq_triage requires tenantId");
  await triageOpenDeadLetters(tenantId);
};
