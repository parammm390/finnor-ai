# Z0 native original-parent path: failure model, oracle and run plan

Written before any launcher, fixture or scenario code of worker Z0 (run-name prefix `w0-`).
It governs `scripts/project-z/start-isolated-app.mjs` (profile `x2`/`z0`),
`finnor-os/scripts/project-z/native/x1-origin-fixture.mts` and
`finnor-os/scripts/project-z/native/z0-session.mjs`.

Nothing here is accepted, published, deployed or protected. The stack is the
disposable native stack (pinned local Auth, embedded PostgreSQL on 55441, Next
API 3101, Next frontend 3001, fake loopback application portal). No external
contact, no new authority, signer, grant or funding.

## 1. Chain under test (PRD 3.3, 4.3 item 4, 4.4 fixtures)

```text
authenticated owner (real local Auth password grant)
 -> original Work, deal/workstream/party originals, owned source documents
 -> authenticated HTTP: workforce profile, policy, institution-mandate,
    institution-register-source, institution-sources, institution-submit
 -> registered durable job run_x1_institution_compiler_v1 (worker, role finnor_worker)
 -> S5 institution parent reservation + x1 compiler episode (real owner code),
    checked artifact, p1_request institution_responsibility_v1, plan revision,
    first P1 delivery to a quiescent WAITING/PARTIAL head
 -> authenticated HTTP application-acquire carrying institutionalOrigin selector
 -> job run_application_semantics_v1 (claim/fence) -> X2 computation against the
    disposable fake portal -> independent checker -> retained model/check
 -> S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED
 -> enqueueProgram: ORIGINAL P1 continuation consumes the accepted model,
    charging the ORIGINAL reservation (PREPARATION), or records the typed
    direct fallback; original deadline; no new reservation
 -> S6 boundary / independent observation or retained UNKNOWN (only if the
    original frozen action is resolvable; otherwise recorded as not reached)
 -> mounted Work readback
```

Independent oracle sources (never the candidate/model output):

* O-DB: rows read with the admin connection of the throwaway database that the
  owner code itself does not use for the decision (`s5_reservations`,
  `s5_reservation_origins`, `s5_governed_resource_charges`, `x1_compiler_*`,
  `p1_requests`, `p1_episodes`, `jobs`, `job_delivery_attempts`,
  `application_semantics_*`).
* O-PORTAL: the fake application portal's own journal (`fixtures/store.mjs`
  snapshot): sequence/digest before and after. Any portal write or request
  that the original ledger does not account for is a failure.
* O-INPUT: values recorded by the scenario BEFORE the owner call (owner id,
  tenant id, deadline literal, resource amounts, source byte hashes, expected
  object ids).
* O-AUTH: HTTP identity from the real Auth token (`/api/me`), compared to the
  launcher receipt owner binding.

## 2. Failure cases with independent expected outcome

Legend: R = must be REFUSED by the product with the typed code listed;
P = must PASS with the stated observable; N = not reachable on this stack
(recorded NOT_RUN with reason, never PASS).

### A. The parent itself can be faked or wrong

| # | How it can fail or be faked | Independent expected outcome / oracle |
|---|---|---|
| A1 | Parent rows built by hand-written INSERTs of owner rows | The fixture library only calls owner functions (`createDeal`, `receiveWork`, `createDocument`, `putAllocationResource`) and authenticated HTTP owner routes; the compiler/episode/reservation/p1 rows must exist with `created_by` the worker job and an S5 `s5_reservation_origins` row of schema `finnor.s5.institution-reservation.v1` (O-DB). The only admin SQL is the disposable `compute_resource_policies('native:p4')` capacity row every product e2e uses. A scan of the library for `INSERT INTO finnor_os.(x1_|p1_|s5_|work_plan)` must find none. |
| A2 | Planner-created request mistaken for X1 | Parent selector must come from a `p1_requests` row whose `request->'institution'->>'compilerRequestId'` equals the compiler request id, with `plan_revision_id` of an active revision of the same Work. An ordinary planner run (no mandate) yields no such row; the scenario asserts the count of `institution_responsibility_v1` rows for a plain Work is 0 and acquisition with that Work's ids is refused `Z0_CURRENT_ORIGINAL_X1_OWNER_REQUIRED`. |
| A3 | New reservation instead of the original | Count of `s5_reservations` rows with origin schema institution-reservation for the tenant is constant (1 per compiler episode) before and after acquisition + continuation; the session `reservation_ref` equals `x1_compiler_episodes.parent_reservation` (O-DB); certificate occupation = `EXISTING_ORIGINAL_X1_RESERVATION_NO_NEW_FUNDING`. |
| A4 | Deadline or budget reset | session `deadline_at` <= episode `original_deadline`; request with deadline later than the original is R `Z0_ORIGINAL_DEADLINE_EXHAUSTED_OR_EXTENDED`; request with a demand above the original remaining is R `Z0_ORIGINAL_BUDGET_EXHAUSTED`; remaining = envelope limit minus `s5_governed_resource_charges` sum, computed from O-DB, equals the projection. Sum of charges never exceeds the original envelope limit. |
| A5 | Wrong Work or stale work input digest | acquire naming another Work -> R `Z0_CURRENT_ORIGINAL_X1_OWNER_REQUIRED`; appended newer work input -> R `Z0_EXACT_ORIGINAL_X1_INPUT_REQUIRED` or `X2_CURRENT_ACTOR_OR_WORK_INPUT_CHANGED`; session `work_input_id` equals the compiler row's. |
| A6 | Wrong responsible principal | selector responsibilityIdentity not in the checked duties -> R `Z0_CHECKED_ORIGINAL_RESPONSIBILITY_REQUIRED`; a second owner (other principal) calling the same selector -> R (404 `PERMITTED_CONTEXT_UNAVAILABLE` or the owner refusal), zero sessions created for the other principal. |
| A7 | Stale compiler head or generation | after a newer compiler revision the old selector is R `Z0_ORIGINAL_INSTITUTION_BINDING_CHANGED` / `X1_COMPILER_*`; no session. (Only attempted if the owner API permits creating a newer revision without new authority; otherwise N.) |
| A8 | Original delivery not quiescent | a queued/running `run_harness_program_v1` for the programme at acquisition time -> R `Z0_ORIGINAL_P1_DELIVERY_MUST_BE_QUIESCENT`. Observed with the worker stopped right after the compiler submit (job still queued). |
| A9 | Pending application subcomputation then a second acquisition | second acquisition while the first session is non-terminal -> R `Z0_ORIGINAL_APPLICATION_SUBCOMPUTATION_PENDING`; exactly one session and one root consumption exist (O-DB). |
| A10 | Standalone reset of an X1 Work | acquire without `institutionalOrigin` on the X1 Work -> R `Z0_X1_WORK_CANNOT_RESET_AS_STANDALONE_X2`; zero sessions. |
| A11 | New-parent budget reset | A second acquisition after the first one is terminal that asks for a demand equal to the full original envelope again -> R `Z0_ORIGINAL_BUDGET_EXHAUSTED` once the original charges exceed the remaining. A fresh parent for the same Work is impossible (A10). Observable: no new `s5_reservations` row. |

