import { randomUUID } from 'node:crypto';
import type { PeMutationContext } from '../types';
import type { DecisionAtlas } from '../../../shared-types/src/decision-atlas';
import { principal, resolveDecisionWork } from '../decision-slice/adapters';
import { readAllocationSnapshot, withCanonicalAllocationSnapshot, type AllocationSnapshot } from '../allocation-store';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { validateBeliefViewPin } from '../enterprise-beliefs';
import { assertDependencies } from '../evidence-execution/store';
import { lookupAtlas, type AtlasPointResult } from '../../../epistemic-runtime/src/policy-atlas/query';
import { atlasHash, atlasRef } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { r7Authorize, r7Build, r7Event, r7Family, r7Parameters, r7QueryRecord, r7Tx } from './store';
import { assertR7Owner, readEnterpriseAffinePolicyFamily } from './owners';
import { checkExactAllocation, currentExactParameterValues } from './allocation';
import { r7Physical, R7PhysicalFailure } from './physical';
import { consumeEnterpriseExactAllocation } from './selection';
import { projectR7Choice } from './projection';
import { BuildSchema, QuerySchema, R7Error, type R7BuildRow, type R7Family, type R7Parameters, type R7Query, type R7EventCursorSchema } from './contracts';
export { registerR7Family, reviseR7Parameters } from './owners';
export { continueEnterpriseAtlasBranch } from './continuation';

