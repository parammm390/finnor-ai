# Z0 mounted Work: failure model, oracle and run plan

Written before any UI, fixture-wrapper or scenario code of worker Z0-M (run-name prefix `w0m-`).
It governs `finnor-os/scripts/project-z/native/z0-mounted-session.mjs` (+ `z0-mounted-*.mts`) and any
change under `src/components/centropy/**` made for these rows. Nothing here is accepted, published,
deployed or protected. Stack: the disposable native stack (pinned local Auth, embedded PostgreSQL,
API 3101, root Next app 3001, fake loopback application portal), launcher profile `z0`, `--no-worker`
(the scenario owns the production worker).

Matrix rows covered (requirement-case-matrix.md): Z0-R08-C01, Z0-R08-C02, Z0-R09-C01..C06,
Z0-R45-C01..C04. PRD 3.3 (last link: canonical mounted Work readback), 4.3 item 7, 4.4 last two
fixtures, 4.5 (stale private state crossing principals, false completion, lost budgets/UNKNOWN fail Z0).

## 1. What is under test

```text
real Auth sign-in in Chromium (semantic Email / Password / Sign in controls)
 -> /centropy/investigations/<thread of the original Work> (real route, real drawer, real Account menu)
 -> ApplicationSemanticsPanel for the ORIGINAL X1 Work (root pe_deal) reading /api/centropy/me and
    /api/centropy/company-brain/application-projection through the proxy to the API at 3101
 -> compared with an independent owner read: admin SQL on the same rows, plus the API read made from
    Node with its own password grant (never the browser's token and never the panel's code path)
```

The original Work, its X1 parent reservation, the acquisition session (MODEL_READY, S4 acceptance)
come from the Z0 fixture library (`createOriginalInstitutionParent`, `driveAcquisitionToModelReady`)
driven by owner code and the production worker. No owner row is written for the mounted cases. The
mounted scenario writes only: (a) owner-API thread creation for an existing Work (`POST /api/threads`
with `workId`, the product's Work-inspection thread), (b) the launcher-seeded foreign owner's local
Auth credential through the Auth admin endpoint of the isolated stack (a credential for an existing
database owner; no tenant/user/role row is created), and (c) the same SQL fixture inputs the Z0
fixture library already writes for the disposable portal profiles.

## 2. Independent oracle (no case passes on a screenshot or on the panel's own parse)

- O-SQL: admin connection (`CENTROPY_E2E_DB_ADMIN_URL`) reading `application_semantics_sessions`,
  `application_semantics_requests`, `application_semantics_events`, `s5_reservations`,
  `s5_governed_resource_charges`, `p1_requests`/`p1_events`, `x1_compiler_episodes`, `works`,
  `work_inputs`, `s6_obligation_origins`, `business_effects`, `domain_actions`, `users`.
- O-API: Node-side owner password grant (fixture `signInOwner`) calling
  `POST /api/company-brain/application-projection` directly on 3101. Expected values are taken from
  O-SQL first; O-API must agree with O-SQL before either is used as the expectation of a DOM fact.
  A disagreement is its own FAIL (`ORACLES_DISAGREE`), not a DOM failure.
- O-IDP: `GET /auth/v1/user` with the bearer the browser actually sent (header observed with
  `page.on("request")`, which observes and never routes or rewrites).
- DOM: text content and ARIA/role state of the mounted panel after every `<details>` has been opened
  by real clicks on its `<summary>` (collapsed content is user-reachable, so it counts only when opened),
  plus `data-application-work`, `data-application-session`, `data-application-status`,
  `data-application-effect-state` attributes already in the panel.
- Storage: after each case the page's `localStorage`, `sessionStorage`, IndexedDB (every database,
  store and record serialised), CacheStorage, service-worker registrations and cookies are enumerated
  and searched for the private-marker set and for the previous principal's access and refresh token.
  Only booleans, counts and key names are recorded; token values are never written.
- Private-marker set for the ORIGINAL Work (computed from O-SQL, all >= 16 characters or UUIDs):
  workId, root dealId, tenantId, owner userId, sessionId, programId, compilerRequestId,
  responsibilityIdentity (`x1-obligation:<64 hex>`), original reservation id, institution id, resource
  ids (`z0-compute-<tag>`, `z0-human-<tag>`), thread id, thread title (the instruction text).
