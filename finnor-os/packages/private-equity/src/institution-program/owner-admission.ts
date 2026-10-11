import { createHash } from "node:crypto";
import { attachWorkEntityTx, withTenantTransaction } from "@finnor/db";
import { appendDocumentVersion, createDocument, loadDocumentVersion } from "@finnor/data-platform";
import { appendEvidenceVersionTx, createEvidenceSourceTx } from "@finnor/memory";
import { attachEvidenceTx, lockPeDeal, peTransaction, requireActivePeDeal } from "../repository";
import { authorizeBeliefResources, authorizeBeliefCandidateCut } from "../enterprise-beliefs";
import { loadPrivateEquityWorldState } from "../world-state";
import { recordPrivateEquitySourceObservation } from "../source-mapping";
import type { PeMutationContext } from "../types";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type InstitutionCheck, type OriginalInstitutionEvidence } from "./checker";
import { originalRawRecords } from "./checker-raw";
import type { DigitalInstitutionProfile } from "./contracts";

type Source = OriginalInstitutionEvidence["sources"][number];
export type RetainedOriginalSource = Source & {
  coreDocumentId: string;
  coreVersionId: string;
  originalSha256: string;
};
type OwnerSourceInput = Omit<Source, "rawUtf8" | "rawBase64"> & {
  bytes: Buffer;
  mediaType: string;
};
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Core owns original binary bytes and immutable versions. This function is
 * for a previously authorized file/export or installed readback owner; it
 * neither downloads arbitrary URLs nor grants source/consent permissions. */
export async function retainInstitutionSource(
  ctx: PeMutationContext, workId: string, source: OwnerSourceInput,
  profile: DigitalInstitutionProfile,
): Promise<RetainedOriginalSource> {
  // A submitted consent reference cannot prove a current subject-bound owner grant.
  if (["personnel_benefits", "expense_administration"].includes(source.sourceClass)) {
    throw new Error("X1_SENSITIVE_CONSENT_OWNER_VERIFICATION_REQUIRED");
  }
  if (source.tenantId !== ctx.auth.tenantId || source.bytes.length === 0
      || source.bytes.length > profile.bounds.objectBytes
      || !source.authorizedPrincipalIds.includes(ctx.auth.employeeId ?? ctx.auth.userId)
      || !profile.sourceClasses.find((entry) => entry.id === source.sourceClass)?.protocols.includes(source.protocol)) {
    throw new Error("X1_ORIGINAL_SOURCE_ACCESS_OR_PROFILE_REFUSED");
  }
  await authorizeBeliefResources(ctx, [{ type: "tenant", id: ctx.auth.tenantId }, { type: "work", id: workId }]);
  const binary = ["pdf_text", "docx", "xlsx"].includes(source.protocol);
  const rawUtf8 = binary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
  const { bytes, mediaType, ...metadata } = source;
  const digest = sha(bytes);
  const { documentId, versionId } = await withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId, isolation: "serializable",
  }, async (db, client) => {
    const work = await client.query("SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2::uuid", [ctx.auth.tenantId, workId]);
    if (!work.rows[0]) throw new Error("X1_WORK_NOT_AUTHORIZED");
    const document = await createDocument(db, {
      tenantId: ctx.auth.tenantId, kind: "institution_original_source", title: `${source.sourceClass}/${source.id}`,
      provenance: { sourceSystem: "x1-authorized-source", externalId: source.id,
        createdBy: ctx.auth.employeeId ?? ctx.auth.userId },
    });
    const version = await appendDocumentVersion(db, {
      tenantId: ctx.auth.tenantId, documentId: document.documentId, bytes,
      mediaType, format: source.protocol === "docx" ? "docx" : source.protocol === "xlsx" ? "xlsx"
        : source.protocol === "pdf_text" ? "pdf" : "unknown",
      origin: "manual_upload", actor: ctx.auth.employeeId ?? ctx.auth.userId,
      sourceSystem: "x1-authorized-source", sourceRef: source.id,
      providerVersionId: source.revision,
    });
    return { documentId: document.documentId, versionId: version.id };
  });
  return { ...metadata, rawUtf8, ...(binary ? { rawBase64: bytes.toString("base64") } : {}),
    coreDocumentId: documentId, coreVersionId: versionId, originalSha256: digest };
}

