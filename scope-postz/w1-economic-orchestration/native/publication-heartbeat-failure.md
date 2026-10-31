# Failure-first publication and heartbeat repair

Attempt `evidence/native-bootstrap-0008` repairs the earlier S5 self-lock. The
original module actually returned netEquity43/leverage3.5 from the restricted
native subprocess. No SQL acceptance or capsule PASS is claimed. Publication
failed, repeated job-heartbeat statements timed out, the connection pool then
timed out, and the delivery was quarantined after its durable lease was lost.

The publication transaction takes `FOR SHARE` on its running job before W1's
complete currentness and completion-driven replan. Queue heartbeat updates need
that same job row. Overlapping blocked heartbeats consume pooled connections
that the still-running owner validation itself needs. Holding the fence across
slow owner work can therefore prevent the worker from maintaining its own lease.

Perform all existing owner checks and transactional result/replan writes first.
Take the unchanged claim-token/fence/status row lock at the final commit cut,
also requiring an unexpired lease. If the claim was replaced, cancelled or
expired during validation, roll back the whole publication transaction. Never
release a fence and later publish without rechecking it. No external I/O is
added to this final locked cut, and no deadline, heartbeat interval, authority,
acceptance, resource allowance or retry identity is relaxed.

Owning proof remains the unchanged registered native bootstrap and independent
original-byte oracle. Add a bounded SQL wait/blocker observer to retain the
actual physical lock history, including failures, rather than labeling a
successful sandbox invocation as successful native execution. The original
same-episode and same-deadline checks remain mandatory.
