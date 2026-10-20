/** Review-derived owner falsifiers. See the preregistered additional probes.
 * All business states, decisions and model bytes come from actual owners. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {appendEvidenceVersion} from '@finnor/memory';
import {artifact} from '../x3/environment.mts';
import {reconciliation,quantity} from '../x3/business-fixtures.mts';
import {transferSpecification,transfer,modes} from './business-fixtures.mts';

export async function learningReviewProbes(f:{
 e:any;evidence:string;tenant:string;root:any;main:any;compilation:any;
 native:(who:string,operation:string,body:unknown)=>Promise<any>;
 learn:(who:string,operation:string,body:unknown)=>Promise<any>;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;
 install:(specification:any)=>Promise<any>;worker:()=>Promise<any>;
}){
 const {e,evidence,tenant,root,native,learn}=f,steps:any[]=[];
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const save=async(id:string,value:unknown)=>{steps.push({id,value});await artifact(evidence,'review-probes-progress.json',{steps,complete:false});};
 const command=(app:any,actionId:string,record:any,input:any={},who='analyst')=>native(who,'command',{
  applicationId:app.id,entityId:app.specification.model.entities[0].id,actionId,input,idempotencyKey:randomUUID(),
  ...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{}),
 });
 const read=(app:any,id:string)=>native('analyst','record',{applicationId:app.id,recordId:id});
 const grant=async(app:any,validUntil=new Date(Date.now()+3000000).toISOString())=>{
  const input={schema:'finnor.x5.training-rights.v1',applicationId:app.id,purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],
   transfer:'SAME_TENANT_COMPATIBLE_APPLICATIONS',failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',
   data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',
   knowledgeCut:new Date().toISOString(),validUntil,idempotencyKey:randomUUID()};
  return {...ok(await learn('analyst','consent',input)),input};
 };
 const original=(await e.admin.query('SELECT request FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2',[tenant,f.compilation.compilationId])).rows[0].request;
 const submit=(experience=original.experience,knowledgeCut=original.knowledgeCut)=>learn('analyst','submit',{
  schema:'finnor.x5.compile-request.v1',root,experience,knowledgeCut,idempotencyKey:randomUUID(),
  limits:{deadlineMs:3600000,maxAttempts:1,maxUses:1},
 });
 const binding=(compilation:any,app:any,record:any,mode='COMPILED_TRAINED',stratum='TRANSFER')=>({
  compilationId:compilation.compilationId,releaseId:compilation.headReleaseId,applicationId:app.id,recordId:record.id,
  expectedRevision:record.revision,expectedReference:record.reference,mode,stratum,idempotencyKey:randomUUID(),
 });
 const completedUse=async(compilation:any,input:any,who:string)=>{
  const accepted=ok(await learn(who,'execute',input),202);await f.worker();
  const use=(await e.admin.query('SELECT id,status,result,request,created_at FROM finnor_os.x5_uses WHERE tenant_id=$1 AND id=$2',[tenant,accepted.useId])).rows[0];
  assert(['DONE','WAIT'].includes(use.status),JSON.stringify(use));return {accepted,use};
 };
 try{
  const emptyGrade=await learn('evaluator','evaluate',{compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,
   useIds:[randomUUID()],retainedUseIds:[randomUUID()],idempotencyKey:randomUUID(),pass:true,results:[{complete:true}]});
  assert.equal(emptyGrade.status,400);await save('caller-grades-with-no-native-evidence',{emptyGrade});

  const mutant=reconciliation(tenant,root.entityId);mutant.id='x5-input-overwrite-negative';
  const replaced={kind:'QUANTITY_LIST' as const,entries:[{...quantity('1000000','USD',root.entityId),time:{kind:'AS_OF' as const,asOf:'2026-03-07T00:00:00.000Z'}}]};
  mutant.actions.find(v=>v.id==='reconcile')!.assignments.push(...['book','bank'].map(field=>({field,value:{op:'literal' as const,value:replaced}})));
  // This intentionally unsafe specification now overwrites the mismatch too.
  // Its own native fixture must describe that actual behavior; the independent
  // X5 original-method requirement, not a failed native install, must refuse it.
  mutant.acceptanceCases.find(v=>v.id==='one-minor-mismatch')!.expected={allowed:true,outcome:'RECONCILED',nextState:'RECONCILED'};
  const poisoned=await f.install(mutant);
  let poison=ok(await command(poisoned,'create',null,await f.values('review-input-overwrite','USD',['199','1'],'200'))).record;
  poison=ok(await command(poisoned,'reconcile',poison)).record;
  poison=ok(await command(poisoned,'approve',poison,{},'partner')).record;
  assert.equal(poison.state,'APPROVED');assert.equal(poison.values.quantity.amount,'200');assert.equal(poison.values.book.entries[0].amount,'1000000');
  const rights=await grant(poisoned),selected=ok(await learn('analyst','experience',{experience:[{applicationId:poisoned.id,recordIds:[poison.id],consentId:rights.consentId}],knowledgeCut:rights.input.knowledgeCut}));
  assert.equal(selected.acceptedCount,0);assert.equal(selected.sampleCount,0);
  await save('native-approved-input-overwrite-is-not-positive-experience',{application:poisoned,record:poison,rights,selected});

  const literalValues=await f.values('review-literal-source','USD',['199','1'],'200'),literal=literalValues.bookEvidence;
  const literalSpec=reconciliation(tenant,root.entityId);literalSpec.id='x5-literal-dependency-source';
  for(const action of literalSpec.actions.filter(v=>['reconcile','approve'].includes(v.id)))action.guards.push({
   id:'literal-source',condition:{op:'current-evidence',value:{op:'literal',value:literal}},denialCode:'LITERAL_SOURCE_STALE',requirementIds:['evidence'],
  });
  for(const example of literalSpec.acceptanceCases)example.input.currentEvidence.push(literal);
  const literalApp=await f.install(literalSpec);let literalRecord=ok(await command(literalApp,'create',null,literalValues)).record;
  literalRecord=ok(await command(literalApp,'reconcile',literalRecord)).record;
  literalRecord=ok(await command(literalApp,'approve',literalRecord,{},'partner')).record;
  const literalRights=await grant(literalApp),literalInput={experience:[{applicationId:literalApp.id,recordIds:[literalRecord.id],consentId:literalRights.consentId}],knowledgeCut:literalRights.input.knowledgeCut};
  const literalBefore=ok(await learn('analyst','experience',literalInput));assert.equal(literalBefore.acceptedCount,1);
  // Move the literal out of record.values: only the specification retains it.
  // A separate current field source prevents an ordinary field correction from
  // standing in for the required literal dependency.
  const fieldValues=await f.values('review-independent-record-source','USD',['199','1'],'200');
  literalRecord=ok(await command(literalApp,'edit',literalRecord,{bookEvidence:fieldValues.bookEvidence})).record;
  literalRecord=ok(await command(literalApp,'reconcile',literalRecord)).record;
  literalRecord=ok(await command(literalApp,'approve',literalRecord,{},'partner')).record;
  const isolatedRights=await grant(literalApp),isolatedInput={experience:[{applicationId:literalApp.id,recordIds:[literalRecord.id],consentId:isolatedRights.consentId}],knowledgeCut:isolatedRights.input.knowledgeCut};
  const isolatedBefore=ok(await learn('analyst','experience',isolatedInput));assert.equal(isolatedBefore.acceptedCount,1);
  assert(isolatedBefore.records.find((v:any)=>v.recordId===literalRecord.id).sourceRefs.some((v:any)=>v.id===literal.sourceId));
  const correction=await appendEvidenceVersion(tenant,literal.sourceId,{content:'Actual correction to required literal-only source',snapshot:{qualification:'PUBLIC_DEVELOPMENT'},asOf:new Date('2026-03-07T00:00:00Z')});
  const literalAfter=ok(await learn('analyst','experience',isolatedInput));assert.equal(literalAfter.acceptedCount,0);
  assert.equal(literalAfter.records.find((v:any)=>v.recordId===literalRecord.id).reason,'X5_ACCEPTED_SOURCE_CORRECTED_OR_STALE');
  await save('literal-only-native-source-correction-invalidates-experience',{literalApp,literalRecord,literalInput,literalBefore,isolatedInput,isolatedBefore,correction,literalAfter});

  const specification=transferSpecification(tenant,root.entityId);
  specification.id='x5-guard-dimensions-negative';specification.model.units.push('major');specification.model.accountingBases.push('ALTERNATIVE_RECORDED');
  const app=await f.install(specification);
  const valid=ok(await command(app,'openLot',null,await f.values('review-valid','USD',['3100','4900'],'8000',true),'ledger')).record;
  const baseline=await completedUse(f.compilation,binding(f.compilation,app,valid),'ledger');
  assert.equal(baseline.use.result.nativeResult.decision.allowed,true);
  for(const kind of ['false-certification','conflicting-status','units','accounting-basis']){
   const values=await f.values('review-'+kind,'USD',['3100','4900'],'8000',true);
   if(kind==='false-certification')values.feedCertified=false;
   if(kind==='conflicting-status')values.exportStatus='CONFLICTING';
   if(kind==='units')values.exportSlices.entries[0].units='major';
   if(kind==='accounting-basis')values.exportSlices.entries[0].accountingBasis='ALTERNATIVE_RECORDED';
   const record=ok(await command(app,'openLot',null,values,'ledger')).record,input=binding(f.compilation,app,record,kind==='false-certification'?'COMPILED_TRAINED':'NATIVE_EXACT');
   const result=await completedUse(f.compilation,input,'ledger'),after=ok(await read(app,record.id));
   assert.equal(after.revision,record.revision);assert.deepEqual(after.values,record.values);assert.equal(after.approvals.length,0);
   assert.equal(result.use.result.nativeResult.decision.allowed,false);
   if(kind==='false-certification'){assert.deepEqual(result.use.result.features,baseline.use.result.features);assert.equal(result.use.result.nativeResult.decision.outcome,'FEED_NOT_CERTIFIED');}
   await save('fresh-guard-'+kind,{record,input,result,after});
  }
  const outside=await f.values('review-entity-scope','USD',['3100','4900'],'8000',true);
  outside.exportSlices.entries[0].entity.id=randomUUID();
  const deniedEntity=await command(app,'openLot',null,outside,'ledger');assert.equal(deniedEntity.status,422);assert.equal(deniedEntity.body.code,'QUANTITY_ENTITY_SCOPE_MISMATCH');
  await save('entity-scope-host-refusal-not-a-model-success',{input:outside,deniedEntity});

  for(const caseId of ['F01','F09']){
   const [,currency,lines,total]=transfer.find(v=>v[0]===caseId)!,replicas:any[]=[];
   for(const mode of modes){
    const values=await f.values('review-'+caseId+':'+mode,currency,lines,total,true);
    if(caseId==='F09'){values.exportSlices={kind:'UNKNOWN',reason:'Registered export not yet observed'};values.exportStatus='UNKNOWN';}
    replicas.push({mode,values,record:ok(await command(app,'openLot',null,values,'ledger')).record});
   }
   const registered=ok(await learn('evaluator','register-assignment',{compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,caseId,
    replicas:replicas.map(v=>({mode:v.mode,applicationId:app.id,recordId:v.record.id})),idempotencyKey:randomUUID()}));
   const observations:any[]=[];
   for(const replica of replicas){
    let record=replica.record;
    const first=await completedUse(f.compilation,{...binding(f.compilation,app,record,replica.mode),assignmentRef:registered.assignmentRef},'ledger');
    if(caseId==='F09'){
     await new Promise(yes=>setTimeout(yes,Math.max(0,first.use.created_at.getTime()+8000-Date.now())));
     if(replica.mode!=='COMPILED_ORIGINAL'){
      const input=structuredClone(replica.values);
      input.exportSlices={kind:'QUANTITY_LIST',entries:[{...quantity(total,currency,root.entityId),time:{kind:'AS_OF',asOf:'2026-03-07T00:00:00.000Z'}}]};input.exportStatus='KNOWN';
      const editAction=app.specification.actions.find((v:any)=>v.kind==='update').id;
      record=ok(await command(app,editAction,record,input,'ledger')).record;
     }
     await completedUse(f.compilation,{...binding(f.compilation,app,record,replica.mode),assignmentRef:registered.assignmentRef},'ledger');
    }
    if(caseId==='F01'&&replica.mode==='COMPILED_ORIGINAL'){
     assert.equal(first.use.result.nativeInvoked,false);
     const forged=ok(await native('ledger','command',{applicationId:app.id,entityId:'settlementLot',actionId:'tieOut',recordId:record.id,
      expectedRevision:record.revision,expectedReference:record.reference,input:{},idempotencyKey:'x5-native:'+first.accepted.useId}));
     assert.equal(forged.decision.allowed,true);record=forged.record;
     observations.push({mode:replica.mode,first,actualManualReconciliation:forged});
    }else record=ok(await read(app,record.id));
    if(record.state==='TIED_OUT')record=ok(await command(app,'attest',record,{},'finance')).record;
    observations.push({mode:replica.mode,first,final:record,deliberatelyMissingObservation:caseId==='F09'&&replica.mode==='COMPILED_ORIGINAL'});
   }
   await save(caseId==='F01'?'caller-spelled-native-use-key-is-not-provenance':'two-physical-WAITs-with-unequal-resumed-inputs-are-not-parameter-gain',{caseId,registered,observations});
  }

  // A genuinely smaller original allocation reaches its own actual limits.
  const one=ok(await submit(),202);await f.worker();
  const limited=ok(await learn('analyst','read',{compilationId:one.compilationId}));assert.equal(limited.status,'DEVELOPMENT_READY');
  const retained=ok(await command(f.main,'create',null,await f.values('review-one-use','USD',['1400','2600'],'4000'))).record;
  const input=binding(limited,f.main,retained,'COMPILED_TRAINED','RETENTION');
  const duplicate=await Promise.all([learn('analyst','execute',input),learn('analyst','execute',input)]);
  assert(duplicate.every(v=>v.status===202));assert.equal(duplicate[0].body.useId,duplicate[1].body.useId);
  await f.worker();
  const replay=ok(await learn('analyst','execute',input),202);assert.equal(replay.useId,duplicate[0].body.useId);assert.equal(replay.replayed,true);
  const exhausted=await learn('analyst','execute',{...input,idempotencyKey:randomUUID()});assert.equal(exhausted.status,409);
  const retrain=await learn('analyst','retrain',{compilationId:one.compilationId,experience:original.experience,knowledgeCut:original.knowledgeCut,reason:'Actual original attempt exhausted',idempotencyKey:randomUUID()});assert.equal(retrain.status,409);
  const replacement=await learn('analyst','submit',{...original,workId:one.workId,idempotencyKey:randomUUID()});assert.equal(replacement.status,409);
  const beforeCancel=ok(await learn('analyst','read',{compilationId:one.compilationId}));
  const cancelled=ok(await learn('analyst','cancel',{compilationId:one.compilationId,reason:'Original-resource cancellation proof',idempotencyKey:randomUUID()}));
  const retry=await learn('analyst','retry',{compilationId:one.compilationId,reason:'No replenishment',idempotencyKey:randomUUID()});assert.equal(retry.status,409);
  const afterCancel=ok(await learn('analyst','read',{compilationId:one.compilationId}));
  const {dataBytes:beforeBytes,...beforeCounters}=beforeCancel.counters,{dataBytes:afterBytes,...afterCounters}=afterCancel.counters;
  assert.deepEqual(afterCounters,beforeCounters);assert(Number(afterBytes)>=Number(beforeBytes));assert.equal(afterCancel.current,false);
  const reconciliations=(await e.admin.query("SELECT id::text,body FROM finnor_os.x3_events WHERE tenant_id=$1 AND record_id=$2 AND kind='BUSINESS_COMMAND' AND body->'input'->>'actionId'='reconcile'",[tenant,retained.id])).rows;assert.equal(reconciliations.length,1);
  await save('concurrent-duplicate-replay-and-finite-original-resources',{one,limited,input,duplicate,replay,exhausted,retrain,replacement,beforeCancel,cancelled,retry,afterCancel,reconciliations});

  const retentionRecord=ok(await command(f.main,'create',null,await f.values('review-evaluator-retention','USD',['1400','2600'],'4000'))).record;
  await completedUse(f.compilation,binding(f.compilation,f.main,retentionRecord,'COMPILED_TRAINED','RETENTION'),'analyst');
  const census=(await e.admin.query('SELECT id,request FROM finnor_os.x5_uses WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY created_at,id',[tenant,f.compilation.compilationId])).rows;
  const request={compilationId:f.compilation.compilationId,releaseId:f.compilation.headReleaseId,
   useIds:census.filter((v:any)=>v.request.stratum!=='RETENTION').map((v:any)=>v.id),retainedUseIds:census.filter((v:any)=>v.request.stratum==='RETENTION').map((v:any)=>v.id),idempotencyKey:randomUUID()};
  const self=await learn('analyst','evaluate',request);assert.equal(self.status,403);
  const duplicated=await learn('evaluator','evaluate',{...request,useIds:[request.useIds[0],request.useIds[0]]});assert.equal(duplicated.status,400);
  const incomplete=ok(await learn('evaluator','evaluate',request),202);await f.worker();
  const incompleteRow=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,incomplete.evaluationId])).rows[0];
  assert.equal(incompleteRow.status,'COMPLETE');assert.equal(incompleteRow.result.disposition,'REFUSED_OR_INCOMPLETE');assert.equal(incompleteRow.result.parameterBehaviorDifference,false);
  const spoof=incompleteRow.result.outcomes.find((v:any)=>v.caseId==='F01'&&v.mode==='COMPILED_ORIGINAL');
  assert.equal(spoof.complete,false);assert.equal(spoof.nativeReconciliationRef,null);assert(spoof.safetyViolations.includes('LEARNED_NATIVE_OUTCOME_NOT_ATOMICALLY_BOUND'));
  for(const outcome of incompleteRow.result.outcomes.filter((v:any)=>v.caseId==='F09')){assert.equal(outcome.complete,false);assert(outcome.safetyViolations.includes('RESUMED_ARM_SURROUNDINGS_NOT_EQUIVALENT'));}
  const omitted=ok(await learn('evaluator','evaluate',{...request,useIds:request.useIds.slice(1),idempotencyKey:randomUUID()}),202);await f.worker();
  const omittedRow=(await e.admin.query('SELECT id,status,result FROM finnor_os.x5_evaluations WHERE tenant_id=$1 AND id=$2',[tenant,omitted.evaluationId])).rows[0];
  assert.equal(omittedRow.status,'FAILED');assert.equal(omittedRow.result.error,'X5_EVALUATION_CENSUS_INCOMPLETE');
  await save('no-physical-census-gain-self-duplicate-or-omission',{request,self,duplicated,incomplete,incompleteRow,omitted,omittedRow});

  const expiresAt=Date.now()+7000,offset=new Date(expiresAt+5*3600000).toISOString().replace('Z','+05:00'),short=await grant(f.main,offset);
  const shortRequest=original.experience.map((v:any)=>({...v,consentId:short.consentId})),negative=ok(await submit(shortRequest,short.input.knowledgeCut),202),gate=74505020;
  let pending:Promise<PromiseSettledResult<any>[]>|undefined;
  await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[gate]);
  try{
   await e.admin.query(`CREATE FUNCTION finnor_os.x5_review_publication_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.compilation_id=TG_ARGV[0]::uuid AND NEW.kind='RELEASE_PUBLISHED_DEVELOPMENT'
     THEN PERFORM pg_advisory_xact_lock(74505020::bigint);END IF;RETURN NEW;END $$`);
   await e.admin.query(`CREATE TRIGGER x5_review_publication_gate AFTER INSERT ON finnor_os.x5_events FOR EACH ROW
    EXECUTE FUNCTION finnor_os.x5_review_publication_gate('${negative.compilationId}')`);
   pending=Promise.allSettled([f.worker()]);
   const until=Date.now()+10000;let held=false;
   while(!held){held=!!(await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[gate])).rowCount;assert(Date.now()<until,'ACTUAL_PUBLICATION_GATE_REQUIRED');if(!held)await new Promise(yes=>setTimeout(yes,20));}
   await new Promise(yes=>setTimeout(yes,Math.max(0,expiresAt-Date.now()+30)));
   const clock=(await e.admin.query('SELECT clock_timestamp() now')).rows[0].now;assert(clock.getTime()>expiresAt);
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);
   const [result]=await pending;if(result!.status==='rejected')throw result!.reason;
   const view=ok(await learn('analyst','read',{compilationId:negative.compilationId}));assert.equal(view.status,'FAILED');assert.equal(view.headReleaseId,null);
   const releases=(await e.admin.query('SELECT id FROM finnor_os.x5_releases WHERE tenant_id=$1 AND compilation_id=$2',[tenant,negative.compilationId])).rows;assert.equal(releases.length,0);
   const events=(await e.admin.query('SELECT kind,body FROM finnor_os.x5_events WHERE tenant_id=$1 AND compilation_id=$2 ORDER BY id',[tenant,negative.compilationId])).rows;
   await artifact(evidence,'publication-expiry-observation.json',{short,expiresAt,clock,negative,view,releases,events,actualPublicationGate:true});
   assert(events.some((v:any)=>v.kind==='TRAINING_METRICS'&&v.body.pid));assert(events.some((v:any)=>v.kind==='OPERATION_FAILED'&&v.body.error==='APPLICATION_AUTHORITY_EXPIRED'));
   await save('offset-consent-expiry-fences-real-publication-commit',{short,expiresAt,clock,negative,view,releases,events,actualPublicationGate:true});
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[gate]);if(pending)await pending;
   await e.admin.query('DROP TRIGGER IF EXISTS x5_review_publication_gate ON finnor_os.x5_events');await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_review_publication_gate()');
  }

  // The real authority writer must wait behind the actual native commit. This
  // is a lock fence, not a claim that a revoked role authorized the mutation.
  const race=ok(await command(app,'openLot',null,await f.values('review-authority-race','USD',['3100','4900'],'8000',true),'ledger')).record;
  const scopeRecord=ok(await command(app,'openLot',null,await f.values('review-removed-scope','USD',['3100','4900'],'8000',true),'ledger')).record;
  const accepted=ok(await learn('ledger','execute',binding(f.compilation,app,race)),202),commitGate=74505021;
  const editor=new pg.Client({connectionString:e.adminUrl});await editor.connect();
  let work:Promise<PromiseSettledResult<any>[]>|undefined,edit:Promise<PromiseSettledResult<any>[]>|undefined;
  await e.admin.query('SELECT pg_advisory_lock($1::bigint)',[commitGate]);
  try{
   await e.admin.query(`CREATE FUNCTION finnor_os.x5_review_native_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.record_id=TG_ARGV[0]::uuid AND NEW.kind='BUSINESS_COMMAND'
     THEN PERFORM pg_advisory_xact_lock(74505021::bigint);END IF;RETURN NEW;END $$`);
   await e.admin.query(`CREATE TRIGGER x5_review_native_gate AFTER INSERT ON finnor_os.x3_events FOR EACH ROW
    EXECUTE FUNCTION finnor_os.x5_review_native_gate('${race.id}')`);
   work=Promise.allSettled([f.worker()]);
   const until=Date.now()+10000;let held=false;
   while(!held){held=!!(await e.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=$1 AND NOT granted",[commitGate])).rowCount;assert(Date.now()<until,'ACTUAL_POST_INFERENCE_NATIVE_GATE_REQUIRED');if(!held)await new Promise(yes=>setTimeout(yes,20));}
   const grant=(await e.admin.query(`SELECT a.id,a.employee_id FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r ON r.id=a.role_id
    WHERE a.tenant_id=$1 AND r.key='x5_ledger_operator' AND a.active`,[tenant])).rows[0];assert(grant);
   const editorPid=(await editor.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   edit=Promise.allSettled([editor.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND id=$2',[tenant,grant.id])]);
   let waiting=false;
   while(!waiting){waiting=!!(await e.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[editorPid])).rowCount;assert(Date.now()<until,'AUTHORITY_CHANGE_MUST_WAIT_FOR_NATIVE_COMMIT');if(!waiting)await new Promise(yes=>setTimeout(yes,20));}
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[commitGate]);
   const [worked]=await work;if(worked!.status==='rejected')throw worked!.reason;
   const [edited]=await edit;if(edited!.status==='rejected')throw edited!.reason;
   const event=(await e.admin.query("SELECT body,pg_xact_commit_timestamp(xmin) committed_at FROM finnor_os.x3_events WHERE tenant_id=$1 AND record_id=$2 AND kind='BUSINESS_COMMAND' ORDER BY id DESC LIMIT 1",[tenant,race.id])).rows[0];
   const authority=(await e.admin.query('SELECT active,pg_xact_commit_timestamp(xmin) committed_at FROM finnor_os.employee_role_assignments WHERE id=$1',[grant.id])).rows[0];
   assert(event.body.result.decision.allowed);assert.equal(authority.active,false);assert(event.committed_at.getTime()<=authority.committed_at.getTime());
   const scoped=ok(await command(app,'tieOut',scopeRecord,{},'ledger'));assert.equal(scoped.decision.allowed,false);assert.equal(scoped.decision.outcome,'ROLE_DENIED');
   await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=true WHERE id=$1',[grant.id]);
   await save('requested-authority-revocation-locks-behind-native-commit',{race,scopeRecord,accepted,event,authority,writerActuallyBlocked:waiting,scoped});
  }finally{
   await e.admin.query('SELECT pg_advisory_unlock($1::bigint)',[commitGate]);if(work)await work;if(edit)await edit;await editor.end();
   await e.admin.query('DROP TRIGGER IF EXISTS x5_review_native_gate ON finnor_os.x3_events');await e.admin.query('DROP FUNCTION IF EXISTS finnor_os.x5_review_native_gate()');
  }
  let old=ok(await command(f.main,'create',null,await f.values('review-regrant','USD',['199','1'],'200'))).record;
  old=ok(await command(f.main,'reconcile',old)).record;old=ok(await command(f.main,'approve',old,{},'partner')).record;
  const beforeRights=await grant(f.main),beforeRevision=ok(await learn('analyst','experience',{
   experience:[{applicationId:f.main.id,recordIds:[old.id],consentId:beforeRights.consentId}],knowledgeCut:beforeRights.input.knowledgeCut}));
  assert.equal(beforeRevision.acceptedCount,1);
  const partnerGrant=(await e.admin.query(`SELECT a.id FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r ON r.id=a.role_id
   WHERE a.tenant_id=$1 AND a.employee_id=$2 AND r.key='x3_partner' AND a.active`,[tenant,old.approvals[0].principalId])).rows[0];assert(partnerGrant);
  await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE id=$1',[partnerGrant.id]);
  await e.admin.query('UPDATE finnor_os.employee_role_assignments SET active=true WHERE id=$1',[partnerGrant.id]);
  const again=await grant(f.main);
  const afterRevision=ok(await learn('analyst','experience',{experience:[{applicationId:f.main.id,recordIds:[old.id],consentId:again.consentId}],knowledgeCut:again.input.knowledgeCut}));
  assert.equal(afterRevision.acceptedCount,0);assert.equal(afterRevision.records.find((v:any)=>v.recordId===old.id).reason,'X5_ACCEPTANCE_CHECKER_AUTHORITY_NOT_CURRENT');
  const prepare=ok(await command(f.main,'prepare',old));assert.equal(prepare.decision.allowed,false);assert.equal(prepare.decision.outcome,'APPROVER_AUTHORITY_REVOKED');
  const noRevival=ok(await learn('analyst','read',{compilationId:f.compilation.compilationId}));assert.equal(noRevival.current,false);assert.equal(noRevival.capsule,null);
  await save('regrant-does-not-revive-old-native-approval-or-learned-release',{old,beforeRights,beforeRevision,partnerGrant,again,prepare,afterRevision,noRevival});
  const report={schema:'finnor.x5.review-owner-probes.v1',allPassed:true,steps,protectedAdmission:false,productionActive:false,
   notEstablished:['COMPLETE_FAULT_AND_EXHAUSTION_MATRIX','PROTECTED_CUSTODY','ELAPSED_DEADLINE_HARM']};
  await artifact(evidence,'review-probes.json',report);return report;
 }catch(error){await artifact(evidence,'review-probes-FAILED.json',{error:String(error),stack:(error as Error).stack,steps});throw error;}
}
