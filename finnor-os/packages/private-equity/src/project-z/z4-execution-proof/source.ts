/** This adapter proves an exact history subcomputation, never the FLOAT64 S3 solver. */
import {resolveEnterpriseInterventionModelForControl} from '../../enterprise-interventions';
import {readEnterpriseContingentPolicy} from '../../enterprise-control';
import {authorize,principal} from '../../owner-context';
import {validateRequest} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {sha,type Submit,type Intake} from './contracts';
import type {PeMutationContext} from '../../types';

export async function ownerSource(ctx:PeMutationContext,input:Submit|Intake){
 const rights=await authorize(ctx,input.root,'workId'in input?[{type:'work',id:input.workId}]:[]);
 const contract=input.ownerContract,model=await resolveEnterpriseInterventionModelForControl(ctx,contract.modelRef);
 if(model.tenantId!==ctx.auth.tenantId||model.principalId!==principal(ctx)||
  !model.request.roots.some(r=>sha(r)===sha(input.root)))throw Error('Z4_CURRENT_ORIGINAL_S3_ROOT_REQUIRED');
 if(contract.columns.some((column,i)=>{
  const definitions=column.kind==='STATE'?model.request.stateVariables:model.request.exposures;
  return !definitions.some(v=>v.id===column.variableId&&v.unit===column.unit)||input.program.inputUnits[i]!==column.unit;
 }))throw Error('Z4_NATIVE_VARIABLE_OR_UNIT_MISMATCH');
 const inputs=contract.periods.map(period=>{
  const row=model.history.rows.find(r=>r.period===period);
  if(!row)throw Error('Z4_NATIVE_HISTORY_PERIOD_UNAVAILABLE');
  return contract.columns.map(column=>{
   const n=(column.kind==='STATE'?row.states:row.exposures)[column.variableId];
   if(n===undefined||!Number.isSafeInteger(n)||Object.is(n,-0)||n<-(2**31)||n>=2**31)throw Error('Z4_UNSUPPORTED_NONEXACT_NATIVE_HISTORY');
   return String(n);
  });
 });
 validateRequest({program:input.program,initial:input.initial,inputs,binding:'0'.repeat(64)});
 const policy=contract.owner==='S4'?await readEnterpriseContingentPolicy(ctx,contract.policyRef):null;
 if(policy&&(policy.tenantId!==ctx.auth.tenantId||policy.principalId!==principal(ctx)||
  sha(policy.bindings.modelRef)!==sha(model.ref)||policy.episodeId!==model.request.episodeId))throw Error('Z4_ORIGINAL_S4_MODEL_MANDATE_MISMATCH');
 const rightsFingerprint=sha({tenant:ctx.auth.tenantId,principal:principal(ctx),revision:rights.revision,
  rightsRefs:model.beliefBindings.map(b=>b.rightsRef).sort(),pins:model.beliefBindings.map(b=>b.pin),permittedUse:'SAME_PRINCIPAL_LOCAL_ANALYTICAL_GUARD_ONLY'});
 const digest=sha({modelRef:model.ref,historyInputDigest:model.history.inputDigest,contract,inputs,
  beliefBindings:model.beliefBindings,policyRef:policy?.ref??null,mandate:policy?.mandateRef??null,rightsFingerprint});
 const rightsRef=policy?.mandate.rightsRef??model.beliefBindings[0]?.rightsRef;
 if(!rightsRef)throw Error('Z4_CANONICAL_S1_RIGHTS_REFERENCE_REQUIRED');
 return {inputs,digest,rightsFingerprint,rightsRef,rightsRevision:rights.revision,
  modelRef:model.ref,policyRef:policy?.ref??null,mandate:policy?.mandateRef??null,
  sourceRefs:model.history.rows.filter(r=>contract.periods.includes(r.period)).flatMap(r=>r.measurementRefs),
  limitations:['EXACT_RECORDED_INTEGER_HISTORY_GUARD_ONLY','S3_FLOAT64_MODEL_NOT_PROVED','SOURCE_TRUTH_CAUSALITY_AND_S8_ADMISSION_NOT_GRANTED']};
}
