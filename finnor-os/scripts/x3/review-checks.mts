/** Installed regressions from scope-x3/review-verification-plan.md. No frozen
 * vector or expected answer is changed; all writes target disposable owners. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {withTenantClientTransaction} from '@finnor/db';
import {appendEvidenceVersion} from '@finnor/memory';
import {exceptionRegister,quantity,literal,field} from './business-fixtures.mts';
import {artifact,hash,repo} from './environment.mts';
export async function installedReviewChecks(f:any){
 const {e,tenant,root,api,people,evidence,finish,runWorker,support}=f,checks:any[]=[];
 const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
 const before=support.current??support.ref;
 const version=await appendEvidenceVersion(tenant,before.sourceId,{content:'Review-boundary second pin',snapshot:{qualification:'DECLARED_DEVELOPMENT_INPUT'},asOf:new Date()});
 const row=(await e.admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[version.versionId])).rows[0];
 const current={...before,versionId:version.versionId,contentDigest:row.content_hash};
 const spec=exceptionRegister(tenant,root.entityId);spec.id='review-boundary-application';
 spec.model.entities[0]!.fields.push(
  {id:'pin',title:'Earlier source pin',type:'evidence',required:true,allowUnknown:false},
  {id:'positions',title:'Exact retained positions',type:'quantity-list',required:true,allowUnknown:false},
  {id:'derivedQuantity',title:'Generated quantity',type:'quantity',required:false,allowUnknown:false},
  {id:'thresholdQuantity',title:'Explicitly unknown conditional quantity',type:'quantity',required:false,allowUnknown:true});
 spec.actions.find(a=>a.id==='create')!.inputFields.push('pin','positions','thresholdQuantity');
 spec.actions.find(a=>a.id==='document')!.guards.push({id:'decimal-equality',condition:{op:'equal',left:literal(quantity('1','USD',root.entityId)),right:literal(quantity('1.0','USD',root.entityId))},denialCode:'DECIMAL_SPELLING_CHANGED_VALUE',requirementIds:['controls']});
 const base=spec.actions.find(a=>a.id==='document')!;
 spec.actions.push({...base,id:'negated-stale',title:'Negated stale pin must remain unknown',toState:'OPEN',
  guards:[{id:'negated-current',condition:{op:'not',value:{op:'current-evidence',value:field('pin')}},denialCode:'CURRENT_PIN_NEGATED',requirementIds:['controls']}],outcome:'NEVER_FROM_STALE'});
 spec.actions.push({...base,id:'derive-foreign',title:'Host must refuse foreign-root generated values',toState:'OPEN',guards:[],
  assignments:[{field:'derivedQuantity',value:literal(quantity('1','USD',randomUUID()))}],outcome:'PURE_VALUE_ONLY'});
 for(const empty of [false,true])spec.actions.push({...base,id:empty?'empty-approval':'unknown-approval',title:empty?'Empty approval policy refuses':'UNKNOWN approval predicate refuses',
  roles:['reviewer'],guards:[],toState:'CLOSED',approval:{requirements:[{role:'reviewer',when:empty?literal(false):
   {op:'compare',comparison:'gte',left:field('thresholdQuantity'),right:literal(quantity('0','USD',root.entityId))}}],
   noSelfApproval:true,distinctPrincipals:true,pendingOutcome:'REVIEW_PENDING'}});
 const vector=spec.acceptanceCases[0]!;
 vector.input.record!.values.pin=before;vector.input.record!.values.positions={kind:'QUANTITY_LIST',entries:[quantity('1','USD',root.entityId)]};
 vector.input.record!.values.thresholdQuantity={kind:'UNKNOWN',reason:'DECLARED_MISSING_QUANTITY'};
 const staleVector=structuredClone(vector);staleVector.id='negated-stale';staleVector.input.actionId='negated-stale';
 staleVector.input.currentEvidence=[];staleVector.expected={allowed:false,outcome:'SOURCE_STALE',nextState:'OPEN'};
 spec.acceptanceCases.push(staleVector);
 for(const [actionId,outcome] of [['unknown-approval','UNKNOWN_VALUE'],['empty-approval','APPROVAL_POLICY_EMPTY']]){
  const negative=structuredClone(vector);negative.id=actionId!;negative.input.actionId=actionId!;
  negative.input.actor={...negative.input.actor,principalId:'independent-reviewer',canonicalRoles:['x3_partner']};
  negative.expected={allowed:false,outcome:outcome!,nextState:'OPEN'};spec.acceptanceCases.push(negative);
 }
 const request={schema:'finnor.x3.application-request.v1',root,specification:spec,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000}};
 const accepted=ok(await api('analyst','submit',request),202),installed=await finish(accepted.applicationId),applicationId=accepted.applicationId;
 assert.equal(installed.package.proofs.protectedCustody,false);
 const input={pin:before,memo:'Review-boundary retained input',remediation:'Independently declared controls',support:current,thresholdQuantity:{kind:'UNKNOWN',reason:'DECLARED_MISSING_QUANTITY'},
  positions:{kind:'QUANTITY_LIST',entries:Array.from({length:128},(_,i)=>quantity(String(i+1),'USD',root.entityId))}};
 const command=(actionId:string,r:any=null,values:unknown={},idempotencyKey=randomUUID())=>api('analyst','command',{applicationId,entityId:'control_exception',actionId,input:values,idempotencyKey,
  ...(r?{recordId:r.id,expectedRevision:r.revision,expectedReference:r.reference}:{})});
 let record=ok(await command('create',null,input)).record;
 assert.equal(record.currentness,'STALE');
 const stale=ok(await command('negated-stale',record));assert.equal(stale.decision.outcome,'SOURCE_STALE');assert.equal(stale.decision.allowed,false);
 const foreign=await command('derive-foreign',record);assert.equal(foreign.status,422);assert.equal(foreign.body.code,'QUANTITY_ENTITY_SCOPE_MISMATCH');
 const unchanged=ok(await api('analyst','record',{applicationId,recordId:record.id}));assert.equal(unchanged.revision,record.revision);assert.equal(unchanged.values.derivedQuantity,undefined);
 const approvalRefusals=[];
 for(const [actionId,outcome] of [['unknown-approval','UNKNOWN_VALUE'],['empty-approval','APPROVAL_POLICY_EMPTY']]){
  const refusal=ok(await api('partner','command',{applicationId,entityId:'control_exception',actionId,recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference,input:{},idempotencyKey:randomUUID()}));
  assert.equal(refusal.decision.allowed,false);assert.equal(refusal.decision.outcome,outcome);assert.equal(refusal.record.approvals.length,0);assert.equal(refusal.record.revision,record.revision);
  approvalRefusals.push(refusal);
 }
 const decimal=ok(await command('document',record));assert.equal(decimal.decision.allowed,true);assert.equal(decimal.record.state,'EVIDENCED');
 record=decimal.record;
 checks.push({id:'independent-decimal-and-negated-unknown-host-scope-and-all-source-pins',applicationId,stale,foreign,unchanged,decimal,approvalRefusals});
 for(let i=1;i<60;i++)ok(await command('create',null,{...input,memo:'Aggregate record '+i}));
 const page=ok(await api('analyst','read',{applicationId,limit:100}));
 assert.equal(page.records.length,60);assert(page.records.every((r:any)=>r.currentness==='STALE'));
 const replacement=structuredClone(spec);replacement.version='2';
 const maintenance=ok(await api('analyst','maintain',{applicationId,expectedReleaseId:installed.headReleaseId,specification:replacement,idempotencyKey:randomUUID(),changeClass:'DEPENDENCY_SCHEMA_DEPLOYMENT',migration:[]}),202);
 const maintained=await finish(applicationId);assert.equal(maintained.counters.builds,2);
 const rollback=ok(await api('analyst','rollback',{applicationId,expectedReleaseId:maintained.headReleaseId,releaseId:installed.headReleaseId,idempotencyKey:randomUUID()}));
 assert.equal(rollback.status,'ROLLED_BACK_DEVELOPMENT');
 const retained=ok(await api('analyst','read',{applicationId,limit:100}));assert.equal(retained.records.length,60);
 assert.deepEqual(retained.records.map((r:any)=>r.values),page.records.map((r:any)=>r.values));
 checks.push({id:'sixty-records-with-128-exact-entries-maintain-and-roll-back',applicationId,recordCount:60,entriesPerRecord:128,sourceOwnerBatch:'ONE_PAGE_UNION_IN_THE_SAME_FENCED_TRANSACTION',maintenance,
  rollback,counters:retained.counters,originalDeadlineRetained:retained.counters.deadlineAt===installed.counters.deadlineAt,fullValuesRetained:true});
 const foreignSpec=structuredClone(spec);foreignSpec.version='3';
 foreignSpec.model.entities[0]!.fields.push({id:'migrationQuantity',title:'Migration must retain authorized root',type:'quantity',required:false,allowUnknown:false});
 const foreignMaintenance=ok(await api('analyst','maintain',{applicationId,expectedReleaseId:retained.headReleaseId,specification:foreignSpec,idempotencyKey:randomUUID(),changeClass:'DEPENDENCY_SCHEMA_DEPLOYMENT',
  migration:[{kind:'ADD_FIELD',entityId:'control_exception',field:'migrationQuantity',value:quantity('1','USD',randomUUID())}]}),202);
 let refused:any;
 for(let i=0;i<8;i++){await runWorker();refused=ok(await api('analyst','read',{applicationId,limit:100}));if(refused.status==='FAILED')break;}
 assert.equal(refused.status,'FAILED');assert.equal(refused.headReleaseId,retained.headReleaseId);
 assert.equal(refused.builds.find((b:any)=>b.id===foreignMaintenance.buildId).failure.code,'QUANTITY_ENTITY_SCOPE_MISMATCH');
 assert.deepEqual(refused.records.map((r:any)=>r.values),retained.records.map((r:any)=>r.values));
 assert(refused.records.every((r:any)=>r.values.migrationQuantity===undefined));
 checks.push({id:'foreign-root-migration-default-refuses-atomically',applicationId,foreignMaintenance,headReleaseRetained:true,fullValuesRetained:true,builds:refused.builds,counters:refused.counters});

 // Completed temporary uploads cannot exhaust an immutable lifetime quota.
 const transportSpec=exceptionRegister(tenant,root.entityId),text=JSON.stringify(transportSpec),digest=hash(text),transport:any[]=[];
 assert(Buffer.byteLength(text)<49152);
 for(let i=0;i<9;i++){
  const uploadId=randomUUID();ok(await api('analyst','upload',{root,uploadId,part:0,totalParts:1,digest,bytes:text}));
  const body={...request,specification:undefined,specificationUploadId:uploadId,idempotencyKey:randomUUID()};
  const submitted=ok(await api('analyst','submit',JSON.parse(JSON.stringify(body))),202);
  // An unchanged UI retry may re-send its same bounded temporary transport.
  ok(await api('analyst','upload',{root,uploadId,part:0,totalParts:1,digest,bytes:text}));
  const replay=ok(await api('analyst','submit',JSON.parse(JSON.stringify(body))),202);assert.equal(replay.applicationId,submitted.applicationId);assert.equal(replay.replayed,true);
  const fragments=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2 AND upload_id=$3',[tenant,people.analyst,uploadId])).rows[0].n;
  assert.equal(fragments,0);
  const copied=(await e.admin.query('SELECT specification FROM finnor_os.x3_builds WHERE tenant_id=$1 AND application_id=$2',[tenant,submitted.applicationId])).rows[0].specification;
  assert.deepEqual(copied,transportSpec);
  const cancelled=ok(await api('analyst','cancel',{applicationId:submitted.applicationId,expectedReleaseId:null,idempotencyKey:randomUUID()}));
  // This physical driver intentionally claims one job. Drain this exact
  // cancelled delivery before later fault episodes observe a different job.
  let delivery:any,drains=0;
  do{
   assert(drains++<16,'CANCELLED_TRANSPORT_DELIVERY_DID_NOT_DRAIN');await runWorker();
   delivery=(await e.admin.query('SELECT status FROM finnor_os.jobs WHERE id=$1',[submitted.jobId])).rows[0];
  }while(delivery.status!=='completed');
  transport.push({applicationId:submitted.applicationId,replayed:replay.replayed,fragments,copiedDigest:hash(JSON.stringify(copied)),cancelled,delivery,drains});
  await artifact(evidence,'upload-transport-progress.json',{transport,completedUploads:transport.length});
 }
 // Explicit aged-transport fixture, not simulated elapsed business time or an
 // alteration of any accepted application allocation.
 const expired=Array.from({length:8},()=>randomUUID());
 for(const id of expired)await e.admin.query("INSERT INTO finnor_os.x3_spec_fragments(tenant_id,principal_id,upload_id,part,total_parts,digest,bytes,created_at) VALUES($1,$2,$3,0,1,$4,$5,clock_timestamp()-interval '2 hours')",[tenant,people.partner,id,digest,text]);
 const freshId=randomUUID();ok(await api('partner','upload',{root,uploadId:freshId,part:0,totalParts:1,digest,bytes:text}));
 const expiredRemaining=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_spec_fragments WHERE tenant_id=$1 AND principal_id=$2 AND upload_id=ANY($3::uuid[])',[tenant,people.partner,expired])).rows[0].n;
 assert.equal(expiredRemaining,0);
 checks.push({id:'temporary-upload-consumption-idempotency-and-expiry',completedUploads:9,transport,expiredFixtureCount:8,expiredRemaining,applicationAllocationRefunded:false});
 const inventoryFile=join(evidence,'tenant-data-inventory.json');
 const inventory=spawnSync(process.execPath,['--import=tsx','scripts/tenant-data-inventory.ts','--tenant-id',tenant,'--output-file',inventoryFile],
  {cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.adminUrl},encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
 assert.equal(inventory.status,0,inventory.stderr);
 const tables=JSON.parse(await readFile(inventoryFile,'utf8')).directTenantTables.filter((t:any)=>t.table.startsWith('x3_'));
 assert.equal(tables.length,6);
 const rls=await withTenantClientTransaction(tenant,{userId:people.analyst,readOnly:true},async(c:any)=>{
  const rows=[];
  for(const table of ['x3_applications','x3_builds','x3_releases','x3_records','x3_events','x3_spec_fragments']){
   const counts=(await c.query(`SELECT count(*)::integer n,count(*) FILTER(WHERE tenant_id<>$1)::integer foreign_count FROM finnor_os.${table}`,[tenant])).rows[0];
   const policy=(await c.query("SELECT current_user,rolsuper,rolbypassrls,relrowsecurity,relforcerowsecurity FROM pg_roles CROSS JOIN pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace WHERE rolname=current_user AND nspname='finnor_os' AND relname=$1",[table])).rows[0];
   assert.equal(counts.foreign_count,0);assert.equal(policy.current_user,'finnor_app');assert(!policy.rolsuper&&!policy.rolbypassrls&&policy.relrowsecurity&&policy.relforcerowsecurity);
   rows.push({table,counts,policy});
  }
  return rows;
 });
 checks.push({id:'canonical-tenant-metadata-inventory-and-six-forced-rls-tables',metadataInventoryRole:'DISPOSABLE_SETUP_ADMIN_METADATA_ONLY',tables,ordinaryRuntimeReadback:rls});

 const key=randomUUID(),lockedRequest={applicationId,entityId:'control_exception',actionId:'create',input,idempotencyKey:key};
 await e.admin.query('BEGIN');
 try{
  await e.admin.query('SELECT id FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,applicationId]);
  const begin=Date.now(),refusal=await api('analyst','command',lockedRequest),elapsedMs=Date.now()-begin;
  assert(refusal.status>=400,JSON.stringify(refusal));assert(elapsedMs>=15000&&elapsedMs<25000,'CUMULATIVE_DATABASE_DEADLINE:'+elapsedMs);
  checks.push({id:'cumulative-monotonic-database-deadline',refusal,elapsedMs,heldLock:'TASK_OWNED_DISPOSABLE_APPLICATION_ONLY'});
 }finally{await e.admin.query('ROLLBACK');}
 const events=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND idempotency_key=$3',[tenant,applicationId,'command:'+key])).rows[0].n;
 assert.equal(events,0);
 await artifact(evidence,'installed-review-boundaries.json',{checks,allPassed:true,immutableAcceptanceUnchanged:true});
 return checks;
}
