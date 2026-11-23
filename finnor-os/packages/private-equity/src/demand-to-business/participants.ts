import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { principal, unavailable } from "../owner-context";
import { readStoredEconomicRecord } from "../economic-store";
import { canonical, hash, same, sameScope, eventSchema, scopeSchema, sourceRefSchema, W4_BOUNDS,
  type CommercialEvent, type EventOriginal, type GrowthScope, type NativeRef, type ParticipantRole, type SourceRef } from "./contracts";
import { growthOperationSchemas, growthEvidenceSchema, inviteGrowthSchema, reportGrowthSchema,
  growthProgressOriginalSchema } from "./boundaries";
import { requireGrowthProfile, growthNow } from "./identity";
import { growthTx, growthRequest, authorizeGrowthWork, currentGrowthCut, growthArtifact, loadGrowthInput,
  growthSourceOriginal, growthSourceOriginals, persistGrowthSource, lockGrowthParticipant, type GrowthRequestRow } from "./store";

export interface GrowthProtocol {
  id: string; tenant_id: string; principal_id: string; request_id: string | null; work_id: string;
  business_assignment_id: string; participant_id: string; buyer_id: string | null; offer_id: string | null;
  terms_digest: string | null; role: ParticipantRole; permitted_kinds: string[]; purpose: string;
  operational_disclosure: { scope: GrowthScope; evidenceKinds: string[]; [key: string]: unknown };
  expires_at: Date; consent_at: Date | null; revoked_at: Date | null;
}
const roleKinds: Record<ParticipantRole, readonly string[]> = {
  BUYER: ["EVIDENCE", "RESPONSE", "DELIVERY_ACCEPTANCE", "REFUND", "SUPPORT"],
  OPERATOR: ["EVIDENCE", "DELIVERY"],
  ACCOUNTANT: ["EVIDENCE", "COLLECTION", "RECOGNITION", "REFUND", "COST"],
  INDEPENDENT_OBSERVER: ["EVIDENCE", "TEST_CLOSED", "MARKET_CHANGE"],
};
const evidenceKinds: Record<ParticipantRole, readonly string[]> = {
  BUYER: ["CONSENT", "DEMAND"], OPERATOR: ["CAPABILITY"],
  ACCOUNTANT: ["ACCOUNTING_POLICY", "INVOICE", "ACCOUNTING"],
  INDEPENDENT_OBSERVER: ["POPULATION", "TEST_PROTOCOL", "DEMAND"],
};
export async function inviteGrowthParticipant(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = inviteGrowthSchema.parse(raw), scope = input.scope;
  return growthTx(ctx, async c => {
    await authorizeGrowthWork(ctx, scope.workId, c);
    if (scope.tenantId !== ctx.auth.tenantId || scope.principalId !== principal(ctx)
      || input.participantId === principal(ctx) || input.permittedKinds.some(k => !roleKinds[input.role].includes(k))
      || input.evidenceKinds.some(k => !evidenceKinds[input.role].includes(k))
      || new Set(input.permittedKinds).size !== input.permittedKinds.length
      || new Set(input.evidenceKinds).size !== input.evidenceKinds.length) throw Error("W4_PROTOCOL_OUTSIDE_AUTHENTICATED_ROLE");
    if (!(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.auth.tenantId, input.participantId])).rows[0]) throw unavailable();
    if (input.role === "BUYER" && input.buyerId !== input.participantId
      || input.role !== "BUYER" && input.buyerId === input.participantId) throw Error("W4_INDEPENDENT_DUTY_OWNER_REQUIRED");
    if (Date.parse(input.expiresAt) <= Date.now()) throw Error("W4_PROTOCOL_EXPIRY_INVALID");
    let disclosure: Record<string, unknown> = {};
    if (input.requestId) {
      const request = await growthRequest(ctx, input.requestId, c, true);
      const original = await loadGrowthInput(ctx, request, c, false), artifact = await growthArtifact(ctx, request, c);
      if (!sameScope(original.scope, scope) || input.purpose !== original.permittedPurpose || !artifact)
        throw Error("W4_EXACT_ORIGINAL_PROGRAMME_PROTOCOL_REQUIRED");
      const offer = artifact.body.offers.find(o => o.id === input.offerId && o.termsDigest === input.termsDigest);
      const buyer = original.population.find(b => b.buyerId === input.buyerId);
      const globalOnly = input.permittedKinds.every(k => ["EVIDENCE", "COST", "TEST_CLOSED", "MARKET_CHANGE"].includes(k));
      if (!globalOnly && (!offer || !buyer || !artifact.body.assignedExposure.some(a =>
        a.offerId === input.offerId && a.buyerId === input.buyerId && a.termsDigest === input.termsDigest)))
        throw Error("W4_PROTOCOL_EXACT_ASSIGNED_OFFER_TERMS_REQUIRED");
      if (input.role === "OPERATOR" && (!offer || !offer.capabilityIds.some(id =>
        original.capabilities.find(cap => cap.id === id)?.operatorId === input.participantId)))
        throw Error("W4_PROTOCOL_ACTUAL_CAPABILITY_OPERATOR_REQUIRED");
      if (input.role === "INDEPENDENT_OBSERVER" && input.participantId !== original.test.independentObservationOwnerId)
        throw Error("W4_PROTOCOL_INDEPENDENT_OBSERVER_REQUIRED");
      if (input.role === "ACCOUNTANT" && (original.population.some(b => b.buyerId === input.participantId)
        || original.capabilities.some(cap => cap.operatorId === input.participantId)))
        throw Error("W4_ACCOUNTANT_INDEPENDENT_OF_BUYER_AND_OPERATOR_REQUIRED");
      if (input.permittedKinds.includes("RESPONSE")) {
        await currentGrowthCut(ctx, request, c);
        if (Date.parse(input.expiresAt) > Date.parse(original.test.closesAt)) throw Error("W4_BUYER_RESPONSE_WINDOW_OUTSIDE_ORIGINAL");
      }
      const horizon = request.original_deadline.getTime() + 366 * 86400000;
      if (Date.parse(input.expiresAt) > horizon) throw Error("W4_CONTINUING_DUTY_PROTOCOL_HORIZON_EXCEEDED");
      disclosure = { ...(offer ? { offer } : {}), ...(buyer ? { buyerId: buyer.buyerId } : {}),
        originalDeadlineAt: original.originalDeadlineAt, marketRevision: original.marketRevision,
        populationSource: original.test.populationSource, testClosesAt: original.test.closesAt, currency: original.currency };
    } else if (!same(input.permittedKinds, ["EVIDENCE"]) || !input.evidenceKinds.length
      || input.offerId || input.termsDigest) throw Error("W4_PRECOMPILE_PROTOCOL_EVIDENCE_ONLY");
    const operational = { ...disclosure, scope, evidenceKinds: input.evidenceKinds, purpose: input.purpose,
      evidenceClass: "CONTROLLED", limitations: ["Authentication establishes authorship, not physical or market truth.",
        "This protocol grants no Work access, field validation, execution authority, or profit qualification."] };
    if (Buffer.byteLength(canonical(operational)) > 16384) throw Error("W4_PROTOCOL_DISCLOSURE_BYTE_BOUND");
    const row = (await c.query<{ id: string }>(`INSERT INTO finnor_os.w4_participant_protocols
     (tenant_id,principal_id,request_id,work_id,business_assignment_id,participant_id,buyer_id,offer_id,terms_digest,
      role,permitted_kinds,purpose,operational_disclosure,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14) RETURNING id`,
    [ctx.auth.tenantId, principal(ctx), input.requestId, scope.workId, scope.businessAssignmentId, input.participantId,
      input.buyerId, input.offerId, input.termsDigest, input.role, canonical(input.permittedKinds), input.purpose,
      canonical(operational), input.expiresAt])).rows[0]!;
    return { protocolId: row.id, status: "INVITED_NOT_CONSENTED", participantClass: "CONTROLLED" };
  });
}
async function growthParticipant(ctx: PeMutationContext, id: string, c: PoolClient, consent = true) {
  await lockGrowthParticipant(ctx, id, c, consent);
  const p = (await c.query<GrowthProtocol>(`SELECT p.* FROM finnor_os.w4_participant_protocols p
   JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.participant_id
   WHERE p.tenant_id=$1 AND p.id=$2 AND p.participant_id=$3 AND u.status='active'`,
  [ctx.auth.tenantId, id, principal(ctx)])).rows[0];
  if (!p || p.expires_at.getTime() <= Date.now() || consent && (!p.consent_at || p.revoked_at)) throw unavailable();
  return p;
}
export async function growthParticipantInbox(ctx: PeMutationContext) {
  requireGrowthProfile();
  return growthTx(ctx, async c => {
    if (principal(ctx) !== ctx.auth.userId) throw unavailable();
    const rows = (await c.query<GrowthProtocol>(`SELECT p.* FROM finnor_os.w4_participant_protocols p
     JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.participant_id
     WHERE p.tenant_id=$1 AND p.participant_id=$2 AND u.status='active' ORDER BY p.created_at DESC,p.id LIMIT 257`,
    [ctx.auth.tenantId, principal(ctx)])).rows;
    if (rows.length > 256) throw Error("W4_PARTICIPANT_INBOX_BOUND_INCOMPLETE");
    return { protocols: rows.map(p => {
      const status = p.revoked_at ? "REVOKED" : p.expires_at.getTime() <= Date.now() ? "EXPIRED"
        : p.consent_at ? "CONSENTED" : "INVITED";
      const current = status === "INVITED" || status === "CONSENTED";
      return { id: p.id, requestId: p.request_id, role: p.role, status, purpose: p.purpose,
        disclosure: current ? p.operational_disclosure : null, permittedKinds: current ? p.permitted_kinds : [],
        expiresAt: p.expires_at, consentAt: p.consent_at, revokedAt: p.revoked_at, evidenceClass: "CONTROLLED" };
    }), scope: { tenantId: ctx.auth.tenantId, principalId: principal(ctx) }, complete: true };
  }, true);
}
export async function growthParticipantProgress(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas["protocol-progress"].parse(raw);
  return growthTx(ctx, async c => {
    const p = await growthParticipant(ctx, input.protocolId, c);
    const row = (await c.query<{ body: unknown }>("SELECT finnor_os.w4_participant_progress($1) body", [p.id])).rows[0];
    const parsed = growthProgressOriginalSchema.safeParse(row?.body);
    if (!parsed.success) throw unavailable();
    const body = parsed.data, scope = scopeSchema.parse(p.operational_disclosure.scope);
    if (body.protocolId !== p.id || body.participantId !== principal(ctx) || !sameScope(body.scope, scope)
      || Date.parse(body.expiresAt) !== p.expires_at.getTime() || Date.now() >= p.expires_at.getTime()
      || body.events.some(e => hash(e.body) !== e.source.contentDigest || !sameScope(e.body.scope, scope)))
      throw unavailable();
    return { ...body, events: body.events.slice(0, 128), executions: body.executions.slice(0, 64),
      evidence: body.evidence.slice(0, 64), complete: body.events.length <= 128
        && body.executions.length <= 64 && body.evidence.length <= 64,
      qualification: "CONTROLLED_DEVELOPMENT_ONLY", physicalTruthEstablished: false, fieldValidated: false };
  });
}
export async function setGrowthParticipantConsent(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas.consent.parse(raw);
  return growthTx(ctx, async c => {
    const p = await growthParticipant(ctx, input.protocolId, c, false);
    if (p.revoked_at) {
      if (!input.revoke) throw unavailable();
      return { status: "REVOKED", semanticReplay: true };
    }
    await c.query("SELECT finnor_os.w4_participant_change($1,$2,NULL)", [input.protocolId, input.revoke]);
    return { status: input.revoke ? "REVOKED" : "CONSENTED", authoredByAuthenticatedParticipant: true };
  });
}
export async function reportGrowthEvent(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = reportGrowthSchema.parse(raw), body = input.event;
  return growthTx(ctx, async (c, db) => {
    const p = await growthParticipant(ctx, input.protocolId, c), scope = scopeSchema.parse(p.operational_disclosure.scope);
    if (!p.request_id || !sameScope(scope, body.scope) || !p.permitted_kinds.includes(body.kind)
      || !roleKinds[p.role].includes(body.kind) || "buyerId" in body && (body.buyerId !== p.buyer_id
        || body.offerId !== p.offer_id || body.termsDigest !== p.terms_digest))
      throw Error("W4_EVENT_EXACT_AUTHENTICATED_PROTOCOL_REQUIRED");
    if (body.kind === "REFUND" && (body.status === "REQUESTED" ? p.role !== "BUYER" : p.role !== "ACCOUNTANT"))
      throw Error("W4_REFUND_REQUEST_AND_ACCOUNTING_DUTIES_SEPARATE");
    if (Date.parse(body.at) > growthNow() || Date.parse(body.at) < p.consent_at!.getTime()
      || Date.parse(body.at) > Date.now()) throw Error("W4_EVENT_OUTSIDE_AUTHENTICATED_RECEIPT_WINDOW");
    const old = (await c.query<{ source_id: string; version_id: string; content_digest: string; body_digest: string }>(
      `SELECT * FROM finnor_os.w4_event_links WHERE tenant_id=$1 AND protocol_id=$2 AND idempotency_key=$3`,
      [ctx.auth.tenantId, p.id, input.idempotencyKey])).rows[0];
    if (old) {
      if (old.body_digest !== hash(body)) throw Error("W4_EVENT_IDEMPOTENCY_CONFLICT");
      return { source: { sourceId: old.source_id, versionId: old.version_id, contentDigest: old.content_digest },
        status: "REPORTED_NOT_PHYSICAL_OR_MARKET_TRUTH", semanticReplay: true, evidenceClass: "CONTROLLED" };
    }
    const source = await persistGrowthSource(ctx, { workId: scope.workId, ownerId: p.principal_id,
      protocolId: p.id, idempotencyKey: "event:" + input.idempotencyKey, purpose: p.purpose, kind: "EVENT", body }, c, db);
    await c.query(`INSERT INTO finnor_os.w4_event_links
     (tenant_id,principal_id,request_id,protocol_id,source_id,version_id,content_digest,author_id,idempotency_key,body_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.auth.tenantId, p.principal_id, p.request_id, p.id, source.sourceId, source.versionId,
      source.contentDigest, principal(ctx), input.idempotencyKey, hash(body)]);
    await c.query("SELECT finnor_os.w4_participant_change($1,false,$2)", [p.id, source.sourceId]);
    return { source, status: "REPORTED_NOT_PHYSICAL_OR_MARKET_TRUTH", semanticReplay: false, evidenceClass: "CONTROLLED" };
  });
}
export function growthAccountingPayload(event: CommercialEvent) {
  const { accountingRef: ignored, ...payload } = event as CommercialEvent & { accountingRef?: NativeRef | null };
  return payload;
}
async function accountingOriginal(ctx: PeMutationContext, row: GrowthRequestRow, ref: NativeRef,
  event: CommercialEvent, authorId: string, recordedAt: Date, c: PoolClient, kind: "ACCOUNTING" | "INVOICE") {
  let sourceRef: SourceRef;
  if (ref.owner === "S7") {
    const record = await readStoredEconomicRecord(ctx, ref.id);
    if (!same(record.ref, ref) || record.payload.schema !== "finnor.w4.accounting-original.v1")
      throw Error("W4_CANONICAL_ACCOUNTING_ORIGINAL_REQUIRED");
    sourceRef = sourceRefSchema.parse(record.payload.sourceRef);
  } else if (ref.owner === "S1" && ref.version === "evidence-source-version-v1") {
    const link = (await c.query<{ source_id: string; version_id: string; content_digest: string }>(`SELECT *
     FROM finnor_os.w4_original_source_links WHERE tenant_id=$1 AND work_id=$2 AND version_id=$3 AND content_digest=$4`,
    [row.tenant_id, row.work_id, ref.id, ref.contentDigest])).rows[0];
    if (!link) throw Error("W4_CANONICAL_ACCOUNTING_ORIGINAL_REQUIRED");
    sourceRef = { sourceId: link.source_id, versionId: link.version_id, contentDigest: link.content_digest };
  } else throw Error("W4_CANONICAL_ACCOUNTING_OWNER_REQUIRED");
  const original = await growthSourceOriginal(ctx, row.work_id, sourceRef, c, false);
  const evidence = growthEvidenceSchema.parse(JSON.parse(original.content));
  if (!sameScope(evidence.scope, event.scope) || evidence.kind !== kind || original.author_id !== authorId
    || original.created_at.getTime() > recordedAt.getTime()
    || Date.parse(evidence.validFrom) > Date.parse(event.at) || Date.parse(evidence.validUntil) < Date.parse(event.at))
    throw Error("W4_ACCOUNTING_SOURCE_EXACT_AUTHOR_AND_TIME_REQUIRED");
  const expected = kind === "INVOICE" && event.kind === "COLLECTION"
    ? { buyerId: event.buyerId, offerId: event.offerId, termsDigest: event.termsDigest, amount: event.amount }
    : growthAccountingPayload(event);
  if (!same(evidence.data, expected)) throw Error("W4_ACCOUNTING_RECORD_EXACT_TRANSACTION_REQUIRED");
}
export async function growthEventOriginals(ctx: PeMutationContext, row: GrowthRequestRow, c: PoolClient) {
  const links = (await c.query<{ source_id: string; version_id: string; content_digest: string; author_id: string;
    role: ParticipantRole; consent_at: Date | null; revoked_at: Date | null; expires_at: Date;
    created_at: Date; reporter_status: string; body_digest: string }>(`SELECT l.*,p.role,p.consent_at,p.revoked_at,
     p.expires_at,u.status reporter_status FROM finnor_os.w4_event_links l
     JOIN finnor_os.w4_participant_protocols p ON p.tenant_id=l.tenant_id AND p.id=l.protocol_id
     JOIN finnor_os.users u ON u.tenant_id=l.tenant_id AND u.id=l.author_id
     WHERE l.tenant_id=$1 AND l.request_id=$2 ORDER BY l.created_at,l.source_id LIMIT 8193 FOR SHARE OF p,u`,
  [row.tenant_id, row.id])).rows;
  if (links.length > W4_BOUNDS.events) throw Error("W4_EVENT_HISTORY_BOUND_INCOMPLETE");
  const refs = links.map(l => ({ sourceId: l.source_id, versionId: l.version_id, contentDigest: l.content_digest }));
  const sources = await growthSourceOriginals(ctx, row.work_id, refs, c, false);
  const originals: EventOriginal[] = [], gaps: string[] = [];
  for (const [index, l] of links.entries()) {
    const source = sources[index]!, ref = refs[index]!, body = eventSchema.parse(JSON.parse(source.content));
    if (hash(body) !== l.body_digest || source.author_id !== l.author_id) throw Error("W4_EVENT_STORAGE_PREIMAGE_INVALID");
    try {
      if ("accountingRef" in body && body.accountingRef)
        await accountingOriginal(ctx, row, body.accountingRef, body, l.author_id, l.created_at, c, "ACCOUNTING");
      if (body.kind === "COLLECTION")
        await accountingOriginal(ctx, row, body.invoiceRef, body, l.author_id, l.created_at, c, "INVOICE");
    } catch {
      gaps.push("W4_ACCOUNTING_OWNER_ORIGINAL_NOT_VERIFIED:" + ref.sourceId);
      continue;
    }
    const at = Date.parse(body.at), received = l.created_at.getTime();
    const consentValidAtReceipt = !!l.consent_at && l.consent_at.getTime() <= at && at <= received
      && l.expires_at.getTime() > received && (!l.revoked_at || l.revoked_at.getTime() > received);
    originals.push({ ref, body, authorId: l.author_id, role: l.role, receivedAt: l.created_at.toISOString(),
      consentValidAtReceipt, consentCurrent: l.reporter_status === "active" && !!l.consent_at && !l.revoked_at
        && l.expires_at.getTime() > Date.now(), evidenceClass: source.evidence_class });
  }
  return { originals, gaps };
}