### B. Model use and acceptance

| # | How it can fail | Expected |
|---|---|---|
| B1 | Model used without S4 acceptance | The continuation selects only artifacts of `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` events; with a session that is MODEL_READY but whose acceptance event is absent (observed by cancelling before publication) there is zero `P1_ORIGINAL_APPLICATION_MODEL_MATERIALIZED` trace. |
| B2 | Double use | A second delivery of the same continuation does not add a second PREPARATION charge for the same physical invocation, and a repeated model-consumed trace is idempotent (O-DB: charge keys unique, trace count). |
| B3 | Candidate turned into verified success | session status MODEL_READY, never COMPLETED; `learnedModelCompletesResponsibility=false`; the responsibility is not in `observedPostconditions` unless the independent canonical observer says so. |
| B4 | Model computes an argument the owner never takes | `Z0_MODEL_CANNOT_REPRESENT_COMPLETE_FROZEN_PAYLOAD` fallback is recorded as `P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK`; it is reported as fallback, not as model use. |
| B5 | Portal changed by the learner | O-PORTAL sequence/digest after acquisition equals the digest accounted by the ledger (no unexpected write). |

### C. Recovery and races (PRD 3.5, 4.4)

| # | Case | Expected |
|---|---|---|
| C1 | Lost provider response + physical SIGKILL of the worker after durable acceptance at the ambiguous request boundary | After restart: same session id, same `original_parent_ref`, same `reservation_ref`, same deadline; the request is reconciled by observation, never re-sent (portal journal sequence unchanged except by the original single send); S6 obligation/effect identity unchanged; if observation cannot establish the outcome the status stays UNKNOWN/`reconciliation_required`. A single physical kill is recorded with the exit signal SIGKILL of the exact pid. |
| C2 | Duplicate delivery of the same job after restart | claim fence strictly increases, `job_delivery_attempts` shows the second claim, zero second possible-egress request for the same effect identity. |
| C3 | Restart with cancellation | cancellation does not release or compensate: `resourceReleaseGranted=false`, reservation not RELEASED, UNKNOWN retained. |
| C4 | Claim/accept/use revocation | Revoking the owner's source grant / mandate / profile at claim, at acceptance and at original-P1 use stops only the affected session (typed R), an unrelated second Work's session keeps running (O-DB status). |
| C5 | Cross-tenant/other principal | Calls by a second user in the same tenant or another tenant read nothing (404 `PERMITTED_CONTEXT_UNAVAILABLE`), create nothing. |
| C6 | UNKNOWN lost on restart | An S5 consumption in UNKNOWN_OUTCOME stays UNKNOWN across worker restart; continuation refuses with `Z0_ORIGINAL_S6_UNCERTAINTY_MUST_BE_OBSERVED` until observed. |

### D. Mounted Work (P2)

| # | Case | Expected |
|---|---|---|
| D1 | Reload keeps Work and the institution session projection | same ids after `page.reload()`. |
| D2 | Logout then new sign-in of a different principal | the previous principal's Work text/ids are absent from the DOM and from `/api/centropy/*` responses; delayed old-principal response does not repopulate. |
| D3 | Token refresh | the Work remains readable; a request with the revoked old token is 401. |
| D4 | Offline/reconnect | no state change in O-DB while offline; no candidate presented as verified. |
Cases that cannot be shown through the mounted UI because the UI has no control
are recorded NOT_RUN with the missing control named.

## 3. Launcher profile failures (x2/z0)

* Existing profiles `z1,z2,x1,z3` must stay byte-identical in effect: compare
  `profileEnv` objects for each existing profile before and after (the scenario
  receipt records `profileEnvNames`; the pre-change env literal is the oracle).