export async function r7Context(ctx:PeMutationContext,workId:string,root:R7Family['root']){
  await resolveDecisionWork(ctx,workId);
  const head=await r7Tx(ctx,async c=>{await r7Authorize(ctx,c);return (await c.query<{body:R7Family}>(
    'SELECT f.body FROM finnor_os.r7_families f JOIN finnor_os.r7_family_heads h USING(tenant_id,principal_id,content_digest) WHERE h.tenant_id=$1 AND h.principal_id=$2 AND h.work_id=$3 AND h.root_type=$4 AND h.root_id=$5',
    [ctx.auth.tenantId,principal(ctx),workId,root.entityType,root.entityId])).rows[0];});
  if(!head)return {workId,family:null,parameters:null,effectiveValues:null,parameterSources:[],builds:[],lastQuery:null};
  await assertR7Owner(ctx,head.body);
  const rows=await r7Tx(ctx,async c=>(await c.query<{id:string;status:string}>(
    'SELECT id::text,status FROM finnor_os.r7_builds WHERE tenant_id=$1 AND principal_id=$2 AND family_digest=$3 ORDER BY created_at DESC,id DESC LIMIT 16',
    [ctx.auth.tenantId,principal(ctx),head.body.ref.contentDigest])).rows);
  const last=await r7Tx(ctx,async c=>(await c.query<{body:R7Query;status:R7BuildRow['status'];deadline_at:Date}>(
    'SELECT q.body,b.status,b.deadline_at FROM finnor_os.r7_queries q JOIN finnor_os.r7_builds b ON b.tenant_id=q.tenant_id AND b.principal_id=q.principal_id AND b.id=q.build_id WHERE q.tenant_id=$1 AND q.principal_id=$2 AND b.family_digest=$3 ORDER BY q.body->>\'createdAt\' DESC,q.content_digest LIMIT 1',
    [ctx.auth.tenantId,principal(ctx),head.body.ref.contentDigest])).rows[0]??null);
  const parameters=await r7Parameters(ctx,head.body);
  const snapshot=await readAllocationSnapshot(ctx),effectiveValues=currentExactParameterValues(head.body.input.source,snapshot,parameters.values),
    parameterSources=head.body.input.source.domain.parameters.map(p=>({parameterId:p.id,owner:p.owner,
      ref:p.owner==='S5'?snapshot.resources.find(r=>r.resourceId===p.resourceId)!.ref:parameters.ref}));
  const lastQuery=last&&!['CANCELLED','FAILED','INVALIDATED'].includes(last.status)&&last.deadline_at.getTime()>Date.now()&&
    atlasHash(last.body.parameterRef)===atlasHash(parameters.ref)&&last.body.resourceSnapshotDigest===snapshot.snapshotDigest?last.body:null;
  return {workId,family:head.body,parameters,effectiveValues,parameterSources,builds:rows,lastQuery};
}
async function assertQueryPublication(ctx:PeMutationContext,c:PoolClient,current:AllocationSnapshot,b:R7BuildRow,
  family:R7Family,parameters:R7Parameters,snapshotDigest:string){
  await r7Authorize(ctx,c);await assertDependencies(ctx,family.input.dependencies,c,true);await assertR7Owner(ctx,family,c);
  const now=await r7Build(ctx,b.id,c,true),p=await r7Parameters(ctx,family,c);
  if(current.snapshotDigest!==snapshotDigest||now.generation!==b.generation||
    ['CANCELLED','FAILED','INVALIDATED'].includes(now.status)||now.deadline_at.getTime()<=Date.now()||
    atlasHash(p.ref)!==atlasHash(parameters.ref))throw new R7Error('STALE_INPUT','Query publication fenced by current canonical S5/generation/parameter/deadline');
}
export async function submitR7Build(ctx:PeMutationContext,value:unknown){
  const request=BuildSchema.parse(value),family=await r7Family(ctx,request.envelope_inputs.familyRef);
  if(process.env.FINNOR_R7_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production')
    throw new R7Error('CONFIGURATION_REQUIRED','Ordinary exact profile requires explicit disposable runtime; protected method/family/checker/grant admission is absent');
  await readEnterpriseAffinePolicyFamily(ctx,family.ref);
  if(request.existing_work_revision!==family.input.work.inputId||atlasHash(request.problem_ref)!==atlasHash(family.input.familyRef)||
    atlasHash(request.domain_profile_ref)!==atlasHash(family.input.domainRef)||atlasHash(request.budget_grant_ref)!==atlasHash(family.grantRef)||
    atlasHash(request.cancellation_ref)!==atlasHash(family.cancellationRef))throw new R7Error('CONFLICT','Original common run inputs differ from owner binding');
  const requestDigest=atlasHash(request);
  return r7Tx(ctx,async c=>{
    await r7Authorize(ctx,c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7007))',
      [ctx.auth.tenantId+':'+principal(ctx)+':'+family.input.work.id]);
    await assertDependencies(ctx,family.input.dependencies,c,true);
    const prior=(await c.query<{id:string;request_digest:string;status:string}>(
      'SELECT id,request_digest,status FROM finnor_os.r7_builds WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
    if(prior){if(prior.request_digest!==requestDigest)throw new R7Error('CONFLICT');return {buildId:prior.id,status:prior.status,replayed:true};}
    const grant=(await c.query<{deadline_at:Date}>('SELECT deadline_at FROM finnor_os.r7_episodes WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3 FOR SHARE',
      [ctx.auth.tenantId,principal(ctx),family.episodeId])).rows[0];
    if(!grant||grant.deadline_at.getTime()<=Date.now())throw new R7Error('LIMIT_EXCEEDED','Original episode expired');
    const id=randomUUID();
    await c.query('INSERT INTO finnor_os.r7_builds(id,tenant_id,principal_id,work_id,family_digest,episode_id,deadline_at,idempotency_key,request_digest,request,input) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)',
      [id,ctx.auth.tenantId,principal(ctx),family.input.work.id,family.ref.contentDigest,family.episodeId,grant.deadline_at,
        request.idempotencyKey,requestDigest,JSON.stringify(request),JSON.stringify(family.input)]);
    await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety) VALUES($1,'run_decision_atlas_v1',$2::jsonb,$3,'interactive',0,1,'locally_idempotent')",
      [ctx.auth.tenantId,JSON.stringify({tenantId:ctx.auth.tenantId,principalId:principal(ctx),buildId:id,generation:1}),`r7:${id}:1`]);
    return {buildId:id,status:'QUEUED',replayed:false};
  });
}
export async function invalidateR7(ctx:PeMutationContext,b:R7BuildRow,code:string){
  return r7Tx(ctx,async c=>{
    const now=await r7Build(ctx,b.id,c,true);
    if(!['CANCELLED','INVALIDATED','FAILED'].includes(now.status)){
      await c.query("UPDATE finnor_os.r7_builds SET status='INVALIDATED',generation=generation+1,failure=$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId,principal(ctx),b.id,JSON.stringify({code,requirement:'Original owner/source/structure/rights/method changed; historical claims and costs retained'})]);
      await r7Event(ctx,b.id,randomUUID(),'INVALIDATED',{code,historicalResultDigest:b.result_digest,costsRetained:true},c);
    }
    return {buildId:b.id,workId:b.work_id,status:now.status==='CANCELLED'?'CANCELLED':'INVALIDATED',atlas:null,deadlineAt:b.deadline_at.toISOString(),failure:{code}};
  });
}
export async function readR7Build(ctx:PeMutationContext,id:string,eventsAfter?:z.infer<typeof R7EventCursorSchema>){
  const b=await r7Build(ctx,id);await resolveDecisionWork(ctx,b.work_id);
  const page=await r7Tx(ctx,async c=>(await c.query<{id:string;kind:string;body:unknown;created_at:Date;cursor_at:string}>(
    `SELECT id::text,kind,body,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
     FROM finnor_os.r7_events WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3
     AND ($4::timestamptz IS NULL OR (created_at,id)>($4::timestamptz,$5::uuid))
     ORDER BY created_at,id LIMIT 129`,
    [ctx.auth.tenantId,principal(ctx),id,eventsAfter?.at??null,eventsAfter?.id??null])).rows),
    events=page.slice(0,128),last=events.at(-1),
    nextEventsAfter=page.length>128&&last?{at:last.cursor_at,id:last.id}:null;
  if(['FAILED','INVALIDATED','CANCELLED'].includes(b.status))return {buildId:id,workId:b.work_id,status:b.status,atlas:null,events,nextEventsAfter,deadlineAt:b.deadline_at.toISOString(),failure:b.failure};
  const familyRef={owner:'S3',id:'affine-family:'+b.family_digest,version:'r7-exact-affine-v1',contentDigest:b.family_digest},family=await r7Family(ctx,familyRef);
  try{await assertR7Owner(ctx,family);}
  catch(error){if(error instanceof R7Error&&error.code==='UNAVAILABLE')throw error;return invalidateR7(ctx,b,'CURRENT_OWNER_BINDING_CHANGED');}
  const atlas=b.result_digest?await r7Tx(ctx,async c=>(await c.query<{body:DecisionAtlas}>(
    'SELECT body FROM finnor_os.r7_atlases WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3 AND generation=$4 AND content_digest=$5',
    [ctx.auth.tenantId,principal(ctx),b.id,b.generation,b.result_digest])).rows[0]?.body??null):null;
  if(b.result_digest){
    if(!atlas)throw new R7Error('CHECK_FAILED','Exact immutable publication is missing');
    const {ref,...body}=atlas;
    if(ref.contentDigest!==b.result_digest||atlasHash(body)!==b.result_digest||atlas.check.status!=='ACCEPTED'||
      atlasHash(atlas.proposal)!==atlas.check.proposalDigest||atlasHash(atlas.input)!==atlasHash(b.input)||
      atlas.check.inputDigest!==atlasHash(b.input.source)||atlas.check.checkerDigest!==family.input.checkerDigest)
      throw new R7Error('CHECK_FAILED','Original immutable atlas/check binding differs');
  }
  const after=await r7Build(ctx,id);
  if(after.generation!==b.generation||after.status!==b.status)return {buildId:id,workId:b.work_id,status:after.status,atlas:null,events,nextEventsAfter,deadlineAt:b.deadline_at.toISOString(),failure:after.failure};
  return {buildId:id,workId:b.work_id,status:b.status,atlas,events,nextEventsAfter,deadlineAt:b.deadline_at.toISOString(),failure:b.failure};
}
export async function cancelR7Build(ctx:PeMutationContext,id:string){
  const b=await r7Build(ctx,id);await resolveDecisionWork(ctx,b.work_id);
  await r7Tx(ctx,async c=>{
    await r7Build(ctx,id,c,true);await c.query("UPDATE finnor_os.r7_builds SET status='CANCELLED',generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status<>'CANCELLED'",
      [ctx.auth.tenantId,principal(ctx),id]);await r7Event(ctx,id,randomUUID(),'CANCELLED',{consumedWorkRetained:true,physicalRelease:'PENDING_CHILD_EXIT_OR_LEASE_EXPIRY',money:null},c);
  });return readR7Build(ctx,id);
}
export async function queryR7Atlas(ctx:PeMutationContext,value:unknown):Promise<R7Query>{
  const started=performance.now(),request=QuerySchema.parse(value),b=await r7Build(ctx,request.buildId),
    family=await r7Family(ctx,{owner:'S3',id:'affine-family:'+b.family_digest,version:'r7-exact-affine-v1',contentDigest:b.family_digest});
  await assertR7Owner(ctx,family);
  const parameters=await r7Parameters(ctx,family);
  if(atlasHash(parameters.ref)!==atlasHash(request.parameterRef))throw new R7Error('STALE_INPUT','Current typed parameter revision required');
  const requestDigest=atlasHash(request),prior=await r7Tx(ctx,async c=>(await c.query<{request_digest:string;body:R7Query}>(
    'SELECT request_digest,body FROM finnor_os.r7_queries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
    [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0]);
  const snapshot=await readAllocationSnapshot(ctx);
  for(const r of snapshot.resources)for(const pin of r.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw new R7Error('STALE_INPUT','Current S5 resource source/rights changed');
  if(prior){
    if(prior.request_digest!==requestDigest)throw new R7Error('CONFLICT');
    return withCanonicalAllocationSnapshot(ctx,async(c,current)=>{
      await assertQueryPublication(ctx,c,current,b,family,parameters,prior.body.resourceSnapshotDigest);return prior.body;
    });
  }
  const values=currentExactParameterValues(family.input.source,snapshot,parameters.values);
  const read=await readR7Build(ctx,b.id);let point:AtlasPointResult={disposition:'INVALIDATED',cellId:null,label:null,value:null,
    costs:{wallMs:0,membershipPredicates:0,fullFamilyEvaluations:0}};
  if(read.atlas)point=lookupAtlas(family.input.source,read.atlas.proposal,values);
  const reasons:string[]=[],physical:DecisionAtlas['physical']=[],originalDisposition=point.disposition;
  let currentCheck=point.label?.winnerPolicyId?checkExactAllocation(family.input.source,snapshot,point.label.winnerPolicyId,values,family.root):null;
  if(currentCheck&&!currentCheck.feasible){reasons.push(...currentCheck.reasons);point={...point,disposition:'INVALIDATED',label:null,value:null};}
  let fallback:R7Query['fallback']=null;
  if(['GAP','OUTSIDE_DOMAIN','INVALIDATED'].includes(point.disposition)){
    reasons.push('ATLAS_'+point.disposition);
    if(request.fallback==='REQUIRE_ADMITTED'){
      reasons.push('S8_COMPATIBLE_FULL_FAMILY_METHOD_DOMAIN_GRANT_ADMISSION_PORT_UNAVAILABLE');
      point={...point,disposition:'UNRESOLVED',label:null,value:null};
      fallback={mode:'REQUIRE_ADMITTED',admitted:false,physical:[],fullFamilyEvaluations:0};
    }else{
      if(process.env.FINNOR_R7_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production')throw new R7Error('CONFIGURATION_REQUIRED','No protected fallback admission is granted');
      // Original outside-domain values cannot extend a model's validity by
      // inference. The explicit full-family supplied-law development callee is
      // conditional and unadmitted; its point result does not extend atlas D.
      const feasiblePolicyIds=family.input.source.policies.filter(p=>checkExactAllocation(family.input.source,snapshot,p.id,values,family.root).feasible).map(p=>p.id),
        attemptId=randomUUID(),cancelled=async()=>{const now=await r7Build(ctx,b.id);return ['CANCELLED','FAILED'].includes(now.status)||now.generation!==b.generation||Date.now()>=b.deadline_at.getTime();};
      try{
        const full=await r7Physical<AtlasPointResult>(ctx,family.episodeId,'FULL_FAMILY',{mode:'FULL_FAMILY',source:family.input.source,values,feasiblePolicyIds},
          30000,cancelled,r=>r7Event(ctx,b.id,attemptId,'CHILD_STARTED',r));
        physical.push(full.receipt);await r7Event(ctx,b.id,attemptId,'FALLBACK_EVALUATED',{receipt:full.receipt,result:full.data,originalEpisodeId:family.episodeId,deadlineAt:b.deadline_at});
        const checked=await r7Physical<{status:string;predicate:string}>(ctx,family.episodeId,'CHECK',{source:family.input.source,point:values,result:full.data,feasiblePolicyIds},
          30000,cancelled,r=>r7Event(ctx,b.id,attemptId,'CHILD_STARTED',r));
        physical.push(checked.receipt);
        if(checked.data.status!=='ACCEPTED')throw new R7Error('CHECK_FAILED',checked.data.predicate);
        point=full.data;currentCheck=point.label?.winnerPolicyId?checkExactAllocation(family.input.source,snapshot,point.label.winnerPolicyId,values,family.root):null;
        fallback={mode:'DEVELOPMENT_EXACT_UNADMITTED_ORIGINAL_EPISODE',admitted:false,physical,fullFamilyEvaluations:family.input.source.policies.length};
      }catch(error){if(error instanceof R7PhysicalFailure)await r7Event(ctx,b.id,attemptId,'FALLBACK_FAILED',{receipt:error.receipt,unknownCost:false});throw error;}
    }
  }
  const choice=projectR7Choice(family,parameters.ref,values,point,currentCheck?.envelopes??[]),
    body:Omit<R7Query,'ref'>={schema:'finnor.r7.query.v1',buildId:b.id,workId:b.work_id,createdAt:new Date().toISOString(),familyRef:family.ref,parameterRef:parameters.ref,
      disposition:point.disposition,cellId:originalDisposition==='COVERED'?point.cellId:null,atlasCoverage:read.atlas?.proposal.coverage??'UNKNOWN',
      choice,reasons,fallback,resourceSnapshotDigest:snapshot.snapshotDigest,costs:{wallMs:performance.now()-started,
        membershipPredicates:point.costs.membershipPredicates,fullFamilyEvaluations:point.costs.fullFamilyEvaluations,money:null},executionAuthorityGranted:false},
    query:R7Query={...body,ref:atlasRef('S4','atlas-query',body)};
  await assertR7Owner(ctx,family);
  return withCanonicalAllocationSnapshot(ctx,async(c,current)=>{
    await assertQueryPublication(ctx,c,current,b,family,parameters,snapshot.snapshotDigest);
    await c.query('INSERT INTO finnor_os.r7_queries(tenant_id,principal_id,content_digest,build_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [ctx.auth.tenantId,principal(ctx),query.ref.contentDigest,b.id,request.idempotencyKey,requestDigest,JSON.stringify(query)]);
    await r7Event(ctx,b.id,randomUUID(),'QUERY',{queryRef:query.ref,costs:body.costs,fallback:body.fallback?.mode,executionAuthorityGranted:false},c);
    return query;
  });
}
export async function chooseEnterpriseAtlasBranch(ctx:PeMutationContext,buildId:string,queryRef:R7Query['ref'],idempotencyKey:string){
  if(process.env.FINNOR_R7_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production')
    throw new R7Error('CONFIGURATION_REQUIRED','Protected exact S4/S5 method activation is not granted');
  const q=await r7QueryRecord(ctx,queryRef);
  if(q.buildId!==buildId||!['COVERED','FULL_FAMILY_CHECKED'].includes(q.disposition)||!q.choice)throw new R7Error('UNSUPPORTED','A current checked original S4 choice is required');
  return consumeEnterpriseExactAllocation(ctx,q,idempotencyKey);
}
