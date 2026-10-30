# Z1 native integrated session: failure model (written before the session code)

Scope: drive the original Z1 episode (`finnor-os/scripts/project-z/z1/native-e2e.mjs`) through the
integrated candidate's ordinary native stack: pinned real Auth, embedded PostgreSQL, the migrated
application on loopback, the real owner login, mounted Work panels, a scenario-owned queue worker
that is physically killed and restarted, and the S6 obligation chain that Z1 must preserve.
No AWS, no provisioning, no external effect, no protected authority. Evidence is software
engineering evidence of the integrated candidate only; it is not independent qualification.

Every row names a way the run could report success while proving less than it claims, and the check
that closes it. The session code is written against this list. A row that cannot be closed is
reported as a limitation, never as a pass.

## A. Target identity and custody

| ID | Failure | Closed by |
|---|---|---|
| A1 | Manifest names harness or unrelated PIDs, so the guard checks processes that do not own the listeners. | The session derives each PID from the listening socket inode (`/proc/net/tcp*` to `/proc/<pid>/fd`). The existing guard then re-verifies inode ownership, uid, start ticks, executable digest, command line and cwd. |
| A2 | A stock worker or another consumer shares the queue and spends attempts or claims jobs. | The stack runs with `--no-worker`. The queue census is taken by the worker role before the guard and after the run. Every lease owner observed must be `z1-owned-proof:<pid>` of a driver-spawned child. |
| A3 | A SOURCE_DEVELOPMENT run is reported as the separately installed flavor, or the reverse. | The flavor is written by the session into the manifest and is echoed from the guard report. The installed flavor additionally needs both `BUILD_ID` files, production `NODE_ENV` and `FINNOR_Z1_INSTALLED_DEVELOPMENT=1`. The two flavors are reported separately. |
| A4 | The installed-source stamp is older than the files it describes, so the API refuses with `STALE` mid-run, or the stamp binds a different tree than the one that ran. | Stamping is the last step before the guard. The session refuses any modified or untracked file other than generated `next-env.d.ts` files and the three stamp files. It records `HEAD`, tree, `git status`, the archive digest and the integration diff digest. |
| A5 | The target manifest is hand-edited or reused from an earlier run. | The manifest is generated inside the run from live `/proc` data. Its digest is passed to the guard through the environment and written into evidence. A new run name is required, and failed attempts keep their evidence. |
| A6 | Credentials, tokens or credentialed URLs enter evidence or logs. | The private environment file is never copied. Evidence records environment names and digests only. The scenario environment is the runner's minimal base plus named non-secret forwards. The Playwright browsers path is forwarded by name. |
| A7 | The guard rejects the integrated migration names (`postz_*`) because it expects the numbered form, so the target is declared invalid for the wrong reason, or the check is loosened to nothing. | The pattern is widened to the two real naming forms (`NNNN[a-z]_name` and `post[a-z]_name`). The guard still requires the named migration to exist in `_migrations`. |

## B. Database role and queue visibility

| ID | Failure | Closed by |
|---|---|---|
| B1 | The spawned worker connects as `finnor_app`. Row security hides every job from that role, so the worker idles, and the driver's poll sees zero pending rows and stops it at once. A worker that did nothing looks like a clean run. | The spawned worker receives the `finnor_worker` login from `FINNOR_Z1_WORKER_DATABASE_URL`. The driver pool stays `finnor_app`, so the API, driver and tenant checks keep the production role split. |
| B2 | `assertQueueOwned` passes vacuously because the driver pool cannot see the queue. | Queue observations use a separate pool on the worker role. The driver verifies that role is neither superuser nor bypass-RLS, that it is not the application role, and that it is not a member of it in the unsafe direction. A positive control then requires the queue pool to see this request's producer job after the first submit. |
| B3 | A job type other than the two Z1 types, or another tenant's job, is queued before the run (for example from seeding or the S3/S4/S5 chain). | The queue census before the guard is retained. If a foreign non-terminal job exists, the run stops with the exact code. Nothing is deleted or edited to make it pass. |
| B4 | The worker URL points at another database or host. | The guard requires loopback, the same port and database name, a different login from the application role, and no query string. |

