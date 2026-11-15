import {z} from 'zod';
import {LedgerFault} from '../../../governed-execution/src/protocol';
import {digest as byteDigest} from '../../../governed-execution/src/canonical';
import type {UniformDecisionExpression,UniformProofPlan} from '../../../shared-types/src/algorithm-theory';

/** Byte-identical to governed-execution `canonical`, whose 100000-node ledger bound is below the
 * 1000000-node bound that parseTotalCapsule admits; every admitted capsule and owner census must be digestible. */
function canonicalJson(value:unknown):string{
 let nodes=0;const parts:string[]=[];
 const encode=(v:unknown,depth:number):void=>{
  if(++nodes>1000000||depth>64)throw new LedgerFault(413,'JSON_COMPLEXITY_LIMIT');
  if(v===null){parts.push('null');return;}
  if(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){parts.push(JSON.stringify(v));return;}
  if(Array.isArray(v)){
   parts.push('[');
   for(let i=0,length=v.length;i<length;i++){if(i)parts.push(',');if(i in v)encode(v[i],depth+1);}
   parts.push(']');return;
  }
  if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)){
   const record=v as Record<string,unknown>,keys=Object.keys(record).sort((a,b)=>a.localeCompare(b));
   parts.push('{');
   for(let i=0;i<keys.length;i++){if(i)parts.push(',');const key=keys[i]!;parts.push(JSON.stringify(key),':');encode(record[key],depth+1);}
   parts.push('}');return;
  }
  throw new LedgerFault(400,'NON_CANONICAL_JSON');
 };
 encode(value,0);return parts.join('');
}
export const hash=(value:string|Buffer)=>byteDigest(value);
export const jsonHash=(value:unknown)=>hash(canonicalJson(JSON.parse(JSON.stringify(value))));
export const expressionSchema:z.ZodType<UniformDecisionExpression>=z.lazy(()=>z.union([
 z.object({op:z.enum(['FALSE','TRUE','NEGATIVE','NONPOSITIVE','POSITIVE','NONNEGATIVE'])}).strict(),
 z.object({op:z.literal('NOT'),arg:expressionSchema}).strict(),
]));
export function expressionSize(e:UniformDecisionExpression):number{return e.op==='NOT'?1+expressionSize(e.arg):1;}
export function parseExpression(value:unknown){
 if(Buffer.byteLength(JSON.stringify(value))>2048)throw Error('Y5_SYNTAX_BOUND');
 const e=expressionSchema.parse(value);if(expressionSize(e)>4)throw Error('Y5_SYNTAX_BOUND');return e;
}
export function evaluateExpression(e:UniformDecisionExpression,w:bigint):boolean{
 switch(e.op){
  case 'FALSE':return false;case 'TRUE':return true;case 'NEGATIVE':return w<0n;
  case 'NONPOSITIVE':return w<=0n;case 'POSITIVE':return w>0n;case 'NONNEGATIVE':return w>=0n;
  case 'NOT':return !evaluateExpression(e.arg,w);
 }
}
export function expressionText(e:UniformDecisionExpression):string{
 switch(e.op){
  case 'FALSE':return 'false';case 'TRUE':return 'true';
  case 'NEGATIVE':return 'decide (w < 0)';case 'NONPOSITIVE':return 'decide (w ≤ 0)';
  case 'POSITIVE':return 'decide (0 < w)';case 'NONNEGATIVE':return 'decide (0 ≤ w)';
  case 'NOT':return `!(${expressionText(e.arg)})`;
 }
}
export const localPlans=[
 'simp_all [LocalStatement, pay, decision]',
 'unfold LocalStatement; intros; grind [pay, decision]',
 'unfold LocalStatement; intro w b; cases b <;> simp_all [pay, decision] <;> split <;> omega',
] as const;
export const uniformPlans=[
 'unfold UniformStatement; intros; grind [feasible, value, run, decision, discovered_lemma]',
 'unfold UniformStatement; intro ws; induction ws <;> intros <;> grind [feasible, value, run, decision, discovered_lemma]',
 'unfold UniformStatement; intro ws; induction ws with | nil => intro bs; cases bs <;> simp_all [feasible, value, run, decision] | cons w ws ih => intro bs; cases bs <;> simp_all [feasible, value, run, decision] <;> grind [LocalStatement, discovered_lemma, pay, decision]',
] as const;
export const expectedStatement='Y5.UniformStatement Y5.decision';
export function renderCandidate(value:UniformDecisionExpression,plan:UniformProofPlan,localOnly=false):string{
 const e=parseExpression(value);
 if(!Number.isInteger(plan.local)||!localPlans[plan.local]||!Number.isInteger(plan.uniform)||!uniformPlans[plan.uniform])throw Error('Y5_PROOF_GRAMMAR');
 return `import Specification\nimport Lean.Elab.Tactic.Grind\nimport Lean.Elab.Tactic.Omega\nnamespace Y5\ndef decision (w : Int) : Bool := ${expressionText(e)}\ndef algorithm := run decision\ntheorem discovered_lemma : LocalStatement decision := by\n  ${localPlans[plan.local]}\n${localOnly?'':`theorem uniform : UniformStatement decision := by\n  ${uniformPlans[plan.uniform]}\n`}end Y5\n`;
}
export const inspectionSource=`import Candidate
example : Y5.UniformStatement Y5.decision := Y5.uniform
example : Y5.algorithm = Y5.run Y5.decision := rfl
example : Y5.feasible [] [] := True.intro
#print axioms Y5.uniform
#check Y5.uniform
`;
export const executionSource=`import Candidate
import Lean.Data.Json
def main (args : List String) : IO UInt32 := do
  let some path := args.head? | throw (IO.userError "Y5_INPUT_REQUIRED")
  let raw ← IO.FS.readFile path
  let json ← IO.ofExcept (Lean.Json.parse raw)
  let values ← IO.ofExcept json.getArr?
  let mut ws : List Int := []
  for item in values do
    let text ← IO.ofExcept item.getStr?
    let some w := text.toInt? | throw (IO.userError "Y5_EXACT_INTEGER_REQUIRED")
    ws := w :: ws
  let answer := Y5.algorithm ws.reverse
  let indices := answer.1.zipIdx |>.filterMap fun (b, i) => if b then some (Lean.toJson i) else none
  IO.println ((Lean.Json.mkObj [("selected", Lean.toJson indices), ("coordinateSteps", Lean.toJson answer.2)]).compress)
  return 0
`;
