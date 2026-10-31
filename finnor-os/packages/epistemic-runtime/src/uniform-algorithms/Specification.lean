import Init

/- Independently pinned definitions, not a successful lemma or proof script.
   A coordinate step treats exact integer predicate evaluation as a primitive.
   This deliberately makes no bit-complexity or physical resource claim. -/
namespace Y5

def pay (weight : Int) (chosen : Bool) : Int := if chosen then weight else 0

def feasible : List Int → List Bool → Prop
  | [], [] => True
  | _ :: ws, _ :: bs => feasible ws bs
  | _, _ => False

def value : List Int → List Bool → Int
  | w :: ws, b :: bs => pay w b + value ws bs
  | _, _ => 0

def run (decision : Int → Bool) : List Int → List Bool × Nat
  | [] => ([], 0)
  | w :: ws =>
    let tail := run decision ws
    (decision w :: tail.1, tail.2 + 1)

def LocalStatement (decision : Int → Bool) : Prop :=
  ∀ (w : Int) (b : Bool), pay w b ≤ pay w (decision w)

def UniformStatement (decision : Int → Bool) : Prop :=
  ∀ (ws : List Int) (bs : List Bool), feasible ws bs →
    feasible ws (run decision ws).1 ∧
    value ws bs ≤ value ws (run decision ws).1 ∧
    (run decision ws).2 = ws.length ∧
    decision 0 = false

end Y5
