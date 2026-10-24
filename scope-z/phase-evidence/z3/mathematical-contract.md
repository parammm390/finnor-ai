# Pre-implementation mathematical contract

This refines the pre-code plan, without changing the locked objective.
The public original input is finite, total, turn based and fully observed.
An empty successor list is rejected. A declared terminal has its explicit
self edge and actual safety/justice/goal labels. Unsafe states remain in the
original graph. Environment predecessors never discard an original edge.

Let K be the safety greatest fixed point, starting at the entire original
universe. In K compute the ordinary GR(1) region by the following simultaneous
outer iteration, using original existential/universal predecessor:

`nu Z . intersection_j (mu Y . union_i (nu X .
 K intersect ((B_j intersect CPre(Z)) union CPre(Y)
             union ((K minus A_i) intersect CPre(X)))))`.

All greatest iterations start at K; all least iterations start empty.
No assumptions means the single set V. No goals means the single set V.
The transcript contains every initial and successor iterant, including the
equal terminating iterant. No arbitrary fixed point, skipped layer or
truncated transcript can certify completeness. Explicit operation, transcript,
time and product bounds cause UNKNOWN, never infeasibility.

## Extraction and finite-memory completeness

Use one round-robin counter for the assumptions and one for the goals.
At `(v,a,b)`, consume v: advance a if v is in A[a], and b if v is in B[b].
Mark an assumption (goal) completion exactly when its counter wraps.
Give the product vertex maximum-parity priority 2 on a goal completion,
otherwise 1 on an assumption completion, otherwise 0. Thus an infinite
play wins exactly if goal completions occur infinitely, or assumption
completions occur only finitely. Counter wraps are equivalent to the
respective conjunctions of justice sets, including singleton V defaults.
Safety was already enforced in K.

Solve this at most 1024-vertex parity game with deterministic attractor
recursion. Its memoryless winning strategies give at most four memories
in the original arena. Parity-game memoryless determinacy establishes
completeness for the ordinary objective on this monitor, not completeness
of nonconflicting synthesis. Cross-check the projected parity region with
the GR(1) region before returning a candidate.

The independent checker does not import the producer, predecessor, parity
solver, parser or graph implementation. It replays the complete fixed-point
transcript with Python sets, reconstructs every original-memory successor,
and checks all cyclic SCCs after removing each goal. Non-bottom SCCs count.
It checks the strategy from every reported winning state with initialized
memory, and checks original initial states separately.

Assumption satisfiability uses the original full graph. Nonconflict means
that every reachable strategy-memory prefix still has a fair continuation.
Both use cyclic SCCs intersecting every assumption and reverse reachability.
Ordinary wins with impossible or sabotaged assumptions are UNKNOWN for
viability. Failure to find a nonconflicting strategy is not unrealizability.
No complete nonconflicting winning-region claim is made.

## Independent exhaustive population, before exposure

The finite population is all labelled total one- and two-state arenas with
every owner partition, every safety subset, every nonempty successor subset,
all states as initials, zero or one arbitrary assumption set, and zero or
one arbitrary goal set. Additionally exhaust the frozen public cases of up
to eight states when their monitor has at most 4096 controller policies.
Each deterministic policy is checked from each original state, retaining
every environment edge. The union of winning starts must equal the claimed
complete region. The counter argument above justifies the finite-memory
bound, rather than an arbitrary bounded-policy search.

This is a precisely enumerated population, NOT all eight-state games.
The test oracle enumerates policies and uses original temporal SCC semantics,
not GR(1) iteration or the producer's parity recursion. It is independently
implemented code, not an independently governed evaluator or protected oracle.

## Source and native distinctions

The 32 structural specifications are the sealed public specifications.
Eight obligations per family are frozen as actual input bytes before product
code. Two feasible cases count only where the family's defining condition
admits a useful nonconflicting solution. Impossible justice, hidden observation
and unavoidable unsafe-attractor families retain explicit inapplicability,
not renamed positives. Per-family denominators, UNKNOWN and falsifiers stay
visible. Public model assumptions do not admit a native fairness/renewal fact.

Finite native observation and retry budgets are distinct from infinite-play
model semantics. Every native action rechecks original Work, rights, code,
S4/S5 and S6. It either follows an original edge or invalidates the guarantee.
No GF claim implies each request finishes, elapsed-time/non-Zeno bounds,
indefinite spending, authority renewal or erasure of UNKNOWN.
