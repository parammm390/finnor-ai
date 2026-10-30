# Preclaim storage exhaustion: pre-correction contract

Written before the continuation's worker correction. This is a source finding,
not a database reproduction or a historical pre-code read receipt.

## Observed source and callers

Checkpoint 02 worker SHA-256:
`e5364af78f0cf83cb157a2cb552f1b3c25fd528a7307629fc30718122eb8ba29`.
The worker's initial local-claim transaction inserts an attempt, a CLAIM cost
and an ACTUAL_QUEUE_CLAIMED event. Its episode storage/event constraint can
reject that transaction before `registered = true`. The catch immediately
rethrows every unregistered failure. The real queue records/retries or
dead-letters the original delivery, but does not update the Z5 request.
Consequently a storage-exhausted request can remain QUEUED rather than expose
the required INCOMPLETE refusal.

The queue's separate `ComputeCapacityUnavailableError` branch deliberately
defers an undispatched locally idempotent job without consuming its logical
attempt. Do not erase that error's identity or turn contention into exhaustion.
Existing queue/delivery rows remain the original physical-attempt evidence.

## Required behavior and failure cases

1. Only the exact recognized original episode byte/event/use CHECK violations
   may enter terminalization before the Z5 local claim commits. Preserve every
   other preclaim error object, including native capacity deferral, unchanged.
2. Use the already authenticated original employee, request and actual running
   job/delivery token/fence/generation. A mismatched, expired or replaced
   physical delivery cannot change a successor's request.
3. Commit INCOMPLETE using the already prepaid bounded control metadata.
   Attempt refusal audit/cost separately. An unavailable/full audit cannot
   undo the fence. No new allowance, attempt row, debit, deadline, reservation
   or obligation identity is created to make a refusal record fit.
4. Cancellation, revocation or a newer generation wins. If no current row or
   transaction is available, retain the queue's original failure and report
   no invented successful terminalization.
5. A later delivery observes INCOMPLETE and dispatches no producer. Already
   committed deliveries, costs and S6 liabilities remain unchanged.
6. Make the optional audit distinguish whether the local claim committed.
   Unmetered preclaim overhead remains a cost gap, not free computation.

## Finite permitted validation

Read the actual worker, store constraint classification, SQL storage trigger
and native queue failure/capacity branches. Re-run the affected complete
backend graph with exact request-05 virtual postimages under the shared
4096-MiB heavy lock. The UI, SQL, kernel, checker and shared postimages do not
change, so their unchanged source-bound receipts are reused. No new post-code
unit campaign, fabricated SQL fixture, native DB/Auth call or archive workaround
is authorized. Real quota/transaction/race behavior remains native NOT_RUN.
Keep checkpoint 02 and all old failure evidence immutable.
