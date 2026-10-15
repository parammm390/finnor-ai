import type { ExperimentRef } from '@finnor/shared-types';
import type { PeMutationContext } from '../types';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { assertR3Current } from './owners';
import { r3Object, r3Protocol, r3Request } from './store';
export interface R3FiniteModelRead { schema:'finnor.s3.r3-finite-model-read.v1'; modelRef:ExperimentRef }
/** S3's exact declared finite-family adapter, not a temporal fit or admission. */
export async function resolveR3FinitePreferenceModel(ctx:PeMutationContext, ref:ExperimentRef) {
  if(ref.owner!=='S3'||ref.version!=='s3-finite-preference-v1')throw Error('R3_S3_FINITE_PREFERENCE_VERSION_REQUIRED');
  const body=await r3Object<{requestId:string;problem:unknown;behavioralQualification:'UNQUALIFIED'}>(ctx,ref);
  const row=await r3Request(ctx,body.requestId);
  await assertR3Current(ctx,row,undefined,false,true);
  if(body.behavioralQualification!=='UNQUALIFIED'||r3Digest(body.problem)!==r3Digest(row.problem))
    throw Error('R3_S3_ORIGINAL_SUPPLIED_PREFERENCE_BINDING');
  return {...body,ref,provenance:'OWNER_SUPPLIED_HYPOTHESIS_NOT_PRIVATE_TRUTH', scientificAdmission:null,executionAuthorityGranted:false};
}
export async function readR3FiniteModelForProtocol(ctx:PeMutationContext,requestId:string) {
  const row=await r3Request(ctx,requestId),protocol=await r3Protocol(ctx,row);
  const {r3Ref}=await import('./store');
  const body={requestId:row.id,problem:row.problem,behavioralQualification:'UNQUALIFIED',sourceStandingNotPrivateTruth:true};
  return resolveR3FinitePreferenceModel(ctx,r3Ref('S3','r3-finite-model',body,'s3-finite-preference-v1'));
}
