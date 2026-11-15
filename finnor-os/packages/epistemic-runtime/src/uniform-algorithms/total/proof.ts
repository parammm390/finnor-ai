import {readFile,stat} from 'node:fs/promises';
import type {TotalFamilyDefinition,TotalProgram,TotalProposition,TotalProofPlan,ResolvedTotalSpecification} from '../../../../shared-types/src/total-algorithm-theory';
import {jsonHash} from '../syntax';
import {grammar,renderProgram,renderDefinition,renderProposition,renderExpression,programOperationBound} from './syntax';
import {searchGrammar} from './search';

export {totalModelPath,installTotalModel} from './model-asset';
const reductions='proposition, Formula.denote, Term.denote, Feasible, meaning, program, denote, runState, eval, Var.get, Arithmetic.integer, Arithmetic.natural, Comparison.integer, Comparison.natural, BooleanOp.eval, Ty.Value, Env';
export const inductionPlans=[
 `intro xs
  induction xs with
  | nil =>
    intro c
    dsimp (config := {instances := true}) [${reductions}] at *
    simp_all
  | cons x xs ih =>
    intro c
    dsimp (config := {instances := true}) [${reductions}] at *
    simp_all
    all_goals split <;> omega`,
 `intro xs
  induction xs with
  | nil =>
    intro c
    dsimp (config := {instances := true}) [${reductions}] at *
    simp_all
  | cons x xs ih =>
    intro c
    dsimp (config := {instances := true}) [${reductions}] at *
    simp_all
    all_goals grind`,
] as const;
export const uniformPlans=[
 `intro xs
  constructor
  · apply (feasible_iff_prefix meaning xs _).mp
    have h := discovered_lemma xs (denote program xs)
    simp_all [proposition, Formula.denote, Term.denote]
  · intro c hc
    have h := discovered_lemma xs c
    have hf := (feasible_iff_prefix meaning xs c).mpr hc
    simp_all [proposition, Formula.denote, Term.denote]`,
] as const;
export const totalGrammarDigest=jsonHash({grammar,searchGrammar,inductionPlans,uniformPlans,renderer:'CLOSED_OWNER_PREFIX_UNIFORM_V2_1'});
export const expectedTotalStatement='Y5Total.UniformStatement Y5Total.meaning Y5Total.program';
export function renderTotalCandidate(definition:TotalFamilyDefinition,program:TotalProgram,formula:TotalProposition,plan:TotalProofPlan,lemmaOnly=false){
 if(!Number.isInteger(plan.induction)||!inductionPlans[plan.induction]||!Number.isInteger(plan.uniform)||!uniformPlans[plan.uniform])throw Error('Y5_TOTAL_PROOF_GRAMMAR');
 const bound=programOperationBound(program);
 return `import Total
import Lean.Elab.Tactic.Grind
import Lean.Elab.Tactic.Omega
namespace Y5Total
def meaning : Meaning := ${renderDefinition(definition)}
def program : Program := ${renderProgram(program)}
def proposition : Formula := ${renderProposition(formula)}
theorem discovered_lemma : ∀ (xs : List Int) (c : Int), Formula.denote meaning program xs c proposition := by
  ${inductionPlans[plan.induction]}
${lemmaOnly?'':`theorem uniform : UniformStatement meaning program := by
  ${uniformPlans[plan.uniform]}
theorem counted_correspondence (xs : List Int) :
    (executeCounted program xs).1 = denote program xs := executeCounted_value program xs
theorem operation_bound (xs : List Int) :
    (executeCounted program xs).2 ≤ ${bound.coefficient} * xs.length + ${bound.constant} := by
  have h := executeCounted_bound program (by rfl) (by rfl) (by rfl) xs
  simpa [program, nodeBound, Var.steps, Arithmetic.steps] using h
theorem feasible_every_input (xs : List Int) : Feasible meaning xs (denote program xs) :=
  (feasible_iff_prefix meaning xs _).mpr (uniform xs).1
theorem sized_nonempty (n : Nat) :
    ∃ xs : List Int, xs.length = n ∧ Feasible meaning xs (denote program xs) := by
  exact ⟨List.replicate n 0, by simp, feasible_every_input _⟩
`}end Y5Total
`;
}
export async function boundedObject(path:string){
 const size=(await stat(path)).size;if(size<=0||size>16777216)throw Error('Y5_TOTAL_PROOF_OBJECT_BOUND');
 return readFile(path);
}
export function totalInspectionSource(expected:ResolvedTotalSpecification,program:TotalProgram,formula:TotalProposition){
 const bound=programOperationBound(program);
 const additiveAdvance={op:'ADD',left:{op:'VAR',index:0},right:{op:'VAR',index:1}},
  safe=renderExpression(expected.definition.safe,['INT']);
 const additiveTarget=jsonHash(expected.definition.advance)===jsonHash(additiveAdvance)?`
example : Y5Total.meaning = Y5Total.additiveMeaning (${safe}) := rfl
example : ∀ xs, Y5Total.AdditiveOptimal (${safe}) xs (Y5Total.denote Y5Total.program xs) :=
  (Y5Total.uniform_additive_equivalence _ _).mp Y5Total.uniform
`:'';
 return `import Candidate
example : Y5Total.meaning = (${renderDefinition(expected.definition)} : Y5Total.Meaning) := rfl
example : Y5Total.program = (${renderProgram(program)} : Y5Total.Program) := rfl
example : Y5Total.proposition = (${renderProposition(formula)} : Y5Total.Formula) := rfl
example : ${expectedTotalStatement} := Y5Total.uniform
example (xs : List Int) : (Y5Total.executeCounted Y5Total.program xs).1 = Y5Total.denote Y5Total.program xs :=
  Y5Total.counted_correspondence xs
example (xs : List Int) : (Y5Total.executeCounted Y5Total.program xs).2 ≤ ${bound.coefficient} * xs.length + ${bound.constant} :=
  Y5Total.operation_bound xs
example (xs : List Int) : Y5Total.Feasible Y5Total.meaning xs (Y5Total.denote Y5Total.program xs) :=
  Y5Total.feasible_every_input xs
example (n : Nat) : ∃ xs : List Int, xs.length = n ∧ Y5Total.Feasible Y5Total.meaning xs (Y5Total.denote Y5Total.program xs) :=
  Y5Total.sized_nonempty n
example (xs : List Int) (c : Int) : Y5Total.Feasible Y5Total.meaning xs c ↔ Y5Total.PrefixFeasible Y5Total.meaning xs c :=
  Y5Total.feasible_iff_prefix _ _ _
${additiveTarget}
set_option pp.proofs true in
#print Y5Total.uniform
#print axioms Y5Total.uniform
#print axioms Y5Total.counted_correspondence
#print axioms Y5Total.operation_bound
#print axioms Y5Total.sized_nonempty
#print axioms Y5Total.uniform_additive_equivalence
#check Y5Total.uniform
run_cmd do
  let environment ← Lean.getEnv
  for name in environment.header.moduleNames do
    Lean.logInfo m!"Y5_TOTAL_IMPORT:{name}"
`;
}
export const totalExecutionSource=`import Candidate
import Lean.Data.Json
def main (args : List String) : IO UInt32 := do
  let some path := args.head? | throw (IO.userError "Y5_INPUT_REQUIRED")
  let raw ← IO.FS.readFile path
  let json ← IO.ofExcept (Lean.Json.parse raw)
  let inputs ← IO.ofExcept json.getArr?
  let mut outputs : Array Lean.Json := #[]
  for input in inputs do
    let values ← IO.ofExcept input.getArr?
    let mut xs : List Int := []
    for value in values do
      let text ← IO.ofExcept value.getStr?
      let some x := text.toInt? | throw (IO.userError "Y5_EXACT_INTEGER_REQUIRED")
      xs := x :: xs
    let result := Y5Total.executeCounted Y5Total.program xs.reverse
    outputs := outputs.push (Lean.Json.mkObj [("value", Lean.toJson (toString result.1)), ("operations", Lean.toJson result.2)])
  IO.println ((Lean.Json.arr outputs).compress)
  return 0
`;
