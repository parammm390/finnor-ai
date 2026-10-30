# Finite-boundary failure and expected-value model

This model precedes the focused replay driver and the implementation changes.
Checkpoint 09, the reviewed staged index, every failed run, and the consumed
commit retry remain immutable. This is continuation of attempt 005, not a new
execution slot or authority grant.

## Source-inspected defects

1. `originalGraph` inserts every distinct original initial state before its
   product-state check, which currently runs only for successor discovery.
   The independent checker's `reconstruct` has the same missing initial bound.
   Two distinct completed initial states with a one-state product budget can
   therefore receive an independently accepted positive certificate. Initial
   tuples are not a free allowance and must not bypass the declared cap.
2. The independent checker's `full_translation` materializes
   `list(product(...))` for every shared valuation before checking a row or
   debiting its operation budget. Eight cells with 32 values each request
   1,099,511,627,776 tuples, even when the translation-row budget is one.
   The producer already enumerates lazily. The checker must also stop at the
   declared row budget rather than exhaust its 512-MiB address-space limit.

Pre-edit implementation SHA-256:

- `kernel.ts`: `d663a2505f06c338922a1018c7026152fd74ee392eb3a903c19bf7346b9b4de5`
- `checker.py`: `f30a37f198cda1cb72fecab5b1a17846900e3db623326953a6865b21debc6887`
- Current 36-file code digest:
  `017c02c2f1074abfaeb62134602391422d7401bb30071947605159e46d7f1b71`

The failures above are source diagnoses, not claims that their processes
have already run. Preserve the actual pre-correction replay result separately.

## Frozen expected-value cases

The focused process replay uses public, explicitly declared finite kernels.
Two fixed components have only legally completed locations, no transitions,
true assumptions and true safety. The first component has two locations and
the second one; one shared immutable public world cell has one value. Thus
the full translation has exactly four rows, with either one or two distinct
original states according to the supplied initial tuples.

| Case | Independent expected result |
|---|---|
| Two distinct initial states, product cap two | CHECKED_CANDIDATE, two original states, checker accepts |
| The same two initial states, product cap one | INCOMPLETE, no positive context or bridge, checker accepts the refusal |
| Three duplicate initial tuples, product cap one | CHECKED_CANDIDATE, one distinct original state and three initial obligations |
| Eight 32-value cells, translation cap one | INCOMPLETE, independently checked without materializing the Cartesian domain |
| Four translation rows, row cap four | CHECKED_CANDIDATE, exact translation count four |
| Four translation rows, row cap three | INCOMPLETE, independently checked refusal |
| Exact-cap positive certificate rebound to the one-state-budget input | Independent checker rejects, even if input digest is recomputed |

These are diagnosed boundary checks, not new qualification families, a
replacement public population, independent freshness, or a unit-test campaign.
All existing frozen public inputs and expected values remain unchanged.

## Required correction and failure preservation

Enforce the distinct-state bound while inserting original initial tuples in
both independent implementations. Repeated tuples still count as separate
initial obligations, but not separate product states. Do not deduplicate or
drop original initial obligations in the certificate.

Enumerate shared valuations lazily for each original component/location in
the checker. Retain the existing valuation/local/component order, complete
joint-domain semantics, digest format, row/operation limits and refusal class.
No larger limits, incomplete positive proofs or producer imports are allowed.

Before editing these implementations, run the bounded replay once and retain
all raw process results and its nonzero exit if the diagnoses reproduce.
After correcting the root causes, rerun exactly that replay with identical
expected values into a new exclusive output directory. Then run the existing
41-case process E2E once because the core producer/checker changed. Do not
regenerate the 256-case registration or start a fresh full semantic campaign.
Use actual processes, credential-free child environments, existing heap/
address-space/wall limits and the original shared heavy lock. Preserve the
4-GiB process, 6-GiB graph and 8-GiB installation guards; no installation is
needed. Read the installed Next server guide before source changes.

## Authority and delivery limits

The one approved local commit retry is consumed after Shield refusal. Do not
commit, restage the reviewed cut, change the journal, make an archive from
uncommitted source, change hooks/identity, or seek a workaround. New owned
worktree corrections must be separately source-bound and explicitly distinct
from the preserved staged tree and historical check receipts.

No native manifest path or verified target exists. No DB/Auth/SQLite,
launcher, listener, seed, migration, grant, signer, outside write or financial
effect is authorized. Shared request 07 stays unchanged and unapplied.
Original Work/reservation/deadline, S6 liabilities/UNKNOWN, S7 attribution and
independent S8 admission remain intact. Costs not actually metered remain
UNKNOWN. Coordinator acceptance and slot release remain absent.
