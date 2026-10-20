/** Versioned X1 consumer of the existing ordinary S8 lifecycle. This module
 * creates no signer, policy, grant, evaluator outcome or promotion decision. */
import { verify,randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { canonical } from '../../governed-execution/src/protocol';
import { privateFile } from './journal';
import { byteDigest,digest,fault,RefSchema,sameRef,type CapabilityRef,type Signed } from './contracts';
import { installedInstitutionCompilerIdentity,institutionCapabilityRef,parseInstitutionCompilerCandidate,type InstitutionCompilerCandidate } from './institution-port';

const text=z.string().min(1).max(4096),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
const PolicySchema=z.object({schema:z.literal('finnor.s8.institution-consumer-policy.v1'),
  domain:z.literal('DISPOSABLE_TEST_AUTHORITY'),tenantId:text,principalId:text,rightsRef:text,
  endpoint:text,tokenPath:text,tokenHash:hex,expectedCandidate:z.unknown(),
  validAfter:instant,validUntil:instant,timeoutMs:z.number().int().min(100).max(10000)}).strict();
type Scope={tenantId:string;principalId:string;rightsRef:string;profileDigest:string};
export type InstitutionCompilerCapability={schema:'finnor.s8.institution-consumer-binding.v1';
  revisionRef:CapabilityRef;admissionRef:CapabilityRef;policyDigest:string;candidateDigest:string;
  profileDigest:string;runtimeDigest:string;protectionDomain:'DISPOSABLE_TEST_AUTHORITY';
  protectedQualification:false;productionActive:false;executionAuthorityGranted:false};

async function configuration(scope:Scope){
  const path=process.env.FINNOR_S8_INSTITUTION_CONSUMER_CONFIG;if(!path)return null;
  const root=process.env.FINNOR_S8_INSTITUTION_CONSUMER_ROOT;
  if(!root)fault('S8_INSTITUTION_CONSUMER_ROOT_UNAVAILABLE',503);
  const bytes=await privateFile(path),signed=JSON.parse(bytes.toString()) as Signed<unknown>,policy=PolicySchema.parse(signed.body);
  if(!verify(null,Buffer.from(canonical(policy)),root,Buffer.from(signed.signature,'base64'))
    ||Date.now()<Date.parse(policy.validAfter)||Date.now()>=Date.parse(policy.validUntil))
    fault('S8_INSTITUTION_CONSUMER_POLICY_INVALID',403);
  if(policy.tenantId!==scope.tenantId||policy.principalId!==scope.principalId||policy.rightsRef!==scope.rightsRef)
    fault('S8_INSTITUTION_CONSUMER_SCOPE',403);
  const endpoint=new URL(policy.endpoint);
  if(endpoint.origin!==policy.endpoint||endpoint.username||endpoint.password
    ||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1')
    fault('S8_INSTITUTION_CONSUMER_ENDPOINT',403);
  const candidate=parseInstitutionCompilerCandidate(policy.expectedCandidate);
  if(candidate.tenantId!==scope.tenantId||candidate.principalId!==scope.principalId
    ||candidate.rightsRef!==scope.rightsRef||candidate.profileDigest!==scope.profileDigest
    ||Date.parse(candidate.validAfter)<Date.parse(policy.validAfter)||Date.parse(candidate.validUntil)>Date.parse(policy.validUntil))
    fault('S8_INSTITUTION_CANDIDATE_SCOPE',403);
  await installedCandidate(candidate);
  return {policy,candidate,policyDigest:digest(policy)};
}
async function installedCandidate(candidate:InstitutionCompilerCandidate){
  const installed=await installedInstitutionCompilerIdentity();
  if(digest(candidate.dependencies)!==digest(installed.sources)||candidate.runtimeDigest!==installed.ref.contentDigest)
    fault('S8_INSTITUTION_INSTALLED_CLOSURE_CHANGED');
  const required={producerModule:'/institution-program/reconstruction.ts',checkerModule:'/institution-program/checker.ts',
    incrementalModule:'/live-recompilation/institution-dependencies.ts'} as const;
  for(const [field,suffix] of Object.entries(required)){
    const module=candidate.payload[field as keyof typeof required];
    if(!module.path.endsWith(suffix)||!installed.sources.some(p=>p.path===module.path&&p.sha256===module.sha256))
      fault('S8_INSTITUTION_MODULE_SUBSTITUTION');
  }
  const checkerFiles=['/institution-program/checker.ts','/institution-program/checker-raw.ts','/institution-program/canonical-json.ts']
    .map(suffix=>installed.sources.find(p=>p.path.endsWith(suffix))!.path);
  if(candidate.checkerRevision!==byteDigest(Buffer.concat(await Promise.all(checkerFiles.map(path=>readFile(path))))))
    fault('S8_INSTITUTION_CHECKER_REVISION_CHANGED');
}

/** Reviewable proposal bytes only. Caller must supply an existing owner profile
 * reference and scope; S8 actors independently register/evaluate/admit them. */
export async function createInstalledInstitutionCompilerProposal(input:{tenantId:string;principalId:string;
  rightsRef:string;profileRef:CapabilityRef;profileDigest:string;validAfter:string;validUntil:string}){
  const scope=z.object({tenantId:text,principalId:text,rightsRef:text,profileRef:RefSchema,profileDigest:hex,
    validAfter:instant,validUntil:instant}).strict().parse(input);
  const installed=await installedInstitutionCompilerIdentity();
  const pin=(suffix:string)=>{const result=installed.sources.find(p=>p.path.endsWith(suffix));
    if(!result)fault('S8_INSTITUTION_REQUIRED_SOURCE_UNAVAILABLE');return result;};
  const checkerFiles=['checker.ts','checker-raw.ts','canonical-json.ts'].map(name=>pin('/institution-program/'+name).path);
  const body={schema:'finnor.s8.institution-compiler.v1',...scope,owningInterface:'x1-institution-programme-v1',
    dependencies:installed.sources,checkerRevision:byteDigest(Buffer.concat(await Promise.all(checkerFiles.map(path=>readFile(path))))),
    runtimeDigest:installed.ref.contentDigest,proposedAt:new Date().toISOString(),
    payload:{algorithm:'NATIVE_EVIDENCE_HYPOTHESES_ORIGINAL_INVARIANTS',
      producerModule:pin('/institution-program/reconstruction.ts'),checkerModule:pin('/institution-program/checker.ts'),
      incrementalModule:pin('/live-recompilation/institution-dependencies.ts')},
    protectedAdmission:false,executionAuthorityGranted:false};
  const candidate=parseInstitutionCompilerCandidate({...body,ref:institutionCapabilityRef('candidate',body)});
  await installedCandidate(candidate);return candidate;
}

/** Re-read configuration/token and the actual service on every currentness
 * check. A configured admission cannot silently fall back after removal. */
export async function currentInstitutionCompilerCapability(scope:Scope,
  expected?:InstitutionCompilerCapability):Promise<InstitutionCompilerCapability|null>{
  const configured=await configuration(scope);
  if(!configured){if(expected)fault('S8_INSTITUTION_CONSUMER_POLICY_REMOVED',503);return null;}
  const {policy,candidate,policyDigest}=configured;
  const token=await privateFile(policy.tokenPath,4096);
  if(byteDigest(token)!==policy.tokenHash)fault('S8_INSTITUTION_CONSUMER_TOKEN_CHANGED',403);
  const response=await fetch(policy.endpoint+'/command',{method:'POST',redirect:'error',credentials:'omit',
    headers:{authorization:'Bearer '+token.toString(),'content-type':'application/json'},
    body:canonical({requestId:'x1-s8-current:'+randomUUID(),operation:'INSTITUTION_CURRENT',body:{revisionRef:candidate.ref}}),
    signal:AbortSignal.timeout(policy.timeoutMs)});
  if(!response.body)fault('S8_INSTITUTION_EMPTY_RESPONSE');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;
    if(total>1048576)fault('S8_INSTITUTION_RESPONSE_BOUND');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const reply=JSON.parse(Buffer.concat(chunks).toString());
  if(!response.ok)fault(typeof reply.code==='string'?reply.code:'S8_INSTITUTION_CURRENT_REFUSED',response.status);
  if(!sameRef(RefSchema.parse(reply.revisionRef),candidate.ref)||reply.protectedQualification!==false
    ||reply.productionActive!==false||reply.executionAuthorityGranted!==false)
    fault('S8_INSTITUTION_CURRENT_RESPONSE_SUBSTITUTION');
  if(reply.current!==true)fault('S8_INSTITUTION_METHOD_NOT_CURRENT',503);
  const current=parseInstitutionCompilerCandidate(reply.candidate),admission=RefSchema.parse(reply.admissionRef);
  if(digest(current)!==digest(candidate)||admission.owner!=='S8'||admission.version!=='s8-institution-compiler-v1'
    ||!admission.id.startsWith('institution-institution_admit:'))fault('S8_INSTITUTION_CURRENT_BINDING_INVALID');
  await installedCandidate(current);
  const binding:InstitutionCompilerCapability={schema:'finnor.s8.institution-consumer-binding.v1',
    revisionRef:current.ref,admissionRef:admission,policyDigest,candidateDigest:current.ref.contentDigest,
    profileDigest:current.profileDigest,runtimeDigest:current.runtimeDigest,protectionDomain:'DISPOSABLE_TEST_AUTHORITY',
    protectedQualification:false,productionActive:false,executionAuthorityGranted:false};
  if(expected&&digest(binding)!==digest(expected))fault('S8_INSTITUTION_CURRENT_ADMISSION_CHANGED');
  return binding;
}
