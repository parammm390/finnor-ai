import type { Evaluation, FrozenDiagnostic, Proposal, Validation, ValidatedCounterexample } from './contracts';
export type ExtractedEffectEvaluation=Extract<Evaluation,{kind:'EFFECT_FIXTURE'}>;
export interface SearchExecution {
  signal:AbortSignal;
  debit(phase:string,body:unknown):Promise<void>;
  retain(kind:string,body:unknown):Promise<void>;
  validateCurrent(full?:boolean):Promise<void>;
  priorValidation(proposal:Proposal):Promise<Validation|null>;
  priorWitness(proposal:Proposal):Promise<ValidatedCounterexample|null>;
  repairProposals():Promise<Proposal[]>;
  witnessCapacity(proposal:Proposal):Promise<boolean>;
}
export type Frozen=FrozenDiagnostic;
