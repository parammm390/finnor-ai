# Frozen independent DEVELOPMENT permissions-portal oracle

Revision: `permissions-portal-development-1`. Contract and credible regressions were fixed **before fixture code and before the X2 learner/checker kernel** in `finnor-os/scripts/x2/fixtures/oracle-contract.json`. `freeze.json` seals that file and this specification; source commit is **unknown/uncreated**, not an invented identity. The supplied base is commit `517003a4396bc8101a90be4b425ee01de9446740`, tree `07ba69b8e96f05944c2f9f14a74b2c400eb89e42`. Original request SHA256: `6ec96e483e3b35ddf4771de1f9298e85feca0d6b4e749001d9af2b5ab13e48cd`.

This is a disposable, independently authored application and evaluator, **not** an application connector for FINNOR. No production checker truth exists or is imported. Fixture readiness is not learner, owner, native, mounted, installed, protected-population or business-value proof. The existing X2 gates and A–J obligations remain unchanged.

## Fixed business rules and limits

- Two discovery records and a separate fresh held-out record are generated in a primary test account. A second isolated test account supplies cross-account negatives. Identities are random on each initialization. Discovery grants cannot list/read the held-out record.
- `save draft`, `validate`, asynchronous `submit`, and separately authorized `commit approval` are distinct persistent operations. Baseline committed reporting does not change until approval.
- Reporting is the exact tuple `(amount, currency, entity, unit, date, basis)`. Amounts are canonical **strings** with exactly two decimal places, at most 18 integer digits and no redundant leading zero. Validation compares integer minor units using `BigInt`; there is no `Number` quantity arithmetic, rounding or conversion. Dates are real dates in 2026–2027. Units are `ones` or `thousands`; basis is `cash` or `accrual`. Entity-owned currency must match and amount must be positive for VALID. Schema-valid invalid business drafts can be saved and then independently found INVALID.
- Acceptance fsyncs a PENDING request before writing HTTP 202 / the “Submission accepted” status message. A separate delayed transaction makes it SUBMITTED. A toast or 202 cannot establish business completion.
- Approval requires a different principal with the approver role and a current record-scoped approval grant. It binds the exact completed submission and updates committed reporting only then. Editor/reader authority is insufficient.
- Dispatch binds application/account/record/principal identities, application/schema/semantic/authority/grant revisions, expected record version, request/effect/obligation/idempotency/parent identities and the original deadline. Rendering identity is carried but does not itself change API semantics.
- Only the baseline state and the named 13 readiness contracts are independently specified here. This fixture is not a complete external transition identification, a universal operation grammar or protected qualification.
- Ceilings: 16 records; 4,096 request attempts; 32 MiB journal; 32 KiB HTTP body; 1,800-second issued-grant lifetime; 5-second store-lock wait; 90-second readiness run. Async delay is 100–10,000 ms; acknowledgment/readback delay 0–10,000 ms. Exhaustion fails explicitly; data are never silently truncated.

The finite domain, negative boundaries, credible regressions and missing stronger coverage are frozen in `oracle-contract.json`, including R01–R13. They do not shrink after failures.

## Surface profiles, structures and lawful observation

All profiles run the same independent state machine:

| Profile | Exposed application structures |
| --- | --- |
| `api` | Authenticated OpenAPI 3.1/documentation, JSON context/record/request reads and JSON mutations; ordinary accessible portal forms also exist. |
| `ui` | Ordinary accessible login, lists, record descriptions, HTML forms, validation results and request-completion pages. `/api`, `/docs` and `/openapi.json` return 404. No embedded JSON oracle. |
| `hybrid` | JSON context/record reads and draft/validation APIs; submission and approval require ordinary HTML forms. Their JSON mutation routes return 404. |

Public route families: `/healthz`, `/login`, `/logout`, `/portal`, `/portal/records/{record}`, `/portal/requests/{request}`, `/api/context`, `/api/accounts/{account}/records`, `/api/accounts/{account}/records/{record}`, record `/draft`, `/validate`, `/submit`, `/approve`, `/api/requests/{request}`, `/docs`, `/openapi.json`. Rendering revision 2 changes HTML action paths. `/portal/records/{record}/preview` is the deliberately deceptive GET boundary.

The honest public docs contain route, field, format and response structures only. They contain no `x-finnor` transition/effect/precondition annotations, expected workflow, held-out objective, demo IDs, evaluator facts, locator recipe or human driver. HTML has normal labels, form actions, hidden application context, concurrency/request fields and CSRF protection; it is not a selector manifest.

