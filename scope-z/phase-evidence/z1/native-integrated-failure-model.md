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
| C2 | The S3/S4/S5 chain is rooted at the Work's deal, but the S3 owner fixture needs an `external_organization` root. | The chain uses the seeded phase-9 external organization of the same tenant. Lineage to the Work is by `workId`, which is what Z1 reads. |
| C3 | S4 refuses new plans after the first outstanding S6 obligation. | All upstream chain steps for the single obligation finish before it is created. |
| C4 | Creating the obligation changes the Work input, so the fixture's `inputDigest` is stale. | Bindings are read after the obligation exists. The driver re-reads `currentWorkInputTx` and compares. |
| C5 | Seed reruns reuse idempotency keys or rows from an earlier attempt. | A new state directory and run name per attempt. Failed attempts are kept, never reused. |
| C6 | Foreign scope leaks: a Work rooted elsewhere or a foreign root is accepted. | The foreign Work and foreign root come from the seeded phase-9 deal. The driver's existing negative calls (foreign Work, foreign root, raw role, anonymous) must return 403/404, 400 and 401. |
| C7 | S3/S4 store or interpreter configuration is absent from the API process, so the chain fails or silently falls back. | The z1 profile supplies per-run S3 model and S4 policy store directories and the pinned S3 Python to the API process only. The scenario process reads them from the launcher's private environment file. |

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
