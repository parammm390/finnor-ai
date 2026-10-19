/** Extra real HTTP/SQL owner probes. These never seed outcomes or labels and
 * never replace the frozen four-arm assignments. See additional-probes.md. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {artifact} from '../x3/environment.mts';
import {reconciliation} from '../x3/business-fixtures.mts';

export async function learningBoundaryProbes(f:{
 e:any;evidence:string;tenant:string;root:any;main:any;b1?:any;compilation:any;
 native:(who:string,operation:string,body:unknown)=>Promise<any>;
 learn:(who:string,operation:string,body:unknown)=>Promise<any>;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;
 install:(specification:any)=>Promise<any>;worker:()=>Promise<any>;
 useIds:string[];retainedUseIds:string[];
}){
 const {e,evidence,tenant,root,native,learn}=f,steps:any[]=[];
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const save=async(id:string,value:unknown)=>{steps.push({id,value});await artifact(evidence,'additional-owner-progress.json',{steps,complete:false});};
 const command=(app:any,actionId:string,record:any,input:any={},who='analyst')=>native(who,'command',{
  applicationId:app.id,entityId:'reconciliation',actionId,input,idempotencyKey:randomUUID(),
  ...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{}),
 });
 const consentBody=(app:any,knowledgeCut=new Date().toISOString(),validUntil=new Date(Date.now()+3000000).toISOString())=>({
  schema:'finnor.x5.training-rights.v1',applicationId:app.id,purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],
  transfer:'SAME_TENANT_COMPATIBLE_APPLICATIONS',failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',
  data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',
  knowledgeCut,validUntil,idempotencyKey:randomUUID(),
 });
 const grant=async(app:any,cut?:string,until?:string)=>{const input=consentBody(app,cut,until);return {...ok(await learn('analyst','consent',input)),input};};
 const select=(app:any,recordId:string,rights:any,extra:Record<string,unknown>={})=>learn('analyst','experience',{
  experience:[{applicationId:app.id,recordIds:[recordId],consentId:rights.consentId}],knowledgeCut:rights.input.knowledgeCut,...extra,
 });
 const create=async(app:any,label:string)=>ok(await command(app,'create',null,await f.values(label,'USD',['199','1'],'200'))).record;
 const reconcile=async(app:any,r:any)=>{const result=ok(await command(app,'reconcile',r));assert(result.decision.allowed);assert.equal(result.record.state,'RECONCILED');return result.record;};
 const approve=async(app:any,r:any)=>{const result=ok(await command(app,'approve',r,{},'partner'));assert(result.decision.allowed);assert.equal(result.record.state,'APPROVED');return result.record;};
 const approved=async(app:any,label:string)=>approve(app,await reconcile(app,await create(app,label)));
 try{
  // A separate ordinary source application has no training rights yet.
  const other=await f.install(reconciliation(tenant,root.entityId));
  const p03=await approved(other,'P03');
  const absent={consentId:randomUUID(),input:{knowledgeCut:new Date().toISOString()}};
  const noRights=await select(other,p03.id,absent);assert.equal(noRights.status,403);
  await save('P03-real-approved-without-training-consent',{record:p03,noRights});

  let p02=await approved(f.main,'P02');
  p02=ok(await command(f.main,'edit',p02,{memo:'Actual post-approval correction P02'})).record;
  assert.equal(p02.state,'DRAFT');assert.equal(p02.approvals.length,0);
  const p02Rights=await grant(f.main),p02Cut=ok(await select(f.main,p02.id,p02Rights));
  assert.equal(p02Cut.acceptedCount,0);assert.equal(p02Cut.records.find((r:any)=>r.recordId===p02.id).reason,'X5_CURRENT_ACCEPTED_OUTCOME_REQUIRED');
  await save('P02-approved-then-edited',{record:p02,rights:p02Rights,selection:p02Cut});

  let p04=await reconcile(other,await create(other,'P04'));
  const beforeApproval=(await e.admin.query('SELECT clock_timestamp() AS cut')).rows[0].cut.toISOString();
  p04=await approve(other,p04);
  const p04Rights=await grant(other,beforeApproval),p04Cut=ok(await select(other,p04.id,p04Rights));
  assert.equal(p04Cut.acceptedCount,0);assert.equal(p04Cut.records.find((r:any)=>r.recordId===p04.id).reason,'X5_FUTURE_OR_POSTCUT_HISTORY_PRESENT');
  await save('P04-real-approval-beyond-cut',{record:p04,rights:p04Rights,selection:p04Cut});

  const currentRights=await grant(other);
  const forged=await select(other,p03.id,currentRights,{acceptanceReceipt:{pass:true,owner:'X3_EVENT',id:randomUUID()}});
  assert.equal(forged.status,400);
  const missingId=randomUUID(),missing=ok(await select(other,missingId,currentRights));
  assert.equal(missing.acceptedCount,0);assert.equal(missing.records.find((r:any)=>r.recordId===missingId).reason,'MISSING_CANONICAL_RECORD');
  await save('P05-fabricated-and-nonresolving-reference',{forged,missingId,missing});

  const p06=await approved(other,'P06'),revokedRights=await grant(other);
  const revoked=ok(await learn('analyst','revoke-consent',{consentId:revokedRights.consentId,reason:'P06 actual pre-selection revocation',idempotencyKey:randomUUID()}));
  const denied=await select(other,p06.id,revokedRights);assert.equal(denied.status,403);
  const expires=new Date(Date.now()+1500).toISOString(),expiredRights=await grant(other,undefined,expires);
  await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(expires)-Date.now()+20)));
  const expired=await select(other,p06.id,expiredRights);assert.equal(expired.status,403);
  await save('P06-revoked-and-expired-real-lineage',{record:p06,revokedRights,revoked,denied,expiredRights,expired});

  const missingPurpose=await learn('analyst','consent',{...consentBody(other),purposes:['TRAIN_STRUCTURAL_CONTROLLER']});assert.equal(missingPurpose.status,400);
  const nonOwner=await learn('partner','consent',consentBody(other));assert.equal(nonOwner.status,403);
  const futureCut=await learn('analyst','consent',consentBody(other,new Date(Date.now()+60000).toISOString()));assert.equal(futureCut.status,400);
  const wrongScope=await select(f.main,p02.id,currentRights);assert.equal(wrongScope.status,403);
  const beyondScope=await learn('analyst','experience',{experience:[{applicationId:other.id,recordIds:[p03.id],consentId:p04Rights.consentId}],knowledgeCut:currentRights.input.knowledgeCut});
  assert.equal(beyondScope.status,403);
  await save('rights-purpose-owner-scope-and-cut',{missingPurpose,nonOwner,futureCut,wrongScope,beyondScope});

  // Real native approval is held after event allocation/insertion. Its server
  // timestamp is before K, but the committed transaction must be after K.
  let late=await reconcile(other,await create(other,'late-commit'));
  const gate=74505019;
  await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
  let pending:Promise<PromiseSettledResult<any>[]>|undefined,held=false;
  try{
   await e.admin.query(`CREATE FUNCTION finnor_os.x5_disposable_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.record_id=TG_ARGV[0]::uuid AND NEW.kind='BUSINESS_COMMAND'
     AND NEW.body->'result'->'record'->>'state'='APPROVED'
     THEN PERFORM pg_advisory_xact_lock(74505019::bigint);END IF;RETURN NEW;END $$`);
   await e.admin.query(`CREATE TRIGGER x5_disposable_commit_gate AFTER INSERT ON finnor_os.x3_events
    FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_disposable_commit_gate('${late.id}')`);
   pending=Promise.allSettled([command(other,'approve',late,{},'partner')]);
   const until=Date.now()+10000;
   while(!held){
    held=!!(await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[gate])).rowCount;
    assert(Date.now()<until,'ACTUAL_NATIVE_APPROVAL_COMMIT_GATE_NOT_REACHED');
    if(!held)await new Promise(yes=>setTimeout(yes,20));
   }
   const cut=(await e.admin.query('SELECT clock_timestamp() AS cut')).rows[0].cut.toISOString();
   await new Promise(yes=>setTimeout(yes,30));
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);
   const [settled]=await pending;if(settled!.status==='rejected')throw settled!.reason;
   late=ok(settled!.value).record;assert.equal(late.state,'APPROVED');
   const event=(await e.admin.query(`SELECT id::text,actor_id,created_at,pg_xact_commit_timestamp(xmin) committed_at,body
    FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND record_id=$3 AND kind='BUSINESS_COMMAND'
     AND body->'result'->'record'->>'state'='APPROVED' ORDER BY id DESC LIMIT 1`,[tenant,other.id,late.id])).rows[0];
   assert(event.created_at.getTime()<=Date.parse(cut));assert(event.committed_at.getTime()>Date.parse(cut));
   const rights=await grant(other,cut),selection=ok(await select(other,late.id,rights));
   assert.equal(selection.acceptedCount,0);assert.equal(selection.records.find((r:any)=>r.recordId===late.id).reason,'X5_FUTURE_OR_POSTCUT_HISTORY_PRESENT');
   await save('late-commit-not-sequence-or-created-at',{cut,event,record:late,rights,selection,actualCommitGateReached:held});
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);
   if(pending)await pending;
   await e.admin.query('DROP TRIGGER IF EXISTS x5_disposable_commit_gate ON finnor_os.x3_events');
   await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_disposable_commit_gate()');
  }

  let overflow=await create(other,'history-64');
  for(let i=0;i<61;i++)overflow=ok(await command(other,'edit',overflow,{memo:'Lawful history edit '+i})).record;
  overflow=await approve(other,await reconcile(other,overflow));
  const history=(await e.admin.query('SELECT h.id::text,h.actor_id,h.kind,h.body FROM finnor_os.x3_events h WHERE h.tenant_id=$1 AND h.application_id=$2 AND h.record_id=$3 ORDER BY h.id',[tenant,other.id,overflow.id])).rows;
  assert.equal(history.length,64);
  const exactRights=await grant(other),atBound=ok(await select(other,overflow.id,exactRights));assert.equal(atBound.acceptedCount,1);
  const pages:any[]=[],ids:string[]=[];let before:string|undefined;
  for(let i=0;i<40;i++){
   const page=ok(await native('analyst','history',{applicationId:other.id,recordId:overflow.id,limit:2,...(before?{before}:{})}));
   assert(Array.isArray(page.events),'NATIVE_HISTORY_PAGE_EVENTS_REQUIRED');
   pages.push(page);ids.push(...page.events.map((v:any)=>v.id));
   if(page.events.length<2)break;
   const next=page.events.at(-1).id;assert(next!==before);before=next;
  }
  assert.equal(new Set(ids).size,64);assert.deepEqual(ids.slice().sort(),history.map((v:any)=>v.id).sort());
  overflow=ok(await command(other,'edit',overflow,{memo:'The 65th genuine event'})).record;
  overflow=await approve(other,await reconcile(other,overflow));
  const overRights=await grant(other),over=await select(other,overflow.id,overRights);
  assert.equal(over.status,409);assert.equal(over.body.code,'X5_COMPLETE_RECORD_HISTORY_BOUND');
  await save('complete-pagination-and-exact-history-bound',{history,pages,atBound,approvedOverflow:overflow,over});

  if(f.useIds.length&&f.retainedUseIds.length){
   const request={compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,useIds:f.useIds,retainedUseIds:f.retainedUseIds,idempotencyKey:randomUUID()};
   const grade=await learn('evaluator','evaluate',{...request,pass:true,results:[{complete:true}]});assert.equal(grade.status,400);
   const self=await learn('analyst','evaluate',request);assert.equal(self.status,403);
   const duplicate=await learn('evaluator','evaluate',{...request,useIds:[f.useIds[0],f.useIds[0]]});assert.equal(duplicate.status,400);
   const omitted=ok(await learn('evaluator','evaluate',{...request,useIds:f.useIds.slice(1),idempotencyKey:randomUUID()}),202);
   await f.worker();
   const row=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,omitted.evaluationId])).rows[0];
   assert.equal(row.status,'FAILED');assert.equal(row.result.error,'X5_EVALUATION_CENSUS_INCOMPLETE');
   await save('evaluator-grades-self-duplicate-and-omission',{grade,self,duplicate,omitted,evaluation:row});
  }
  const report={schema:'finnor.x5.additional-owner-probes.v1',allPassed:true,steps,protectedAdmission:false,productionActive:false,
   notEstablished:['COMPLETE_FAULT_AND_EXHAUSTION_MATRIX','PROTECTED_CUSTODY','ELAPSED_DEADLINE_HARM','EMITTED_RUNTIME_OR_BROWSER_BY_THIS_REPORT']};
  await artifact(evidence,'additional-owner-probes.json',report);return report;
 }catch(error){await artifact(evidence,'additional-owner-FAILED.json',{error:String(error),stack:(error as Error).stack,steps});throw error;}
}
