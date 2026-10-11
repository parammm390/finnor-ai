import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PeMutationContext} from '../types';
import {SolverRequestSchema,type SolverRequest} from '../../../shared-types/src/solver-capsule';
import {listEnterpriseControlPolicies} from '../enterprise-control';
import {loadEnterpriseBeliefView} from '../enterprise-beliefs';
import {readAllocationSnapshot} from '../allocation-store';
import {resolveDecisionWork,principal} from '../decision-slice/adapters';
import {assertDependencies,unavailable} from '../evidence-execution/store';
import {hash} from '../../../epistemic-runtime/src/solver-synthesis/contracts';
import {resolveSolverOwners,assertSolverOwnersCurrent} from './owners';
import {tx,solverRow,currentSolverRow,readCapsule,record,enqueueSolver,type SolverRow} from './store';
import {diagnosticSolverSelection} from './selection';
import {solverRef} from './capsule';
const instant=(value:unknown)=>new Date(value instanceof Date?value:String(value)).toISOString();
export const SolverOperationSchemas={
 'solver-request':SolverRequestSchema,'solver-read':z.object({requestId:z.string().uuid()}).strict(),
 'solver-cancel':z.object({requestId:z.string().uuid()}).strict(),'solver-selection':z.object({requestId:z.string().uuid()}).strict(),
 'solver-native-comparison':z.object({requestId:z.string().uuid()}).strict(),
 'solver-context':z.object({workId:z.string().uuid(),root:z.object({entityType:z.string().min(1),entityId:z.string().uuid()}).strict()}).strict(),
};
export const R8_OPERATIONS=new Set(Object.keys(SolverOperationSchemas));
const key=z.object({requestId:z.string().uuid()}).strict();
export async function originalGrant(ctx:PeMutationContext,row:SolverRow,c?:import('pg').PoolClient){
 const read=async(client:import('pg').PoolClient)=>{const grant=(await client.query<{id:string;deadline_at:string;max_rounds:number;rounds_used:number;attempts_used:number}>(
  'SELECT id,deadline_at,max_rounds,rounds_used,attempts_used FROM finnor_os.r8_grants WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
  [row.tenant_id,row.principal_id,row.grant_id])).rows[0];if(!grant)throw unavailable();return {...grant,deadline_at:instant(grant.deadline_at)};};
 return c?read(c):tx(ctx,read,true);
}
async function create(ctx:PeMutationContext,request:SolverRequest){
 if(Buffer.byteLength(JSON.stringify(request))>65536)throw Error('R8_REQUEST_BOUND');
 const binding=await resolveSolverOwners(ctx,request),requestDigest=hash(request),owner=principal(ctx),id=randomUUID();
 const row=await tx(ctx,async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['r8:'+ctx.auth.tenantId+':'+owner+':'+request.workId]);
  const prior=(await c.query<SolverRow>('SELECT * FROM finnor_os.r8_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,owner,request.idempotencyKey])).rows[0];
  if(prior){const digest=(await c.query<{request_digest:string}>('SELECT request_digest FROM finnor_os.r8_requests WHERE id=$1',[prior.id])).rows[0]!.request_digest;
   if(digest!==requestDigest)throw Error('R8_IDEMPOTENCY_PAYLOAD_CHANGED');return prior;}
  if(request.parentRequestId){const parent=await solverRow(ctx,request.parentRequestId,c);
   if(parent.work_id!==request.workId)throw unavailable();}
  let grant=(await c.query<{id:string;deadline_at:Date;max_rounds:number;rounds_used:number;attempts_used:number}>(
   'SELECT * FROM finnor_os.r8_grants WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE',[ctx.auth.tenantId,owner,request.workId])).rows[0];
  if(!grant){grant={id:randomUUID(),deadline_at:new Date(Date.now()+request.limits.deadlineMs),max_rounds:request.limits.maxRounds,rounds_used:0,attempts_used:0};
   await c.query('INSERT INTO finnor_os.r8_grants(id,tenant_id,principal_id,work_id,deadline_at,max_rounds) VALUES($1,$2,$3,$4,$5,$6)',
    [grant.id,ctx.auth.tenantId,owner,request.workId,grant.deadline_at,grant.max_rounds]);}
  if(grant.deadline_at.getTime()<=Date.now()||grant.rounds_used>=grant.max_rounds)throw Error('R8_ORIGINAL_WORK_EPISODE_EXHAUSTED');
  await assertDependencies(ctx,binding.dependencies,c,true);
  const status=binding.projection?'QUEUED':'UNSUPPORTED';
  const inserted=(await c.query<SolverRow>(`INSERT INTO finnor_os.r8_requests(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,grant_id,parent_request_id,
   idempotency_key,request_digest,request,binding,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13) RETURNING *`,
   [id,ctx.auth.tenantId,owner,request.workId,binding.work.inputId,binding.work.inputDigest,grant.id,request.parentRequestId??null,
    request.idempotencyKey,requestDigest,JSON.stringify(request),JSON.stringify(binding),status])).rows[0]!;
  for(const d of binding.dependencies)await c.query('INSERT INTO finnor_os.r8_dependencies(tenant_id,principal_id,request_id,key,revision) VALUES($1,$2,$3,$4,$5)',
   [ctx.auth.tenantId,owner,id,d.key,d.revision]);
  if(binding.projection)await enqueueSolver(ctx,inserted,'SYNTHESIZE',c);
  return inserted;
 });
 return {status:row.status,requestId:row.id,generation:row.generation,workId:row.work_id,workInputDigest:row.work_input_digest,
  originalGrant:await originalGrant(ctx,row),unsupportedReasons:binding.unsupportedReasons,
  semanticGate:'NOT_YET_ACCEPTED',domainGate:'UNQUALIFIED',admissionGate:'UNQUALIFIED',activationGate:'NOT_ACTIVATED',
  protectedExecution:false,executionAuthorityGranted:false};
}
async function read(ctx:PeMutationContext,id:string){
 const row=await currentSolverRow(ctx,id),grant=await originalGrant(ctx,row),capsule=await readCapsule(ctx,row);
 const records=await tx(ctx,async c=>(await c.query<{category:string;record_key:string;digest:string;created_at:Date}>(
  'SELECT category,record_key,digest,created_at FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at DESC,category,record_key LIMIT 257',
  [row.tenant_id,row.principal_id,id])).rows,true);
 const progress=await tx(ctx,async c=>{
  const candidate=(await c.query<{body:{program:unknown}}>("SELECT body FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='CANDIDATE' ORDER BY (body->>'round')::integer DESC LIMIT 1",
   [row.tenant_id,row.principal_id,id])).rows[0];
  const chunks=candidate?(await c.query<{checked:string}>("SELECT coalesce(sum((body->>'count')::integer),0)::text checked FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='CHUNK' AND body->>'programDigest'=$4",
   [row.tenant_id,row.principal_id,id,hash(candidate.body.program)])).rows[0]!.checked:'0';
  const trials=(await c.query<{trials:string;counterexamples:string}>("SELECT count(*)::text trials,coalesce(sum(jsonb_array_length(body->'counterexamples')),0)::text counterexamples FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='TRIAL'",
   [row.tenant_id,row.principal_id,id])).rows[0]!;
  const invocation=(await c.query<{body:{compute:{actualRoute:string}}}>("SELECT body FROM finnor_os.r8_records WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND category='INVOCATION' ORDER BY created_at DESC LIMIT 1",
   [row.tenant_id,row.principal_id,id])).rows[0];
  return {checkedInputs:Number(chunks),trialCount:Number(trials.trials),counterexampleCount:Number(trials.counterexamples),
   historicalDiagnosticRoute:invocation?.body.compute.actualRoute??null,wholeDomainClaim:!!capsule};
 },true);
 return {schema:'finnor.r8.work-review.v1',requestId:id,status:row.status,generation:row.generation,workId:row.work_id,
  workInputDigest:row.work_input_digest,originalGrant:grant,capsuleRef:capsule?.ref??null,artifactAvailable:!!capsule,
  candidate:capsule?{programDigest:hash(capsule.program),moduleDigest:capsule.module.compiledDigest,profile:capsule.profile,
   receiptRef:solverRef('semantic-receipt',capsule.receipt),domainInputs:capsule.receipt.checkedInputs,subsetChecks:capsule.receipt.checkedPairs,
   trialCount:capsule.trials.length,counterexampleCount:capsule.counterexamples.length}:null,
  unsupportedReasons:row.binding.unsupportedReasons,failure:row.failure,progress,records:records.slice(0,256),recordsTruncated:records.length>256,
  semanticGate:capsule?'DEVELOPMENT_MODEL_RELATIVE_PASS':'NOT_ACCEPTED',domainGate:'UNQUALIFIED',
  admissionGate:'SEPARATE_S8_OWNER_READ_REQUIRED',activationGate:'SEPARATE_S8_OWNER_READ_REQUIRED',
  joinedCompatibility:'NOT_ASSEMBLED',comparisonGate:'NOT_QUALIFIED',economicGate:'UNKNOWN',
  fallBack:'ORIGINAL_CURRENT_S5_FULL_ROUTE_WITHIN_ORIGINAL_GRANT_UNADMITTED',protectedExecution:false,executionAuthorityGranted:false};
}
async function cancel(ctx:PeMutationContext,id:string){
 const before=await currentSolverRow(ctx,id);await resolveDecisionWork(ctx,before.work_id);
 return tx(ctx,async c=>{const row=await solverRow(ctx,id,c,true);await assertDependencies(ctx,row.binding.dependencies,c,true);
  await record(ctx,row,'CANCEL','generation:'+row.generation,{reason:'AUTHENTICATED_WORK_CANCELLATION',at:new Date().toISOString(),
   originalGrant:await originalGrant(ctx,row,c),physicalLiabilityRetained:true},c);
  await c.query("UPDATE finnor_os.r8_requests SET status='CANCELLED',generation=generation+1,failure='AUTHENTICATED_CANCELLED',updated_at=clock_timestamp() WHERE id=$1",[id]);
  return {requestId:id,status:'CANCELLED',generation:row.generation+1,originalBudgetRetained:true,physicalLiabilityRetained:true,executionAuthorityGranted:false};
 });
}
export async function handleSolverOperation(ctx:PeMutationContext,operation:string,body:unknown){
 try{
  if(operation==='solver-context'){
   const input=SolverOperationSchemas['solver-context'].parse(body),root=input.root as import('../types').PeWorldRootRef;
   const work=await resolveDecisionWork(ctx,input.workId);await loadEnterpriseBeliefView(ctx,{root});
   const policies=await listEnterpriseControlPolicies(ctx,root),resources=await readAllocationSnapshot(ctx);
   return {status:200,body:{workId:input.workId,workInputDigest:work.inputDigest,root,policies,resources,
    executionAuthorityGranted:false,qualification:'CURRENT_OWNER_MODELS_NOT_EXACT_FITTED_COEFFICIENTS_OR_WEALTH'}};
  }
  if(operation==='solver-request')return {status:202,body:await create(ctx,SolverRequestSchema.parse(body))};
  const {requestId}=key.parse(body);
  if(operation==='solver-read')return {status:200,body:await read(ctx,requestId)};
  if(operation==='solver-cancel')return {status:200,body:await cancel(ctx,requestId)};
  if(operation==='solver-selection'||operation==='solver-native-comparison')return {status:200,body:await diagnosticSolverSelection(ctx,requestId,operation==='solver-native-comparison')};
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  const code=error instanceof Error?error.message:'R8_UNAVAILABLE';
  const unavailableScope=error instanceof Error&&('code'in error&&error.code==='PE_ENTITY_NOT_FOUND'||/RIGHTS|WORK_SOURCE|DEPENDENCY|OWNER_MODULE/.test(code));
  return {status:unavailableScope?404:409,body:{code:unavailableScope?'R8_SCOPE_UNAVAILABLE':code,
   current:false,capsuleRef:null,candidate:null,executionAuthorityGranted:false}};
 }
}
