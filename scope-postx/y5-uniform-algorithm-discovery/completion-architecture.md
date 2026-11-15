# Y5 discovery architecture

## Decision

Use a versioned proof-carrying synthesis path over a closed total language.
The old Boolean-box capsule remains version 1 and an explicitly reused baseline.
Do not turn its recognizer into a catalogue of named structural profiles.

Two read-only attempts examined the whole problem. Candidate A proposed a typed
conjecture DAG with a proof-carrying rewrite/equality graph. Candidate B proposed
joint synthesis of total programs, representations and invariants, executed
through the same Lean semantics that appears in the theorem. Both rejected a
profile-to-proof-template catalogue. Choose B because it removes the separate
optimizer/rewrite trust surface and gives an observable program/proof/execution
boundary first. Checked intermediate lemmas still form an acyclic dependency
graph, but an equality-graph optimizer is not required.

Both attempts inherited Sol-heavy. They are independent attempts, not different
model families. A separate Sol-heavy read-only judge required the corrections
below before engine implementation. This does not establish cross-model review.

## Public boundary

The existing Work command, discovery store, queue and worker remain the
orchestrator. Additive versioned input resolves:

- An immutable, typed family specification fixing input/output types,
  feasibility, objective, exact ties, numerical meaning and cost model.
- A lawful complete episode cut, including failed, corrected and UNKNOWN
  siblings. Episode mining ranks proposals; it cannot change task meaning.
- The original Work, principal, rights, source revisions and resource allocation.

Use a distinct v2 task command, not a reserve definition embedded in the v1
allocation payload. Resolve the specification from an immutable,
authenticated user-authored Work input before search. The owning resolver
constructs its reference and verifies external acceptance where configured.
S5 owns the fixed complete-principal episode census. A caller-selected head
list is not a completeness certificate; overflow or unavailable visibility
refuses the cut instead of dropping siblings.

An independently accepted input must carry a receipt resolved under an actually
configured external semantic-acceptance policy. Parsing `independent: true`,
minting a local key, or seeing an S5 CANDIDATE event cannot construct that state.
Unaccepted public specifications remain usable as public development inputs.

The worker emits either an incomplete search with retained attempts or a v2
capsule. The capsule binds the original specification, synthesized program,
discovered structural statement, all-size proof, sized nonempty domain,
declared counted cost, import/axiom inventory and actual runtime profile.
Version 1 is never silently promoted to version 2.

## Language and search

Use exact integer/natural/Boolean values, lists, products, variables,
conditionals, arithmetic/comparisons and structural list/natural recursion.
Use typed hygienic binding. No arbitrary source, imports, IO, shell, unsafe
evaluation, axioms or raw tactic programs may arrive through the request.

The engine searches expression trees, recurrence/accumulator programs and
intermediate propositions from the frozen grammar. Task and lawful episode
subterms rank the search. It tests development counterexamples, retains actual
refutations, and separately records unproved obligations. Generic induction,
case analysis and arithmetic tactics are reusable operators, not successful
family proofs or discovery evidence.

The first decisive new development task is minimum initial reserve for an
arbitrary list of exact cash movements. Its specification gives prefix
feasibility and minimality, not an algorithm, accumulator, successful invariant
or proof. A runtime search must find an executable recurrence and a load-bearing
structural theorem. A named reserve primitive, preinstalled successful body or
finite-only proof fails the gate. This deliberately contaminated public task
earns no protected novelty credit.

Separate the supplied economic-state transition from the synthesized algorithm
state. Search available state types, initial/step/result terms and Boolean
propositions. An exclusively threshold-shaped invariant would be a reused
abstraction, not discovery of that structural shape. The actual intermediate
proof must participate in the all-size theorem.

The independent public correctness target is every prefix balance, including
the empty prefix: for every finite integer list, return the least integer
initial reserve making all prefixes nonnegative. Prove equivalence between
the recursive feasibility representation and that target. Cover every size
and input, including empty lists, with no candidate-selected domain. A
conservative nonoptimal feasibility witness may establish domain nonvacuity.

Every checked result must cover all mathematical input sizes in its declared
domain. Hidden length bounds, contradictory assumptions and always-UNKNOWN
algorithms fail. Grammar exhaustion is INCOMPLETE, not task infeasibility.

## Correspondence and owners

The Lean denotation and counted evaluator share the canonical program AST.
Execute that definition, not a separately generated JavaScript implementation.
The checker obtains the expected specification/type independently of candidate
claims, re-elaborates source, replays the actual proof object and inspects the
real imports and axioms. Lean process separation is not a second proof-system
implementation or protected checker custody.

Prove counted-value agreement and an explicit `a * length + b` upper bound
for the selected program, charging expression evaluation, products,
conditionals and recursion. Exact integer operations are declared primitives;
the result is not a bit-complexity or physical resource guarantee.

S5 still checks the complete original supplied problem. An original primal
feasibility check alone is not proof of optimality correspondence. Where the
semantic bridge or independent original-space bound is absent, report only
checked feasibility and the actual gap. No new ledger, reservation authority,
S6 effect or self-admission is introduced.

Origin discovery, immutable mathematical theory and a current method use have
different lifetimes. A new use needs current Work/rights/instance/budget checks;
it does not renew the origin grant. P7 invalidates the relevant theorem,
correspondence, applicability and admission edges without deleting history.

## Public Markov task

Use a separately pinned compatible mathematical dependency profile. Do not
silently widen the existing core runtime's import policy.

The required result constructs the stipulated history-conditional process,
proves absorption using a geometric survival bound, proves the stopped harmonic
process is a bounded martingale, and proves the eventual upper-first event has
probability `(2^i - 1) / (2^N - 1)`. Handle `N=1` and both endpoints. The `N=8`
answer is a consequence, not the main theorem. An assumed absorption/limit,
finite recurrence or supplied answer is not completion.

## Registered failure model

Before the new implementation, retain these falsifiers in the end-to-end
campaign:

1. Absent/forged semantic acceptance, unauthorized/future episodes, revoked
   rights, an omitted adverse sibling or a changed complete episode cut.
2. A family-specific successful algorithm/invariant hidden in the grammar.
3. Development equality without an all-size, nonvacuous theorem; a successful
   theorem about a different task, tie rule or cost model.
4. A false but well-typed conjecture, hidden axiom, changed import, renamed
   theorem, changed implementation or substituted proof object.
5. An interpreter/source mismatch, integer overflow or uncharged nested work.
6. A claimed S5 optimum based only on one feasible translated answer.
7. Renewed episode/use deadlines, late publication after cancellation, lost
   physical completion reported as complete or UNKNOWN effects retried.
8. A Markov fixture that assumes absorption or convergence or checks only a
   finite horizon.
9. A mounted view that revives private data after a late read, Work/principal
   switch, source withdrawal or authority loss.
10. A copied installation, missing sandbox/quota, operation count or unknown
    dollar amount labelled as protected practical qualification.

Native and installed runs remain serial, bounded and source-sealed. Preserve
the existing 30-second call/invocation limits. Bound the new AST, candidate
frontier, proof attempts, counterexamples and scratch before expensive work.
