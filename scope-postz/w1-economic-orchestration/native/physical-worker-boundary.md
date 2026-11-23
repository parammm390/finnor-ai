# Failure-first physical queue repair

`evidence/native-bootstrap-0005` retained the original queued P1 request, due job,
zero deliveries and zero physical attempts after ten real queue ticks. Migration
`0171_runtime_database_role_isolation.sql` gives only the existing restricted
`finnor_worker` role global queue visibility. The P2 fixture incorrectly used its
`finnor_app` API pool for global claims. Waiting longer cannot fix that boundary.
The earlier idle-backoff diagnosis alone was insufficient.

Reuse and extend the existing P5 physical queue fixture, not the production queue
or its policies. The API remains `finnor_app`; a separate native process uses
`finnor_worker`, non-superuser, non-BYPASSRLS, with no application membership in
the worker role. The disposable database enables login for that already-created
role, as existing R2/P5/X2 owner fixtures do. No new role, protected grant or RLS
exception is introduced.

Before W1 scoring, observe the worker's actual role, PID, real registered handler
names/contracts, queue deliveries and process usage. Require worker auth bypass0.
Pass only declared local runtime paths and keep the transport guard. The original
WAITING/zero-attempt assertion, original episode/grant/deadline, original P1 SQL
acceptance and unchanged independent W1 oracle remain mandatory.

The reusable client must reject unsupported handler registrations, disconnected
workers and failed RPCs. Child exit rejects pending calls. Closing drains logs and
terminates only its own child. The original P5 default profile remains unchanged.
P2's source-stage subqueue must also use this physical boundary with only its
original two handlers; do not let orchestration execute before source staging.

Expected owning proof: the same registered native bootstrap advances through the
real restricted worker and independently verifies actual capsule consumption.
All earlier failures remain. This fixture repair is not a software-completion,
protected-admission, clean-install or economics receipt.
