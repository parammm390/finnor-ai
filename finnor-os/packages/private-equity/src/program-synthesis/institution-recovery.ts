import { withTenantTransaction } from "@finnor/db";
import type { InstitutionHarnessProgram } from "./contracts";
import { matchesFrozenInstitutionIntent, readCanonicalDuty } from "./duty-observer";
import { sha } from "../evidence-execution/store";

type OriginalAction = {
  id: string; initiatedBy: string | null; workId: string | null;
  planRevisionId: string | null; actionType: string; payload: unknown;
  authorityContext: unknown;
};

/** Read-only settlement of a lost native acknowledgement. This closed adapter
 * never executes an action, reopens a grant or changes its original intent. */
export async function observeUnknownInstitutionCreation(tenantId: string,
  action: OriginalAction, effectPayload: Record<string, unknown>) {
  const origin = action.authorityContext as Record<string, unknown> | null;
  if (!origin || origin.kind !== "institution_duty" || !action.initiatedBy
      || !action.workId || !action.planRevisionId || typeof origin.programId !== "string"
      || typeof origin.stableIdentity !== "string"
      || !["create_deal_request", "open_workstream", "record_finding"].includes(action.actionType)) return null;
  return withTenantTransaction(tenantId, { userId: action.initiatedBy }, async (_db, c) => {
    const row = (await c.query<{ body: InstitutionHarnessProgram; digest: string;
      institution: unknown }>(`SELECT p.body,p.digest,q.request->'institution' institution
      FROM finnor_os.p1_requests q JOIN finnor_os.p1_programs p
        ON p.tenant_id=q.tenant_id AND p.request_id=q.id AND p.id=q.head_id
      WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id::text=$3
        AND q.work_id=$4 AND q.plan_revision_id=$5 FOR SHARE OF q,p`,
    [tenantId, action.initiatedBy, origin.programId, action.workId, action.planRevisionId])).rows[0];
    if (!row || sha(row.body) !== row.digest
        || row.body.schema !== "finnor.institution-harness-program.v1"
        || row.body.acceptanceDigest !== sha(row.institution)
        || row.body.work.id !== action.workId || row.body.work.planRevisionId !== action.planRevisionId) return null;
    const nodes = row.body.nodes.filter(node => node.stableIdentity === origin.stableIdentity
      && node.operation === action.actionType && node.action?.expectedEntityId === action.id);
    if (nodes.length !== 1) return null;
    const node = nodes[0]!;
    if (!matchesFrozenInstitutionIntent(node.action!.payload, action.payload, action.workId)
        || !matchesFrozenInstitutionIntent(node.action!.payload, effectPayload, action.workId)) return null;
    const observation = await readCanonicalDuty(c, tenantId, node);
    return observation.observed ? { ...observation, stableIdentity: node.stableIdentity,
      originalDeadline: node.deadlineAt, programmeDigest: row.digest,
      basis: "EXACT_FROZEN_X1_DUTY_CANONICAL_READ_ONLY_SETTLEMENT" } : null;
  });
}
