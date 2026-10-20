# Preregistered bounded process-cleanup observation

The current-cut4 X3 main browser driver passed all 18 original groups and exited
zero. Its process meter retained `PARTIAL_COMMAND_CLEANUP` because one observed
descendant, PID 211529/startTicks 9692885, was still alive at the immediate final
sample. A later exact-PID read found it gone; the separate fixture meter passed
and its database was stopped. Preserve these original receipts unchanged.

The meter currently stops observing as soon as the command exits and its sample
function returns when the root process is absent. This cannot observe ordinary
asynchronous descendant shutdown. Do not relabel the old partial receipt PASS.

## Selected repair and failure model

- Continue following already observed PID/startTicks identities after the root
  exits. Never attach to an unrelated reused root PID. Include descendants of
  surviving owned identities through the existing process-tree traversal.
- On a zero or nonzero command exit, observe pending owned cleanup for at most
  three seconds, capped by the original remaining 900-second command bound.
  Keep original RSS, log and deadline enforcement active during observation.
  Do not grant a new command deadline, widen a product limit or omit costs.
- Stop waiting immediately when no observed non-zombie owned processes remain.
  Record initial pending identities, actual wait and effective cleanup bound.
- A surviving identity after that bound must still produce the original
  `PARTIAL_COMMAND_CLEANUP` failure. A resource/deadline failure stays a failure.
  Never kill an unrelated or user-owned browser to obtain a clean receipt.
- Preserve the original 250-ms sampling, stable-identity checks, sampled-peak
  limitations, exit/status distinctions and all original business/browser
  oracles. A browser verdict alone is not a clean command receipt.

Use the actual emitted mounted campaigns as the falsifier. Rerun the main
browser and remaining focused/effect/X5/X4 pairs in new attempt directories,
with the same 900-second/6-GiB command floors and task-owned fixture teardown.
No post-code unit test or fabricated process state is introduced.
