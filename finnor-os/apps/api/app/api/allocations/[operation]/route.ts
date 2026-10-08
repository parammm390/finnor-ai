import { z } from 'zod';
import { AllocationContractError, ControlContractError, ExperimentContractError, AllocationOperationSchemas, InterventionContractError } from '@finnor/epistemic-runtime';
import { PeDomainError, clearEnterprisePortfolio, consumeEnterpriseAllocation, listEnterpriseAllocationResources, readEnterpriseAllocation, reconcileEnterpriseAllocation, recordEnterpriseAllocationAssessment, registerEnterpriseAllocationResource, releaseEnterpriseAllocation, validateEnterpriseAllocation,settleEnterpriseAllocation } from '@finnor/private-equity';
import { errorResponse, requireContext } from '../../../../lib/auth';
import {LedgerFault} from '../../../../../../packages/governed-execution/src/protocol';

export const runtime='nodejs';
const {resource,clear:clearing,read:reference,consume:consumption,release,assessment}=AllocationOperationSchemas;
function response(value:unknown,status=200):Response {
  const body=JSON.stringify(value);if(Buffer.byteLength(body)>8*1024*1024)throw new AllocationContractError('LIMIT_EXCEEDED','S5 response exceeds 8 MiB');
  return new Response(body,{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});
}
async function boundedJson(req:Request):Promise<unknown> {
  const limit=2*1024*1024;if(Number(req.headers.get('content-length')??0)>limit){await req.body?.cancel().catch(()=>undefined);throw new AllocationContractError('LIMIT_EXCEEDED','S5 request exceeds 2 MiB');}
  if(!req.body)throw new AllocationContractError('INVALID_REQUEST','S5 requires JSON');
  const reader=req.body.getReader(),bytes=Buffer.alloc(limit);let size=0;
  try {while(true){const chunk=await reader.read();if(chunk.done)break;if(chunk.value.byteLength>limit-size){await reader.cancel().catch(()=>undefined);throw new AllocationContractError('LIMIT_EXCEEDED','S5 request exceeds 2 MiB');}bytes.set(chunk.value,size);size+=chunk.value.byteLength;}return JSON.parse(bytes.subarray(0,size).toString('utf8'));}
  catch(e){if(e instanceof AllocationContractError)throw e;throw new AllocationContractError('INVALID_REQUEST','S5 requires bounded JSON');}finally{reader.releaseLock();}
}
export async function POST(req:Request,{params}:{params:Promise<{operation:string}>}):Promise<Response> {
  try {const [auth,route]=await Promise.all([requireContext(req),params]),ctx={auth},body=await boundedJson(req);
    switch(route.operation){
      case 'resource':{const p=resource.parse(body);return response(await registerEnterpriseAllocationResource(ctx,{resource:p.resource,expectedRef:p.expectedRef}));}
      case 'resources':AllocationOperationSchemas.resources.parse(body);return response(await listEnterpriseAllocationResources(ctx));
      case 'clear':{const p=clearing.parse(body);return response(await clearEnterprisePortfolio(ctx,{...p,mandate:p.mandate,jointModel:p.jointModel}));}
      case 'read':return response(await readEnterpriseAllocation(ctx,reference.parse(body).allocationRef));
      case 'validate':return response(await validateEnterpriseAllocation(ctx,reference.parse(body).allocationRef));
      case 'consume':return response(await consumeEnterpriseAllocation(ctx,consumption.parse(body)));
      case 'release':return response(await releaseEnterpriseAllocation(ctx,release.parse(body)));
      case 'reconcile':return response(await reconcileEnterpriseAllocation(ctx,reference.parse(body)));
      case 'settle':return response(await settleEnterpriseAllocation(ctx,AllocationOperationSchemas.settle.parse(body)));
      case 'assessment':return response(await recordEnterpriseAllocationAssessment(ctx,assessment.parse(body)));
      default:return response({error:'S5 operation was not found',code:'NOT_FOUND'},404);
    }
  }catch(e){
    if(e instanceof z.ZodError)return response({error:'Invalid S5 request',code:'INVALID_REQUEST'},400);
    if(e instanceof LedgerFault)return response({code:e.code},e.status);
    if(e instanceof AllocationContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:['IDEMPOTENCY_CONFLICT','STALE_INPUT'].includes(e.code)?409:e.code==='BLOCKED_AUTHORITY'?422:400);
    if(e instanceof ControlContractError||e instanceof InterventionContractError||e instanceof ExperimentContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:400);
    if(e instanceof PeDomainError)return response({error:e.message,code:e.code},/NOT_FOUND/.test(e.code)?404:/INVALID/.test(e.code)?400:422);
    return errorResponse(e);
  }
}