/** Rehydrates from immutable Core bytes instead of trusting a submitted
 * candidate's raw evidence or its asserted canonical references. */
async function rereadSources(ctx: PeMutationContext, sources: RetainedOriginalSource[]): Promise<Source[]> {
  return withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true, isolation: "repeatable read" }, async (db) => {
    const restored: Source[] = [];
    for (const source of sources) {
      const version = await loadDocumentVersion(db, ctx.auth.tenantId, source.coreDocumentId, source.coreVersionId);
      if (!version || version.version.byte_sha256 !== source.originalSha256
          || sha(version.bytes) !== source.originalSha256
          || version.version.source_ref !== source.id || version.version.provider_version_id !== source.revision) {
        throw new Error("X1_ORIGINAL_BYTES_OR_REVISION_MISMATCH");
      }
      const { coreDocumentId: _document, coreVersionId: _version, originalSha256: _digest,
        rawUtf8: _claimed, rawBase64: _claimedBinary, ...metadata } = source;
      const binary = ["pdf_text", "docx", "xlsx"].includes(source.protocol);
      restored.push({ ...metadata, rawUtf8: binary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(version.bytes),
        ...(binary ? { rawBase64: version.bytes.toString("base64") } : {}) });
    }
    return restored;
  });
}

/** Exact existing Deal identities only. The PE createDeal owner requires a
 * target, employee, signed LOI and dates; an ungrounded raw name cannot mint
 * these fields. Unmatched entities remain explicit unresolved alternatives. */
export async function loadInstitutionCanonicalOwnerSnapshot(
  ctx: PeMutationContext, original: OriginalInstitutionEvidence, profile: DigitalInstitutionProfile,
): Promise<Pick<OriginalInstitutionEvidence, "canonical"> & { rightsRevision: string }> {
  await authorizeBeliefResources(ctx, [{ type: "tenant", id: ctx.auth.tenantId }]);
  await authorizeBeliefCandidateCut(ctx);
  const identifiers = new Set<string>();
  for (const source of original.sources) {
    const rows = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
    for (const row of rows) if (row.registrationId) identifiers.add(row.registrationId);
  }
  if (identifiers.size > profile.bounds.canonicalReferences) throw new Error("X1_CANONICAL_REFERENCE_BOUND");
  const matches = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId,
    readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const result = await client.query<{ id: string; external_id: string }>(
      `SELECT id::text,external_id FROM finnor_os.pe_deals
        WHERE tenant_id=$1 AND external_id=ANY($2::text[]) AND archived_at IS NULL
        ORDER BY external_id,id LIMIT $3`,
      [ctx.auth.tenantId, [...identifiers], profile.bounds.deals + 1]);
    return result.rows;
  });
  if (matches.length > profile.bounds.deals) throw new Error("X1_DEAL_BOUND");
  const entities: OriginalInstitutionEvidence["canonical"]["entities"] = [];
  const revisions: string[] = [];
  let rightsRevision = "";
  for (const deal of matches) {
    const world = await loadPrivateEquityWorldState(ctx, { entityType: "pe_deal", entityId: deal.id });
    const owner = world.provenance.find((item) => item.entityType === "pe_deal" && item.entityId === deal.id);
    if (!owner || world.deal?.externalId !== deal.external_id || !world.beliefView) {
      throw new Error("X1_CANONICAL_OWNER_SNAPSHOT_UNAVAILABLE");
    }
    const rights = String(world.beliefView.rights.revision);
    if (rightsRevision && rightsRevision !== rights) throw new Error("X1_RIGHTS_CHANGED_DURING_CANONICAL_READ");
    rightsRevision = rights;
    revisions.push(`${owner.entityId}:${owner.entityVersion}:${owner.snapshotHash}`);
    entities.push({ ref: `pe_deal:${deal.id}@v${owner.entityVersion}`, entityType: "deal",
      registrationId: deal.external_id, institutionId: original.institutionId });
  }
  if (!rightsRevision) {
    rightsRevision = String((await authorizeBeliefResources(ctx, [{ type: "tenant", id: ctx.auth.tenantId }])).revision);
  }
  return { canonical: { tenantId: ctx.auth.tenantId, revision: sha(revisions.sort().join("|")), entities },
    rightsRevision };
}

