import Init
import Lean.Elab.Tactic.Omega

namespace Y5Total

inductive Ty where
  | int | nat | bool | prod (left right : Ty) | list (element : Ty)

abbrev Ty.Value : Ty → Type
  | .int => Int
  | .nat => Nat
  | .bool => Bool
  | .prod a b => a.Value × b.Value
  | .list a => List a.Value

def Ty.zero : (t : Ty) → t.Value
  | .int => 0
  | .nat => 0
  | .bool => false
  | .prod a b => (a.zero, b.zero)
  | .list _ => []

def Ty.zeroSteps : Ty → Nat
  | .prod a b => a.zeroSteps + b.zeroSteps + 1
  | _ => 1

abbrev Env : List Ty → Type
  | [] => Unit
  | t :: ts => t.Value × Env ts

inductive Var : List Ty → Ty → Type where
  | here : Var (t :: ts) t
  | there : Var ts t → Var (s :: ts) t

def Var.get : Var context t → Env context → t.Value
  | .here, e => e.1
  | .there v, e => v.get e.2

def Var.steps : Var context t → Nat
  | .here => 1
  | .there v => v.steps + 1

inductive Arithmetic where
  | add | sub | mul | min | max

def Arithmetic.steps : Arithmetic → Nat
  | .min | .max => 3
  | _ => 1

def Arithmetic.integer : Arithmetic → Int → Int → Int
  | .add, a, b => a + b
  | .sub, a, b => a - b
  | .mul, a, b => a * b
  | .min, a, b => if a ≤ b then a else b
  | .max, a, b => if a ≤ b then b else a

def Arithmetic.natural : Arithmetic → Nat → Nat → Nat
  | .add, a, b => a + b
  | .sub, a, b => a - b
  | .mul, a, b => a * b
  | .min, a, b => if a ≤ b then a else b
  | .max, a, b => if a ≤ b then b else a

inductive Comparison where
  | le | lt | eq

def Comparison.integer : Comparison → Int → Int → Bool
  | .le, a, b => decide (a ≤ b)
  | .lt, a, b => decide (a < b)
  | .eq, a, b => decide (a = b)

def Comparison.natural : Comparison → Nat → Nat → Bool
  | .le, a, b => decide (a ≤ b)
  | .lt, a, b => decide (a < b)
  | .eq, a, b => decide (a = b)

inductive BooleanOp where
  | and | or

def BooleanOp.eval : BooleanOp → Bool → Bool → Bool
  | .and, a, b => a && b
  | .or, a, b => a || b

inductive Expr : List Ty → Ty → Type where
  | var : Var context t → Expr context t
  | intLit : Int → Expr context .int
  | natLit : Nat → Expr context .nat
  | boolLit : Bool → Expr context .bool
  | intBin : Arithmetic → Expr context .int → Expr context .int → Expr context .int
  | natBin : Arithmetic → Expr context .nat → Expr context .nat → Expr context .nat
  | intCmp : Comparison → Expr context .int → Expr context .int → Expr context .bool
  | natCmp : Comparison → Expr context .nat → Expr context .nat → Expr context .bool
  | boolEq : Expr context .bool → Expr context .bool → Expr context .bool
  | boolBin : BooleanOp → Expr context .bool → Expr context .bool → Expr context .bool
  | not : Expr context .bool → Expr context .bool
  | pair : Expr context a → Expr context b → Expr context (.prod a b)
  | fst : Expr context (.prod a b) → Expr context a
  | snd : Expr context (.prod a b) → Expr context b
  | nil (element : Ty) : Expr context (.list element)
  | cons : Expr context t → Expr context (.list t) → Expr context (.list t)
  | head : Expr context (.list t) → Expr context t
  | tail : Expr context (.list t) → Expr context (.list t)
  | length : Expr context (.list t) → Expr context .nat
  | isEmpty : Expr context (.list t) → Expr context .bool
  | ite : Expr context .bool → Expr context t → Expr context t → Expr context t