- Mutation watch: every non-GET browser request is recorded (method, path, operation name decoded from
  the body for `/live-controls`). The mutating set is `company-brain/application-acquire|execute|cancel|resume`,
  `actions`, `outcome-packs`, `threads`, `works/*/objective`, `instructions/*/cancel` and `live-controls`
  with `operation: dispatch`. Reads that are POST (`company-brain/application-projection`, `live-controls`
  read operations) and `live-controls end-delivery` (sign-out) are classified, not counted as mutations.
  Expected mutating requests per case: 0 unless the case itself clicks a mutating control (none does).
  O-SQL witness (sessions, reservations, charges, cancel_requested_at, jobs by type/status) taken before
  and after the mounted phase must be equal on the deterministic tables.
- Positive controls (a detector that cannot see is not evidence): each DOM fact detector must find its
  markers while signed in as the owner; the storage detector must find the Supabase session key and the
  principal id while signed in; the mutation watch must record the real sign-out `end-delivery` POST;
  the delayed-response hold must be seen as a Postgres backend waiting on a lock, not assumed.

## 3. How the mounted path can lie (finite list; each has a probe in a case below)

| ID | Lie | Caught by |
|----|-----|-----------|
| L-01 | Predicted or optimistic completion shown for a MODEL_READY/UNKNOWN/unchecked candidate (COMPLETED label, VERIFIED effect without observation, "success", plan steps as done) | M-01, M-02, M-04, every post-event DOM scan |
| L-02 | Independent observation missing in the owner row but a VERIFIED label shown | M-02 (effect cards vs `observation_ref`) |
| L-03 | Remaining budget shown renewed, or a second reservation/parent appears after any mounted action | M-02, mutation witness |
| L-04 | Remaining value differs from `limit - sum(charges)` of the original reservation (wrong parent, double count, child limit shown as parent) | M-02 |
| L-05 | A claim of one class rendered under another label (model prediction shown as sourced fact, UNKNOWN shown as proof) | M-03 |
| L-06 | Reload loses the blocked/needs-action state (FAILED/BLOCKED/UNKNOWN session reads as ready or empty) | M-04 |
| L-07 | Stale response of the previous principal/Work/root rendered after a switch | M-05, M-06, M-10 |
| L-08 | Private values kept in component state, DOM, localStorage, sessionStorage, IndexedDB, CacheStorage or a service worker after logout or principal change | M-06, M-08 |
| L-09 | Token refresh replays a mutation, resurrects private data of a prior token generation, or leaves the panel on the old session fence | M-07 |
| L-10 | An offline queue replays a submit/cancel on reconnect, or offline keeps showing private data | M-09 |
| L-11 | A delayed response from the old principal lands after the new principal signed in | M-10 |
| L-12 | The panel shows the requested computation, mandate/terms or remaining resources of another Work, or none of them (silent omission) | M-01 |
| L-13 | The mounted chain omits a link (source -> candidate -> check -> owner -> effect/observation) or a gap, so "no gap" is implied by absence | M-02, M-03 |
| L-14 | The harness itself is blind (selector matches nothing, storage scan skips IndexedDB, delay never in flight) and passes vacuously | positive controls above |

## 4. Case list (finite, with expected value and oracle)

Case ids are scenario ids. Each records PASS / FAIL / NOT_RUN; a failing case never stops later cases and
is never retried inside the run. The first run of a case that fails a UI expectation defines the UI gap;
the expected value is never edited after the run.