* Assertion `FINNOR_ENVIRONMENT=ordinary_disposable` must stay for the Auth
  state file. The application environment may differ only when the `x2` profile
  is requested and then must equal exactly `staging`; any other combination
  fails closed. Profile `x2` must set `FINNOR_X2_PROFILE=ordinary_disposable`,
  `FINNOR_X2_SOURCE_ROOT=<repo root>`, `FINNOR_X2_DISPOSABLE_SECRET_ROOT=<state>/x2-secrets` (mode 0700, owned by the launcher uid).
* Failure signals: `X2_PROTECTED_APPLICATION_DOMAIN_UNADMITTED`,
  `Disposable application secret custody is invalid`, application refusing to
  start under `staging` (Next dev or Sentry/production gates), API 503.

## 4. Environment/transport failures (never PASS)

Port busy, MemAvailable < 4 GiB, Auth install failure, cold-compile 504 from the
proxy, job lease expiry before the scenario polls, worker unable to claim
(role). Each is reported as a stack/transport failure with the log name; the
immutable run name is never reused.

## 5. Evidence artifact (each run)

`/home/factory-user/repos/fzv-int-out/native/<run>/scenario-01/z0-session.json`
containing inputs, steps, the O-* observations, step-by-step expected vs
observed, exit codes, source commit, scenario sha256; private logs stay in
`*.private.*` files at mode 0600. Failures are kept and cited; no run is
re-labelled.

## 6. Addendum after w0-native-05: child allocation sizing versus original remaining

Observed in the retained database of `w0-native-05` (read-only copy, not the
live stack): the acquisition session of P0-10 ended UNKNOWN
`X2_EXPLORATION_RECONCILIATION_REQUIRED` because the independent disposition
of the 14th exploration interaction was `UNKNOWN` with reason
`Z0_ORIGINAL_BUDGET_EXHAUSTED`. The original request envelope is 520 and the
original episode had used 13 before the acquisition, so the original was not
exhausted; the acquisition child allocation requested by the fixture was
`requestUnits` default 128 and `assertInheritedCharge` refused the 129th
ACQUISITION charge (131 ACQUISITION charges were recorded, 128 of them after
the acquisition started). The product behaved as designed: the child
allocation is a ceiling inside the original remaining, and exhaustion during
an ambiguous request retains UNKNOWN with the responsibilities.

Ways this can be misdiagnosed or faked, and the independent expectation:

| # | Wrong response | Expected |
|---|---|---|
| E1 | Change the expected session status to UNKNOWN or accept UNKNOWN as pass | MODEL_READY plus the S4 acceptance event is the oracle of P0-10; UNKNOWN stays a FAIL. |
| E2 | Raise the original envelope or add a new reservation to make room | The original envelope digest, episode digest and reservation count are unchanged (witness `sameBudget`); only the child demand changes, and it must stay at most `original limit - original used` read from S5. |
| E3 | Raise the child demand above the original remaining | Refused `Z0_ORIGINAL_BUDGET_EXHAUSTED` (P0-04 keeps demanding 2048 against 520 to prove it). |
| E4 | Relax `assertInheritedCharge` | Not done; the P0-10 oracle is unchanged and the exhaustion code remains the refusal. |
| E5 | The sizing needed for a full exploration is unknown | The run records per-phase charge totals; a pass requires `sum(charges) <= original limit` and every charge on the original reservation. |

P0-04 verification: `remainingInstitutionBudget` rejects a ceiling above 2048
with `Z0_ORIGINAL_RESOURCE_DOMAIN` and a ceiling above the remaining
(520 - 13 = 507) with `Z0_ORIGINAL_BUDGET_EXHAUSTED`. The demand 2048 is not
above 2048, so it must be refused with `Z0_ORIGINAL_BUDGET_EXHAUSTED`.

## 7. Addendum: physical worker kill at the ambiguous request boundary (kill mode)

Written before the kill-mode code is changed. The earlier kill case killed the
worker when "a job is running" and then waited for a terminal session status
after restarting the worker. It can pass or fail for reasons unrelated to the
recovery contract (kill before any request, or no explicit resume after the
queue quarantined the lost job). It is replaced by the PRD 3.5 sequence that
`scripts/x2/run-native-e2e.mts` proves for the X2 owner, now on the original
parent.

