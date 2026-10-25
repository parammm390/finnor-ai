import assert from 'node:assert/strict';
import {createHook} from 'node:async_hooks';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {cpus,loadavg} from 'node:os';
import pg from 'pg';
import {semanticHash,sealInputSnapshot} from '@finnor/underwriting';

/** Diagnostic around the actual authenticated owner path, never a substitute
 * reader or result oracle. SQL parameter values and private source bytes are
 * deliberately excluded from the diagnostic. */
export async function acquisitionReadProbe(e:any){
 const {api,decisionId,observed,admin,tenant,evidence}=e;
 const expectedDigest=semanticHash(observed.body.result);
 async function read(){
  const result=await api('acquisition-read',{decisionId});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.status,'TESTED');
  assert.equal(result.body.result.candidates.length,6);assert.equal(result.body.result.maximumBid.qualification,'NO_FEASIBLE_CANDIDATE');
  assert.equal(semanticHash(result.body.result),expectedDigest);return result;
 }
 const loadBefore=loadavg();await read();
 const sql=new Map<string,{count:number;elapsedMs:number}>();let fileOperations=0;
 const fsHook=createHook({init(_id,type){if(type==='FSREQPROMISE')fileOperations++;}});
 const original=pg.Client.prototype.query;
 (pg.Client.prototype as any).query=function(...args:any[]){
  const started=performance.now(),result=Reflect.apply(original,this,args);
  if(result&&typeof result.then==='function')return result.finally(()=>{const key=String(typeof args[0]==='string'?args[0]:args[0]?.text).replace(/\s+/g,' ').trim();const item=sql.get(key)??{count:0,elapsedMs:0};item.count++;item.elapsedMs+=performance.now()-started;sql.set(key,item);});
  return result;
 };
 fsHook.enable();
 try{await read();}finally{fsHook.disable();pg.Client.prototype.query=original;}
 const samples:any[]=[];
 for(let i=0;i<5;i++){const cpu=process.cpuUsage(),started=performance.now();await read();samples.push({elapsedMs:performance.now()-started,cpuMicros:process.cpuUsage(cpu),status:200,checkedCandidates:6,resultDigest:expectedDigest});}
 const sorted=samples.map(s=>s.elapsedMs).sort((a,b)=>a-b);
 const metrics={schema:'finnor.acquisition-read-probe.v1',side:process.env.FINNOR_ACQUISITION_READ_PROBE,workload:{decisionId,candidates:6,sourceOperatingProfit:'930000',bidQualification:'NO_FEASIBLE_CANDIDATE'},machine:{cores:cpus().length,loadBefore,loadAfter:loadavg()},diagnostic:{filesystemPromiseOperations:fileOperations,sqlQueries:[...sql].map(([sqlTemplate,counts])=>({sqlTemplate,...counts})),totalQueries:[...sql.values()].reduce((s,x)=>s+x.count,0)},samples,medianMs:sorted[2],rangeMs:[sorted[0],sorted.at(-1)],errors:0,productionSpeedupQualified:false,qualification:'LOCAL_ACTUAL_ROUTE_AND_DATABASE; SEPARATE_NON_INTERLEAVED_RUNS; NO_HOSTED_OR_ECONOMIC_CLAIM'};
 await writeFile(join(evidence,'acquisition-read-metrics.json'),JSON.stringify(metrics,null,2));

 // Privileged corruption is confined to this disposable fixture. Restore each
 // original row before the existing source-correction proof continues.
 const last=observed.body.result.candidates.at(-1),run=(await admin.query('SELECT result,input_snapshot,input_hash FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',[tenant,last.runId])).rows[0];
 async function replace(column:string,value:any,inputHash?:string){
  await admin.query('BEGIN');try{
   await admin.query('ALTER TABLE finnor_os.underwriting_runs DISABLE TRIGGER USER');
   await admin.query(`UPDATE finnor_os.underwriting_runs SET ${column}=$3::jsonb${inputHash?',input_hash=$4':''} WHERE tenant_id=$1 AND id=$2`,[tenant,last.runId,JSON.stringify(value),...(inputHash?[inputHash]:[])]);
   await admin.query('ALTER TABLE finnor_os.underwriting_runs ENABLE TRIGGER USER');await admin.query('COMMIT');
  }catch(error){await admin.query('ROLLBACK');throw error;}
 }
 const probes:any[]=[];
 try{
  await replace('result',{...run.result,resultSemanticHash:'0'.repeat(64)});
  const corrupted=await api('acquisition-read',{decisionId});assert.notEqual(corrupted.status,200);assert(!corrupted.body.result);probes.push({kind:'LAST_CANDIDATE_RESULT_HASH',observed:corrupted});
 }finally{await replace('result',run.result);}
 try{
  const snapshot=structuredClone(run.input_snapshot);snapshot.values.operating_profit.value='930001';delete snapshot.semanticHash;
  const sealed=sealInputSnapshot(snapshot);await replace('input_snapshot',sealed,sealed.semanticHash);
  const mismatched=await api('acquisition-read',{decisionId});assert.notEqual(mismatched.status,200);assert(!mismatched.body.result);probes.push({kind:'LAST_CANDIDATE_PRODUCER_VALUE_MISMATCH',observed:mismatched});
 }finally{await replace('input_snapshot',run.input_snapshot,run.input_hash);}
 await read();
 await writeFile(join(evidence,'acquisition-read-integrity-probes.json'),JSON.stringify({probes,restored:true,qualification:'SUPERUSER_CORRUPTION_OF_DISPOSABLE_FIXTURE_ONLY'},null,2));
 return metrics;
}
