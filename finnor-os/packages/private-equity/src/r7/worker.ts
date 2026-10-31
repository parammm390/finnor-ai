import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../types';
import type { AtlasCheckReceipt, AtlasProposal, DecisionAtlas } from '../../../shared-types/src/decision-atlas';
import { atlasHash, atlasRef } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { principal } from '../decision-slice/adapters';
import { assertDependencies } from '../evidence-execution/store';
import { r7Build, r7Event, r7Family, r7Tx } from './store';
import { assertR7Owner } from './owners';
import { r7Physical, R7PhysicalFailure } from './physical';
import { R7Error } from './contracts';
import { R7_ADOPTION_BASE } from './runtime';

export async function runDecisionAtlasJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
  if(!execution||execution.protocolVersion!==1||execution.tenantId!==payload.tenantId||
    typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.buildId!=='string')
    throw new R7Error('UNAVAILABLE','Actual compatible durable atlas claim required');
  if(process.env.FINNOR_R7_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production')
    throw new R7Error('CONFIGURATION_REQUIRED','Protected atlas admission/runtime is not available');
  const started=performance.now(),cpu=process.cpuUsage(),ctx:PeMutationContext={
    auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},
    provenance:{sourceSystem:'R7:ordinary-native-worker',createdBy:payload.principalId}},attemptId=randomUUID();
  let b=await r7Build(ctx,payload.buildId);
  if(!['QUEUED','RUNNING'].includes(b.status)||b.generation!==payload.generation)return;
  const family=await r7Family(ctx,{owner:'S3',id:'affine-family:'+b.family_digest,version:'r7-exact-affine-v1',contentDigest:b.family_digest});
  const claim=async(c:PoolClient,lock=true)=>(await c.query(
    "SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_decision_atlas_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 AND lease_expires_at>clock_timestamp() AND payload->>'buildId'=$5 AND payload->>'generation'=$6"+(lock?' FOR SHARE':''),
    [execution.jobId,ctx.auth.tenantId,execution.claimToken,execution.claimFence,b.id,String(b.generation)])).rows[0];
  const physical:DecisionAtlas['physical']=[];
  let unreconciledAttemptIds:string[]=[],attempts=1;
  const accounting=()=>{const usage=process.cpuUsage(cpu);return {wallMs:performance.now()-started,cpuMicros:usage.user+usage.system,
    rssBytes:process.memoryUsage().rss,aggregatePeakRSSBytes:null,money:null,humanSeconds:null,scope:'SUPERVISOR_INTERVAL_PLUS_SEPARATE_CHILDREN_NOT_AGGREGATE_PEAK'};};
  b=await r7Tx(ctx,async c=>{
    if(!await claim(c))throw new R7Error('STALE_INPUT','Original queue claim fenced');
    const current=await r7Build(ctx,b.id,c,true);
    if(current.generation!==b.generation||!['QUEUED','RUNNING'].includes(current.status))return current;
    const lost=(await c.query<{attempt_id:string}>(
      "SELECT DISTINCT e.attempt_id::text FROM finnor_os.r7_events e WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.build_id=$3 AND e.kind='STARTED' AND NOT EXISTS(SELECT 1 FROM finnor_os.r7_events f WHERE f.tenant_id=e.tenant_id AND f.principal_id=e.principal_id AND f.build_id=e.build_id AND f.attempt_id=e.attempt_id AND f.kind IN('FINISHED','FAILED','FENCED'))",
      [ctx.auth.tenantId,principal(ctx),b.id])).rows;
    for(const old of lost)await r7Event(ctx,b.id,old.attempt_id,'FAILED',{predicate:'DURABLE_WORKER_LOST',
      physicalCost:'UNKNOWN_RETAINED',originalEpisodeId:b.episode_id,deadlineAt:b.deadline_at,replayEffects:false},c);
    await c.query("UPDATE finnor_os.r7_builds SET status='RUNNING',active_claim_token=$4,active_claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId,principal(ctx),b.id,execution.claimToken,execution.claimFence]);
    await r7Event(ctx,b.id,attemptId,'STARTED',{jobId:execution.jobId,claimToken:execution.claimToken,claimFence:execution.claimFence,
      deliveryAttemptId:execution.deliveryAttemptId,workerId:execution.workerId,episodeId:b.episode_id,deadlineAt:b.deadline_at,
      inputDigest:atlasHash(b.input)},c);
    unreconciledAttemptIds=(await c.query<{attempt_id:string}>(
      "SELECT DISTINCT attempt_id::text FROM finnor_os.r7_events WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3 AND kind='FAILED' AND body->>'predicate'='DURABLE_WORKER_LOST'",
      [ctx.auth.tenantId,principal(ctx),b.id])).rows.map(r=>r.attempt_id);
    attempts=(await c.query<{n:number}>(
      "SELECT count(DISTINCT attempt_id)::int n FROM finnor_os.r7_events WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3 AND kind='STARTED'",
      [ctx.auth.tenantId,principal(ctx),b.id])).rows[0]!.n;
    return {...current,status:'RUNNING' as const,active_claim_token:execution.claimToken,active_claim_fence:execution.claimFence};
  });
  if(b.status!=='RUNNING')return;
  const current=async()=>{
    return r7Tx(ctx,async c=>{
      const q=await r7Build(ctx,b.id,c);
      return q.generation===b.generation&&q.active_claim_token===execution.claimToken&&
        String(q.active_claim_fence)===String(execution.claimFence)&&q.deadline_at.getTime()>Date.now()&&
        ['RUNNING','COMPLETE','INCOMPLETE'].includes(q.status)&&Boolean(await claim(c,false));
    });
  };
  execution.registerHeartbeat(async()=>{try{return await current();}catch{return false;}}, { leaseSeconds: 90 });
  const checkpoint=async()=>{if(!await current())throw new R7Error('STALE_INPUT','Original claim/generation/episode deadline fenced');};
  try{
    await checkpoint();await assertR7Owner(ctx,family);
    // If a prior physical attempt reached independent acceptance before process
    // loss, retain and reauthorize those exact bytes instead of pretending its
    // cost never happened or blindly executing an accepted child again.
    const retained=await r7Tx(ctx,async c=>(await c.query<{body:{proposal:AtlasProposal;check:AtlasCheckReceipt;physical:DecisionAtlas['physical']}}>(
      "SELECT body FROM finnor_os.r7_events WHERE tenant_id=$1 AND principal_id=$2 AND build_id=$3 AND kind='CHECK_ACCEPTED' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.auth.tenantId,principal(ctx),b.id])).rows[0]?.body??null);
    let proposal:AtlasProposal,check:AtlasCheckReceipt;
    if(retained&&retained.check.status==='ACCEPTED'&&retained.check.inputDigest===atlasHash(b.input.source)&&
      retained.check.proposalDigest===atlasHash(retained.proposal)&&retained.check.checkerDigest===b.input.checkerDigest){
      proposal=retained.proposal;check=retained.check;physical.push(...retained.physical);
    }else{
      const built=await r7Physical<AtlasProposal>(ctx,b.episode_id,'BUILD',
        {mode:'BUILD',source:b.input.source,checkerDigest:b.input.checkerDigest,budget:b.request.budget},
        b.request.budget.deadlineMs,async()=>!await current(),r=>r7Event(ctx,b.id,attemptId,'CHILD_STARTED',r));
      physical.push(built.receipt);proposal=built.data;
      await r7Event(ctx,b.id,attemptId,'BUILD_RETURNED',{receipt:built.receipt,proposalDigest:atlasHash(proposal)});
      await checkpoint();await assertR7Owner(ctx,family);
      const checked=await r7Physical<AtlasCheckReceipt>(ctx,b.episode_id,'CHECK',{source:b.input.source,proposal},
        30000,async()=>!await current(),r=>r7Event(ctx,b.id,attemptId,'CHILD_STARTED',r));
      physical.push(checked.receipt);check=checked.data;
      if(check.status!=='ACCEPTED'||check.inputDigest!==atlasHash(b.input.source)||check.proposalDigest!==atlasHash(proposal)||
        check.checkerDigest!==b.input.checkerDigest)throw new R7Error('CHECK_FAILED',check.predicate);
      await r7Event(ctx,b.id,attemptId,'CHECK_ACCEPTED',{proposal,check,physical});
    }
    await checkpoint();await assertR7Owner(ctx,family);
    const resultBody:Omit<DecisionAtlas,'ref'>={
      schema:'finnor.decision-atlas.v1',input:b.input,proposal,check,physical,executionAuthorityGranted:false,
      envelope:{tenantId:ctx.auth.tenantId,principalId:principal(ctx),sharing:{scope:'PRINCIPAL',policy:'CURRENT_S1_AUTHORIZATION'},
        rights:{revision:b.input.rightsRevision,ref:b.input.source.mandate.rightsRef,evaluatedAt:new Date().toISOString()},
        work:{id:b.work_id,revision:b.input.work.inputId,inputDigest:b.input.work.inputDigest},mandate:b.input.source.mandate.ref,
        parents:[],inputsDigest:atlasHash(b.input),validAt:b.input.source.mandate.horizon.startAt,knowledgeAt:b.input.source.mandate.knowledgeAt,
        code:{version:'r7-exact-affine-v1',digest:b.input.codeDigest,schemaDigest:b.input.schemaDigest,checkerDigest:b.input.checkerDigest},
        capability:{kind:'NAMED_FINITE_FAMILY_ATLAS',admission:null},
        runtime:{node:process.version,imageDigest:null,fabricInvocationId:physical[0]?.invocationId??null,workerId:execution.workerId,
          jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,
          childPid:physical[0]?.pid??null,leases:physical.flatMap(r=>r.leases)},
        domain:{entityScope:[family.root.entityType+':'+family.root.entityId],interface:'r7-exact-affine-v1',horizon:'H1',businessTruthCertified:false},
        dependencyRefs:b.input.dependencies.map(d=>d.key+':'+d.revision),
        costs:{wallMs:performance.now()-started,cpuMicros:physical.reduce((s,r)=>s+(r.cpuMicros??0),0),
          peakRSSBytes:null,inputBytes:physical.reduce((s,r)=>s+r.inputBytes,0),outputBytes:physical.reduce((s,r)=>s+r.outputBytes,0),
          modelCalls:0,usd:null,status:'LOCAL_COST_UNMETERED',attempts,nativeInvocations:physical,unreconciledAttemptIds},
        status:proposal.coverage==='COMPLETE'?'COMPLETE':'INCOMPLETE',admission:null,funding:null,
        unavailableBindings:['INDEPENDENT_FAMILY_BUSINESS_ADEQUACY','S8_METHOD_CHECKER_ADMISSION','PROTECTED_FULL_FAMILY_FALLBACK',
          'COMPLETE_MONEY_HUMAN_AGGREGATE_MEMORY_METERS','COMPLETED_X_COMPARATOR','S7_H2_OUTCOMES'],
        baseline:R7_ADOPTION_BASE,
        ownerInputRefs:[b.input.sourceRef,b.input.familyRef,b.input.modelRef,b.input.domainRef],
        assumptions:b.input.source.assumptions,grammar:'NAMED_FAMILY_ONLY',checkBasis:check,claimGaps:check.gapIds,
        lifecycleRefs:[`r7-build:${b.id}`,`r7-attempt:${attemptId}`]},
    };
    const atlas:DecisionAtlas={...resultBody,ref:atlasRef('S4','decision-atlas',resultBody)};
    await r7Tx(ctx,async c=>{
      await assertDependencies(ctx,b.input.dependencies,c,true);
      await assertR7Owner(ctx,family,c);
      if(!await claim(c))throw new R7Error('STALE_INPUT','Original publication claim fenced');
      const now=await r7Build(ctx,b.id,c,true);
      if(now.status!=='RUNNING'||now.generation!==b.generation||now.active_claim_token!==execution.claimToken||
        String(now.active_claim_fence)!==String(execution.claimFence)||now.deadline_at.getTime()<=Date.now())throw new R7Error('STALE_INPUT','Exact publication fenced');
      await c.query('INSERT INTO finnor_os.r7_atlases(tenant_id,principal_id,content_digest,build_id,generation,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [ctx.auth.tenantId,principal(ctx),atlas.ref.contentDigest,b.id,b.generation,JSON.stringify(atlas)]);
      await c.query('UPDATE finnor_os.r7_builds SET status=$4,result_digest=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [ctx.auth.tenantId,principal(ctx),b.id,atlas.envelope.status,atlas.ref.contentDigest]);
      await r7Event(ctx,b.id,attemptId,'FINISHED',{resultRef:atlas.ref,physical,supervisor:accounting(),reusedAcceptedChild:Boolean(retained),executionAuthorityGranted:false},c);
    });
  }catch(error){
    if(error instanceof R7PhysicalFailure)physical.push(error.receipt);
    await r7Tx(ctx,async c=>{
      const now=await r7Build(ctx,b.id,c,true),fenced=now.generation!==b.generation||now.status!=='RUNNING'||now.active_claim_token!==execution.claimToken,
        code=error instanceof R7Error?error.code:'OWNER_STORAGE_OR_RUNTIME_FAILURE';
      if(!fenced)await c.query('UPDATE finnor_os.r7_builds SET status=$4,failure=$5::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [ctx.auth.tenantId,principal(ctx),b.id,code==='STALE_INPUT'?'INVALIDATED':'FAILED',JSON.stringify({code,requirement:error instanceof R7Error?error.message:'Owner/storage/runtime predicate failed'})]);
      await r7Event(ctx,b.id,attemptId,fenced?'FENCED':'FAILED',{code,physical,supervisor:accounting(),costsRetained:true,usableResult:false},c);
    });
  }
}