## C. Seeding and the S6 chain

| ID | Failure | Closed by |
|---|---|---|
| C1 | The unresolved S6 obligation is inserted by SQL or created without Work lineage, so `originalObligationsTx` is satisfied by a fake. | The only creator is `prepareEnterpriseDurableObligation(ctx, refs, {workId})` after a real S3 fit, S4 synthesis and handoff, and S5 resource and clearing through authenticated HTTP on the running API. The session then reads `s6_obligation_origins`, `domain_actions.work_id` and `body.workLineage.workId`, and requires the third Work to list exactly that obligation and the first Work to list none. |
| C2 | The S3/S4/S5 chain is rooted at the Work's deal, but the S3 owner fixture needs an `external_organization` root. | Revised after evidence: the fit operation revalidates the world belief pin and refuses unless canonical coverage is COMPLETE (`enterprise-beliefs.ts` `validateBeliefViewPin`). The seeded phase-9 organization world is PARTIAL by design (unversioned core document metadata and decision receipts), which the Z4 worker's retained `w4-seed-01`/`w4-seed-02` attempts observed as `S3_FIT_STATUS_404` with `pinStatus: INVALIDATED`. The chain therefore roots at a fresh active `external_organizations` row in the same tenant (vertical assignment is tenant-scoped), whose world contains only this fixture's own evidence — the same shape the S5/S6 owner suites prove. Lineage to the Work stays by `workId`, which is what Z1 reads. |
| C3 | S4 refuses new plans after the first outstanding S6 obligation. | All upstream chain steps for the single obligation finish before it is created. |
| C4 | Creating the obligation changes the Work input, so the fixture's `inputDigest` is stale. | Bindings are read after the obligation exists. The driver re-reads `currentWorkInputTx` and compares. |
| C5 | Seed reruns reuse idempotency keys or rows from an earlier attempt. | A new state directory and run name per attempt. Failed attempts are kept, never reused. |
| C6 | Foreign scope leaks: a Work rooted elsewhere or a foreign root is accepted. | The foreign Work and foreign root come from the seeded phase-9 deal. The driver's existing negative calls (foreign Work, foreign root, raw role, anonymous) must return 403/404, 400 and 401. |
| C7 | S3/S4 store or interpreter configuration is absent from the API process, so the chain fails or silently falls back. | The z1 profile supplies per-run S3 model and S4 policy store directories and the pinned S3 Python to the API process only. The scenario process reads them from the launcher's private environment file. |
| C8 | Added after `w1-native-04` (retained, failed at `s3-s4-s5-owner-chain` with `S5_CLEARING_NOT_FEASIBLE`, API log `POST /api/allocations/clear 200 in 529 ms`, solver never started). The session registered the four Z1 compute resources (hourly horizon, rights `S1:current-owner-assertion`) before the S5 clearing. `clearNumericEnterprisePortfolio` (`enterprise-allocation.ts:119`) refuses unless `input.resourceRefs` equals the tenant's COMPLETE current resource registry (`STALE_INPUT`, `CURRENT_COMPLETE_RESOURCE_REGISTRY_REQUIRED`), and `assertAllocationProblem` (`allocation-contracts.ts:128`) requires every registry resource to carry the mandate's horizon and rights reference. The Z1 compute resources can meet neither, so any enterprise clearing in a tenant that already holds them is refused before the solver runs. | The chain owner (S3 fit, S4 synthesis, cash resource, S5 clearing, S4 handoff, S6 preparation) runs first, while the tenant registry holds only the chain's own mandate-conformant cash resource. The Z1 compute resources are registered after the S6 obligation exists and before the bindings are read; Z1's own budget owner (`reserveOriginalSharedWorkBudget`) reads the resource heads by reference and does not use the enterprise clearing. Nothing in S5 is relaxed and no resource is shaped to fit the clearing. |
| C9 | The clearing refusal is reported only as `S5_CLEARING_NOT_FEASIBLE`, so the cause (`STALE_INPUT`, `INFEASIBLE`, `SOLVER_UNAVAILABLE`, `SEARCH_EXHAUSTED`) is lost and the next attempt guesses. | The failure text carries the returned status and reason codes. The full clearing response (references and reason codes only, no credentials) is retained under `upstream/clear-response.json`. |
| C10 | Registering the compute resources after the clearing makes the S6 obligation, the S5 reservation or the handoff stale. | The obligation is prepared before the registration, and the session reads the obligation's S6 origin, the reservation state and the Work lineage again after the registration. The driver's own stage-0 conservation check remains the authority; a stale obligation fails the episode as a named stage rather than being repaired. |
| C11 | Added after `w1-native-05` (retained, failed at `s3-s4-s5-owner-chain` with `S5_CLEAR_STATUS_500`; API log `POST /api/allocations/clear 500 in 3978 ms`, `unhandled route failure ... column reference "body" is ambiguous`; PostgreSQL log: `CONTEXT: PL/pgSQL function z1_s5_writer_guard() line 7 at SQL statement`, `STATEMENT: INSERT INTO finnor_os.s5_reservation_origins`). With C8 closed, the clearing was feasible for the first time and reached the reservation write. The Z1 trigger function `z1_s5_writer_guard` (`postz_z1_shared_work.sql`) declares a PL/pgSQL variable named `body` and reads `(body->>'tenant_id')` unqualified in a statement that also ranges over `s5_reservation_origins o`, whose column is `body`; PostgreSQL's default `variable_conflict = error` rejects the statement at its first execution. Every S5 reservation write on any `s5_*` table guarded by that trigger fails the same way, so this is a product defect in the integrated migration, not a session artifact, and it was invisible to the earlier runs because no earlier run reached an S5 reservation write. The same class of defect (a variable named like a column read in the same statement) was independently found in the Z0 application bridge functions by the Z3 native run `w3-gov-03`. | The guard function and the Z0 bridge functions state `#variable_conflict use_variable`, with the identical text the Z3 branch carries (`00e106d`), so the three branches merge without a semantic difference; every unqualified `body`/`parent` in those statements already means the variable, and every column read is qualified (`o.body`). No statement is rewritten and no check is weakened. Because a single run reaches only the statements it executes, the rest of the Z1 plpgsql set is read for the same class before the rerun (declared variables against columns read unqualified in the same statement); any further hit is a new numbered entry, found by evidence or by reading, never by relaxing `plpgsql.variable_conflict` for the database. |
| C12 | Added after `w1-native-06` (retained, failed at `stamp-installed-source` with `DECLARED_GIT_IDENTITY_REQUIRED`, 10 s after `materialize-public-fixture`; the S3 fit, S4 synthesis and handoff, S5 clearing with its reservation write, the S6 obligation with Work lineage, the compute resource registration, the bindings read and the fixture materialization all returned OK, so C11 is closed by evidence). The session's `git()` helper runs `spawnSync` with `maxBuffer` 64 MiB and asserts exit status 0, and one of its callers is `git archive HEAD`, which at `cf1ba9a` is 212,408,320 bytes on the remote checkout (measured, 0.9 s). `spawnSync` kills the child on overflow and returns `status: null` with `error.code: ENOBUFS`, so the assertion fired with the identity message instead of the cause. The other helper calls are small (`rev-parse`, `diff --binary` at 119,386 bytes), the declared-input checks in `stamp-installed.mjs` accepted a hand-made equivalent on the same checkout in 1.5 s (dry run, artifacts removed), and the whole-owner walk found 2,972 files and no symlink, so the oversize archive is the single observed cause. Other ways the same step can fail: git exits non-zero (missing base object, detached or unreadable repository), the child times out (120 s), the stream is cut (EPIPE) so a partial archive is hashed as if complete, the streamed digest differs from what a clean reconstruction computes as `git archive HEAD` through a pipe to SHA-256, and a refusal is reported without its cause so the next attempt guesses. | The archive digest is computed by streaming `git archive HEAD` into SHA-256 with no in-memory copy and no size cap, so the value is exactly SHA-256 of the archive bytes (the quantity a clean reconstruction obtains with `git archive HEAD \| sha256sum`); a non-zero exit, a signal or a timeout of that child rejects with its own named code instead of a digest. The small buffered calls keep their bound, and every refusal now names the cause (exit status, signal or error code) after `DECLARED_GIT_IDENTITY_REQUIRED`. The declared inputs and `stamp-installed.mjs` are unchanged, so no identity, digest or check is relaxed, and no value the stamp records changes. |

