import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attachWorkEntityTx, CURRENT_MIGRATION_HEAD, withTenantTransaction } from "@finnor/db";
import { employeeAuthoritySnapshot, canExerciseAuthority } from "@finnor/authority";
import { loadDocumentVersion, materializeSourceRecord } from "@finnor/data-platform";
import { appendEvidenceVersionTx, createEvidenceSourceTx } from "@finnor/memory";
import { attachEvidenceTx, lockPeDeal, peTransaction, requireActivePeDeal } from "../repository";
import { authorizeBeliefResources, authorizeBeliefCandidateCut } from "../enterprise-beliefs";
import { loadPrivateEquityWorldState } from "../world-state";
import { mapPrivateEquitySourceObservation } from "../source-mapping";
import { createFundTx, createVehicleTx, linkFundVehicleTx } from "../digital-twin";
import { readAllocationSnapshot } from "../allocation-store";
import { deriveInstitutionResponsibilities, verifyInstitutionDutyPopulation } from "./responsibility";
import { PE_ENTITY_TYPES, type PeMutationContext, type PeEntityType } from "../types";
import type { InstitutionCandidate, InstitutionCheck, OriginalInstitutionEvidence } from "./checker";
import { checkInstitutionInSeparateProcessAsync } from "./checker-process";
import { originalRawRecords } from "./checker-raw";
import { proposeInstitutionModel } from "./reconstruction";
import type { DigitalInstitutionProfile } from "./contracts";
import { acquireInstitutionOriginal, readInstitutionMandate, type OwnerOriginal } from "./source-authority";
import { installedInstitutionCompilerIdentity } from "../../../capability-evolution/src/institution-port";
import { readAdditionalInstitutionOwners,parseInstitutionOwnerRef,lockAdditionalInstitutionOwner } from "./canonical-owners";
import { institutionOwnerCutDigest } from "./canonical-json";

