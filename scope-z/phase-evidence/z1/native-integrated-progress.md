# Z1 native integrated session — progress note

Scope: Z1 only. This note records engineering state, not admission. No protected
authority, qualification, 100× or activation is claimed here or by the run.

## Branch

`w/z1-native`, coordinator-owned. Base: integrated candidate `a5209ab`.

- `7e88d22` failure model `scope-z/phase-evidence/z1/native-integrated-failure-model.md`
- `f8f296e` merge of the Z4 native stack support (auth-tls, production build, z4 profile)
- `6ec7669` z1 profile carries the S3/S4 owner stores (`--s3-python`, stores under
  state `z4-stores/`), bounded `--budget-ms` (600000–7200000) on launcher and runner
- `75b1fe6` queue census and owned workers on the separate `finnor_worker` role:
  guard requires `FINNOR_Z1_WORKER_DATABASE_URL` (loopback, same database, the
  manifest's `database.workerRole`, distinct from the application role), verifies the
  application processes never hold it; driver verifies the worker role is
  nonprivileged and not the application role, checks the census against the
  tenant-scoped view (positive control), spawns owned workers with the worker role
  URL; migration-name pattern accepts the `post`-series files; README updated
- `86fb6ab` `finnor-os/scripts/project-z/native/z1-session.mjs` scenario

## Session scenario design (z1-session.mjs)

1. Reads `native-environment-01.private.json` (requires the launcher run with
   `--no-worker`, z1 profile and `--s3-python`), asserts scenario-owned workers.
2. Real Auth password grant; `/api/centropy/me` owner identity.
3. Product-library seeding (app role): deal rooted at the phase-9 target
   organization `90000000-0000-4000-8000-000000000027`, one active investment case,
   three original Works + one foreign-root Work, five canonical evidence sources,
   four S5 compute allocation resources (logical/cpu/storage/memory).
4. Real S3 fit → S4 synthesize → S5 resource/clear → S4 handoff over authenticated
   loopback HTTP on 3101, via `createUpstreamFixtureSupport` in existing mode
   (root = a fresh active `external_organizations` row in the same tenant; the
   seeded phase-9 organization world has PARTIAL canonical coverage, which the S3
   fit gate refuses — observed by the Z4 worker's retained `w4-seed-01/02`
   attempts; admin client sets `app.test_vertical_mode='explicit'`; pinned
   `FINNOR_S3_PYTHON` generates the reference rows). The fit/synthesize stores
   come from the launcher.
5. One unresolved S6 obligation bound to Work 3 through
   `prepareEnterpriseDurableObligation(..., { workId })` in the scenario process
   (the HTTP prepare route takes no workId), verified in `domain_actions`,
   `business_effects`, `s6_obligation_origins` (`workLineage`).
6. Bindings read after all seeding (authority revision stable), fixture
   materialized offline by `make-native-fixture.mjs`, installed source stamped by
   `stamp-installed.mjs` with declared reconstruction input (HEAD commit/tree,
   `git diff --binary a5209ab HEAD`, `git archive HEAD` digests).
7. Target manifest pins: SOURCE_DEVELOPMENT flavor, loopback frontend/API, same
   auth origin, database name/port/role/workerRole, fixture digest, applied
   migration head, native schema digest, `z1_%` catalog digest, browser executable
   digest, and the three listener processes by `/proc` (pid, start ticks, uid,
   executable digest, port, command-line digest, cwd).
8. Queue census on the worker role must be empty before the episode (exclusive
   queue custody), then `z1/native-e2e.mjs --report <new dir>` runs the guarded
   driver (ORIGINAL_EPISODE: seven stages, three physical SIGKILLs at
   CLAIM/CHECKPOINT/DELIVERY, duplicate replay, cancellation, stale-claim refusal).

## Runs (remote verify host, one stack at a time)

- `w1-native-01`: never started. Killed while still queued (before any evidence or
  state directory existed) because the chain root was revised after the Z4
  worker's retained `w4-seed-02` diagnosis showed the S3 fit gate refusing the
  seeded phase-9 organization's PARTIAL-coverage world. No processes, evidence or
  database were created under this name.
- `w1-native-02`: first real attempt, at the amended session commit.
  Evidence: `fzv-int-out/native/w1-native-02/` and its
  `scenario-01/z1-native-e2e-report-01/`.
  Rerun shape (new immutable name each attempt):
  `native-run.sh <name> z1 finnor-os/scripts/project-z/native/z1-session.mjs
  --no-worker --budget-ms=7200000 --forward-env=PLAYWRIGHT_BROWSERS_PATH`
  with `PLAYWRIGHT_BROWSERS_PATH=/home/factory-user/repos/fzv-browsers` and the
  pinned `FINNOR_S3_PYTHON` exported.

- `w1-native-02`: FAILED_RETAINED at the runner resource guard
  (`UNCHANGED_RESOURCE_GUARD`, 3.82 GiB free < 4 GiB required on the remote). No
  scenario executed. Infrastructure, not product: five concurrent workers had filled
  the disk. Retained at `fzv-int-out/native/w1-native-02`.
- `w1-native-03`: FAILED_RETAINED in 2 s at `REAL_AUTH_AND_DATABASE`. The pinned Auth
  starter `realpathSync`s the parent of its state directory and this remote worktree
  had never held a certification run, so `.centropy-certification` did not exist
  (`ENOENT`). Fixed in the runner by creating the state root (commit 21289e0).
- `w1-native-04` (head 21289e0): the scenario ran. Owner login, owner identity and the
  Work/source seeding passed; the S3 fit and S4 policy artifacts were written under the
  fresh organization root (so the chain-root revision of e5b2d1c works); the chain
  failed at the S5 clearing with `S5_CLEARING_NOT_FEASIBLE` and no solver run
  (`POST /api/allocations/clear 200 in 529ms`). Diagnosis from the owner source, not a
  guess: the session had registered the four Z1 compute resources before the clearing,
  and `clearNumericEnterprisePortfolio` requires the tenant's complete current resource
  registry, each resource carrying the mandate's horizon and rights reference
  (`enterprise-allocation.ts:119`, `allocation-contracts.ts:128`). Failure model C8-C10;
  fixed in b4ca52e (compute resources registered after the S6 obligation; the clearing
  status and reasons are retained). Evidence: `fzv-int-out/native/w1-native-04/`.
- `w1-native-05` (head b4ca52e): FAILED_RETAINED in 2 minutes at `s3-s4-s5-owner-chain` with
  `S5_CLEAR_STATUS_500`. With C8 closed the clearing reached an S5 reservation write for
  the first time. API log: `POST /api/allocations/clear 500`, `column reference "body" is
  ambiguous`; PostgreSQL log names `z1_s5_writer_guard()` line 7 on
  `INSERT INTO finnor_os.s5_reservation_origins`. A PL/pgSQL variable named `body` collides
  with the column of the same name read in the same statement (failure model C11). The Z3
  native run had independently hit the same class in the Z0 bridge functions. Fixed with
  `#variable_conflict use_variable` in the identical text the Z3 branch carries
  (cherry-pick of 00e106d, e188c99). A static read of every `postz_*` plpgsql function
  for declared variables used unqualified against a column of a table in the same
  statement found only the Z1 guard and the three Z0 bridge functions the Z3 commit
  already covers. Evidence: `fzv-int-out/native/w1-native-05/`.
- `w1-native-06`: queued at the head carrying that fix.

## Known limits of this attempt

- SOURCE_DEVELOPMENT flavor only; SEPARATELY_INSTALLED_DEVELOPMENT (pinned builds,
  `FINNOR_Z1_INSTALLED_DEVELOPMENT=1`) is a later run on the frozen final cut.
- Costs remain UNKNOWN; interrupted physical attempts retain UNKNOWN responsibility.
- The scenario claims no admission; the guarded report is the only result.
