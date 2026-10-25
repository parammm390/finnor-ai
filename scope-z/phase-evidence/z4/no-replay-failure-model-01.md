# No-full-replay correction, specified before changing the checker

The locked PRD §§8.1/8.6 require the audit and native consumer to verify
without executing the original programme. At b169136, the Rust `verify`
operation already verifies the compressed proof without the input trace,
but `checkExecutionProof` unconditionally calls `originalExecution`.
The completed b169136 delivery remains historical and is not rewritten.

Two complete shapes were considered:

1. Keep original reference execution in production diagnostics; independently
   derive the constraint image and original input commitment in the checker;
   accept a claimed final state only after actual pinned proof verification.
2. Cache a trusted final result and compare later claims with that cache.
   This would replace instance proof checking with a trusted-result shortcut
   and is rejected.

Choose the first shape. Binding the original inputs still scans their bytes.
No whole-path sublinear, full-range, security-admission or value claim follows.
The relation/compiler/native backend, supported bounds and resource ceilings
do not change. Old capsules and checked-result schemas must not be silently
interpreted as the new no-replay result.

Failure-first executable check:

* Use the retained real two-step proof for `r = 11*r + x`, initial 5,
  inputs 1/2, independently declared final value 618.
* In a separate actual Node process, replace only the original interpreter
  module with a counting function that throws. Exercise that trap directly
  to prove it is active. This fault injection supplies no result or proof.
* The old checker must fail because it invokes that interpreter. After the
  correction, checking the real proof must succeed with no extra trap calls.
* Changed result, relation, initial state, length, input commitment, original
  inputs and parameter identity must still reject. No producer boolean or
  cached verifier receipt may replace the separate native verifier.
* Preserve full independent original execution in producer/reference checks,
  including comparison before a new checkpoint is published.
* Migrate persisted result/version checks, native audit evidence and every
  actual caller. Re-run the existing critical process falsifiers and affected
  type/lint/build checks. Preserve all earlier failures and packages.

This is offline native proof E2E, not authenticated Work/DB/UI evidence.
No DB/Auth, grant, signer, listener, production action, protected population
or additional business budget is authorized or created.
