# R6 independent producer failure model

Registered before producer, verifier, oracle or fixture code, 11 October 2026.
Base: `4a90ed33ca96afa252c51f511fea279e0034cddb`, tree
`310a43fa2b7983bf33afc321795461c9678ce7f9`.

## Governing contract and authority

The complete R PRD (SHA256
`5781e4fd0f2bd0ac01d643fafc682905a931ff4cb0384e9eb1527dc8d99c4d59`)
sections 2, 9, 12, 13 and 14 and the final S architecture lock (SHA256
`2288bb54a3f6a91ed2673c220e7d844842ace9de5f6ee1b6674e8a48980ff415`)
govern. R6 is VerifiedCapitalCompiler -> DecisionProof, delivery phase 1.
There is no issued R6 goal in the inspected issued directory. The R1 blueprint
is methodology, not R6 mathematics or publication authority.

Only this independent checkout's assigned leaf paths may change. No existing
underwriting implementation, owner registry, migration, API, UI, package lock,
Docker file or other R scope is to change. Local commits only.

## Observed owner semantics, not a proposed parallel financial IR

The existing `underwriting-model-ir.v1` and native compiler/executor remain the
only executable finance IR. Its generic interpreter evaluates ordered decimal
operations with decimal.js precision 34, HALF_EVEN, explicit per-node rounding,
inclusive exact input ranges, full calendar-keyed series, lazy conditionals,
lag-before-forecast failures, aggregates, checks and output aliases.
In particular, `add`/`sum` fold from zero and `multiply` folds from one; these
folds round at each native arithmetic operation. Associativity/distributivity,
reordering operands and moving a rounding boundary are NOT assumed laws.
Node normalization alone is not a significant-digit rounding point.

The existing standard-LBO runtime is NOT the generic node interpreter.
It computes schedules imperatively, uses tolerances for several financial
checks, bounded fixed-point iteration and bounded IRR/XIRR solvers with decimal
power/log/exp. Its `put` does not apply generic node rounding. Reusing native
standard-LBO scenario results cannot prove it against an independent accepted
reference. Do not invent that reference or silently substitute rational math.

Installed investigation found Node v22.22.3, Python 3.9.6, decimal.js 10.6.0 and
tsx 4.23.13 in the integrator's read-only dependencies. `lean`, `lake`, `elan`,
`z3`, `cvc5` and `viprchk` are not on PATH; the usual `.elan` and Lean installation
paths are absent. No Lean proof is to be claimed. R2's VIPR optimization
checker is not a financial-IR translation proof.

## Independent acceptance predicate specified before code

The proposed bounded native checker is an ordinary, independently implemented
Python/Fraction verification path, not an admitted Ring-0 change. It must not
import the producer, native compiler, native decimal implementation or its
expected answers. Its trusted source/version and native semantic premises are
explicit pins. A separate process alone is not the independence argument.

For an actual pair of existing generic IR instances, the producer supplies
compiled native artifacts, canonical owner input correspondence, declared
financial-state correspondence and a proof object containing only the permitted
congruence rule, complete statements, no axioms and no unresolved goals.
The checker must independently:

1. Validate original IR bytes, all nodes/types/units/currencies/dependencies,
   complete calendar and lexicographic native execution order. Reconstruct the
   native compiled artifact and native semantic hash rather than trust it.
2. Validate a complete explicitly bounded input domain for every native input
   component. Decimal domains are supplied fixed-scale integer lattices with
   inclusive exact bounds; booleans/text/dates have explicit finite allowed
   values. Domain size may be enormous: checking must not rely on sampling or
   silently enumerate a smaller domain. A supplied native InputSnapshot must
   witness membership and native valid input policies. Zero is not missing.
3. Bind every input to its canonical owner reference; expand let/alias nodes
   independently into typed ordered native expression terms per actual period.
   All observed amount, liability, timing, objective and hard-check terms must
   agree by checked congruence, preserving every rounding point and lazy guard.
   Transparent no-rounding aliases and differing internal node structure may
   agree. Unproved algebraic rewrites are rejected as unproved, not fraud.