namespace Expr
@[simp] def intAdd (a b : Expr context .int) := intBin .add a b
-- The aliases keep the closed external grammar independent of constructor layout.
@[simp] def intSub (a b : Expr context .int) := intBin .sub a b
@[simp] def intMul (a b : Expr context .int) := intBin .mul a b
@[simp] def intMin (a b : Expr context .int) := intBin .min a b
@[simp] def intMax (a b : Expr context .int) := intBin .max a b
@[simp] def natAdd (a b : Expr context .nat) := natBin .add a b
@[simp] def natSub (a b : Expr context .nat) := natBin .sub a b
@[simp] def natMul (a b : Expr context .nat) := natBin .mul a b
@[simp] def natMin (a b : Expr context .nat) := natBin .min a b
@[simp] def natMax (a b : Expr context .nat) := natBin .max a b
@[simp] def intLE (a b : Expr context .int) := intCmp .le a b
@[simp] def intLT (a b : Expr context .int) := intCmp .lt a b
@[simp] def intEq (a b : Expr context .int) := intCmp .eq a b
@[simp] def natLE (a b : Expr context .nat) := natCmp .le a b
@[simp] def natLT (a b : Expr context .nat) := natCmp .lt a b
@[simp] def natEq (a b : Expr context .nat) := natCmp .eq a b
@[simp] def and (a b : Expr context .bool) := boolBin .and a b
@[simp] def or (a b : Expr context .bool) := boolBin .or a b
end Expr

def eval : Expr context t → Env context → t.Value
  | .var v, e => v.get e
  | .intLit v, _ => v
  | .natLit v, _ => v
  | .boolLit v, _ => v
  | .intBin op a b, e => op.integer (eval a e) (eval b e)
  | .natBin op a b, e => op.natural (eval a e) (eval b e)
  | .intCmp op a b, e => op.integer (eval a e) (eval b e)
  | .natCmp op a b, e => op.natural (eval a e) (eval b e)
  | .boolEq a b, e => decide (eval a e = eval b e)
  | .boolBin op a b, e => op.eval (eval a e) (eval b e)
  | .not a, e => !(eval a e)
  | .pair a b, e => (eval a e, eval b e)
  | .fst a, e => (eval a e).1
  | .snd a, e => (eval a e).2
  | .nil _, _ => []
  | .cons a b, e => eval a e :: eval b e
  | @Expr.head _ t a, e => (eval a e).headD t.zero
  | .tail a, e => (eval a e).tail
  | .length a, e => (eval a e).length
  | .isEmpty a, e => (eval a e).isEmpty
  | .ite c a b, e => if eval c e then eval a e else eval b e

def lengthCounted {a : Type} : List a → Nat × Nat
  | [] => (0, 1)
  | _ :: xs => let r := lengthCounted xs; (r.1 + 1, r.2 + 1)

theorem lengthCounted_value {a : Type} (xs : List a) :
    (lengthCounted xs).1 = xs.length := by
  induction xs <;> simp_all [lengthCounted]

def counted : Expr context t → Env context → t.Value × Nat
  | .var v, e => (v.get e, v.steps + 1)
  | .intLit v, _ => (v, 1)
  | .natLit v, _ => (v, 1)
  | .boolLit v, _ => (v, 1)
  | .intBin op a b, e =>
    let x := counted a e; let y := counted b e
    (op.integer x.1 y.1, x.2 + y.2 + op.steps)
  | .natBin op a b, e =>
    let x := counted a e; let y := counted b e
    (op.natural x.1 y.1, x.2 + y.2 + op.steps)
  | .intCmp op a b, e =>
    let x := counted a e; let y := counted b e
    (op.integer x.1 y.1, x.2 + y.2 + 1)
  | .natCmp op a b, e =>
    let x := counted a e; let y := counted b e
    (op.natural x.1 y.1, x.2 + y.2 + 1)
  | .boolEq a b, e =>
    let x := counted a e; let y := counted b e
    (decide (x.1 = y.1), x.2 + y.2 + 1)
  | .boolBin op a b, e =>
    let x := counted a e; let y := counted b e
    (op.eval x.1 y.1, x.2 + y.2 + 1)
  | .not a, e => let x := counted a e; (!x.1, x.2 + 1)
  | .pair a b, e =>
    let x := counted a e; let y := counted b e
    ((x.1, y.1), x.2 + y.2 + 1)
  | .fst a, e => let x := counted a e; (x.1.1, x.2 + 1)
  | .snd a, e => let x := counted a e; (x.1.2, x.2 + 1)
  | .nil _, _ => ([], 1)
  | .cons a b, e =>
    let x := counted a e; let y := counted b e
    (x.1 :: y.1, x.2 + y.2 + 1)
  | @Expr.head _ t a, e =>
    let x := counted a e; (x.1.headD t.zero, x.2 + t.zeroSteps + 1)
  | .tail a, e => let x := counted a e; (x.1.tail, x.2 + 1)
  | .length a, e =>
    let x := counted a e; let n := lengthCounted x.1
    (n.1, x.2 + n.2 + 1)
  | .isEmpty a, e => let x := counted a e; (x.1.isEmpty, x.2 + 1)
  | .ite c a b, e =>
    let x := counted c e
    if x.1 then let y := counted a e; (y.1, x.2 + y.2 + 1)
    else let y := counted b e; (y.1, x.2 + y.2 + 1)

