import { z } from 'zod';
import { AllocationContractError, ControlContractError, ExperimentContractError, ExperimentRefSchema, InterventionContractError } from '@finnor/epistemic-runtime';
import { PeDomainError, synthesizeEnterpriseControl, readEnterpriseContingentPolicy, replayEnterpriseContingentPolicy, validateEnterpriseContingentPolicy, recordEnterpriseControlAssessment, observeEnterpriseControl, chooseEnterpriseControlBranch, prepareEnterpriseContingentHandoff } from '@finnor/private-equity';
import { errorResponse, requireContext } from '../../../../lib/auth';

export const runtime='nodejs';
const synthesis=z.object({mandate:z.unknown(),problem:z.unknown(),protocols:z.array(z.unknown()).max(8),scenarios:z.object({pathsPerMechanism:z.number().int().min(1).max(64),seed:z.number().int().min(0).max(4294967295)}).strict()}).strict();
const revision=synthesis.extend({priorPolicyRef:ExperimentRefSchema,reason:z.string().min(1).max(2048)});
const reference=z.object({policyRef:ExperimentRefSchema}).strict();
const branch=reference.extend({decision:z.unknown(),allocationRef:ExperimentRefSchema.optional(),measurements:z.array(z.object({protocol:z.unknown(),events:z.array(z.unknown()).max(4096)}).strict()).max(8).optional()});
const handoff=branch.extend({allocationRef:ExperimentRefSchema.optional()});
const temporal=reference.extend({instrumentId:z.string().min(1).max(256),availablePeriod:z.number().int().min(1).max(24),modelRef:ExperimentRefSchema.optional()});
const assessment=reference.extend({type:z.enum(['CORRECTION','HUMAN_OVERRIDE']),reason:z.string().min(1).max(2048),requestedActionId:z.string().min(1).max(256).nullable(),humanSeconds:z.number().finite().nonnegative().max(900),evidenceRefs:z.array(ExperimentRefSchema).max(32)});
function response(value:unknown,status=200):Response{const body=JSON.stringify(value);if(Buffer.byteLength(body)>8*1024*1024)throw new ControlContractError('LIMIT_EXCEEDED','S4 response exceeds 8 MiB');return new Response(body,{status,headers:{'content-type':'application/json','cache-control':'private, no-store'}});}
async function boundedJson(req:Request):Promise<unknown>{const limit=2*1024*1024;if(Number(req.headers.get('content-length')??0)>limit){await req.body?.cancel().catch(()=>undefined);throw new ControlContractError('LIMIT_EXCEEDED','S4 request exceeds 2 MiB');}if(!req.body)throw new ControlContractError('INVALID_REQUEST','S4 requires JSON');const reader=req.body.getReader(),bytes=Buffer.alloc(limit);let size=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;if(chunk.value.byteLength>limit-size){await reader.cancel().catch(()=>undefined);throw new ControlContractError('LIMIT_EXCEEDED','S4 request exceeds 2 MiB');}bytes.set(chunk.value,size);size+=chunk.value.byteLength;}return JSON.parse(bytes.subarray(0,size).toString('utf8'));}catch(e){if(e instanceof ControlContractError)throw e;throw new ControlContractError('INVALID_REQUEST','S4 requires bounded JSON');}finally{reader.releaseLock();}}
export async function POST(req:Request,{params}:{params:Promise<{operation:string}>}):Promise<Response>{try{const [auth,route]=await Promise.all([requireContext(req),params]),ctx={auth},body=await boundedJson(req);switch(route.operation){
 case 'synthesize':return response(await synthesizeEnterpriseControl(ctx,synthesis.parse(body)));
 case 'replan':return response(await synthesizeEnterpriseControl(ctx,revision.parse(body)));
 case 'read':return response(await readEnterpriseContingentPolicy(ctx,reference.parse(body).policyRef));
 case 'replay':return response(await replayEnterpriseContingentPolicy(ctx,reference.parse(body).policyRef));
 case 'validate':return response(await validateEnterpriseContingentPolicy(ctx,reference.parse(body).policyRef));
 case 'assessment':return response(await recordEnterpriseControlAssessment(ctx,assessment.parse(body)));
 case 'observe':return response(await observeEnterpriseControl(ctx,temporal.parse(body)));
 case 'decide':return response(await chooseEnterpriseControlBranch(ctx,branch.parse(body)));
 case 'handoff':return response(await prepareEnterpriseContingentHandoff(ctx,handoff.parse(body)));
 default:return response({error:'S4 operation was not found',code:'NOT_FOUND'},404);
 }}catch(e){if(e instanceof z.ZodError)return response({error:'Invalid S4 request',code:'INVALID_REQUEST'},400);if(e instanceof AllocationContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:['IDEMPOTENCY_CONFLICT','STALE_INPUT'].includes(e.code)?409:e.code==='BLOCKED_AUTHORITY'?422:400);if(e instanceof ControlContractError||e instanceof InterventionContractError||e instanceof ExperimentContractError)return response({error:e.message,code:e.code},e.code==='LIMIT_EXCEEDED'?413:e.code==='PERMITTED_CONTEXT_UNAVAILABLE'?404:400);if(e instanceof PeDomainError)return response({error:e.message,code:e.code},/NOT_FOUND/.test(e.code)?404:/INVALID/.test(e.code)?400:422);return errorResponse(e);}}
