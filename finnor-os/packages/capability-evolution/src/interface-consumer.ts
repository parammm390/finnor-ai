/** Authenticated P5 consumer through the existing S8 service, not a second catalogue. */
import {verify} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {byteDigest,digest,fault,RefSchema,type Signed} from './contracts';
import {parseInterfaceCandidate,type InterfaceCandidate,InterfacePayloadSchema,InterfaceDomainSchema,InterfacePortRefSchema} from './interface-port';
const PolicySchema=z.object({schema:z.literal('finnor.s8.interface-consumer-policy.v1'),domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 tenantId:z.string(),principalId:z.string(),rightsRef:z.string(),endpoint:z.string(),tokenPath:z.string(),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
 sourcePins:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(128),
 validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true}),timeoutMs:z.number().int().min(100).max(10000)}).strict();
type ConsumerPolicy=z.infer<typeof PolicySchema>;
export async function interfaceConsumerPolicy(scope:{tenantId:string;principalId:string;rightsRef?:string}):Promise<ConsumerPolicy|null>{
 const file=process.env.FINNOR_S8_INTERFACE_CONSUMER_CONFIG;
 if(!file)return null;
 const root=process.env.FINNOR_S8_INTERFACE_CONSUMER_ROOT;if(!root)fault('S8_INTERFACE_CONSUMER_ROOT_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(file)).toString()) as Signed<unknown>,policy=PolicySchema.parse(signed.body);
 if(!verify(null,Buffer.from(canonical(policy)),root,Buffer.from(signed.signature,'base64'))||Date.now()<Date.parse(policy.validAfter)||Date.now()>=Date.parse(policy.validUntil))fault('S8_INTERFACE_CONSUMER_POLICY_INVALID',403);
 if(policy.tenantId!==scope.tenantId||policy.principalId!==scope.principalId||scope.rightsRef!==undefined&&policy.rightsRef!==scope.rightsRef)fault('S8_INTERFACE_CONSUMER_SCOPE',403);
 const url=new URL(policy.endpoint);
 if(url.origin!==policy.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)fault('S8_INTERFACE_CONSUMER_ENDPOINT',403);
 return policy;
}
async function command(policy:ConsumerPolicy,operation:string,body:unknown,requestId:string){
 const token=await privateFile(policy.tokenPath,4096);
 if(byteDigest(token)!==policy.tokenHash)fault('S8_INTERFACE_TOKEN_CHANGED',403);
 const response=await fetch(policy.endpoint+'/command',{method:'POST',headers:{authorization:'Bearer '+token.toString(),'content-type':'application/json'},
  body:canonical({operation,body,requestId}),redirect:'error',credentials:'omit',signal:AbortSignal.timeout(policy.timeoutMs)});
 if(!response.body)fault('S8_INTERFACE_EMPTY_RESPONSE');
 const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
 try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>262144)fault('S8_INTERFACE_RESPONSE_BOUND');chunks.push(r.value);}}
 finally{await reader.cancel().catch(()=>{});}
 const data=JSON.parse(Buffer.concat(chunks).toString());
 if(!response.ok)fault(typeof data.code==='string'?data.code:'S8_INTERFACE_COMMAND_REFUSED',response.status);
 return data;
}
export async function proposeInterfaceCandidate(candidate:InterfaceCandidate,policy:ConsumerPolicy){
 parseInterfaceCandidate(candidate);
 if(digest(candidate.dependencies)!==digest(policy.sourcePins)||candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef)fault('S8_INTERFACE_CANDIDATE_SCOPE');
 const reply=await command(policy,'INTERFACE_PROPOSE',candidate,'p5-propose:'+candidate.ref.contentDigest);
 if(digest(RefSchema.parse(reply.ref))!==digest(candidate.ref))fault('S8_INTERFACE_CANDIDATE_RESPONSE_SUBSTITUTION');
 return candidate.ref;
}
export async function currentInterfaceCandidate(candidate:InterfaceCandidate,policy:ConsumerPolicy,requestId:string){
 const reply=await command(policy,'INTERFACE_CURRENT',{revisionRef:candidate.ref},requestId);
 if(reply.protectedExecution!==false||reply.executionAuthorityGranted!==false||reply.protectionDomain!=='DISPOSABLE_TEST_AUTHORITY'||digest(reply.revisionRef)!==digest(candidate.ref))fault('S8_INTERFACE_CURRENT_RESPONSE_SUBSTITUTION');
 if(reply.current!==true)return null;
 const current=parseInterfaceCandidate(reply.candidate);
 if(digest(current)!==digest(candidate))fault('S8_INTERFACE_CURRENT_PAYLOAD_SUBSTITUTION');
 InterfacePayloadSchema.parse(current.payload);InterfaceDomainSchema.parse(current.domain);
 return InterfacePortRefSchema.parse(reply.admissionRef);
}
