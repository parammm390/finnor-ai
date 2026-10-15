import { createHash, verify } from "node:crypto";
import { z } from "zod";
import { canExerciseAuthorityTx, evaluateAuthorityTx } from "@finnor/authority";
import { relationshipLock } from "../../authority/src/relationship-policy";
import { appendEvidenceVersionTx, createEvidenceSourceTx } from "@finnor/memory";
import { VReferenceSchema, type AuthorityRequest } from "@finnor/shared-types";
import { assertDependencies, authorize, principal } from "./owner-context";
import { peTransaction, withPeMutationTransaction, attachEvidenceTx } from "./repository";
import { attachInvestmentCaseToPromotedDeal, attachWorkToWorldEntity, promoteOpportunityToDeal } from "./world-repository";
import { ClosingProfileSchema } from "./closing/contracts";
import { currentArtifact } from "./bilateral-opportunities/store";
import { assertDevelopment } from "./bilateral-opportunities/governance";
import { closingCanonical, closingDigest } from "./closing/compiler";
import { PeDomainError, type PeMutationContext } from "./types";

const Id = z.string().uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Time = z.string().datetime({ offset: true });

export const OpportunityHandoffSchema = z.object({
  opportunityId: Id,
  qualifiedOpportunityRef: VReferenceSchema.extend({ owner: z.literal("V1"), id: Id, revision: z.literal("1") }),
  expectedOpportunityVersion: z.number().int().positive().max(2147483647),
  workId: Id,
  expectedWorkInputId: Id,
  investmentCaseId: Id,
  expectedInvestmentCaseVersion: z.number().int().positive().max(2147483647),
  profileId: z.string().min(1).max(160),
  expectedProfileDigest: Digest,
  deal: z.object({
    id: Id, name: z.string().min(1).max(200), codeName: z.string().max(200).optional(),
    dealLeadEmployeeId: Id, targetClosingAt: Time,
  }).strict(),
  loi: z.object({ documentId: Id, documentDigest: Digest, signedAt: Time }).strict(),
  attestation: z.object({
    schema: z.literal("finnor.signed-loi-attestation.v1"),
    purpose: z.literal("SIGNED_LOI_PROMOTION"),
    environment: z.literal("DEVELOPMENT"),
    tenantId: Id, requestDigest: Digest,
    issuerId: z.string().min(1).max(160), actorId: Id,
    professionalScope: z.literal("signed-loi"),
    channel: z.string().min(1).max(160),
    status: z.literal("CONFIRMED"),
    observedAt: Time, validUntil: Time,
    signature: z.string().min(1).max(4096),
  }).strict(),
}).strict();

function refuse(code: string): never {
  throw new PeDomainError(code, "The exact independently attested Opportunity handoff is unavailable");
}

/** Record a DEVELOPMENT handoff, not legal qualification or LIVE admission.
 * The trusted profile must already explicitly support signed-loi attestations. */