4. Check every declared reference cash/liability/constraint item exactly once
   against supplied programme bindings. Require complete coverage of outputs
   and all hard CheckNodes. Relative inventory completeness is not evidence
   that the reference represents every real-world obligation. Unknown S6
   liabilities prevent the stronger mechanically complete claim.
5. Independently establish successful execution and all specified hard checks
   for the entire domain using sound exact interval/lattice reasoning.
   Each native arithmetic fold/round is accounted for. A division range
   containing zero, possible decimal overflow/underflow/length failure,
   applicable missing lag, unresolved predicate or failed hard check prevents
   COMPLETE. Lazy unreachable branches are not executed. Equality of failed
   executions or a false hard check is not a valid financial proof.
6. Reject empty domains, omitted/mutated statements, changed engine/checker/
   dependency/assumption/domain pins, arbitrary axioms and unresolved goals.
   A crash, timeout, cancellation or malformed response gives no acceptance.

Checked congruence is an all-input translation statement conditional on the
pinned native interpreter semantics. Induction over the acyclic evaluation
graph and expression constructors establishes equality for every domain input;
series induction uses the actual calendar key and lag index. Sound interval
and lattice enclosures prove successful execution and universal hard checks,
not sampled equality. This is NOT a Lean theorem, modeling truth, causal
adequacy, legal interpretation, settlement, optimality or economic gain.

Reference interpretation approval and checker qualification must be separately
resolved by the existing protected owner path. No self-issued development
receipt, caller-provided reference object or flag can create either authority.
The bounded producer can return ordinary mechanically accepted evidence while
its overall R6 disposition remains INCOMPLETE for absent current approved
reference/checker authority and shared integration. It must expose exact gaps.

## Failure families and decisive oracles

| Failure | Decisive evidence |
| --- | --- |
| Native compiler/schema differs from claimed source | independent reconstruction of actual compiled bytes and semantic hash rejects |
| Currency/unit mismatch with otherwise valid native instances | checker compares owner input and state type/currency bindings |
| Rounding moved, arithmetic reordered or precision changed | ordered native term congruence and semantic pins reject |
| Liability omitted, cash duplicated, date shifted | complete canonical reference inventory and amount/timing statement checks reject |
| False guard used to conceal a liability | complete lazy branch term checking rejects; applicable branch invariants remain universal |
| Empty or incompletely described domain; witness outside it | exact bounds/cardinality/complete component coverage and witness membership reject |
| Equal outputs but false hard constraint or failing execution | universal validity/totality proof rejects; no vacuous pass |
| Native series/aggregate/output alias semantics misencoded | complete calendar/period expansion; independent finite native/reference comparison is additional conformance evidence |
| Before-forecast lag executed, unknown input, wrong truth policy | actual native input policy and lazy expression totality reject |
| Actual source/dependency changed after checking | currentness recheck fences consumption; historical evidence stays immutable |
| Checker crash/timeout/cancel/output tampering | real separate process transcript; no certified receipt, unchanged grant/deadline |
| Standard LBO, circular generic execution or unsupported semantic rewrite | UNSUPPORTED/INCOMPLETE with exact missing proof; never claim the original full profile passed |
| Missing accepted reference, native-runtime conformance or S8/checker admission | ordinary evidence only, named open gates; no invented receipt |
| Disconnected core called integrated Work/API/worker proof | finite handoff explicitly distinguishes leaf core from serial seams and NOT RUN integration |
| Cost/throughput claim omits checker or preparation | actual wall/CPU/RSS retained; money/human/aggregate memory gaps explicit |

## Finite execution discipline

The adjacent verification-plan.json fixes the selected cases, commands, limits
and rerun conditions before expensive execution. End-to-end runs retain their
inputs, full packets, process transcripts, native execution observations,
independent receipts and expected predicates in ignored private evidence.
Never delete or overwrite a failed attempt; repairs append a new attempt.
No post-code unit tests or unrelated inherited recertification.
