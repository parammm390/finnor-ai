# Recovery cleanup preflight, before the first physical epoch

The proposed physical key repair remains uninstalled. Both physical cases
remain NOT_RUN. The original failure/oracle contract and all numerical,
business, queue and observer bounds remain unchanged.

The real case worker does not detach from its case process group. The inner
Python runner creates each case in a new session and already kills that exact
group in finally. Thus group cleanup, not a name-pattern kill, owns descendants.

Two concrete outer failure paths are not fully closed:

* After spawning the inner runner, a bootstrap receipt/I/O failure enters
  finally without stopping that runner. The same is true of a later bootstrap
  exception while the inner child remains alive.
* The outer watchdog sends SIGTERM to Python, which has no SIGTERM handler.
  Abrupt default termination can bypass the active case-group finally.
  Concurrently stopping PostgreSQL does not kill that separate case group.

Before the first physical freeze, make SIGTERM unwind the inner runner through
its existing exact-group finally. Reap the killed direct case child with a
bounded wait. Register the bootstrap's child-close observer immediately at
spawn, before fallible receipt writes. In bootstrap finally, terminate only
its exact live child, wait for close, and escalate only that PID after five
seconds. Do not race PostgreSQL stop against an active child's graceful group
cleanup. Keep all stopped data and failed artifacts.

These are test-harness lifecycle repairs, not queue-key production repairs.
No new signal is part of the scored victim oracle: the existing exact victim
SIGKILL, awaited OS close, lock release, natural lease expiry and both original
row oracles remain unchanged. The A/B E2E will qualify nominal cleanup only;
unexecuted abrupt-wrapper failure injection remains NOT_RUN.
