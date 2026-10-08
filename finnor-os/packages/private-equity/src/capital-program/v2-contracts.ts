import {epistemicHash} from '../../../epistemic-runtime/src/source-precedence';
import {CAPITAL_PROGRAM_V2_VERSION,type CapitalProgramV2Ref} from '@finnor/shared-types/src/capital-program';
export {CAPITAL_PROGRAM_V2_VERSION,CapitalProgramV2RequestSchema,CapitalProgramV2Operations} from '@finnor/shared-types/src/capital-program';
export type {CapitalProgramV2,CapitalProgramV2Candidate,CapitalProgramV2Request,CapitalProgramV2Ref,
  CapitalProgramV2Module,CapitalProgramV2Pending,CapitalProgramV2QueryView,CapitalProgramV2Status,CapitalProgramV2BranchReview,
  CapitalProgramV2AttemptCost} from '@finnor/shared-types/src/capital-program';
export class CapitalProgramV2Error extends Error {
  constructor(readonly code:'INVALID_REQUEST'|'UNAVAILABLE'|'STALE_INPUT'|'CONFLICT'|'LIMIT_EXCEEDED'|'CHECK_FAILED'|'CONFIGURATION_REQUIRED'|'BLOCKED_SELECTION',
    message:string){super(message);this.name='CapitalProgramV2Error';}
}
export const m3Unavailable=()=>new CapitalProgramV2Error('UNAVAILABLE','Permitted capital programme is unavailable');
export const m3Ref=(kind:string,value:unknown):CapitalProgramV2Ref=>{
  const contentDigest=epistemicHash(value);return {owner:'M3',id:`${kind}:${contentDigest}`,version:CAPITAL_PROGRAM_V2_VERSION,contentDigest};
};
export const m3Same=(a:unknown,b:unknown)=>epistemicHash(a)===epistemicHash(b);
export const m3Hash=epistemicHash;
export function m3Bounded(value:unknown,max=8*1024*1024):void{
  if(Buffer.byteLength(JSON.stringify(value))>max)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Capital programme byte grant exhausted');
}
export const m3Blocker=(code:string,owner:string,requirement:string)=>({code,owner,requirement});