export async function promoteAttestedOpportunity(ctx: PeMutationContext, value: unknown) {
  const input = OpportunityHandoffSchema.parse(value);
  let target: URL;
  try {
    assertDevelopment();
    target = new URL(process.env.DATABASE_URL ?? "");
  } catch { refuse("PE_HANDOFF_DISPOSABLE_DEVELOPMENT_ONLY"); }
  if (process.env.FINNOR_ENVIRONMENT === "production"
      || !["postgres:", "postgresql:"].includes(target.protocol)
      || !["127.0.0.1", "[::1]"].includes(target.hostname)) {
    refuse("PE_HANDOFF_DISPOSABLE_DEVELOPMENT_ONLY");
  }
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) refuse("PE_HANDOFF_AUTHORITY_NOT_GRANTED");
  if (ctx.provenance?.sourceSystem === "@finnor/plugin-private-equity") {
    refuse("PE_HANDOFF_NATIVE_DISPATCH_UNSUPPORTED");
  }
  const { attestation, ...request } = input;
  const requestDigest = closingDigest(request);
  if (attestation.tenantId !== ctx.auth.tenantId || attestation.requestDigest !== requestDigest
      || attestation.actorId === principal(ctx)) refuse("PE_HANDOFF_INDEPENDENT_EXACT_ATTESTATION_REQUIRED");
  const receiptDigest = closingDigest(input);
  const handoffCtx: PeMutationContext = { ...ctx, provenance: {
    sourceSystem: "@finnor/private-equity:signed-loi-handoff",
    externalId: receiptDigest, createdBy: principal(ctx),
  } };
  const authorityRequest: AuthorityRequest = {
    operation: "action", capability: "private_equity:promote_opportunity",
    resource: { type: "pe_opportunity", id: input.opportunityId },
    risk: "high", workId: input.workId,
  };
  return withPeMutationTransaction(handoffCtx, () => peTransaction(handoffCtx, async (db, client) => {
    await relationshipLock(client, ctx.auth.tenantId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.auth.tenantId]);
    // Profile writes already take this native fence. App has SELECT-only profile
    // custody, so a FOR SHARE row lock would incorrectly require UPDATE rights.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["v3-material-cut:" + ctx.auth.tenantId]);
    const root = { entityType: "pe_opportunity" as const, entityId: input.opportunityId };
    await authorize(handoffCtx, root, [
      { type: "work", id: input.workId },
      { type: "pe_investment_case", id: input.investmentCaseId },
      { type: "document", id: input.loi.documentId },
    ], [], client);
    const authority = await evaluateAuthorityTx(ctx.auth, authorityRequest, client).catch(error => {
      if (error instanceof Error && error.message === "CURRENT_CANONICAL_AUTHORITY_UNAVAILABLE") {
        refuse("PE_HANDOFF_AUTHORITY_NOT_GRANTED");
      }
      throw error;
    });
    if (authority.outcome !== "allowed") refuse("PE_HANDOFF_AUTHORITY_NOT_GRANTED");
    const work = (await client.query(
      "SELECT status,coalesce(current_owner_id,created_by)::text AS principal_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.workId],
    )).rows[0];
    const latest = (await client.query(
      "SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.auth.tenantId, input.workId],
    )).rows[0];
    const loop = (await client.query(
      "SELECT deadline_at FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2 FOR SHARE",
      [ctx.auth.tenantId, input.workId],
    )).rows[0];
    const deadline = loop?.deadline_at == null ? NaN : new Date(loop.deadline_at).getTime();
    if (!work || work.principal_id !== principal(ctx) || ["completed", "failed", "cancelled"].includes(work.status)
        || latest?.id !== input.expectedWorkInputId || !Number.isFinite(deadline) || deadline <= Date.now()) {
      refuse("PE_HANDOFF_CURRENT_ORIGINAL_WORK_REQUIRED");
    }
    const anchor = (await client.query(
      "SELECT 1 FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 AND entity_type='pe_opportunity' AND entity_id=$3",
      [ctx.auth.tenantId, input.workId, input.opportunityId],
    )).rowCount;
    if (!anchor) refuse("PE_HANDOFF_ORIGINAL_OPPORTUNITY_ANCHOR_REQUIRED");

    const row = (await client.query(
      "SELECT body,digest,status,valid_until FROM finnor_os.pe_closing_profiles WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, input.profileId],
    )).rows[0];
    const profileUntil = row ? new Date(row.valid_until).getTime() : NaN;
    if (!row || row.status !== "ACTIVE" || row.digest !== input.expectedProfileDigest
        || !Number.isFinite(profileUntil) || profileUntil <= Date.now()) refuse("PE_HANDOFF_PROFILE_UNAVAILABLE");
    const profile = ClosingProfileSchema.parse(row.body);
    const { admission: _admission, ...preimage } = profile;
    if (profile.environment !== "DEVELOPMENT" || closingDigest(preimage) !== row.digest) refuse("PE_HANDOFF_PROFILE_CHANGED");
    const issuer = profile.issuers.find(candidate => candidate.id === attestation.issuerId);
    const observed = Date.parse(attestation.observedAt), now = Date.now();
    if (!issuer || issuer.status !== "ACTIVE" || issuer.actorId !== attestation.actorId
        || issuer.environment !== "DEVELOPMENT" || !issuer.kinds.includes("DOCUMENT_EXECUTION")
        || !issuer.qualifiedScopes.includes("signed-loi") || !issuer.channels.includes(attestation.channel)
        || Date.parse(issuer.validUntil) <= now || Date.parse(attestation.validUntil) <= now
        || observed > now || Date.parse(input.loi.signedAt) > observed
        || Date.parse(input.deal.targetClosingAt) <= Date.parse(input.loi.signedAt)) {
      refuse("PE_HANDOFF_SIGNER_SCOPE_TIME_OR_PURPOSE_INVALID");
    }
    const signer = (await client.query(
      "SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.auth.tenantId, attestation.actorId],
    )).rowCount;
    const { signature, ...signedBody } = attestation;
    let valid = false;
    try {
      valid = verify(null, Buffer.from(closingCanonical(signedBody)), issuer.publicKeyPem, Buffer.from(signature, "base64"));
    } catch { /* Invalid keys and signatures fail closed. */ }
    if (!signer || !valid) refuse("PE_HANDOFF_SIGNED_LOI_ATTESTATION_INVALID");

    const document = (await client.query<{ bytes: Buffer | null; size_bytes: number }>(
      `SELECT CASE WHEN octet_length(c.bytes) BETWEEN 1 AND 8388608 THEN c.bytes END AS bytes,c.size_bytes
       FROM finnor_os.documents d JOIN finnor_os.document_contents c ON c.document_id=d.id AND c.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL FOR SHARE OF d,c`,
      [ctx.auth.tenantId, input.loi.documentId],
    )).rows[0];
    if (!document?.bytes || document.bytes.length !== document.size_bytes
        || createHash("sha256").update(document.bytes).digest("hex") !== input.loi.documentDigest) {
      refuse("PE_HANDOFF_EXACT_RETAINED_DOCUMENT_REQUIRED");
    }
    const qualified = await currentArtifact(handoffCtx, input.qualifiedOpportunityRef, client).catch(error => {
      if (error instanceof Error && /^[A-Z][A-Z0-9_:]{0,159}$/.test(error.message)) {
        refuse("PE_HANDOFF_ORIGINAL_QUALIFIED_OPPORTUNITY_REQUIRED");
      }
      throw error; // Preserve SQL serialization/deadlock failures for the owner retry.
    });
    if (qualified.artifact.opportunityId !== input.opportunityId
        || qualified.artifact.workRef !== input.workId
        || qualified.artifact.workRevision !== input.expectedWorkInputId
        || qualified.artifact.environment !== "DEVELOPMENT") {
      refuse("PE_HANDOFF_ORIGINAL_QUALIFIED_OPPORTUNITY_REQUIRED");
    }
    const intake = qualified.programme.intake;
    const governanceRefs = [intake.mandateRef, intake.authorityProfileRef, intake.domainProfileRef,
      intake.budgetGrantRef, intake.sourceProfileRef, intake.relationshipPolicyRef];
    const governanceIds = [...new Set(governanceRefs.map(ref => ref.id))];
    const governance = (await client.query<{ id: string; revision: number; digest: string; body: Record<string, unknown> }>(
      `SELECT h.id,h.revision,v.digest,v.body FROM finnor_os.primary_governance_heads h
       JOIN finnor_os.primary_governance_versions v USING(tenant_id,id,revision)
       WHERE h.tenant_id=$1 AND h.id=ANY($2::uuid[]) AND h.state='CURRENT'
       ORDER BY h.id FOR SHARE OF h`,
      [ctx.auth.tenantId, governanceIds],
    )).rows;
    if (governance.length !== governanceIds.length || governanceRefs.some(ref =>
      !governance.some(record => record.id === ref.id && String(record.revision) === ref.revision
        && record.digest === ref.contentDigest))) refuse("PE_HANDOFF_NATIVE_QUALIFICATION_REVISED");
    await assertDependencies(handoffCtx, [
      ...qualified.artifact.invalidationDependencies,
      ...(qualified.programme.frozen_manifest?.dependencies ?? []),
    ].map(dependency => ({ ...dependency, nodeIds: [], digest: null })), client, true);
    const nativeDeadlines = governance.flatMap(({ body }) =>
      ["deadline", "expiresAt", "originalProgrammeDeadline", "retentionUntil", "validUntil"]
        .flatMap(key => {
          const time = body[key];
          return typeof time === "string" ? [Date.parse(time)] : [];
        }));
    const prior = (await client.query(
      "SELECT id,source_system,external_id FROM finnor_os.pe_deals WHERE tenant_id=$1 AND opportunity_id=$2 FOR UPDATE",
      [ctx.auth.tenantId, input.opportunityId],
    )).rows[0];
    if (prior && (prior.id !== input.deal.id || prior.source_system !== handoffCtx.provenance!.sourceSystem
        || prior.external_id !== receiptDigest)) refuse("PE_HANDOFF_PROMOTION_REPLAY_CONFLICT");
    const promoted = await promoteOpportunityToDeal(handoffCtx, {
      opportunityId: input.opportunityId, expectedVersion: input.expectedOpportunityVersion,
      deal: { ...input.deal, targetClosingAt: new Date(input.deal.targetClosingAt),
        signedLoiAt: new Date(input.loi.signedAt), signedLoiDocumentId: input.loi.documentId },
    });
    const investmentCase = await attachInvestmentCaseToPromotedDeal(handoffCtx, {
      investmentCaseId: input.investmentCaseId, dealId: input.deal.id,
      expectedVersion: input.expectedInvestmentCaseVersion,
    });
    const source = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
      sourceKey: `signed-loi-handoff:${input.deal.id}`, sourceType: "independently_signed_loi_handoff",
      title: "Development signed-LOI handoff",
      metadata: { requestDigest, receiptDigest, profileDigest: row.digest },
    });
    const evidence = await appendEvidenceVersionTx(db, ctx.auth.tenantId, source.id, {
      content: closingCanonical(input), snapshot: { signedLoiHandoff: input },
      asOf: new Date(attestation.observedAt),
      entityRefs: [{ type: "pe_deal", id: input.deal.id }, { type: "pe_opportunity", id: input.opportunityId }],
    });
    await attachEvidenceTx(client, handoffCtx, {
      dealId: input.deal.id, entity: { entityType: "pe_deal", entityId: input.deal.id },
      evidenceSourceId: source.id, evidenceVersionId: evidence.versionId, relationship: "supports",
    });
    await attachWorkToWorldEntity(handoffCtx, {
      workId: input.workId, entity: { entityType: "pe_deal", entityId: input.deal.id, relationship: "target" },
    });
    if (!await canExerciseAuthorityTx(ctx.auth, authorityRequest, client)
        || Math.min(deadline, profileUntil, Date.parse(issuer.validUntil), Date.parse(attestation.validUntil),
          Date.parse(qualified.artifact.validityAndExpiry.expiresAt), ...nativeDeadlines) <= Date.now()
        || nativeDeadlines.some(time => !Number.isFinite(time))) {
      refuse("PE_HANDOFF_ORIGINAL_AUTHORITY_EXPIRED");
    }
    return { ...promoted, investmentCase: investmentCase.row, workId: input.workId,
      workInputId: input.expectedWorkInputId, evidence, receiptDigest,
      environment: "DEVELOPMENT", liveAdmissionGranted: false, financingOrSettlementAuthorityGranted: false };
  // Re-read after waiting for material fences. A pre-fence SERIALIZABLE snapshot
  // could otherwise retain a profile revoked before this transaction got the lock.
  }), { isolation: "read committed" }).catch(error => {
    if (error instanceof PeDomainError && error.code === "PE_STALE_VERSION") {
      refuse("PE_HANDOFF_CANONICAL_REVISION_REVISED");
    }
    throw error;
  });
}
