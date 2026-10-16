import {readEnterpriseExactAllocation,validateEnterpriseExactAllocation,reconcileEnterpriseExactAllocation,releaseEnterpriseExactAllocation} from '../../../../../../packages/private-equity/src/r7/accounting';
import {R7Error} from '../../../../../../packages/private-equity/src/r7/contracts';
import { z } from 'zod';
import { AllocationContractError, ControlContractError, ExperimentContractError, AllocationOperationSchemas, InterventionContractError } from '@finnor/epistemic-runtime';
import { PeDomainError, clearEnterprisePortfolio, consumeEnterpriseAllocation, listEnterpriseAllocationResources, readEnterpriseAllocation, reconcileEnterpriseAllocation, recordEnterpriseAllocationAssessment, registerEnterpriseAllocationResource, releaseEnterpriseAllocation, validateEnterpriseAllocation,settleEnterpriseAllocation } from '@finnor/private-equity';
import { errorResponse, requireContext } from '../../../../lib/auth';
import {LedgerFault} from '@finnor/private-equity';
import { R3OwnerOperationSchemas } from '../../../../../../packages/epistemic-runtime/src/incentive-rule-synthesis/output-contracts';

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
      case 'coalition-clear':return response(await clearEnterpriseCoalitionAllocation(ctx,coalitionClear.parse(body)));
      case 'coalition-read':return response(await readEnterpriseCoalitionAllocation(ctx,coalitionRead.parse(body).allocationRef));
      case 'coalition-consume':return response(await consumeEnterpriseCoalitionAllocation(ctx,coalitionConsume.parse(body)));
      case 'coalition-release':return response(await releaseEnterpriseCoalitionAllocation(ctx,coalitionConsume.parse(body)));
      case 'resource':{const p=resource.parse(body);return response(await registerEnterpriseAllocationResource(ctx,{resource:p.resource,expectedRef:p.expectedRef}));}
      case 'resources':AllocationOperationSchemas.resources.parse(body);return response(await listEnterpriseAllocationResources(ctx));
      case 'clear':{const p=clearing.parse(body);return response(await clearEnterprisePortfolio(ctx,{...p,mandate:p.mandate,jointModel:p.jointModel}));}
      case 'clear-mechanism':{const p=R3OwnerOperationSchemas.allocations['clear-mechanism'].parse(body);
        return response(await clearEnterprisePortfolio(ctx,{schema:'finnor.s5.r3-clearing-request.v1',...p}));}
      case 'read':return response(await readEnterpriseAllocation(ctx,reference.parse(body).allocationRef));
      case 'validate':return response(await validateEnterpriseAllocation(ctx,reference.parse(body).allocationRef));
      case 'consume':return response(await consumeEnterpriseAllocation(ctx,consumption.parse(body)));
      case 'consume-mechanism':{const p=R3OwnerOperationSchemas.allocations['consume-mechanism'].parse(body);
        return response(await consumeEnterpriseAllocation(ctx,{schema:'finnor.s5.r3-consumption-request.v1',...p}));}
      case 'release':return response(await releaseEnterpriseAllocation(ctx,release.parse(body)));
      case 'reconcile':return response(await reconcileEnterpriseAllocation(ctx,reference.parse(body)));
      case 'settle':return response(await settleEnterpriseAllocation(ctx,AllocationOperationSchemas.settle.parse(body)));
      case 'assessment':return response(await recordEnterpriseAllocationAssessment(ctx,assessment.parse(body)));
      default:return response({error:'S5 operation was not found',code:'NOT_FOUND'},404);
    }
  }catch(e){
    if(e instanceof R7Error)return response({code:'R7_'+e.code,requirement:e.message},e.code==='UNAVAILABLE'?404:['STALE_INPUT','CONFLICT'].includes(e.code)?409:e.code==='CONFIGURATION_REQUIRED'?503:422);
    if(e instanceof z.ZodError)return response({error:'Invalid S5 request',code:'INVALID_REQUEST'},400);
    if(e instanceof LedgerFault)return response({code:e.code},e.status);
    if(e instanceof AllocationContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:['IDEMPOTENCY_CONFLICT','STALE_INPUT'].includes(e.code)?409:e.code==='BLOCKED_AUTHORITY'?422:400);
    if(e instanceof ControlContractError||e instanceof InterventionContractError||e instanceof ExperimentContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:400);
    if(e instanceof PeDomainError)return response({error:e.message,code:e.code},/NOT_FOUND/.test(e.code)?404:/INVALID/.test(e.code)?400:422);
    return errorResponse(e);
  }
}
