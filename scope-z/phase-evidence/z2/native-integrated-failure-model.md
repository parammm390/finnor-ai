# Z2 installed whole-owner native replay on the integrated candidate: failure model

Written before any product, launcher, installer or scenario code of this task. Scope: the integrated candidate commit
`a5209abc15fe40c68f30336c60d95dbfc343c13a` (tree `71e5c7d2f8a9f5f686b328407e32c82c940b2d67`), a separately installed whole-owner
pack, an ordinary disposable native stack (pinned real Auth, throwaway embedded PostgreSQL, real owner logins, mounted Work UI) and
the existing guarded driver `finnor-os/scripts/project-z/z2/native-replay.mjs --execute-native`.

Nothing here is acceptance, protected admission, 32x8 qualification, comparison, 100x or activation. A case that cannot be run is
reported NOT_RUN with the blocker, never as a pass.

Every case names the way it can be faked or can fail, the independent expected result and the oracle that decides it. The oracle is
never the component under test.

## A. Provenance of the installed pack

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| A1 | The pack reuses a donor `node_modules` (symlink, copy or parent lookup). | Refused. `npm ci` runs inside the new pack for both lockfiles; the receipt has `borrowedNodeModules=false`. | `find pack -name node_modules -type l` is empty; receipt `steps` contain both `npm ci` exits; no `node_modules` path outside the pack is resolved by `require.resolve` from the emitted roots. |
| A2 | The pack tree is built from a dirty worktree or a different commit than the one named. | The prepare step reads bytes from `git archive` of the named commit only; commit and tree are recorded; a dirty worktree is irrelevant because no worktree byte is read. | `source-receipt.json` commit and tree equal `git rev-parse`; per-file sha256 equals `git show COMMIT:path`. |
| A3 | `.env*`, `node_modules`, `.next*`, `.centropy-certification`, credential ledgers are in the source tree. | Refused before copy. | Source inventory contains none; `install-owner.py` asserts the same on its input. |
| A4 | Source fallback: the replay runs the worktree sources while claiming the pack. | The scenario, the stack launcher, the driver and the worker are all run by absolute path inside the pack root; `sourceRoot` equals the installed root and every `/proc/PID/cwd` is inside it. | Driver `processIdentity` cwd assertions; stack receipt lists argv paths, all prefixed by the pack root. |
| A5 | Stale or foreign catalogue/OpenAPI/coverage/source-stamp. | The installer regenerates and checks them in the pack; every generated change is named. A drift is `unexpectedSourceChanges` and fails the receipt. | `install-report.json` `generatedInputChanges`, `unexpectedSourceChanges=[]`. |
| A6 | Build-id mismatch: the served process was built from another build or the id was typed into the env. | `/api/release` `x-finnor-build-id` must equal both `.next/BUILD_ID` files of the pack. | Driver check against `build.buildIds`; the stack launcher reads the BUILD_ID files before start and refuses a different `FINNOR_BUILD_ID`. |
| A7 | `next dev` or an old build is served as the installed target. | Refused. Only `next start` on the pack's own `.next` (API) and `.next-x1-install` (frontend) may bind 3101/3001. | Listener process argv/cwd/exe in the stack receipt and in the driver `ownedListener`; launcher refuses to start if the distDir lacks `BUILD_ID`. |
| A8 | Release Node differs from the repo pin. | Recorded as an explicit deviation (see DECISIONS in the report): repo pin 22.22.3, host pinned 22.23.4; node-gyp headers cannot be downloaded from nodejs.org under the approved network scope. | Receipt `node.version`, `requiredVersion`, `deviation`. The default installer mode still refuses a mismatch. |
| A9 | The runtime Node is not the installed one (system Node 24 is on the host). | Refused. Every process (API, frontend, worker, scenario, driver) runs with the install-time Node binary. | Driver asserts `sha256(/proc/PID/exe) == build.node.sha256` for api/frontend/worker. |
| A10 | Browser asset borrowed from the shared cache. | Browser comes from the pack's own `.z2-installed/browsers`, downloaded once over HTTPS during the install. | Driver `browser.assetRoot` realpath inside the pack; install `browser-acquisition.json`. |
| A11 | Network egress other than npm registry and Playwright CDN. | None. The node headers come from the already-cached 22.23.4 copy, recorded by hash. | Install logs; `installed-node-header-sha256.json`. |

