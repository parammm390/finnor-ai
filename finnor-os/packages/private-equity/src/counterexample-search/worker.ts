import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withGovernedProviderInvocation,ComputeCapacityUnavailableError,withDatabaseExecutionDeadline } from '@finnor/db';
import type { PeMutationContext } from '../types';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import { principal } from '../decision-slice/adapters';
import { assertDependencies } from '../evidence-execution/store';
import { inM1Episode } from '../decision-slice/budget';
import { DecisionSliceError } from '../decision-slice/contracts';
import { ChallengeError,M4_VERSION,ref,hash,gap,type OwnerArtifactDiagnostic,type SearchReport,type Validation,type Proposal } from './contracts';
import { profile,assertCurrent,assertFrozenContext,authorizedSearch,repairRechecks,withIssuedCapitalChallengeRead } from './service';
import { tx,searchRow,retain,event,events,eventValue,fence,budgetRoot,allocate,witnessCapacity,reportRecord,episodeCancelled } from './store';
import { inChallengeEpisode,remainingMs,checkBudget } from './budget';
import { searchFrozenDiagnostic } from './search';
import { witnessInputKey } from './generator';
import {buildChallengeResult} from './challenge-result';
const payloadSchema=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),searchId:z.string().uuid()}).strict();

export async function runCounterexampleSearchJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
  const parsed=payloadSchema.parse(payload);
  if(!execution||execution.protocolVersion!==1||execution.tenantId!==parsed.tenantId||execution.retrySafety!=='locally_idempotent')
    throw new ChallengeError('UNAVAILABLE','Actual compatible authenticated durable job claim required');
  // PostgreSQL bigint fences arrive as decimal strings with the canonical pg parser.
  const claimFence=Number(execution.claimFence);
  if(!Number.isSafeInteger(claimFence)||claimFence<1)throw new ChallengeError('UNAVAILABLE','Unsupported durable job fence');
  execution={...execution,claimFence};
  const ctx:PeMutationContext={auth:{tenantId:parsed.tenantId,userId:parsed.principalId,employeeId:parsed.principalId,role:'owner'},
    provenance:{sourceSystem:'M4:disposable-native-worker',createdBy:parsed.principalId}};
  profile();
  const {row,frozen}=await authorizedSearch(ctx,parsed.searchId);
  if(['COMPLETED','CANCELLED','FAILED','EXPIRED','STALE'].includes(row.status))return;
  const attemptId=randomUUID(),abort=new AbortController(),started=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss;
  // An expired queued request is a refused search, never a successful absence of witnesses.
  const cancelled=await episodeCancelled(ctx,row);
  if(cancelled||row.deadline_at.getTime()<=Date.now()){
    await withDatabaseExecutionDeadline(performance.now()+250,()=>tx(ctx,async c=>{
      const current=await searchRow(ctx,row.id,c,true);
      if(!['QUEUED','RUNNING'].includes(current.status))return;
      await event(ctx,current,attemptId,'REFUSED',{reason:cancelled?'PARENT_EPISODE_CANCELLED':
        'PARENT_DEADLINE_EXHAUSTED_IN_QUEUE',checkedCells:0,usd:null},c);
      await c.query("UPDATE finnor_os.m4_searches SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId,principal(ctx),row.id,cancelled?'CANCELLED':'EXPIRED']);
    }));return;
  }
  await tx(ctx,async c=>{
    const current=await searchRow(ctx,row.id,c,true);await fence(ctx,current,execution,c);
    const prior=await c.query<{attempt_id:string}>(
      "SELECT DISTINCT attempt_id FROM finnor_os.m4_events e WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND kind='STARTED' AND NOT EXISTS(SELECT 1 FROM finnor_os.m4_events f WHERE f.tenant_id=e.tenant_id AND f.principal_id=e.principal_id AND f.search_id=e.search_id AND f.attempt_id=e.attempt_id AND f.kind IN('FINISHED','FAILED','FENCED','CANCELLED_ATTEMPT'))",
      [ctx.auth.tenantId,principal(ctx),row.id]);
    for(const lost of prior.rows)await event(ctx,current,lost.attempt_id,'FENCED',{reason:'PRIOR_DELIVERY_LOST',
      finalPhysicalCostUnknown:true,earlierValidWitnessesRetained:true,usd:null},c);
    await c.query("UPDATE finnor_os.m4_searches SET status='RUNNING',active_claim_token=$4,active_claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId,principal(ctx),row.id,execution.claimToken,execution.claimFence]);
    await event(ctx,current,attemptId,'STARTED',{jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,
      workerId:execution.workerId,deadlineAt:current.deadline_at.toISOString(),queueWaitMs:Date.now()-current.created_at.getTime(),
      usd:null,financialAllocation:null,aggregateOSLimits:'UNQUALIFIED'},c);
  });
  execution.registerHeartbeat(async()=>{
    try{return await tx(ctx,async c=>{
      const current=await searchRow(ctx,row.id,c);
      // Publication is settled before queue acknowledgement. An in-flight
      // heartbeat must not reinterpret that completed report as a lost lease.
      if(current.status==='COMPLETED'&&current.report_digest&&current.job_id===execution.jobId&&
        current.active_claim_token===execution.claimToken&&Number(current.active_claim_fence)===execution.claimFence)return true;
      await fence(ctx,current,execution,c,true);return true;
    });}
    catch{abort.abort();return false;}
  });
  let status='FAILED',failure:string|null=null;
  try{
    await withIssuedCapitalChallengeRead(()=>inChallengeEpisode(row.deadline_at.getTime()-Date.now(),()=>inM1Episode(remainingMs(),async()=>{
      const execute=async(capacitySignal:AbortSignal,capacityRefusal=false)=>{
        const signal=AbortSignal.any([abort.signal,capacitySignal]);
        const settled=await events(ctx,row,['CHECK','REUSED_SETTLED_CHECK','REDUCTION_CHECK','VALID_ORIGINAL','REPAIR_CHECK']);
        const previousChecks=new Map<string,Validation>();
        const repairedProposals=new Map<string,Proposal>();
        for(const e of settled){const v=eventValue<{proposal?:Proposal;validation?:Validation}>(e);
          if(v.proposal&&v.validation){
            previousChecks.set(v.proposal.ref.contentDigest,v.validation);
            if(e.kind==='REPAIR_CHECK'&&v.validation.status==='VALID')repairedProposals.set(v.proposal.ref.contentDigest,v.proposal);
          }}
        const previousWitnesses=new Map((await events(ctx,row,['WITNESS'])).map(e=>{
          const w=eventValue<import('./contracts').ValidatedCounterexample>(e);
          const {ref:identity,...body}=w;
          if(identity.contentDigest!==hash(body)||w.candidateIdentity!==frozen.identityDigest||
            w.contextDigest!==frozen.contextDigest||w.validation.status!=='VALID'||!w.validation.material||
            !w.validation.failureKey)throw new ChallengeError('CHECK_FAILED','Retained witness does not bind this exact frozen candidate');
          return [w.original.ref.contentDigest,w] as const;
        }));
        const debit=async(phase:string,body:unknown)=>tx(ctx,async c=>{
          checkBudget();
          if(capacityRefusal)throw new ChallengeError('LIMIT_EXCEEDED','Required native capacity unavailable; no new native trial permitted');
          const current=await searchRow(ctx,row.id,c,true);await fence(ctx,current,execution,c,true);
          const root=await budgetRoot(ctx,current,c);
          if(current.trials>=current.limits.maxTrials||root.trials>=root.limits.maxTrials)
            throw new ChallengeError('LIMIT_EXCEEDED','One parent trial allocation exhausted, including repair and retries');
          const proposal=(body as {proposal?:Proposal}).proposal;
          if(proposal&&['GENERATE','REDUCTION','REPAIR_REPLAY'].includes(phase))
            await allocate(ctx,current,phase==='REDUCTION'?'REDUCTION':'CELL',proposal.ref.contentDigest,c);
          if(root.id!==current.id)await c.query('UPDATE finnor_os.m4_searches SET trials=trials+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
            [ctx.auth.tenantId,principal(ctx),root.id]);
          await c.query('UPDATE finnor_os.m4_searches SET trials=trials+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
            [ctx.auth.tenantId,principal(ctx),row.id]);
          await event(ctx,current,attemptId,'DEBIT',{phase,...body as Record<string,unknown>,parentEpisodeId:root.id},c);
        });
        const retainEvent=async(kind:string,body:unknown)=>{
          await tx(ctx,async c=>{
            const current=await searchRow(ctx,row.id,c,true);await fence(ctx,current,execution,c,true);
            if(kind==='WITNESS'){
              const w=body as import('./contracts').ValidatedCounterexample;
              await allocate(ctx,current,'WITNESS',witnessInputKey(w.candidateIdentity,w.original),c);
            }
            await event(ctx,current,attemptId,kind,body,c);
          });
          if(kind==='REPAIR_CHECK'){
            const checked=body as {proposal:Proposal;validation:Validation};
            previousChecks.set(checked.proposal.ref.contentDigest,checked.validation);
            if(checked.validation.status==='VALID')repairedProposals.set(checked.proposal.ref.contentDigest,checked.proposal);
          }
        };
        const canCheck=(p:Proposal)=>tx(ctx,async c=>{
          const current=await searchRow(ctx,row.id,c,true);await fence(ctx,current,execution,c,true);
          return witnessCapacity(ctx,current,witnessInputKey(frozen.identityDigest,p),c);
        });
        if(capacityRefusal)await retainEvent('REFUSED',{reason:'REQUIRED_NATIVE_CAPACITY_UNAVAILABLE',
          resourceKey:'provider:m4-native',newNativeTrialsPermitted:false,usd:null});
        const repair=capacityRefusal?{parentResultRef:row.parent_search_id?
          (await reportRecord(ctx,await searchRow(ctx,row.parent_search_id)))?.ref??null:null,replay:[]}:
          await repairRechecks(ctx,row,frozen,debit,signal,retainEvent,canCheck,async p=>previousChecks.get(p.ref.contentDigest)??null);
        await retainEvent('REPAIR_REPLAY',{parentResultRef:repair.parentResultRef,replay:repair.replay});
        const outcome=await inChallengeEpisode(remainingMs(),()=>searchFrozenDiagnostic(ctx,frozen,{
          signal,debit,retain:retainEvent,validateCurrent:(full=false)=>full?assertCurrent(ctx,frozen):assertFrozenContext(ctx,frozen),
          priorValidation:async p=>previousChecks.get(p.ref.contentDigest)??null,
          priorWitness:async p=>previousWitnesses.get(p.ref.contentDigest)??null,
          repairProposals:async()=>[...repairedProposals.values()],
          witnessCapacity:canCheck,
        }),signal);
        if(repair.replay.some(replay=>replay.outcome==='UNRESOLVED'||replay.outcome==='UNSUPPORTED_NEW_DOMAIN')){
          outcome.unresolved.push(gap('PRIOR_WITNESS_RECHECK_UNRESOLVED',
            'An earlier witness could not be independently rechecked inside the new exact domain and remaining root allocation',null,true,'M4'));
          outcome.result=outcome.witnesses.length?'FAILURE_WITNESS':'BLOCKED';
        }
        if(capacityRefusal){
          outcome.unresolved.push(gap('REQUIRED_NATIVE_CAPACITY_UNAVAILABLE',
            'Required m4-native capacity is unavailable; only already committed same-context evidence can be retained',null,true,'S5/P3'));
          if(row.parent_search_id)outcome.unresolved.push(gap('REPAIR_RECHECK_UNAVAILABLE','Native capacity did not permit new repair checking',null,true,'M4'));
          outcome.result=outcome.witnesses.length?'FAILURE_WITNESS':'BLOCKED';
        }
        await assertCurrent(ctx,frozen);checkBudget();
        const current=await searchRow(ctx,row.id),history=await events(ctx,current,['STARTED','FENCED','FINISHED','FAILED']);
        const usage=process.cpuUsage(cpu),body:Omit<OwnerArtifactDiagnostic,'ref'>={
          schema:'finnor.m4.owner-artifact-diagnostic.v1',
          producer:{owner:'M4',version:M4_VERSION,schema:'finnor.m4.producer-envelope.v1'},
          identity:{tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId:row.work_id,workInputId:row.work_input_id,
            contextDigest:frozen.contextDigest,sourceDigest:frozen.code.digest},
          runtime:{node:process.version,platform:process.platform,architecture:process.arch,imageAttestation:null},
          evaluation:{protocol:'FROZEN_ORIGINAL_PREDICATE_V1',independentAdmission:null},
          resources:{profile:'DISPOSABLE_TRUSTED_NATIVE',protectedFunding:null,aggregateOSLimits:'UNQUALIFIED'},
          cost:{usd:null,status:'UNMETERED',upstreamChargesDuplicated:false},qualification:'H0_H1_DEVELOPMENT_NOT_H2',
          executionAuthorityGranted:false,target:{sliceRef:frozen.slice.ref,ownerRefs:[...new Map(frozen.faultGraph.nodes.map(n=>[hash(n.ownerRef),n.ownerRef])).values()]},
          claims:frozen.claims,searchedDomain:{ref:frozen.domainRef,definition:frozen.request.domain,globalAbsenceClaimsPermitted:false},
          ...outcome,ledger:{trials:current.trials,attempts:history.filter(e=>e.kind==='STARTED').length,
            cpuUserMicros:usage.user,cpuSystemMicros:usage.system,wallMs:Date.now()-row.created_at.getTime(),
            rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,measurementScope:'PROCESS_INTERVAL_NOT_AGGREGATE_OS',
            unknownAttemptCosts:history.some(e=>eventValue<any>(e).finalPhysicalCostUnknown)||history.some(e=>e.kind==='FAILED'),
            usd:null,modelCalls:0},parentResultRef:repair.parentResultRef,repairReplay:repair.replay,
        };
        const report:SearchReport=frozen.capital?buildChallengeResult(frozen,row,body):
          {ref:ref('owner-artifact-diagnostic',body),...body};
        if(Buffer.byteLength(JSON.stringify(report))>row.limits.maxBytes)throw new ChallengeError('LIMIT_EXCEEDED','One result byte bound exhausted');
        await tx(ctx,async c=>{
          const locked=await searchRow(ctx,row.id,c,true);await fence(ctx,locked,execution,c,true);
          await assertDependencies(ctx,frozen.revisions,c,true);
          // Owner source/resource/plan writers take these same revision locks.
          const digest=await retain(ctx,locked,'REPORT',report,c);
          await event(ctx,locked,attemptId,'FINISHED',{reportRef:report.ref,coverage:report.coverage,ledger:report.ledger},c);
          await c.query("UPDATE finnor_os.m4_searches SET status='COMPLETED',report_digest=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
            [ctx.auth.tenantId,principal(ctx),row.id,digest]);
        });
        status='COMPLETED';
      };
      try{await withGovernedProviderInvocation({provider:'m4-native',tenantId:ctx.auth.tenantId,ownerId:attemptId},execute);}
      catch(error){
        if(error instanceof ComputeCapacityUnavailableError&&error.resourceKey==='provider:m4-native'||
          error instanceof Error&&error.message==='Mandatory compute resource policy is absent or disabled: provider:m4-native')
          await execute(new AbortController().signal,true);
        else throw error;
      }
    })));
  }catch(error){
    failure=error instanceof ChallengeError?error.code:
      error instanceof DecisionSliceError?error.code:'NATIVE_OWNER_REFERENCE_OR_CAPACITY_FAILURE';
    // Accounting is deliberately outside the exhausted execution episode. It
    // cannot publish a report or revive the lost job, only retain the cost/refusal.
    await withDatabaseExecutionDeadline(performance.now()+250,()=>tx(ctx,async c=>{
      const current=await searchRow(ctx,row.id,c,true);
      await event(ctx,current,attemptId,failure==='CANCELLED'?'CANCELLED_ATTEMPT':'FAILED',
        {reason:failure,computedWitnessesRetained:true,usage:{wallMs:performance.now()-started,cpu:process.cpuUsage(cpu),
          rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss},usd:null},c);
      if(current.status==='RUNNING'&&current.active_claim_token===execution.claimToken&&Number(current.active_claim_fence)===execution.claimFence)
        await c.query("UPDATE finnor_os.m4_searches SET status=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [ctx.auth.tenantId,principal(ctx),row.id,failure==='STALE_INPUT'?'STALE':
            failure==='LIMIT_EXCEEDED'?'EXPIRED':failure==='CANCELLED'?'CANCELLED':'FAILED']);
    }));
  }finally{
    abort.abort();
    // Queue retains delivery outcome and capacity cleanup. No effect/reservation release exists here.
    if(status!=='COMPLETED'&&failure===null)throw new ChallengeError('CHECK_FAILED','Worker did not produce a settled diagnostic');
  }
}