## D. Expected values

| ID | Failure | Closed by |
|---|---|---|
| D1 | Expected results come from the shared DAG producer, so a producer bug cancels itself. | The driver obtains every expected value from `original-expectations.py`, which re-derives each Work directly with exact fractions. The session does not compute, edit or cache expected values. The oracle outputs are retained and hashed per stage. |
| D2 | The fixture generator and the oracle share a mistake. | The oracle is a separate program run per stage on the canonical request, and its output is compared with the canonical intake read back through the API and with the S3/S4 owner use. |

## E. Time, recovery and budgets

| ID | Failure | Closed by |
|---|---|---|
| E1 | The launcher's 30 minute setup budget stops the application in the middle of the episode, which then looks like a product failure or, worse, a partial pass. | The launcher gets an explicit, bounded runtime budget option. The run records the budget and any stop reason. |
| E2 | A kill is simulated in memory, or the wrong PID is signalled. | The existing driver identity checks stay: rendezvous message with nonce and PID, process identity before signal, SIGKILL exit status observed, three kills at CLAIM, CHECKPOINT and DELIVERY. |
| E3 | Lease or permit lengths are changed, or a retry is spent early, to make recovery pass. | The existing waits (job lease and the 90 second serial permit) stay. The session never edits leases. Both are recorded. |
| E4 | The original deadline, parent reservations or remaining budget are renewed after kills. | The driver's `assertConserved` checks stay and are not relaxed. |
| E5 | Cancellation drops unresolved S6 obligations or LOST_UNKNOWN attempts. | The driver requires three LOST_UNKNOWN attempts and the same obligations after cancel. |

