# Participant identity and legacy authority, before repair

The canonical `participant` identity must be insertable after the complete fresh
migration chain. It confers no employee role or general authority. An existing
owner, dispatcher or technician can be demoted to participant without retaining
an active legacy-derived assignment. Explicit nonlegacy assignments remain under
their existing authority owner. Restoring a legacy role reuses its original
assignment rather than creating a duplicate. Both tenant-scope guards remain
effective even for an administrative database connection.

The observed W3 failure is `employee authority role crosses tenant boundary`.
Migration 0069 resolves no legacy role for participant. Its NULL comparison
does not deactivate the old role, and its unconditional assignment INSERT
passes a NULL role to the unchanged tenant guard. Do not edit that historical
migration or weaken the guard.

The primary regression is `scripts/postz-w2/run-participant-authority-e2e.mts`.
It migrates a disposable PostgreSQL database, drives actual user inserts and
role transitions, reads the canonical assignment rows, and calls the real
generic and workforce authority consumers with a restricted application role.
The original signed native campaign does not independently exercise demotion,
restoration or foreign-role assignment, and currently fails during participant
setup. No production seam or fabricated acceptance is needed.

Before changing production SQL, run the driver and retain its actual database
errors. Rerun the same driver after the additive migration. Preserve owner and
legacy mapping behavior, independent explicit roles, generic participant denial,
scoped workforce authority, and both cross-tenant refusals. This is controlled
database evidence, not signed-HTTP, genuine-human, field or admission evidence.

The finite driver budget is 180 seconds plus 10 seconds per owned closer, one
disposable database, 10-second database statements and a 2 GiB free-disk floor.
Its receipt records the source/migration hashes, inputs, expected and observed
results, failures, cleanup and exact reproduction command without credentials.

## Whole-body deadline regression, before supervision

Independent review found that checking the elapsed time only before each case
does not bound `initialise`, `start`, `migrate`, or the final awaited case. A
blocked startup can retain its PostgreSQL process indefinitely. An elapsed-time
check without interruption cannot enforce the registered 180-second budget.

`run-participant-authority-timeout-e2e.py` owns the failure control. Its preload
waits forever immediately after the actual disposable PostgreSQL server starts.
It changes only the fixture dependency in that owned test process, never
production code. The unchanged public journey must fail at its own original
180-second deadline, stop the owned process family and independently verify the
exact PostgreSQL data-directory/PID identity is no longer live. A 195-second
outer observation is only the failing-control watchdog, not a longer business
budget. If it must kill the journey itself, the control fails.

Run that control before implementing supervision. Retain the missing-deadline
failure and its independently performed cleanup. Then add an actual child
supervisor, rerun the identical fault control, and rerun the ordinary seven
database/authority cases. Timeout, abnormal exit, cleanup error, missing receipt
or elapsed excess must fail the final journey receipt. Never use an uncancelled
Promise race to leave database startup running after a reported timeout.
