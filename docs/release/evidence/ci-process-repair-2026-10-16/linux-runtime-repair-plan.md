# Native Linux repair: finite verification

Before implementation, the observed failures are: emulated ARM64 `uname`
selects ARM64 binaries on an x86 kernel; R5 P1 rejects Linux before execution.

Failure model: native x64 must not consult an emulated binary; ARM64 kernels
with translated x64 Node require the sealed ARM64 callee; conflicting, missing
or unsupported kernel identification must refuse; supplemental manifest or
binary custody failures must refuse. R5 must retain its original physical
supervisor, CPU/memory/call/deadline charges, cancellation and exit receipt.
Only the seccomp descriptor may cross the supervisor, and programme scratch
must be read-only. No privileges, host credentials or protected authority may
be added. Missing namespace support remains a failure, not a fallback.

Finite checks: kernel-identification fixtures (native x64, ARM64, conflicting,
unknown); actual P1 arithmetic/input, filesystem/network/process refusal,
deadline and cancellation via R2NativeSession; existing S6 executor challenges;
backend types; generated release contracts and existing CI process E2Es.
Retain exact source digests, input, physical receipts and rerun commands.
macOS execution is regression evidence only, never installed Linux acceptance.
Existing installed R3 owner cases remain required and unchanged. A Linux
failure is not permission to relax the enclosing container or deploy anyway.

The actual deadline challenge exposed a separate Darwin teardown failure:
`killpg` can return EPERM after the direct child exits. Retain the failed runs
and bounded supervisor traceback. Suppress that signal error only when
`Popen.poll()` independently observes direct-child exit; retain the existing
process-group census before asserting physical release. Never suppress EPERM
for a live child or infer that an exited parent proves descendant release.
