# Z4 native stack: failure model (written before the launcher, runner and scenario code)

Scope: the transport and orchestration pieces that let the Z4 guarded replay (`finnor-os/scripts/project-z/z4/native-e2e.mts`)
run against a real native stack: an HTTPS loopback Auth front (`--auth-tls`), production builds of the frontend and API with
real `BUILD_ID` files (`--production-build`), the `z4` launcher profile, and the scenario program
`finnor-os/scripts/project-z/native/z4-session.mjs`. The replay authority, the signer and the Z4 owners are not redefined here.

Every case lists the way it can go wrong, the independent expected result, and the oracle that decides it. The oracle is never
the component under test. A run that hits a case reports the predicate named here, never a silent downgrade.

## A. Transport and trust

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| A1 | The certificate file is replaced between receipt creation and use (substitution). | The replay refuses (`Z4_REPLAY_AUTH_*` certificate or SPKI mismatch); the TLS front self-check fails; no request is made. | Declared cert sha256 and SPKI sha256 in the target receipt versus the file bytes; the self-check connects with only the declared PEM as trust anchor. |
| A2 | `NODE_TLS_REJECT_UNAUTHORIZED` is present in any process (launcher, API, worker, scenario, replay). | Refused before start; never forwarded. | The runner scans every child env it builds; the replay `authTransport` refuses presence. |
| A3 | Ambient trust leakage: `NODE_EXTRA_CA_CERTS` pointing at another file, `SSL_CERT_FILE`/`SSL_CERT_DIR`, a system CA bundle, or `--use-openssl-ca`. | Only the single declared PEM is trusted. A request to the TLS front with another cert fails. | Negative probe: a second self-signed leaf served on a second ephemeral loopback port is rejected by Node under the declared trust; the declared leaf is accepted. |
| A4 | The certificate is a CA, has no IP SAN for `127.0.0.1`, is expired, or has more than one PEM block. | `start-isolated-auth-tls.mjs` refuses to start. | X.509 parse in the TLS start script; generated certificate is `CA:FALSE`, SAN `IP:127.0.0.1` only, short validity. |
| A5 | Node reads `NODE_EXTRA_CA_CERTS` lazily at the first TLS use, so a late `process.env` assignment is silently ineffective. | The variable is part of the process start environment of every Node process that talks to Auth. | The transport-only scenario performs an authenticated Auth call from the API (bearer verification) and from the scenario process; both succeed only with the start-time variable. |
| A6 | The mounted frontend was built with an `http://` Auth URL (`NEXT_PUBLIC_*` is inlined at `next build`). | The browser login can not reach https Auth and the stack refuses to claim `--auth-tls`. | After the build, the launcher greps the built client chunks for the https origin and refuses if the http gateway origin is present as `NEXT_PUBLIC_SUPABASE_URL`. |
| A7 | The browser trusts more than the declared certificate. | Chromium runs with `--ignore-certificate-errors-spki-list=<declared SPKI>` only, and never with `--ignore-certificate-errors`. | Replay launches the browser; the transport scenario also loads a second-leaf origin and expects a certificate error. |
| A8 | The browser pin applies to the wrong executable (full Chrome aborts in the stripped environment; only the headless shell was observed to honour the list). | The target receipt pins the headless shell path and its sha256. | Receipt sha256 of the file versus file bytes (signer re-checks). |

## B. Build identity and production mode

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| B1 | `next dev` is run and presented as production (no `BUILD_ID`). | `--production-build` refuses to start the stack unless `.next/BUILD_ID` exists in both apps and the server was started with `next start`. | The launcher checks the file after the build, records its sha256, and the listening process command line contains `next start`. |
| B2 | A stale `.next` from an earlier source revision is reused. | The build is always run in the run's own pass and `FINNOR_BUILD_ID` is set to a value derived from `git rev-parse HEAD` plus the run name, so a stale directory has a different id. | `BUILD_ID` file content equals the expected derived value. |
| B3 | A donor build or donor `node_modules` (another checkout) is used. | Refused: build roots must equal the repository root resolved from the launcher path, and the worktree HEAD must equal the committed local HEAD. | Resolved real paths of `.next` and `node_modules`; `git rev-parse HEAD`. |
| B4 | The API runtime identity differs from the signed source (dirty tree). | The signer refuses (`Z4_SIGNER_SOURCE_NOT_A_CLEAN_COMMITTED_TREE`) and the scenario stops before the replay. | Signer exit status. |
| B5 | Source-only run is labelled installed. | Not claimed: the evidence names provenance `source` and never `installed`. | Evidence field `provenance`. |
| B6 | Existing flag behaviour changes. | Without the new flags the launcher/runner argument handling, env and output are byte-compatible. | Diff review: the new code is in clearly separated blocks guarded by the new flags; the `z1,z2,x1,z3` run is unchanged. |
| B7 | Production API requires state the dev server hid (rate limit store, readiness checks, `NODE_ENV=production` refusals). | Surfaces as a named failed bring-up run, kept; not patched by weakening a check. | Bring-up log. |

