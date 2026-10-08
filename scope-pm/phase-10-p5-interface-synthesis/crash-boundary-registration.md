# Additional physical crash cuts, registered before executing stories

Original predicates remain unchanged. These public development cases add
physical evidence for P5-23/24/25/27/33/34, not sealed GateP5 qualification.

Use the existing actual SQL/API/queue/independent persisted target. A physical
owned worker executes the unchanged registered handler. Independent test-only
network pauses or a disposable SQL advisory-lock trigger hold an exact cut.
Kill that worker PID with SIGKILL and await close; independently retain SQL/
target observations before and after read-only reconciliation or original retry.
No product fault flag or intercepted runtime helper establishes the cut.

1. Discovery GET pending, no durable attempt and no PATCH: actual job fencing/
   lease recovery then explicit resume retains original episode/deadline/
   operation, learning attempt count, and permits exactly one mutation.
2. Durable INTENT, before possible-egress transaction commits: target unchanged,
   zero wire debit, same attempt/operation after explicit safe resume, one write.
   SQL trigger gates only the disposable `p5_attempts` possible-egress update.
3. Mutation acknowledged, independent target GET pending: original attempt/
   possible-egress/ack and read debit survive SIGKILL; mutation retry refused;
   bounded read-only reconciliation yields one verified actual mutation.
4. Actual exact observation/history and COMPLETED result durably committed,
   capability INSERT blocked before publication: no current capability is
   fabricated after worker death. Original result/history survives; reconcile
   reads target/history again and publishes without another mutation.

The reference independently requires C_01 price2000, C_010 price1000, actual
single mutation and exact operation/revision. Zero- and one-mutation cuts are
checked from disk, not returned by adapter or fixture-control endpoint. All
failed/time-limited/interrupted runs remain raw evidence. Advisory triggers/
locks exist only inside an owned disposable database and are removed/closed.