Public JSON mutation shape: `{context, request, expectedVersion, reporting?, submissionRequestId?}`. Context names the exact application/account/record/principal and current application/schema/semantic/rendering/authority/grant revisions. Request contains `requestId`, `effectId`, `obligationId`, `idempotencyKey`, `parentId`, `deadline`. API authentication uses a private bearer binding plus `X-Portal-Grant`; browser login uses those test credentials to issue an HttpOnly/SameSite session and CSRF-protected forms.

Public record observations have 16 top-level typed fields: application/account/record identities; record version; application/schema/semantic/rendering/authority revisions; phase; committed reporting; draft; validation; submission; approval; observation coverage. Authenticated context adds the principal, grant, account-owned entities and allowed actions. Record and request readbacks are application-owned observation surfaces, not runtime-provided receipts. Private paths are never served.

## Private administration and custody

Source assets live only under `finnor-os/scripts/x2/fixtures/`. `admin.mjs`, `evaluate.mjs`, the frozen files, readiness code and provider storage must **not** be mounted or disclosed to the candidate. They belong to the development evaluator/application administrator, not learner input.

Initialization creates an absolute **new** custodian directory (0700), journal and credential/packet/objective files (0600). Plaintext test tokens, issued identities, session/CSRF material, unredacted HTTP evidence and evaluator snapshots stay there, outside public evidence. Public readiness evidence replaces them with stable aliases, preserving response status/error/body structure and separate evidence digests. No real customer or hosted credential is used.

**Concrete custody limitation:** directory permissions isolate different operating-system users, not arbitrary tools running as the same UID. Network-only candidate access has no evaluator endpoint. If the main harness grants the candidate unrestricted same-UID file/process execution, custody is unsatisfied; it must restrict/mount tools or use a genuinely separate custodian user. This fixture cannot honestly claim to sandbox such a candidate without that integration. No protected signer/grant is created.

The CLI exports separate private exploration, execution and approver packets. Only discovery inputs are available initially. `release-held-out` makes a fresh execution grant/objective and a separate approver grant available to the custodian. The **main E2E must seal acquired-model bytes first**, and then supply only the approved objective/credential subset. Fixture readiness may exercise release, but does not pretend to acquire or freeze a learner.

The evaluator independently parses/verifies journal bytes and checks the frozen business assignment, exact identities/tuple, transition order, distinct approval authority, request/completion counts and duplicate attempts. It imports no provider transition functions and never supplies runtime receipts. Its commands require filesystem custody, write private output, and print only a non-sensitive summary. It can inspect a durable acceptance event to coordinate an external fault.

## Revisions, mutations, currentness and faults

- Rendering revision 2 changes field names, element IDs, grouping/order and HTML action URLs. Semantics are preserved. Relocation/revalidation by a future learner must be lawful; this fixture does not authorize it.
- Semantic revision 2 keeps **Submit** and the 202/status message but confirms validation instead of submitting. Public current revision and later readback reveal the difference. Submission-dependent compositions must be fenced by the future consumer; unrelated reads/drafts remain independently meaningful.
- Administrator controls independently revoke a principal, remove a role or revoke a grant. Every physical request checks current state. Old sessions/tokens and prior success confer no continuing authority. Already accepted effects are not erased by later revocation.
- The GET **Preview** trap becomes `submission.create`, checked under that authority rather than `record.read`. A read-only grant is denied; an explicit authorized test send can demonstrate the misleading-method effect.
- `drop-next-submit` destroys the **real response socket after durable acceptance**, not before request dispatch. `hold-next-submit` delays the acknowledgment after acceptance. Async and readback delays are separately controlled; requests remain durably queued across server restart.
- External evaluator/orchestrator must wait for the journal's `submission.accepted` event, then `SIGKILL` the **actual main worker/session** before its acknowledgment. No provider/production “kill worker” hook exists. This readiness assignment does not run native worker SIGKILL.
- Normal mode offers exact authenticated request readback and stable idempotency. Same original bytes/identity return the original request; another identity for an existing submitted record is denied and retained in the request journal.
- `opaque` completion mode intentionally provides neither completion observation nor submission idempotency. Version/phase/submission/approval/committed reporting are masked equally before and after possible submission; every request lookup is unavailable. Private evaluator inspection still sees accepted/completed requests and duplicates. Missing-versus-accepted cannot be resolved lawfully; the runtime must retain UNKNOWN/exposure and not retry.
- Pending completion is owned by the provider, not the caller. Caller cancellation/death does not compensate it. Unauthorized compensation, resource release, fallback, parent budget refresh and production activation are outside this fixture.

