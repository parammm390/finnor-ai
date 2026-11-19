# Guarded existing-target Z4 replay

`reconstruct.py replay --repository /absolute/source --evidence /new/private/run`
exits **78** without a valid explicit authority manifest. It does not initialize
DB/Auth, create users, change grants, run migrations, start listeners or invent
owners. No authority manifest or grant receipt is supplied by this phase.

The executable path is `native-e2e.mts`, not a refusal-only stub. It checks a
strict `finnor.z4.replay-authority.v1` manifest, `fixture:false`, at most one-hour
expiry, complete current source/native hashes, actual source or installed
provenance, exact frontend/API build-ID files, existing loopback target and real
same-project Auth. The target receipt also pins the exact Chromium executable
and its SHA-256, so no inherited browser cache can silently supply a binary.
A coordinator-owned receipt must exist at
`scope-z/orchestration/replay-grants/z4/<receipt-sha256>.json`; the independently
supplied `FINNOR_Z4_REPLAY_AUTHORITY_SHA256` must match it and its exact scope
digest. Builder fixtures, credentials alone and an open port cannot unlock it.

The manifest schema is executable in `replay-authority.mts`. Its scope includes
two to eight **existing original Work/input/plan** cases, including real S3 and
S4 use, public original-history input/literal expected-value files and their
custody provenance, at least one producer recovery and one owner-ack recovery,
and at least eight exact tenant/private-use/authority/currentness/budget/
cancellation/unsupported/incomplete negative cases. Tenant and authority
negatives require genuinely distinct authenticated actors. No builder
authored case becomes an independently protected definition.

After authorization it:

1. Signs the real owner into mounted CENTROPY and verifies the returned identity.
2. Selects the exact existing WORLD Work and submits through its mounted panel
   when no original proof session exists. No write is retried on uncertainty.
3. Uses the real queue, shared compute contract and original job claim/fence.
   The requested shared `original-job-scope-v1` seam narrows **every claim and
   recovery candidate** to that tenant/job. Missing wiring fails closed.
4. At durable claim/checkpoint boundaries, physically SIGKILLs only its own
   recorded IPC child, observes its actual exit, waits for canonical lease
   expiry and resumes the same original job. No budget/deadline is reset.
5. Compares the real original owner history with the separately supplied literal
   oracle, invokes the pinned independent verifier, then invokes actual S3/S4.
6. Kills its authenticated consumer child after independent native result
   persistence and both native guard acks, **before delivery acknowledgement**.
   Exact-key redelivery must independently re-read and acknowledge that same
   persisted native result/use ID, not recompute or replace it. An unresolved
   delivery without a known result stays UNKNOWN and refuses blind replay.
7. Requires canonical query execution, the exact Plan CompletionProof, reloaded
   mounted result and retained S5/S6 responsibility. Runs each negative against
   the registered exact HTTP status and predicate.

Every child is finite and listener-free. Before native input is sent, its
separate supervisor process group is independently recorded and acknowledged
over the owned IPC channel. Cleanup uses its actual Linux start ticks to avoid
signalling a reused PID. It kills recorded native groups as well as the Node
child, and parent-channel loss stops an active prover. `process-control.mts`
exercises that equipment with real public offline processes, not an owner.
The runner strips ungranted provider,
telemetry and inherited process environment before runtime imports. Logs and
screenshots stay private under the explicit evidence directory. Credentials
and bearer tokens are never written to evidence. Failure and NOT_RUN are not
qualification. Source and independently installed replay need separate grants,
identities, reports and actual observations.
