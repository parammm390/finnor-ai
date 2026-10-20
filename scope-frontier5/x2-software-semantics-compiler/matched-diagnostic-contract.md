# Bounded matched diagnostic: failure/oracle contract

Written before harness implementation and execution. Scope: disposable local
orchestration and read-only configuration/admission inspection, not new authority.

## Frozen enrollment and accounting

Three surface strata remain separate: native-099 API, native-100 hybrid and
native-101 UI opaque, using installed-009 and product commit 5e9a728. The harness
must seal exact proof, application, oracle, driver, provider and runtime hashes
and objective/starting-state identifiers into registration.json BEFORE executing
configuration/admission attempts. It must not infer identical per-run identifiers
across independent historical runs. A missing exact identifier is UNAVAILABLE.
Source drift or missing evidence rejects reuse; passing historical proofs are
supporting evidence only, never new matched-arm executions.

Each hypothetical pair requires the exact same application/version, record,
starting state, objective, independent source-oracle revision, offered surface,
permitted public exploration, resource envelope, model and editor/distinct-approver
roles/grants. No API-as-UI substitution. Existing proof parameters are pinned by
content; unresolved live inputs are NOT_ENROLLED, not filled with invented IDs.
Candidate code may never inspect private fixture truth. This orchestrator may
hash historical private objective/initial-state evidence, but must not expose
credentials, private journal contents or secret values.

Bounded feasibility horizon: one registration/preflight per three surface strata,
three arms (X2-enabled, strongest incumbent, equipped integration), no business
attempts authorized by this contract. Cold business horizon is not enrolled;
mature reuse horizon and actual eligible demand remain UNKNOWN, not zero.
No statistical power, throughput denominator or multiplier is available.
Preparation provenance: contract and harness creation are attributable to this
task; historical build/discovery/fixture preparation and human effort remain
UNMEASURED. Diagnostic wall/CPU/RSS measures must be labeled orchestration-only.
Discovery, model construction, checking, execution, recovery, invalidation,
maintenance, infrastructure/provider and human lifecycle costs remain UNKNOWN
unless a bounded actual measurement with its scope is recorded.

## Finite failures and independent checks

1. Reject existing output directories, symlinks, out-of-scope writes, missing pins,
   unparseable evidence, stale/mismatched candidate source hashes, failed historical
   assertions, missing oracle evidence, and source drift during execution.
2. No dotenv/secret loading, network, database, browser, paid provider or child
   worker launch. Inspect only Boolean inherited configuration presence. Presence
   does not establish credential validity or authority.
3. Inspect current existing-owner admission source and explicit fixture profile
   type. This is an executed source/config preflight, NOT a runtime owner refusal.
   Generic fresh WRITE refusal cannot become a throughput denominator.
4. No forged task/effect rows, direct private application transport baseline,
   hand-authored portal executor, admission relaxation or new comparator capability.
5. Missing compatible existing profiles/provider/entrypoint yields terminal
   INCONCLUSIVE, each arm businessStatus NOT_RUN and measurements null. Even if
   Boolean keys are present, no external effect is authorized here.
6. Record every orchestration attempt, outcome, input pins, unknown predicates,
   exact invocation and source/runtime identities in result.json. Failures remain
   failures; diagnostics may complete while the original matched-run gate is
   UNPASSED and matched business executions remain zero.

## Commands and result interpretation

Entrypoint: `finnor-os/scripts/x2/run-matched-diagnostic.mjs --output <fresh
absolute task-private directory>`. It uses only Node standard library.
Exit 0 means the diagnostic receipt completed consistently, NOT business success;
result verdict remains INCONCLUSIVE. Exit 1 means orchestration/integrity failure.
Run `node --check` and scoped repository ESLint on this harness only. No test
stack, shared documents, publication, commit or push is authorized.
