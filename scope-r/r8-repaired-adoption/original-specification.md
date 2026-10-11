# R8 specification, frozen before implementation

Authority: issued R8 goal, SHA256 `b813cc260c3fde8c4570060a08d0ae332a20dc7646a6b3bb20dee6bcba4ea254`.
Standalone base: commit `517003a4396bc8101a90be4b425ee01de9446740`, tree `07ba69b8e96f05944c2f9f14a74b2c400eb89e42`.

## Exact development profile

Name: `r8-three-optional-projects-integer-v1`.
Input order: `[c1,c2,c3,v1,v2,v3]`. JSON integers mean mathematical integers, not measurements with invented precision.
Each coordinate independently ranges from zero through seven. Index is
`c1*8^5+c2*8^4+c3*8^3+v1*8^2+v2*8+v3`.
There are 262,144 inputs. Output is an integer mask 0 through 7; bit `i` names the project at immutable position `i`.

For each input the independent reference evaluates all eight masks, including empty.
Cost is the sum of selected costs; feasibility is cost at most seven.
Objective is the sum of selected supplied utilities, without deducting cost again.
The reference retains the complete maximizing feasible mask set.
The required output is its smallest mask. This is a **new named development tie rule**, not an inherited FINNOR convention.
Inspection of main's S5 canonical checker found exact objective certification, but no selected-mask tie prescription.
An owner with another rule is outside this profile.

Acceptance is the conjunction of:

1. Independent structural grammar, integer-growth and termination checks.
2. Original nonempty domain and original complete eight-mask reference.
3. Exactly-once contiguous canonical-index coverage with coordinate round-trip.
4. Independent AST interpreter termination within fuel, legal output, feasibility, zero exact gap and minimum-mask tie.
5. Actual registered P1 emitted-byte execution equals that interpreter and reference on every input.
6. Immutable AST/IR/emitted/compiler/library/runtime/specification/grammar/checker correspondence.

No SAT/UNSAT/model/hash/signature alone establishes this predicate.
Interrupted coverage is INCOMPLETE. Grammar UNSAT is not allocation infeasibility.
No receipt manufactures causal identification, prediction calibration, field-economic truth, domain qualification or protected admission.

## Original owner projection

Inputs are resolved from authenticated current S4 policies and the complete current S5 resource/outstanding snapshot, not a private numerical form.
Require exactly three distinct optional policies in immutable supplied order, one action period, one complete declared additive joint world, zero base value, supplied integer singleton utility terms 0…7 and no interaction term.
Require one explicit resource/demand dimension, identical units and time basis, remaining capacity exactly seven **after** safety margin, existing use and every outstanding envelope.
Costs must be lossless supplied action-resource integers 0…7, not rounded fitted coefficients. Explicit zero demand remains legal.
Tail liabilities, additional funding/human requirements, unknown outcomes, competing selected-policy commitments, observations, nontrivial choice constraints and extra resource dimensions are unsupported.

The adapter independently evaluates all eight original canonical selections. Their feasibility must equal the profile's and every feasible objective must equal its supplied sum. This checks mandate, risk, covenant and branch premises rather than silently discarding them. Original policy IDs remain the output identities.
Changes within D can reuse the abstract theorem only with fresh current owner bindings. Work/resource/rights/method changes fence invocation, not erase historical mathematics.
The existing S5 full producer followed by its canonical checker is the ordinary compatible fallback. It shares the original episode/deadline and is not labeled completed/admitted X.

## Gates and authority

Development semantic verification; independent domain qualification; ordinary separated disposable S8 review/use; protected S8 admission; activation; joined peer compatibility; protected equipped-X comparison; and mature S7 economic release are separate.
Ordinary disposable use is shadow computation only and cannot create a reservation.
Protected generated-module installation remains unavailable until an independently governed versioned owner release and exact domain/module/checker/fallback receipts exist.
Pi is not adopted.
