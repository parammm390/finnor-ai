import type { PeMutationContext } from "../types";
import { principal } from "../owner-context";
import { bytesHash, growthInputSchema, type GrowthInput } from "./contracts";
import { authorizeGrowthWork, growthSourceOriginal, growthTx, type GrowthRequestRow } from "./store";

/** Display handles for actual originals, never a replacement producer or grant. */
export async function growthPreparedOutcomes(ctx: PeMutationContext, workId: string) {
  return growthTx(ctx, async c => {
    await authorizeGrowthWork(ctx, workId, c);
    const latest = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_inputs
     WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId, workId])).rows[0];
    if (!latest) throw Error("W4_CURRENT_ORIGINAL_WORK_INPUT_REQUIRED");
    const rows = (await c.query<{ source_id: string; version_id: string; content_digest: string; content: string }>(
      `SELECT l.source_id,l.version_id,l.content_digest,v.content
       FROM finnor_os.w4_original_source_links l JOIN finnor_os.evidence_source_versions v
        ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
       WHERE l.tenant_id=$1 AND l.principal_id=$2 AND l.author_id=$2 AND l.work_id=$3 AND l.kind='OUTCOME'
        AND v.content_hash=l.content_digest
        AND v.version_number=(SELECT max(h.version_number) FROM finnor_os.evidence_source_versions h
         WHERE h.tenant_id=v.tenant_id AND h.source_id=v.source_id)
        AND NOT EXISTS(SELECT 1 FROM finnor_os.w4_business_requests r WHERE r.tenant_id=l.tenant_id
         AND r.work_id=l.work_id AND r.outcome_ref->>'sourceId'=l.source_id::text
         AND r.outcome_ref->>'versionId'=l.version_id::text)
       ORDER BY l.created_at,l.source_id LIMIT 33`, [ctx.auth.tenantId, principal(ctx), workId])).rows;
    if (rows.length > 32) throw Error("W4_PREPARED_OUTCOME_READ_BOUND_INCOMPLETE");
    return rows.map(row => {
      if (bytesHash(row.content) !== row.content_digest) throw Error("W4_ORIGINAL_S1_SOURCE_UNAVAILABLE");
      const original = growthInputSchema.parse(JSON.parse(row.content));
      if (original.scope.tenantId !== ctx.auth.tenantId || original.scope.principalId !== principal(ctx)
        || original.scope.workId !== workId) throw Error("W4_ORIGINAL_SCOPE_MISMATCH");
      return { source: { sourceId: row.source_id, versionId: row.version_id, contentDigest: row.content_digest },
        workInputId: latest.id, budgetObligationRef: original.budgetObligation,
        scope: original.scope, originalMeaning: original.originalMeaning, question: original.question,
        originalDeadlineAt: original.originalDeadlineAt, permittedPurpose: original.permittedPurpose,
        status: "RECORDED_ORIGINAL_REQUIRES_OWNER_REVALIDATION" as const };
    });
  });
}

export async function growthOwnerProductInfo(ctx: PeMutationContext, request: GrowthRequestRow, input: GrowthInput) {
  return growthTx(ctx, async c => {
    await authorizeGrowthWork(ctx, request.work_id, c);
    const policy = await growthSourceOriginal(ctx, request.work_id, input.terms.accountingPolicySource, c, false);
    const assignments = [
      ...input.population.map(b => ({ id: b.buyerId, role: "BUYER" as const })),
      ...input.capabilities.map(cap => ({ id: cap.operatorId, role: "OPERATOR" as const })),
      { id: input.test.independentObservationOwnerId, role: "INDEPENDENT_OBSERVER" as const },
      { id: policy.author_id, role: "ACCOUNTANT" as const },
    ];
    const users = (await c.query<{ id: string; email: string }>(`SELECT id,email FROM finnor_os.users
     WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='active'`,
    [request.tenant_id, [...new Set(assignments.map(a => a.id))]])).rows;
    const seen = new Set<string>();
    const participants = assignments.flatMap(assignment => {
      const user = users.find(user => user.id === assignment.id), key = assignment.id + ":" + assignment.role;
      if (!user || user.id === request.principal_id || seen.has(key)) return [];
      seen.add(key); return [{ id: user.id, label: user.email, role: assignment.role }];
    });
    const protocols = (await c.query<{ id: string; participant_id: string; role: string; expires_at: Date;
      consent_at: Date | null; revoked_at: Date | null }>(`SELECT id,participant_id,role,expires_at,consent_at,revoked_at
     FROM finnor_os.w4_participant_protocols WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3
     ORDER BY created_at,id LIMIT 257`, [request.tenant_id, request.principal_id, request.id])).rows;
    if (protocols.length > 256) throw Error("W4_OWNER_PROTOCOL_READ_BOUND_INCOMPLETE");
    return { scope: input.scope, purpose: input.permittedPurpose, participants,
      accountingPolicySource: input.terms.accountingPolicySource,
      currentUntil: new Date(Math.min(Date.parse(input.originalDeadlineAt), Date.parse(input.test.closesAt),
        ...input.capabilities.map(cap => Date.parse(cap.validUntil)),
        ...input.demands.map(d => Date.parse(d.validUntil)),
        ...input.population.map(b => Date.parse(b.consentValidUntil)))).toISOString(),
      protocols: protocols.map(p => ({ id: p.id, participantId: p.participant_id, role: p.role,
        expiresAt: p.expires_at.toISOString(), status: p.revoked_at ? "REVOKED"
          : p.expires_at.getTime() <= Date.now() ? "EXPIRED" : p.consent_at ? "CONSENTED" : "INVITED" })) };
  });
}
