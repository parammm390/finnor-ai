# Engineering receipt-controller validation

This is not a FINNOR product or remote-platform qualification.

## Failure-first record

`failure-model.md` records the contract and eighteen credible failure classes
before controller implementation. `e2e_controller.py` was authored before
`control.py`. Its first retained run failed with a missing implementation:

`scope-z/orchestration/evidence/controller-594e4ba0ccd347448b330081935c342e/report.json`.

That failure is not erased or reclassified as a product defect.

## Implemented and checked

The first implementation passed all 35 then-defined subprocess cases:

`scope-z/orchestration/evidence/controller-80ec06827ef946fcbb4abafa918af54a/report.json`.

Inline source inspection then identified an additional custody concern:
idempotent events and later status must not mask substituted descendant evidence.
The controller now checks the accepted receipt tree again; two further
subprocess E2E cases exercise that concern. This is not a post-code unit suite.

The current cut passes **37/37**:

`scope-z/orchestration/evidence/controller-200ead96a9c5426f9ad4a1ca8e5e15e6/report.json`.

The report records exact controller/driver SHA-256, planned/observed cases,
inputs, process invocations, exit codes, before/after state hashes and rerun.
It includes:

- immutable member, missing-lock and symlink rejection;
- explicit simulation/live separation;
- exact initial group, three-slot reservation and actual-start separation;
- staged/wrong-model/missing-role/duplicate-Computer rejection;
- event idempotence and conflicting-payload rejection;
- accepted evidence-byte substitution rejection, including repeated events;
- certification independent of scheduling;
- interruption and same-parent continuation, with reset rejection;
- ownership, source-cut and incomplete-internal-software rejection;
- two truly concurrent handoff subprocesses, ordered Z3/Z4 refill and no fourth slot;
- Z5 refill before deep certification and no duplicate refill;
- lost launch acknowledgement retaining the original intent/slot;
- a real forced process exit after fsynced immutable snapshot but before pointer;
- fail-closed orphan detection and exact immutable successor recovery;
- malformed current state rejection and retained snapshots.

The implementation additionally bounds state/file sizes, pins the product
digest, requires reviewed execution-pack identity at live initialization and
refuses stale live start observations. Those guards are source-inspected;
the 37-case fixture suite does not claim a live service observation, live
freshness trial or arbitrary-filesystem-adversary proof.

## Remaining limitations and authority

The controller **records supplied observations**. It cannot cryptographically
authenticate Factory receipts, inspect a remote Computer on its own, or prove
that a producer's verification label is true. Actual service/runtime facts,
source scrutiny and independent qualification remain necessary.

There is no remote provisioning/session-creation/message adapter hidden in this
controller. Supported platform operations must be performed separately under
the exact current authority; full immutable seeds are the fallback.

All platform entities in E2E are explicitly SIMULATED. There is no Z execution,
product correctness, protected S8 admission, operational gain or financial result
in these reports. No Computer was provisioned and no external effect occurred.
