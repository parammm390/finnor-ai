# Remaining execution-boundary failures, before further edits

The frozen archive 04 and installation attempt 05 remain unchanged. Attempt 05
failed its first, pre-install Git-isolation check: actual exit 0 instead of the
declared expected exit 128. Git still discovered the parent checkout when the
ceiling was its current directory. The separate real
`git-parent-ceiling-control-01.log` exits 128 with the immediate parent as ceiling.
Use that parent ceiling for every fresh build/doctor child.

Source review of the guarded native driver identified these failures before
editing it. They are source diagnoses, not executed authenticated native cases.

| Failure | Required independently observed result |
| --- | --- |
| A background refusal can satisfy the complete event query but fail a later narrower use-event-only check | Reuse the same typed-refusal predicate over the complete native refusal population |
| Unique primary-key action IDs alone cannot detect replacement actions | Retain every pre-cut action's immutable original argument/identity and allow at most one canonical action per original programme/responsibility |
| A new claim fence alone can end a recovery case before useful continuation or lawful remaining-budget refusal | Require a nonempty independently precommitted durable recovery expectation and one closed outcome: original owner observed, typed remaining-budget refusal, or ambiguity retained; do not promote mere reclaim |
| Newly acquired application rows are not present in the before-snapshot, so existing-row comparisons cannot bind them | Correlate their actual original compiler/programme selector, original input, exact original reservation, root parent and nonrenewed deadlines |
| Source target metadata is asserted but source bytes are not checked, and installed snapshot matching uses OR | Check both targets' actual source-snapshot digest/population, every original source byte or explicitly declared installed transformation, and both installed source bindings using AND before Auth/DB effects |
| Observer and browser allocation can fail before cleanup registration; one cleanup exception can skip other resources | Register the browser immediately, close a failed observer, and attempt independent cleanup of every owned resource; fail qualification on any cleanup failure |
| Observer action IDs are compared with a business entity ID | Bind the native head's independent observer to the actual canonical action ID, and check the separate full original business row against the independent oracle |

Preserve the original compiler/programme input, complete frozen proposed intent,
episode and original deadlines while status/head/fence progress. Recovery fixtures
must additionally provide `expectedDurableState` and `recoveryOutcome`, one of
`ORIGINAL_OWNER_OBSERVED`, `TYPED_REMAINING_BUDGET_REFUSAL`, `UNKNOWN_RETAINED`.
Ambiguity cuts require the last outcome. A typed budget refusal must be actually
observed and must not add consumption or a replacement action. An observed-owner
outcome requires the same full independent native row/observer/deadline contract
as the useful G1 positive. No fabricated fixture or new unit test will be added.

Both targets must deliver their actual parent `source-snapshot.json`, its SHA256
as `sourceSnapshotSha256`, and the same frozen source population. Original source
files may differ in an installed target only at manifest-declared custody/Next
declaration transforms with exact recorded original and installed hashes.
All native cases, Auth, DB execution and physical cuts remain NOT_RUN. No
authority has been delivered, and these repairs grant none.
