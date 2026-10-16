# CI #176: explicit per-minute webhook fixture

Exact cut 3f13a04efbb2084607a3cdcc325fb86f5ca23d9b, run 38966995655,
shard 2 job 117197225952. One of 473 tests failed: the Microsoft Graph webhook
dedupe case expected one queued wake but observed two. Other 469 tests passed
and three skipped. The seven-case file ended at 21:12:00.248 UTC; its two
accepted-delivery logs were flushed at 21:12:00.056/057 and reported 31/18 ms.
The original raw job keys were not retained, so a minute-crossing diagnosis is
consistent with the observed boundary, not directly proven from stored keys.

The production route deliberately keys ordinary wakes by subscription and
`receivedAt.toISOString().slice(0,16)`. Its integration test used an uncontrolled
wall clock while requiring both deliveries to coalesce. This requirement is
nondeterministic at a UTC minute edge. No production route, idempotency key,
database uniqueness constraint, authentication check or floor will be changed.

Finite fixture repair and acceptance registered before editing:

- Freeze only Date in this disposable-DB integration case, not PostgreSQL,
  network timers, performance.now or event-loop timers; restore in finally.
- Same-minute deliveries must still yield exactly one actual queued sync_source.
- Add an exact xx:xx:59.999 -> next-minute boundary case: duplicates within
  either minute coalesce, but the next minute retains its new wake (two rows).
- Keep the original three-second response assertion against native monotonic
  elapsed time; fake time cannot make it pass.
- Retain actual queue keys/status/payload, controlled timestamps, elapsed time,
  source hashes and rerun command in a JSON artifact captured by the existing
  backend evidence upload. Do not label skipped/local-unavailable cases PASS.
- Reuse the existing PR #133, no additional PR. Required exact-head checks and
  governed production deployment remain mandatory. Original failure is retained;
  no blind rerun is used to erase it.

Local qualification: the focused integration command reported eight skipped
cases because localhost PostgreSQL was unavailable; this is NOT a PASS. The
full local typecheck was stopped after process/version inspection showed it
was running the unpinned system Node 22.18.0, not required 22.22.3; no successful
typecheck is claimed. Its process sample is retained. Hosted exact-head source
and disposable-DB checks remain mandatory before merging.

CodeRabbit found that the extra minute-edge case had accidentally applied one
three-second bound to four requests instead of each original two-request pair.
The original same-minute three-second assertion is unchanged semantically and
uses native performance.now; the added independent minute groups each retain
that same bound, with individual and total elapsed values recorded. Fresh final
review of both changed files completed with zero findings. The real queue keys
are now retained before row-count assertions so any repeat failure remains
diagnosable. The original #176 failure is kept in ci-176-webhook-failure.log.
