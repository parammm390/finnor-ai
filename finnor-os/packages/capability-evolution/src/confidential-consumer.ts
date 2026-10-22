import {verify} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {digest,fault,RefSchema,type Signed} from './contracts';
import {capabilityConsumerCommand} from './consumer-transport';
import {parseConfidentialCandidate,type ConfidentialCandidate} from './confidential-port';
const Policy=z.object({schema:z.literal('finnor.s8.confidential-consumer-policy.v1'),domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 tenantId:z.string(),principalId:z.string(),rightsRef:z.string(),endpoint:z.string(),tokenPath:z.string(),
 tokenHash:z.string().regex(/^[a-f0-9]{64}$/),sourcePins:z.array(z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(256),
 validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true}),timeoutMs:z.number().int().min(100).max(10000)}).strict();
type Policy=z.infer<typeof Policy>;
export async function confidentialConsumerPolicy(scope:{tenantId:string;principalId:string;rightsRef:string}){
 const path=process.env.FINNOR_S8_CONFIDENTIAL_CONSUMER_CONFIG,root=process.env.FINNOR_S8_CONFIDENTIAL_CONSUMER_ROOT;
 if(!path||!root)fault('S8_CONFIDENTIAL_CONSUMER_UNAVAILABLE',503);
 const signed=JSON.parse((await privateFile(path)).toString()) as Signed<unknown>,p=Policy.parse(signed.body);
 if(!verify(null,Buffer.from(canonical(p)),root,Buffer.from(signed.signature,'base64'))
  ||Date.now()<Date.parse(p.validAfter)||Date.now()>=Date.parse(p.validUntil)
  ||p.tenantId!==scope.tenantId||p.principalId!==scope.principalId||p.rightsRef!==scope.rightsRef)fault('S8_CONFIDENTIAL_POLICY_OR_SCOPE_INVALID',403);
 const url=new URL(p.endpoint);
 if(url.origin!==p.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)fault('S8_CONFIDENTIAL_ENDPOINT',403);
 return p;
}
export async function proposeConfidentialCandidate(candidate:ConfidentialCandidate,policy:Policy){
 parseConfidentialCandidate(candidate);
 if(candidate.tenantId!==policy.tenantId||candidate.principalId!==policy.principalId||candidate.rightsRef!==policy.rightsRef
  ||digest(candidate.dependencies)!==digest(policy.sourcePins))fault('S8_CONFIDENTIAL_SCOPE');
 const r=await capabilityConsumerCommand(policy,'CONFIDENTIAL_PROPOSE',candidate,'y4-propose:'+candidate.ref.contentDigest,'CONFIDENTIAL');
 if(digest(RefSchema.parse(r.ref))!==digest(candidate.ref))fault('S8_CONFIDENTIAL_PROPOSAL_SUBSTITUTION');
 return candidate.ref;
}
export async function currentConfidentialCandidate(candidate:ConfidentialCandidate,policy:Policy,requestId:string){
 const r=await capabilityConsumerCommand(policy,'CONFIDENTIAL_CURRENT',{revisionRef:candidate.ref},requestId,'CONFIDENTIAL');
 if(r.protectedAdmission!==false||r.executionAuthorityGranted!==false||r.protectionDomain!=='DISPOSABLE_TEST_AUTHORITY'
  ||r.scope!=='RECIPIENT_LOCAL_ANALYTICAL_CONSTRUCTION_ONLY'||digest(r.revisionRef)!==digest(candidate.ref))
  fault('S8_CONFIDENTIAL_CURRENT_SUBSTITUTION');
 if(r.current!==true)return null;
 const until=z.string().datetime({offset:true}).parse(r.currentUntil);
 if(Date.now()>=Date.parse(until))return null;
 if(Date.parse(until)>Math.min(Date.parse(candidate.domain.validUntil),Date.parse(policy.validUntil))
  ||digest(parseConfidentialCandidate(r.candidate))!==digest(candidate))fault('S8_CONFIDENTIAL_PAYLOAD_OR_VALIDITY_SUBSTITUTION');
 return {ref:RefSchema.parse(r.admissionRef),validUntil:until};
}