theorem counted_value (a : Expr context t) (e : Env context) :
    (counted a e).1 = eval a e := by
  induction a <;> simp_all [counted, eval, lengthCounted_value]
  all_goals first | rfl | (split <;> simp_all)

def constantCost : Expr context t → Bool
  | .intBin _ a b | .natBin _ a b | .intCmp _ a b | .natCmp _ a b
  | .boolEq a b | .boolBin _ a b | .pair a b | .cons a b =>
    constantCost a && constantCost b
  | .not a | .fst a | .snd a | .head a | .tail a | .isEmpty a => constantCost a
  | .length _ => false
  | .ite c a b => constantCost c && constantCost a && constantCost b
  | _ => true

def nodeBound : Expr context t → Nat
  | .var v => v.steps + 1
  | .intBin op a b | .natBin op a b => nodeBound a + nodeBound b + op.steps
  | .intCmp _ a b | .natCmp _ a b
  | .boolEq a b | .boolBin _ a b | .pair a b | .cons a b =>
    nodeBound a + nodeBound b + 1
  | @Expr.head _ t a => nodeBound a + t.zeroSteps + 1
  | .not a | .fst a | .snd a | .tail a | .length a | .isEmpty a => nodeBound a + 1
  | .ite c a b => nodeBound c + nodeBound a + nodeBound b + 1
  | _ => 1

theorem counted_bound (a : Expr context t) (e : Env context)
    (h : constantCost a = true) : (counted a e).2 ≤ nodeBound a := by
  induction a <;> simp_all [constantCost, counted, nodeBound, Bool.and_eq_true]
  all_goals try omega
  all_goals split <;> simp_all <;> omega

structure Program where
  stateType : Ty
  initial : Expr [] stateType
  step : Expr [.int, stateType] stateType
  result : Expr [stateType] .int

def runState (p : Program) : List Int → p.stateType.Value
  | [] => eval p.initial ()
  | x :: xs => eval p.step (x, runState p xs, ())

def denote (p : Program) (xs : List Int) : Int :=
  eval p.result (runState p xs, ())

def runCounted (p : Program) : List Int → p.stateType.Value × Nat
  | [] => let v := counted p.initial (); (v.1, v.2 + 1)
  | x :: xs =>
    let tail := runCounted p xs
    let step := counted p.step (x, tail.1, ())
    (step.1, tail.2 + step.2 + 1)

def executeCounted (p : Program) (xs : List Int) : Int × Nat :=
  let state := runCounted p xs
  let result := counted p.result (state.1, ())
  (result.1, state.2 + result.2 + 1)

theorem runCounted_value (p : Program) (xs : List Int) :
    (runCounted p xs).1 = runState p xs := by
  induction xs <;> simp_all [runCounted, runState, counted_value]

theorem executeCounted_value (p : Program) (xs : List Int) :
    (executeCounted p xs).1 = denote p xs := by
  simp [executeCounted, denote, counted_value, runCounted_value]

theorem runCounted_bound (p : Program) (hi : constantCost p.initial = true)
    (hs : constantCost p.step = true) (xs : List Int) :
    (runCounted p xs).2 ≤ (nodeBound p.step + 1) * xs.length + nodeBound p.initial + 1 := by
  induction xs with
  | nil =>
    have h := counted_bound p.initial () hi
    simp only [runCounted, List.length_nil, Nat.mul_zero]
    omega
  | cons x xs ih =>
    have h := counted_bound p.step (x, (runCounted p xs).1, ()) hs
    simp only [runCounted, List.length_cons, Nat.mul_succ]
    omega

theorem executeCounted_bound (p : Program) (hi : constantCost p.initial = true)
    (hs : constantCost p.step = true) (hr : constantCost p.result = true) (xs : List Int) :
    (executeCounted p xs).2 ≤ (nodeBound p.step + 1) * xs.length +
      (nodeBound p.initial + nodeBound p.result + 2) := by
  have a := runCounted_bound p hi hs xs
  have b := counted_bound p.result ((runCounted p xs).1, ()) hr
  simp only [executeCounted]
  omega

structure Meaning where
  safe : Expr [.int] .bool
  advance : Expr [.int, .int] .int

def follow (s : Meaning) : List Int → Int → Int
  | [], c => c
  | x :: xs, c => follow s xs (eval s.advance (x, c, ()))

def integerSum : List Int → Int
  | [] => 0
  | x :: xs => x + integerSum xs

def additiveMeaning (safe : Expr [.int] .bool) : Meaning :=
  { safe, advance := .intAdd (.var .here) (.var (.there .here)) }

