# PR 187 API cold-route review

Source under review: `f6da3273440945845d4898496a2313cdb121c3a8`.
Tree: `ad7f924127b8e86d5793d5afc3b64440c9a3f863`.

The current W2 run `43795837030`, job `133064328958`, fails on an
authenticated resume request with `ECONNRESET`, before settlement evidence.
The current Z0 run `43795836981`, job `133064329281`, still fails the original
Work display. Its finite receipt records multiple 502 read responses. Neither
is a phase pass. The local exact W2 run also fails before settlement.

## Failure model before changes

Small API routes import package entry points that also export unrelated native
compilers. Their development compilation can retain unrelated module graphs.
Next's launcher and serving worker have separate lifetimes: a living launcher
does not establish an uninterrupted serving worker. Measure that hypothesis
before changing package boundaries; do not infer it from a connection reset.

An actual HTTP cold-route comparison must retain the original heap ceiling and
request limits, call the same unauthenticated routes, require the original 401
denials, and record request times and numeric process memory only. It grants no
authority and cannot establish authenticated acceptance or business completion.
Reject optimizations that change denial behavior, runtime source custody,
module identity, or native acceptance. Do not add retries or extend deadlines.

Independent fixture ownership issue: a portal acquired before MODEL_READY must
be stopped if acquisition throws before its handle transfers to the caller.
The original first error must survive cleanup. Successful handles must remain
owned by the caller. Cleanup is not an application acceptance result.

## Local observations and retained correction

An instrumented run of the original W2 exact owner reproduced a socket failure
before settlement. The Next serving-worker samples stopped before the retained
launcher stopped. Maximum sampled serving-process RSS was 4,486,873,088 bytes;
one sample included 1,951 MiB of ArrayBuffers. This does not establish the exit
signal or prove that heap exhaustion caused the failure. The launcher being
alive did not prove service continuity.

Speculative import/optimization changes were removed after measurement. A
bounded development-cache experiment passed nine original HTTP denials and
advanced the actual W2 owner through the previously failing confirmations.
It nevertheless failed before settlement: closing/read timed out after
100,324 ms against its unchanged 90-second request signal. The independent
checker also recorded SQLSTATE 57014. The serving worker's observed exit was
after that failure during cleanup, not its cause. That experiment is preserved
locally as commit `b49cf96c22258b335c07c86559846cbfc5c0320a`, tree
`461a3515c39f71949500a70b9552f7d7efd2d747`; its cache change is not published.
All six original source preimages restored exactly.

A private database copy of that failed owner then passed the unchanged
ordinary-role read contention probe in 226 ms while a tenant writer remained
held. This rules out treating every read as intrinsically slow or blocked by
that writer. Live transport, process pressure and currentness remain unresolved.
No cache, API heap, timeout, acceptance or business-authority change is retained.

The fixture now retains the acquired portal until its complete handle actually
returns to its caller. Failure during setup, SQL cleanup, model readiness or S4
acceptance stops that portal while preserving the original failure. Process
cleanup has a two-second cooperative drain followed by a two-second forced
drain. Ten real child-process cases pass, including the actual acquisition
portal's 401 denial, read-only 200 and confirmed graceful listener closure.
The tested helper SHA256 is
`3ad952c013790690aa7c101baf3a7105554ef1b4821d0b7b215f728e29877b16`;
rerun with `node scripts/project-z/native-lifecycle.e2e.mjs <new-receipt-path>`.

The finite W2 failure path now labels UUID action confirmations as
`/api/actions/:id/confirm`. Actual local timeout, refused-connection and child-exit
checks pass; identifiers and arbitrary messages remain excluded. This closes
an observation gap, not settlement.
