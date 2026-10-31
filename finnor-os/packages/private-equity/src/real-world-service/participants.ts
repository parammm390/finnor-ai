import { z } from "zod";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { principal, unavailable } from "../owner-context";
import {
  canonical, hash, sameScope, ObservationSchema, ScopeSchema, type SourceRef, type ObservationOriginal, type ServiceScope,
} from "./contracts";
import { InviteSchema, ReportSchema, QualificationSchema } from "./boundaries";
import {
  serviceTx, serviceRequest, currentServiceCut, serviceArtifact, sourceOriginal, sourceOriginals, persistServiceSource,
  type ServiceRequestRow,
} from "./store";
import { requireServiceProfile, serviceNow } from "./identity";

interface ParticipantProtocol {
  id: string; tenant_id: string; principal_id: string; request_id: string; participant_id: string;
  instance_id: string; provider_id: string; terms_digest: string;
  role: ObservationOriginal["role"]; criterion_ids: string[]; permitted_kinds: string[];
  purpose: string; operational_disclosure: { scope: ServiceScope; [key: string]: unknown };
  qualification_refs: SourceRef[]; incentive_ref: SourceRef | null; expires_at: Date;
  consent_at: Date | null; revoked_at: Date | null;
}
const allowedKinds: Record<ObservationOriginal["role"], readonly string[]> = {
  PROVIDER: ["PROVIDER_EVIDENCE", "QUOTE", "ACCEPTED", "STARTED", "DELIVERED", "CANCELLED", "INVOICE", "COST", "DISPUTED"],
  RECIPIENT: ["OBSERVATION", "MISSED", "DISPUTED"],
  INSPECTOR: ["OBSERVATION", "MISSED", "DISPUTED", "COST"],
  PROFESSIONAL: ["OBSERVATION", "DISPUTED", "COST"],
  ACCEPTANCE_OWNER: ["OBSERVATION", "ORIGINAL_ACCEPTANCE", "CANCELLATION_REQUESTED", "PAYMENT", "COST", "DISPUTED"],
};
export async function inviteServiceParticipant(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = InviteSchema.parse(raw);
  return serviceTx(ctx, async c => {
    const request = await serviceRequest(ctx, input.requestId, c, true);
    const { outcome, providers } = await currentServiceCut(ctx, request, c);
    const instance = outcome.demands.find(d => d.id === input.instanceId);
    if (!instance || input.permittedKinds.some(k => !allowedKinds[input.role].includes(k))) throw Error("W3_PROTOCOL_OUTSIDE_ROLE");
    const actor = (await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.auth.tenantId, input.participantId])).rows[0];
    if (!actor || input.role === "PROVIDER" && input.participantId !== input.providerId
      || input.role === "ACCEPTANCE_OWNER" && input.participantId !== outcome.acceptanceOwnerId) throw unavailable();
    if (new Set(input.criterionIds).size !== input.criterionIds.length
      || input.criterionIds.some(id => !instance.criterionIds.includes(id))) throw Error("W3_PROTOCOL_CRITERION_MISMATCH");
    const artifact = await serviceArtifact(ctx, request, c);
    const discovery = input.permittedKinds.length === 1 && input.permittedKinds[0] === "PROVIDER_EVIDENCE";
    if (discovery ? input.termsDigest !== hash(outcome)
      : !artifact?.body.options.some(o => o.instanceId === input.instanceId && o.providerId === input.providerId
        && o.termsDigest === input.termsDigest)) throw Error("W3_EXACT_CURRENT_PROTOCOL_TERMS_REQUIRED");
    const criterion = outcome.criteria.filter(c => input.criterionIds.includes(c.id));
    if (criterion.some(c => c.independentOfProvider) && input.participantId === input.providerId)
      throw Error("W3_PROVIDER_CANNOT_SELF_INSPECT");
    if (criterion.some(c => c.kind === "SENSORY") && input.role !== "RECIPIENT"
      || criterion.some(c => c.kind === "PROFESSIONAL") && input.role !== "PROFESSIONAL") throw Error("W3_APPROPRIATE_OBSERVER_ROLE_REQUIRED");
    const qualifications: string[] = [];
    for (const ref of input.qualificationRefs) {
      const source = await sourceOriginal(ctx, request.work_id, ref, c);
      const qualification = QualificationSchema.parse(JSON.parse(source.content));
      if (!sameScope(qualification.scope, outcome.scope)
        || qualification.subjectPrincipalId !== input.participantId || qualification.verifiedByPrincipalId !== source.author_id
        || qualification.verifiedByPrincipalId === input.participantId
        || Date.parse(qualification.expiresAt) < Date.parse(input.expiresAt)) throw Error("W3_PROFESSIONAL_QUALIFICATION_SCOPE_REQUIRED");
      qualifications.push(qualification.qualificationId);
    }
    if (criterion.some(c => c.qualificationIds.some(id => !qualifications.includes(id))))
      throw Error("W3_ACTUAL_QUALIFICATION_EVIDENCE_REQUIRED");
    if (input.incentiveRef) await sourceOriginal(ctx, request.work_id, input.incentiveRef, c);
    if (criterion.some(c => c.phase === "TRIAL") && !input.incentiveRef) throw Error("W3_TRIAL_COMPENSATION_BASIS_REQUIRED");
    if (Date.parse(input.expiresAt) <= Date.now() || Date.parse(input.expiresAt) > request.original_deadline.getTime())
      throw Error("W3_PROTOCOL_EXPIRY_OUTSIDE_PARENT");
    const provider = providers.find(p => p.body.providerId === input.providerId);
    const operational = {
      scope: outcome.scope, instance, timeZone: outcome.sites.find(s => s.id === instance.siteId)!.timeZone,
      purpose: outcome.disclosure.purpose, requirements: outcome.disclosure.operationalRequirements,
      criteria: criterion, termsDigest: input.termsDigest, evidenceClass: "CONTROLLED",
      ...(input.role === "PROVIDER" && provider ? { quote: provider.body.quote } : {}),
      limitations: ["Authentication proves authorship, not physical truth.", "Controlled evidence does not establish genuine sensory or field outcomes."],
    };
    const row = (await c.query<{ id: string }>(`INSERT INTO finnor_os.w3_participant_protocols
     (tenant_id,principal_id,request_id,participant_id,instance_id,provider_id,terms_digest,role,
      criterion_ids,permitted_kinds,purpose,operational_disclosure,qualification_refs,incentive_ref,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15) RETURNING id`,
    [ctx.auth.tenantId, principal(ctx), request.id, input.participantId, input.instanceId, input.providerId,
      input.termsDigest, input.role, canonical(input.criterionIds), canonical(input.permittedKinds),
      outcome.disclosure.purpose, canonical(operational), canonical(input.qualificationRefs),
      input.incentiveRef ? canonical(input.incentiveRef) : null, input.expiresAt])).rows[0]!;
    return { protocolId: row.id, status: "INVITED_NOT_CONSENTED", compensationEstablished: false, participantClass: "CONTROLLED" };
  });
}
async function currentParticipant(ctx: PeMutationContext, id: string, c: PoolClient, consentRequired = true) {
  const protocol = (await c.query<ParticipantProtocol>(`SELECT p.* FROM finnor_os.w3_participant_protocols p
   JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.participant_id
   WHERE p.tenant_id=$1 AND p.id=$2 AND p.participant_id=$3 AND u.status='active' FOR SHARE OF u`,
  [ctx.auth.tenantId, id, principal(ctx)])).rows[0];
  if (!protocol || protocol.revoked_at || protocol.expires_at.getTime() <= Date.now()
    || consentRequired && !protocol.consent_at) throw unavailable();
  return protocol;
}
export async function readParticipantInbox(ctx: PeMutationContext) {
  return serviceTx(ctx, async c => {
    const rows = (await c.query<ParticipantProtocol>(`SELECT p.* FROM finnor_os.w3_participant_protocols p
     JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.participant_id
     WHERE p.tenant_id=$1 AND p.participant_id=$2 AND u.status='active' ORDER BY p.created_at DESC LIMIT 257`,
    [ctx.auth.tenantId, principal(ctx)])).rows;
    if (rows.length > 256) throw Error("W3_INBOX_BOUND_INCOMPLETE");
    const now = Date.now();
    return { protocols: rows.map(p => {
      const status = p.revoked_at ? "REVOKED" : p.expires_at.getTime() <= now ? "EXPIRED"
        : p.consent_at ? "CONSENTED" : "INVITED";
      const current = status === "INVITED" || status === "CONSENTED";
      return {
        id: p.id, requestId: p.request_id, role: p.role, purpose: p.purpose, status,
        disclosure: current ? p.operational_disclosure : null,
        permittedKinds: current ? p.permitted_kinds : [], criteria: current ? p.criterion_ids : [],
        consentAt: p.consent_at, revokedAt: p.revoked_at, expiresAt: p.expires_at, evidenceClass: "CONTROLLED",
      };
    }), scope: { tenantId: ctx.auth.tenantId, principalId: principal(ctx) }, complete: true };
  }, true);
}
export async function setServiceConsent(ctx: PeMutationContext, raw: unknown) {
  const input = z.object({ protocolId: z.string().uuid(), revoke: z.boolean() }).strict().parse(raw);
  return serviceTx(ctx, async c => {
    await currentParticipant(ctx, input.protocolId, c, false);
    await c.query("SELECT finnor_os.w3_participant_consent($1,$2)", [input.protocolId, input.revoke]);
    return { status: input.revoke ? "REVOKED" : "CONSENTED", authoredByAuthenticatedParticipant: true };
  });
}
export async function submitServiceObservation(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = ReportSchema.parse(raw), body = ObservationSchema.parse(input.observation);
  return serviceTx(ctx, async (c, db) => {
    const protocol = await currentParticipant(ctx, input.protocolId, c);
    const scope = ScopeSchema.parse(protocol.operational_disclosure.scope);
    if (canonical(body.scope) !== canonical(scope) || body.instanceId !== protocol.instance_id
      || body.providerId !== protocol.provider_id || body.termsDigest !== protocol.terms_digest
      || !protocol.permitted_kinds.includes(body.kind) || !allowedKinds[protocol.role].includes(body.kind))
      throw Error("W3_REPORT_ORIGINAL_PROTOCOL_TERMS_OR_ROLE_MISMATCH");
    if (Date.parse(body.at) > serviceNow()) throw Error("W3_FUTURE_OBSERVATION_FORBIDDEN");
    if (body.kind === "OBSERVATION" && !protocol.criterion_ids.includes(body.criterionId))
      throw Error("W3_REPORT_CRITERION_NOT_PERMITTED");
    if (body.kind === "QUOTE" || body.kind === "ACCEPTED") {
      const quote = z.object({ revision: z.string() }).passthrough().parse(protocol.operational_disclosure.quote);
      if (body.quoteRevision !== quote.revision) throw Error("W3_CURRENT_QUOTE_REVISION_REQUIRED");
    }
    for (const ref of body.basis) await sourceOriginal(ctx, scope.workId, ref, c, false);
    const reportDigest = hash(body);
    const old = (await c.query<{ source_id: string; version_id: string; content_digest: string; body_digest: string }>(`SELECT *
     FROM finnor_os.w3_observation_links WHERE tenant_id=$1 AND protocol_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId, protocol.id, input.idempotencyKey])).rows[0];
    if (old) {
      if (old.body_digest !== reportDigest) throw Error("W3_OBSERVATION_IDEMPOTENCY_CONFLICT");
      return { source: { sourceId: old.source_id, versionId: old.version_id, contentDigest: old.content_digest },
        status: "REPORTED_NOT_INDEPENDENT_PHYSICAL_TRUTH", semanticReplay: true, evidenceClass: "CONTROLLED" };
    }
    const count = (await c.query<{ n: number }>("SELECT count(*)::int n FROM finnor_os.w3_observation_links WHERE tenant_id=$1 AND request_id=$2",
      [ctx.auth.tenantId, protocol.request_id])).rows[0]?.n ?? 0;
    if (count >= 50000) throw Error("W3_OBSERVATION_BOUND_INCOMPLETE");
    const source = await persistServiceSource(ctx, {
      workId: scope.workId, ownerId: protocol.principal_id, protocolId: protocol.id,
      idempotencyKey: "report:" + input.idempotencyKey, purpose: protocol.purpose, body, private: true,
    }, c, db);
    await c.query(`INSERT INTO finnor_os.w3_observation_links
     (tenant_id,principal_id,request_id,protocol_id,source_id,version_id,content_digest,author_id,idempotency_key,body_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.auth.tenantId, protocol.principal_id, protocol.request_id, protocol.id, source.sourceId, source.versionId,
      source.contentDigest, principal(ctx), input.idempotencyKey, reportDigest]);
    await c.query("SELECT finnor_os.w3_wake_from_source($1,$2,$3,$4,false)",
      [protocol.id, source.sourceId, source.versionId, source.contentDigest]);
    return { source, status: "REPORTED_NOT_INDEPENDENT_PHYSICAL_TRUTH", semanticReplay: false, evidenceClass: "CONTROLLED" };
  });
}
export async function observationOriginals(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient): Promise<ObservationOriginal[]> {
  const links = (await c.query<{
    source_id: string; version_id: string; content_digest: string; author_id: string; role: ObservationOriginal["role"];
    consent_at: Date | null; revoked_at: Date | null; expires_at: Date; qualification_refs: SourceRef[];
    created_at: Date; reporter_status: string;
  }>(`SELECT l.*,p.role,p.consent_at,p.revoked_at,p.expires_at,p.qualification_refs,u.status reporter_status
   FROM finnor_os.w3_observation_links l JOIN finnor_os.w3_participant_protocols p
    ON p.tenant_id=l.tenant_id AND p.id=l.protocol_id
   JOIN finnor_os.users u ON u.tenant_id=l.tenant_id AND u.id=l.author_id
   WHERE l.tenant_id=$1 AND l.request_id=$2 ORDER BY l.created_at,l.source_id LIMIT 50001 FOR SHARE OF p,u`,
  [row.tenant_id, row.id])).rows;
  if (links.length > 50000) throw Error("W3_OBSERVATION_BOUND_INCOMPLETE");
  const refs = links.map(link => ({ sourceId: link.source_id, versionId: link.version_id, contentDigest: link.content_digest }));
  const sources = await sourceOriginals(ctx, row.work_id, refs, c, false);
  const result: ObservationOriginal[] = [], qualificationsByRef = new Map<string, ReturnType<typeof sourceOriginal>>();
  for (const [index, link] of links.entries()) {
    const ref = refs[index]!, source = sources[index]!;
    const qualifications: string[] = [];
    for (const q of link.qualification_refs) {
      try {
        const key = canonical(q);
        let pending = qualificationsByRef.get(key);
        if (!pending) {
          pending = sourceOriginal(ctx, row.work_id, q, c);
          qualificationsByRef.set(key, pending);
        }
        const original = await pending;
        const qualification = QualificationSchema.parse(JSON.parse(original.content));
        if (qualification.subjectPrincipalId === link.author_id && qualification.verifiedByPrincipalId === original.author_id
          && original.author_id !== link.author_id && qualification.scope.workId === row.work_id
          && Date.parse(qualification.expiresAt) > Date.now())
          qualifications.push(qualification.qualificationId);
      } catch { /* Revocation removes this evidence, not unrelated services or historical liabilities. */ }
    }
    result.push({ ref, body: ObservationSchema.parse(JSON.parse(source.content)), authorId: link.author_id,
      classification: source.evidence_class, role: link.role,
      consentCurrent: link.reporter_status === "active" && !!link.consent_at && !link.revoked_at && link.expires_at.getTime() > Date.now(),
      qualificationIds: qualifications, receivedAt: link.created_at.toISOString() });
  }
  return result;
}