theorem follow_additive (safe : Expr [.int] .bool) (xs : List Int) (c : Int) :
    follow (additiveMeaning safe) xs c = c + integerSum xs := by
  induction xs generalizing c with
  | nil => simp [follow, integerSum]
  | cons x xs ih =>
    change follow (additiveMeaning safe) xs (x + c) = c + integerSum (x :: xs)
    rw [ih]
    simp only [integerSum]
    omega

def Feasible (s : Meaning) : List Int → Int → Prop
  | [], c => eval s.safe (c, ()) = true
  | x :: xs, c => eval s.safe (c, ()) = true ∧ Feasible s xs (eval s.advance (x, c, ()))

def PrefixFeasible (s : Meaning) (xs : List Int) (c : Int) : Prop :=
  ∀ k, k ≤ xs.length → eval s.safe (follow s (xs.take k) c, ()) = true

theorem feasible_iff_prefix (s : Meaning) (xs : List Int) (c : Int) :
    Feasible s xs c ↔ PrefixFeasible s xs c := by
  induction xs generalizing c with
  | nil =>
    constructor
    · intro h k hk
      have : k = 0 := by simpa using hk
      subst k
      exact h
    · intro h
      exact h 0 (by simp)
  | cons x xs ih =>
    constructor
    · intro h k hk
      cases k with
      | zero => exact h.1
      | succ k =>
        change eval s.safe (follow s (xs.take k) (eval s.advance (x, c, ())), ()) = true
        exact (ih _).mp h.2 k (by simpa using hk)
    · intro h
      constructor
      · exact h 0 (by simp)
      · apply (ih _).mpr
        intro k hk
        have hp := h (k + 1) (by simpa using Nat.succ_le_succ hk)
        exact hp

def Optimal (s : Meaning) (xs : List Int) (r : Int) : Prop :=
  PrefixFeasible s xs r ∧ ∀ c, PrefixFeasible s xs c → r ≤ c

def UniformStatement (s : Meaning) (p : Program) : Prop :=
  ∀ xs, Optimal s xs (denote p xs)

def AdditivePrefixFeasible (safe : Expr [.int] .bool) (xs : List Int) (c : Int) : Prop :=
  ∀ k, k ≤ xs.length → eval safe (c + integerSum (xs.take k), ()) = true

theorem additive_prefix_equivalence (safe : Expr [.int] .bool) (xs : List Int) (c : Int) :
    PrefixFeasible (additiveMeaning safe) xs c ↔ AdditivePrefixFeasible safe xs c := by
  change (∀ k, k ≤ xs.length → eval safe (follow (additiveMeaning safe) (xs.take k) c, ()) = true) ↔ _
  simp only [follow_additive, AdditivePrefixFeasible]

def AdditiveOptimal (safe : Expr [.int] .bool) (xs : List Int) (r : Int) : Prop :=
  AdditivePrefixFeasible safe xs r ∧ ∀ c, AdditivePrefixFeasible safe xs c → r ≤ c

theorem uniform_additive_equivalence (safe : Expr [.int] .bool) (p : Program) :
    UniformStatement (additiveMeaning safe) p ↔ ∀ xs, AdditiveOptimal safe xs (denote p xs) := by
  simp only [UniformStatement, Optimal, AdditiveOptimal, additive_prefix_equivalence]

inductive Term where
  | initial | output | integer (value : Int)

def Term.denote (p : Program) (xs : List Int) (c : Int) : Term → Int
  | .initial => c
  | .output => Y5Total.denote p xs
  | .integer v => v

inductive Formula where
  | truth | falsity
  | feasible (arg : Term) | safe (arg : Term)
  | le (left right : Term) | lt (left right : Term) | eq (left right : Term)
  | not (arg : Formula)
  | and (left right : Formula) | or (left right : Formula)
  | implies (left right : Formula) | iff (left right : Formula)

def Formula.denote (s : Meaning) (p : Program) (xs : List Int) (c : Int) : Formula → Prop
  | .truth => True
  | .falsity => False
  | .feasible t => Feasible s xs (t.denote p xs c)
  | .safe t => eval s.safe (t.denote p xs c, ()) = true
  | .le a b => a.denote p xs c ≤ b.denote p xs c
  | .lt a b => a.denote p xs c < b.denote p xs c
  | .eq a b => a.denote p xs c = b.denote p xs c
  | .not a => ¬ a.denote s p xs c
  | .and a b => a.denote s p xs c ∧ b.denote s p xs c
  | .or a b => a.denote s p xs c ∨ b.denote s p xs c
  | .implies a b => a.denote s p xs c → b.denote s p xs c
  | .iff a b => a.denote s p xs c ↔ b.denote s p xs c

end Y5Total
