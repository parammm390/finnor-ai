# Protected final authority and recovery bounds

Registered before implementation: extend the existing real native-owner,
separate-process ledger/broker and local TLS record-contract E2E. Preserve its
crash, wrong-record/null, revocation and native S5 settlement challenges.

Observable contracts and plausible failures:

1. A provider PATCH leaves after a live native owner check, but protected history
   contains no exact signed nonce assessment, source version, validity deadline
   or delivery fence. Before the PATCH, protect the actual final assessment and
   independently verify its signature, parent order and append timestamp against
   the observed TLS request. A synthesized assessment or unsigned summary fails.
2. An ordinary caller bypasses queue retry bounds by invoking protected readback
   repeatedly or restarting the broker. Cap observation requests at 64 per
   logical obligation, durably claim each read before sensitive egress, and retain
   operator responsibility on exhaustion. Exercise 64 real wrong-record TLS GETs,
   physical SIGKILL/reap/restart, and additional requests. The 65th GET is forbidden;
   prior possible effects and the exact S5 envelope must remain held. The cap is
   an operational bound, not a claim of S5 monetary metering.
3. A protected claim or authority-witness append fails. Dependent provider egress
   must not occur; a recorded possible attempt retains responsibility. Existing
   ledger persistence/outage tests remain relevant, but do not claim an injected
   crash at a specific new syscall unless actually observed.

No provider or owner decision is mocked. The TLS contract is local and keys are
disposable independent test roots. A same-host test does not qualify production
isolation, live provider guarantees or human release approval. No new production
fault seam, changed oracle budget, history deletion or fake clock is introduced.
Recovery remains read-only for every previously attempted member. Monetary costs
remain UNMETERED, and native S5 controls release. Bound: 64 total observation
claims, 64 members, 256 protected history records, 30 seconds per request. The
candidate must refuse before exceeding its protected history bound.

Retain exact native references, request/admission/grant inputs, owner signatures,
TLS requests/readbacks, protected receipts, PID census, native SQL liabilities,
source freeze and terminal status. A baseline must fail for the absent witness
or observed 65th read before either mechanism is repaired.

Retained baseline `protected-recovery-witness-baseline`: 10 native cases pass;
the final-authority case observes zero protected assessment witnesses, and the
budget case observes 67 real provider GETs after cold restart. Terminal exit 1;
the entire recorded source set is unchanged. The next candidate keeps the same
64-read oracle. Its history bound is registered as 512 before implementation:
64 members can need 193 intent/attempt/authority/acknowledgment records plus 128
observation claim/result records and terminal responsibility/verification. The
prior 256-history limit could strand that declared domain. This is a bounded
capacity repair; it is not evidence that the 64-member workload has passed.

`protected-recovery-witness-repaired` was stopped after the native S5 dependency
failed to trace the new reconciliation records back to its authenticated attempt.
Its partial results and process-group termination/census remain retained; it is
not a completed qualification. The dependency repair admits only the three
defined protected reconciliation kinds, preserves exact allocation/effect/owner
checks and descending signed parent order, and still requires a genuine ATTEMPT.
The exhaustion challenge now includes native API/S5 notification after restart,
in addition to direct protected recovery. Unknown or unrelated reconciliation
content remains refused. A full unchanged-source rerun is required.