type Source = OriginalInstitutionEvidence["sources"][number];
export type RetainedOriginalSource = OwnerOriginal;
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const profilePath = fileURLToPath(new URL("../../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json", import.meta.url));
const checkerPath = fileURLToPath(new URL("./checker.ts", import.meta.url));
const checkerRawPath = fileURLToPath(new URL("./checker-raw.ts", import.meta.url));
const canonicalJsonPath = fileURLToPath(new URL("./canonical-json.ts", import.meta.url));
function checkedDutyDigest(original: OriginalInstitutionEvidence, candidate: InstitutionCandidate,
  check: InstitutionCheck, profile: DigitalInstitutionProfile): string {
  const lowered = deriveInstitutionResponsibilities({
    original, candidate, check, profile,
    admittedCanonicalRefs: original.canonical.entities.map(entity => entity.ref),
    authorizedOperations: original.current.authorizedOperations,
  });
  return verifyInstitutionDutyPopulation(lowered.programme, lowered.responsibilities, lowered.unresolved);
}
function canonicalId(tenant: string, institution: string, kind: string, registration: string): string {
  const value = sha(JSON.stringify([tenant, institution, kind, registration])).slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20)}`;
}

/** Acquisition is authorized by the currently active owner grant, not by
 * caller bytes or source metadata. */
export async function retainInstitutionSource(
  ctx: PeMutationContext, workId: string, grantId: string,
  profile: DigitalInstitutionProfile,
): Promise<RetainedOriginalSource> {
  return acquireInstitutionOriginal(ctx, workId, grantId, profile);
}

/** Rehydrates from immutable Core bytes instead of trusting a submitted
 * candidate's raw evidence or its asserted canonical references. */
async function rereadSources(
  ctx: PeMutationContext, workId: string, sources: RetainedOriginalSource[], profile: DigitalInstitutionProfile,
): Promise<RetainedOriginalSource[]> {
  const restored: RetainedOriginalSource[] = [];
  for (const source of sources) {
    const current = await acquireInstitutionOriginal(ctx, workId, source.grantId, profile);
    if (current.originalSha256 !== source.originalSha256
        || current.coreVersionId !== source.coreVersionId || current.grantVersion !== source.grantVersion) {
      throw new Error("X1_ORIGINAL_BYTES_OR_REVISION_MISMATCH");
    }
    restored.push(current);
  }
  return restored;
}

/** Only this owner assembly may create an admission original. S5/S8 hooks are
 * explicit non-authorizing dependencies until their respective owners bind them. */
export async function loadInstitutionAdmissionOriginal(
  ctx: PeMutationContext, workId: string, grantIds: string[], profile: DigitalInstitutionProfile,
): Promise<{ original: OriginalInstitutionEvidence; retained: RetainedOriginalSource[] }> {
  if (sha(JSON.stringify(profile)) !== sha(JSON.stringify(JSON.parse(readFileSync(profilePath, "utf8"))))
      || !grantIds.length || grantIds.length > profile.bounds.sourceInstances
      || new Set(grantIds).size !== grantIds.length
      || grantIds.length > profile.bounds.authorizedAcquisitionCalls) {
    throw new Error("X1_PROFILE_OR_ACQUISITION_BOUND");
  }
  const mandate = await readInstitutionMandate(ctx, workId);
  const retained: RetainedOriginalSource[] = [];
  let bytes = 0, objects = 0;
  for (const grantId of grantIds) {
    const source = await acquireInstitutionOriginal(ctx, workId, grantId, profile);
    if (source.institutionId !== mandate.institutionId
        || retained.some((item) => item.id === source.id)) throw new Error("X1_SOURCE_INSTITUTION_OR_IDENTITY_MISMATCH");
    bytes += source.rawBase64 ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8);
    objects += source.coverage.readObjectIds.length;
    if (bytes > profile.bounds.rawBytes || objects > profile.bounds.observationReferences) {
      throw new Error("X1_SOURCE_TOTAL_BOUND");
    }
    retained.push(source);
  }
  const authority = await employeeAuthoritySnapshot(ctx.auth);
  const rightsRevision = String(authority.revision);
  if (retained.some((source) => source.rightsRevision !== rightsRevision)) throw new Error("X1_SOURCE_RIGHTS_CHANGED");
  const allowed: string[] = [];
  for (const operation of profile.ordinaryOperations) {
    if (await canExerciseAuthority(ctx.auth, {
      operation: "action", capability: `action:${operation}`, resource: { type: "work", id: workId },
      workId, risk: "low",
    })) allowed.push(operation);
  }
  const s5 = await readAllocationSnapshot(ctx);
  const method=await installedInstitutionCompilerIdentity();
  // The knowledge cut binds to the server-side retention facts (Core version
  // or acquisition receipt), so an identical owner state replays to an
  // identical digest and a caller can never supply or shift the cut.
  const original: OriginalInstitutionEvidence = {
    tenantId: ctx.auth.tenantId, institutionId: mandate.institutionId,
    workId, principalId: ctx.auth.userId,
    knowledgeCut: retained.map((source) => source.retainedAt).sort().at(-1)!,
    sources: retained, mandate,
    canonical: { tenantId: ctx.auth.tenantId, revision: "", entities: [] },
    current: {
      sourceRevisions: Object.fromEntries(retained.map((source) => [source.id, source.revision])),
      sourceDigests: Object.fromEntries(retained.map((source) => [source.id, source.originalSha256])),
      sensitiveSubjects:retained.filter(source=>source.sensitiveSubjectRegistrations).map(source=>({
        sourceId:source.id,institutionId:source.institutionId,sourceClass:source.sourceClass,
        purpose:source.purpose,registrations:source.sensitiveSubjectRegistrations!})),
      mandateRevision: mandate.revision, canonicalRevision: "", rightsRevision,
      resourceRevision: s5.snapshotDigest,
      methodRevision: method.ref.contentDigest,
      operationRevision: sha(JSON.stringify([rightsRevision, allowed])),
      checkerRevision: sha(Buffer.concat([readFileSync(checkerPath), readFileSync(checkerRawPath),readFileSync(canonicalJsonPath)])),
      profileRevision: profile.revision, schemaRevision: await withTenantTransaction(ctx.auth.tenantId,
        { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
          const rows = await client.query<{ name: string }>(
            "SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
          return rows.rows[0]?.name ?? "SCHEMA_NOT_INSTALLED";
        }),
      runtimeRevision: `development:${process.version}:${process.platform}:${process.arch}`,
      authorizedOperations: allowed,
    },
  };
  if (original.current.schemaRevision !== CURRENT_MIGRATION_HEAD) {
    throw new Error("X1_AUTHORITY_SCHEMA_NOT_INSTALLED");
  }
  const owner = await loadInstitutionCanonicalOwnerSnapshot(ctx, original, profile);
  original.canonical = owner.canonical;
  original.current.canonicalRevision = owner.canonical.revision;
  original.current.canonicalOwners = owner.canonical.entities;
  if (owner.rightsRevision !== rightsRevision) throw new Error("X1_CANONICAL_RIGHTS_CHANGED");
  return { original, retained };
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
  const prospective = new Map<string, { entityType: "fund" | "vehicle"; registrationId: string; id: string; name: string; ambiguousName?:boolean }>();
  for (const source of original.sources) {
    const rows = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
    for (const row of rows) {
      if (row.registrationId) identifiers.add(row.registrationId);
      if (row.relationRegistrationId) identifiers.add(row.relationRegistrationId);
      if ((row.entityType === "fund" || row.entityType === "vehicle") && row.registrationId
          && row.name && row.name.length <= 256) {
        const key = JSON.stringify([row.entityType, row.registrationId]);
        const prior = prospective.get(key);
        if(prior){if(prior.name!==row.name)prior.ambiguousName=true;continue;}
        prospective.set(key, { entityType: row.entityType, registrationId: row.registrationId,
          id: canonicalId(ctx.auth.tenantId, original.institutionId, row.entityType, row.registrationId), name: row.name });
      }
    }
  }
  if (identifiers.size > profile.bounds.canonicalReferences) throw new Error("X1_CANONICAL_REFERENCE_BOUND");
  const matches = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId,
    readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const result = await client.query<{ id: string; external_id: string;version:number }>(
      `SELECT id::text,external_id,version FROM finnor_os.pe_deals
        WHERE tenant_id=$1 AND source_system=$4 AND external_id=ANY($2::text[]) AND archived_at IS NULL AND status='active'
        ORDER BY external_id,id LIMIT $3`,
      [ctx.auth.tenantId, [...identifiers], profile.bounds.deals + 1, `x1:${original.institutionId}`]);
    return result.rows;
  });
  if (matches.length > profile.bounds.deals) throw new Error("X1_DEAL_BOUND");
  const entities: OriginalInstitutionEvidence["canonical"]["entities"] = [];
  let rightsRevision = "";
  for (const deal of matches) {
    const world = await loadPrivateEquityWorldState(ctx, { entityType: "pe_deal", entityId: deal.id });
    const owner = world.provenance.find((item) => item.entityType === "pe_deal" && item.entityId === deal.id);
    const nativeVersion=Number(world.deal?.version);
    if (!owner || world.deal?.externalId !== deal.external_id || !world.beliefView
        ||!Number.isSafeInteger(nativeVersion)||nativeVersion<1||nativeVersion!==Number(deal.version)) {
      throw new Error("X1_CANONICAL_OWNER_SNAPSHOT_UNAVAILABLE");
    }
    const rights = String(world.beliefView.rights.revision);
    if (rightsRevision && rightsRevision !== rights) throw new Error("X1_RIGHTS_CHANGED_DURING_CANONICAL_READ");
    rightsRevision = rights;
    // S1's immutable history ordinal can advance independently of the native
    // mutation/CAS version. Do not use that ordinal as a PE API version.
    entities.push({ ref: `pe_deal:${deal.id}@v${nativeVersion}`, entityType: "deal",
      registrationId: deal.external_id, institutionId: original.institutionId,
      ownerWitness:{historyVersion:owner.entityVersion,historySnapshotHash:owner.snapshotHash} });
  }
  const currentTwins = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId,
    readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const refs: Array<{ kind: "fund" | "vehicle"; id: string; registration: string; name: string; version: number }> = [];
    for (const entry of prospective.values()) {
      const table = entry.entityType === "fund" ? "pe_funds" : "pe_vehicles";
      const row = await client.query<{ id: string; name: string; external_id: string; version: number }>(
        `SELECT id::text,name,external_id,version FROM finnor_os.${table}
          WHERE tenant_id=$1 AND source_system=$2 AND external_id=$3 AND status<>'liquidated' LIMIT 1`,
        [ctx.auth.tenantId, `x1:${original.institutionId}`, entry.registrationId]);
      const found = row.rows[0];
      if(!found&&entry.ambiguousName)continue;
      // Existing owners supply their actual ID. A display-label correction is
      // an assertion difference, not a new identity or permission to rename.
      refs.push({ kind: entry.entityType, id: found?.id??entry.id, registration: entry.registrationId,
        name: found?.name??entry.name, version: found?.version ?? 0 });
    }
    for(const kind of ["fund","vehicle"] as const){
      const table=kind==="fund"?"pe_funds":"pe_vehicles";
      const rows=(await client.query<{id:string;name:string;external_id:string;version:number}>(
        `SELECT id::text,name,external_id,version FROM finnor_os.${table}
          WHERE tenant_id=$1 AND source_system=$2 AND external_id=ANY($3::text[])
            AND status<>'liquidated' ORDER BY external_id,id LIMIT $4`,
        [ctx.auth.tenantId,`x1:${original.institutionId}`,[...identifiers],profile.bounds.canonicalReferences+1])).rows;
      if(rows.length>profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
      for(const row of rows)if(!refs.some(ref=>ref.kind===kind&&ref.id===row.id))
        refs.push({kind,id:row.id,registration:row.external_id,name:row.name,version:row.version});
    }
    return refs;
  });
  for (const entry of currentTwins) {
    entities.push({ ref: `pe_${entry.kind}:${entry.id}@v${entry.version || 1}`,
      entityType: entry.kind, registrationId: entry.registration, institutionId: original.institutionId });
  }
  const additional=await readAdditionalInstitutionOwners(ctx,original,[...identifiers],profile);
  for(const entity of additional)entities.push(entity);
  if (entities.length > profile.bounds.canonicalReferences
      || currentTwins.length + matches.length > profile.bounds.canonicalReferences) {
    throw new Error("X1_CANONICAL_REFERENCE_BOUND");
  }
  if (!rightsRevision) {
    rightsRevision = String((await authorizeBeliefResources(ctx, [{ type: "tenant", id: ctx.auth.tenantId }])).revision);
  }
  return { canonical: { tenantId: ctx.auth.tenantId, revision: institutionOwnerCutDigest(entities), entities },
    rightsRevision };
}

export interface AcceptedInstitutionMappingRef {
  sourceId: string; recordId: string; canonicalRef: string; originalDocumentVersionId: string;
  evidenceSourceId: string; evidenceVersionId: string; evidenceLinkId: string;
  sourceTruthLinkId: string | null;
  relationId?: string;
  disposition: "SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH";
  evidenceAttachmentKind?:"PE_EVIDENCE_LINK"|"CORE_EVIDENCE_ENTITY_REF";
  workAttachmentKind?:"CANONICAL_WORK_LINK"|"MEMORY_ENTITY_REF_ONLY";
}

/** Authenticated source handles are the only input to the production proposal.
 * An accepted development checker receipt never itself publishes canonical truth. */
export async function reconstructAndAdmitInstitutionSources(
  ctx: PeMutationContext, workId: string, grantIds: string[], profile: DigitalInstitutionProfile,
): Promise<{ mappings: AcceptedInstitutionMappingRef[];
  unresolved: NonNullable<InstitutionCandidate["unresolved"]>; check: InstitutionCheck;
  original: OriginalInstitutionEvidence; candidate: InstitutionCandidate }> {
  const { original } = await loadInstitutionAdmissionOriginal(ctx, workId, grantIds, profile);
  const candidate = await proposeInstitutionModel(original, profile);
  const check = await checkInstitutionInSeparateProcessAsync(original, candidate, profile);
  if (check.disposition !== "ACCEPTED_DEVELOPMENT") {
    return { mappings: [], unresolved: candidate.unresolved ?? [], check, original, candidate };
  }
  const mappings = await admitCheckedInstitutionMappings(ctx, original, candidate, check, profile);
  return { mappings, unresolved: candidate.unresolved ?? [], check, original, candidate };
}

/** Separate checker acceptance is rederived from owner bytes/snapshot. No
 * producer-issued check, inferred norm or direct canonical row write is used.
 * Module-private on purpose: every preflight and write input below derives
 * from the server-rehydrated `sources`, never from a caller-retained array. */
async function admitCheckedInstitutionMappings(
  ctx: PeMutationContext, original: OriginalInstitutionEvidence,
  candidate: InstitutionCandidate,
  acceptedCheck: InstitutionCheck, profile: DigitalInstitutionProfile,
): Promise<AcceptedInstitutionMappingRef[]> {
  if (original.tenantId !== ctx.auth.tenantId || original.principalId !== ctx.auth.userId
      || acceptedCheck.disposition !== "ACCEPTED_DEVELOPMENT") throw new Error("X1_ADMISSION_NOT_CURRENT_OR_UNRESOLVED");
  // The caller's original supplies only opaque rehydration handles; content,
  // class, purpose, consent and Source Truth inputs come from `sources`.
  const handles = original.sources as unknown as RetainedOriginalSource[];
  if (handles.some((handle) => !handle || typeof handle.grantId !== "string" || !handle.grantId
      || typeof handle.originalSha256 !== "string" || typeof handle.coreVersionId !== "string"
      || typeof handle.grantVersion !== "number")) {
    throw new Error("X1_ADMISSION_NOT_CURRENT_OR_UNRESOLVED");
  }
  const sources = await rereadSources(ctx, original.workId, handles, profile);
  if (sources.length !== handles.length || sources.some((source, index) => source.id !== handles[index]!.id)) {
    throw new Error("X1_ORIGINAL_BYTES_OR_REVISION_MISMATCH");
  }
  const mandate = await readInstitutionMandate(ctx, original.workId);
  if (mandate.id !== original.mandate.id || mandate.revision !== original.mandate.revision
      || sha(JSON.stringify(mandate.rules)) !== sha(JSON.stringify(original.mandate.rules))
      || mandate.institutionId !== original.institutionId) throw new Error("X1_MANDATE_CHANGED");
  const prior = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true },
    async (_db, client) => client.query<{ receipts: AcceptedInstitutionMappingRef[]; checker_digest: string; duty_population_digest: string | null }>(
      `SELECT receipts,checker_digest,duty_population_digest FROM finnor_os.x1_mapping_admissions
        WHERE tenant_id=$1 AND work_id=$2 AND principal_id=$3
          AND original_digest=$4 AND candidate_digest=$5 LIMIT 1`,
      [ctx.auth.tenantId, original.workId, ctx.auth.userId, sha(JSON.stringify(original)), sha(JSON.stringify(candidate))],
    ));
  if (prior.rows[0]) {
    if (acceptedCheck.inputDigest !== sha(JSON.stringify(original))
        || acceptedCheck.candidateDigest !== sha(JSON.stringify(candidate))
        || prior.rows[0].checker_digest !== acceptedCheck.checkerRevision
        || prior.rows[0].duty_population_digest !== checkedDutyDigest(
          original, candidate, acceptedCheck, profile)) {
      throw new Error("X1_ADMISSION_REPLAY_DIGEST_MISMATCH");
    }
    const current = await loadInstitutionAdmissionOriginal(ctx, original.workId,
      sources.map((source) => source.grantId), profile);
    if (current.original.current.rightsRevision !== original.current.rightsRevision
        || current.original.current.checkerRevision !== acceptedCheck.checkerRevision) {
      throw new Error("X1_ADMISSION_REPLAY_STALE_RIGHTS_OR_CHECKER");
    }
    await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
      for (const receipt of prior.rows[0]!.receipts) {
        if (!current.original.canonical.entities.some((entity) => entity.ref === receipt.canonicalRef)) {
          throw new Error("X1_ADMISSION_REPLAY_CANONICAL_CHANGED");
        }
        const entity = parseInstitutionOwnerRef(receipt.canonicalRef);
        if (!entity) throw new Error("X1_ADMISSION_REPLAY_CANONICAL_CHANGED");
        const evidence = receipt.evidenceAttachmentKind === "CORE_EVIDENCE_ENTITY_REF"
          ? await client.query(
            `SELECT 1 FROM finnor_os.evidence_source_versions v
               JOIN finnor_os.evidence_chunks ch ON ch.tenant_id=v.tenant_id
                 AND ch.source_id=v.source_id AND ch.version_id=v.id
              WHERE v.tenant_id=$1 AND v.id=$2 AND v.source_id=$3 AND v.id=$4
                AND ch.entity_refs @> $5::jsonb`,
            [ctx.auth.tenantId,receipt.evidenceVersionId,receipt.evidenceSourceId,receipt.evidenceLinkId,
              JSON.stringify([{type:entity.entityType,id:entity.entityId}])])
          : await client.query(
          `SELECT 1 FROM finnor_os.evidence_source_versions v
             JOIN finnor_os.pe_evidence_links l ON l.tenant_id=v.tenant_id
               AND l.evidence_source_id=v.source_id AND l.evidence_version_id=v.id
            WHERE v.tenant_id=$1 AND v.id=$2 AND v.source_id=$3
              AND l.id=$4 AND l.entity_type=$5 AND l.entity_id=$6 AND l.archived_at IS NULL`,
          [ctx.auth.tenantId, receipt.evidenceVersionId, receipt.evidenceSourceId, receipt.evidenceLinkId,
            entity.entityType,entity.entityId],
        );
        if (!evidence.rows[0]) throw new Error("X1_ADMISSION_REPLAY_EVIDENCE_CHANGED");
        // Readback also re-verifies the Source Truth link: a later re-map or
        // tombstone of the observed provider object refuses the replay.
        if (receipt.sourceTruthLinkId) {
          const truth = await client.query(
            `SELECT 1 FROM finnor_os.external_refs
              WHERE tenant_id=$1 AND id=$2 AND entity=$3
                AND (internal_id=$4::uuid OR candidate_canonical_ids @> ARRAY[$4::uuid])
                AND mapping_status<>'tombstoned' AND tombstoned_at IS NULL`,
            [ctx.auth.tenantId, receipt.sourceTruthLinkId, entity.entityType, entity.entityId],
          );
          if (!truth.rows[0]) throw new Error("X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED");
        }
      }
    });
    return prior.rows[0].receipts;
  }
  const currentOwner = await loadInstitutionAdmissionOriginal(ctx, original.workId,
    sources.map((source) => source.grantId), profile);
  // The knowledge cut binds to the server-side retention receipts, so the
  // fresh owner read must reproduce it exactly; caller input never moves it.
  const owner = await loadInstitutionCanonicalOwnerSnapshot(ctx, { ...original, sources }, profile);
  const sourceRevisions = Object.fromEntries(sources.map((source) => [source.id, source.revision]));
  const sourceDigests = Object.fromEntries(sources.map((source) => [source.id, source.originalSha256]));
  const independent: OriginalInstitutionEvidence = {
    ...currentOwner.original, sources, mandate, canonical: owner.canonical,
    current: { ...currentOwner.original.current, sourceRevisions, sourceDigests, mandateRevision: mandate.revision,
      canonicalRevision: owner.canonical.revision, canonicalOwners:owner.canonical.entities, rightsRevision: owner.rightsRevision },
  };
  if (sha(JSON.stringify(independent)) !== sha(JSON.stringify(original))) {
    throw new Error("X1_ORIGINAL_OR_CURRENT_OWNER_CUT_MISMATCH");
  }
  const check = await checkInstitutionInSeparateProcessAsync(independent, candidate, profile);
  if (check.disposition !== "ACCEPTED_DEVELOPMENT"
      || check.inputDigest !== acceptedCheck.inputDigest
      || check.candidateDigest !== acceptedCheck.candidateDigest
      || check.profileDigest !== acceptedCheck.profileDigest
      || check.checkerRevision !== acceptedCheck.checkerRevision) {
    throw new Error("X1_SEPARATE_CHECK_OR_OWNER_CUT_MISMATCH");
  }
  const dutyPopulationDigest = checkedDutyDigest(independent, candidate, check, profile);
  // Preflight every target before any owner write; unresolved independent
  // sources do not prevent the supported mappings from committing.
  for (const mapping of candidate.mappings) {
    const source = sources.find((item) => item.id === mapping.sourceId);
    const exact = owner.canonical.entities.find((item) => item.ref === mapping.canonicalRef
      && item.registrationId === mapping.registrationId && (!item.sourceId || item.sourceId===mapping.sourceId));
    const entity = parseInstitutionOwnerRef(mapping.canonicalRef);
    if (!source || !exact || !entity) throw new Error("X1_MAPPING_NO_CANONICAL_OWNER_TARGET");
    const integration = [source.integrationId, source.provider, source.sourceScope, source.externalObjectType];
    if (integration.some(Boolean) && !integration.every(Boolean)) throw new Error("X1_PARTIAL_SOURCE_TRUTH_BINDING");
  }
  return peTransaction(ctx, async (db, client) => {
    const rights = await client.query<{ revision: number }>(
      "SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE",
      [ctx.auth.tenantId],
    );
    if (String(rights.rows[0]?.revision) !== original.current.rightsRevision) {
      throw new Error("X1_AUTHORITY_CHANGED_DURING_PUBLICATION");
    }
    const mandateLocked = await client.query<{ id: string }>(
      `SELECT id::text FROM finnor_os.x1_work_mandates
        WHERE tenant_id=$1 AND id=$2 AND work_id=$3 AND principal_id=$4
          AND revision=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
      [ctx.auth.tenantId, original.mandate.id, original.workId, ctx.auth.userId, original.mandate.revision],
    );
    if (!mandateLocked.rows[0]) throw new Error("X1_MANDATE_CHANGED_DURING_PUBLICATION");
    const receipts: AcceptedInstitutionMappingRef[] = [];
    const createdRelations = new Set<string>();
    for (const mapping of [...candidate.mappings].sort((a, b) => {
      const rank = (ref: string) => ref.startsWith("pe_fund:") ? 0 : ref.startsWith("pe_vehicle:") ? 1 : 2;
      return rank(a.canonicalRef) - rank(b.canonicalRef);
    })) {
      const source = sources.find((item) => item.id === mapping.sourceId)!;
      const entity = parseInstitutionOwnerRef(mapping.canonicalRef);
      if (!entity) throw new Error("X1_MAPPING_NO_CANONICAL_OWNER_TARGET");
      const entityId=entity.entityId,entityType=entity.entityType;
      const kind=entityType==="pe_deal"?"deal":entityType==="pe_fund"?"fund":entityType==="pe_vehicle"?"vehicle":null;
      let dealId:string|null=null;
      if(kind){
      let row: { id: string; external_id: string; version: number; source_system: string };
      if (kind === "deal") {
        const deal = await lockPeDeal(client, ctx.auth.tenantId, entityId!);
        requireActivePeDeal(deal);
        row = deal as typeof row;
        dealId=entityId;
      } else {
        const records = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
        const native = records.find((item) => item.id === mapping.recordId);
        if (!native || native.entityType !== kind || native.registrationId !== mapping.registrationId) {
          throw new Error("X1_NATIVE_CANONICAL_CREATION_EVIDENCE_MISSING");
        }
        const table = kind === "fund" ? "pe_funds" : "pe_vehicles";
        const current = await client.query<typeof row>(
          `SELECT id::text,external_id,version,source_system FROM finnor_os.${table}
            WHERE tenant_id=$1 AND source_system=$2 AND external_id=$3 FOR UPDATE`,
          [ctx.auth.tenantId, `x1:${original.institutionId}`, mapping.registrationId],
        );
        if (!current.rows[0]) {
          if(!native.name||native.name.length>256)throw Error("X1_NATIVE_CANONICAL_CREATION_EVIDENCE_MISSING");
          if(canonicalId(ctx.auth.tenantId,original.institutionId,kind,mapping.registrationId)!==entityId)
            throw Error("X1_NATIVE_CANONICAL_CREATION_IDENTITY_CHANGED");
          const creation = { ...ctx, provenance: { sourceSystem: `x1:${original.institutionId}`,
            externalId: mapping.registrationId, createdBy: ctx.auth.userId,
            observedAt: new Date(original.knowledgeCut) } };
          const result = kind === "fund"
            ? await createFundTx(client, creation, { id: entityId!, name: native.name, registrationId: mapping.registrationId })
            : await createVehicleTx(client, creation, { id: entityId!, name: native.name, registrationId: mapping.registrationId,
              vehicleType: native.vehicleType === "feeder" ? "feeder"
                : native.vehicleType === "main" ? "main" : "other" });
          row = { id: String(result.row.id), external_id: String(result.row.externalId),
            version: Number(result.row.version), source_system: String(result.row.sourceSystem) };
        } else row = current.rows[0];
      }
      if (row.id !== entityId || row.external_id !== mapping.registrationId
          || entity.revision !== `v${row.version}`
          || row.source_system !== `x1:${original.institutionId}`) {
        throw new Error("X1_CANONICAL_ENTITY_CHANGED_DURING_ADMISSION", { cause: {
          kind: "X1_CANONICAL_OWNER_MISMATCH", canonicalRef: mapping.canonicalRef,
          registrationId: mapping.registrationId, expectedSourceSystem: `x1:${original.institutionId}`,
          observed: { id: row.id, registrationId: row.external_id, version: row.version, sourceSystem: row.source_system },
        } });
      }
      }else{
        const locked=await lockAdditionalInstitutionOwner(client,ctx,original,mapping.canonicalRef,
          mapping.registrationId,mapping.sourceId);
        dealId=locked.dealId;
      }
      const version = await loadDocumentVersion(db, ctx.auth.tenantId, source.coreDocumentId, source.coreVersionId);
      if (!version || sha(version.bytes) !== source.originalSha256) throw new Error("X1_ORIGINAL_CHANGED_DURING_PUBLICATION");
      // Publication relocks the grant at acquisition strength: exact revision
      // and original digest, inside its valid window, and not superseded by a
      // newer version issued during the publication window.
      const grant = await client.query(
        `SELECT 1 FROM finnor_os.x1_source_grants g WHERE g.tenant_id=$1 AND g.id=$2
          AND g.principal_id=$3 AND g.work_id=$4 AND g.version=$5
          AND g.revision=$6 AND g.original_sha256=$7
          AND g.valid_from<=clock_timestamp()
          AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM finnor_os.x1_source_grants newer
             WHERE newer.tenant_id=g.tenant_id AND newer.work_id=g.work_id
               AND newer.principal_id=g.principal_id AND newer.source_id=g.source_id
               AND newer.version>g.version)
          FOR SHARE`,
        [ctx.auth.tenantId, source.grantId, ctx.auth.userId, original.workId, source.grantVersion,
          source.revision, source.originalSha256],
      );
      if (!grant.rows[0]) throw new Error("X1_SOURCE_GRANT_CHANGED_DURING_PUBLICATION");
      if (source.sourceClass === "personnel_benefits" || source.sourceClass === "expense_administration") {
        const records = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
        const subjects = [...new Set(records.map((row) => row.registrationId))];
        if (!subjects.length || subjects.some((id) => !id)) throw new Error("X1_SENSITIVE_SUBJECT_UNRESOLVED");
        // Same strength as acquisition: the bound subject must still be an
        // active employee at publication, not only at retention.
        const consent = await client.query<{ registration_id: string }>(
          `SELECT b.registration_id FROM finnor_os.x1_subject_identity_bindings b
             JOIN finnor_os.x1_subject_consents c ON c.tenant_id=b.tenant_id
               AND c.subject_user_id=b.subject_user_id AND c.institution_id=b.institution_id
               AND c.source_class=$4 AND c.purpose=$5
             JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
           WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.source_id=$3
             AND b.registration_id=ANY($6::text[]) AND b.revoked_at IS NULL
             AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
             AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
             AND u.status='active'
           FOR SHARE OF b,c`,
          [ctx.auth.tenantId, source.institutionId, source.id, source.sourceClass, source.purpose, subjects],
        );
        if (consent.rows.length !== subjects.length) throw new Error("X1_SENSITIVE_CONSENT_CHANGED");
      }
      let sourceTruthLinkId: string | null = null;
      if (source.integrationId && source.provider && source.sourceScope && source.externalObjectType) {
        const record = kind === "deal" ? mapPrivateEquitySourceObservation({
          tenantId: ctx.auth.tenantId, integrationId: source.integrationId, provider: source.provider,
          sourceScope: source.sourceScope, externalObjectType: source.externalObjectType,
          externalId: mapping.recordId, dealId: entityId!,
          entity: { entityType: "pe_deal", entityId: entityId! },
          claims: [{ entity: { entityType: "pe_deal", entityId: entityId! }, predicate: "deal.exists", value: true }],
          observedAt: original.knowledgeCut, sourceVersion: source.revision,
          provenance: { originalDocumentId: source.coreDocumentId, originalVersionId: source.coreVersionId,
            originalSha256: source.originalSha256, checkedCandidateDigest: check.candidateDigest },
        }) : {
          tenantId: ctx.auth.tenantId, integrationId: source.integrationId, provider: source.provider,
          sourceScope: source.sourceScope, externalObjectType: source.externalObjectType,
          externalId: mapping.recordId, canonicalEntity: entityType, candidateCanonicalIds: [entityId],
          identityKey: JSON.stringify([original.institutionId,entityType,mapping.registrationId]),
          sourceVersion: source.revision, observedAt: original.knowledgeCut,
          data: { schema: "finnor.x1.checked-identity.v1", registrationId: mapping.registrationId,
            originalSha256: source.originalSha256, originalDocumentVersionId: source.coreVersionId },
          ownership: { default: "finnor" as const, direction: "inbound" as const },
          materialization: "observe_only" as const,
          provenance: { checkedCandidateDigest: check.candidateDigest },
        };
        const observed = await materializeSourceRecord(db, record);
        if (!["observed", "duplicate"].includes(observed.status)) {
          throw new Error(`X1_SOURCE_TRUTH_${observed.status.toUpperCase()}`);
        }
        sourceTruthLinkId = observed.sourceLinkId;
      }
      const evidence = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
        sourceKey: `x1:${source.coreDocumentId}:${source.coreVersionId}:${mapping.recordId}`,
        sourceType: "x1_original_source_assertion",
        title: `Original ${source.sourceClass} observation ${mapping.recordId}`,
        metadata: { documentId: source.coreDocumentId, documentVersionId: source.coreVersionId,
          originalSha256: source.originalSha256, protocol: source.protocol, sourceRevision: source.revision },
      });
      const evidenceVersion = await appendEvidenceVersionTx(db, ctx.auth.tenantId, evidence.id, {
        content: `Original source assertion ${mapping.recordId}; sha256:${source.originalSha256}`,
        snapshot: { sourceId: source.id, objectId: mapping.recordId,
          documentId: source.coreDocumentId, documentVersionId: source.coreVersionId,
          originalSha256: source.originalSha256, canonicalCandidate: mapping.canonicalRef,
          disposition: "source_assertion_not_settled_truth" },
        asOf: new Date(original.knowledgeCut), retrievedAt: new Date(),
        entityRefs: [{ type: entityType, id: entityId }],
      });
      const peEntity=PE_ENTITY_TYPES.find(type=>type===entityType) as PeEntityType|undefined;
      const link = peEntity && (dealId || kind==="fund" || kind==="vehicle")
        ? await attachEvidenceTx(client,ctx,{
          dealId,...(dealId?{}:{worldRoot:{entityType:kind==="fund"?"pe_fund" as const:"pe_vehicle" as const,entityId}}),
          entity:{entityType:peEntity,entityId},evidenceSourceId:evidence.id,
          evidenceVersionId:evidenceVersion.versionId,relationship:"supports"}) : null;
      // The canonical registry owns Work attachability. Relation-only owners
      // remain Memory assertions when their native owner disallows Work links.
      const attachable=(await client.query<{available:boolean}>(
        "SELECT finnor_os.canonical_entity_work_attachable($1,$2) available",
        [ctx.auth.tenantId,entityType])).rows[0]?.available===true;
      if(attachable)await attachWorkEntityTx(db, { tenantId: ctx.auth.tenantId, workId: original.workId,
        entity: { entityType, entityId, relationship: "about", source: "x1-checked-source" } });
      const relation = (candidate.relations ?? []).find((item) => item.sourceId === mapping.sourceId
        && item.recordId === mapping.recordId && item.relation === "fund_vehicle");
      let relationId: string | undefined;
      if (kind === "vehicle" && relation) {
        const fund = /^pe_fund:([0-9a-f-]{36})@v\d+$/.exec(relation.targetRef);
        if (!fund) throw new Error("X1_FUND_VEHICLE_TARGET_UNSUPPORTED");
        const nativeRecords = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
        const nativeVehicle = nativeRecords.find((item) => item.id === mapping.recordId);
        if (!nativeVehicle || nativeVehicle.vehicleType !== "feeder" && nativeVehicle.vehicleType !== "main") {
          throw new Error("X1_RELATION_KIND_UNRESOLVED");
        }
        const relationshipKind = nativeVehicle.vehicleType === "feeder" ? "feeder" : "other";
        const id = canonicalId(ctx.auth.tenantId, original.institutionId, "fund_vehicle",
          JSON.stringify([relation.targetRegistrationId,mapping.registrationId]));
        const key = `${fund[1]}:${entityId}`;
        if (!createdRelations.has(key)) {
          const existing = await client.query<{ id: string }>(
            `SELECT id::text FROM finnor_os.pe_fund_vehicle_links
               WHERE tenant_id=$1 AND fund_id=$2 AND vehicle_id=$3
                 AND relationship_kind=$4 AND superseded_at IS NULL
                 AND valid_to IS NULL FOR UPDATE`,
            [ctx.auth.tenantId, fund[1], entityId, relationshipKind],
          );
          if (existing.rows[0] && existing.rows[0].id !== id) throw new Error("X1_RELATION_IDENTITY_CONFLICT");
          if (!existing.rows[0]) await linkFundVehicleTx(client, {
            ...ctx, provenance: { sourceSystem: `x1:${original.institutionId}`,
              externalId: `${relation.targetRegistrationId}:${mapping.registrationId}`,
              createdBy: ctx.auth.userId, observedAt: new Date(original.knowledgeCut) },
          }, { id, fundId: fund[1]!, vehicleId: entityId!, validFrom: new Date(relation.validFrom!),
            relationshipKind,
            evidence: { evidenceSourceId: evidence.id, evidenceVersionId: evidenceVersion.versionId } });
          createdRelations.add(key);
        }
        relationId = id;
      }
      receipts.push({ sourceId: source.id, recordId: mapping.recordId, canonicalRef: mapping.canonicalRef,
        originalDocumentVersionId: source.coreVersionId, evidenceSourceId: evidence.id,
        evidenceVersionId: evidenceVersion.versionId, evidenceLinkId: link?String(link.row.id):evidenceVersion.versionId,
        evidenceAttachmentKind:link?"PE_EVIDENCE_LINK":"CORE_EVIDENCE_ENTITY_REF",
        workAttachmentKind:attachable?"CANONICAL_WORK_LINK":"MEMORY_ENTITY_REF_ONLY",
        sourceTruthLinkId, ...(relationId ? { relationId } : {}),
        disposition: "SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH" });
    }
    // Raw INSERT is revoked from finnor_app; publication routes through the
    // SECURITY DEFINER owner function, which re-derives tenant/principal from
    // the request GUCs and cross-checks the referenced Work.
    const publication = await client.query(
      `SELECT id::text FROM finnor_os.x1_publish_mapping_admission($1,$2,$3,$4,$5::jsonb,$6)`,
      [original.workId, check.inputDigest, check.candidateDigest, check.checkerRevision,
        JSON.stringify(receipts), dutyPopulationDigest],
    );
    if (publication.rowCount !== 1) throw new Error("X1_ADMISSION_PUBLICATION_FAILED");
    return receipts;
  }, { isolation: "serializable" });
}