## C. Authority and receipts

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| C1 | A worker writes, templates or forges a receipt under `scope-z/orchestration/replay-grants/`. | Never done. The only writer is the coordinator signer `z4-sign-grant.mjs`. | Receipt directory listing before and after: files appear only through the signer's stdout receipt hash and audit line. |
| C2 | Scope digest, owned source digest, source commit or tree, native binary or source digest differ from the real ones. | Signer refuses; replay refuses. | `Z4_SIGNER_*` and `Z4_REPLAY_*` predicates. |
| C3 | Scope is expired, longer than one hour, or broader than the declared disposable target (non-3 loopback origins, database port other than 55441). | Signer refuses. | Signer predicate. |
| C4 | The grant receipt hash env differs from the receipt file name. | Replay refuses. | Replay predicate. |
| C5 | Credentials or private files are group/other readable, symlinks, or larger than 128 KiB. | Refused by signer and replay. | `Z4_SIGNER_PRIVATE_FILE_REQUIRED` / replay predicate. |
| C6 | Second actors do not exist: negatives for tenant and authority would run with the owner's credentials and "pass" vacuously. | Scenario creates a foreign-tenant owner and a same-tenant actor with no authority over the work as real Auth users bound to their DB identities, and each negative expects its own status and predicate. A negative that cannot name its actor is not written. | Auth admin listing of three distinct users; each negative's predicate is a literal expected value in the scope, produced from the owner contract (`400|404|422`, uppercase code), not from the observed response. |
| C7 | Credentials leak into reports or repository. | Credentials exist only in `*.private.*` mode 0600 files under the evidence directory and in process environment. | Grep of committed files and report for the generated passwords and tokens (none). |

## D. Real-owner seeding and expected values

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| D1 | Expected files are produced by the producer under test (self-confirming). | Expected finals come from the public case file (`public-cases.pre-code.json`, frozen before code, sha `3992c311...4d94`) which was generated from the original integer interpreter and family formula; the scenario copies literals, it never reads producer output into an expected file. | Frozen registration sha; the expected file contents equal the registration's `expectedFinal` for the same family. |
| D2 | `ownerSourceDigest` in an expected file differs from the real owner source. | The replay refuses the case; the scenario computes the digest from the seeded real S3/S4 owner records by the product's own digest function before writing the file. This digest is an identity binding, not an expected computation result. | Replay predicate on mismatch. |
| D3 | Seeds fabricate S3/S4/S5 owner records directly in SQL. | Not done. Seeds use the existing owner fixture support (`createUpstreamFixtureSupport` in `finnor-os/scripts/s5/owner-fixture.mts`) and the product library calls (`receiveWork` and owner routes). | Source review; the seed contains no `INSERT` into owner tables. |
| D4 | Intake or plan was skipped so the original Work does not exist. | `execution-proof-intake` and `execution-proof-plan` run through the real route handlers before the case is recorded. | The case workId/workInputId are read from the intake response, not invented. |
| D5 | Coverage gaps: no S3 or no S4 owner case; no recover-producer or recover-owner case; missing negative kinds. | Scope builder refuses to write the scope; the signer also checks coverage. | Signer predicate `Z4_SIGNER_COVERAGE_REQUIRED`. |

## E. Recovery (PRD 3.5)

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| E1 | SIGKILL hits a process that this run does not own. | Only the owned replay child (spawned by the replay, pid and start time checked) is killed. | Replay owned-child ledger; no other pid in the kill list. |
| E2 | Crash at claim or checkpoint: the retry recomputes with a fresh budget or deadline. | The recovered job keeps the original parent, deadline, `maxAttempts` and remaining budgets; attempts is bounded by 3. | Request row `deadlineAt`, `maxAttempts` before and after; attempt count. |
| E3 | Crash after native result persistence and both guard acknowledgements but before the delivery acknowledgement. | Exact-key redelivery returns the same persisted result id and digest and does not run the native binary again. | Result digest before kill equals digest after redelivery; native invocation counter unchanged. |
| E4 | Delivery outcome unknown after the kill. | The state remains UNKNOWN (never promoted to delivered or failed) until the exact-key redelivery reads the persisted result; no compensation is invented. | Delivery status read before and after. |
| E5 | The kill leaves the original queued job consumed or absent. | The original unused QUEUED job exists before the recovery step (replay requires it) and is claimed through the scoped claim seam only. | Queue row state before the kill. |
| E6 | Replay re-reads a different persisted result for the same key. | Refused; unequal digests fail the case. | Digest comparison. |