## Persistence and concurrent-process safety

Two designs were considered: an in-memory timer/state with checkpoint (too easy to lose accepted requests), and an authoritative append-only transactional journal. The latter is used without dependencies.

An atomic `mkdir` store lock serializes every transaction across local processes. The journal contains complete post-transaction state, events, monotone sequence and hash-chain identity; append is fsynced before success. A process-local queue prevents self-interference. Due requests are completed under the same lock, so two provider processes cannot both complete a normal identity. Private authorization/session data are never public state.

Orphan locks and incomplete/tampered journal tails **fail closed**, not silently discarded. Offline `recover-lock` is allowed only after the custodian stops all writers and the recorded lock owner is dead; it does not modify journal bytes. PID reuse, missing owner metadata and partial journal repair are unsupported and require independent inspection. Local process/restart durability is exercised; power-loss/storage-hardware durability is not certified.

## Launch, readiness, observation, stop and rerun

Use Node 22 standard facilities only; no package, lock, migration, cloud, model, solver or browser installation:

```sh
FIXTURE=/Users/paramdave/.factory/worktrees/frontier5-x2-software-semantics-compiler/FINNOR/finnor-os/scripts/x2/fixtures
PRIVATE=/tmp/x2-portal-<unique-custodian-run>
node "$FIXTURE/admin.mjs" init --private-dir "$PRIVATE" --surface hybrid
node "$FIXTURE/server.mjs" --private-dir "$PRIVATE" --port 0
```

The server binds **127.0.0.1 only**, rejects mismatched Host/Origin, prints `{event:"ready",origin,pid}` without private paths/tokens, and writes private `readiness.json`. Poll `$origin/healthz`; use the custodian packet for authenticated reads. Save the printed PID in the owning orchestrator. Stop with `kill -TERM <owned-pid>` and wait for exit; do not kill a peer server. Accepted due requests remain in the journal and complete after restart. No automatic cleanup removes evidence.

Administrative examples (private outputs; no token stdout):

```sh
node "$FIXTURE/admin.mjs" release-held-out --private-dir "$PRIVATE"
node "$FIXTURE/admin.mjs" set --private-dir "$PRIVATE" --patch '{"renderingRevision":2}'
node "$FIXTURE/admin.mjs" set --private-dir "$PRIVATE" --patch '{"semanticRevision":2}'
node "$FIXTURE/admin.mjs" set --private-dir "$PRIVATE" --patch '{"responseFault":"hold-next-submit","ackDelayMs":1200}'
node "$FIXTURE/evaluate.mjs" wait --private-dir "$PRIVATE" --event submission.accepted --request-id '<private-original-request>' --timeout-ms 3000
node "$FIXTURE/evaluate.mjs" grade --private-dir "$PRIVATE" --objective "$PRIVATE/held-out-objective.json" --output "$PRIVATE/grade.json"
node "$FIXTURE/evaluate.mjs" snapshot --private-dir "$PRIVATE" --output "$PRIVATE/evaluator-snapshot.json"
```

`admin.mjs revoke --kind principal|role|grant --id <private-id>` and role revocation additionally `--role editor|approver|reader` operate on test-owned authority. `set` allows only declared controls, not arbitrary state or code.

Bounded readiness E2E, exercising the real local HTTP listener, HTML form protocol, durable store, private administrator and separate evaluator:

```sh
node "$FIXTURE/readiness.mjs" --artifact "$FIXTURE/artifacts/readiness-smoke.json"
```

The artifact is created exclusively (reruns require a new filename), records frozen/source/runtime hashes, inputs, actual HTTP status/body or socket error, intermediate states, administrator/evaluator/process steps, durations, failure bytes, private evidence hashes and precise coverage gaps. It starts only one small fixture server at a time, stops owned processes in `finally`, preserves private originals, and does not delete unrelated files. The artifact's actual result, not this specification, determines readiness PASS/FAIL. Failed/interrupted attempts must remain.

No unit tests are added. R01–R13 are pre-code protocol contracts with stronger native coverage explicitly missing. Physical main-worker SIGKILL, real browser pointer/keyboard, native S4/P1/S5/S6/S8 consumers, model invalidation, budgets/cost meters, comparator/J outcomes and installed/upgrade proof belong to the main integrator, not this smoke.
