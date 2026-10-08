/** Failure-first ordinary-role discovery versus the unchanged final authorizer. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canExerciseAuthority,employeeAuthoritySnapshot,evaluateAuthority} from '@finnor/authority';
import {withTenantClientTransaction,withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError} from '@finnor/db';
import type {AuthorityRequest,TenantContext} from '@finnor/shared-types';

interface Support {
 scope:any;admin:any;artifact:(name:string,value:unknown)=>Promise<unknown>;
}
export async function authorityCorrespondence(s:Support){
 const employeeId=randomUUID(),roleId=randomUUID(),assignmentId=randomUUID(),grantId=randomUUID(),
  capability='query:completion-b-owned-authority',ctx:TenantContext={tenantId:s.scope.tenant,
   userId:employeeId,employeeId,role:'owner'},observations:any[]=[];
 await s.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,display_name,role,status) VALUES($1,$2,$3,'Owned authority correspondence','owner','active')",
  [employeeId,ctx.tenantId,employeeId+'@example.invalid']);
 await s.admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Owned authority correspondence')",
  [roleId,ctx.tenantId,'completion-b-owned:'+roleId]);
 await s.admin.query("INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4,$5::jsonb)",
  [assignmentId,ctx.tenantId,employeeId,roleId,JSON.stringify({kind:'tenant'})]);
 await s.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND employee_id=$2 AND role_id<>$3',
  [ctx.tenantId,employeeId,roleId]);
 await s.admin.query("INSERT INTO finnor_os.role_authority_grants(id,tenant_id,role_id,capability,resource_type,effect,max_amount_usd,max_risk) VALUES($1,$2,$3,$4,'work','allow',100,'medium')",
  [grantId,ctx.tenantId,roleId,capability]);
 const request:AuthorityRequest={operation:'query',capability,resources:[{type:'work',id:s.scope.workId}],risk:'low',amountUsd:50},
  count=async()=>Number((await s.admin.query('SELECT count(*) n FROM finnor_os.authority_decisions WHERE tenant_id=$1',
   [ctx.tenantId])).rows[0].n),
  observe=async(name:string,expected:boolean,input:AuthorityRequest=request)=>{
   const before=await count(),actual=await canExerciseAuthority(ctx,input);
   assert.equal(await count(),before,'Discovery appended a final authority decision');
   const final=await evaluateAuthority(ctx,input);
   assert.equal(actual,expected,name);assert.equal(actual,final.outcome==='allowed',name);
   observations.push({name,discovery:actual,finalOutcome:final.outcome,reason:final.reasonCode,
    revision:final.authorityRevision,discoveryAppendedNoDecision:true});
  };
 await observe('ACTUAL_CURRENT_ALLOW',true);
 const snapshot=await employeeAuthoritySnapshot(ctx);assert(snapshot.roles.includes('completion-b-owned:'+roleId));
 await observe('ACTUAL_CAPABILITY_ABSENT',false,{...request,capability:'query:completion-b-absent'});
 await observe('ACTUAL_AMOUNT_LIMIT',false,{...request,amountUsd:101});
 await observe('ACTUAL_RISK_LIMIT',false,{...request,risk:'high'});
 await s.admin.query("UPDATE finnor_os.role_authority_grants SET effect='deny' WHERE id=$1",[grantId]);
 await observe('ACTUAL_LIVE_DENY',false);
 await s.admin.query("UPDATE finnor_os.role_authority_grants SET effect='allow' WHERE id=$1",[grantId]);
 await s.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[employeeId]);
 await observe('ACTUAL_SUSPENDED_EMPLOYEE',false);await assert.rejects(()=>employeeAuthoritySnapshot(ctx));
 await s.admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[employeeId]);
 await s.admin.query("UPDATE finnor_os.employee_roles SET active=false WHERE id=$1",[roleId]);
 await observe('ACTUAL_INACTIVE_ROLE',false);
 await s.admin.query("UPDATE finnor_os.employee_roles SET active=true WHERE id=$1",[roleId]);
 await s.admin.query("UPDATE finnor_os.employee_role_assignments SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[assignmentId]);
 await observe('ACTUAL_EXPIRED_ASSIGNMENT',false);
 await s.admin.query('UPDATE finnor_os.employee_role_assignments SET expires_at=null,resource_scope=$2::jsonb WHERE id=$1',
  [assignmentId,JSON.stringify({kind:'resources',resourceType:'work',resourceIds:[s.scope.workId]})]);
 await observe('ACTUAL_EXACT_RESOURCE_SCOPE',true);
 await observe('ACTUAL_OUT_OF_RESOURCE_SCOPE',false,{...request,resources:[{type:'work',id:randomUUID()}]});
 await s.admin.query('UPDATE finnor_os.employee_role_assignments SET resource_scope=$2::jsonb WHERE id=$1',
  [assignmentId,JSON.stringify({kind:'assigned'})]);
 await observe('ACTUAL_UNASSIGNED_WORK',false);
 const prior=(await s.admin.query('SELECT assigned_to FROM finnor_os.works WHERE id=$1',[s.scope.workId])).rows[0];
 try{
  await s.admin.query('UPDATE finnor_os.works SET assigned_to=$2 WHERE id=$1',[s.scope.workId,employeeId]);
  await observe('ACTUAL_ASSIGNED_WORK',true);
 }finally{await s.admin.query('UPDATE finnor_os.works SET assigned_to=$2 WHERE id=$1',[s.scope.workId,prior.assigned_to]);}
 await s.admin.query('UPDATE finnor_os.employee_role_assignments SET resource_scope=$2::jsonb WHERE id=$1',
  [assignmentId,JSON.stringify({kind:'tenant'})]);
 await observe('ACTUAL_RESTORED_CURRENT_ALLOW',true);
 const foreign={...ctx,tenantId:randomUUID()};
 assert.equal(await canExerciseAuthority(foreign,request),false);
 await assert.rejects(()=>employeeAuthoritySnapshot(foreign));
 const scoped=await withTenantClientTransaction(ctx.tenantId,{},async client=>(await client.query(
  "SELECT pg_backend_pid() pid,current_setting('app.tenant_id') tenant,current_setting('transaction_isolation') isolation")).rows[0]);
 assert.equal(scoped.tenant,ctx.tenantId);assert.equal(scoped.isolation,'read committed');
 await assert.rejects(()=>withDatabaseExecutionDeadline(performance.now(),()=>employeeAuthoritySnapshot(ctx)),
  error=>error instanceof DatabaseExecutionDeadlineError);
 const report={observations,scoped,snapshot,foreignRefused:true,originalWorkAssignmentRestored:true,
  preExpiredSQLDeadlineFenceObserved:true,qualifiedSpeedup:false,usd:null};
 await s.artifact('authority/current-discovery-correspondence.json',report);return report;
}
