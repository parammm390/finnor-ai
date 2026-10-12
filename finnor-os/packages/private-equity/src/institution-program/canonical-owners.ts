import type { PoolClient } from "pg";
import { withTenantTransaction } from "@finnor/db";
import type { PeMutationContext } from "../types";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import type { DigitalInstitutionProfile } from "./contracts";
import type { OriginalInstitutionEvidence } from "./checker";
import { institutionDigest } from "./canonical-json";
import { lockInstitutionSourceAuthority } from "./source-locks";

/** Closed owner registry; source data never selects a SQL table or predicate. */
const PE = {
  investment_case: { table: "pe_investment_cases", entity: "pe_investment_case", current: "archived_at IS NULL AND superseded_at IS NULL" },
  facility: { table: "pe_debt_facilities", entity: "pe_debt_facility", current: "superseded_at IS NULL AND valid_to IS NULL AND status NOT IN('cancelled','repaid')" },
  metric: { table: "pe_metric_series", entity: "pe_metric_series", current: "active" },
  request: { table: "pe_requests", entity: "pe_request", current: "archived_at IS NULL" },
  finding: { table: "pe_findings", entity: "pe_finding", current: "archived_at IS NULL AND superseded_at IS NULL" },
  decision: { table: "pe_decisions", entity: "pe_decision", current: "superseded_at IS NULL" },
} as const;
const RELATIONS = [
  { table: "pe_fund_vehicle_links", entity: "pe_fund_vehicle_link", current: "superseded_at IS NULL AND valid_to IS NULL" },
  { table: "pe_company_party_roles", entity: "pe_company_party_role", current: "superseded_at IS NULL AND valid_to IS NULL" },
  { table: "pe_debt_facility_lenders", entity: "pe_debt_facility_lender", current: "superseded_at IS NULL AND valid_to IS NULL" },
  { table: "pe_dependencies", entity: "pe_dependency", current: "removed_at IS NULL" },
] as const;
type Entity = OriginalInstitutionEvidence["canonical"]["entities"][number];
type Parsed = { entityType: string; entityId: string; revision: string };
export function parseInstitutionOwnerRef(ref: string): Parsed | null {
  const m=/^([a-z_]+):([a-f0-9-]{36})@(v[1-9]\d*|s[a-f0-9]{64})$/.exec(ref);
  return m?{entityType:m[1]!,entityId:m[2]!,revision:m[3]!}:null;
}
const coreRef=(type:string,id:string,preimage:unknown)=>`${type}:${id}@s${institutionDigest(preimage)}`;
const documentHeads=`coalesce((SELECT jsonb_agg(jsonb_build_object('kind',h.kind,'headKey',h.head_key,
  'versionId',h.version_id,'sha256',v.byte_sha256) ORDER BY h.kind,h.head_key)
  FROM finnor_os.document_version_heads h JOIN finnor_os.document_versions v
    ON v.tenant_id=h.tenant_id AND v.id=h.version_id AND v.document_id=h.document_id
  WHERE h.tenant_id=d.tenant_id AND h.document_id=d.id),'[]'::jsonb)`;

