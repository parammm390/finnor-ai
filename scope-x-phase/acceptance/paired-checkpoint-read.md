# Canonical paired checkpoint read, pre-code contract

The fifth X2 native campaign still fails its original seven-second suite.
Do not rerun unchanged, regrade its partial cases or alter the eight-second
pause, seven-second suite, original lease/currentness, authority or resources.

## Observed owner path and narrow change

Every S8 command checks journal integrity and calls `verifyCheckpointTail`.
For a nonempty journal this makes two serial authenticated S6 reads: reject
a checkpoint after the current tail, then validate the actual tail checkpoint.
Each read correctly repeats the complete S6 release, journal, anchor, content
and witness integrity pass. Bounded content concurrency did not finish the
gate. This duplicated canonical request is a concrete remaining cost, not
proof that batching alone will make the native campaign pass.

Add one read-only canonical S6 endpoint for one or two distinct reference IDs.
It must use the same authenticated owner, queue, rights/sealed-content checks,
reference/preimage validation and complete integrity pass. Keep every committed
file checked on every request, no file/state/authorization cache. Return both
results from one serialized owner operation; only genuinely absent references
are null. Denied rights, corruption, unavailable storage, bad witness/release,
malformed input and partial reads fail the whole operation, never look absent.
Preserve the old single-reference endpoint and clients through shared exact
validation, without changing their wire or error behavior.

Bind the complete new snapshot, including absence, to a fresh client nonce
using S6's existing release-bound signature. Include requested order, exact
caller scope, current sequence/checkpoint, release identity, checked time and
explicit no-effect-authority qualification. The client must verify the signed
snapshot against existing accepted receipt roots and every present original
receipt/reference using the existing verifier. No unsigned null/reordering,
partial array, unbound ID, stale/replayed nonce, changed scope or invented
release is accepted. Keep existing HTTP response size, timeout and route/token
checks. No new signer, grant, journal, store or native success system.

S8 replaces only the two checkpoint lookups with this bounded canonical
snapshot. It still refuses a future checkpoint, checks the exact tail
policy/sequence/entry/previous digests, and repairs a genuinely missing tail
through its original existing path. No fallback silently accepts a server
without the new contract. Historical sealed deliveries are untouched.

## Failure model and validation before implementation

First author an artifact-producing separate-process HTTP E2E, then implement
the endpoint/client and S8 call site. Use only new disposable synthetic
reference custody, generated test keys/tokens and private evidence. This is
not a native Work/business/S8 campaign or protected-substrate qualification.

Cover unchanged original single reads; valid present/absent pairs and reversed
order; sealed access with/without rights; read-disabled and unauthenticated
callers; foreign tenant without disclosure; malformed/empty/duplicate/oversize
ID sets and unsupported fields; same-size content tamper, symlink/missing/
oversized storage, unrelated-file corruption even for missing requested IDs;
response tampering, omission, reordering, scope/release substitution and exact
signed response replay with a new nonce. Every failed read must leave the
actual S6 journal/head unchanged. Restore only exact files created by this
fixture. Stop/await its own server/proxy and retain all failed attempts.

Record exact source/runtime/commands, inputs or their safe digests, per-case
HTTP results, original receipt identity, ending journal/head and rerun command.
Never print tokens, keys, config or raw private wire bodies. Bound this one
local stack by the existing 900-second/6-GiB sampled observer, original
8-MiB wire limit, one/two IDs and unchanged 256-request ledger queue.

After boundary E2E, require backend/driver types, affected existing security
and S8 recovery checks, source review, and a fresh complete native X2 campaign
with every original state comparison. A faster component or passing boundary
test is not a passing live gate, full chain or economic qualification.
