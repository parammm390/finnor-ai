import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type pg from 'pg';
import type { OwnerFixture } from './run-owner.mts';
import { readAllocationSnapshot, withCanonicalAllocationSnapshot } from '../../packages/private-equity/src/allocation-store';
import { assertR7Owner, readEnterpriseAffinePolicyFamily } from '../../packages/private-equity/src/r7/owners';
import { checkExactAllocation, currentExactParameterValues } from '../../packages/private-equity/src/r7/allocation';
import { r7Physical } from '../../packages/private-equity/src/r7/physical';
import { r7Event } from '../../packages/private-equity/src/r7/store';
import { projectR7Choice } from '../../packages/private-equity/src/r7/projection';
import type { AtlasPointResult } from '../../packages/epistemic-runtime/src/policy-atlas/query';
import type { R7Query } from '../../packages/private-equity/src/r7/contracts';

type Built={accepted:{buildId:string};read:any};
type Inputs={
  repo:string;admin:pg.Client;fixture:(name:string)=>Promise<OwnerFixture>;
  resource:(f:OwnerFixture)=>Promise<unknown>;bind:(f:OwnerFixture)=>Promise<unknown>;
  build:(f:OwnerFixture)=>Promise<Built>;parameters:(f:OwnerFixture,values:string[])=>Promise<unknown>;
  query:(f:OwnerFixture,id:string,fallback?:string)=>Promise<R7Query>;
  call:(f:OwnerFixture,operation:string,body:unknown)=>Promise<{status:number;body:any}>;
  reviseSource:(f:OwnerFixture)=>Promise<unknown>;
  artifact:(name:string,value:unknown)=>Promise<string>;
};
type Phase={name:string;actor:'SHARED'|'OFF'|'ON';wallNs:string;parentCpuMicros:number;status:'PASS'|'FAIL'};
/** The off actor shares exactly the source/evaluator/current S5 contract.
 * Batching known points avoids artificially charging 256 child startups. */