### M-00 Preconditions (not a matrix row)
Expected: owned worker running; original parent quiescent (compiler `WAITING|PARTIAL`, no live job);
acquisition session `MODEL_READY` with an `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event; inspection
thread exists for the Work (thread `active_work_id` = Work); the second original parent B2 exists with its
own Work, root, thread; the foreign owner credential signs in (`/api/me` 200, tenant differs from the
original tenant). Any failure marks every dependent case NOT_RUN with the exact predicate.

### M-01 Reload shows the original mandate/Work, terms, remaining resources and requested computation
Rows: Z0-R08-C01, Z0-R45-C01, Z0-R09-C01 (reload part).
Steps: UI sign-in as owner; open the thread route with the root carried by the product's own URL
parameter; observe the panel; `page.reload()` twice; observe after each.
Expected (from O-SQL, matched against the DOM facts after reload):
 1. `data-application-work` equals Work id; the displayed root is `pe_deal / <dealId>`; tenant and native
    principal equal the owner rows; `/api/centropy/me` observed with a Bearer and `/auth/v1/user` agrees.
 2. Original programme id, compiler request id, responsibility identity, original reservation id are shown
    and equal `x1_compiler_episodes`/`p1_requests`/session columns.
 3. Original deadline, wall deadline and learning cutoff shown equal the owner instants (parsed, not string
    compared) and the learning cutoff <= original and wall deadline.
 4. Remaining resources per resource id equal `limit - sum(charges)` from O-SQL (limit from the reservation
    envelope).
 5. Terms/mandate: the standing rule ids and expiry of the original institution mandate, and the requested
    computation (acquisition targets count, original resource demand per resource, requested deadline),
    appear on the Work. Expected owner values: the `institution-mandate` rule ids, the request
    `resourceDemand`/targets of the acquisition session row, and the session `deadline_at`.
 6. No predicted completion: no `COMPLETED` status, no effect card in state `VERIFIED` without an
    observation reference, the Work status label equals the label for the O-SQL session status
    (`MODEL_READY` -> "fresh native binding is still required").
 7. The fact set after the second reload equals the fact set after the first (no drift, no flash of a
    different Work); mutating requests during the case: 0.
Failure that FAILs the case: any fact missing or different; an expected item 5 fact absent from the DOM is
`UI_GAP_MANDATE_OR_REQUESTED_COMPUTATION_NOT_SHOWN` and is the evidence for the UI commit, not a harness
problem.

### M-02 S5/S6/S7 accounting, producer/checker/consumer, observation, no predicted completion
Rows: Z0-R08-C02, Z0-R45-C03.
Expected, each compared DOM vs O-SQL after the reload of M-01:
 1. Same parent: the reservation shown equals `sessions.reservation_ref.id`; `count(s5_reservations)` for
    the tenant and the original envelope digest are unchanged from before the mounted phase (no renewal).
 2. Physical cost: number of charge records shown equals `count(s5_governed_resource_charges)` for the
    reservation; each shown `usedAfter` equals the running sum in `created_at` order; money, human seconds
    and aggregate peak bytes are shown as `UNKNOWN` (not 0, not blank).
 3. Producer/checker/consumer: model ref (producer), check ref and disposition and checker ref
    (independent check), accepted operation ids count, S4 acceptance ref (consumer) and
    `modelConsumedByOriginalP1` equal O-SQL (`p1_events` kind `P1_ORIGINAL_APPLICATION_*` present or not);
    when the original P1 has not consumed the model the panel says "not observed".
 4. S6/effects: the number of effect cards equals the O-SQL join `application_semantics_requests` x
    `s6_obligation_origins`; for each card, observation reference displayed iff `observation_ref IS NOT NULL`
    and `data-application-effect-state` equals the request status; no card is VERIFIED without an
    observation reference; an UNKNOWN/POSSIBLE_EGRESS row (if any) keeps its label.
 5. Counterexample/unsupported/incomplete: the number of counterexamples shown equals the check body's
    count; composition gaps shown equal the composition body (none when no composition exists, stated
    as "no checked composition", not as success).
 6. Original completion owner: text says the learned model does not complete the responsibility; the
    original Work status in `works` is unchanged by the mounted phase.

### M-03 Claim basis classes are distinguishable and equal the native class
Row: Z0-R45-C02.
Native classes in the model envelope (`observed_claims`, `inferred_claims`, `predicted_claims`,
`unresolved_claims`), source observations, independent check results, and the exactness of the check
(`disposition`, `falseValid`, `falseInvalid`). Expected mapping oracle: sourced fact = a claim listed in
`observed_claims`/`source_observations`; assertion = declared/supplied (`declared_type_signatures`,
owner-supplied terms); model-relative claim = `inferred_claims`/`predicted_claims`; exact proof = a check
result with disposition and checker reference; UNKNOWN = `unresolved_claims` or missing evidence.
Expected: for every claim entry in the owner envelope the DOM exposes its class under a stable, distinct
label (text or `data-` attribute) and the class equals the owner list it came from; counts per class equal
the owner counts; no class label is shared across two classes; "exact proof" is never attached to an
inferred/predicted entry. A DOM that only dumps a JSON blob without per-claim class labels FAILs
`UI_GAP_CLAIM_CLASS_NOT_DISTINGUISHABLE` (evidence for the UI commit).

### M-04 Blocked/needs-action state survives reload
Rows: Z0-R45-C03 (actionable blocked states), Z0-R09-C01 (reload part), L-06.
Setup: second original parent B2; acquisition submitted; the launcher-disposable application accounts of B2
only (account_key tag) disabled by owner database action after two session requests, exactly the P1-05 race
of the API scenario. Expected owner state: session terminal `FAILED|BLOCKED|STALE` with a database reason, 0
requests/portal logins after revocation, original programme unchanged.
Expected mounted: after open and after reload the Work shows the non-ready state label for that status,
the owner reason text, no MODEL_READY/COMPLETED label, no acquisition form that could reset the allowance,
and the next owner action is stated (what is missing and who acts). A state shown only as an unlabeled status
word with no missing predicate or next action is `UI_GAP_BLOCKED_STATE_NOT_ACTIONABLE`. If the revocation
race is not reached the case is NOT_RUN `REVOCATION_RACE_NOT_REACHED`, never PASS.

### M-05 Work/root switch through the real Investigations drawer
Rows: Z0-R09-C02 (switch), Z0-R45-C04.
Steps: from the original Work, open the drawer, choose the B2 Investigation; read; choose the original again.
Expected: after switching to B2 the DOM contains none of the original Work's private markers and
`.ct-application-semantics[data-application-work=<original>]` count is 0 while
`[data-application-work=<B2>]` shows B2's own root/IDs (O-SQL); no request for the original Work is rendered
under B2; returning restores the original from a fresh read (a new `application-projection` request is
observed for it) and its facts equal O-SQL again; mutating requests 0.

### M-06 Principal switch: logout, then a different real owner
Rows: Z0-R09-C02 (principal), Z0-R09-C04, Z0-R45-C04.
Steps: UI Sign out (Account menu); sign in as the foreign owner (different tenant, existing database owner);
navigate to the original thread URL; read.
Expected: foreign `/api/me` tenant differs; the original Work's panel count 0; no original marker in DOM or any
storage; the Node-side call of the original Work's projection with the foreign owner's bearer returns 403/404
and the browser's direct request for it (if the page issues one) is not rendered; the foreign principal's own
state is not mixed with the original's; after the foreign owner signs out and the original owner signs in
again the original facts equal O-SQL again from a fresh read.

### M-07 Token refresh
Row: Z0-R09-C03, Z0-R45-C04.
Mechanism: the real isolated Auth issues a 3600 s access token (the launcher fixes `GOTRUE_JWT_EXP`); in a
dedicated browser context the page clock (`page.clock.install` before navigation, then `fastForward`) moves
only the browser's time so supabase-js reaches its own refresh margin and performs a real
`POST /auth/v1/token?grant_type=refresh_token` against the real Auth. No request or response is routed,
fulfilled or rewritten. The Auth server clock is unchanged.
Expected: exactly one observed refresh request with status 200 and a new access token (hash differs from the
previous one, compared in memory); after refresh the panel re-reads under the new token and its fact set
equals O-SQL; the fence changed (a new projection request carries the new token); mutating requests 0;
O-SQL witness unchanged; no old-generation response rendered; refresh_token reuse by the old token is not
needed. If supabase-js does not refresh within the bounded fast-forward the case is FAIL
`REFRESH_NOT_OBSERVED`, not PASS.

### M-08 Real logout then new sign-in
Rows: Z0-R09-C04, Z0-R45-C04.
Expected: Sign out through the Account menu issues the `end-delivery` POST (positive control) and the Auth
`/logout`; afterwards DOM has no panel and no marker; storage scan finds none of the markers, the principal id,
the old access or refresh token; replaying the old refresh token against `/auth/v1/token?grant_type=refresh_token`
from Node returns a non-200 (the real logout revoked the session); a new UI sign-in as the same owner
produces a different access token and the panel facts equal O-SQL from a fresh read, with a new
`application-projection` request observed.

### M-09 Offline then reconnect
Row: Z0-R09-C05.
Mechanism: `browserContext.setOffline(true)` then `false` (real browser offline emulation, no routing).
Expected: while offline the panel shows the offline boundary and no private marker is in the DOM or in
component-visible text; no mutating control is operable; no non-GET request is emitted; after reconnect a
fresh `application-projection` request is observed and the fact set equals O-SQL; no queued request replays
(mutating requests 0; the O-SQL witness, notably `cancel_requested_at` and the session count, is unchanged).

### M-10 Delayed old-principal response
Row: Z0-R09-C06.
Mechanism (documented, no body rewriting): an owned database hold. The scenario takes an
`ACCESS EXCLUSIVE` lock on `finnor_os.application_semantics_sessions` from the admin connection; the
panel's real `application-projection` request is accepted by the API, passes authorization and blocks in
PostgreSQL on the sessions query. The hold is proven by `pg_stat_activity` (a `finnor_app` backend with
`wait_event_type = 'Lock'` and the sessions query) and by the browser request having no response. While it
is held the user signs out and the foreign owner signs in in the same tab. The lock is released before the
proxy's 20 s budget. The old request then completes at the API; the browser either aborted it (the panel's
own abort/fence) or receives it.
Expected: whichever occurred is recorded (`requestfailed` with abort, or `response` status/bytes); in both
cases the foreign principal's DOM contains no original marker and no original Work panel, both before and
after the release and after a further 5 s settle; storage scan clean; mutating requests 0. Failure to show a
backend waiting on the lock is `HOLD_NOT_IN_FLIGHT` (FAIL, not PASS).

## 5. Non-goals and explicit limits

- No phase acceptance, protected admission, 100x or production claim. All sessions are
  `DISPOSABLE_TEST_AUTHORITY` development runs.
- An in-flight mutation raced against a token refresh or an offline transition is not exercised (the
  panel offers no mutating control while offline or while the scope is unverified; the case asserts the
  absence of any such control and of any replay, not a race outcome).
- Real token expiry is not driven (the launcher fixes a 3600 s lifetime); the refresh path is real, the
  trigger is browser-side clock advance. A launcher environment override for a short lifetime is the exact
  patch request if the coordinator wants true expiry.
- Screenshots are evidence of what was rendered only; every claim is checked against O-SQL/O-API.
  Screenshot originals are mode 0600; any committed derivative must be redacted (no email, token).

## 6. Pre-run amendments (written after reading the mounted panels, before any run; nothing below was observed)

The mounted Work page renders two private panels for the original Work, so M-01..M-04 read both:
`section[aria-label="Institution responsibility"]` (`InstitutionProgramPanel`: standing responsibility rows,
original deadline, observed/inferred/unresolved claim counts, attempts and acquisition units retained) and
`.ct-application-semantics` (`ApplicationSemanticsPanel`). Owner expectations for the first are taken from
`POST /api/company-brain/institution-read` (O-API) cross-checked with `x1_compiler_requests`,
`x1_compiler_episodes` and `p1_programs` (O-SQL).

1. M-01 item 5 is split into separately recorded predicates (mandate responsibility rows, requested resource
   demand per resource, requested targets, requested deadline). Each failing predicate is named
   (`UI_GAP_*`); the case outcome is FAIL when any of them is absent.
2. M-04 revokes only the application accounts of B2 (`account_key` carries B2's tag), not every `x2_portal`
   account of the tenant, so the original Work's MODEL_READY session is not affected by the revocation.
3. M-07: after the first real refresh the token's server-side expiry is again inside supabase-js's
   refresh margin of the advanced browser clock, so further refreshes at the library's 30 s tick are expected.
   Expected is: at least one refresh request, every observed refresh answered 200 by the real Auth, the first
   one yields a new access token, and the panel re-reads under the new token within 45 s. "Exactly one"
   is replaced by "all observed refreshes are real 200 grants and none replays a mutation".
4. M-06/M-10 foreign principal: the launcher-seeded owner of a different tenant is used when present
   (`users.role = 'owner'`, tenant differs); otherwise the cases are NOT_RUN `FOREIGN_OWNER_NOT_SEEDED`.
   Its Auth credential is created through the isolated Auth admin endpoint with a random password kept only
   in memory.
5. Root carriage: the Work page is first opened without a `root` parameter (the product's persisted root
   path). If the panel does not mount within 30 s, the `root` URL parameter of the product's own routing
   (`?root={"entityType":"pe_deal","entityId":...}`) is used and `ROOT_NOT_PERSISTED_BY_THREAD` is
   recorded as an observation (not a failure of the Work readback).
6. Locale/time: browser contexts use `en-US` and `UTC` so the panel's date formatting can be compared to
   owner instants at minute resolution.
7. M-07 normalises the panel's browser-clock dependent phrases (deadline "expired", validity window wording)
   out of the fact signature, because the page clock is deliberately advanced; the instants themselves are
   still compared.
