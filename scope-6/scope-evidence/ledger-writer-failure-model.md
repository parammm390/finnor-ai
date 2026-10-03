# One ledger writer across stale-lock recovery, registered before authoring

Contract: exactly one separately authenticated ledger process may serve a protected
state directory at a time. Concurrent starts after a dead writer cannot both acquire
the lock or serve/append history. SIGKILL must release kernel ownership without
another process deleting an active writer's lock. An old PID is diagnostic metadata,
not a durable cross-process fencing primitive.

Credible regression: two candidates read the same stale PID; one removes the old
file and claims a new file, then the other removes that new claim and becomes a
second writer. The existing single-process restart and contention append cases do
not start multiple daemons against one state directory. Primary new owning boundary:
actual ledger-server processes, actual same-directory startup and independent HTTP
health. No production hook, fake receipt, prepared callback order or extra export.
Fixtures supply only externally signed disposable configuration and stale lock
metadata. No production key or independent admission is created.

Failure model: multiple READY processes or healthy writer endpoints; startup failure
unrelated to the stale-lock boundary is retained and not called the intended race.
Use four actual Node processes per round, at most 32 rounds and 300 seconds overall,
15-second startup deadlines. The stale regular lock file has a dead, independently
checked PID plus 3 MiB bounded padding to widen actual asynchronous reads; it stays
below the existing 8 MiB protected-file limit. Preserve before/after state, every
actual PID/exit/signal/log/health, exact source/runtime/config hashes and rerun command.
Stop all directly spawned test-owned processes even after an assertion failure.
Zero reproduced races means only bounded empirical stress, not a demonstrated
pre-fix regression; never turn a missing baseline counterexample into a repair claim.

Reuse decision under consideration: POSIX kernel advisory `flock`, using the mature
fs-ext native wrapper rather than inventing another lease engine. Its maintainer's
[API/source](https://raw.githubusercontent.com/baudehlo/node-fs-ext/master/README.md)
documents nonblocking exclusive locks and an NFS limitation. npm reports fs-ext
2.1.1 with integrity `sha512-/TrISPOFhCkbgIRWK9lzscRzwPCu0PqtCcvMc9jsHKBgZGoqA0VzhspVht5Zu8lxaXjIYIBWILHpRotYkCCcQA==`.
No dependency has been installed yet. Inspect exact source/license/build/runtime
identity and version migration before deciding; pin any added native substrate in
the reviewable release candidate. Local same-UID tests do not establish a protected
OS identity, portable build, NFS semantics, release authority or rollback witness.

Baseline `ledger-writer-baseline` reproduces the intended race in round 9: PIDs 27815
and 27817 both return READY and independent authenticated health 200/sequence 0 for
the same state directory. Every directly spawned child is terminated and reaped;
source freeze passes. This is a demonstrated exclusivity failure, not an append
fork claim (no append was requested). Preserve all ten rounds and actual exits.

Selected repair: pinned fs-ext 2.1.1, MIT license, exact published tarball/source
inspected before its native install. The wrapper passes nonblocking exclusive flags
to the actual POSIX `flock` syscall. Keep the lock inode; hold its descriptor for the
whole daemon lifetime; release by closing/SIGKILL, never stale-file deletion. Retain
conservative legacy PID handling only for migration from a still-live v1 daemon.
Empty/torn v2 diagnostic metadata cannot replace kernel ownership. The v2 release
candidate must pin the wrapper, compiled native addon and package metadata as well
as all four existing protected sources, and bind reported runtime ABI/platform.
This runtime report is not an OS attestation. Production release remains external.

Before owner repair, extend the new process test with successor startup against the
same retained inode after all original contenders have been killed. Existing ledger
recovery exercises receipts; this control checks kernel lock release in the same
contention directory. No extra production hook is needed. Native build and NFS/nonlocal
filesystem deployment remain explicitly unqualified. Adding the dependency also
normalizes three existing workspace lockfile entries to their already-present package
dependencies (worker epistemic-runtime, PE artifacts, epistemic-runtime db/underwriting);
no existing installed package version is changed. Exact preimages are retained.