## B. Stack and process ownership

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| B1 | Borrowed listener: ports 3001/3101 already bound by another worker's stack. | Refuse start (`PORT_BUSY`), never reuse. | `ss -ltn` before start; stack lock. |
| B2 | The stock worker still runs during the replay. | The stack is started with scenario-owned worker lifecycle; the launcher never starts a worker. The fixture worker used to construct Y1 theories is a scenario child stopped before the driver starts, and the initial replay worker is spawned by the scenario with a replay-only env. | Process table before driver start: exactly one worker, whose pid/start ticks/cmdline hash are in the target; stack receipt `workerLifecycle=OWNED_BY_SCENARIO`. |
| B3 | The replacement worker is not exclusive or the database holds unrelated work. | Driver refuses unless every non-terminal job is `construct_interaction_protocol_v1` for the declared tenant and Works. | Driver SQL (`unrelated=0`); scenario asserts the same count before the driver and drains all fixture jobs. |
| B4 | Wrong DB role: superuser, `finnor_app` (RLS-blind to the global queue) or application role for the worker. | The driver observation pool and the replacement worker use the `finnor_worker` role (non-superuser, non-BYPASSRLS, holds the canonical queue authority). API and frontend stay on `finnor_app`. | Driver role assertion (`rolsuper=false`, `rolbypassrls=false`, `pg_has_role`); API process environ holds `finnor_app` only. |
| B5 | The worker DB URL leaks to application processes or evidence. | URL exists only in 0600 private files and the scenario/driver environment. | Grep of API/frontend `/proc/PID/environ` names for `FINNOR_WORKER_DATABASE_URL`; grep of committed files and reports for `finnor_worker:` (none). |
| B6 | `NODE_ENV=production` at runtime (Y3 refuses; Next `next start` sets it by default). | API and frontend are started with explicit `NODE_ENV=test`; the build used `NODE_ENV=production` only for compilation. | `/proc/PID/environ` of API/frontend; Y3 `developmentOnly()` passes only under test. If `next start` overrides it, the run fails with a named, retained failure rather than a patched gate. |
| B7 | HTTPS Auth: the driver requires an `https://` issuer equal to the JWT `iss`. The existing isolated Auth issues `http://127.0.0.1:54321/auth/v1`. | The stack runs Auth with the external URL/issuer of the loopback TLS front; the browser trusts only the single declared SPKI; TLS verification is never disabled. | Decoded JWT `iss` observed by the driver; driver cert-digest/SPKI check; no `NODE_TLS_REJECT_UNAUTHORIZED`, no `--ignore-certificate-errors`. |
| B8 | The frontend bundle was built with an `http://` Auth origin, so mounted login cannot reach https Auth. | Public build env fixes `NEXT_PUBLIC_SUPABASE_URL` to the TLS front origin at install time; the installer scans the built client chunks. | Grep of `.next-x1-install/static` for the https origin and absence of the http gateway origin. |
| B9 | Fewer than 2 or more than 4 owner users; users share a principal; non-owner role; inactive employee; passwords in the target or evidence. | 3 distinct active owner-role users in one tenant, credentials only in a 0600 private env file, target holds only variable names. | Driver login (`me.role=owner`, tenant, user, principal distinct); scenario audit of `resolve_authenticated_identity` for each email; grep of target/report for passwords (none). |

## C. Original fixtures and expected values

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| C1 | The Work lacks same-Work Y1 theory, fixed meanings, canonical source/model claims or the S5 reservation (fixtures written by SQL). | All business state is made through bearer HTTP routes and owner libraries (`receiveWork`, `economic-theory-submit/admit`, `allocations/resource`, `economic-reservation-create`, canonical evidence claims); SQL is used only to read. | Source review; scenario step log lists each route and status; each Work's theory is CHECKED and admitted in its own Work. |
| C2 | Expected utilities / effect digests come from the producer under test. | Expected values are literals derived from the public original problem by hand and by `original-oracle.py` on an independently constructed pure profile; the checked candidate is compared after the fact. | Frozen expected file written before submission (`expected-literals.json` with sha256 recorded in the scenario evidence before any construction job is queued). |
| C3 | Positive Works already have Y3 requests; Works are reused between cases. | Each case has a distinct fresh Work with zero Y3 requests. | Driver `Z2_FRESH_ORIGINAL_WORKS_WITHOUT_EXISTING_PROTOCOLS_REQUIRED`. |
| C4 | Fixture-kind provenance is claimed as independent custody. | The report states that negative-kind provenance is the operator's preexisting declaration written by the scenario, not independent custody. | Report wording; driver step `native-negative-*` carries that field. |
| C5 | Negative cases are produced by privileged SQL or by changing expected outcomes. | Stale source, revoked rights, cross tenant, resource bound, unsupported and incomplete are real states created through native routes (superseded evidence version, authority revision, foreign tenant protocol, oversize problem, unsupported/incomplete problem families); expected codes are literals from the owner contracts. | Driver requires genuine 4xx with literal code; any 2xx fails the run. |
| C6 | Cross tenant is simulated with a random id. | A second tenant with its own owner and a real Y3 protocol exists; the first tenant's actor reads it and must get 404 (or the owner's literal refusal). If the second tenant cannot be created through the owner path, the case is reported NOT_RUN with the blocker. | Scenario step log; driver negative. |

