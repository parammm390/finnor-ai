# Runtime repair — not production acceptance

Starting head: `59214832fa7faa6981cfd8f9f2ccd1c3e4a69a94`, existing PR 129.

Fixed the confirmed ABI selector: native kernel CPU fields replace execution
of an emulated ARM64 uname. A native x64 worker now selects native x64
bubblewrap/Node. Only translated x64 workers on actual ARM64 kernels use the
existing sealed supplemental runtime; unsupported/unknown combinations refuse.

Ported R5 P1 to the existing Linux isolator, using read-only scratch and its
original R2 physical supervisor. Only the consumed seccomp descriptor is
forwarded. CPU, memory, call, deadline, checkpoint and independent checker
semantics remain unchanged. Added a short actual installed P1 gate before
expensive owner campaigns, without changing container security settings.

Actual E2E also exposed Darwin `killpg` EPERM after direct-child exit. The
repair preserves live-child refusal and independently observes group drainage.
Unknown physical receipts remain UNKNOWN; bounded supervisor diagnostics are
retained privately. The failed deadline and premature-cancellation runs remain
in the task artifacts; no deadline was increased to make them pass.

Evidence root:
`/Users/paramdave/.codex/visualizations/2026/10/15/01a1404a-0156-7020-915c-9b2c9f148554`.

- `linux-runtime-repair-p1-final-cut-macos`: all four actual physical cases PASS,
  including the original 750ms deadline and observed-child cancellation.
- `linux-runtime-repair-s6-macos`: all four existing hostile executor cases PASS.
- `linux-runtime-repair-ci-process`: all eight process E2Es PASS.
- Kernel identification fixtures PASS; backend TypeScript check PASS.
- Full generated release preflight and relocated worker-layout E2E PASS.
- macOS evidence is not installed Linux, native exact-solver, owner, economic,
  protected effect or deployed acceptance. Source snapshots and replay commands
  are retained with each physical run.

CodeRabbit reviewed the seven-file change and raised one conditional issue:
missing FINNOR_R2_PYTHON. The image already defines its pinned value in
Dockerfile.worker, so that condition is false. The follow-up review covered all
eight changed files including teardown/readiness repairs and raised 0 issues.

Native Linux namespace execution remains unverified. Docker's default seccomp
profile restricts clone namespace flags, mount and unshare without SYS_ADMIN:
https://github.com/moby/profiles/blob/main/seccomp/default.json . Fargate does
not allow adding SYS_ADMIN:
https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html .
This is a platform compatibility risk, not evidence of a native Fargate failure.
Do not disable isolation, add privileges, skip owner acceptance, or deploy this
unqualified candidate. No new AWS probe was authorized or launched. No new
PR, push, workflow run, production task or protected activation is part of this
local repair. A separately authorized bounded credential-free native Fargate
probe is the previously proposed next qualification step, not an approval to
change the production execution substrate.
