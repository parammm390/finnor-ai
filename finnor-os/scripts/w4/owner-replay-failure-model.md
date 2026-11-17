# Signed owner replay repair

Case 008 is a profiled diagnostic, not a benchmark or qualification run. During
the pending handoff its SQL observation found no blocking backend; the parent
used about 13 CPU seconds within the first 15 wall seconds. Its CPU profile
attributes substantial work to canonical encoding and owner-origin verification.

The same S3 reader first calls readableHistory, which recovers the signed model
and its experience, then recovers it again after currentness. Keep the authorized
historical read, current S1/model/method checks and one complete recovery. Remove
only the second recovery inside that same owner read. Keep each later owner read
fresh; no cache spans requests, currentness stages, principals or transactions.

Transport byte bounds and Ed25519 verification currently serialize the same
decoded policy/envelope twice in one synchronous check. Reuse the exact bounded
canonical bytes for that signature check. Canonical encoding, signed fields,
8 MiB and complexity limits, reference preimages, origin key validity/revocation,
rights, scopes, digest encodings and delivery/recovery fences remain required.

The existing hosted reference-snapshot E2E must retain its signed positive and
counterfeit/mismatched origin controls. Rerun the real authenticated W4 owner
journey with its unchanged 30-second HTTP and original resource/deadline bounds.
Do not report a speedup from the profiled run or turn a fast refusal into success.

## Native delivery workload

Unprofiled b2 case 010 completes two 30-second handoffs, then the third returns
500. Its in-process S1 diagnostic records
OWNER_TRANSPORT_UNRESOLVED_BACKLOG_LIMIT. The recipient configures transport
but does not drive the existing owner outbox. Its routes also omit canonical
source owners referenced by the actual authenticated S1 view.

Declare only source owners present in that view, with its exact canonical
rights reference. Drive the ordinary signed outbox between preparation stages,
using the existing 32-record delivery bound, original leases and recovery
budgets. Retain all attempts and refusals. A bounded drain must end with zero
unresolved deliveries, or fail before the next preparation; do not delete an
outbox row, increase its 256-intent bound, omit provenance or label pending as
accepted. Existing foreign identity, wrong receipt and physical recovery
checks remain required. This is disposable fixture orchestration, not a new
production grant or installed-worker qualification.

## W5 source-cut diagnosis

Case 011's actual signed assessment is STALE_INPUT for both policy/model and
resource source witnesses, with zero provider requests. Record the original
resource pins and fresh authorized S1 dependency cuts immediately before and
after the source Work intake, without altering any pin, policy, reservation or
deadline. Changed dependency entries identify a fixture ordering defect only
when the observations establish it. Preserve the original refusal and do not
bypass the currentness checks.

Case 012 on 081 observes the original S1 pin matching before source intake and
not matching afterwards. The sole added dependency is one canonical
work_entity_link; there are 303 then 304 claims, with equal rights revision and
coverage. Declare that existing planned source Work during beforeFit, alongside
the existing prospective units. Later exact-idempotent intake must return the
same original input and add no dependency. This changes fixture order, never
the original pin, native refusal, resource grant or episode deadline.

Case 013 stops during recipient setup because a semantic owner containing a
slash was used as a filename. Hash the complete owner identity for token-file
custody; retain the original identity in every signed route, scope and receipt.

Case 014 preserves its S1 cut and completes actual first dispatch, cold restart
and two-second operator takeover. The next test submits five seconds and
incorrectly expects exhaustion: this original obligation has a 225-second
human envelope. The shared S6 fixture's literal negative belongs to its smaller
original fixture. Read the current authentic human budget and submit exactly
remaining+1 within the existing 900-second request bound. Still require 409,
unchanged protected history and unchanged native budgets; retain inputs and
both readbacks. Do not lower the declared allowance or claim a valid request
was an owner-budget bug.

Case 015 actually commits 95 signed outbox entries, then the bounded drain
retains 54 S1, 12 S3 and two S5 deliveries. The refusals are missing/unauthorized
references and missing parent events. Preserve each unresolved original signed
envelope and the declared reader rights alongside the exact ledger journal,
then compare the complete referenced dependency population before a repair.
Do not retry an unchanged unresolved closure, fabricate missing references or
weaken the zero-unresolved and original budget assertions.

## Verification of identical locally signed bytes

Case 019 clears 173 delivery records and has zero unresolved at its first
handoff. The original 30-second client request still expires after one
durable S4 preparation and before S5 consumption. At the 15-second sample
there are zero database blockers and roughly 12 seconds of main-process
CPU time. The prior profiled run points to repeated canonical encoding and
origin signature checking; it does not establish one dominant current
function or a measured speedup.

Newly signed origins can use the same bounded canonical bytes for signing
and verifying within the private signing call. Their insert transaction
needs that completed verification once. An existing stored origin still
requires the full independent signature, preimage, current route and
authorization verification. No stored receipt, effect or currentness check
is cached or waived. Keep remote delivery and recovery verification
unchanged. The existing signed transport controls and original W4 handoff
remain the acceptance boundaries.
