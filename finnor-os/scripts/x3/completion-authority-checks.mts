/** Installed HTTP/SQL timing cases preregistered in completion-review-plan.md.
 * Gates delay disposable transactions only; they never fabricate owner facts. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {configureTenantVertical} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {exceptionRegister} from './business-fixtures.mts';
import {artifact} from './environment.mts';

export async function completionAuthorityChecks(f:any){
 const {e,evidence,runWorker}=f,checks:any[]=[];
 const ok=(response:any,status=200)=>{assert.equal(response.status,status,JSON.stringify(response));return response.body;};
 // Authority revisions intentionally invalidate admission across this tenant.
 // Use an independently owned fixture rather than changing the S8 specimen's
 // rights between its original build and its admission.
 const tenant=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()},people={analyst:randomUUID(),partner:randomUUID()},tokens:Record<string,string>={};
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X3 temporal authority fixture')",[tenant,randomUUID()]);
 for(const [name,employee] of Object.entries(people)){
  const email=employee+'@x3.example.test';
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[employee,tenant,email]);
  e.http.register(employee,email);tokens[name]=await e.http.login(employee);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'X3 temporal fixture','other')",[root.entityId,tenant,randomUUID()]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:people.analyst,sourceSystem:'X3:disposable-temporal-authority'});
 for(const [name,employee] of Object.entries(people)){
  const role=(await e.admin.query('INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$2) RETURNING id',[tenant,'x3_'+name])).rows[0];
  await e.admin.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)',[tenant,employee,role.id,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]})]);
 }
 const api=(who:string,operation:string,input:unknown)=>e.http.api(tokens[who],'company-brain','application-'+operation,input);
 const finish=async(applicationId:string)=>{
  for(let i=0;i<16;i++){
   const state=ok(await api('analyst','read',{applicationId}));
   if(state.status==='INSTALLED')return state;
   assert(!['FAILED','CANCELLED'].includes(state.status),JSON.stringify(state.builds));await runWorker();
  }
  throw Error('TEMPORAL_APPLICATION_DID_NOT_INSTALL');
 };
 const waitFor=async(query:string,values:unknown[]=[])=>{
  const until=Date.now()+12000;
  for(;;){const row=(await e.admin.query(query,values)).rows[0];if(row)return row;assert(Date.now()<until,'ACTUAL_DISPOSABLE_TIMING_GATE_NOT_OBSERVED');await new Promise(yes=>setTimeout(yes,10));}
 };
 const spec=exceptionRegister(tenant,root.entityId);spec.id='completion-temporal-authority';spec.title='Temporal owner authority checks';
 for(const [id,key] of [['transient_operator','x3_transient_operator'],['transient_reviewer','x3_transient_reviewer']]){
  spec.model.roles.push({...spec.model.roles[0]!,id:id!,canonicalRole:key!});
 }
 const create=spec.actions.find(a=>a.id==='create')!,close=spec.actions.find(a=>a.id==='close')!;
 spec.actions.push({...structuredClone(create),id:'transient-create',roles:['transient_operator']});
 spec.actions.push({...structuredClone(close),id:'transient-approve',roles:['transient_reviewer'],toState:'EVIDENCED',
  approval:{...close.approval!,requirements:[{role:'transient_reviewer',when:{op:'literal',value:true}}]}});
 const final=structuredClone(close);delete final.approval;
 spec.actions.push({...final,id:'transient-close',roles:['operator'],requiresApprovalsFrom:'transient-approve'});
 const accepted=ok(await api('analyst','submit',{schema:'finnor.x3.application-request.v1',root,specification:spec,idempotencyKey:randomUUID(),
  limits:{deadlineMs:3600000,maxBuilds:8,maxMutations:1000}}),202);
 const installed=await finish(accepted.applicationId),applicationId=accepted.applicationId;
 const source=await createEvidenceSource(tenant,{sourceKey:'x3-completion-temporal-support',sourceType:'manual',title:'Declared temporal authority evidence'});
 await appendEvidenceVersion(tenant,source.id,{content:'Independent disposable timing specimen',snapshot:{qualification:'DEVELOPMENT_TIMING_MECHANICS_ONLY'},asOf:new Date()});
 const sourceId=source.id;
 const current=(await e.admin.query('SELECT id,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1',[tenant,sourceId])).rows[0];
 const input={memo:'completion-temporal-authority',remediation:'Declared independent temporal-role check',
  support:{kind:'EVIDENCE',sourceId,versionId:current.id,contentDigest:current.content_hash}};
 const command=(who:string,actionId:string,record:any=null,values:unknown={},key=randomUUID())=>api(who,'command',{applicationId,entityId:'control_exception',actionId,input:values,idempotencyKey:key,
  ...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{})});
 const gate='x3-completion-authority:'+randomUUID();
 await e.admin.query(`CREATE FUNCTION finnor_os.x3_completion_authority_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.application_id='${applicationId}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0],0));END IF;RETURN NEW;END $$`);
 await e.admin.query(`CREATE TRIGGER x3_completion_authority_gate BEFORE INSERT OR UPDATE ON finnor_os.x3_records
  FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_completion_authority_gate('${gate}')`);
 async function assignment(key:string,employee:string,seconds:number){
  const role=(await e.admin.query('INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,$2,$2) RETURNING id',[tenant,key])).rows[0];
  return (await e.admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,expires_at)
   VALUES($1,$2,$3,$4::jsonb,clock_timestamp()+$5*interval '1 second') RETURNING id,expires_at`,
   [tenant,employee,role.id,JSON.stringify({kind:'resources',resourceType:root.entityType,resourceIds:[root.entityId]}),seconds])).rows[0];
 }
 async function expireDuringWrite(lease:any,call:()=>Promise<any>,key:string){
  await e.admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate]);
  const pending=call().then(result=>({result}),error=>({error:String(error)}));
  let blocked:any,atExpiry:any;
  try{
   blocked=await waitFor(`SELECT pid,wait_event_type,wait_event,clock_timestamp() AS observed_at FROM pg_stat_activity
    WHERE usename='finnor_app' AND state='active' AND wait_event_type='Lock' AND query LIKE '%finnor_os.x3_records%'
    AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) LIMIT 1`);
   assert(new Date(blocked.observed_at).getTime()<new Date(lease.expires_at).getTime(),'ROLE_EXPIRED_BEFORE_COMMIT_GATE');
   await e.admin.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)",[lease.expires_at]);
   atExpiry=(await e.admin.query('SELECT clock_timestamp() AS observed_at')).rows[0];
  }finally{await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate]);}
  const observed=await pending;assert('result' in observed,JSON.stringify(observed));
  assert.equal(observed.result.status,409,JSON.stringify(observed));assert.equal(observed.result.body.code,'APPLICATION_AUTHORITY_EXPIRED');
  const events=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND idempotency_key=$3',[tenant,applicationId,'command:'+key])).rows[0].n;
  assert.equal(events,0);
  return {lease:{id:lease.id,expiresAt:lease.expires_at},blocked,atExpiry,response:observed.result,committedEvents:events};
 }
 try{
  const actorLease=await assignment('x3_transient_operator',people.analyst,5),actorKey=randomUUID();
  const before=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2',[tenant,applicationId])).rows[0].n;
  const actor=await expireDuringWrite(actorLease,()=>command('analyst','transient-create',null,input,actorKey),actorKey);
  assert.equal((await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2',[tenant,applicationId])).rows[0].n,before);
  checks.push({id:'actor-original-assignment-expires-after-decision-before-persistence',applicationId,actor,recordCountRetained:true,grantRenewed:false});
  let record=ok(await command('analyst','create',null,input)).record;
  record=ok(await command('analyst','document',record)).record;
  const approverLease=await assignment('x3_transient_reviewer',people.partner,10);
  record=ok(await command('partner','transient-approve',record)).record;
  assert.equal(record.approvals.length,1);
  const approverKey=randomUUID(),approver=await expireDuringWrite(approverLease,()=>command('analyst','transient-close',record,{},approverKey),approverKey);
  const retained=ok(await api('analyst','record',{applicationId,recordId:record.id}));assert.deepEqual(retained,record);
  checks.push({id:'approver-original-assignment-expires-after-decision-before-persistence',applicationId,approver,retained,grantRenewed:false,originalDeadline:installed.counters.deadlineAt});
 }finally{
  await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate]);
  await e.admin.query('DROP TRIGGER x3_completion_authority_gate ON finnor_os.x3_records');
  await e.admin.query('DROP FUNCTION finnor_os.x3_completion_authority_gate()');
 }

 // A separate disposable tenant keeps this committed denial in place without
 // restoring or extending an earlier authority grant for later cases.
 const isolated=randomUUID(),employee=randomUUID(),organization=randomUUID(),email=employee+'@x3.example.test';
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X3 intake authority fixture')",[isolated,randomUUID()]);
 await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[employee,isolated,email]);
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'X3 isolated intake','other')",[organization,isolated,randomUUID()]);
 await configureTenantVertical({tenantId:isolated,verticalKey:'private_equity',expectedVersion:0,createdBy:employee,sourceSystem:'X3:disposable-completion-authority'});
 e.http.register(employee,email);const token=await e.http.login(employee);
 const role=(await e.admin.query("INSERT INTO finnor_os.employee_roles(tenant_id,key,name) VALUES($1,'x3_intake_deny','X3 intake denial') RETURNING id",[isolated])).rows[0];
 await e.admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk) VALUES($1,$2,'action:synthesize_enterprise_application','external_organization','deny','low')",[isolated,role.id]);
 const intakeGate='x3-completion-intake:'+randomUUID(),intakeKey=randomUUID();
 await e.admin.query(`CREATE FUNCTION finnor_os.x3_completion_intake_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.tenant_id='${isolated}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0],0));END IF;RETURN NEW;END $$`);
 await e.admin.query(`CREATE TRIGGER x3_completion_intake_gate AFTER INSERT ON finnor_os.work_inputs
  FOR EACH ROW EXECUTE FUNCTION finnor_os.x3_completion_intake_gate('${intakeGate}')`);
 const writer=new pg.Client({connectionString:e.adminUrl});await writer.connect();
 let revoke:Promise<unknown>|undefined,intake:Promise<any>|undefined;
 try{
  await e.admin.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[intakeGate]);
  const intakeRoot={entityType:'external_organization',entityId:organization};
  intake=e.http.api(token,'company-brain','application-submit',{schema:'finnor.x3.application-request.v1',root:intakeRoot,
   specification:exceptionRegister(isolated,organization),idempotencyKey:intakeKey,limits:{deadlineMs:60000,maxBuilds:2,maxMutations:10}}).then((result:any)=>({result}), (error:unknown)=>({error:String(error)}));
  const blocked=await waitFor(`SELECT pid,clock_timestamp() AS observed_at FROM pg_stat_activity WHERE usename='finnor_app'
   AND state='active' AND wait_event_type='Lock' AND query LIKE '%work_inputs%' AND pg_backend_pid()=ANY(pg_blocking_pids(pid)) LIMIT 1`);
  await writer.query('BEGIN');await writer.query("SELECT set_config('app.tenant_id',$1,true)",[isolated]);
  revoke=writer.query('INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)',
   [isolated,employee,role.id,JSON.stringify({kind:'resources',resourceType:intakeRoot.entityType,resourceIds:[organization]})]).then(()=>writer.query('COMMIT'));
  void revoke.catch(()=>undefined);
  const queued=await waitFor(`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock'
   AND query LIKE 'INSERT INTO finnor_os.employee_role_assignments%' AND $1::integer=ANY(pg_blocking_pids(pid)) LIMIT 1`,[blocked.pid]);
  await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[intakeGate]);
  await revoke;
  const observed=await intake;assert('result' in observed,JSON.stringify(observed));assert([403,404].includes(observed.result.status),JSON.stringify(observed));
  const acceptedRows=(await e.admin.query('SELECT count(*)::integer n FROM finnor_os.x3_applications WHERE tenant_id=$1 AND idempotency_key=$2',[isolated,intakeKey])).rows[0].n;
  assert.equal(acceptedRows,0);
  checks.push({id:'synthesis-authority-revoked-between-intake-and-acceptance',tenant:isolated,principal:employee,blocked,queued,response:observed.result,acceptedApplications:acceptedRows,denialRetained:true});
 }finally{
  await e.admin.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[intakeGate]);
  await revoke?.catch(()=>undefined);await writer.query('ROLLBACK').catch(()=>undefined);await writer.end();
  await intake?.catch(()=>undefined);
  await e.admin.query('DROP TRIGGER x3_completion_intake_gate ON finnor_os.work_inputs');
  await e.admin.query('DROP FUNCTION finnor_os.x3_completion_intake_gate()');
 }
 await artifact(evidence,'completion-authority-boundaries.json',{status:'PASS_INSTALLED_TEMPORAL_AND_INTAKE_AUTHORITY',checks});
 return checks;
}
