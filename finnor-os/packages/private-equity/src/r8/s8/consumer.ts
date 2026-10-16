import {z} from 'zod';
import {verify,randomUUID} from 'node:crypto';
import {canonical} from '../../../../governed-execution/src/protocol';
import {privateFile} from '../../../../capability-evolution/src/journal';
import {byteDigest,fault,RefSchema,type Signed} from '../../../../capability-evolution/src/contracts';
import {SOLVER_PORT_VERSION,type SolverUseLease} from './contracts';
import {hash} from '../../../../epistemic-runtime/src/solver-synthesis/contracts';
import type {SolverCapsule} from '../../../../shared-types/src/solver-capsule';
const instant=z.string().datetime({offset:true}),text=z.string().min(1).max(4096),hex=z.string().regex(/^[a-f0-9]{64}$/);
const PolicySchema=z.object({schema:z.literal('finnor.s8.solver-consumer-policy.v1'),contract:z.literal(SOLVER_PORT_VERSION),
 domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),tenantId:text,principalId:text,rightsRef:text,endpoint:text,
 tokenPath:text,tokenHash:hex,revisionRef:RefSchema,admissionRef:RefSchema,capsuleRef:RefSchema,
 validAfter:instant,validUntil:instant,timeoutMs:z.number().int().min(100).max(10000)}).strict();
type Policy=z.infer<typeof PolicySchema>;
const LeaseSchema=z.object({schema:z.literal('finnor.s8.solver-use.v1'),useId:z.string().uuid(),ref:RefSchema,
 revisionRef:RefSchema,admissionRef:RefSchema,capsuleRef:RefSchema,payloadDigest:hex,inputDigest:hex,
 workInputDigest:hex,rightsRef:text,generation:z.number().int().positive(),expiresAt:instant,mode:z.literal('DIAGNOSTIC'),
 protectedExecution:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
async function policy(scope:{tenantId:string;principalId:string;rightsRef:string},capsule:SolverCapsule):Promise<Policy|null>{
 const path=process.env.FINNOR_S8_SOLVER_CONSUMER_CONFIG;
 if(!path)return null;
 const root=process.env.FINNOR_S8_SOLVER_CONSUMER_ROOT;if(!root)fault('S8_SOLVER_CONSUMER_RELEASE_ROOT_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(path)).toString()) as Signed<unknown>,p=PolicySchema.parse(signed.body);
 if(!verify(null,Buffer.from(canonical(p)),root,Buffer.from(signed.signature,'base64'))||
  Date.now()<Date.parse(p.validAfter)||Date.now()>=Date.parse(p.validUntil))fault('S8_SOLVER_CONSUMER_POLICY_INVALID',403);
 if(p.tenantId!==scope.tenantId||p.principalId!==scope.principalId||p.rightsRef!==scope.rightsRef||
  hash(p.capsuleRef)!==hash(capsule.ref))fault('S8_SOLVER_CONSUMER_CURRENT_SCOPE_OR_METHOD_CHANGED',403);
 const url=new URL(p.endpoint);
 if(url.origin!==p.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)
  fault('S8_SOLVER_CONSUMER_ORDINARY_ENDPOINT_REQUIRED',403);
 return p;
}
async function command(p:Policy,operation:string,body:unknown,deadlineAt:number,requestId='solver-consumer:'+randomUUID()){
 const token=await privateFile(p.tokenPath,4096);
 if(byteDigest(token)!==p.tokenHash)fault('S8_SOLVER_CONSUMER_TOKEN_CHANGED',403);
 if(deadlineAt<=Date.now())fault('S8_SOLVER_ORIGINAL_USE_DEADLINE_EXHAUSTED');
 const response=await fetch(p.endpoint+'/command',{method:'POST',headers:{authorization:'Bearer '+token.toString(),'content-type':'application/json'},
  body:canonical({operation,body,requestId}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(Math.min(p.timeoutMs,deadlineAt-Date.now()))});
 if(!response.body)fault('S8_SOLVER_CONSUMER_EMPTY_RESPONSE');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const row=await reader.read();if(row.done)break;bytes+=row.value.length;if(bytes>262144)fault('S8_SOLVER_CONSUMER_RESPONSE_BOUND');chunks.push(row.value);}}
 finally{await reader.cancel().catch(()=>undefined);}
 const result=JSON.parse(Buffer.concat(chunks).toString());
 if(!response.ok)fault(typeof result.code==='string'?result.code:'S8_SOLVER_CONSUMER_REFUSED',response.status);
 return result;
}
export async function acquireSolverCapability(input:{capsule:SolverCapsule;tenantId:string;principalId:string;rightsRef:string;
 inputDigest:string;workInputDigest:string;deadlineAt:number}):Promise<SolverUseLease|null>{
 const p=await policy(input,input.capsule);if(!p)return null;
 const result=await command(p,'SOLVER_USE',{revisionRef:p.revisionRef,admissionRef:p.admissionRef,
  tenantId:input.tenantId,principalId:input.principalId,rightsRef:input.rightsRef,inputDigest:input.inputDigest,
  workInputDigest:input.workInputDigest,originalDeadlineAt:new Date(input.deadlineAt).toISOString(),mode:'DIAGNOSTIC'},input.deadlineAt);
 const lease=LeaseSchema.parse(result.lease);
 if(result.protectedExecution!==false||hash(lease.capsuleRef)!==hash(input.capsule.ref)||lease.payloadDigest!==hash(input.capsule)||
  hash(lease.revisionRef)!==hash(p.revisionRef)||hash(lease.admissionRef)!==hash(p.admissionRef)||
  lease.inputDigest!==input.inputDigest||lease.workInputDigest!==input.workInputDigest||lease.rightsRef!==input.rightsRef||
  Date.parse(lease.expiresAt)>input.deadlineAt||Date.parse(lease.expiresAt)<=Date.now())fault('S8_SOLVER_CONSUMER_LEASE_SUBSTITUTION');
 return lease;
}
export async function recheckSolverCapability(scope:{tenantId:string;principalId:string;rightsRef:string},
 capsule:SolverCapsule,lease:SolverUseLease,deadlineAt:number){
 const p=await policy(scope,capsule);if(!p)fault('S8_SOLVER_CONSUMER_POLICY_REMOVED');
 const result=await command(p,'SOLVER_CURRENT',{lease},deadlineAt);
 if(result.current!==true||result.protectedExecution!==false||hash(result.lease)!==hash(lease)||
  hash(result.capsuleRef)!==hash(capsule.ref))fault('S8_SOLVER_CONSUMER_CURRENT_USE_FENCED');
 return true;
}
