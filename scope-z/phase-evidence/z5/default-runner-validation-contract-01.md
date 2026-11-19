# Current default-runner validation contract

Date: 2026-10-25. This is a post-code validation-scope correction, not a
historical pre-code receipt or a new population registration.

Checkpoint 05 records that the changed public runner's audit-only mode was
executed, but its default full semantic mode was not. The earlier audit
contract judged another complete sweep unnecessary because the kernel,
checker and frozen inputs did not change. That leaves the new mandatory
audit prelude, full-mode receipt attachment and final source check without
a complete current-default-CLI execution. Closing this specific gap is a
diagnosed affected rerun under the original stop rule, not a new case or
unit-test campaign. The earlier contract and receipts remain immutable.

## Expected values, fixed before this invocation

- Original registration SHA-256:
  `74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e`.
- Current 36-file code digest:
  `d65ccefad807b1690e2d4ad2b9dcec72c76f894af771fddbeae71110e6e564f2`.
- Current runner SHA-256:
  `978a8b5b92b1fa68f3493827ac512b2f81c63793312a6d36623cd4a7a76c31ec`.
- Run the original 256 registered slots without changing any expected value:
  188 candidates, 50 checked infeasible, 16 unsupported, two incomplete.
- Every registered case must invoke the actual producer and independent
  checker successfully, with the original expected replacement disposition.
  Expected full-run exit is 0, 256/256 and 188/188 positive slots.
- The attached population audit must still identify 84 different complete
  inputs, 50 different positive inputs, 172 repeated slots and nine
  cross-label duplicate groups. Structural-family qualification and
  independent freshness remain `NOT_ESTABLISHED`.

## Failure modes

1. Exit through audit-only mode without executing the original case flow.
2. Fail to attach the population-audit artifact to the full-mode receipt.
3. Accept a wrong original disposition or replacement, omit a case, or
   count duplicate slots as independently fresh structures.
4. Change kernel/checker/runner/registration during the invocation.
5. Overwrite an earlier report, change a frozen member or hide a failure.
6. Start without the shared heavy lock or safe output headroom.
7. Misreport lock-wait time as mechanism execution time or a speedup.
8. Treat this public source execution as native owner, installed,
   protected-custody or financial qualification.

## Bounded execution and observation

Use one new `public-sweep-04/` directory and a credential-free environment.
Take the existing shared heavy lock, with a finite wait and overall command
timeout. The existing runner serializes bounded producer/checker processes;
retain every raw process result and the final report. Measure command-level
time separately from the runner's own elapsed time.

Before launch, reverify the 36-file source digest and original registration.
Require free space of at least twice the retained sweep-03 output footprint
plus 128 MiB. This source-replay headroom check does not change the separate
8-GiB installation guard.

After completion, independently verify the 256 raw producer/checker exits,
all registered expected outcomes, source hashes and attached audit identity.
Keep original runs 01–03, failed checks, denied index and flagged journal
unchanged. No commit/archive retry, flagged-content inspection, DB/Auth
operation, listener, migration, signer, peer archive replay or coordinator
gate is authorized.