## F. Run hygiene

| # | Failure | Expected result | Oracle |
|---|---------|-----------------|--------|
| F1 | Ports 3001/3101/55441/54321/54322/54443 busy. | The stack wrapper refuses to start; nothing is killed that this run did not start. | Port check. |
| F2 | The worker is not exclusive (stock worker also running). | The z4 run uses `--no-worker`; the scenario starts exactly one worker and records it. | Process list in evidence. |
| F3 | A failed run is retried in place. | Never; every run has a new immutable name and failed runs are kept. | Run directory names. |
| F4 | A PASS is claimed from the transport-only scenario. | It reports `transport_only` and nothing else. | Result file field. |

## G. World-pin currentness across the session (added after w4-seed-05)

Observed in w4-seed-05: the S3 fit succeeded, the first original Work (`s3-producer-recovery`) completed intake and plan, and the intake of the
second Work was refused because the model's S1 pin (dependencyDigest `2822127f...`) no longer equalled the fresh view at the pin's own validAt
(`a648b172...`) with the same rightsRevision (43) and canonicalStatus COMPLETE. S3's revalidation is not weakened; the session has to be shaped so
the pin is current wherever the product demands it.

| # | Candidate cause of a changed dependency digest after the fit | Independent expected result | Oracle |
|---|---|---|---|
| G1 | The first original Work's `work_entity_link` to the root enters the root's canonical world (world-state `work_entity_link` history) | The trace shows exactly one added dependency reference of owner `work_entity_link` right after the first intake | Reference difference between consecutive views loaded at the same validAt |
| G2 | S4 synthesis or S5 resource registration writes a canonical row connected to the root | The trace changes after `after-s4-policy` / `after-s5-resource` and names the added reference | Same |
| G3 | Plan selection / objective start writes versioned canonical rows connected to the root | The trace changes after `after-plan:*` | Same |
| G4 | Clock effect: coverage or source-cut fields that depend on request time rather than a revision | The digest changes with no added/removed reference; the coverage or source-cut owners differ | Trace `coverage` and `sourceCutOwners` compared field by field |
| G5 | A reused root is shared by several Works so one Work's mutation stales the pin used by the next | A per-Work root removes the cross-Work effect; a mutation caused by the Work's own link remains and is reported, not hidden | Trace per root |

Rules for the fix: no edit of `enterprise-beliefs.ts`, `enterprise-interventions.ts` or the S3/S4 gates; no pin refreshed by hand; any re-fit is a
real `/api/interventions/fit` call whose new model reference is the one named by the Work it serves; a Work whose model is stale at submit is
reported as a product defect with the trace, never patched around. Expected values (the public-case finals) never depend on this stage.

## H. Observed cause and the adopting intake (added after w4-seed-06)

