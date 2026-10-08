import type {ExperimentRef} from '@finnor/shared-types';
import {m3Ref,m3Hash,type CapitalProgramV2Pending,type CapitalProgramV2Request} from './v2-contracts';
export function capitalPendingRequests(request:CapitalProgramV2Request,targets:ExperimentRef[],deadlineAt:string|null,
 remaining:CapitalProgramV2Request['resource']):CapitalProgramV2Pending[]{
 const definitions:Array<Pick<CapitalProgramV2Pending,'owner'|'requiredSchema'|'domain'|'reason'>>=[
  {owner:'M4',requiredSchema:'ChallengeResult/original-M4-v1',domain:'Exact emitted economic module, all changed terms, full histories/resources and model-relative value',
   reason:'The original M4 port is callable. This programme still needs its own current ChallengeResult and complete claim-domain coverage; no-witness is not SAFE or independent admission.'},
  {owner:'M2',requiredSchema:'DeliberationPolicy/original-M2-v1',domain:'Same original mandate/risk and attenuated episode resource; no marginal-computation value asserted',
   reason:'Authentic M2 is not present. Fixed finite native term/structure order is not an adaptive scheduler.'},
  {owner:'P1',requiredSchema:'HarnessProgram/economic-constructor-execution-port',domain:'Typed M3 pure constructor, exact input/module/compiler/domain and attenuated resources',
   reason:'Committed P1 scalar source DSL exposes no compatible authenticated economic-module execution port. M3 native Seatbelt execution is not a HarnessProgram join.'},
  {owner:'P3',requiredSchema:'BranchFabric/economic-module-isolated-branch-port',domain:'Credential-free exact constructor, real supported process isolation and checkpoint/remaining grant',
   reason:'Committed P3 exposes no P1/M3 execution transport; no P3 branch, aggregate quota or admitted runtime is fabricated.'},
 ];
 return definitions.map(definition=>{
  const body={schema:'finnor.m3.pending-request.v2' as const,...definition,target:targets,inputDigest:m3Hash(request),
   remaining,deadlineAt,status:'PENDING_DEPENDENCY' as const,executionAuthorityGranted:false as const};
  return {...body,ref:m3Ref('pending-owner-request',body)};
 });
}
