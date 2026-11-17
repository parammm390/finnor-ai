/** Consume only the existing root-authenticated lifecycle/enrollment and real DB role. */
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../../governed-execution/src/protocol";
import { digest, fault, type Signed } from "./contracts";
import { CanonicalSpecialistAuthority, type CanonicalEpoch } from "./specialist-publication-authority";
import { verifyEnrollment, immutable } from "./specialist-publication-protocol";
import { installedWorkforceSpecialistIdentity } from "./specialist-source";

const text=z.string().min(1).max(4096),signed=z.object({body:z.unknown(),keyId:text,signature:text}).strict();
export const canonicalConsumerConfigurationSchema=z.object({
  signedLifecyclePolicy:signed,enrollment:signed,quorumPolicy:signed,quorumRoot:text,
  approvals:z.array(z.object({role:text,keyId:text,signature:text}).strict()).min(2).max(512),
  client:z.unknown(),
}).strict();
type ConsumerScope={tenantId:string;principalId:string;rightsRef:string;
  evaluatorKeys:unknown[];promotionKeys:unknown[];canonical:unknown};
export async function openConsumerCanonicalAuthority(policy:ConsumerScope,root:string,
  allowedRoles:readonly string[]=["reader","candidate"], originalReadOnly=false){
  const config=canonicalConsumerConfigurationSchema.parse(policy.canonical),
    original=config.signedLifecyclePolicy.body as any,key=createPublicKey(root);
  if(key.asymmetricKeyType!=="ed25519"||!original||typeof original!=="object"
    ||!verify(null,Buffer.from(canonical(original)),key,Buffer.from(config.signedLifecyclePolicy.signature,"base64"))
    ||original.schema!=="finnor.s8.lifecycle-policy.v1"||original.domain!=="REVIEWED_PROTECTED_DOMAIN"
    ||original.tenantId!==policy.tenantId||original.principalId!==policy.principalId
    ||original.rightsRef!==policy.rightsRef||!original.specialistAnalysis||!original.protectedEvents
    ||digest(original.evaluatorKeys)!==digest(policy.evaluatorKeys)
    ||digest(original.promotionKeys)!==digest(policy.promotionKeys))
    fault("S8_CANONICAL_ORIGINAL_SIGNED_LIFECYCLE_REQUIRED",503);
  const body=config.enrollment.body as any;
  const enrollment=verifyEnrollment({signed:config.enrollment,releaseRoot:root,
    policyDigest:digest(original),tenantId:policy.tenantId,principalId:policy.principalId,rightsRef:policy.rightsRef,
    evaluatorKeys:original.evaluatorKeys,promotionKeys:original.promotionKeys,
    quorum:config.quorumPolicy,quorumRoot:config.quorumRoot,expectedQuorumDigest:body?.quorumPolicyDigest,
    approvals:config.approvals,originalReadOnly});
  const authority=await CanonicalSpecialistAuthority.open(enrollment,config.client,
    await installedWorkforceSpecialistIdentity());
  if(!allowedRoles.includes(authority.config.role)){
    await authority.close();fault("S8_CANONICAL_CONSUMER_ROLE_NOT_SEPARATED",503);
  }
  return authority;
}
export function assertCanonicalCurrentBinding(epoch:CanonicalEpoch,input:{
  revisionRef:unknown;admissionRef:unknown;evaluationRef:unknown;protocolRef:unknown;
  candidate:unknown;admission:unknown;evaluation:unknown;protocol:unknown;
  canonicalAuthority:{enrollmentDigest:string;epoch:string;historyDigest:string};
}){
  const state=epoch.canonicalState as any,entries=state?.specialistEntries;
  if(state?.schema!=="finnor.s8.authenticated-canonical-specialist-history.v1"||!Array.isArray(entries)
    ||input.canonicalAuthority.enrollmentDigest!==epoch.enrollmentDigest
    ||input.canonicalAuthority.epoch!==epoch.epoch||input.canonicalAuthority.historyDigest!==epoch.historyDigest)
    fault("S8_CANONICAL_CURRENT_REPLY_EPOCH_CHANGED",503);
  for(const [operation,ref,content]of [
    ["SPECIALIST_PROPOSE",input.revisionRef,input.candidate],["SPECIALIST_REGISTER",input.protocolRef,input.protocol],
    ["SPECIALIST_EVALUATE",input.evaluationRef,input.evaluation],["SPECIALIST_ADMIT",input.admissionRef,input.admission],
  ]){
    if(!entries.some((entry:any)=>entry.operation===operation
      &&digest(entry.result.ref)===digest(ref)&&digest(entry.body)===digest(content)
      &&entry.requestDigest===digest({actorId:entry.actorId,requestId:entry.requestId,
        operation:entry.operation,body:entry.body})))
      fault("S8_CURRENT_NOT_THE_CANONICAL_ORIGINAL_TERMINAL",503);
  }
  if(entries.some((entry:any)=>entry.operation==="SPECIALIST_REVOKE"
    &&digest(entry.body?.body?.revisionRef)===digest(input.revisionRef)))
    fault("S8_CANONICAL_ORIGINAL_ADMISSION_REVOKED",503);
}
export const canonicalAuthorityReplySchema=z.object({
  enrollmentDigest:z.string().regex(/^[a-f0-9]{64}$/),
  epoch:z.string().regex(/^[1-9][0-9]*$/),historyDigest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function canonicalEpochReference(epoch:CanonicalEpoch){
  return immutable({enrollmentDigest:epoch.enrollmentDigest,epoch:epoch.epoch,historyDigest:epoch.historyDigest});
}
