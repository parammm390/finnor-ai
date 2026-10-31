import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {withDatabaseExecutionDeadline,DatabaseExecutionDeadlineError} from '@finnor/db';
import {PeDomainError,LedgerFault} from '@finnor/private-equity';
import {AllocationContractError,ControlContractError,ExperimentContractError} from '@finnor/epistemic-runtime';
import {errorResponse,requireContext} from '../../../../lib/auth';
import {UniformOwnerError,fail} from '../../../../../../packages/private-equity/src/uniform-algorithms/contracts';
import {submitUniformDiscovery,readUniformDiscovery,listUniformDiscoveries,consumeUniformAlgorithm,cancelUniformDiscovery,invalidateUniformDiscovery} from '../../../../../../packages/private-equity/src/uniform-algorithms/service';
import {assignUniformEvaluation,evaluateUniformAlgorithm,proposeUniformAdmission,readUniformAdmission} from '../../../../../../packages/private-equity/src/uniform-algorithms/admission';
import {resolveTotalSpecification} from '../../../../../../packages/private-equity/src/uniform-algorithms/specification';
import {submitTotalDiscovery,consumeTotalAlgorithm} from '../../../../../../packages/private-equity/src/uniform-algorithms/total-service';
import {recordTotalTaskEpisode} from '../../../../../../packages/private-equity/src/allocation-total-episodes';
import {prewarmToolIdentity} from '../../../../../../packages/epistemic-runtime/src/uniform-algorithms/native';
export const runtime='nodejs';
// The first full verification of the pinned toolchain hashes gigabytes. Starting it when the route loads keeps it out
// of the first checked use's 28.5 s deadline.
if(process.env.NEXT_PHASE!=='phase-production-build')prewarmToolIdentity();
let activeRequests=0;
const response=(body:unknown,status=200)=>{
 const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>16777216)fail('Y5_RESPONSE_BOUND',413);
 return new Response(encoded,{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
};
async function boundedJson(req:Request,deadlineAt:number){
 const limit=2097152;
 if(Number(req.headers.get('content-length')??0)>limit){await req.body?.cancel().catch(()=>undefined);fail('Y5_REQUEST_BOUND',413);}
 if(!req.body)fail('Y5_JSON_REQUIRED',400);
 const reader=req.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){
  if(req.signal.aborted)fail('Y5_REQUEST_ABORTED',400);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const next=await Promise.race([reader.read(),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new UniformOwnerError('Y5_REQUEST_BODY_DEADLINE',408)),Math.max(1,deadlineAt-Date.now()));})]).finally(()=>clearTimeout(timer));
  if(next.done)break;size+=next.value.length;if(size>limit)fail('Y5_REQUEST_BOUND',413);chunks.push(next.value);
 }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('Y5_JSON_REQUIRED',400);}
 }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
export async function POST(req:Request,{params}:{params:Promise<{operation:string}>}){
 if(activeRequests>=8)return response({code:'Y5_API_PROCESS_CAPACITY_UNAVAILABLE'},503);
 activeRequests++;const startedAt=Date.now(),deadlineAt=startedAt+28500;
 try{
  return await withDatabaseExecutionDeadline(performance.now()+28500,async()=>{
  const [auth,route]=await Promise.all([requireContext(req),params]),body=await boundedJson(req,Math.min(startedAt+5000,deadlineAt)),ctx={auth};
  if(Date.now()>=deadlineAt)fail('Y5_ORIGINAL_REQUEST_DEADLINE',408);
  switch(route.operation){
   case 'specification':return response(await resolveTotalSpecification(ctx,body));
   case 'record-task-episode':return response(await recordTotalTaskEpisode(ctx,body,deadlineAt));
   case 'submit':return response(await submitUniformDiscovery(ctx,body),202);
   case 'submit-total':return response(await submitTotalDiscovery(ctx,body,deadlineAt),202);
   case 'read':return response(await readUniformDiscovery(ctx,body));
   case 'list':return response(await listUniformDiscoveries(ctx,body));
   case 'consume':return response(await consumeUniformAlgorithm(ctx,body,deadlineAt));
   case 'consume-total':return response(await consumeTotalAlgorithm(ctx,body,deadlineAt));
   case 'cancel':return response(await cancelUniformDiscovery(ctx,body));
   case 'invalidate':return response(await invalidateUniformDiscovery(ctx,body));
   case 'assign-evaluation':return response(await assignUniformEvaluation(ctx,body));
   case 'evaluate':return response(await evaluateUniformAlgorithm(ctx,body,deadlineAt));
   case 's8-propose':return response(await proposeUniformAdmission(ctx,body));
   case 'admission':return response(await readUniformAdmission(ctx,body));
   default:return response({code:'Y5_OPERATION_NOT_FOUND'},404);
  }});
 }catch(error){
  if(error instanceof z.ZodError)return response({code:'Y5_INVALID_REQUEST'},400);
  if(error instanceof UniformOwnerError)return response({code:error.code},error.status);
  if(error instanceof LedgerFault)return response({code:error.code},error.status);
  if(error instanceof DatabaseExecutionDeadlineError)return response({code:'Y5_ORIGINAL_REQUEST_DEADLINE'},408);
  if(error instanceof PeDomainError)return response({code:error.code},/NOT_FOUND/.test(error.code)?404:422);
  if(error instanceof AllocationContractError||error instanceof ControlContractError||error instanceof ExperimentContractError)
   return response({code:error.code},error.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:error.code==='LIMIT_EXCEEDED'?413:400);
  return errorResponse(error);
 }finally{activeRequests--;}
}
