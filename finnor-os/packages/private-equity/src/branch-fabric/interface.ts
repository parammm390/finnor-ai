import {fixedProcess} from './runtime';
import {parseProgrammeInterface} from '../program-synthesis/interface-contracts';
/** No credentials, target network, branch admission or business execution. */
export async function rehearseProgrammeInterface(input:unknown,signal:AbortSignal,options:{protectedExecution?:boolean;requiredAggregateLimits?:Record<string,number>}={}){
 if(options.protectedExecution)throw Error('P5_PROGRAMME_PROTECTED_REHEARSAL_UNADMITTED');
 if(options.requiredAggregateLimits&&Object.keys(options.requiredAggregateLimits).length)throw Error('P5_PROGRAMME_AGGREGATE_LIMITS_UNAVAILABLE');
 const module=parseProgrammeInterface(input);
 const execution=await fixedProcess('interface-worker.mts',module,signal,8000);
 if(execution.value.moduleDigest!==module.ref.contentDigest||execution.value.effectAuthority!==false)throw Error('P5_PROGRAMME_REHEARSAL_OUTPUT_BINDING');
 return {...execution,protectedEligible:false as const,qualification:'REGISTERED_P3_NATIVE_OUTER_S6_SEATBELT_PURE_CHILD_NOT_REHEARSAL_BRANCH_OR_BUSINESS_EFFECT'};
}
