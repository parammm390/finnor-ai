import {verify} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {digest,fault,RefSchema,type Signed} from './contracts';
import {capabilityConsumerCommand} from './consumer-transport';
import {parseLearnedPolicyCandidate,type LearnedPolicyCandidate} from './learned-policy-port';
const Policy=z.object({schema:z.literal('finnor.s8.learned-policy-consumer-policy.v1'),domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 tenantId:z.string(),principalId:z.string(),rightsRef:z.string(),endpoint:z.string(),tokenPath:z.string(),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
 sourcePins:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(128),
 validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true}),timeoutMs:z.number().int().min(100).max(10000)}).strict();
type Policy=z.infer<typeof Policy>;
export async function learnedPolicyConsumerPolicy(scope:{tenantId:string;principalId:string;rightsRef:string}){
 const file=process.env.FINNOR_S8_LEARNED_POLICY_CONSUMER_CONFIG;if(!file)return null;
 const root=process.env.FINNOR_S8_LEARNED_POLICY_CONSUMER_ROOT;if(!root)fault('S8_LEARNED_POLICY_ROOT_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(file)).toString()) as Signed<unknown>,policy=Policy.parse(signed.body);
 if(!verify(null,Buffer.from(canonical(policy)),root,Buffer.from(signed.signature,'base64'))||Date.now()<Date.parse(policy.validAfter)||Date.now()>=Date.parse(policy.validUntil))fault('S8_LEARNED_POLICY_POLICY_INVALID',403);
 if(policy.tenantId!==scope.tenantId||policy.principalId!==scope.principalId||policy.rightsRef!==scope.rightsRef)fault('S8_LEARNED_POLICY_SCOPE',403);
 const url=new URL(policy.endpoint);
 if(url.origin!==policy.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)fault('S8_LEARNED_POLICY_ENDPOINT',403);
 return policy;
}
export async function proposeLearnedPolicyCandidate(candidate:LearnedPolicyCandidate,policy:Policy){
 parseLearnedPolicyCandidate(candidate);
 if(candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef||digest(candidate.dependencies)!==digest(policy.sourcePins))fault('S8_LEARNED_POLICY_SCOPE');
 const reply=await capabilityConsumerCommand(policy,'LEARNED_POLICY_PROPOSE',candidate,'x5-propose:'+candidate.ref.contentDigest,'LEARNED_POLICY');
 if(digest(RefSchema.parse(reply.ref))!==digest(candidate.ref))fault('S8_LEARNED_POLICY_PROPOSAL_SUBSTITUTION');
 return candidate.ref;
}
export async function currentLearnedPolicyCandidate(candidate:LearnedPolicyCandidate,policy:Policy,requestId:string){
 const reply=await capabilityConsumerCommand(policy,'LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref},requestId,'LEARNED_POLICY');
 if(reply.protectedAdmission!==false||reply.executionAuthorityGranted!==false||reply.protectionDomain!=='DISPOSABLE_TEST_AUTHORITY'||digest(reply.revisionRef)!==digest(candidate.ref))fault('S8_LEARNED_POLICY_CURRENT_SUBSTITUTION');
 if(reply.current!==true)return null;
 const validUntil=z.string().datetime({offset:true}).parse(reply.currentUntil);
 if(Date.now()>=Date.parse(validUntil))return null;
 if(Date.parse(validUntil)>Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil)))fault('S8_LEARNED_POLICY_VALIDITY_SUBSTITUTION');
 if(digest(parseLearnedPolicyCandidate(reply.candidate))!==digest(candidate))fault('S8_LEARNED_POLICY_PAYLOAD_SUBSTITUTION');
 return {ref:RefSchema.parse(reply.admissionRef),validUntil};
}
