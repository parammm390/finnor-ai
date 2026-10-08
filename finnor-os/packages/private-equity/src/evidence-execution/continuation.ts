import {type PeMutationContext} from '../types';
import {parseRequest} from './contracts';
import {loadHandle} from './sources';
import {assertDependencies,authorize,newId,principal,revisions,sha,stable,tx} from './store';

/** Additive owner adapter: a continuation reads an accepted input; it never calls
 * receiveWork, changes instruction text or rebases an old result. */
export async function submitEvidenceContinuation(ctx:PeMutationContext,body:unknown,binding:{workId:string;inputId:string;inputDigest:string}){
 const request=parseRequest(body);if(request.workId!==binding.workId)throw Error('CONTINUATION_WORK_SCOPE_MISMATCH');
 if(request.mode!=='ordinary_disposable'||process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('PROTECTED_FUNDING_ADMISSION_AND_RUNTIME_BINDINGS_UNAVAILABLE');
 await authorize(ctx,request.root,[{type:'work',id:binding.workId}]);const handles=[];
 for(const input of request.inputs){const handle=await loadHandle(ctx,input.handleId,request.root);if(handle.inputId!==input.inputId)throw Error('HANDLE_INPUT_ID_MISMATCH');handles.push(handle);}
 const dependencies=[...handles.flatMap(h=>h.dependencies),...await revisions(ctx,['work-inputs:'+binding.workId,'rights:tenant'])];const digest=sha({request,binding});
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4404))',[ctx.auth.tenantId+':'+principal(ctx)+':'+request.idempotencyKey]);
  await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,binding.workId]);
  await assertDependencies(ctx,dependencies,c,true);
  const input=(await c.query<{id:string;body:unknown}>('SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.auth.tenantId,binding.workId])).rows[0];
  if(input?.id!==binding.inputId||sha(input.body)!==binding.inputDigest)throw Error('EXACT_WORK_REVISION_CHANGED');
  const prior=(await c.query('SELECT id,request_digest,work_id,work_input_id,status FROM finnor_os.p4_queries WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==digest||prior.work_input_id!==binding.inputId)throw Error('IDEMPOTENCY_REQUEST_CONFLICT');return {queryId:String(prior.id),workId:String(prior.work_id),workRevision:String(prior.work_input_id),status:String(prior.status),replayed:true};}
  const id=newId();await c.query('INSERT INTO finnor_os.p4_queries(id,tenant_id,principal_id,root,work_id,work_input_id,work_input_digest,idempotency_key,request_digest,request) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb)',[id,ctx.auth.tenantId,principal(ctx),stable(request.root),binding.workId,binding.inputId,binding.inputDigest,request.idempotencyKey,digest,stable(request)]);
  await c.query('INSERT INTO finnor_os.p4_plans(tenant_id,principal_id,query_id,generation,body,digest) VALUES($1,$2,$3,1,$4::jsonb,$5)',[ctx.auth.tenantId,principal(ctx),id,stable(request),sha(request)]);
  await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_evidence_derivation_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent') ON CONFLICT(idempotency_key) DO NOTHING",[ctx.auth.tenantId,stable({tenantId:ctx.auth.tenantId,principalId:principal(ctx),queryId:id,generation:1}),'p4:'+id+':1']);
  return {queryId:id,workId:binding.workId,workRevision:binding.inputId,status:'QUEUED',replayed:false};
 });
}
