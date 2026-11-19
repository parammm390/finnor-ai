# Worker heartbeat teardown and dispatch: pre-correction contract

Written before this continuation's source correction. The checkpoint-03 worker
SHA-256 is `fb7560a067774d919d26d32ae8eaa5f794bd63540fd67d33286a0c507aa737f3`.
These are source findings, not observed native database races.

## Actual callers and failure paths

The real native queue keeps handler heartbeat callbacks until its surrounding
handler/ACK/failure block finishes. A callback returning false makes its
`leaseLost` flag sticky. The worker's final `finally` releases its compute
leases but neither closes the callback nor detaches that final lease array.
A callback already renewing, or starting while final release is awaited, can
therefore interpret a deliberate completed-work release as active lease loss.
The producer-to-S8 handoff already detaches its permit, but final teardown
does not. An already-started request/source check can also finish after all
handler work settles.

The first producer dispatch follows original S5 debit, source/profile checks
and owner extraction. Only the periodic callback checks the physical queue/
compute permit during that interval; the first direct heartbeat occurs after
the producer returns. Scheduling delay or loss of the original permit must
not allow a new producer to start before a direct current-fence check.

## Required behavior and finite failure cases

1. Active producer/checker/owner work retains all existing generation, original
   delivery, deadline, profile, source and compute-lease checks. Unexpected
   active permit loss still aborts and reports false.
2. Close the handler callback only when its normal work or error handling has
   settled and final cleanup begins. From then on there is no producer work
   or owner consumption left for that callback to authorize.
3. Detach the final completed lease set before awaiting its actual release.
   Already-running renewals and request/source checks that finish after
   closure must not manufacture a new active-work lease loss.
4. A callback that already reported loss before closure remains lost. Do not
   reset the native queue's sticky flag or bypass its actual job/delivery
   token/fence ACK query. Closure is not a claim that ACK occurred.
5. Final release errors still propagate. Do not refund work, discard debit/
   claim/cost evidence, create an allowance or release another owner's permit.
6. Before a newly invoked producer, perform the same direct current heartbeat
   fence already required before checker dispatch/publication. A failure
   launches no producer. Reusing an immutable artifact needs no new producer.
7. Retain the original preclaim quota fix, capacity-deferral error identity,
   separate audit transactions and all old S6 liabilities. No shared queue
   source or integration postimage changes are needed.

## Validation boundary

Read the current worker/process/store and actual queue callback/ACK branches
before changing the owned worker. Run its affected complete backend graph
under the shared 4096-MiB heavy lock and check the final diff. Existing UI,
SQL, kernel/checker, process drivers and native authority guard are unchanged;
reuse their exact source-bound receipts. Do not add post-code unit fixtures,
mock a native owner, initialize DB/Auth, alter caps or rerun denied packaging.
Native timing, actual queue ACK/recovery and installed behavior remain NOT_RUN.
Preserve checkpoint 03, the original failures and the denied index.
