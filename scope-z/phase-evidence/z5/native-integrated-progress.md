# Z5 native integrated progress

Base a5209ab (integrated candidate with request 07, e481133). Branch `w/z5-native`.

## Done
- Failure model F1-F21, D1-D6 (predecessor) and D7-D10 (successor) in `native-integrated-failure-model.md`.
- D4 fixed (fixed-profile source reference), D7 fixed (S6 CONSUMER route removed from the scenario ledger policy), D9 fixed (chain roots at a fresh organization).
- D10 implemented: scenario ledger carries the S6 protected broker; `native/z5-dispatch.mts` runs the loopback TLS provider and the native-owner authority endpoint; the carried obligation is dispatched to UNKNOWN_OUTCOME (response lost) before the S8 profile is built; the independent reconcile plus S5 settlement is released after the driver's mounted/second-tenant/sign-out steps.
- D8 diagnosed: S8 `LifecyclePolicySchema` pin cap is inert (zod 4 stacks `.max`); request patch in `native-integrated-request-s8-sourcepins.patch` (NOT applied on the branch; applied only in the scratch remote worktree).

## Runs
- w5-native-03 (predecessor): Z5N-01/02/03/05 PASS, others FAIL/cascade.
- w5-native-04 onward: see the final report.
