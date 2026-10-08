import { z } from 'zod';
import type { PeMutationContext } from '../types';
import { assertBounded,ChallengeRequestSchema,DiagnosticRequestSchema,SearchIdSchema,SearchReadSchema,ReplaySchema,RepairSchema } from './contracts';
import { submitDiagnostic,submitChallenge,readDiagnostic,cancelDiagnostic,replayWitness,requestRepair,authorizedSearch } from './service';
import { purgeExpiredPayloads } from './store';
export const M4Operations={
  'challenge-submit':{schema:ChallengeRequestSchema,classification:'MUTATION'},
  'counterexample-diagnostic-submit':{schema:DiagnosticRequestSchema,classification:'MUTATION'},
  'counterexample-read':{schema:SearchReadSchema,classification:'READ'},
  'counterexample-currentness':{schema:SearchIdSchema,classification:'READ'},
  'counterexample-view':{schema:SearchReadSchema,classification:'READ'},
  'counterexample-ledger':{schema:SearchReadSchema,classification:'READ'},
  'counterexample-witness-replay':{schema:ReplaySchema,classification:'READ'},
  'counterexample-cancel':{schema:SearchIdSchema,classification:'CONTROL'},
  'counterexample-repair-request':{schema:RepairSchema,classification:'MUTATION'},
  'counterexample-retention-purge':{schema:SearchIdSchema,classification:'CONTROL'},
} as const satisfies Record<string,{schema:z.ZodTypeAny;classification:'READ'|'CONTROL'|'MUTATION'}>;
export const M4_OPERATIONS=new Set(Object.keys(M4Operations));
export async function handleCounterexampleOperation(ctx:PeMutationContext,operation:string,body:unknown):Promise<{status:number;body:unknown}>{
  assertBounded(body);
  switch(operation){
    case 'challenge-submit':return {status:202,body:await submitChallenge(ctx,body)};
    case 'counterexample-diagnostic-submit':return {status:202,body:await submitDiagnostic(ctx,body)};
    case 'counterexample-read':
    case 'counterexample-view':
    case 'counterexample-ledger':{
      const input=SearchReadSchema.parse(body);
      return {status:200,body:await readDiagnostic(ctx,input.searchId,operation==='counterexample-ledger',input.readMode)};
    }
    case 'counterexample-currentness':return {status:200,body:await readDiagnostic(ctx,SearchIdSchema.parse(body).searchId)};
    case 'counterexample-cancel':return {status:200,body:await cancelDiagnostic(ctx,SearchIdSchema.parse(body).searchId)};
    case 'counterexample-witness-replay':{
      const input=ReplaySchema.parse(body);return {status:200,body:await replayWitness(ctx,input.searchId,input.witnessRef)};
    }
    case 'counterexample-repair-request':{
      const input=RepairSchema.parse(body);return {status:202,body:await requestRepair(ctx,input.searchId,input.replacement)};
    }
    case 'counterexample-retention-purge':{
      const input=SearchIdSchema.parse(body);await authorizedSearch(ctx,input.searchId);
      return {status:200,body:await purgeExpiredPayloads(ctx)};
    }
    default:return {status:404,body:{code:'UNAVAILABLE',error:'Permitted challenge operation unavailable'}};
  }
}