## D. Recovery (PRD 3.5) and allowance

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| D1 | A restart is a graceful stop or an in-process fake. | `SIGKILL` of the exact owned worker pid at CLAIM, CHECKPOINT, ARTIFACT, PARTIAL_CONSENT; exit observed through `/proc`; the replacement has a new pid and start ticks. | Driver steps `physical-worker-exit`, `same-build-worker-restart`. |
| D2 | The dead worker's compute permit is released or shortened to hurry the replacement. | Natural expiry is observed; no reservation release or deadline reset. | Driver `original-resource-expiry-observed` and the unchanged S5 reservation row. |
| D3 | Fences do not increase after recovery or UNKNOWN cost tails are dropped. | `claim_fence` of the last delivery is greater than the first; earlier deliveries have `finished_at`; costs of failed attempts retained. | Driver `original-budget-fences-and-responsibility`. |
| D4 | The original four-attempt allowance is reset by descendants or consumed without charging. | Descendants keep the original episode, input and deadline; `attempts` rises to 4; next submission is refused `Z2_ORIGINAL_EPISODE_EXHAUSTED`; no counter is edited. | Driver `remaining-original-budget-and-current-checked-parent`. |
| D5 | Original deadline is renewed by a retry. | `deadlineAt` of every descendant equals the parent's. | Same step. |
| D6 | Withdrawal does not invalidate later use or erases responsibility. | After `WITHDRAW`, run status is `INVALIDATED_RESPONSIBILITY_RETAINED`, `current=false`, a later start is refused. | Driver step after withdrawal. |
| D7 | Cancellation is presented as compensation, or an S5 renewal/fresh budget is invented. | Never done; reservation row equal before and after. | Driver `assert.deepEqual(after.reservation, baseline.reservation)`. |

## E. Honesty and secrets

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| E1 | Credentials, tokens, DB URLs with passwords in committed files, reports or logs shown. | None; private files are 0600; reports carry digests only. | `grep -r` of the repository diff and the retained summaries for the generated passwords, `finnor_worker:`, `Bearer ` (none). |
| E2 | Stack bring-up, validate-only target, or a refusal is reported as the replay passing. | Only the driver's `status=PASSED` with `installedOwnerExecution=PASSED` counts, and only for what the report lists. | `report.json` of the driver run. |
| E3 | Unsupported claims: acceptance, protected admission, 32x8, comparison, 100x, activation, S6 ambiguous-effect recovery. | Stated NOT_RUN; the driver itself records them NOT_RUN. | Driver proof fields. |
| E4 | A failed attempt is erased or retried blindly. | Every attempt has a new immutable name; failures, logs and their exit codes are cited. | Run names under `/home/factory-user/repos/fzv-int-out/`. |

## F. Defects the integrated candidate might expose

A defect in the native Y3/Y1/Z2 owner path that blocks the run is fixed in the smallest owner file, listed in the report with the
failing run, and never by weakening a gate or a driver assertion. A defect outside the Z2 ownership list (migrations, shared
launcher files, Auth starter) becomes an exact patch request, not an edit.

## G. Harness corrections found by reading the never-executed session against the owner code (successor review)

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| G1 | The REVOKED_RIGHTS fixture suspends the second participant's identity row. `resolveTenantContextByEmail` refuses a suspended employee with 403 "Employee access is suspended" before any Y3 code runs, and the driver logs in every declared actor through the mounted UI (`/api/centropy/me` must return 200 with role owner), so the run would stop at login and the negative would never reach the owner. | The second participant stays an active, authenticated owner. Its rights are revoked through the authority tables: a dedicated role assigned to that employee carries an active `deny` grant on `query:pe_world_state`, which `authorizeBeliefCandidateCut` turns into `PE_ENTITY_NOT_FOUND`, mapped by the Y3 API to 404 `Y3_AUTHENTICATED_RESOURCE_UNAVAILABLE`. The negative must come from `interaction-local` as an authenticated call by that actor on a real CHECKED protocol in which that actor is a participant. | Driver login for the three actors passes; the driver negative requires an HTTP 404 and the literal code. The identity suspension case (`Y3_ACTIVE_PARTICIPANT_REQUIRED`) is NOT exercised and is reported NOT_RUN: a suspended identity cannot authenticate. |
| G2 | The deny grant is written with administrator SQL (as `scripts/s1/run-s1-e2e.mts` does for its resource deny), which could be mistaken for the driver creating the condition. | The grant is part of the operator's preexisting target state written by the scenario before the driver starts; the report states it is operator-declared authority state, not independent custody, and that no native owner route for revoking a grant exists in this candidate. | Report wording; session receipt step `revoked-rights-authority`. |
| G3 | The disk guard of the stack launcher copies was lowered in an earlier uncommitted edit. | Not applied: the stock 4 GiB free guard stays. A run that fails it is an infrastructure refusal, reported as such. | `z2-stack.mjs` and `z2-auth.mjs` carry `4 * 1024 ** 3`. |
