/** Compiler-only temporal authority, using real source approvals and a held
 * physical publication. No source/rights expiry substitutes for caller expiry. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {artifact} from '../x3/environment.mts';
export async function learningCallerExpiry(f:{
 e:any;evidence:string;tenant:string;root:any;people:Record<string,string>;main:any;
 native:(who:string,operation:string,body:unknown)=>Promise<any>;
 learn:(who:string,operation:string,body:unknown)=>Promise<any>;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;worker:()=>Promise<any>;
}){
 const {e,tenant,root,main,native,learn}=f,ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const command=(actionId:string,r:any,input:unknown={})=>native(actionId==='approve'?'partner':'analyst','command',{
  applicationId:main.id,entityId:'reconciliation',actionId,input,idempotencyKey:randomUUID(),
  ...(r?{recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference}:{}),
 });
 const records:any[]=[];
 for(let i=0;i<8;i++){
  const created=ok(await command('create',null,await f.values('caller-expiry-'+i,'USD',['199','1'],'200'))).record;
  records.push(ok(await command('reconcile',created)).record);
 }
 const expiresAt=Date.now()+7000,grants=(await e.admin.query(`UPDATE finnor_os.employee_role_assignments
  SET expires_at=$3 WHERE tenant_id=$1 AND employee_id=$2 AND active RETURNING id,role_id,expires_at`,
  [tenant,f.people.ledger,new Date(expiresAt)])).rows;assert(grants.length);
 for(let i=0;i<records.length;i++)records[i]=ok(await command('approve',records[i])).record;
 const knowledgeCut=new Date().toISOString(),rights=ok(await learn('analyst','consent',{
  schema:'finnor.x5.training-rights.v1',applicationId:main.id,purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],
  transfer:'SAME_TENANT_COMPATIBLE_APPLICATIONS',failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',
  data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',
  knowledgeCut,validUntil:new Date(Date.now()+600000).toISOString(),idempotencyKey:randomUUID(),
 }));
 const experience=[{applicationId:main.id,recordIds:records.map(r=>r.id),consentId:rights.consentId}];
 const sourceBefore=ok(await learn('analyst','experience',{experience,knowledgeCut}));assert.equal(sourceBefore.acceptedCount,8);
 const accepted=ok(await learn('ledger','submit',{schema:'finnor.x5.compile-request.v1',root,experience,knowledgeCut,
  limits:{deadlineMs:3600000,maxAttempts:1,maxUses:1},idempotencyKey:randomUUID()}),202);
 const gate=74505060;let pending:Promise<PromiseSettledResult<any>[]>|undefined;
 await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
 try{
  await e.admin.query(`CREATE FUNCTION finnor_os.x5_caller_expiry_gate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.compilation_id=TG_ARGV[0]::uuid AND NEW.kind='RELEASE_PUBLISHED_DEVELOPMENT'
    THEN PERFORM pg_advisory_xact_lock(74505060::bigint);END IF;RETURN NEW;END $$`);
  await e.admin.query(`CREATE TRIGGER x5_caller_expiry_gate AFTER INSERT ON finnor_os.x5_events FOR EACH ROW
   EXECUTE FUNCTION finnor_os.x5_caller_expiry_gate('${accepted.compilationId}')`);
  pending=Promise.allSettled([f.worker()]);let held=false;
  while(!held){
   held=!!(await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[gate])).rowCount;
   assert(Date.now()<expiresAt,'PUBLICATION_MUST_BEGIN_UNDER_THE_ORIGINAL_COMPILER_GRANT');
   if(!held)await new Promise(yes=>setTimeout(yes,15));
  }
  await new Promise(yes=>setTimeout(yes,Math.max(0,expiresAt-Date.now()+25)));
  await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);await pending;
  const compilation=(await e.admin.query('SELECT id,status,head_release_id,attempt_count,max_attempts,deadline_at FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2',[tenant,accepted.compilationId])).rows[0];
  const releases=(await e.admin.query('SELECT id FROM finnor_os.x5_releases WHERE tenant_id=$1 AND compilation_id=$2',[tenant,accepted.compilationId])).rows;
  const events=(await e.admin.query('SELECT kind,body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY id',[tenant,accepted.compilationId])).rows;
  const sourceAfter=ok(await learn('analyst','experience',{experience,knowledgeCut}));
  const report={schema:'finnor.x5.compiler-caller-expiry.v1',grants,expiresAt,accepted,sourceBefore,sourceAfter,compilation,releases,events,
   actualPublicationGate:held,extraEligibleScientificAssignments:0,protectedAdmission:false,productionActive:false};
  await artifact(f.evidence,'compiler-caller-expiry.json',report);
  assert.equal(sourceAfter.acceptedCount,8);assert.equal(compilation.head_release_id,null);assert.equal(releases.length,0);
  assert.equal(compilation.attempt_count,1);assert.equal(compilation.max_attempts,1);assert.equal(compilation.status,'FAILED');
  assert(events.some((v:any)=>v.kind==='TRAINING_METRICS'&&v.body.pid));
  assert(events.some((v:any)=>v.kind==='OPERATION_FAILED'&&v.body.error==='APPLICATION_AUTHORITY_EXPIRED'));
  assert(!events.some((v:any)=>v.kind==='RELEASE_PUBLISHED_DEVELOPMENT'));
  return {...report,allPassed:true};
 }finally{
  await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);if(pending)await pending;
  await e.admin.query('DROP TRIGGER IF EXISTS x5_caller_expiry_gate ON finnor_os.x5_events');
  await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_caller_expiry_gate()');
 }
}