export interface AcceptedInstitutionMappingRef {
  sourceId: string; recordId: string; canonicalRef: string; originalDocumentVersionId: string;
  evidenceSourceId: string; evidenceVersionId: string; evidenceLinkId: string;
  sourceTruthLinkId: string | null;
  disposition: "SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH";
}

/** Separate checker acceptance is rederived from owner bytes/snapshot. No
 * producer-issued check, inferred norm or direct canonical row write is used. */
export async function admitCheckedInstitutionMappings(
  ctx: PeMutationContext, original: OriginalInstitutionEvidence,
  retained: RetainedOriginalSource[], candidate: InstitutionCandidate,
  acceptedCheck: InstitutionCheck, profile: DigitalInstitutionProfile,
): Promise<AcceptedInstitutionMappingRef[]> {
  if (retained.some((source) => ["personnel_benefits", "expense_administration"].includes(source.sourceClass))) {
    throw new Error("X1_SENSITIVE_CONSENT_OWNER_VERIFICATION_REQUIRED");
  }
  if (original.tenantId !== ctx.auth.tenantId || original.principalId !== (ctx.auth.employeeId ?? ctx.auth.userId)
      || retained.length !== original.sources.length || candidate.unresolved?.length
      || acceptedCheck.disposition !== "ACCEPTED_DEVELOPMENT") throw new Error("X1_ADMISSION_NOT_CURRENT_OR_UNRESOLVED");
  const sources = await rereadSources(ctx, retained);
  const owner = await loadInstitutionCanonicalOwnerSnapshot(ctx, { ...original, sources }, profile);
  const independent: OriginalInstitutionEvidence = {
    ...original, sources, canonical: owner.canonical,
    current: { ...original.current, canonicalRevision: owner.canonical.revision, rightsRevision: owner.rightsRevision },
  };
  const check = await independentlyCheckInstitutionModel(independent, candidate, profile);
  if (check.disposition !== "ACCEPTED_DEVELOPMENT"
      || check.inputDigest !== acceptedCheck.inputDigest
      || check.candidateDigest !== acceptedCheck.candidateDigest
      || check.profileDigest !== acceptedCheck.profileDigest
      || check.checkerRevision !== acceptedCheck.checkerRevision) {
    throw new Error("X1_SEPARATE_CHECK_OR_OWNER_CUT_MISMATCH");
  }
  const sourceTruthByMapping = new Map<string, string>();
  // An installed source integration is first observed by the existing Source
  // Truth owner. File/export sources have no fabricated provider integration.
  for (const mapping of candidate.mappings) {
    const source = retained.find((item) => item.id === mapping.sourceId);
    const exact = owner.canonical.entities.find((item) => item.ref === mapping.canonicalRef
      && item.registrationId === mapping.registrationId);
    const dealId = /^pe_deal:([0-9a-f-]{36})@v\d+$/.exec(mapping.canonicalRef)?.[1];
    if (!source || !exact || !dealId) throw new Error("X1_MAPPING_NO_CANONICAL_OWNER_TARGET");
    const integration = [source.integrationId, source.provider, source.sourceScope, source.externalObjectType];
    if (integration.some(Boolean) && !integration.every(Boolean)) throw new Error("X1_PARTIAL_SOURCE_TRUTH_BINDING");
    if (integration.every(Boolean)) {
      const sourceTruth = await recordPrivateEquitySourceObservation(ctx, {
        integrationId: source.integrationId!, provider: source.provider!, sourceScope: source.sourceScope!,
        externalObjectType: source.externalObjectType!, externalId: mapping.recordId,
        dealId, entity: { entityType: "pe_deal", entityId: dealId },
        claims: [{ entity: { entityType: "pe_deal", entityId: dealId }, predicate: "deal.exists", value: true }],
        observedAt: original.knowledgeCut, sourceVersion: source.revision,
        provenance: { originalDocumentId: source.coreDocumentId, originalVersionId: source.coreVersionId,
          originalSha256: source.originalSha256, checkedCandidateDigest: check.candidateDigest },
      });
      if (["out_of_order", "conflict", "ambiguous", "unresolved", "tombstoned"].includes(sourceTruth.materialization.status)) {
        throw new Error(`X1_SOURCE_TRUTH_${sourceTruth.materialization.status.toUpperCase()}`);
      }
      sourceTruthByMapping.set(`${mapping.sourceId}/${mapping.recordId}`, sourceTruth.materialization.sourceLinkId);
    }
  }
  return peTransaction(ctx, async (db, client) => {
    const receipts: AcceptedInstitutionMappingRef[] = [];
    for (const mapping of candidate.mappings) {
      const source = retained.find((item) => item.id === mapping.sourceId)!;
      const dealId = /^pe_deal:([0-9a-f-]{36})@v(\d+)$/.exec(mapping.canonicalRef);
      if (!dealId) throw new Error("X1_MAPPING_NO_CANONICAL_OWNER_TARGET");
      const deal = await lockPeDeal(client, ctx.auth.tenantId, dealId[1]!);
      requireActivePeDeal(deal);
      if (deal.external_id !== mapping.registrationId || Number(deal.version) !== Number(dealId[2])) {
        throw new Error("X1_CANONICAL_DEAL_CHANGED_DURING_ADMISSION");
      }
      const evidence = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
        sourceKey: `x1:${source.coreDocumentId}:${source.coreVersionId}:${mapping.recordId}`,
        sourceType: "x1_original_source_assertion",
        title: `Original ${source.sourceClass} observation ${mapping.recordId}`,
        metadata: { documentId: source.coreDocumentId, documentVersionId: source.coreVersionId,
          originalSha256: source.originalSha256, protocol: source.protocol, sourceRevision: source.revision },
      });
      const version = await appendEvidenceVersionTx(db, ctx.auth.tenantId, evidence.id, {
        content: `Original source assertion ${mapping.recordId}; sha256:${source.originalSha256}`,
        snapshot: { sourceId: source.id, objectId: mapping.recordId,
          documentId: source.coreDocumentId, documentVersionId: source.coreVersionId,
          originalSha256: source.originalSha256, canonicalCandidate: mapping.canonicalRef,
          disposition: "source_assertion_not_settled_truth" },
        asOf: new Date(original.knowledgeCut), retrievedAt: new Date(),
        entityRefs: [{ type: "pe_deal", id: dealId[1]! }],
      });
      const link = await attachEvidenceTx(client, ctx, {
        dealId: dealId[1]!, entity: { entityType: "pe_deal", entityId: dealId[1]! },
        evidenceSourceId: evidence.id, evidenceVersionId: version.versionId, relationship: "supports",
      });
      await attachWorkEntityTx(db, { tenantId: ctx.auth.tenantId, workId: original.workId,
        entity: { entityType: "pe_deal", entityId: dealId[1]!, relationship: "about", source: "x1-checked-source" } });
      receipts.push({ sourceId: source.id, recordId: mapping.recordId, canonicalRef: mapping.canonicalRef,
        originalDocumentVersionId: source.coreVersionId, evidenceSourceId: evidence.id,
        evidenceVersionId: version.versionId, evidenceLinkId: String(link.row.id),
        sourceTruthLinkId: sourceTruthByMapping.get(`${mapping.sourceId}/${mapping.recordId}`) ?? null,
        disposition: "SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH" });
    }
    return receipts;
  });
}
