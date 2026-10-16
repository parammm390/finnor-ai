import type {PrimaryRequest,PrimarySourceProfile} from '@finnor/shared-types';
import {primarySourceOperation} from '../../../governed-execution/src/primary-records';

/** P5 declares the exact supported read contract. It does not confer authority,
 * solve consent or relabel its local interface rehearsal as external evidence. */
export function primaryInterface(profile:PrimarySourceProfile){
 if(profile.adapterVersion!=='primary-records-http-v1')throw Error('PRIMARY_INTERFACE_VERSION_UNSUPPORTED');
 return {owner:'P5',version:'primary-records-http-v1',requestSchema:'finnor.primary-request.v1',responseSchema:'finnor.primary-response.v1',
  acquire:'POST /primary/requests',recover:'GET /primary/requests/:requestId',page:'GET /primary/requests/:requestId?cursor=:cursor',
  retries:profile.recovery,sourceProfileId:profile.profileId,sourceRevision:profile.revision,executionAuthorityGranted:false,admission:null};
}
export async function invokePrimaryInterface(profile:PrimarySourceProfile,request:PrimaryRequest,input:Parameters<typeof primarySourceOperation>[2]){
 primaryInterface(profile);return primarySourceOperation(profile,request,input);
}
