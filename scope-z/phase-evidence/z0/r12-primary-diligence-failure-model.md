# Z0-R12 primary-diligence: failure model, oracle and run plan

Written and committed BEFORE any R12 product code (run-name prefix `wr12-`). It
governs: the typed canonical query `primary_diligence_v1`, the objective plan
operation `primary-plan`, the owner-consumption wake, the launcher profile `v2`
and the native scenario `finnor-os/scripts/project-z/native/z0-r12-session.mjs`.

Selection (fixed by the coordinator's access-gap measurement, not re-tuned here):
family `primary-diligence` (job `advance_primary_diligence_v1`, sources
`finnor-os/packages/private-equity/src/primary-diligence/*`). Static counts prove
nothing (M7); the oracle is the native before/after run on the disposable stack.

Nothing here is accepted, published, deployed or protected. No external contact,
no live source, no new authority, signer, grant or funding. The only source is
the loopback controlled source `scripts/v2/controlled-source.mts` (ed25519-signed,
`ordinary_disposable`, `NODE_ENV!=production`). Qualification stays
`LOCAL_ENGINEERING_ONLY`; the S8, security and protected admissions are not claimed.

## 1. Chain under test

```text
authenticated owner (real local Auth password grant)
 -> primary-open-work: ORIGINAL Work (+ typed Work input)
 -> primary-governance-put x N (authority, semantics, source profile, consent,
    mandate, grant)  and  primary-reserve-budget (S5 fixed budget, original
    reservation + original deadline)
 -> primary-plan  (NEW): objective plan on the ORIGINAL Work
      allowed capabilities = [query:primary_diligence_v1, check:objective_success]
      success condition = all-of canonical_query(primary_diligence_v1) criteria
      over data.status / data.current / data.definitionDigest / data.nativeOwnerConsumed
      loop waits natively (deferInitialIteration, initialNativeWait)
 -> primary-submit  (202): programme + job advance_primary_diligence_v1
 -> real registered worker claim (fence) -> controlled source (ACQUIRE/READ_RESULT)
    -> reconcile -> INDEPENDENT checker process (checker.mts, resource native:p4)
    -> published finding (EXACT_REGISTERED_CLAIMS_DEVELOPMENT_CHECKED)
 -> primary-consume: real S3 underwriting run + v2_consumer_dependencies rows
    -> wake: schedulePreparedPrimaryDiligenceObjectiveTx (loop waiting -> continue)
 -> typed query primary_diligence_v1 (authenticated /api/queries) -> objective success
```

## 2. Frozen reader contract (names are frozen)

Request: exactly `{intent:"primary_diligence_v1", workId:<uuid>}` (strict, no
other field; fast-read-lane, plugin-registry reference and the reader schema
all reject anything else).

Result `data` field names (frozen): `status`, `current`, `definitionDigest`,
`findingDigests`, `underwritingRunId`, `nativeOwnerConsumed`; plus identity
fields `programmeId`, `workId`, `workInputId` and qualification literals
(`qualification:'LOCAL_ENGINEERING_ONLY'`, `securityAdmission:'NOT_RUN'`,
`protectedAdmission:false`, `productionActive:false`,
`executionAuthorityGranted:false`). Nothing else.

* `definitionDigest` = `v2_programmes.intake_digest` (digest of the accepted
  intake, re-verified by `hash(intake)` inside the owner `programme()` read).
* `findingDigests` = array of `{assertionId, findingDigest}` (digests and
  counts only); never `establishedValueOrInterval`, record values, raw
  evidence, source bodies, credentials.
* `underwritingRunId` = the consuming S3 run id or `null`.
* `nativeOwnerConsumed` true only if ALL hold at read time: programme found by
  (tenant, authenticated principal, Work) in `v2_programmes`; programme bound to
  the exact current Work input passed by the runtime (`options.workInputId`);
  at least one finding of THIS programme passes the owner `currentFinding`
  (method identity, dependency vector, governance currentness/expiry, freshness,
  exact Work); AND `v2_consumer_dependencies(tenant_id, finding_id,
  consumer_type='underwriting_run', consumer_id)` binds that finding to an
  existing `underwriting_runs` row.
* `current` = every finding of the programme passes `currentFinding` now and
  programme is neither invalidated nor cancelled.
* `status`: `ok`-grade only when `current && nativeOwnerConsumed`; the envelope
  `status` is `ok` in that case, else `partial`. `data.status` carries the
  programme status (`COMPLETE`) or `STALE` / `BLOCKED` / `NOT_CONSUMED`.
* The objective success criteria (frozen): `data.status eq "COMPLETE"`,
  `data.current eq true`, `data.nativeOwnerConsumed eq true`,
  `data.definitionDigest eq <hash(accepted intake)>`.

## 3. Independent oracle sources

* O-INPUT: values the scenario records BEFORE any owner call (principal ids,
  deadline literals, budgets, expected facility value `5000000`, discovered
  record id `additional-facility-1`, intake object and its sha256 computed by
  the scenario's own canonicaliser, not by the owner).
* O-DB: admin connection (`CENTROPY_E2E_DB_ADMIN_URL`) reads of `v2_programmes`,
  `v2_findings`, `v2_consumer_dependencies`, `underwriting_runs`, `jobs`,
  `job_delivery_attempts`, `s5_reservations`, `s5_primary_charges`,
  `s6_primary_requests`, `work_inputs`, `work_plan_revisions`,
  `work_objective_loops`/iterations, `work_query_executions`,
  `compute_leases`. Never the reader's own output.
* O-SOURCE: the controlled source's own call journal (IPC `inspect`): method
  sequence `ACQUIRE`, `STATUS`, `READ_RESULT` per requestId and request count.
* O-CHECKER: the checker's own persisted claim-check row (`v2_claim_checks`)
  and its process exit; an in-process checker is a failure.
* O-AUTH: identity from the real Auth token (`/api/me`).
* O-MANIFEST: `scripts/centropy/generate-capability-manifest.mjs` output hash at
  base `43e8e3a` (BEFORE) and the planner capability listing at runtime.

## 4. Finite case list

Legend: R = must be REFUSED with the stated code/predicate; P = must PASS with
the stated observable; N = not reachable here (recorded NOT_RUN with reason,
never PASS).

### A. BEFORE (base 43e8e3a)

| # | Case | Expected | Independent oracle |
|---|------|----------|--------------------|
| R12-01 | At `43e8e3a` the intent `primary_diligence_v1` is absent from the planner capability manifest and `POST /api/queries {intent:"primary_diligence_v1",workId}` on a stack from the pristine base is refused (typed `unsupported intent`/400/422, no `work_query_executions` row). | R | O-MANIFEST hash/grep at base; live refusal HTTP status+body on the base stack or, if the base stack cannot be started, the retained manifest hash plus the source grep proving the intent literal absent (the choice is stated in the artifact). |
| R12-02 | AFTER the change, the same request on an unplanned Work (no programme) returns the typed result with `nativeOwnerConsumed:false`, `current:false`, status `partial`, never `ok`; and a plan for the Work cannot reach success. | P (partial) | O-DB: no `v2_programmes` row for the Work; `jobs` none; loop not `succeeded`. |

### B. AFTER positive

| # | Case | Expected | Independent oracle |
|---|------|----------|--------------------|
| R12-03 | Full chain (section 1) on the ordinary Work with real worker + checker + consumer. Plan accepted (HTTP 201/200 with planId); programme COMPLETE; finding SUPPORTED, EXACT value 5000000, selected `additional-facility-1`; `primary-consume` 200 creating the underwriting run; wake fires; typed query `ok` with `nativeOwnerConsumed:true`; objective loop reaches `succeeded` through `objective_success`. | P | O-INPUT value `5000000`; O-DB `v2_findings` row, `v2_consumer_dependencies` row binding the finding to `underwriting_runs.id`; O-SOURCE journal exactly `[ACQUIRE,READ_RESULT]` (or per-request); O-CHECKER claim-check row; loop/iteration rows; `work_query_executions` succeeded. |
| R12-04 | Success is reached BY the wake, not by polling luck: loop is `waiting` (zero iterations beyond the initial) until `primary-consume` returns; after it, a continue iteration exists whose trigger is the wake. | P | O-DB loop state history timestamps: no executed iteration between submit and consume that observed success. |
| R12-05 | Reader result contains no private values. | P | Scenario greps the entire raw response body and the persisted `work_query_executions.result_summary` for `5000000`, `additional-facility-1`, the controlled-source secret token, the ed25519 private key bytes, `establishedValueOrInterval`: none present. |

### C. Identity and scope

| # | Case | Expected | Independent oracle |
|---|------|----------|--------------------|
| R12-06 | Wrong Work: query with another valid Work (same owner) that has no programme. | `partial`, `nativeOwnerConsumed:false`, `programmeId` null; never the first Work's digest | O-DB the other Work id; digest absent. |
| R12-07 | Other tenant: a second tenant's owner queries the first tenant's `workId`. | 404/refusal (Work unavailable in scope); zero data | O-AUTH second tenant identity; no `work_query_executions` row for the foreign tenant. |
| R12-08 | Other principal: second owner in the SAME tenant queries/plans/consumes the first owner's Work. | refusal / `partial` with no digest; `primary-plan` refused 404/422 | O-AUTH; O-DB programme principal_id differs. |
| R12-09 | Malformed or extra envelope fields: extra key, missing `workId`, non-UUID, intent case variants, extra `root`, array values. | 400/422 on each; none reaches the reader | HTTP statuses; zero `work_query_executions` rows created for them. |
| R12-10 | Unauthenticated / forged token query. | 401 | HTTP status. |

### D. Drift after success (reader must go non-current)

| # | Case | Expected | Independent oracle |
|---|------|----------|--------------------|
| R12-11 | Stale Work input: a newer `receiveWork` input on the same Work after the programme is created. | reader `current:false`, `nativeOwnerConsumed:false`, `status` not `COMPLETE`; plan cannot succeed on the superseded input | O-DB: `work_inputs` newest id differs from `v2_programmes.work_input_id`. |
| R12-12 | Governance revoked AFTER claim (before finding publication). | programme BLOCKED/STOPPED; no finding published or published finding refused; no consume | O-DB programme status, `v2_findings` count unchanged vs O-SOURCE journal. |
| R12-13 | Governance (consent/mandate/authority) revoked AFTER use (post-consume). | reader `current:false`, `nativeOwnerConsumed:false` even though the `v2_consumer_dependencies` row still exists | O-DB consumer row still present AND governance head state `REVOKED`. |
| R12-14 | Programme cancellation (`primary-cancel`) after consume. | reader `current:false`; status not `COMPLETE`; releaseGranted false | O-DB `cancellation_requested_at` set. |
| R12-15 | Finding expiry, or method/checker identity change (checker digest differs from the finding's recorded one). | `current:false` | O-DB: finding expiry timestamp in the past (fixture-created short expiry) or recorded digest != recomputed checker digest. If the owner offers no way to produce an expired finding without raw writes: NOT_RUN with reason. |
| R12-16 | Objective dependency drift after plan success claim is not used to short-circuit: after R12-13, a fresh evaluation of the objective success condition is false. | R | `objective_success` evaluation result/loop remains/returns non-success after re-query. |

### E. Idempotence, duplication, failures

| # | Case | Expected | Independent oracle |
|---|------|----------|--------------------|
| R12-17 | Duplicate `primary-consume` with the same idempotency key. | Same `underwritingRunId`, one run, one `v2_consumer_dependencies` row, no double use of the finding | O-DB counts: underwriting_runs for key = 1; consumer rows = 1. |
| R12-18 | Duplicate `primary-consume` with the same key but changed bindings/world time. | Refused (idempotency conflict predicate) | HTTP code/predicate; O-DB counts unchanged. |
| R12-19 | Duplicate job delivery (same `jobs` row delivered twice / duplicate `primary-submit` replay). | One programme, one job; replay returns `replayed:true`; source call count not doubled | O-DB jobs count for idempotency key `v2:<id>:<rev>` = 1; O-SOURCE journal. |
| R12-20 | Physical worker SIGKILL mid-job after possible egress, then restart. | Job becomes `quarantined` after lease expiry (no automatic replay); `primary-advance` resumes with original grant and original deadline; calls on the source are `ACQUIRE` then `STATUS`/`READ_RESULT` with the SAME requestId (never a blind re-POST); `UNKNOWN` preserved until observed; final programme COMPLETE | O-DB `jobs.status`, lease expiry, `s6_primary_requests` statuses; O-SOURCE journal; reservation id unchanged; deadline literal equals O-INPUT. |
| R12-21 | Original deadline exhausted (frozen mandate deadline passed; or deadline before dispatch). | zero source calls; programme STOPPED/BLOCKED with `ORIGINAL_PRIMARY_DEADLINE_EXHAUSTED`-class reason; no new deadline; reader never `ok` | O-SOURCE journal count 0; O-DB programme reason. |
| R12-22 | Reservation exhausted (budget grant too small / second use of original shared grant). | Blocked state visible in `primary-read` and in the reader (`status` BLOCKED/`STALE`, `nativeOwnerConsumed:false`); NO new funding row created | O-DB `s5_reservations` count unchanged; `s5_primary_charges` ≤ original ceiling. |
| R12-23 | Objective plan fails closed: `primary-plan` with an intake whose Work input is not the latest, or with an unknown allowed capability. | 422 refusal, no plan revision created | O-DB `work_plan_revisions` count unchanged. |
| R12-24 | The wake refuses to move the loop when preconditions do not hold: consume of a DIFFERENT Work's finding; plan superseded; deadline expired; success condition changed. | Loop stays `waiting` | O-DB loop state unchanged for each negative trigger. |

### F. Reader can lie (each must be caught by an oracle)

| # | Way the reader lies | Oracle that catches it |
|---|---------------------|------------------------|
| R12-25 | Reports `nativeOwnerConsumed:true` while no `v2_consumer_dependencies` row exists (consumed without a current finding). | Before `primary-consume`, with COMPLETE programme and finding present, the reader must return `nativeOwnerConsumed:false`; O-DB consumer count 0. |
| R12-26 | Reports consumed for a finding of ANOTHER programme/Work or another principal (row exists but not for this programme). | Second Work with its own finding, consume only the first: reader of Work 2 stays false; O-DB. |
| R12-27 | Reports `current:true` after revocation/cancellation/Work-input change (trusts the payload/consumer row instead of re-deriving from owner rows). | R12-11, R12-13, R12-14 observations. |
| R12-28 | Leaks private finding values (see R12-05) or source credentials. | Raw-response/summary grep for planted sentinel strings. |
| R12-29 | Returns a different `definitionDigest` than the accepted intake (reads a replayed/other programme revision). | Scenario computes sha256 of its own canonical intake (O-INPUT) and compares with response and O-DB `intake_digest`. |
| R12-30 | The reader result is produced from a client-supplied payload rather than owner rows (any extra fields ignored/refused). | R12-09 (strict envelope) plus a request with a forged `data`/`current` field refused. |

## 5. Environment gates

* The scenario needs: launcher profile `v2` with `FINNOR_V2_PROFILE=ordinary_disposable`
  and a private `FINNOR_PRIMARY_CREDENTIAL_DIRECTORY` (0700) for the worker; the
  worker owned by the scenario (`--no-worker`) so the SIGKILL is physical; an
  admin-inserted `native:p4` capacity row only as disposable fixture (as x1 does).
* Dev-mode stack only; `NODE_ENV!=production`; never `--production-build`.
* If a case is unreachable it is recorded `NOT_RUN` with the exact reason; no
  case is faked, no owner predicate is widened, no raw INSERT into owner tables
  except disposable fixture inputs that no owner API creates (compute policy row,
  external organization), each listed in the artifact.
* Retained artifact: `finnor.project-z.z0-r12.v1` JSON (inputs, steps, expected
  values with provenance, observed values, evidence digests, exit codes, costs,
  skips, rerun command).

## 6. Shared-surface and migration obligations (verified by the run, not by count)

New intent `primary_diligence_v1` through: shared types, runtime dispatch,
plugin reference, fast-read-lane strict validation, objective success/loop
identity lists, `/api/queries` native-only refusal, DB check constraint
`work_query_executions_intent_check` (one new migration), verifier denominators
20 -> 21. A DB constraint miss shows up as a `work_query_executions` insert failure
in R12-03; a runtime miss shows up as the R12-01 refusal persisting AFTER.