| # | How it can fail or be faked | Independent expectation / oracle |
|---|---|---|
| K1 | Kill before any request, or after the request settled | Boundary oracle (database): a request row of the session with `possible_egress` and no `observation_ref` and status not VERIFIED/DENIED/UNKNOWN exists at the moment of the kill; its identity (`request_ref`, `obligation_id`, wire `requestId`/`effectId`) is recorded before the kill. No such row: FAIL `KILL_BOUNDARY_NOT_OBSERVED`. |
| K2 | The killed process is a wrapper, not the queue owner | `job_delivery_attempts.worker_id` of the unfinished attempt ends with `:<pid>` of the process that received SIGKILL; the exit event reports signal SIGKILL for that pid. |
| K3 | The restart replays the job blindly | After lease expiry the queue's recovery leaves the job `quarantined` with attempt outcome `reconciliation_required`, failure kind `lease_expired`, and `attempts` and `claim_fence` equal to the values read before the kill. |
| K4 | Resume sends the lost request again | Portal journal (independent of the owner database): the wire `requestId` of the killed request appears in exactly one `dispatch.*`, `submission.accepted` or `approval.committed` event after resume; the session has exactly one request row with that `request_ref`. |
| K5 | Recovery changes parent, reservation, deadline or grants a new allowance | `reservation_ref`, `original_parent_ref`, `deadline_at` of the session and the original episode/envelope digests equal their pre-kill values; reservation count unchanged; the S5 charges created after the restart belong to the original reservation. |
| K6 | The lost request disappears or is relabelled success | After resume the request row still exists with the same obligation, in VERIFIED/DENIED only through the independent request/record observation, otherwise UNKNOWN. Final session status must be a settled state (MODEL_READY, UNKNOWN, BLOCKED, FAILED or STALE); ACQUIRING/PLANNING after the wait window is FAIL `RECOVERY_DID_NOT_SETTLE`. A MODEL_READY session is not treated as business completion. |
| K7 | Later cases consume a model that never existed | The consumption case is NOT_RUN unless an `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event exists for the session. |

## 8. Addendum: business-effect oracle premise (w0-native-09 P0-10)

Written before the oracle is changed. Run w0-native-09 reached MODEL_READY and
S4 acceptance, then failed `BUSINESS_EFFECT_CREATED_BY_ACQUISITION` because the
witness counted every `domain_actions` row of the original Work. The retained
database shows 16 rows, all `execute_application_operation_v1` (8 completed,
8 rejected), none with `authority_context.programId`, created by X2's own
exploration interactions on the sandboxed portal. The other `domain_actions`
row of the database (`submit_condition_evidence`) belongs to the seed Work
90000000-...-0015, not to this Work. The premise "no domain action on the
original Work" was therefore wrong about the product's design: exploration
interactions are recorded as domain actions of the acquisition session. The
claim that must hold is narrower and stays independently checkable.

| # | How it can fail or be faked | Independent expectation / oracle |
|---|---|---|
| B1 | Narrowing the count hides a real business action of the programme | Count the Work's domain actions that are NOT linked from `s6_obligation_origins.domain_action_id` to a session request; any such row fails. Rows with `authority_context.programId` of the original programme fail regardless. `pe_requests` on the deal must stay 0. |
| B2 | An exploration action is a real business write on the portal | Portal journal is the oracle (independent of the owner database): every portal write event (`submission.*`, `approval.committed`, `dispatch.accepted`) must be accounted for by a session request wire `requestId`; a write with no session request fails. |
| B3 | Exploration action count is unbounded | The number of exploration actions must equal the number of session requests that have a `domain_action_id` link, and the portal journal count must match what the sandbox policy allows (recorded, not asserted to a constant). |
| B4 | Count is compared before and after so a pre-existing row is masked | Before-acquisition count of unlinked actions is required to be 0 (P0-01) and the after count is compared to it, not to a literal. |

## 9. Addendum: authority revocation race during acquisition (revoke mode, P1-05)

Written before the case is implemented. The case runs in its own stack run
(`FINNOR_Z0_MODE=revoke`) on a fresh original parent because the original Work
admits one root application session and P0-10/P1-03 consume it. The owner
revocation is the same owner-state change the X2 review gates use for the read
boundary (`application_accounts.status='disabled'`, committed by the owner
database), not an external provider revocation; no external revocation is claimed.

| # | How it can fail or be faked | Independent expectation / oracle |
|---|---|---|
| R1 | Revocation lands before any physical interaction or after the session already finished | The update is issued only after the session has at least two PHYSICAL_READ_STARTED/request rows and while status is ACQUIRING/PLANNING; the commit time T0 is read from the database in the same statement. If the session is already MODEL_READY/terminal before the update the case is NOT_RUN `REVOCATION_RACE_NOT_REACHED`, never PASS. |
| R2 | Acquisition keeps using revoked authority and completes | Final session status must not be MODEL_READY; no `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event. |
| R3 | A new physical interaction begins after T0 | No `application_semantics_requests` row of the session with `created_at` > T0; the portal journal (independent of the owner database) has no `session.created` event with `at` > T0 (requests already past the owner check may complete: only their completion events are tolerated, counted and recorded). |
| R4 | The revocation is handled by cancelling or damaging the original | The original programme status, original reservation envelope/digest, episode digest and reservation count are unchanged; the original Work row is not cancelled/failed; rows of unrelated Works (seed Work) have an unchanged digest ("only affected work stops"). |
| R5 | Settling hides uncertainty | A request in flight at T0 that has `possible_egress` and no observation stays `UNKNOWN`/ambiguous or reconciled through the independent observation; none is relabelled VERIFIED without observation_ref. |
| R6 | Charges after revocation grow the allowance | S5 charges stay on the original reservation and sum <= the original envelope limit (`invariants` is reused); the count of charges after T0 is recorded. |

## 10. Addendum (Z0-N A): an original parent that holds an executable duty undispatched (P0-11)

Written before the fixture shape or the case is implemented. Source facts (read, not assumed):

- `institution-origin.ts` `assertOriginalInstitutionOwnerIdle` refuses an acquisition while any `run_harness_program_v1` or
  `run_x1_institution_continuation_v1` job of the programme is queued/running/quarantined. The original must be quiescent.
- `institution-continuation.ts`: a pass ends with a scheduled poll job unless `supportedComplete || deadlineExpired ||
  interventions.length>0`; with an intervention the status is PARTIAL and no wake is scheduled. A node whose action is
  absent (unresolved duty) is STOPped in the initial pass (`institution.ts` 263-271, `owners.ts` 37) and becomes a
  persisted intervention, so a programme that contains one unresolved duty is quiescent PARTIAL after every pass.
- A pass dispatches duties per Deal one at a time (`activeRoots`): an executable duty is skipped while another duty of the
  same Deal has a `pending`/`executing`/`approved` action. `consumeInstitutionApplicationModels` runs only at the moment an
  executable duty is first dispatched (`!existing`), and only for the duty named by the origin selector.
