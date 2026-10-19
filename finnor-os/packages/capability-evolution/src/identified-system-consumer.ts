import {verify} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {digest,fault,RefSchema,type Signed} from './contracts';
import {capabilityConsumerCommand} from './consumer-transport';
import {parseIdentifiedSystemCandidate,type IdentifiedSystemCandidate} from './identified-system-port';
const Policy=z.object({schema:z.literal('finnor.s8.identified-system-consumer-policy.v1'),domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 tenantId:z.string(),principalId:z.string(),rightsRef:z.string(),endpoint:z.string(),tokenPath:z.string(),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
 sourcePins:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(256),
 validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true}),timeoutMs:z.number().int().min(100).max(10000)}).strict();
type Policy=z.infer<typeof Policy>;
export async function identifiedSystemConsumerPolicy(scope:{tenantId:string;principalId:string;rightsRef:string}){
 const path=process.env.FINNOR_S8_IDENTIFIED_SYSTEM_CONSUMER_CONFIG;if(!path)return null;
 const root=process.env.FINNOR_S8_IDENTIFIED_SYSTEM_CONSUMER_ROOT;if(!root)fault('S8_IDENTIFIED_SYSTEM_ROOT_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(path)).toString()) as Signed<unknown>,policy=Policy.parse(signed.body);
 if(!verify(null,Buffer.from(canonical(policy)),root,Buffer.from(signed.signature,'base64'))||Date.now()<Date.parse(policy.validAfter)||Date.now()>=Date.parse(policy.validUntil))fault('S8_IDENTIFIED_SYSTEM_POLICY_INVALID',403);
 if(policy.tenantId!==scope.tenantId||policy.principalId!==scope.principalId||policy.rightsRef!==scope.rightsRef)fault('S8_IDENTIFIED_SYSTEM_SCOPE',403);
 const u=new URL(policy.endpoint);
 if(u.origin!==policy.endpoint||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password)fault('S8_IDENTIFIED_SYSTEM_ENDPOINT',403);
 return policy;
}
export async function proposeIdentifiedSystemCandidate(candidate:IdentifiedSystemCandidate,policy:Policy){
 parseIdentifiedSystemCandidate(candidate);
 if(candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef||digest(candidate.dependencies)!==digest(policy.sourcePins))fault('S8_IDENTIFIED_SYSTEM_SCOPE');
 const reply=await capabilityConsumerCommand(policy,'IDENTIFIED_SYSTEM_PROPOSE',candidate,'x4-propose:'+candidate.ref.contentDigest,'IDENTIFIED_SYSTEM');
 if(digest(RefSchema.parse(reply.ref))!==digest(candidate.ref))fault('S8_IDENTIFIED_SYSTEM_PROPOSAL_SUBSTITUTION');
 return candidate.ref;
}
export async function currentIdentifiedSystemCandidate(candidate:IdentifiedSystemCandidate,policy:Policy,requestId:string){
 const reply=await capabilityConsumerCommand(policy,'IDENTIFIED_SYSTEM_CURRENT',{revisionRef:candidate.ref},requestId,'IDENTIFIED_SYSTEM');
 if(reply.protectedAdmission!==false||reply.executionAuthorityGranted!==false||reply.protectionDomain!=='DISPOSABLE_TEST_AUTHORITY'||digest(reply.revisionRef)!==digest(candidate.ref))fault('S8_IDENTIFIED_SYSTEM_CURRENT_SUBSTITUTION');
 if(reply.current!==true)return null;
 const validUntil=z.string().datetime({offset:true}).parse(reply.currentUntil);
 if(Date.now()>=Date.parse(validUntil))return null;
 if(Date.parse(validUntil)>Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil)))fault('S8_IDENTIFIED_SYSTEM_VALIDITY_SUBSTITUTION');
 if(digest(parseIdentifiedSystemCandidate(reply.candidate))!==digest(candidate))fault('S8_IDENTIFIED_SYSTEM_PAYLOAD_SUBSTITUTION');
 return {ref:RefSchema.parse(reply.admissionRef),validUntil};
}
