import { z } from "zod";
import { DatabaseExecutionDeadlineError, withTenantClientTransaction } from "@finnor/db";
import { authorize, principal } from "./owner-context";
import type { PeClient } from "./repository";
import type { PeMutationContext } from "./types";
import { assertCommitteeMemoRunsCurrent } from "./underwriting-repository";

const sourceRefsSchema = z.array(z.string().transform(ref => {
  const [type, id, extra] = ref.split(":");
  return { type, id, extra };
}).pipe(z.object({
  type: z.enum(["pe_ic_case", "pe_deal", "underwriting_run", "document_version", "pe_deal_risk", "pe_finding", "pe_evidence_link"]),
  id: z.string().uuid(),
  extra: z.undefined(),
}))).min(2).max(192);

export async function canReadGeneratedCommitteeMemo(
  ctx: PeMutationContext, documentId: string, client?: PeClient,
): Promise<boolean> {
  const tenant = ctx.auth.tenantId;
  const read = async (scoped: PeClient) => {
    const { rows } = await scoped.query<{ archived: boolean; sourceRefs: unknown }>(`
      SELECT document.archived_at IS NOT NULL AS archived, recorded."sourceRefs"
        FROM finnor_os.documents document
        LEFT JOIN LATERAL (
          SELECT event.payload->'sourceRefs' AS "sourceRefs"
            FROM finnor_os.document_versions version
            JOIN finnor_os.business_events event
              ON event.tenant_id=version.tenant_id AND event.entity_type='document' AND event.entity_id=version.document_id
             AND event.event_type='document_version_observed' AND event.source='ic_memo_draft'
             AND event.payload->>'documentVersionId'=version.id::text
           WHERE version.tenant_id=document.tenant_id AND version.document_id=document.id
             AND version.source_system='ic_memo_draft' AND version.source_ref=document.external_id
           LIMIT 2
        ) recorded ON true
       WHERE document.tenant_id=$1 AND document.id=$2 AND document.source_system='ic_memo_draft'`,
    [tenant, documentId]);
    if (!rows.length) return true;
    const origin = rows[0];
    if (!origin || rows.length !== 1 || origin.archived) return false;
    const sources = sourceRefsSchema.safeParse(origin.sourceRefs);
    if (!sources.success) return false;
    const caseIds = sources.data.filter(ref => ref.type === "pe_ic_case").map(ref => ref.id);
    const runIds = [...new Set(sources.data.filter(ref => ref.type === "underwriting_run").map(ref => ref.id))];
    const versionIds = [...new Set(sources.data.filter(ref => ref.type === "document_version").map(ref => ref.id))];
    const [caseId] = caseIds;
    if (!caseId || caseIds.length !== 1 || !runIds.length) return false;
    const { rows: [committee] } = await scoped.query<{ dealId: string; investmentCaseId: string }>(`
      SELECT ic.deal_id::text AS "dealId", ic.investment_case_id::text AS "investmentCaseId"
        FROM finnor_os.pe_ic_cases ic
       WHERE ic.tenant_id=$1 AND ic.id=$2 AND EXISTS (
         SELECT 1 FROM finnor_os.pe_document_links link
          WHERE link.tenant_id=ic.tenant_id AND link.deal_id=ic.deal_id AND link.document_id=$3
            AND link.entity_type='pe_ic_case' AND link.entity_id=ic.id AND link.link_role='source'
            AND link.archived_at IS NULL
       )`, [tenant, caseId, documentId]);
    if (!committee) return false;
    const { rows: documents } = await scoped.query<{ id: string }>(`
      SELECT document.id::text FROM finnor_os.document_versions version
        JOIN finnor_os.documents document
          ON document.tenant_id=version.tenant_id AND document.id=version.document_id AND document.archived_at IS NULL
       WHERE version.tenant_id=$1 AND version.id=ANY($2::uuid[])`, [tenant, versionIds]);
    if (documents.length !== versionIds.length) return false;
    try {
      await authorize(ctx, { entityType: "pe_deal", entityId: committee.dealId }, [
        ...sources.data.filter(ref => ref.type !== "document_version"),
        { type: "document", id: documentId },
        ...documents.map(document => ({ type: "document", id: document.id })),
      ], [], scoped);
      await assertCommitteeMemoRunsCurrent(ctx, { investmentCaseId: committee.investmentCaseId, runIds }, scoped);
      return true;
    } catch (error) {
      if (error instanceof DatabaseExecutionDeadlineError) throw error;
      return false;
    }
  };
  return client ? read(client) : withTenantClientTransaction(tenant, {
    userId: principal(ctx), isolation: "repeatable read", readOnly: true,
  }, read);
}
