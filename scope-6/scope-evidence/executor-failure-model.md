# S6 isolated executor candidate, registered before implementation

Decision: reuse installed macOS Seatbelt via sandbox-exec for a local code-worker
confinement candidate; do not build a hypervisor. Node executes an arbitrary script
in a private scratch directory, receives only serialized bounded obligation input,
has an explicitly empty credential environment, inherited stdio pipes only, no
network permission, no host writable path, no protected or business database/key
path, and child processes inherit the sandbox. Output is untrusted IR/provenance,
never authority, verification or a settlement receipt. No provider SDK is mounted.

Inherited trust: macOS 26.6.2 kernel/Seatbelt, exact installed Node/runtime files,
trusted supervisor and its file descriptors. macOS App Sandbox documentation is
not evidence that an arbitrary Seatbelt profile is correct; the actual adversarial
process is the qualification oracle. sandbox-exec is not a supported portable
production substrate or a memory/CPU/pid quota mechanism. Code admission remains
unsupported for production until these gaps and independent release are resolved.

Primary comparisons: https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox
and https://gvisor.dev/docs/architecture_guide/security/ . gVisor provides a
Linux isolation substrate whose exposed filesystem/network configuration still
needs exact business enforcement. No installed Linux/container runtime exists
here. No cloud resources are created, and neither system implies effect authority.

Failure families: direct TCP/HTTP including loopback/database and redirected
transport; reading a supervisor credential/private key; writing public/ordinary or
protected host files; parent-relative and symlink traversal; inherited environment
or descriptors; child privilege amplification; arbitrary action-shaped output;
wall timeout, output flooding and process death leaving children; body/script
replacement after admission. All output remains untrusted. A successful denial
alone does not prove CPU/pid/cross-process/side-channel protection.

Local budgets: 1 MiB script/input each, 128 KiB stdout/stderr combined, 10-second
wall time per worker, Node 128 MiB old-space (explicitly not total memory), maximum
4 active supervisor jobs. No paid providers. Scratch occupancy measured on exit
and bounded by the execution deadline, not hard disk quota. Resource gaps are
explicitly retained. Executor provenance includes input/script/profile/Node hashes,
OS version, elapsed/CPU/RSS accounting scope, exit/signal and costs unknown.

Authoring gate: (1) actual hostile OS processes cannot read supplied secret files,
reach an independently listening TCP observer, write outside scratch or escape
through a child; (2) broader profile/mounted credential paths/inherited secrets
make the oracle observe a leak; (3) current broker fixtures do not launch hostile
isolated code, so this is a distinct owning-boundary test; (4) no test-only seam,
use the actual supervisor launcher. Preserve all existing browser/tool evidence.
Positive control must compute and write within scratch. Negative controls must
attempt actual syscalls, and the independent listener/filesystem must remain
unchanged. No self-reported BLOCKED flag is sufficient. No unit tests.

## Detached process lifetime registration

Extend the same actual supervisor E2E before changing its profile. Contract: a
pure Node worker cannot amplify process authority or create a detached descendant
that survives its 1-second registered wall limit. Credible regression is the current
allow-process-fork profile plus group-only termination: an allowed Node descendant
can create a new process group/session, detach its stdio, and survive parent death.
The existing child probe only observes denial of one outside-file write; it does
not inspect lifetime/PID occupation. No production seam is added. Launch the actual
isolated worker with a unique descendant command marker, then independently inspect
the exact PID/command/UID/parent/group via the host OS. The producer's printed PID
is only a candidate lookup, never proof of absence or survival. Record this lookup,
worker input/provenance, deadline and process state. Clean up only a confirmed
test-owned marker-bearing descendant, even when the baseline assertion fails.
Do not use that cleanup as evidence that production supervision enforced the limit.

Failure model: no-child or prompt process-creation denial is acceptable for this
pure-code class; nested work requires a separately owned obligation. An escaped
Node process, missing independent lookup, ambiguous PID reuse or unbounded test
cleanup cannot qualify lifetime protection. The initial bootstrap/runtime and
ordinary computation must still pass the existing positive control. Refusing fork
does not establish hard aggregate thread/memory/CPU/disk quotas or protected admission.

`executor-detached-child-baseline`: existing three cases pass, lifecycle case fails
at the intended boundary. The real OS lookup finds PID 22310, parent 1, process
group 22310, UID 501 and the exact unique Node command marker after the supervisor
wall limit. Confirmed test-owned manual SIGKILL cleans up the baseline descendant;
that cleanup is explicitly not production enforcement evidence. Preserve the
input script, profile/runtime source identity and independent OS record. Repair
the pure-worker process-creation policy rather than claim process-group killing
controls arbitrary descendant sessions. Aggregate memory/thread/CPU/disk controls
and independently reviewed resource/admission substrate remain unresolved.

The first repaired run is retained as an unqualified harness failure: the actual
worker stderr records a synchronous `spawn EPERM` thrown by Node, but the challenge
only registered an asynchronous error listener. No production policy is weakened.
The challenge now captures either Node error path, requires a definite permission
refusal, and independently runs a host process census for its unique descendant
marker even when no PID is emitted. The marker census is needed because a worker's
self-reported refusal alone cannot establish that no descendant survives. The
original positive, filesystem/network, deadline and output probes are retained.
