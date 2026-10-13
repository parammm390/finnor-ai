/** Actual canonical/provider-owned rows. No compiler summary, inference or oracle. */
import {createHash} from 'node:crypto';
import {getPool,withTenantClientTransaction} from '@finnor/db';
import {callAuthenticatedOwner,type OwnerEndpoint,type IndependentReadProjection} from './qualification-runtime.mts';
import type {z} from 'zod';
import {originalRawRecords} from '../../../packages/private-equity/src/institution-program/checker-raw';
import {mappingMeaning,mappingIdentity,dutyIdentity,obligationMeaning,nativeCreationMeaning,normalizeCanonicalFields,normalizedInstant} from './qualification-meaning.mts';
import {loadInstitutionProfile} from '../../../packages/private-equity/src/institution-program/store';
import {parseInstitutionOwnerRef} from '../../../packages/private-equity/src/institution-program/canonical-owners';
import {institutionDigest} from '../../../packages/private-equity/src/institution-program/canonical-json';
import type {PoolClient} from 'pg';
type Selector=NonNullable<z.infer<typeof IndependentReadProjection>['nativeSelector']>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Closed native owner readers, independent of compiler inference and output. */
const peOwners:Record<string,{table:string;current:string;workScoped?:boolean}>={
  pe_deal:{table:'pe_deals',current:"archived_at IS NULL AND status='active'",workScoped:true},
  pe_fund:{table:'pe_funds',current:"status<>'liquidated'",workScoped:true},
  pe_vehicle:{table:'pe_vehicles',current:"status<>'liquidated'",workScoped:true},
  pe_investment_case:{table:'pe_investment_cases',current:'archived_at IS NULL AND superseded_at IS NULL'},
  pe_debt_facility:{table:'pe_debt_facilities',current:"superseded_at IS NULL AND valid_to IS NULL AND status NOT IN('cancelled','repaid')"},
  pe_metric_series:{table:'pe_metric_series',current:'active'},
  pe_request:{table:'pe_requests',current:'archived_at IS NULL'},
  pe_finding:{table:'pe_findings',current:'archived_at IS NULL AND superseded_at IS NULL'},
  pe_decision:{table:'pe_decisions',current:'superseded_at IS NULL'},
  pe_fund_vehicle_link:{table:'pe_fund_vehicle_links',current:'superseded_at IS NULL AND valid_to IS NULL'},
  pe_company_party_role:{table:'pe_company_party_roles',current:'superseded_at IS NULL AND valid_to IS NULL'},
  pe_debt_facility_lender:{table:'pe_debt_facility_lenders',current:'superseded_at IS NULL AND valid_to IS NULL'},
  pe_dependency:{table:'pe_dependencies',current:'removed_at IS NULL'},
};
async function actualMappingAttachment(c:PoolClient,owner:OwnerEndpoint,workId:string,row:any,registrationId:string,
  measured:<T>(read:()=>Promise<T>)=>Promise<T>){
  const ref=parseInstitutionOwnerRef(row.canonicalCandidate);
  if(!ref||!Array.isArray(row.entityRefs)||!row.entityRefs.some((e:any)=>e.type===ref.entityType&&e.id===ref.entityId))return false;
  const pe=peOwners[ref.entityType];let current=false,requiresPeLink=false;
  if(pe){
    const native=(await measured(()=>c.query(`SELECT * FROM finnor_os.${pe.table} n WHERE n.tenant_id=$1 AND n.id=$2
      AND n.external_id=$3 AND ${pe.current} AND (n.source_system=$4 ${pe.workScoped?`OR EXISTS(SELECT 1 FROM finnor_os.work_entity_links w
        WHERE w.tenant_id=n.tenant_id AND w.work_id=$5 AND w.entity_type=$6 AND w.entity_id=n.id)`:''})`,
      pe.workScoped?[owner.tenantId,ref.entityId,registrationId,'x1:'+row.institutionId,workId,ref.entityType]
        :[owner.tenantId,ref.entityId,registrationId,'x1:'+row.institutionId]))).rows[0];
    current=Boolean(native&&ref.revision==='v'+native.version);
    requiresPeLink=Boolean(native&&(native.deal_id||['pe_deal','pe_fund','pe_vehicle'].includes(ref.entityType)));
  }else{
    let proof:unknown;
    if(ref.entityType==='user'){
      const bindings=(await measured(()=>c.query(`SELECT b.id::text,b.source_id,b.registration_id,b.revision FROM finnor_os.x1_subject_identity_bindings b
        JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
        WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.subject_user_id=$3 AND b.registration_id=$4 AND b.source_id=$5
          AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp() AND u.status='active'`,
        [owner.tenantId,row.institutionId,ref.entityId,registrationId,row.sourceId]))).rows;
      if(bindings.length===1){const b=bindings[0];proof={bindingId:b.id,sourceId:b.source_id,registrationId:b.registration_id,revision:b.revision};}
    }else if(ref.entityType==='external_organization'){
      const n=(await measured(()=>c.query(`SELECT organization_key FROM finnor_os.external_organizations
        WHERE tenant_id=$1 AND id=$2 AND organization_key=$3 AND active`,[owner.tenantId,ref.entityId,registrationId]))).rows[0];
      if(n)proof={organizationKey:n.organization_key,active:true};
    }else if(ref.entityType==='document'){
      const n=(await measured(()=>c.query(`SELECT d.id::text,d.external_id,d.source_system,COALESCE((SELECT jsonb_agg(
        jsonb_build_object('kind',h.kind,'headKey',h.head_key,'versionId',h.version_id,'sha256',v.byte_sha256) ORDER BY h.kind,h.head_key)
        FROM finnor_os.document_version_heads h JOIN finnor_os.document_versions v
          ON v.tenant_id=h.tenant_id AND v.id=h.version_id AND v.document_id=h.document_id
        WHERE h.tenant_id=d.tenant_id AND h.document_id=d.id),'[]'::jsonb) heads FROM finnor_os.documents d
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.archived_at IS NULL
          AND (d.id::text=$3 OR (d.source_system=$4 AND d.external_id=$3))`,
        [owner.tenantId,ref.entityId,registrationId,'x1:'+row.institutionId]))).rows[0];
      if(n)proof={id:n.id,externalId:n.external_id,sourceSystem:n.source_system,heads:n.heads};
    }else if(ref.entityType==='work'){
      const n=(await measured(()=>c.query(`SELECT id::text,created_by FROM finnor_os.works
        WHERE tenant_id=$1 AND id=$2 AND id::text=$3 AND created_by=$4`,[owner.tenantId,ref.entityId,registrationId,owner.principalId]))).rows[0];
      if(n)proof={id:n.id,principalId:n.created_by};
    }
    current=proof!==undefined&&ref.revision==='s'+institutionDigest(proof);
  }
  if(!current)return false;
  if(requiresPeLink)return (await measured(()=>c.query(`SELECT 1 FROM finnor_os.pe_evidence_links
    WHERE tenant_id=$1 AND evidence_source_id=$2 AND evidence_version_id=$3 AND entity_type=$4 AND entity_id=$5
      AND archived_at IS NULL`,[owner.tenantId,row.evidenceSourceId,row.evidenceVersionId,ref.entityType,ref.entityId]))).rowCount!==0;
  return true;
}