- With the default policy (no confirmation) a supported duty executes at once, so no executable duty survives until
  acceptance. With `requiresConfirmation=true` for the operation the first dispatched duty is `pending` approval.

Lawful shape (all owner code, nothing written to owner tables): one unresolved duty (intervention, so no poll) and two
supported `create_deal_request` duties A and B on the same Deal, operation policy `requiresConfirmation=true`. The first
pass drafts A (pending approval, holds the Deal) and skips B. The programme is quiescent PARTIAL with B executable and
undispatched. The acquisition selects B. After S4 acceptance the enqueued continuation skips B again while A is pending. The
real owner approval of A (`POST /api/actions/:id/confirm` with the reviewed `expectedEffectHash`) and the owner
`program-resume` operation then let the next pass dispatch B through `consumeInstitutionApplicationModels`.

| # | How it can be faked or go wrong | Independent expectation / oracle |
|---|---|---|
| N1 | Insert the B action, trace or acceptance rows by hand | Forbidden: every row comes from owner code or the HTTP API. The oracle reads the B domain action only by the deterministic id the programme node carries and requires its `created_at` after the S4 acceptance event time. |
| N2 | B was dispatched before the acquisition (so nothing is consumed) | At the cut: A has a domain action `pending`, B has none, no live job, programme PARTIAL. Otherwise FAIL `PARENT_SHAPE_NOT_REACHED`. |
| N3 | A second compile or second root supplies the duty after acceptance | Reservation count, original envelope digest and episode digest unchanged (`sameBudget`); one compiler request for the Work. |
| N4 | A fresh budget pays for the consumption | The PREPARATION charge for B's stable identity exists in `s5_governed_resource_charges` on the ORIGINAL reservation; its ref equals the `chargeRef` of the trace; total charges <= original envelope. |
| N5 | "Consumed" is read from the AVAILABLE trace only | PASS needs the canonical action row: `authority_context.applicationModelUseRef`, `applicationModelAcceptanceRef` (equal to the acceptance of this session) and `applicationModelInputDigest`, plus events MATERIALIZED and CONSUMED naming that action. |
| N6 | A fallback is relabelled consumption | `P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK` with its reason is a recorded outcome of "returns to the original" (P0-11a). "Useful learned argument" (P0-11b) is PASS only for MATERIALIZED+CONSUMED; the fallback reason is reported verbatim as the NOT_RUN/FAIL predicate of P0-11b. |
| N7 | The approval is forced by an owner-table update | Only the HTTP confirm route with the semantic hash read from `business_effects`; the case records the HTTP status and the action status transitions. |
| N8 | The final business result is claimed from the action status | Independent read: `pe_requests` row with the deterministic id on the Deal, and `business_effects.status='verified'`; the payload fields are compared with values derived from the fixture inputs (request text, due date, deal, workstream, recipient), not from the node. |
| N9 | Deadline or assignment moved | Programme head `bounds.deadlineAt`, the node deadline and the session deadline are not later than the values captured at the cut. |
| N10 | The two-duty shape is not accepted by the owner (e.g. approval refused for the owner principal) | The exact HTTP status/body is recorded and the case ends FAIL or NOT_RUN with that predicate; no product weakening. |

## 11. Addendum (Z0-N D): D1 identity at the authenticated `POST /api/queries` boundary

Written before the session script is implemented. Source facts (read, not assumed):

- Pristine base (`c7e560c`): `parseRequestBody` removes `workId`/`idempotencyKey`/`executionKey` (ENVELOPE_KEYS) before
  `validateOperationalQueryRequest`, restoring `workId` only for `economic_programme_v1`. The shared query types require
  `workId` for `harness_program_v1` and `confidential_economic_computation_v1`, so those parse as a generic 400.
- Integrated source (HEAD): the same parser first answers `NATIVE_ORIGINAL_WORK_OWNER_REQUIRED` (400) for
  `harness_program_v1`, `confidential_economic_computation_v1` and `execution_proof_capsule_v1`; `economic_programme_v1`
  reaches `handleOperationalQuery` -> `observeOriginalWork` (native observation, no `receiveWork`).
  So the integrated route may refuse the two forms the task expects to reach their readers. This is a hypothesis to be
  observed, not assumed: the first run records the actual status and body for every form.
- The original parent Work carries a `query:harness_program_v1` capability grant and its `p1_requests` row is a valid
  `programId` for `harness_program_v1`. No economic programme or confidential computation exists on that Work.
- There is no public field that names a work input; the only envelope fields are `workId`, `idempotencyKey`, `executionKey`.

Cases (all through real Auth bearer tokens over HTTP; identities: owner, a second principal inside the owner tenant, and
an unrelated tenant with its own owner, all created through the Auth admin API plus the tenant directory rows; nothing is
written to Work/programme tables):