w4-seed-06 `world-trace.json` (view loaded at the pin's own validAt): digest equal to the fit pin after fit, S4 synthesis and S5 resource registration
(394 references, `matchesFitPin: true`, `pinStatus: CURRENT`); after the first Z4 intake the digest changed and the only difference is ONE added reference
`@finnor/db:canonical:work_entity_link:<id>:1:<hash>` (395 references, `pinStatus: INVALIDATED`). So G1 holds and G2..G5 do not. S1 counts a Work
link on a pinned root as a new recorded fact, correctly and by design, and `intakeProofWork` always creates a new Work and links it to the model's root
after `ownerSource` already demanded a current model. Every later Z4 step (`submitProof`, store recheck, consume) calls `ownerSource` again, so with the
current intake no Work can ever be used with a model pinned on its own root: fit-before-link goes stale, link-before-fit needs a model reference that the
intake definition (`ownerContract.modelRef` is inside `acceptedDefinition`) must already name.

Smallest fix inside the Z4 owner (no S1/S3/S4 edit, no pin weakened): an optional `adoptWorkId` on `execution-proof-intake` that appends the typed
objective input to an EXISTING original Work that already carries the canonical `about` link to the root, so the link exists before the model is fit and
the intake adds no link. `adoptWorkId` is not part of the accepted definition, so plan and submit see the same definition as before.

| # | Failure | Expected result | Oracle |
|---|---|---|---|
| H1 | Adopting a Work of another tenant or another principal | 404 `PE_ENTITY_NOT_FOUND` (foreign) or 422 `Z4_ADOPTED_WORK_NOT_ELIGIBLE` (same tenant, other creator); no input appended | `work_inputs` count for that Work unchanged |
| H2 | Adopting a Work that has no `about` link to the request root | 422 `Z4_ADOPTED_WORK_NOT_ELIGIBLE`; no link is created to make it eligible | `work_entity_links` count unchanged |
| H3 | Adopting a Work that already holds a typed Z4 input under another key or definition | 422 `Z4_ADOPTED_WORK_NOT_ELIGIBLE` | typed input count remains 1 |
| H4 | Adopting a Work that already has a plan revision or is terminal (`completed`, `failed`, `cancelled`) | 422 `Z4_ADOPTED_WORK_NOT_ELIGIBLE` | plan revision count and status unchanged |
| H5 | Exact-key replay of the same adoption | Same `workInputId`, `duplicate: true`, no second input, no new link | counts unchanged |
| H6 | Same key replayed with a different definition | 422 `Z4_ADOPTED_INTAKE_DEFINITION_CONFLICT`; the first input is untouched | typed input digest unchanged |
| H7 | The adoption itself changes the root's S1 view | It must not: the dependency digest after adoption equals the digest before it | `world-trace.json` entries `after-adopted-intake:*` all `matchesFitPin: true` |
| H8 | Intake without `adoptWorkId` | Unchanged behaviour (creates and links a new Work). Its pin-staling effect is reported as a product limitation, not hidden | Source diff: that branch is byte-identical |
| H9 | Adoption resets the deadline or budget | Not possible: deadline and one-hour rule are checked before any Work lookup, demand and budget are unchanged | Existing `Z4_ORIGINAL_ONE_HOUR_DEADLINE_REQUIRED` and S5 predicates |
| H10 | OpenAPI/manifest staleness from the extra field | Reported to the coordinator for the single final restamp; not regenerated here | Report item |

## I. First original submission refused (w4-seed-07, `Z4_PREDICATE_UNPASSED` with no named predicate)

After the adopting intake all six Works kept a CURRENT pin (every `after-adopted-intake:*` and `after-plan:*` trace entry `matchesFitPin: true`). The
pre-submission of the owner-recovery Work then answered 422 `Z4_PREDICATE_UNPASSED`. The route only names a predicate that is an uppercase token, so the
failing site is masked. Candidate sites in `submitProof` (none may be bypassed): I1 `authorize` rights; I2 `workSnapshot` (plan, latest input, deadline,
objective, status); I3 `ownerSource` (S3 model currentness, S4 policy `readEnterpriseContingentPolicy`, mandate/model/episode binding, history period
availability, exact-integer range); I4 `obligations`; I5 `reserveApplicationParent` (S5 resource horizon, validity, beliefPins, demand versus availability,
rights reference); I6 retained-byte budget; I7 an error whose message is not an uppercase token (a raw library error such as a SQL or Zod message).
Oracle: the same `submitProof` call made in-process by the scenario with the same authenticated context; the thrown message and first stack frames name
the site. This is a diagnostic read, it is recorded as evidence and never used to pass the stage.

## J. Submission commits the job, then a state write fails on a nonexistent column (w4-seed-08 and w4-seed-09)

w4-seed-09 ran with the plpgsql ambiguity repair (3228ade) in place. The submission of the owner-recovery Work still answered 422
`Z4_PREDICATE_UNPASSED`, but the in-process diagnosis of the same call returned `replayed: true`: the job row had already been committed by the HTTP
attempt, so the refusal came from a step after the insert. The embedded Postgres log names it exactly:
`ERROR: column "updated_at" of relation "jobs" does not exist` on `UPDATE finnor_os.jobs SET payload=jsonb_set(...),updated_at=clock_timestamp()`
(`store.ts` `setState`). The migrations give `finnor_os.jobs` no `updated_at` and no `created_at` (0000, 0007, 0059, 0060, 0090, 0137, 0138);
the only creation-time column is `accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()` (0138). The same absent-column assumption exists in
`listProofs` (`ORDER BY created_at DESC`), which has not run yet.

| # | Failure | Expected result | Oracle |
|---|---|---|---|
| J1 | `setState` names a column the table lacks | The state write succeeds and is guarded by the exact-previous-state comparison only | Postgres log has no `column ... does not exist` for `finnor_os.jobs` |
| J2 | Dropping `updated_at` loosens the concurrency guard | It must not: the `payload->'z4'=$4` compare-and-set and `rowCount===1` check are unchanged | Source diff shows only the SET list changed |
| J3 | `listProofs` ordering uses a missing column | Ordered by `accepted_at DESC, id DESC` (deterministic tie-break) | Status/list read in the full stage returns sessions |
| J4 | A masked refusal hides a SQL error again | The submit diagnosis already records PG `where`/`detail`; the postgres log is the second oracle | `submit-diagnosis.json` and `postgres.private.log` |
| J5 | Committed job with a failed follow-up leaves a half-submitted session | A fresh run name is used; the retained run is not reused. The replayed in-process answer in the diagnosis confirms the idempotent submission path | `w4-seed-09` retained, next run `w4-seed-10` |
