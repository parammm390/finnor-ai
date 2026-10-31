import {verify} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {digest,fault,RefSchema,type Signed} from './contracts';
import {capabilityConsumerCommand} from './consumer-transport';
import {parseUniformAlgorithmCandidate,type UniformAlgorithmCandidate} from './uniform-algorithm-port';
import {assertTotalUniformPinBounds,TOTAL_UNIFORM_SOURCE_LIMITS} from './source-closure';
const Policy=z.object({schema:z.literal('finnor.s8.uniform-algorithm-consumer-policy.v1'),domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 tenantId:z.string().uuid(),principalId:z.string().uuid(),rightsRef:z.string(),endpoint:z.string(),tokenPath:z.string(),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),
 sourcePins:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(256),
 validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true}),timeoutMs:z.number().int().min(100).max(30000)}).strict();
const TotalPolicy=Policy.extend({schema:z.literal('finnor.s8.uniform-algorithm-consumer-policy.v2'),
 profile:z.literal('CLOSED_TOTAL_FOLD_INTEGER_LISTS_V2'),
 sourcePins:z.array(Policy.shape.sourcePins.element).min(1).max(TOTAL_UNIFORM_SOURCE_LIMITS.maxPins)}).strict();
export async function uniformAlgorithmConsumerPolicy(scope:{tenantId:string;principalId:string;rightsRef:string}){
 const file=process.env.FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_CONFIG;if(!file)return null;
 const root=process.env.FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_ROOT;if(!root)fault('S8_UNIFORM_ALGORITHM_ROOT_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(file)).toString()) as Signed<unknown>;
 const p=z.union([Policy,TotalPolicy]).parse(signed.body);
 if(p.schema==='finnor.s8.uniform-algorithm-consumer-policy.v2')assertTotalUniformPinBounds(p.sourcePins);
 if(!verify(null,Buffer.from(canonical(p)),root,Buffer.from(signed.signature,'base64'))||Date.now()<Date.parse(p.validAfter)||Date.now()>=Date.parse(p.validUntil))fault('S8_UNIFORM_ALGORITHM_POLICY_INVALID',403);
 if(p.tenantId!==scope.tenantId||p.principalId!==scope.principalId||p.rightsRef!==scope.rightsRef)fault('S8_UNIFORM_ALGORITHM_SCOPE',403);
 const url=new URL(p.endpoint);
 if(url.origin!==p.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)fault('S8_UNIFORM_ALGORITHM_ENDPOINT',403);
 return p;
}
export async function proposeUniformAlgorithmCandidate(candidate:UniformAlgorithmCandidate,policy:NonNullable<Awaited<ReturnType<typeof uniformAlgorithmConsumerPolicy>>>){
 parseUniformAlgorithmCandidate(candidate);
 assertUniformConsumerProfile(candidate,policy);
 if(candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef||digest(candidate.dependencies)!==digest(policy.sourcePins))fault('S8_UNIFORM_ALGORITHM_SCOPE');
 const reply=await capabilityConsumerCommand(policy,'UNIFORM_ALGORITHM_PROPOSE',candidate,'y5-propose:'+candidate.ref.contentDigest,'UNIFORM_ALGORITHM',
  candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2'?'TOTAL_THEORY_V2':undefined);
 if(digest(RefSchema.parse(reply.ref))!==digest(candidate.ref))fault('S8_UNIFORM_ALGORITHM_PROPOSAL_SUBSTITUTION');return candidate.ref;
}
export async function currentUniformAlgorithmCandidate(candidate:UniformAlgorithmCandidate,policy:NonNullable<Awaited<ReturnType<typeof uniformAlgorithmConsumerPolicy>>>){
 assertUniformConsumerProfile(candidate,policy);
 if(candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef||
  digest(candidate.dependencies)!==digest(policy.sourcePins))fault('S8_UNIFORM_ALGORITHM_SCOPE');
 const reply=await capabilityConsumerCommand(policy,'UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref},'y5-current:'+crypto.randomUUID(),'UNIFORM_ALGORITHM',
  candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2'?'TOTAL_THEORY_V2':undefined);
 if(reply.protectedAdmission!==false||reply.executionAuthorityGranted!==false||reply.protectionDomain!=='DISPOSABLE_TEST_AUTHORITY'||digest(reply.revisionRef)!==digest(candidate.ref))fault('S8_UNIFORM_ALGORITHM_CURRENT_SUBSTITUTION');
 if(reply.current!==true)return null;
 const until=z.string().datetime({offset:true}).parse(reply.currentUntil);
 if(Date.parse(until)>Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil)))fault('S8_UNIFORM_ALGORITHM_VALIDITY_SUBSTITUTION');
 if(Date.now()>=Date.parse(until))return null;
 if(digest(parseUniformAlgorithmCandidate(reply.candidate))!==digest(candidate))fault('S8_UNIFORM_ALGORITHM_PAYLOAD_SUBSTITUTION');
 return {ref:RefSchema.parse(reply.admissionRef),validUntil:until};
}
function assertUniformConsumerProfile(candidate:UniformAlgorithmCandidate,policy:NonNullable<Awaited<ReturnType<typeof uniformAlgorithmConsumerPolicy>>>){
 if((candidate.schema==='finnor.s8.uniform-algorithm-candidate.v2')!==
  (policy.schema==='finnor.s8.uniform-algorithm-consumer-policy.v2'))fault('S8_UNIFORM_ALGORITHM_PROFILE_MISMATCH');
}
