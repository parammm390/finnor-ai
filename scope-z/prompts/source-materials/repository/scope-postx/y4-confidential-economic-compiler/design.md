# Y4 frozen engineering design

Implementation reconciliation: the frozen failure model and verification
manifest remain unchanged. The mechanism descriptions below reflect profile
1.3.0 and the implemented restrictive source-accounting and retry policies.
Historical rejected builds and failed episodes remain retained.

## Whole-shape alternatives

1. Direct recursive lowering of the existing P1 `Expression` into MP-SPDZ
   `sint` operations. Small, but independent checking has no stable emitted
   object and must trust more producer control flow.
2. Lower the same canonical `Expression` into a bounded typed arithmetic
   protocol graph, independently compare each graph node with the original
   expression and its exact scale/domain, then emit MP-SPDZ. This exposes
   every branch, arithmetic bound, input binding and reveal.

Selected: **2**, with a single production lowering. The intermediate graph
is a compiler representation, not a parallel financial IR. P1 exact semantics
remain authoritative. Existing P1 cross-entity scope restrictions are unchanged;
Y4 requires explicit joint-function participant/terms authority instead of
pretending a joint request is an ordinary pooled P1 request.

## Numerical domain

Native source:
`finnor-os/packages/private-equity/src/program-synthesis/contracts.ts`,
`native.ts`, and `evidence-execution/exact.ts`.

Support the existing input/literal/add/subtract/multiply/ratio/min/max/if and
five signed comparisons. No general Python, dynamic indexing, recursion,
unbounded loops, secret-dependent memory access, floats, implicit FX or noise.
Inputs are signed base-10 lattices. All quantities retain original financial
semantics, source/estimation class, owner, time and explicit rounding.

Addition/subtraction/multiplication preserve integer mantissa and decimal
scale exactly. Comparison aligns scales. Division has the existing exact
18-place contract: zero or nonzero remainder is invalid, never approximately
rounded. Both branches are compiled obliviously; validity is selected with
the branch, so a lazy unselected invalid division does not invalidate an
otherwise valid function. Oversized intermediate integers/scales are
UNSUPPORTED before exposure, not modular financial results.

Each original node has an independently checked scale, signed integer interval
and unit derivation. Integer bounds remain strictly below 2^80. Comparisons use
84 bits with explicitly selected 40-bit statistical parameter over the pinned
128-bit prime. This is not the Decimal.js underwriting/R6 domain. No claim
that existing R6 proves this backend is made.

## Cryptographic boundary

MP-SPDZ v0.4.4 MASCOT/SPDZ over a prime field, malicious SoftSpoken OT via
pinned libOTe / cryptoTools, fresh live preprocessing, authenticated TLS channels.
The initial KOS15 path refused secure execution and was rejected, not enabled
with `-DINSECURE`; see `security-build-deviation.md`.
Active malicious n−1 corruption, at least one honest participant, abort allowed.
No fairness, guaranteed output delivery, availability or common-host-operator
protection is claimed. Deployment review and separately administered custody
remain unissued qualification requirements.

Input values are bit-encoded and each bit is checked inside MPC before any
range comparison; an adversarial out-of-range field element cannot exploit a
comparison's bounded-integer premise. Salted SHA-256 commitments bind actual
secret bits to public source/grant/session/function bindings. A 128-bit random
participant-local nonce hides low-entropy quantities. Nonces never reach the
coordinator or receipts. The established pinned Bristol SHA-256 circuit supplies
the hash; Y4 only interprets its AND/XOR/INV gates over authenticated secret bits.
Commitment validity is not primary-source truth.

Only declared recipient-specific results are privately opened. Public validity,
function/profile/participant identities, message sizes, progress/abort/error
classes and timing are declared leakage. Logs and receipts contain no private
inputs, nonces, key material or preprocessing. A local input file is never
opened by the coordinator/compiler.

## Independent correspondence/result basis

A separate checker accepts the original function and actual emitted graph,
not normalized producer assertions. It independently reconstructs ordered
expression terms, units, scales, interval premises, output bindings and complete
node coverage. Induction on the acyclic graph establishes correspondence
conditional on the pinned generic operation semantics. It is not a general
machine-checked proof of MP-SPDZ or its C++ compiler.

An independent exact Fraction oracle is permitted only in the disposable
verification administrator. It never runs in the candidate runtime and never
supplies plaintext to its workers/coordinator. Public engineering custody
does not establish protected independent administration. A protected production
result needs the actual qualified independent-checker contract.

## Owner and lifecycle boundaries

Use canonical Work/authentication, document versions for public compilation/
session evidence, native durable jobs, P4 currentness dependencies, existing
S4/S5 consumption and separately authorized S6 effects. No participant ledger
is merged. The computation artifact never grants effect authority.

Output authorization binds the whole function, participants, recipients,
input/source/grant heads and a cumulative disclosure family. The implemented
policy permits one prepared invocation per stable institution/source identity,
including across changed handles, functions and family labels. Atomic durable
reservations enforce that restriction; changing a label or aborting does not
refund it. Identical readback is allowed without a new invocation. This is not
a claim of arbitrary adaptive-query privacy. Aborted attempts and already
disclosed outputs remain recorded. Revocation suspends future use and
derivatives, but cannot recall prior knowledge.

Only a failed pre-input compilation with no prepared session can be retried,
within the original remaining attempt, CPU and deadline grant. Prepared,
aborted or uncertain protocol sessions cannot be retried through this API.
Reconciliation reads existing participant receipts without rerunning MPC;
uncertain sessions are burned, never blindly replayed. Cancellation/abort
never changes original S6 effect states,
reservations, liabilities or exposure. No plaintext fallback exists.

## Integration discipline

Shared edits stay in this isolated branch. No guessed migration ordinal:
additive SQL requiring serial owner allocation is retained as a named
preimage-bound integration asset until allocated. An applied disposable
installation is not a production migration or completed serial integration.
Y1/Y2/Y3 contracts remain separately pinned and are never silently absorbed.
