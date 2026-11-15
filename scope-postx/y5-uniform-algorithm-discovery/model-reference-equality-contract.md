# Pure original-owner structural equality repair

Registered before this repair's logic. This is MODEL_ISOLATION, not an
authenticated Work, independent acceptance, kernel theorem or protected result.
Use only the exported S5 `checkTotalTaskResult`, `evaluateTotalTaskModel` and
`totalReferenceBounds`. Do not mock responses, clocks, budgets or private helpers.

## Failure model and oracle

1. Equal separately constructed products or lists compare unequal by JS identity.
   Unequal structural values, lengths, Booleans and nested products/lists must
   remain unequal. NOT EQ must invert structural equality, not object identity.
2. A valid necessary empty-prefix bound from either AND conjunct is discarded
   because the other conjunct has unsupported bound syntax. Test both orders,
   two supported bounds, and two unsupported conjuncts. OR still needs both.
3. Catching unsupported syntax accidentally swallows TIME_BOUND, INTEGER_BOUND
   or EVALUATION_BOUND. Preserve honest UNKNOWN results and original limits.
4. Structural comparison work is uncharged. Charge one budget step for every
   compared value node, including array roots, lengths and visited leaves.
   An empty-task product comparison fixture must report 21 expression steps;
   the corresponding singleton-list fixture must report 20.
5. Minimality or prefixes change. For movements [-2,-1,4], nonnegative safety
   plus structural tautologies returns exactly 3, with failures 0,1,2 and all
   four prefixes including empty. Combining lower bounds 0 and 2 returns 5,
   with failures 2,3,4. A bounded search must never claim UNSOLVABLE.
6. Deadline, arithmetic, evaluation or candidate bounds are raised or mocked
   to make the check pass. Check the unchanged exported bounds exactly.

## Repro and artifacts

`verify-total-model-reference.mts` is written before logic and first run with
`--phase=red` against the saved pre-fix owner source. It records every input,
actual returned value or error, assertion, source hash and observed failure.
After the narrow source patch, run the identical driver with `--phase=green`.
Never rewrite the red artifact. One execution is limited to 30 seconds and a
1,280 MiB Node heap. No database, API, native, server, build or browser runs.

Synthetic bindings carry an explicit MODEL_ISOLATION qualification and are used
only as pure interpreter inputs. They do not pass the authenticated binding
schema. Existing kernel-related prefix-result tags do not establish any kernel
qualification in this isolated check. Parent integration, typed-language
admission and authenticated E2E verification remain separate gates.

## Addendum: recorded-result replay (written after the change, not pre-registered)

The fourteenth owner run failed inside the discovery worker, about 66 s in, with
`S5_TOTAL_TASK_INDEPENDENT_REFERENCE_RECHECK_FAILED`, while the host was heavily
loaded and swapping. The recheck replayed a recorded MODEL_ACCEPTED result
through `evaluateTotalTaskModel`, which stops at `min(deadline, now + 1000 ms)`.
The accepted records cost 35 and 91 expression steps (0.2 to 0.3 ms), so only a
stall of more than a second inside the call can exhaust that wall budget. The
stall is inferred, not observed. The change makes the failure impossible by
construction instead of waiting for it to recur.

`replayTotalTaskModel(specification, task, recordedSteps)` is the recheck. Its
only bound is the recorded step count (capped at the unchanged 2,000,000), and
it has no deadline input. `evaluateTotalTaskModel` keeps its wall bound.

Failure model for the replay, checked by the `replay-is-bounded-by-recorded-work-and-never-reads-the-clock`
case in the same driver:

1. Replay reads the clock and can fail an accepted record after a stall. The case
   counts reads of `Date.now` around replay only and requires zero. Time is
   observed, never altered.
2. Replay does different work than the original. The replayed result must have
   the same digest as the original, including its step count.
3. Replay work is unbounded. Replay with one step fewer than recorded must return
   UNKNOWN with EVALUATION_BOUND.
4. The original evaluator loses its wall bound. An already expired deadline must
   still return UNKNOWN with TIME_BOUND.
5. Exported bounds change. The existing exact bounds assertion still applies.

The owner end-to-end run remains the real check of the worker path.
