# Bounded obligation/append protocol, registered before implementation

This is an executable finite-state safety model with explicit provider and trusted
boundary assumptions. It supplies protocol evidence, not proof of arbitrary deployed
providers or protected infrastructure. Do not certify missing mediation using it.

Check two worker identities, two effect members and up to two physical attempts per
member, one authority revision/revocation and cancellation, lease takeover, one
provider idempotency expiry and one crash between durable intent, may-have-left,
acceptance, observation and settlement. Requests have an immutable authorized
semantic identity. Accepted requests after revocation remain possible: revocation
must be current at egress, not retroactively imposed on provider acceptance.

Provider assumptions: a physical request may be accepted with its response lost.
Within the registered window, the provider deduplicates the exact request/key;
outside it, the same key can cause another consequence. A qualified absence read
is allowed only when no accepted or delayed request remains; partitions yield
unknown and cannot authorize replay. Local fences cannot revoke an in-flight request.
Independent observation is target/member bound. Producer success has no evidentiary
weight. Cancellation never releases an uncertain member or deletes its liability.

Append model checks authenticated owner/reference equality, immutable identity,
durable ordinary journal followed by a protected monotonic checkpoint before a
receipt. Crash and ordinary rollback cannot erase acknowledged history; complete
rollback of both protected checkpoint and journal is excluded and remains a real
deployment dependency. No scientific truth follows from a signed commitment.

Invariant failures: unauthorized egress, changed request identity, duplicate member
consequences, parent completion with unsettled members, possible delivery with no
retained responsibility, changed accepted content, or acknowledged history lost.
Enumerate all states reachable under the registered finite bounds. Liveness is not
claimed without scheduling, provider availability and observation fairness.

Test audit: contract is the above independent safety properties; credible mutations
remove final authorization, permit blind retries, trust executor success, erase
liability on cancellation or acknowledge before checkpoint. Existing process tests
exercise individual transitions but cannot enumerate their interleavings. No test
only production seam is introduced. Mandatory negative-control model variants must
produce counterexample traces, preventing vacuous green results.

Mappings: durable native commit/lease transitions → expired-success-repaired and
single-action owner evidence; false observation → browser wrong-record/null and
canonical self-verification; append → separate ledger process crash/tamper artifacts;
hostile egress → executor-dyld. Provider expiry/independent admission model assumptions
require actual qualified provider and protected broker evidence before completion.

## Provider history extension, registered before model implementation

The original obligation/append state spaces stay unchanged. Add a distinct bounded
logical provider-operation history model: two native attempts, at most two sequential
physical requests per attempt (preparatory then completion), one provider-key expiry,
physical prepare/may-have-left/provider decision/ACK or response loss, crash and native
recovery, and an independently observed whole-operation absence barrier. History is
immutable; physical no-egress and logical absence are different facts. Unresolved
delivery scans every attempt after the native absence barrier. Intermediate ACK cannot
complete the logical operation; a final ACK/readback must match the completion step.

Independent oracle records actual accepted steps and pending provider delivery.
Invariants: known failure cannot hide unresolved delivery; unknown responsibility
cannot be released; no duplicate accepted logical step after unsafe window expiry;
logical completion requires the actual completion step. Authoring gate: plausible
mutations use only the newest physical request, only the newest native attempt,
promote intermediate ACK, or trust the latest wrapper refusal. Existing two models
do not contain these request/attempt history distinctions. No production test seam.
Each unsafe mutation must produce a counterexample, and the correct finite model
must exhaust within the existing two-million-state budget. Safety only: no fairness,
provider certification, S5 release/liability, protected broker or admission proof.

Before implementing this extension, distinguish the whole-history algorithm from
the actual transport-time guarantee. The conditional history exploration assumes
that the provider protection window cannot expire with a physical request still
pending. This is an explicit, stronger provider contract, not a fact supplied by
the native database clock or current HTTP clients. Its expiry transition is disabled
while any request remains pending. The four history mutations are challenged under
that same assumption so that a transport-time failure cannot hide their own faults.
An additional unmutated exploration allows expiry while requests remain in flight,
as an ordinary network can. Duplicate accepted steps in that exploration must be
retained as an unresolved counterexample to the current local-window guarantee,
not renamed an expected safe outcome or omitted to make the gate green. Successful
enumeration of both explorations is not a passed S6 completion gate.

The independent oracle holds physical provider decisions and per-step acceptance
counts separately from native outcomes/ACK markers. Bounds remain two attempts and
two sequential steps per attempt; at most four physical requests, one expiry, and
the existing two-million-state budget per exploration. A 120-second wall budget
per exploration will return an explicit incomplete result. Retain CPU/peak-memory
measurements; neither these measurements nor the state budget are executor quotas.
Source digests are captured before and after the model run. Process mappings must
name exact successful cases, preserved transcripts and source matches/mismatches;
historical runs may not be relabelled as current-source proof.

Oracle correction before the next scored run: the first extension run allowed
expiry before any provider acceptance. That is not a retention-from-first-use
contract and is insufficient evidence for its printed transport counterexample.
Keep `protocol-history-current` intact and qualify that oracle limitation. The
corrected window may expire only after the provider has accepted at least one
step, in addition to the conditional no-pending-expiry restriction where applied.
Stripe's primary idempotency documentation (read 2026-10-02) describes retention
of the first result and a new request after the original key is pruned:
https://docs.stripe.com/api/idempotent_requests . This is a reference semantic
example, not qualification of FINNOR's other providers. A valid delayed-arrival
counterexample must include an actual first acceptance before key expiry and a
later request accepted after expiry. No real provider request is asserted here.

Map transitions to the actual retained `provider-history-owner-final` readbacks:
local accepted HTTP plus intermediate ACK/SIGKILL; prepared tail followed by SIGKILL;
new provider-key retry plus SIGKILL; and live retry refusal/expiry. Verify native
observed outcomes and source identities when recording mappings. The core absence
barrier test is a trusted-owner protocol fixture; the model's no-delayed-request
absence assumption is stronger and must stay disclosed. A finite abstraction cannot
prove arbitrary provider session/chunk contracts from these mappings.
