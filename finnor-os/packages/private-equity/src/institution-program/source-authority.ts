import { createHash } from "node:crypto";
import { AsyncLocalStorage } from 'node:async_hooks';
import { withTenantTransaction } from "@finnor/db";
import { loadDocumentVersion } from "@finnor/data-platform";
import { employeeAuthoritySnapshot } from "@finnor/authority";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import type { PeMutationContext } from "../types";
import { originalRawRecords } from "./checker-raw";
import { acquireInstalledMailOriginal } from "./installed-source";
import type { OriginalInstitutionEvidence } from "./checker";
import type { DigitalInstitutionProfile } from "./contracts";
import { recordInstitutionSourceAttempt,recordInstitutionPhysicalObservation } from "./meter";
import { lockInstitutionSourceAuthority } from './source-locks';
import { readInstitutionSourceScope,type InstitutionSourceScope } from './source-scope';

type Source = OriginalInstitutionEvidence["sources"][number];
export type OwnerOriginal = Source & {
  grantId: string; grantVersion: number; coreDocumentId: string; coreVersionId: string;
  originalSha256: string; purpose: string;
  /** Server-side retention time of the pinned Core version or acquisition
   * receipt; the knowledge cut binds to it, never to caller input. */
  retainedAt: string;
  sensitiveSubjectRegistrations?:string[];
  sourceScopePin:{grantId:string;digest:string;originalReadAllowed:boolean};
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sensitive = (sourceClass: string) =>
  sourceClass === "personnel_benefits" || sourceClass === "expense_administration";
type RetainedCore={bytes:Buffer;documentId:string;versionId:string;retainedAt:string};
const coreOriginalCache=new AsyncLocalStorage<Map<string,RetainedCore>>();
export const withInstitutionOriginalReuse=<T>(run:()=>Promise<T>)=>coreOriginalCache.run(new Map(),run);

type Grant = {
  id: string; source_id: string; source_class: string; protocol: string; revision: string;
  institution_id: string; purpose: string; acquisition_kind: string; version: number;
  document_id: string | null; document_version_id: string | null; original_sha256: string | null;
  expected_object_ids: unknown; integration_id: string | null; provider: string | null;
  adapter_scope: string | null; external_object_type: string | null; external_id: string | null;
  valid_from:Date;
};

/** The registration and bytes come only from the current owner grant and Core.
 * The caller supplies an opaque grant handle, never source bytes or permissions. */
export async function acquireInstitutionOriginal(
  ctx: PeMutationContext, workId: string, grantId: string, profile: DigitalInstitutionProfile,
): Promise<OwnerOriginal> {
  const sourceStarted=performance.now(),sourceStartedAt=new Date().toISOString();
  let originalBytesRead=0,reusedBytes=0,decodedObjects=0,outcome='REFUSED';
  try{
  const principal = ctx.auth.userId;
  await authorizeBeliefResources(ctx, [{ type: "tenant", id: ctx.auth.tenantId }, { type: "work", id: workId }]);
  const grant = await withTenantTransaction(ctx.auth.tenantId, {
    userId: principal, readOnly: true, isolation: "repeatable read",
  }, async (_db, client): Promise<{ row: Grant; rightsRevision: string }> => {
    const result = await client.query<Grant>(
      `SELECT g.id::text,g.source_id,g.source_class,g.protocol,g.revision,g.institution_id,g.purpose,
              g.acquisition_kind,g.version,g.document_id::text,g.document_version_id::text,
              g.original_sha256,g.expected_object_ids,g.integration_id::text,g.provider,
              g.adapter_scope,g.external_object_type,g.external_id,g.valid_from
         FROM finnor_os.x1_source_grants g
         JOIN finnor_os.works w ON w.tenant_id=g.tenant_id AND w.id=g.work_id
        WHERE g.tenant_id=$1 AND g.work_id=$2 AND g.principal_id=$3 AND g.id=$4
          AND w.created_by=$3
        LIMIT 1`,
      [ctx.auth.tenantId, workId, principal, grantId],
    );
    const row = result.rows[0];
    if (!row || !profile.sourceClasses.some((entry) =>
      entry.id === row.source_class && entry.protocols.includes(row.protocol))) {
      throw new Error("X1_SOURCE_GRANT_MISSING_REVOKED_OR_PROFILE_UNSUPPORTED");
    }
    const rights = await client.query<{ revision: number }>(
      `SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 LIMIT 1`,
      [ctx.auth.tenantId],
    );
    return { row, rightsRevision: String(rights.rows[0]?.revision ?? "") };
  });
  const { row, rightsRevision } = grant;
  if(!rightsRevision||!row.original_sha256||!Array.isArray(row.expected_object_ids)
    ||row.expected_object_ids.length>profile.bounds.tabularRowsPerObject
    ||row.expected_object_ids.some(id=>typeof id!=='string'||!id))throw Error('X1_SOURCE_GRANT_COVERAGE_INVALID');
  let sourceScope=await readInstitutionSourceScope(ctx,workId,grantId);
  if(sourceScope.body.sourceRevision!==row.revision||sourceScope.body.originalSha256!==row.original_sha256
    ||sourceScope.body.sourceId!==row.source_id||sourceScope.body.sourceClass!==row.source_class
    ||sourceScope.body.institutionId!==row.institution_id||sourceScope.body.purpose!==row.purpose
    ||sourceScope.body.protocol!==row.protocol||sourceScope.body.acquisitionKind!==row.acquisition_kind
    ||sourceScope.body.documentId!==row.document_id||sourceScope.body.documentVersionId!==row.document_version_id
    ||sourceScope.body.integrationId!==row.integration_id||sourceScope.body.provider!==row.provider
    ||sourceScope.body.adapterScope!==row.adapter_scope||sourceScope.body.externalObjectType!==row.external_object_type
    ||sourceScope.body.externalId!==row.external_id
    ||JSON.stringify(sourceScope.body.expectedObjectIds)!==JSON.stringify(row.expected_object_ids))
    throw Error('X1_SOURCE_METADATA_CHANGED_BEFORE_READ');
  const unavailable=async(scope:InstitutionSourceScope):Promise<OwnerOriginal>=>{
    outcome='AUTHORIZED_SOURCE_GAP';
    if(scope.body.originalReadAllowed||!scope.body.gap)throw Error('X1_SOURCE_GAP_REQUIRES_NATIVE_REFUSAL');
    const metadata=row.document_id&&row.document_version_id?await withTenantTransaction(ctx.auth.tenantId,
      {userId:principal,readOnly:true},async(_db,c)=>(await c.query<{created_at:Date}>(
        'SELECT created_at FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2 AND id=$3',
        [ctx.auth.tenantId,row.document_id,row.document_version_id])).rows[0]):undefined;
    return {id:row.source_id,revision:row.revision,sourceClass:row.source_class,protocol:row.protocol,
      tenantId:ctx.auth.tenantId,institutionId:row.institution_id,authorizedPrincipalIds:[],rightsRevision,
      rawUtf8:'',coverage:{expectedObjectIds:row.expected_object_ids as string[],readObjectIds:[],complete:false},
      grantId:row.id,grantVersion:row.version,coreDocumentId:row.document_id??'',coreVersionId:row.document_version_id??'',
      originalSha256:row.original_sha256!,purpose:row.purpose,
      retainedAt:new Date(metadata?.created_at??row.valid_from).toISOString(),
      sourceScopePin:{grantId,digest:scope.digest,originalReadAllowed:false},
      ownerCoverageGap:{sourceId:row.source_id,grantId,reason:scope.body.gap,scopeDigest:scope.digest,
        expectedObjectCount:(row.expected_object_ids as string[]).length}};
  };
  if(!sourceScope.body.originalReadAllowed)return unavailable(sourceScope);
  let bytes: Buffer; let documentId: string; let versionId: string; let retainedAt: string;
  if (row.acquisition_kind === "core_export") {
    // Immutable Core versions are retained before X1 sees the source. A grant
    // to a version does not confer authority to a newer document head.
    if (!row.document_id || !row.document_version_id) throw new Error("X1_CORE_GRANT_INCOMPLETE");
    const cache=coreOriginalCache.getStore(),key=JSON.stringify([ctx.auth.tenantId,principal,workId,
      row.id,row.document_id,row.document_version_id,row.original_sha256]);
    const reused=cache?.get(key);
    if(!reused)await recordInstitutionSourceAttempt(grantId);
    const read=await withTenantTransaction(ctx.auth.tenantId,{userId:principal,isolation:'repeatable read'},async(db,c)=>{
      await lockInstitutionSourceAuthority(ctx,c,workId,[grantId]);
      const scope=await readInstitutionSourceScope(ctx,workId,grantId,c);
      if(!scope.body.originalReadAllowed)return {scope,core:null};
      if(scope.body.sourceRevision!==row.revision||scope.body.originalSha256!==row.original_sha256)
        throw Error('X1_SOURCE_METADATA_CHANGED_BEFORE_READ');
      if(reused){
        const current=(await c.query<{byte_sha256:string;provider_version_id:string|null;id:string;size_bytes:number;
          sha256:string;content_size:number;physical_size:number;storage_backend:string}>(`SELECT v.id::text,v.byte_sha256,
          v.provider_version_id,v.size_bytes,c.sha256,c.size_bytes content_size,octet_length(c.bytes) physical_size,c.storage_backend
          FROM finnor_os.document_versions v JOIN finnor_os.document_version_contents c ON c.tenant_id=v.tenant_id AND c.version_id=v.id
          WHERE v.tenant_id=$1 AND v.document_id=$2 AND v.id=$3`,[ctx.auth.tenantId,row.document_id,row.document_version_id])).rows[0];
        if(!current||current.byte_sha256!==row.original_sha256||current.sha256!==row.original_sha256
          ||current.storage_backend!=='postgres'||current.size_bytes!==reused.bytes.length
          ||current.content_size!==reused.bytes.length||current.physical_size!==reused.bytes.length
          ||(current.provider_version_id??current.id)!==row.revision||digest(reused.bytes)!==row.original_sha256)
          throw Error('X1_RETAINED_IMMUTABLE_ORIGINAL_OWNER_CHANGED');
        reusedBytes=reused.bytes.length;
        return {scope,core:reused};
      }
      const acquired=await loadDocumentVersion(db,ctx.auth.tenantId,row.document_id!,row.document_version_id!);
      originalBytesRead=acquired?.bytes.length??0;
      if(!acquired||acquired.version.byte_sha256!==row.original_sha256||digest(acquired.bytes)!==row.original_sha256
        ||(acquired.version.provider_version_id??acquired.version.id)!==row.revision
        ||!acquired.bytes.length||acquired.bytes.length>profile.bounds.objectBytes)throw Error('X1_ORIGINAL_VERSION_OR_DIGEST_CHANGED');
      return {scope,core:{bytes:acquired.bytes,documentId:row.document_id!,versionId:row.document_version_id!,
        retainedAt:new Date(acquired.version.created_at).toISOString()}};
    });
    sourceScope=read.scope;
    if(!read.core)return unavailable(sourceScope);
    ({bytes,documentId,versionId,retainedAt}=read.core);
    if(cache&&!reused){
      const total=[...cache.values()].reduce((sum,item)=>sum+item.bytes.length,bytes.length);
      if(cache.size>=profile.bounds.sourceInstances||total>profile.bounds.rawBytes)throw Error('X1_ORIGINAL_REUSE_BOUND');
      cache.set(key,read.core);
    }
  } else if (row.acquisition_kind === "installed_adapter") {
    await recordInstitutionSourceAttempt(grantId);
    // The installed owner fetches exact original bytes through its own current
    // credential, scope and permission reads, then retains them in Core. X1
    // never receives a caller URL, token or pre-mapped provider record.
    if (!row.integration_id || !row.provider || !row.adapter_scope
        || !row.external_object_type || !row.external_id || !row.original_sha256) {
      throw new Error("X1_INSTALLED_GRANT_INCOMPLETE");
    }
    const acquired = await acquireInstalledMailOriginal(ctx, workId, {
      id: row.id, integration_id: row.integration_id, adapter_scope: row.adapter_scope,
      external_id: row.external_id, source_id: row.source_id, source_class: row.source_class,
      external_object_type: row.external_object_type, protocol: row.protocol,
      provider: row.provider, revision: row.revision, original_sha256: row.original_sha256,
    }, profile);
    bytes = acquired.bytes; documentId = acquired.documentId; versionId = acquired.versionId;
    originalBytesRead=acquired.bytes.length;
    retainedAt = acquired.retainedAt;
  } else {
    throw new Error("X1_ACQUISITION_KIND_UNSUPPORTED");
  }
  if (!rightsRevision || !Array.isArray(row.expected_object_ids)
      || row.expected_object_ids.length > profile.bounds.tabularRowsPerObject
      || row.expected_object_ids.some((value) => typeof value !== "string" || !value)) {
    throw new Error("X1_SOURCE_GRANT_COVERAGE_INVALID");
  }
  const binary = ["pdf_text", "docx", "xlsx"].includes(row.protocol);
  const source: OwnerOriginal = {
    id: row.source_id, revision: row.revision, sourceClass: row.source_class, protocol: row.protocol,
    tenantId: ctx.auth.tenantId, institutionId: row.institution_id,
    authorizedPrincipalIds: [principal], rightsRevision,
    rawUtf8: binary ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ...(binary ? { rawBase64: bytes.toString("base64") } : {}),
    coverage: { expectedObjectIds: row.expected_object_ids as string[], readObjectIds: [], complete: false },
    grantId: row.id, grantVersion: row.version, coreDocumentId: documentId,
    sourceScopePin:{grantId,digest:sourceScope.digest,originalReadAllowed:true},
    coreVersionId: versionId, originalSha256: digest(bytes), purpose: row.purpose, retainedAt,
    ...(row.integration_id ? { integrationId: row.integration_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.adapter_scope ? { sourceScope: row.adapter_scope } : {}),
    ...(row.external_object_type ? { externalObjectType: row.external_object_type } : {}),
  };
  const rows = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
  decodedObjects=rows.length;
  source.coverage.readObjectIds = rows.map((item) => item.id);
  source.coverage.complete = source.coverage.expectedObjectIds.length === rows.length
    && new Set(rows.map((item) => item.id)).size === rows.length
    && source.coverage.expectedObjectIds.every((id) => source.coverage.readObjectIds.includes(id));
  if (!source.coverage.complete) throw new Error("X1_SOURCE_COVERAGE_INCOMPLETE");
  if (sensitive(row.source_class)) {
    await verifySubjectConsent(ctx, source, rows, profile);
    source.sensitiveSubjectRegistrations=[...new Set(rows.map(item=>item.registrationId!))].sort();
    if(JSON.stringify(source.sensitiveSubjectRegistrations)!==JSON.stringify(sourceScope.body.expectedSubjectRegistrations))
      throw Error('X1_ORIGINAL_SUBJECT_CERTIFICATION_DIFFERS');
    // Compatibility witness for the original-byte checker. Only owner reads
    // can issue it; admission rechecks the actual rows, not this string.
    source.sensitiveConsentRef = `owner-current:${digest(Buffer.from(JSON.stringify([
      source.institutionId, source.id, source.purpose, rows.map((item) => item.registrationId),
    ])))}`;
  }
  const currentRights = await employeeAuthoritySnapshot(ctx.auth);
  if (String(currentRights.revision) !== rightsRevision) throw new Error("X1_SOURCE_RIGHTS_CHANGED");
  outcome='COMPLETE';
  return source;
  }finally{
    recordInstitutionPhysicalObservation({kind:'SOURCE',grantId,startedAt:sourceStartedAt,
      elapsedMs:performance.now()-sourceStarted,outcome,includedWithin:'COMPILE',originalBytesRead,reusedBytes,
      decodedObjects,byteBasis:'BYTES_RETURNED_BY_CANONICAL_CORE_OR_INSTALLED_SOURCE_OWNER',
      storageBlockBytes:null,networkWireBytes:null,monetaryCost:null});
  }
}

async function verifySubjectConsent(
  ctx: PeMutationContext, source: OwnerOriginal,
  rows: Awaited<ReturnType<typeof originalRawRecords>>, profile: DigitalInstitutionProfile,
): Promise<void> {
  if (rows.length > profile.bounds.observationReferences) throw new Error("X1_SENSITIVE_SUBJECT_BOUND");
  const ids = [...new Set(rows.map((row) => row.registrationId))];
  if (!ids.length || ids.some((id) => !id)) throw new Error("X1_SENSITIVE_SUBJECT_UNRESOLVED");
  const count = await withTenantTransaction(ctx.auth.tenantId, {
    userId: ctx.auth.userId, readOnly: true, isolation: "repeatable read",
  }, async (_db, client) => client.query<{ registration_id: string }>(
    `SELECT b.registration_id
       FROM finnor_os.x1_subject_identity_bindings b
       JOIN finnor_os.x1_subject_consents c
         ON c.tenant_id=b.tenant_id AND c.subject_user_id=b.subject_user_id
        AND c.institution_id=b.institution_id AND c.source_class=$4 AND c.purpose=$5
       JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
      WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.source_id=$3
        AND b.registration_id=ANY($6::text[]) AND b.valid_from<=clock_timestamp()
        AND b.expires_at>clock_timestamp() AND b.revoked_at IS NULL
        AND c.granted_at<=clock_timestamp() AND c.expires_at>clock_timestamp()
        AND c.revoked_at IS NULL AND u.status='active'`,
    [ctx.auth.tenantId, source.institutionId, source.id, source.sourceClass, source.purpose, ids],
  ));
  if (count.rows.length !== ids.length
      || count.rows.some((row) => !ids.includes(row.registration_id))) {
    throw new Error("X1_SENSITIVE_SUBJECT_CONSENT_MISSING_OR_EXPIRED");
  }
}

/** Consent is a subject-owned, expiring owner record. No title or discovered
 * source record can create it. */
export async function grantInstitutionSubjectConsent(ctx: PeMutationContext, input: {
  institutionId: string; sourceClass: "personnel_benefits" | "expense_administration";
  purpose: string; expiresAt: Date;
}): Promise<void> {
  if (!input.institutionId || !input.purpose || !Number.isFinite(input.expiresAt.valueOf())
      || input.expiresAt <= new Date()) throw new Error("X1_CONSENT_INVALID");
  await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, isolation: "serializable" }, async (_db, client) => {
    const result = await client.query(
      `SELECT * FROM finnor_os.x1_set_subject_consent($1,$2,$3,$4,false)`,
      [input.institutionId, input.sourceClass, input.purpose, input.expiresAt],
    );
    if (result.rowCount !== 1) throw new Error("X1_CONSENT_WRITE_FAILED");
  });
}

