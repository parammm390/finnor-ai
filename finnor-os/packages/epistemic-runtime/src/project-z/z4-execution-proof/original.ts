/** Original integer meaning. No field arithmetic, compiler plan or prover call. */
import {checked64,fail,validateRequest,type Operand,type ExactRequest} from './contracts';
export interface OriginalResult {finalState:string[];steps:number;instructionEvaluations:number;wallMs:number}
export function originalExecution(raw:unknown):OriginalResult {
 const started=performance.now(),r:ExactRequest=validateRequest(raw),state=r.initial.map(BigInt);
 let count=0;
 const read=(o:Operand,row:bigint[]):bigint=>'const'in o?BigInt(o.const):'reg'in o?state[o.reg]!:row[o.input]!;
 for(const values of r.inputs){
  const row=values.map(BigInt);
  for(const i of r.program.instructions){
   const a=read(i.a,row),b=read(i.b,row);
   let result:bigint;
   switch(i.op){
    case 'add':result=a+b;break;
    case 'sub':result=a-b;break;
    case 'mul':result=a*b;break;
    case 'lt':result=a<b?1n:0n;break;
    case 'eq':result=a===b?1n:0n;break;
    case 'select':{
     const c=read(i.c!,row);if(c!==0n&&c!==1n)fail('Z4_BOOLEAN_SELECT_REQUIRED');
     result=c===1n?a:b;break;
    }
   }
   checked64(result);state[i.dst]=result;count++;
  }
 }
 return {finalState:state.map(String),steps:r.inputs.length,instructionEvaluations:count,wallMs:performance.now()-started};
}
