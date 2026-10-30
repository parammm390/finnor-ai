import {z} from 'zod';
import type {PlanningSnapshotCapability} from '@finnor/planning';
import {RefSchema,QuantityValue,ordinaryDisposableEconomicRuntime,type EconomicRef,type State} from '../economic-action-theory/contracts';

export const ECONOMIC_NATIVE_ACTION='execute_economic_right_transition';
export interface EconomicStep {operatorId:string;parameters:State;before:State;after:State}
export const EconomicNativeIntent=z.object({
 theoryRef:RefSchema,programmeId:z.string().uuid(),stepIndex:z.number().int().min(0).max(15),
 operatorId:z.string().min(1).max(80),parameters:z.record(QuantityValue),reservationRef:RefSchema,
 before:z.record(QuantityValue),after:z.record(QuantityValue),
}).strict();
export function economicStepIntent(theoryRef:EconomicRef,programmeId:string,reservationRef:EconomicRef,index:number,step:EconomicStep){
 return EconomicNativeIntent.parse({theoryRef,programmeId,reservationRef,stepIndex:index,
  operatorId:step.operatorId,parameters:step.parameters,before:step.before,after:step.after});
}
/** This registered native owner capability is not a generic planner/plugin
 * opcode. Only the physically fenced Y1 job can materialize or execute it. */
export function economicNativeCapability():PlanningSnapshotCapability{
 const available=ordinaryDisposableEconomicRuntime();
 return {capability:ECONOMIC_NATIVE_ACTION,kind:'action',modelProposable:false,available,
  health:available?'available':'unavailable',risk:'medium',irreversible:false,
  requiredReferences:['theoryRef','programmeId','reservationRef'],effectClass:'INTERNAL_WRITE',
  observationStrategy:'business_effect',reversibility:'compensatable',supportedRecoveryModes:['recover','escalate'],
  externalSideEffect:false,authorityRequirement:'policy'};
}
