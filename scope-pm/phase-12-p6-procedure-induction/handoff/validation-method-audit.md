# Validation method correction

The first final proposed cut was `39352a010c49de24664757c91bdb32ddffe91218`.
Its first native run had 11 PASS/3 FAIL and a driver timeout before two stories.
The second had 14 PASS/2 FAIL, unchanged source and a stopped database. The
P5/race repair run passed both repaired stories but failed three physical
induction stories. It is 13 PASS/3 FAIL, not final completion.

## What the evidence actually establishes

- The UNKNOWN P5 request reached a 422 response after the client's 15-second
  timeout. Early authenticated refusal now passes the original P5 story.
- A fixed 16-second race observation missed the real publication window.
  Bounded observation within the unchanged original deadline now passes the
  original race story. No grant was renewed.
- In the repaired run, one crash induction's original deadline was
  `2026-10-08T03:07:04.366Z`; its actual delivery began at
  `2026-10-08T03:06:48.869Z` and ended at `2026-10-08T03:07:08.359Z`.
  Only 15.497 seconds remained when delivery began. The 19.490-second
  delivery exceeded that remaining grant. The final state reader overlaps
  state/cost reads, so its earlier RUNNING row is not proof of successful
  late publication. Retain the actual FAILED_OR_FENCED event.
- Baseline story elapsed time varied from 27.728 seconds to 92.643 seconds.
  That observation does not identify a host-capacity cause.
- Repeating full trajectories immediately costs minutes of physical recovery
  backoff and does not isolate startup, claim, synthesis, publication or
  acknowledgment. Worker child output was discarded, losing that diagnosis.

## Bounded repair method and failures to prevent

For physical publication/acknowledgment mechanics, launch the actual native
queue child and wait for a credential-free ready message **before accepting
the induction**. Ready requires its real registered handlers and verified
loaded source identity. Only then accept the normal API request, install
the physical database lock and let the child poll the normal durable queue.
No capsule, job, claim, result, evaluator or expected output is injected.

Record the child PID, code identity, preparation elapsed time and readiness,
then actual claim/publication/ack observations. Preparation is not free:
preserve measured wall time and unknown dollars. These are explicitly
**warm-worker crash mechanics**, not independent cold-transfer qualification.
The earlier cold-start expiry failures remain in the denominator.

Use the existing short lease profiles only for crash recovery; observe the
unmodified original deadline. Do not extend an induction's 30-second grant,
remove the native 60-second recovery backoff or ignore final deadline fences.
An unmet readiness bound fails before intake. An unmet physical window fails
with worker output and queue/induction diagnostics, not a guessed explanation.
Keep the full 16-story final run mandatory.

During repair, run a declared dependency-complete E2E selection for the failing
boundary, with every other story recorded NOT_RUN. Do not aggregate that
selection as a complete suite. Only after it passes, reconstruct the latest
committed cut and run all stories, mounted flow and affected owner checks.

No changes here qualify BASE10, S8 admission, independent custody, hidden
trials, full costs, a reuse horizon or original GateP6.
