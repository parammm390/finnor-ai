# Retained checked-request publication failure model

This continuation model is written before changing the affected consumer or
store source. Checkpoint 06 and every original failure remain immutable.
The current implementation digest before this correction is
`d65ccefad807b1690e2d4ad2b9dcec72c76f894af771fddbeae71110e6e564f2`.
This is source inspection, not a newly observed native execution.

## Diagnosed failure

`checkedCurrent` reads the request before independent owner/S8 calls.
Cancellation can subsequently commit `cancel_requested`, a new generation
and `CANCELLED` without changing the original owner cut. Several final S4
transactions only rechecked that owner cut. In particular, resolving an
original handoff, recording immutable plan/handoff consumption, and beginning
planning could therefore publish after a cancellation committed between the
earlier currentness check and the final request lock. An existing-admission
read had the same retained-row gap. Some new-admission/use branches checked
cancellation but did not consistently check retained generation or terminal
status. Original S8 pre-dispatch/currentness paths also used inconsistent
subsets of the checked-request predicate.

The S4 head can independently change during an external check. Reading a
previous immutable use row is not proof that it remains the actual head.
The final binding check must lock the real head and its immutable use row.

## Required correction and expected values

- Under the final transaction's request lock, require a checked artifact,
  unexpired original deadline, no cancellation and no STALE, REVOKED,
  CANCELLED, UNKNOWN or INCOMPLETE state.
- When a retained request is supplied, additionally require the identical
  generation, artifact digest, source digest and immutable request digest.
  A previously checked snapshot never overrides a newer control fence.
- Reuse this predicate for initial checked reads, S8 admission/evaluation/
  currentness, S4 use, handoff resolution, planning debit evidence and
  consumption recording. Keep original owner/profile/dependency checks.
- When consuming a composition binding, require the current admission and
  exact original policy/allocation plus the locked actual S4 head/use.
  Repeat this local check after external custody/debit/immutable-file work.
- A cancellation/revocation/stale/new-generation/head change before the final
  lock refuses publication. A change after the lock serializes after that
  publication and invalidates later reads. This is not once-only effects,
  protected custody or a stronger distributed-transaction claim.
- Original S5 debits already committed before refusal remain charged. No
  refund, fresh allowance, dropped S6 liability or control-fence mutation.
- Missing admission, changed immutable artifact or expired deadline refuses.
  Ordinary current checked candidates and USED requests preserve behavior.
  No global source, schema or coordinator patch change is needed.

## Bounded validation and limits

Before the implementation edit, strengthen the existing guarded native flow
to request S8 admission, S4 use and original S4 planning after cancellation
and require all three to refuse without changing the durable cancelled
request/episode/event/attempt state. This is a real-owner flow definition,
not a mock, new unit campaign or permission to run it. Run only its existing
credential-free refusal guard here.

Run the affected backend graph and owned-source lint using the existing
identified third-party compiler/declarations under the shared heavy lock,
with actual exit receipts and retained original failures. Check changed MJS
syntax and current owned whitespace. Kernel/checker/population/proposal
bytes are unchanged, so do not repeat their exhaustive semantic sweep.

No DB/Auth, listener, migration, signer or native execution authority exists.
Neither static checks nor the refusal guard demonstrate this concurrency
schedule at runtime. Record the native cancellation/race proof as NOT_RUN.
Shield still blocks commit/archive/reconstruction; this correction grants no
flagged-content read, retry, exclusion, packaging workaround or acceptance.
