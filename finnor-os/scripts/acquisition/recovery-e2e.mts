import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readAcquisitionIcBasis} from '../../packages/private-equity/src/acquisition/ic';
import {getUnderwritingRun} from '../../packages/private-equity/src/underwriting-repository';
import type {UnderwritingInputSnapshot} from '@finnor/underwriting';

export async function acquisitionRecoveryE2E(e:any){
 const {admin,ctx,tenant,actor,request,baseRun,work,api,runWorker,results}=e;
 const filter=process.env.FINNOR_ACQUISITION_RECOVERY_CASE_FILTER;
 const finite={...request,bidDomain:{...request.bidDomain,values:['90']},financingCases:[request.financingCases[0]]};
 if(!filter||filter==='no-feasible-work-basis'){
  const accepted=await api('acquisition-evaluate',{...finite,idempotencyKey:'no-feasible-existing-baseline',constraints:[{...request.constraints[0],threshold:'999'}]});
  assert.equal(accepted.status,202);await runWorker();
  const observed=await api('acquisition-read',{decisionId:accepted.body.decisionId});
  assert.equal(observed.status,200);assert.equal(observed.body.status,'TESTED');
  assert.equal(observed.body.result.maximumBid.qualification,'NO_FEASIBLE_CANDIDATE');
  assert.equal(observed.body.result.maximumBid.runId,null);
  const basis=await readAcquisitionIcBasis(ctx,{workId:work.workId,dealId:request.dealId,decisionId:accepted.body.decisionId});
  assert(basis);const effective=await getUnderwritingRun(ctx,basis.runId),original=await getUnderwritingRun(ctx,baseRun.id);
  assert.equal(effective.workId,work.workId);assert.equal(effective.scenarioId,null);
  assert.equal((effective.inputSnapshot as UnderwritingInputSnapshot).values.price!.value,'100');assert.equal(effective.inputHash,original.inputHash);
  assert.equal(original.workId,null);
  results.push({id:'no-feasible-work-basis',status:'PASS',accepted,observed,basis,effective,original});
 }
 if(filter&&filter!=='overlapping-terminal-publication')return;
 const tableLock=new pg.Client(admin.connectionParameters),rowLock=new pg.Client(admin.connectionParameters);
 await tableLock.connect();await rowLock.connect();
 const running:Promise<void>[]=[];const waits:any[]=[];
 const waitFor=async(fragment:string,count=1)=>{
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   const rows=(await admin.query("SELECT pid,query,wait_event,wait_event_type FROM pg_stat_activity WHERE usename='finnor_worker' AND wait_event_type='Lock' AND query LIKE $1",['%'+fragment+'%'])).rows;
   if(rows.length>=count){waits.push({fragment,rows});return;}
   await new Promise(yes=>setTimeout(yes,25));
  }
  throw Error('EXPECTED_PHYSICAL_SQL_WAIT_NOT_OBSERVED:'+fragment);
 };
 try{
  const accepted=await api('acquisition-evaluate',{...finite,idempotencyKey:'overlapping-original-analysis'});assert.equal(accepted.status,202);
  await tableLock.query('BEGIN');await tableLock.query('LOCK TABLE finnor_os.underwriting_runs IN SHARE MODE');
  running.push(runWorker());await waitFor('INSERT INTO finnor_os.underwriting_runs');
  await rowLock.query('BEGIN');await rowLock.query('SELECT id FROM finnor_os.acquisition_decisions WHERE id=$1 FOR UPDATE',[accepted.body.decisionId]);
  await tableLock.query('COMMIT');await waitFor('FROM finnor_os.acquisition_decisions');
  await admin.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'evaluate_acquisition_v1',$2::jsonb,$3,'batch',1,'locally_idempotent')",[tenant,JSON.stringify({tenantId:tenant,principalId:actor,decisionId:accepted.body.decisionId}),'disposable-duplicate-completion:'+randomUUID()]);
  running.push(runWorker());await waitFor('acquisition_decisions',2);
  await rowLock.query('COMMIT');await Promise.all(running);
  const observed=await api('acquisition-read',{decisionId:accepted.body.decisionId});
  const row=(await admin.query('SELECT status,result,result_digest,failure FROM finnor_os.acquisition_decisions WHERE id=$1',[accepted.body.decisionId])).rows[0];
  const jobs=(await admin.query("SELECT id,status,claim_fence,attempts,payload,last_error FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'decisionId'=$2 ORDER BY id",[tenant,accepted.body.decisionId])).rows;
  results.push({id:'overlapping-terminal-publication',status:row.status==='TESTED'?'PASS':'FAIL',accepted,observed,row,jobs,waits});
  assert.equal(row.status,'TESTED');assert.equal(observed.body.result.completeSearch,true);assert.equal(observed.body.result.maximumBid.value,null);
  assert(jobs.every((job:any)=>job.status==='completed'));
 }finally{
  await tableLock.query('ROLLBACK').catch(()=>undefined);await rowLock.query('ROLLBACK').catch(()=>undefined);
  await Promise.allSettled(running);await tableLock.end();await rowLock.end();
 }
}
