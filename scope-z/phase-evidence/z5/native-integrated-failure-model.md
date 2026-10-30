# Z5 native integrated run: failure model (written before the session script)

Scope: running `finnor-os/scripts/project-z/z5/native-e2e.mjs` on the integrated candidate (request 07 applied, e481133) against an ordinary disposable native stack (embedded PostgreSQL 55441, real pinned Auth 54321, API 3101, frontend 3001, runner `--no-worker`). This note lists how the run can be faked or can fail and the independent expected outcome. Expected outcomes are written from the PRD/owner contracts and the DB, never from the producer's own output.

Coverage limits carried into every report: sound-subset context, finite-path nonblocking, exact-listed-kernel correspondence, 84 distinct inputs (not 256 fresh), LOCAL FILE journal recovery is not native queue/S5 recovery. No acceptance, protected admission, 100x or activation is claimed.

## Decision: the `s8` owned process
Z5 calls the ORIGINAL S8 lifecycle (`packages/capability-evolution/src/server.mts`) over loopback HTTP (`native-s8.ts` -> `POST /command` `Z5_COMPOSITION_ADMIT|CURRENT`) and reads S8/S4/S5/S6 references through the S6 ledger (`readOwnerTransportReference`). S8 is therefore a real separate process, so the driver's `ownedProcesses.s8` guard (pid, port, source head, cwd under repo, same uid, listening socket inode owned by that pid) is correct and is NOT relaxed. The session must start the real lifecycle process (plus the real S6 ledger it commits to) and identify the pid that actually owns the listener from /proc. A guard relaxation was rejected: it would let a missing S8 pass.

## Failure/fake cases