/** Mandate is read from Work-owned immutable revision, never from a candidate. */
export async function readInstitutionMandate(
  ctx: PeMutationContext, workId: string,
): Promise<OriginalInstitutionEvidence["mandate"]> {
  return withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, async (_db, client) => {
    const result = await client.query<{
      id: string; standing_id:string; revision: string; institution_id: string; rules: OriginalInstitutionEvidence["mandate"]["rules"];
    }>(
      `SELECT m.id::text,m.standing_id::text,m.revision,m.institution_id,m.rules
         FROM finnor_os.x1_work_mandates m JOIN finnor_os.works w
           ON w.tenant_id=m.tenant_id AND w.id=m.work_id
        WHERE m.tenant_id=$1 AND m.work_id=$2 AND m.principal_id=$3
          AND w.created_by=$3 AND m.valid_from<=clock_timestamp()
          AND m.expires_at>clock_timestamp() AND m.revoked_at IS NULL
        ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
      [ctx.auth.tenantId, workId, ctx.auth.userId],
    );
    const row = result.rows[0];
    if (!row || !Array.isArray(row.rules) || row.rules.length > 128) throw new Error("X1_CURRENT_MANDATE_UNAVAILABLE");
    return { id: row.id, standingId:row.standing_id,revision: row.revision, tenantId: ctx.auth.tenantId,
      institutionId: row.institution_id, workId, rules: row.rules };
  });
}