export async function matchedReuse(input:Inputs){
  const phases:Phase[]=[],rows:unknown[]=[],physical:unknown[]=[],samples:Array<{at:string;rssBytes:number;processes:number}>=[];
  const measure=async<T,>(name:string,actor:Phase['actor'],fn:()=>Promise<T>):Promise<T>=>{
    const start=process.hrtime.bigint(),cpu=process.cpuUsage();let status:Phase['status']='PASS';
    try{return await fn();}catch(error){status='FAIL';throw error;}
    finally{const used=process.cpuUsage(cpu);phases.push({name,actor,wallNs:String(process.hrtime.bigint()-start),parentCpuMicros:used.user+used.system,status});}
  };
  const sample=()=>{
    const observed=spawnSync('/bin/ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8',timeout:1000,maxBuffer:1048576});
    if(observed.status!==0)return;
    const all=observed.stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),
      descendants=new Set([process.pid]);let changed=true;
    while(changed){changed=false;for(const [pid,parent]of all)if(descendants.has(parent!)&&!descendants.has(pid!)){descendants.add(pid!);changed=true;}}
    const owned=all.filter(([pid])=>descendants.has(pid!));
    samples.push({at:new Date().toISOString(),rssBytes:owned.reduce((sum,row)=>sum+row[2]!*1024,0),processes:owned.length});
  };
  sample();const timer=setInterval(sample,200),registration=JSON.parse(await readFile(join(input.repo,'scope-r/r7-policy-atlas-compiler/cost-registration.json'),'utf8'));
  let status='RUNNING',f:OwnerFixture|undefined,originalEpisode:unknown;
  const save=()=>input.artifact('cost/results.json',{schema:'finnor.r7.matched-complete-cost.v1',status,registration,phases,rows,physical,
    sampledOwnedDescendantRSS:{maximumBytes:samples.length?Math.max(...samples.map(s=>s.rssBytes)):null,sampleIntervalMs:200,samples,
      basis:'Actual parent/worker/builder/checker/disposable-PostgreSQL descendant RSS samples, not a continuous aggregate peak bound'},
    originalEpisode,qualification:'LOCAL_REGISTERED_SEQUENCE_CONDITIONAL_EXACT_NO_COMPLETED_X_OR_FIELD_GAIN',
    unknown:{money:null,humanSeconds:null,dataFees:null,licenceFees:null,installationAllocation:null,aggregateSimultaneousPeakMemoryBytes:null}});
  async function fullBatch(actor:OwnerFixture,buildId:string,points:string[][]){
    const family=(await readEnterpriseAffinePolicyFamily(actor.ctx,actor.family!.ref)).family,
      snapshot=await readAllocationSnapshot(actor.ctx),prepared=points.map(values=>{
        const current=currentExactParameterValues(family.input.source,snapshot,values);
        assert.deepEqual(current,values);
        return {values,feasiblePolicyIds:family.input.source.policies.filter(p=>
          checkExactAllocation(family.input.source,snapshot,p.id,current,family.root).feasible).map(p=>p.id)};
      }),attempt=randomUUID(),event=(receipt:unknown)=>r7Event(actor.ctx,buildId,attempt,'CHILD_STARTED',
        {receipt,costActor:'OFF',basis:'REGISTERED_FULL_FAMILY_POINT_SEQUENCE'});
    const cancelled=async()=>Date.now()>=Date.parse(family.input.source.mandate.validUntil),
      full=await r7Physical<AtlasPointResult[]>(actor.ctx,family.episodeId,'FULL_FAMILY_BATCH',
        {mode:'FULL_FAMILY_BATCH',source:family.input.source,points:prepared},30000,cancelled,event);
    physical.push({actor:'OFF',receipt:full.receipt});
    const check=await r7Physical<{status:string;checks:Array<{status:string}>}>(actor.ctx,family.episodeId,'CHECK',
      {source:family.input.source,points:prepared,results:full.data},30000,cancelled,event);
    physical.push({actor:'OFF',receipt:check.receipt,check:check.data});assert.equal(check.data.status,'ACCEPTED');
    assert.equal(check.data.checks.length,points.length);
    await withCanonicalAllocationSnapshot(actor.ctx,async(c,current)=>{
      await assertR7Owner(actor.ctx,family,c);assert.equal(current.snapshotDigest,snapshot.snapshotDigest);
    });
    return {results:full.data,snapshotDigest:snapshot.snapshotDigest};
  }
  try{
    f=await measure('immutable-owner-family-resource-preparation','SHARED',async()=>{
      const actor=await input.fixture('r7-cost');await input.resource(actor);await input.bind(actor);return actor;
    });
    const startEpisode=(await input.admin.query('SELECT * FROM finnor_os.r7_episodes WHERE tenant_id=$1',[f.tenant])).rows[0];
    const b=await measure('cold-durable-build-worker-check-read','ON',()=>input.build(f!));
    physical.push({actor:'ON',phase:'cold-build',receipts:b.read.atlas.physical});
    const points=Array.from({length:128},(_,i)=>[i===0?'0/1':i===127?'1/1':`${i}/127`]),
      baseline=await measure('full-family-128-point-native-batch-and-independent-check','OFF',()=>fullBatch(f!,b.accepted.buildId,points));
    // The prime denominator makes every interior input literal reduced.
    assert.equal(points.length,registration.sequence.coveredQueries);
    for(let i=0;i<points.length;i++){
      await measure('typed-owner-parameter-'+i,'SHARED',()=>input.parameters(f!,points[i]!));
      const off=await measure('current-original-projection-S5-'+i,'OFF',async()=>{
        await assertR7Owner(f!.ctx,f!.family!);
        return withCanonicalAllocationSnapshot(f!.ctx,async(c,current)=>{
          await assertR7Owner(f!.ctx,f!.family!,c);assert.equal(current.snapshotDigest,baseline.snapshotDigest);
          const point=baseline.results[i]!,winner=point.label?.winnerPolicyId,
            checked=winner?checkExactAllocation(f!.source,current,winner,points[i]!,f!.root):null;
          assert(!checked||checked.feasible);
          return projectR7Choice(f!.family!,f!.parameters!.ref,points[i]!,point,checked?.envelopes??[]);
        });
      });
      const on=await measure('exact-API-currentness-query-storage-'+i,'ON',()=>input.query(f!,b.accepted.buildId));
      assert.equal(on.disposition,'COVERED');assert.equal(on.costs.fullFamilyEvaluations,0);
      assert.equal(on.choice?.policyId,off?.policyId);assert.equal(on.choice?.robustValue,off?.robustValue);
      assert.deepEqual(on.choice?.tiedPolicyIds,off?.tiedPolicyIds);assert.deepEqual(on.choice?.worstWorldIds,off?.worstWorldIds);
      assert.deepEqual(on.choice?.exactDemand,off?.exactDemand);
      rows.push({index:i,values:points[i],off,on});
      if(i%8===7){await save();console.log(JSON.stringify({case:'matched-reuse',completedQueries:i+1,totalQueries:128}));}
    }
    const eventIds:string[]=[],eventKinds:string[]=[];let cursor:unknown=undefined;
    do{
      const page=await measure('bounded-durable-event-read','ON',async()=>{
        const r=await input.call(f!,'read',{buildId:b.accepted.buildId,...(cursor?{eventsAfter:cursor}:{})});
        assert.equal(r.status,200);assert.equal(r.body.status,'COMPLETE');return r.body;
      });
      for(const e of page.events){assert(!eventIds.includes(e.id),'Append-only cursor must not repeat an event');eventIds.push(e.id);eventKinds.push(e.kind);}
      cursor=page.nextEventsAfter;
    }while(cursor);
    assert.equal(eventKinds.filter(k=>k==='QUERY').length,128);
    await measure('outside-owner-parameter','SHARED',()=>input.parameters(f!,['5/4']));
    const outsideOff=await measure('outside-full-family-native-and-check','OFF',()=>fullBatch(f!,b.accepted.buildId,[['5/4']]));
    const outsideOn=await measure('outside-API-real-full-family-fallback','ON',()=>input.query(f!,b.accepted.buildId,'DEVELOPMENT_EXACT'));
    assert.equal(outsideOn.choice!.policyId,outsideOff.results[0]!.label!.winnerPolicyId);
    assert.equal(outsideOn.choice!.robustValue,outsideOff.results[0]!.value);assert.equal(outsideOn.fallback?.physical.length,2);
    rows.push({outsideOff,outsideOn,eventIds});
    const revised=await measure('immutable-source-structural-revision-current-resource-rebind','SHARED',()=>input.reviseSource(f!));
    const old=await input.call(f,'read',{buildId:b.accepted.buildId});assert.equal(old.body.status,'INVALIDATED');
    await measure('reset-business-parameter-not-episode','SHARED',()=>input.parameters(f!,['1/2']));
    const rebuilt=await measure('structural-cold-rebuild-and-independent-check','ON',()=>input.build(f!)),
      afterOff=await measure('changed-source-full-family-native-and-check','OFF',()=>fullBatch(f!,rebuilt.accepted.buildId,[['1/2']])),
      afterOn=await measure('changed-source-exact-current-API-query','ON',()=>input.query(f!,rebuilt.accepted.buildId));
    assert.equal(afterOn.choice!.policyId,afterOff.results[0]!.label!.winnerPolicyId);
    assert.equal(afterOn.choice!.robustValue,afterOff.results[0]!.value);
    physical.push({actor:'ON',phase:'outside-fallback',receipts:outsideOn.fallback!.physical},
      {actor:'ON',phase:'structural-rebuild',receipts:rebuilt.read.atlas.physical});
    const ending=(await input.admin.query('SELECT * FROM finnor_os.r7_episodes WHERE tenant_id=$1',[f.tenant])).rows;
    assert.equal(ending.length,1);assert.equal(ending[0].episode_id,startEpisode.episode_id);
    assert.equal(+ending[0].deadline_at,+startEpisode.deadline_at);assert.equal(ending[0].max_invocations,64);assert.equal(ending[0].invocations,12);
    originalEpisode={start:startEpisode,end:ending[0]};
    const storage=await measure('actual-SQL-storage-accounting','SHARED',async()=>(
      await input.admin.query(`SELECT 'atlases' kind,count(*)::int records,sum(pg_column_size(body))::text bytes
      FROM finnor_os.r7_atlases WHERE tenant_id=$1 UNION ALL SELECT 'queries',count(*)::int,sum(pg_column_size(body))::text
      FROM finnor_os.r7_queries WHERE tenant_id=$1 UNION ALL SELECT 'events',count(*)::int,sum(pg_column_size(body))::text
      FROM finnor_os.r7_events WHERE tenant_id=$1`,[f!.tenant])).rows);
    const sum=(actor:Phase['actor'])=>phases.filter(p=>p.actor===actor).reduce((n,p)=>n+BigInt(p.wallNs),0n),
      shared=sum('SHARED'),offTotal=sum('OFF')+shared,onTotal=sum('ON')+shared,
      offBatch=BigInt(phases.find(p=>p.name==='full-family-128-point-native-batch-and-independent-check')!.wallNs);
    let off=shared+offBatch,on=shared+BigInt(phases.find(p=>p.name==='cold-durable-build-worker-check-read')!.wallNs),
      equality:number|null=null,strict:number|null=null;
    for(let i=0;i<128;i++){
      off+=BigInt(phases.find(p=>p.name==='current-original-projection-S5-'+i)!.wallNs);
      on+=BigInt(phases.find(p=>p.name==='exact-API-currentness-query-storage-'+i)!.wallNs);
      if(equality===null&&on<=off)equality=i+1;if(strict===null&&on<off)strict=i+1;
    }
    rows.push({revised,old,rebuilt:rebuilt.accepted,afterOff,afterOn,storage,wallNanoseconds:{off:String(offTotal),on:String(onTotal),shared:String(shared),
      observedPrefix:{equality,strict,basis:'Frozen batch startup charged at prefix zero, no future-work amortization'},
      completeSequenceImprovement:onTotal<offTotal,constantCostForecast:null,forecastReason:'Variable storage/currentness/fallback/rebuild costs use the actual sequence'}});
    status='PASS';await save();return {status,matchedPoints:128,originalInvocations:12,wallNanoseconds:{off:String(offTotal),on:String(onTotal)},
      observedPrefix:{equality,strict},completeSequenceImprovement:onTotal<offTotal,artifact:'cost/results.json'};
  }catch(error){status='FAIL';throw error;}
  finally{clearInterval(timer);sample();await save();}
}