| # | How it can be faked or go wrong | Independent expectation / oracle |
|---|---|---|
| D1-1 | "Positive" is a 2xx that is not the reader's answer, or the envelope parser's refusal is counted as a pass | Positive PASS requires status 2xx, `workId` equal the original, `workInputId` equal the latest `work_inputs.id` read from the database, `result.execution.workId/workInputId` the same, and `result.data` carrying the programme id asked for. A 4xx `NATIVE_ORIGINAL_WORK_OWNER_REQUIRED` or a generic validation 400 is FAIL with that body, never relabelled. |
| D1-2 | A positive creates a new Work or appends a steering input | `works` count of the tenant and `work_inputs` count of the original Work are read before and after every request; both must be unchanged (positives and rejects). |
| D1-3 | The economic and confidential positives are claimed without a programme | No economic programme or confidential computation can be created on this fixture within this session (an economic programme needs an accepted Y1 theory, an economic reservation and canonical operator observations; a confidential computation needs the Y4 lifecycle). Those two positives are NOT_RUN with that exact reason. What is recorded instead: the reader's typed answer to a request naming a programme/Work that does not have one (reader reached, no Work created). |
| D1-4 | Foreign tenant or principal is refused only because the token is bad | Both identities first read `/api/me` (200, their own tenant). Foreign tenant and foreign principal then send the byte-identical valid harness request; the oracle is a 4xx with no body field naming the original programme, Work input, deal, reservation or institution (leak scan over the stripped response text against values read from the database that the client did not send). A same-tenant second principal that is answered 2xx is FAIL `CROSS_PRINCIPAL_READ_ALLOWED` only if the Work is bound to a principal; the observed status is always recorded. |
| D1-5 | Wrong Work, stale input, extra-envelope field, conflicting identity, missing owner all collapse to one 400 | Each reject is its own request with its own expected status class: wrong Work (random UUID and a real other Work of the tenant) 403/404; stale input (`workInputId` of an older/absent input: not a public field) 400; extra-envelope field (`tenantId` of the foreign tenant) 400; conflicting identity (the original Work with a `programId` that is not the original's, and the same `executionKey` reused with a different body) 4xx; missing owner (no `workId`) 4xx and anonymous 401. Each is also checked for D1-2. |
| D1-6 | Fail-before-fix is claimed without a pre-repair observation | Z0-R02-C03: the pre-repair `parseRequestBody` is extracted verbatim from `git show c7e560c:finnor-os/apps/api/app/api/queries/route.ts` (pristine object, SHA recorded) and run with the real `validateOperationalQueryRequest` against the valid harness and confidential bodies; the result (workId stripped, generic validation failure) is the retained baseline. The HEAD parser is run on the same bodies. The HTTP observation of HEAD is the main case. |
| D1-7 | A product change is made to turn a FAIL into a PASS | `apps/api/app/api/queries/route.ts` is a shared file. If D1-1 fails, the exact patch is requested from the coordinator with the failing run as evidence; any patched-tree verification run is labelled as an unmerged working-tree variant and never counted as the integrated result. |

## 12. Addendum (Z0-N B): the eight G1 rejects and the standalone control

Written before the cases are implemented. The plan (`z0/native-e2e-plan.mjs`) lists `G1_REJECT_*` with outcome
`NO_NEW_LEARNED_OWNER_USE`, plus `X2_STANDALONE_REMAINS_LAWFUL`. Mapping to cases (existing = already observed in
`w0-native-10`; new = `reject` mode of `z0-session.mjs`, `FINNOR_Z0_MODE=reject`, own stack run on a fresh parent):

| G1 reject | Case | Predicate / oracle |
|---|---|---|
| NO_ORIGINAL_PARENT | existing P0-06 (forged selector), P0-07 (other programme); new P0-13: an ordinary Work (no X1 episode) carrying the real parent's selector | refused 4xx with a `Z0_`/X1-owner code; zero sessions for both Works; original charges/reservations/episode digest unchanged |
| BUDGET_EXHAUSTED | existing P0-04 (demand above envelope), P0-05 (foreign resource), P0-12 (second acquisition) | as recorded; remaining units computed from `s5_governed_resource_charges`, not from the response |
| DEADLINE_EXPIRED | existing P0-03 (extension past the original); new P0-14: `deadlineAt` already in the past | refused with `Z0_ORIGINAL_DEADLINE_EXHAUSTED_OR_EXTENDED`; zero sessions; state digest unchanged |
| PENDING_LEARNING | new P0-15: a second, different acquisition while the first session is non-terminal | refused (`Z0_ORIGINAL_APPLICATION_SUBCOMPUTATION_PENDING` or the owner's equivalent); exactly one root session; the first session is then cancelled through the owner route and settles; reservation/envelope digests unchanged |
| UNSUPPORTED_MODEL, INCOMPLETE_MODEL | observed by P0-11 only if the real consumer returns `P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK` with a `Z0_MODEL_*` reason (the consumer's typed no-use of a model it cannot represent completely); otherwise NOT_RUN | no owner path makes the stock learner emit an unsupported or incomplete model against the disposable portal, and hand-writing a model artifact is forbidden (N1). The exact reason is reported; never relabelled |
| PRIVATE_REPLAY | NOT_RUN unless the learner's own refusal is reachable: the fixture portal is disposable and has no private-source replay surface | exact reason reported |
| S6_UNKNOWN | NOT_RUN unless a retained UNKNOWN obligation exists on the original Work: P1-03 resolved its lost request to VERIFIED by observation (w0-native-11) | no owner path creates an S6 UNKNOWN without a physically lost effect that the portal cannot observe; reported as such |
| Standalone control | new P0-16: an ordinary Work with its own S5 resource, `application-acquire` with no `institutionalOrigin` | accepted (2xx); the session's `original_parent_ref.institutionalProgramRef` is null; its `reservation_ref` is NOT the X1 parent reservation; no `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event; the X1 parent's reservation, envelope, charges and episode digests are unchanged (a standalone acceptance must not substitute for the institutional one) |

Faking risks and oracles:

| # | How it can be faked or go wrong | Independent expectation / oracle |
|---|---|---|
| S1 | The standalone Work is secretly an X1 Work, or reuses the parent's reservation | The ordinary Work has no `x1_compiler_episodes` row; its resource id differs from the parent's resources; the session reservation id differs from the parent reservation id (O-DB) |
| S2 | The refusal is caused by an unrelated defect (missing portal profile, wrong root) rather than by the X1 parent rule | Each refusal carries the product's own code; the standalone control with the same portal profiles, root and deadline is accepted, so profiles/root are not the cause |
| S3 | A refusal changed state | witness before/after: sessions, charges, reservations, original envelope, episode digest, `pe_requests`, domain actions |
| S4b | PENDING_LEARNING passes because the first session already ended | The second request is sent only while the first session row is non-terminal (read from the database immediately before sending); otherwise NOT_RUN `PENDING_WINDOW_NOT_REACHED` |
| S5b | A standalone session is left running and interferes with later cases | It is driven to a terminal status or cancelled; the case is not PASS until the session is terminal and the portal stopped |

## 13. Addendum (Z0-N F): original accounting read-back and the meter receipt (P0-20)

Written before the case is implemented. There is no existing receipt schema for Z0 meters (`grep -ri meter` finds only
capital-formation human-meter code and Z2 replay code), so `finnor.project-z.z0-meter-receipt.v1` is defined here:
original Work/programme/parent reservation, the authenticated API budget view, the database accounting, every S5 charge
with its `costs` field and provenance, consumption/reservation status counts, S7 record counts by kind, physical
interaction counts, queue delivery wall-clock, retained UNKNOWN S5 consumptions, and the list of meter gaps.

| # | How it can be faked or go wrong | Independent expectation / oracle |
|---|---|---|
| F1 | The API view is trusted as the accounting | The case compares it with an independent database reading (`s5_reservations.envelopes`, `s5_governed_resource_charges` sums) for every resource line: limit, used, remaining must be equal. A missing API projection is FAIL, not NOT_RUN, when a root session exists. |
| F2 | A renewal or release hides as accounting | `newReservation=false`, `releaseGranted=false`, `originalReservationRef` equal to the parent's reference, no resource line overdrawn. |
| F3 | Money is invented | `monetaryCost` must be null / `UNKNOWN`; S5 charge `costs.status` must be `UNMETERED` (the code's own conservative-occupation qualification); both are listed as meter gaps, never converted to a number. |
| F4 | A physical cost is reported without a meter | Only queue delivery wall-clock (`job_delivery_attempts` start/finish) is a measurement; CPU, memory and provider cost are listed as unobserved gaps; S7 COST/COMPUTE records for the Work are counted and, when absent, listed as a gap. |
| F5 | UNKNOWN is dropped | S5 consumption states with `UNKNOWN_OUTCOME` are listed in the receipt; the receipt never relabels them. |
| F6 | The case passes with no session | NOT_RUN `no root application session exists on the original Work in this mode` is the only allowed skip. |

## 14. Addendum (Z0-N E): currentness matrix, INTAKE and CLAIM stages (`FINNOR_Z0_MODE=current`)

Written before the cases are implemented. The closed plan is 4 stages (INTAKE, CLAIM, USE, DISPATCH) x 7 dependencies
(RIGHTS, SOURCE, TERMS, CODE, CHECKER, CONSUMER, PARENT) = 28 obligations, plus currentness at checker acceptance and at
artifact publication. Source facts: `readOwnerOrigin` (institution-origin.ts) re-reads the compiler, episode, programme,
active plan, checked artifact, duty population and calls `assertInstitutionCompilerCurrent` and `assertProgramCurrent` at
acquire time AND at every delivery (`assertInstitutionApplicationOriginCurrent`). `assertInstitutionCompilerCurrent`
(institution-program/store.ts) fences: installed X1 compiler method identity, canonical owner cut, rights revision and
operation revision, exact Work input digest, compiler revision superseded, source grant revoked or superseded, responsible
principals and source scopes. It binds no X2 learner, checker or Z0 consumer source identity (grep for digest bindings in
application-semantics and z0-convergence finds only the X1 `checkerRevision`).

Feasible honest cases and the real owner path used for each change:

| Dependency | Change (owner path, nothing hand-written for X1/S5/P1/S4/S6) | Expected fence |
|---|---|---|
| SOURCE | `appendDocumentVersion` of the original CRM export document + `institution-register-source` (a new grant version of the same source supersedes the old one) | `X1_SOURCE_GRANT_REVOKED_OR_SUPERSEDED` or the origin binding refusal |
| PARENT | `institution-revise` (a new compiler revision of the same Work) | `X1_COMPILER_REVISION_SUPERSEDED` / `Z0_ORIGINAL_INSTITUTION_BINDING_CHANGED` |
| TERMS | `POST /api/workforce/profiles` with the same key and narrower terms | whichever fence the owner has; if none, the case is FAIL `CHANGED_DEPENDENCY_NOT_FENCED` (never PASS) |
| RIGHTS | disposable `employee_roles` row; the product trigger `bump_authority_revision` raises `authority_states.revision` (the only direct SQL, a disposable role definition, not an X1/S5/P1/S4/S6 row) | rights/operation revision binding |
| CODE, CHECKER, CONSUMER | none | NOT_RUN: no owner read binds those source identities; a source-byte edit of the running product would not exercise a fence |

| # | How it can be faked or go wrong | Independent expectation / oracle |
|---|---|---|
| E1 | The refusal is caused by something other than the changed dependency | Each case uses its own fresh parent and changes exactly one dependency; the untouched control parent (the first parent of the run) keeps its original envelope digest, episode digest, charges and session count (`sameOriginal`), which also shows the refusal does not spread to unrelated Work |
| E2 | INTAKE "refusal" is a generic 4xx that never reached the owner | PASS needs a 4xx and zero application sessions for the Work; the body and code are recorded; an accepted acquisition (202) is cancelled and recorded FAIL `CHANGED_DEPENDENCY_NOT_FENCED_ACQUISITION_ACCEPTED` |
| E3 | CLAIM case changes the dependency after the worker already claimed | The owned worker is stopped first; the acquisition job is read as `queued` with `attempts=0` after the 202; only then the dependency changes and the worker restarts, so the first claim happens after the change. Otherwise FAIL `ACQUISITION_JOB_WAS_CLAIMED_BEFORE_THE_CHANGE` |
| E4 | The stopped claim leaves a partial effect | PASS needs a terminal non-MODEL_READY session, zero `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` events, zero `application_semantics_requests` rows for the session (no physical interaction), unchanged original envelope/episode digests and charge count |
| E5 | A stage is claimed without being exercised | USE and DISPATCH need a completed acquisition per case and an interleaving harness between acceptance and the consumer (USE) or between materialisation and the business row (DISPATCH); they are NOT_RUN with that reason, not simulated. Checker-acceptance and artifact-publication currentness are NOT_RUN: no owner hook exists between those steps inside a delivery |
| E6 | `institution-revise` legitimately changes owner state and trips the original-only oracle | The oracle compares only the original reservation envelope/status, the original episode digest and the original charge count; a legitimate supersession that changes the original reservation status is recorded as FAIL with the observed values for analysis, not tuned away |

## 15. Addendum (Z0-N C): revocation at CLAIM, SIGKILL at the CLAIM boundary and after durable ACCEPTANCE, concurrent reconciliation (`FINNOR_Z0_MODE=boundaries`)

Written before the cases are implemented. Existing: P1-05 (revocation during acquisition, after two requests), P1-03
(SIGKILL at the ambiguous request boundary, quarantine, resume), P1-01 (duplicate delivery). New cases, each on its own
fresh original parent (the Work admits one root application session), sequential in one stack run (the tenant resource
set rule does not matter: each parent has its own resources; the extra tenants are not needed):

| Case | Procedure (all real owner paths; the owned worker is the only process that is stopped or killed) | PASS oracle |
|---|---|---|
| B-REVOKE-CLAIM (Z0-R11) | worker stopped; `application-acquire` 202; job read `queued`, `attempts=0`; the acquisition's own application accounts are disabled (the same owner-state change as P1-05, limited to accounts whose key carries this parent's tag); worker restarted | session terminal and not MODEL_READY; zero `application_semantics_requests` rows and zero portal `session.created` events; no S4 acceptance; original envelope/episode digests and charges unchanged; the control parent (an earlier untouched one) unchanged |
| B-KILL-CLAIM (Z0-R42, R10) | acquisition running; the instant the job is `running` with an unfinished delivery attempt and no physical request exists, SIGKILL of that worker pid; restart; wait for lease expiry quarantine; TWO `application-resume` calls issued concurrently | exit signal SIGKILL of the queue owner pid; quarantine `reconciliation_required/lease_expired` with unchanged attempts/fence; after the resumes exactly ONE new delivery attempt exists (claim fence +1, not +2), both HTTP answers are recorded; one session, same reservation/original parent/deadline; no duplicate S4 acceptance; portal writes only from session requests; charges <= original envelope; if the boundary is missed (a physical request already exists) NOT_RUN `CLAIM_BOUNDARY_NOT_REACHED`, never PASS |
| B-KILL-ACCEPT (Z0-R43) | gated parent; acquisition runs to the durable S4 acceptance event; SIGKILL immediately; restart; wait until the continuation job and the session settle | acceptance event count stays 1 with the same acceptance ref; PREPARATION charges on the original reservation after recovery equal those at kill time or +1 for the single consumption of the stable action (never +2 for one identity); continuation job reaches a terminal state without a second root session; original deadline/reservation/episode unchanged; original programme not failed by the kill |
| Fallback under remaining resources, exhausted parent (Z0-R44) | cannot be produced without hand-written charges: the Work admits one root acquisition (~150-250 of 520 request units) and over-demand is refused (P0-04). The exhausted-parent behaviour is observed only through the refusal `Z0_ORIGINAL_BUDGET_EXHAUSTED` (P0-04) and the P0-11 original continuation | NOT_RUN for the exhausted-envelope continuation with this exact reason |
| Revocation at ACCEPT / USE (Z0-R11-C02/C03) | would need a change committed between the checker verdict and S4 acceptance, or between acceptance and the original consumer, inside one delivery; no owner hook | NOT_RUN with that reason |

| # | How it can be faked or go wrong | Oracle |
|---|---|---|
| B1 | The kill lands before the claim or after the work | The boundary is read from the database immediately before the kill (job `running`, unfinished attempt, zero requests) and the worker pid is checked against `job_delivery_attempts.worker_id` |
| B2 | A second resume starts a second delivery or resends | Delivery attempt count and claim fence before/after; portal journal write events accounted for by session requests |
| B3 | Recovery renews budget or moves the deadline | `invariants` (reused): session reservation_ref equals the parent's, deadline <= original, reservation count and envelope digests unchanged, charges <= envelope |
| B4 | Revocation of one parent's accounts stops other work | Accounts are selected by this parent's tag; the control parent's original digests are compared |