export async function readAdditionalInstitutionOwners(ctx:PeMutationContext,original:OriginalInstitutionEvidence,
  identifiers:string[],profile:DigitalInstitutionProfile):Promise<Entity[]>{
  const entities=await withTenantTransaction(ctx.auth.tenantId,{userId:ctx.auth.userId,readOnly:true,isolation:"repeatable read"},async(_db,c)=>{
    const found:Entity[]=[];
    const push=(ref:string,entityType:string,registrationId:string,sourceId?:string,ownerWitness?:Record<string,unknown>)=>{
      if(found.some(e=>e.ref===ref&&e.registrationId===registrationId&&e.sourceId===sourceId))return;
      if(found.length>=profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
      found.push({ref,entityType,registrationId,institutionId:original.institutionId,
        ...(sourceId?{sourceId}:{}),...(ownerWitness?{ownerWitness}:{})});
    };
    for(const [kind,owner] of [...Object.entries(PE),...RELATIONS.map(owner=>["relationship",owner] as const)]){
      const rows=(await c.query<{id:string;version:number;external_id:string}>(`SELECT id::text,version,external_id
        FROM finnor_os.${owner.table} WHERE tenant_id=$1 AND source_system=$2
        AND external_id=ANY($3::text[]) AND ${owner.current} ORDER BY external_id,id LIMIT $4`,
      [ctx.auth.tenantId,`x1:${original.institutionId}`,identifiers,profile.bounds.canonicalReferences+1])).rows;
      if(rows.length>profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
      for(const row of rows)push(`${owner.entity}:${row.id}@v${row.version}`,kind,row.external_id);
    }
    // Identity-owner bindings are source-scoped and evidence-backed. A matching
    // display name, email body or employee number from another source is ignored.
    const people=(await c.query<{subject_user_id:string;registration_id:string;source_id:string;revision:number;id:string}>(
      `SELECT b.id::text,b.subject_user_id::text,b.registration_id,b.source_id,b.revision
       FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users u
        ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
       WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.registration_id=ANY($3::text[])
        AND b.source_id=ANY($4::text[]) AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp()
        AND b.expires_at>clock_timestamp() AND u.status='active' ORDER BY b.source_id,b.registration_id LIMIT $5`,
      [ctx.auth.tenantId,original.institutionId,identifiers,original.sources.filter(s=>!s.ownerCoverageGap).map(s=>s.id),profile.bounds.canonicalReferences+1])).rows;
    if(people.length>profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
    if(new Set(people.map(p=>p.subject_user_id)).size>profile.bounds.people)throw Error("X1_PERSON_BOUND");
    for(const p of people){const proof={bindingId:p.id,sourceId:p.source_id,registrationId:p.registration_id,revision:p.revision};
      push(coreRef("user",p.subject_user_id,proof),"person",p.registration_id,p.source_id,proof);}
    const counterparties=(await c.query<{id:string;organization_key:string}>(`SELECT id::text,organization_key
      FROM finnor_os.external_organizations WHERE tenant_id=$1 AND organization_key=ANY($2::text[]) AND active ORDER BY id LIMIT $3`,
      [ctx.auth.tenantId,identifiers,profile.bounds.canonicalReferences+1])).rows;
    if(counterparties.length>profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
    for(const p of counterparties){const proof={organizationKey:p.organization_key,active:true};
      push(coreRef("external_organization",p.id,proof),"counterparty",p.organization_key,undefined,proof);}
    const documents=(await c.query<{id:string;external_id:string|null;source_system:string|null;heads:unknown[]}>(`SELECT d.id::text,d.external_id,d.source_system,${documentHeads} heads
      FROM finnor_os.documents d WHERE d.tenant_id=$1 AND d.archived_at IS NULL
       AND ((d.source_system=$2 AND d.external_id=ANY($3::text[])) OR d.id::text=ANY($3::text[])) ORDER BY d.id LIMIT $4`,
      [ctx.auth.tenantId,`x1:${original.institutionId}`,identifiers,profile.bounds.canonicalReferences+1])).rows;
    if(documents.length>profile.bounds.canonicalReferences)throw Error("X1_CANONICAL_REFERENCE_BOUND");
    for(const p of documents){const proof={id:p.id,externalId:p.external_id,sourceSystem:p.source_system,heads:p.heads};
      push(coreRef("document",p.id,proof),"document",identifiers.includes(p.id)?p.id:p.external_id!,undefined,proof);}
    if(identifiers.includes(original.workId)){
      const work=(await c.query<{id:string;created_by:string}>("SELECT id::text,created_by FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND created_by=$3",
        [ctx.auth.tenantId,original.workId,original.principalId])).rows[0];
      if(work){const proof={id:work.id,principalId:work.created_by};push(coreRef("work",work.id,proof),"work",work.id,undefined,proof);}
    }
    return found;
  });
  const refs=entities.map(e=>parseInstitutionOwnerRef(e.ref)!);
  await authorizeBeliefResources(ctx,refs.map(r=>({type:r.entityType,id:r.entityId})));
  return entities;
}

/** Publication locks a genuine current owner row and returns its stable
 * identity; Core version tokens are owner preimages, not invented counters. */
export async function lockAdditionalInstitutionOwner(c:PoolClient,ctx:PeMutationContext,
  original:OriginalInstitutionEvidence,ref:string,registrationId:string,sourceId:string,grantId:string){
  const parsed=parseInstitutionOwnerRef(ref);if(!parsed)throw Error("X1_CANONICAL_OWNER_REF_INVALID");
  const pe=[...Object.values(PE),...RELATIONS].find(owner=>owner.entity===parsed.entityType);
  if(pe){
    const row=(await c.query<{id:string;version:number;external_id:string;deal_id?:string}>(`SELECT *
      FROM finnor_os.${pe.table} WHERE tenant_id=$1 AND id=$2 AND source_system=$3 AND external_id=$4
       AND ${pe.current} FOR UPDATE`,[ctx.auth.tenantId,parsed.entityId,`x1:${original.institutionId}`,registrationId])).rows[0];
    if(!row||parsed.revision!==`v${row.version}`)throw Error("X1_CANONICAL_ENTITY_CHANGED_DURING_ADMISSION");
    return {entityType:pe.entity,entityId:parsed.entityId,dealId:row.deal_id??null,kind:"PE" as const};
  }
  let expected:string|null=null;
  if(parsed.entityType==="user"){
    await lockInstitutionSourceAuthority(ctx,c,original.workId,[grantId]);
    const rows=(await c.query<{id:string;source_id:string;registration_id:string;revision:number}>(`SELECT b.id::text,b.source_id,b.registration_id,b.revision
      FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
      WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.subject_user_id=$3 AND b.registration_id=$4
       AND b.source_id=$5 AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
       AND u.status='active' FOR SHARE OF u`,[ctx.auth.tenantId,original.institutionId,parsed.entityId,registrationId,sourceId])).rows;
    if(rows.length===1){const p=rows[0]!;expected=coreRef("user",parsed.entityId,{bindingId:p.id,sourceId:p.source_id,registrationId:p.registration_id,revision:p.revision});}
  }else if(parsed.entityType==="external_organization"){
    const row=(await c.query<{organization_key:string}>("SELECT organization_key FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2 AND organization_key=$3 AND active FOR SHARE",
      [ctx.auth.tenantId,parsed.entityId,registrationId])).rows[0];
    if(row)expected=coreRef(parsed.entityType,parsed.entityId,{organizationKey:row.organization_key,active:true});
  }else if(parsed.entityType==="document"){
    const row=(await c.query<{id:string;external_id:string|null;source_system:string|null;heads:unknown[]}>(`SELECT d.id::text,d.external_id,d.source_system,${documentHeads} heads FROM finnor_os.documents d
      WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL AND (d.id::text=$3 OR (d.source_system=$4 AND d.external_id=$3)) FOR SHARE OF d`,
      [ctx.auth.tenantId,parsed.entityId,registrationId,`x1:${original.institutionId}`])).rows[0];
    if(row)expected=coreRef(parsed.entityType,row.id,{id:row.id,externalId:row.external_id,sourceSystem:row.source_system,heads:row.heads});
  }else if(parsed.entityType==="work"){
    const row=(await c.query<{id:string;created_by:string}>("SELECT id::text,created_by FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND id::text=$3 AND created_by=$4 FOR SHARE",
      [ctx.auth.tenantId,parsed.entityId,registrationId,original.principalId])).rows[0];
    if(row)expected=coreRef(parsed.entityType,row.id,{id:row.id,principalId:row.created_by});
  }
  if(expected!==ref)throw Error("X1_CANONICAL_ENTITY_CHANGED_DURING_ADMISSION");
  return {entityType:parsed.entityType,entityId:parsed.entityId,dealId:null,kind:"CORE" as const};
}