export async function readNativeObservationSnapshot(owner:OwnerEndpoint,selector:Selector,deadlineAt:number,
  measured:<T>(read:()=>Promise<T>)=>Promise<T>=async read=>read()){
  const database=new URL(process.env.DATABASE_URL??'');
  if(!['127.0.0.1','localhost','[::1]'].includes(database.hostname))throw Error('NATIVE_OBSERVER_DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  const role=(await measured(()=>getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user`))).rows[0];
  if(!role||role.current_user!=='finnor_app'||role.rolsuper||role.rolbypassrls||role.app_inherits_worker)
    throw Error('NATIVE_OBSERVER_RESTRICTED_APP_ROLE_REQUIRED');
  const authorised=await measured(()=>callAuthenticatedOwner(owner,{path:'/api/company-brain/institution-sources',method:'POST',body:{workId:selector.workId}},
    {deadlineAt,maxResponseBytes:1024*1024}));
  if(authorised.status!==200||authorised.body.workId!==selector.workId)throw Error('NATIVE_OBSERVER_AUTHENTICATED_ORIGINAL_WORK_REQUIRED');
  const rows=await withTenantClientTransaction(owner.tenantId,{userId:owner.principalId,readOnly:true},async c=>{
    await c.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.min(20000,deadlineAt-Date.now())))]);
    const original=(await measured(()=>c.query(`SELECT e.parent_reservation,e.original_deadline FROM finnor_os.x1_compiler_episodes e
      JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.id=$3 AND r.work_id=$4 LIMIT 1`,
      [owner.tenantId,owner.principalId,selector.originalEpisodeId,selector.workId]))).rows[0];
    if(!original?.parent_reservation||sha(JSON.stringify(original.parent_reservation))!==selector.originalGrantDigest
      ||original.original_deadline.toISOString()!==selector.originalDeadline)throw Error('NATIVE_OBSERVER_ORIGINAL_PARENT_OR_DEADLINE_CHANGED');
    const args=[owner.tenantId,owner.principalId,selector.workId,selector.originalEpisodeId];
    if(selector.kind==='S1_MAPPING_CLAIMS'){
      if(!selector.sourceIds?.length)throw Error('EXACT_NATIVE_SOURCE_POPULATION_REQUIRED');
      return (await measured(()=>c.query(`SELECT v.snapshot||jsonb_build_object('evidenceSourceId',s.id,'evidenceVersionId',v.id,
        'entityRefs',ch.entity_refs,'x1_observed_at',clock_timestamp(),'protocol',g.protocol,'sourceClass',g.source_class,
        'grantId',g.id,'institutionId',g.institution_id) body
        FROM finnor_os.evidence_sources s JOIN finnor_os.evidence_source_versions v ON v.tenant_id=s.tenant_id AND v.source_id=s.id
        JOIN finnor_os.evidence_chunks ch ON ch.tenant_id=v.tenant_id AND ch.source_id=v.source_id AND ch.version_id=v.id
        JOIN finnor_os.x1_source_grants g ON g.tenant_id=v.tenant_id AND g.source_id=v.snapshot->>'sourceId'
          AND g.document_id::text=v.snapshot->>'documentId' AND g.document_version_id::text=v.snapshot->>'documentVersionId'
        WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.work_id=$3 AND g.source_id=ANY($5::text[])
          AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          AND (finnor_os.x1_source_scope($3,g.id)->'body'->>'originalReadAllowed')::boolean
          AND g.original_sha256=v.snapshot->>'originalSha256'
          AND EXISTS(SELECT 1 FROM finnor_os.x1_compiler_requests r WHERE r.tenant_id=g.tenant_id AND r.work_id=$3 AND r.episode_id=$4)
        ORDER BY s.id,v.id,ch.id LIMIT 150001`,[...args,selector.sourceIds]))).rows.map(r=>r.body);
    }
    if(selector.kind==='P1_OBLIGATION_CLAIMS')return (await measured(()=>c.query(`SELECT node||jsonb_build_object('programId',q.id,
      'responsibility',responsibility,'principalId',q.principal_id,'x1_observed_at',clock_timestamp()) body FROM finnor_os.x1_compiler_requests r
      JOIN finnor_os.p1_requests q ON q.tenant_id=r.tenant_id AND q.id=r.program_id
      JOIN finnor_os.p1_programs p ON p.tenant_id=q.tenant_id AND p.id=q.head_id AND p.request_id=q.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.body->'nodes','[]'::jsonb)) node
      JOIN LATERAL jsonb_array_elements(COALESCE(q.request->'institution'->'responsibilities','[]'::jsonb)) responsibility
        ON responsibility->'obligation'->>'stableIdentity'=node->>'stableIdentity'
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4
        AND r.revision=(SELECT max(latest.revision) FROM finnor_os.x1_compiler_requests latest
          WHERE latest.tenant_id=r.tenant_id AND latest.principal_id=$2 AND latest.work_id=$3)
      ORDER BY q.id,node->>'id' LIMIT 3841`,args))).rows.map(r=>r.body);
    const table=selector.kind==='REQUEST_ROWS'?'pe_requests':selector.kind==='WORKSTREAM_ROWS'?'pe_workstreams':'pe_findings';
    return (await measured(()=>c.query(`WITH current_program AS(SELECT p.body FROM finnor_os.x1_compiler_requests r
      JOIN finnor_os.p1_requests q ON q.tenant_id=r.tenant_id AND q.id=r.program_id
      JOIN finnor_os.p1_programs p ON p.tenant_id=q.tenant_id AND p.id=q.head_id AND p.request_id=q.id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4
        AND r.revision=(SELECT max(latest.revision) FROM finnor_os.x1_compiler_requests latest
          WHERE latest.tenant_id=r.tenant_id AND latest.principal_id=$2 AND latest.work_id=$3))
      SELECT jsonb_build_object('identity',a.authority_context->>'stableIdentity','actionId',a.id,
      'actionStatus',a.status,'effectStatus',e.status,'operation',a.action_type,'responsibility',responsibility,
      'originNode',origin_node,'currentNode',current_intent.current_node,
      'fields',to_jsonb(n),'x1_observed_at',clock_timestamp(),
      'x1_committed_at',CASE WHEN current_setting('track_commit_timestamp')='on' THEN pg_xact_commit_timestamp(n.xmin) ELSE NULL END) body
      FROM finnor_os.domain_actions a LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id
      JOIN finnor_os.${table} n ON n.tenant_id=a.tenant_id AND n.id=a.id
      JOIN finnor_os.p1_requests owner_request ON owner_request.tenant_id=a.tenant_id AND owner_request.id::text=a.authority_context->>'programId'
      JOIN finnor_os.p1_programs origin_program ON origin_program.tenant_id=owner_request.tenant_id
        AND origin_program.id=owner_request.head_id AND origin_program.request_id=owner_request.id
      JOIN LATERAL jsonb_array_elements(COALESCE(origin_program.body->'nodes','[]'::jsonb)) origin_node
        ON origin_node->>'stableIdentity'=a.authority_context->>'stableIdentity'
      LEFT JOIN LATERAL(SELECT node current_node FROM current_program p
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.body->'nodes','[]'::jsonb)) node
        WHERE node->>'stableIdentity'=a.authority_context->>'stableIdentity') current_intent ON true
      JOIN LATERAL jsonb_array_elements(COALESCE(owner_request.request->'institution'->'responsibilities','[]'::jsonb)) responsibility
        ON responsibility->'obligation'->>'stableIdentity'=a.authority_context->>'stableIdentity'
      WHERE a.tenant_id=$1 AND a.initiated_by=$2 AND a.work_id=$3 AND a.authority_context->>'kind'='institution_duty'
        AND EXISTS(SELECT 1 FROM finnor_os.p1_requests q JOIN finnor_os.x1_compiler_requests r
          ON r.tenant_id=q.tenant_id AND r.program_id=q.id WHERE q.tenant_id=a.tenant_id
            AND q.id::text=a.authority_context->>'programId' AND q.principal_id=$2 AND q.work_id=$3 AND r.episode_id=$4
            AND q.work_input_id::text=a.authority_context->>'workInputId')
        AND NOT EXISTS(SELECT 1 FROM finnor_os.s6_obligation_origins o WHERE o.tenant_id=a.tenant_id AND o.domain_action_id=a.id)
      ORDER BY a.id,e.id LIMIT 3841`,args))).rows.map(r=>r.body);
  });
  if(rows.length>(selector.kind==='S1_MAPPING_CLAIMS'?150000:3840))throw Error('ORIGINAL_NATIVE_OBSERVER_ROW_BOUND');
  const profile=loadInstitutionProfile(),decoded=new Map<string,Awaited<ReturnType<typeof originalRawRecords>>>();let rawBytes=0;
  for(const row of rows){
    if(selector.kind==='S1_MAPPING_CLAIMS'){
      const originalKey=row.documentVersionId+'/'+row.originalSha256;
      let records=decoded.get(originalKey);
      if(!records){
        if(decoded.size>=profile.bounds.sourceInstances)throw Error('NATIVE_OBSERVER_ORIGINAL_SOURCE_BOUND');
        const loaded=await withTenantClientTransaction(owner.tenantId,{userId:owner.principalId,readOnly:true},async c=>
          (await measured(()=>c.query(`SELECT contents.bytes FROM finnor_os.x1_source_grants g
            JOIN finnor_os.document_version_contents contents ON contents.tenant_id=g.tenant_id AND contents.version_id=g.document_version_id
            WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.work_id=$3 AND g.id=$4
              AND g.original_sha256=$5 AND (finnor_os.x1_source_scope($3,g.id)->'body'->>'originalReadAllowed')::boolean
              AND contents.size_bytes<=$6`,[owner.tenantId,owner.principalId,selector.workId,row.grantId,row.originalSha256,profile.bounds.objectBytes]))).rows[0]);
        if(!loaded?.bytes)throw Error('CURRENT_NATIVE_OBSERVER_ORIGINAL_READ_REQUIRED');const bytes=Buffer.from(loaded.bytes);rawBytes+=bytes.length;
        if(rawBytes>profile.bounds.rawBytes||createHash('sha256').update(bytes).digest('hex')!==row.originalSha256)
          throw Error('NATIVE_OBSERVER_ORIGINAL_BYTE_PREIMAGE_OR_AGGREGATE_BOUND');
        const binary=['xlsx','docx','pdf_text'].includes(row.protocol);
        records=await originalRawRecords({sourceClass:row.sourceClass,protocol:row.protocol,
          rawUtf8:binary?'':bytes.toString('utf8'),...(binary?{rawBase64:bytes.toString('base64')}:{})},
          profile.bounds.tabularRowsPerObject,profile.bounds.objectBytes);decoded.set(originalKey,records);
      }
      const record=records.find(r=>r.id===row.objectId);if(!record)throw Error('ACTUAL_IMMUTABLE_ORIGINAL_RECORD_REQUIRED');
      const claimedRecord=row.sourceQuantity?{...record,...row.sourceQuantity}:record;
      row.meaning=mappingMeaning({sourceId:row.sourceId,recordId:row.objectId,originalSha256:row.originalSha256,
        canonicalRef:row.canonicalCandidate,record:claimedRecord});
      row.meaningIdentity=mappingIdentity(row.sourceId,row.objectId,row.originalSha256);
      row.nativePredicatesSatisfied=await withTenantClientTransaction(owner.tenantId,{userId:owner.principalId,readOnly:true},
        c=>actualMappingAttachment(c,owner,selector.workId,row,record.registrationId!,measured));
      if(!row.nativePredicatesSatisfied)row.nativePredicateGap='CURRENT_CANONICAL_OWNER_OR_EXACT_EVIDENCE_ATTACHMENT_ABSENT';
    }else{
      const obligation=row.responsibility?.obligation;
      if(!obligation?.trigger?.sourceId||!obligation.trigger.recordId||!obligation.rule?.id)throw Error('ACTUAL_NATIVE_DUTY_ORIGINAL_REF_REQUIRED');
      row.meaningIdentity=dutyIdentity(obligation.trigger.sourceId,obligation.trigger.recordId,obligation.rule.id);
      if(selector.kind==='P1_OBLIGATION_CLAIMS'){
        const businessFields=nativeCreationMeaning(row.operation,row.action?.payload??{});
        const canonicalRef=obligation.preconditions?.find((p:any)=>/^pe_deal:/.test(p.ref))?.ref;
        if(!canonicalRef)throw Error('ACTUAL_NATIVE_DUTY_CANONICAL_REF_REQUIRED');
        row.meaning=obligationMeaning({sourceId:obligation.trigger.sourceId,recordId:obligation.trigger.recordId,ruleId:obligation.rule.id,
          canonicalRef,operation:row.operation,principalId:obligation.responsiblePrincipal,deadlineAt:row.deadlineAt,businessFields});
        row.nativePredicatesSatisfied=true;
      }else{
        const f=row.fields,operation=selector.kind==='REQUEST_ROWS'?'create_deal_request':selector.kind==='WORKSTREAM_ROWS'?'open_workstream':'record_finding';
        const template=nativeCreationMeaning(operation,{dealId:f.deal_id,owner:{partyType:f.owner_party_type,partyId:f.owner_party_id},
          workstreamId:f.workstream_id,requestedFromDealPartyId:f.requested_from_deal_party_id,requestText:f.request_text,
          requestedAt:f.requested_at,dueAt:f.due_at,requiresAcceptedDeliverable:f.requires_accepted_deliverable,
          kind:f.kind,name:f.name,statement:f.statement,severity:f.severity,materiality:f.materiality,
          relatedRequestId:f.related_request_id,relatedDeliverableId:f.related_deliverable_id,requiredForWorkstreamCompletion:f.required_for_workstream_completion});
        row.meaning=normalizeCanonicalFields(Object.fromEntries(Object.keys(template).map(key=>[key,f[key]])));
        const current=row.currentNode,origin=row.originNode;
        row.nativePredicatesSatisfied=Boolean(current&&origin&&current.action?.payload&&origin.action?.payload
          &&row.operation===operation&&current.operation===operation
          &&origin.operation===operation&&normalizedInstant(current.deadlineAt)===normalizedInstant(origin.deadlineAt)
          &&institutionDigest(nativeCreationMeaning(operation,current.action?.payload??{}))
            ===institutionDigest(nativeCreationMeaning(operation,origin.action?.payload??{}))
          &&institutionDigest(row.meaning)===institutionDigest(nativeCreationMeaning(operation,current.action?.payload??{}))
          &&row.actionStatus==='completed'&&row.effectStatus==='verified');
        if(!row.nativePredicatesSatisfied)row.nativePredicateGap='CURRENT_NATIVE_DUTY_INTENT_OR_COMPLETION_NOT_ESTABLISHED';
      }
    }
  }
  const body={workId:selector.workId,originalEpisodeId:selector.originalEpisodeId,selector:selector.kind,
    snapshotStatus:'ACTUAL_NATIVE_OWNER_ROWS_READ',rows,role,authorityGranted:false},bytes=JSON.stringify(body);
  if(Buffer.byteLength(bytes)>6*1024*1024)throw Error('ORIGINAL_NATIVE_OBSERVER_RESPONSE_BOUND');
  return {status:200,body,responseDigest:sha(bytes),responseBytes:Buffer.byteLength(bytes),observedAt:new Date().toISOString()};
}
