# Batch 171: actual installed-context failure and repair

Published head: `6a212bb31f5ddbdaac0778e15422b418b5662599`.
Run: https://github.com/parammm390/finnor-ai/actions/runs/38925000756 .
Synthetic merge/image source: `de3bcf344ec1b7a8c2b2c6d8b29e9ffb55470382`.
Every applicable job passed except worker-image and its required verdict.
Optional database-role-qa was skipped. No main merge/deployment occurred.

The image compiled; all four class health/shutdown checks passed. All five S6
cases refused `ISOLATION_LAUNCHER_REFUSED:CALLER:0` before untrusted execution.
R1/P1/R3/R4 installed owner stages were not reached. No inherited pass.
Artifact 12057770032, 25,014 bytes, SHA256:
`5f492ff2a2250c4ec05c33d7127900407857f9d3860a2bf84568333c4bd60b59`.
Exact raw artifact is retained as `hosted-batch-171-failure/worker-image.zip` in
the chat artifact root, with safely extracted evidence and original failures.

Cause: the direct S6 Node driver is container PID 1. The helper incorrectly
required getppid > 1. Earlier native child-supervisor evidence did not cover
this context. Linux kills the namespace's processes when its PID-1 init exits:
https://man7.org/linux/man-pages/man7/pid_namespaces.7.html .

Repair accepts a positive parent PID only when it matches a pre-bound original
supervisor PID. Retain nonroot UID/GID, exact SYS_CHROOT then zero capabilities,
unchanged-parent/PDEATHSIG, no-new-privileges, Landlock, filter-byte digest and
all syscall restrictions. This also refuses adoption by PID 1 after an ordinary
original parent dies before helper setup. No init/profile/capability override.

The two call paths are distinct:

- S6: driver Node -> fixed helper -> confined Node. Bootstrap parent must equal
  the S6 driver PID, including when that driver really is PID 1.
- P1: owner Node -> physical Python supervisor -> fixed helper -> confined Node.
  Python validates the original owner binding, then binds the helper to its own
  PID. R2NativeSession checks the bootstrap parent against the independently
  observed Python child PID and records both owner/supervisor identities.

CodeRabbit reported one major concern confusing these paths, suggesting S6
compare against Python. Source inspection shows S6 directly spawns the helper,
not Python; the actual two native runs below independently confirm its parent.
The suggested assertion change is therefore not applicable. No predicate is
removed to satisfy review. P1 remains an independent installed-image gate.

Native repair proof: task `ffaee6148740451db3f359c4ef232981`, definition
`finnor-isolation-probe-cac788902edf45d7:1`, us-east-1. All ten actual S6 cases
PASS across child driver PID 642 and actual PID-1 driver. Both run UID 1000;
bootstrap parentPid values independently match 642 and 1. Capabilities are 0,
noNewPrivileges 1, Landlock ABI 2. Same mandatory filter hash as the predecessor.
Task stopped exit 0; definition deregistered/deletion requested; exact logs
retained before their stream removal; cleanup succeeded. No production changes.

Proof source SHA256, relative to finnor-os:

- C helper: `7a02833e1a06060f9112389813b989f7598903c0f85648444aa92d25d835a7b0`
- Linux adapter: `5c1efbb05f9cca16b0d8aef30d8ad9173cc4c81a5475348846fcbbaa23c2da62`
- S6 driver: `f442f049eb04a3ccf8b2e24f6e250a07d0ba45a56a278314458af28863a5ae27`
- Native helper binary: `b1464dc018b52763c9d6f04755b4ac6f3a39ce159d7617953137545cf32a9e9d`

Retained result SHA256:
`134b3cafd08a4b9f24041793afb133b2a6fe943bba5f6275ce9b729fc20a8137`.
Source-freeze SHA256:
`8b1ef44744be224ed74f7e615fe87d77379c5e57bf6ecebf72b2110cec89758d`.
Reproduce with retained `build-launcher-context-proof.mjs`, then
`run-fargate-isolation-probe.mjs --launcher-verification`. Original failures,
context/PID records, source-before/after, all execution receipts, raw paginated
logs and cleanup are in `finnor-isolation-probe-cac788902edf45d7`.

A larger combined P1 transport was rejected by ECS's 65,536-byte definition
limit before any definition/task was created. That preflight failure is
retained in `finnor-isolation-probe-599ec59fce9e4911`; cleanup confirms no task
or production mutation. Native proof explicitly omits P1, installed owners,
production and protected admission; it is not relabeled as their acceptance.
The existing four P1 tests remain in the final image gate, with unchanged
750ms deadline, physical accounting, readonly scratch and cancellation.

Backend types and four macOS P1 cases pass on the repaired source. Linux P1,
installed R3/R4 and the required exact-head verdict remain pending. Live
frontend/API are still the old release; no protected activation is performed.
