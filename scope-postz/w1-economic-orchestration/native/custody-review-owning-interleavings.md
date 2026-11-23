# Concrete owning schedules for custody review repairs

These schedules refine the already registered parent failure hypotheses.
No outcome below has run. They are E2E sub-observations, not unit tests and not
new substitutes for the original 65 required predicate IDs.

## Genuine current claims for request/key conflicts

Use a separately admitted original-human native read. Install an owned trigger
that rejects its post-private-commit step finalization and also rejects the
attempt to clear that step's live claim. The latter rollback must retain both
the actual native step claim and actual persisted loop lease. No test-created
claim, successful receipt INSERT, response stub or relaxed currentness check.
Remove the trigger after the native owner returns.

For every changed field, first replay the unchanged request/key/input/principal
through the real dispatcher with that still-current native claim. Require the
exact original execution and private result. Read the actual claim/deadline and
database clock before the mutation. Change only request, key, input, principal,
or node selector. Require a fact-free rejection and unchanged original private
bytes/receipt. Finish via the native runtime with its original claim owner.

## Input/deadline races after verification starts

Use a post-private-commit final-check fault to leave a legitimate unfinished
native check. The atomic repair must roll back plan sealing with that failed
check, preserving the private query's earlier independent commit.

In the disposable admin transaction, lock `evidence_source_versions` in
ACCESS EXCLUSIVE mode. Resume the real native check, and within a fixed
five-second observation window confirm that its actual app-role SELECT is
waiting on this source table after its current check claim was persisted.
This pauses real source reauthorization, not a mocked verifier or fake result.
Do not hold the Work or input table.

- Input race: while that real source read waits, commit a new same-Work input
  through ordinary `receiveWork`, as the original human. Require created=false
  and duplicate=false. Only then release the source lock.
- Deadline race: accept the parent with a fixed five-second deadline. While
  verification waits, let that exact deadline elapse naturally, still within
  the live thirty-second native claim and the SQL/iteration timeouts. Never
  extend or replace the deadline. Only then release the source lock.

In both schedules, require the resumed native owner to return `continue`,
not a source error or unsatisfied-condition block. The plan and Work must not
be completed, the proof must not be sealed, private bytes and counters must
remain identical, and the original accepted condition must remain unchanged.
Always roll back/release the owned source lock in finally and await the bounded
native call. A missed schedule/precondition is a failure, not a pass.

The finalizer also awaits canonical plan locking after its first deadline
check. Add a third schedule that holds that exact PlanRevision row instead of
the source table. Confirm the actual app-role `SELECT ... FOR NO KEY UPDATE`
waits at canonical sealing, then let the original deadline pass before releasing
the row. This must roll back all tentative plan, step, loop and Work completion,
not leave a completed plan behind a rejected publication. The already committed
private query remains immutable.

The source-deadline fixture accepts five seconds; the separately accepted
seal-deadline fixture accepts ten seconds so it can run after the first one.
Neither deadline is changed after intake. The remaining pause must fit within
the still-live thirty-second claim, unchanged ten-second canonical SQL timeout
and iteration timeout. Bound the remaining pause to seven seconds. Check
the deadline/current loop lease again after all transactional publication
awaits. A lost final fence aborts that transaction and yields `continue`; it
must not be confused with a successful completion or a source-read failure.

## Graph and remaining-step recovery

Add a real compiler-admitted three-query chain whose checks depend on their
own query. Require all three receipts before whole-goal completion. Add a
separate repeated-request plan whose two original assertions are status=ok
and execution.status=succeeded. Require distinct native receipts, coverage
bindings and unchanged private bytes for both criteria.

For completed-delivery recovery, accept maxSteps=2 for one query and one check.
Fault the final check after the original query completed and check 2 was
reserved, then redeliver query step 1. Require completion on the same two
reserved steps and same single query, with no third controller or new grant.

The unqualified draft that deferred every check in the generic frontier is
rejected: an accepted query -> check -> query graph would deadlock. Do not
narrow admission or ignore its edges to hide that valid input.

Keep the canonical frontier unchanged. While a query branch remains unfinished,
a native check verifies only its own original criterion, using the existing
canonical query-criterion owner and its original criterion index. Publish only
that node's receipt-backed metadata and continue under the same budget. Never
store a partial result as whole-Objective success. After every query completes,
the existing whole-goal verifier must recheck every unchanged accepted criterion
and current source right before the atomic completion fence.

Add a separate admitted three-query graph with actual check barriers between
queries. Require receipt-backed criterion checks to unlock each exact dependent
query, followed by full original-condition completion. This also exercises
already-reserved checks without adding a generic scheduler option.

All new source dependencies receive exact preimages and are included in the
existing strict owner closure and source freeze.