| # | Way to fake or fail | Independent expected outcome |
|---|---|---|
| F1 | Fake s8 pid (any live pid, the driver itself, the shell) | Guard rejects: the pid's `/proc/<pid>/fd` has no socket inode in the LISTEN table for the declared port. Session writes only pids found by scanning `/proc/*/fd` against `/proc/net/tcp*` for the real port owner. |
| F2 | Borrowed listener (the s8/api/frontend entry points at the launcher parent or another worker's process) | Guard rejects on inode ownership or cwd outside repo; session resolves the actual owner pid of ports 3001/3101/S8 and refuses to start if the port was busy before it started the process. |
| F3 | Wrong DB role: worker child runs as `finnor_app` or driver pool as `finnor_worker` | Worker cannot claim jobs globally (RLS) -> request never leaves the queue; driver pool assert `current_user='finnor_app'` fails. Fix: worker child gets `FINNOR_WORKER_DATABASE_URL` (role `finnor_worker`), driver pool and API stay `finnor_app`; recorded `current_user` values are in evidence. |
| F4 | Stock worker also running (steals claims) | `--no-worker`; session asserts no `apps/worker` process before the run; claim attempts in `z5_link_attempts` must be exactly the driver-owned worker pids. |
| F5 | Authority file forged beyond the declared disposable scope (invented signer/grant/protected admission, wrong sourceHead, expired, non-loopback DB) | Authority contains only the operator declaration for this disposable stack; sourceHead equals `git rev-parse HEAD` of the remote worktree (committed tree, synced before run); guard failures stay failures. No signer/grant is invented. |
| F6 | Expected values taken from the producer (artifact digest, certificate, replacement from the worker output) | Driver asserts against durable rows read through RLS and the frozen/owner contracts (`z5_link_requests/episodes/attempts/events`, `compute_resource_leases`, queue rows); session never feeds producer output back as expectation. |
| F7 | Allowance reset after kill (attempts or quota restart at 0; fifth delivery succeeds) | Attempts stay 4 after three kills + final; fifth submit with new idempotency key -> 202 `INCOMPLETE`, `requestId:null`, `newAllowance:false`. |
| F8 | Lease shortened or stolen (row deleted/updated to skip waiting) | Next worker claims only after `native:z5-institution-linker` lease expires/is released by the owner path; driver reads lease through tenant RLS; session never writes the lease table. |
| F9 | Deadline renewal (original deadline moved on retry) | `originalDeadline` of request/episode/reservation unchanged across 4 attempts (driver compares to authority value). |
| F10 | Stale S6 callback treated as acknowledgement | Delayed original S6 callback after the AFTER_REPLACEMENT kill makes the request `STALE`, adds observation events not in the snapshot; stale `institution-link-use` refused (>=400); obligations retained; no consumption acknowledged. |
| F11 | Callback faked by direct DB write | Callback comes only from the real S6 dispatch/reconcile mechanism (ledger + broker + loopback TLS provider with lost response -> UNKNOWN, later reconcile). Session performs no inserts into S6 tables. If this cannot be arranged it is reported NOT_RUN with the exact gap. |
| F12 | Cancelled request consumed (admit/use/plan after cancel) | 4xx on each, durable-state digest identical before/after. |
| F13 | Cross-tenant read (second owner reads first tenant's request/Work) | 403/404; second tenant has `tenantId != identity.tenantId` (separate tenant row, separate Auth user) or the step FAILS as `second tenant not distinct`. |
| F14 | Second tenant not distinct (same tenant, second user) | `otherIdentity.tenantId == identity.tenantId` assertion fails the run; session creates a genuine second tenant via the product bootstrap path. |
| F15 | Private result survives sign-out / root switch (panel DOM or storage) | After UI sign-out and alternate Work/root switch, panel DOM has no first-Work artifact digest; reload shows only the permitted state. |
| F16 | S5/S6 obligation dropped by replacement/live-state bridge | `obligationRefs` identical in request, certificate and handoff after replacement; settlement/obligations remain after stale and cancel. |
| F17 | Credential in evidence (tokens, passwords, DB URLs, private keys) | Private files 0600 under state dir; evidence directory scanned for password/token/JWT/URL-credential patterns before export; commands never echo env. |
| F18 | Source changes while processes run (loadedBuild mismatch) | No source edit after sync until the run ends; each attempt syncs a committed tree and records HEAD. |
| F19 | Mixed run: stale processes or port reuse from a previous attempt | `native-run.sh` aborts exit 75 when ports are busy; every attempt has an immutable name; failed runs are kept. |
| F20 | Evidence directory escapes `scope-z/phase-evidence/z5` | `e2e-tools.mjs evidenceDirectory` realpath check; session writes to `<worktree>/scope-z/phase-evidence/z5/native-integrated-<name>` and copies sanitized artifacts to `FINNOR_NATIVE_EVIDENCE`. |
| F21 | Session fabricates upstream S3/S4/S5/S6 objects by direct SQL | Upstream objects go only through owner routes/libraries (S3 fit, S4 synthesize/handoff, S5 clear, S6 prepare with Work lineage). A step the owners refuse is a FAIL with the owner's refusal recorded, not patched around. |

## Expected observable per driver step (PASS only when independently observed)
login; pool role; contract register 200; submit 202 + conflicting preimage 409 `Z5_ORIGINAL_IDEMPOTENCY_CONFLICT`; kill AFTER_CLAIM; kill AFTER_CERTIFICATE; kill AFTER_REPLACEMENT; final worker -> `USED`, queue `completed`, 4 attempts; composition-plan 200 + `S4_ORIGINAL_COMPOSITION_PLAN_CONSUMED`; non-mutating reads; fifth delivery refused; mounted panel + alternate Work; second tenant denied; sign-out; delayed callback -> `STALE`; stale use refused; cancel; post-cancel refusals; revoke -> `REVOKED` visible after reload. Anything not reached is NOT_RUN with the blocking step named.

## Defects expected a priori (each gets an entry before its fix)
D1. Driver spawns the worker with the driver's `DATABASE_URL` (finnor_app) -> fix in `z5/native-e2e.mjs`: worker child uses `FINNOR_WORKER_DATABASE_URL`.
D2. Launcher has no `z5` profile -> add localized `// BEGIN z5-native` block (profile whitelist plus env paths).
D3. Evidence directory restriction vs runner evidence dir -> scenario copies.