## F. Browser

| ID | Failure | Closed by |
|---|---|---|
| F1 | Chromium cannot start with its sandbox and the run is reported as a product failure, or the sandbox is disabled silently. | The host sandbox capability is probed first and recorded. The driver keeps `chromiumSandbox: true`. A launch failure is NOT_RUN or FAILED with the guard's exit code, never converted. |
| F2 | The network allow-list blocks the Auth origin, so login fails and the driver stops before any mutation. | The allow-list stays frontend, API and `<auth origin>/auth/v1/`. A blocked login is retained as a failed attempt. |

## G. Changes to existing guarded code

| ID | Failure | Closed by |
|---|---|---|
| G1 | A change to the guard weakens a check (process identity, listener ownership, loopback, bypass or provider-credential refusal). | Only these additions are made: the worker URL validation (B4), the queue pool and its role check (B1, B2), and the migration-name pattern (A7). Nothing in the identity, listener, environment or manifest checks is relaxed. |
| G2 | Host guards are skipped (memory, disk, ports), so a failed run leaves listeners that break the next one. | Preflight requires free ports, at least 4 GiB available memory and at least 6 GiB free disk. After the run the ports are checked again and any survivor is reported. |
| G3 | The evidence cannot be rerun. | Evidence names `HEAD`, tree, archive and diff digests, Node, Python and Playwright versions, lock hashes, browser digest, the exact command, the guard report, per-stage independent expected values and observations, physical exits, costs marked UNKNOWN where unmeasured, and the failed attempts. |

## Expected observations for a pass

Seven stages (INITIAL, INSERT, RETRACT, OBJECTIVE_EDIT, WITHDRAW, REACTIVATE, REVOKE) over three
distinct original Works with exact initial, update, edit, withdraw, reactivate and revoke results equal
to the independent oracle; the S3 and S4 owner uses equal the oracle's expected uses; three physical
SIGKILL exits at CLAIM, CHECKPOINT and DELIVERY with three LOST_UNKNOWN attempts retained and stale
claims refused; duplicate intake replay is idempotent; cancellation retains costs and obligations;
foreign, raw-role and anonymous calls are refused; mounted panels reload to the same original Work
identity; sign-out clears the panel. Anything less is reported as the exact stage that stopped.

Not claimed by this run: protected admission, independent qualification, whole-system or financial
100x, production activation, or external-effect behaviour.
