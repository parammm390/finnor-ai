# D1 execution details

This implements the already frozen D1 family without changing its predicates,
native profile, backend, original deadline or qualification population.

- Every subcase creates fresh synthetic originals, participant ledgers, TLS
  identities and a session. No previous attempt or private state is reused.
- Four subcases exercise native dropout, an intentionally mismatched *own*
  TLS keypair, corruption of one encrypted native TLS record, and physical
  coordinator cancellation. All must reach the native runtime, abort every
  participant, leave no accepted release, stop their processes and refuse
  participant replay. An exception before that boundary cannot pass.
- The fault observer follows descendants of its own launched coordinator only.
  It also checks the exact backend executable and participant/session working
  directory. It never enumerates or signals another workstream's processes.
- TLS corruption uses Linux tracing of that owned descendant, changing one
  ciphertext byte at a socket-write syscall. It never reads private input
  files, keys or plaintext messages. No tracing-policy or privilege change is
  permitted. Unavailable tracing is an unpassed observation, not a substitute
  test or permission to relax the native identity checks.
- The campaign assigns one absolute deadline before its first exposure.
  Four conservative native CPU reservations total at most 3,200 seconds;
  supervisors retain their existing memory, CPU and physical-stop bounds.
  Subcases run sequentially. Monetary, human and aggregate-memory measurements
  remain unknown, not zero.
- Inputs, opening nonces, keys and native logs stay under the new attempt's
  `PRIVATE-NOT-FOR-HANDOFF` directory. Shared receipts contain predicates and
  states only. Existing installations and participant assets are untouched.

This local adversarial exercise does not establish independent administration,
protected qualification, source truth, onward admission or production safety.

## Retained observation and affected rerun

Attempt `adverse-001` retained passing dropout and keypair-mismatch cases. Its
message case actually reported OpenSSL's `cipher operation failed (Provider
routines)` at the native receive boundary, but the observer only recognized
other OpenSSL record-authentication error spellings. The attempt remains FAIL.
Accept that exact provider-authentication diagnostic in addition to the
original diagnostics, never a generic disconnect or timeout.

`--faults message cancel` selects only the affected and unrun subcases in a
new disposable verification episode with fresh setup and originals. It cannot
resume an old cryptographic session, erase the earlier failure, claim all four
cases passed in that attempt, or renew a computation's original deadline.
The default still runs all four cases. Selected cases and their conservative
CPU reservations are retained explicitly.

## Setup and partial-verification disposal

Before adding the supplemental E2E cases:

- Supply another local participant's authority path for the second verifier.
  The first verifier must have durably succeeded before the bridge observes
  that refusal. Every nonfinished participant must end ABORTED with no retained
  input/nonce or disposable tape, no disclosure refund and no accepted release.
- Precreate the first participant's exact runtime path as a symlink to a new
  sentinel outside that runtime path. Native setup must refuse after RUNNING,
  burn that participant's secrets and preserve the sentinel and link. Its local
  disposal must refuse the changed custody, without preventing disposal of the
  other participants. These peers may already have delivered inputs, so retain
  their actual disclosure records and never label this a preinput retry.
- Replaying any of these original sessions must fail at the durable verified
  session boundary. Record original deadlines, per-participant disclosure counts,
  verified-before-failure evidence and bounded CPU reservations. Never read
  participant secrets into the fault observer or shared evidence.

These are additional engineering cases, not replacements for the four native
fault cases above or submissions to the protected population.

The supplemental allocation stays at 1,600 CPU seconds total: 700 each for
verification/setup refusal and 100 each for insufficient native memory and
preexisting output-directory refusal. The last two must reach no verifier or
native input. All four retain one preparation disclosure per participant, abort
and burn each exact session, and preserve preexisting custody. Disposal receives
the bounded public bundle over stdin even if the output directory cannot be
created. No failed preparation reservation is reclassified as delivered input.
