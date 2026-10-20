# Typed S8 application-command negatives — pre-code contract

## Deferred live native-use relay, not delivered or verified

The 53 lifecycle/retained-lease refusals pass in native 084. The existing
live-use cases still require a genuinely current, unreconciled native lease.
The late, unvalidated relay addition was withdrawn. Its patch is retained
outside the checkout in `live-use-relay-unvalidated-001.patch`; no live-use
coverage is claimed. The following is a deferred pre-code proposal only.
Use only a fixture-owned loopback HTTP relay, armed before signing the native
consumer configuration. Direct fixture commands continue to reach the real S8
server, never the relay. No product hook or manufactured currentness is allowed.

Forward the first native USE once, preserving its bearer authentication,
envelope identity and request bytes. Obtain the real successful upstream lease
before holding that exact response. Run the existing live-use suite, including
its positive original-currentness RECHECK, then release the unchanged upstream
status, headers and body only after PASS. The native worker cannot begin its
physical dispatch while waiting for this response.

Credible failures are an absent/failed original USE, malformed or oversized
traffic, expired lease, unexpected snapshot mutation/refusal, timeout, client
disconnect, late suite completion, response substitution, recursive relay
delivery, or incomplete owned-server cleanup. Bound the hold to the smaller
of eight seconds from request receipt and the original lease expiry. Keep the
consumer's ten-second timeout and all physical/currentness/grant deadlines
unchanged. Timeout/disconnect cancels suite fetches; every command and PASS
assignment checks cancellation. Destroy the held connection on failure, never
return a synthetic success. Await outstanding suite work before stopping the
owned services. A worker that never reaches USE must fail without awaiting an
unreachable completion promise.

Record only request/response byte digests, identities, timing and the private
suite artifact path. Never record authorization headers or credentials. This
does not supply another independently qualified domain or test its cumulative,
revoked-live-use or expired-activation boundaries.

Registered before changing `finnor-os/scripts/x2/native-s8-fixture.mts`.
This is an opt-in, finite native test-harness extension, not production code,
an admission oracle, a new authority store, or qualification evidence.
Authoring delivers no commands and runs no validation processes.

## Observable contract and credible regression

The entry is the fixture's existing authenticated `POST /command`, through
`commandAs`, using its unchanged configured role principals, tokens and
Ed25519 keys. The egress is the real CapabilityEvolution application owner,
its signed journal, and the canonical S6 commitments/readbacks. No mocked
receipt, replacement model, self-issued currentness, or protected grant is
permitted.

A syntactically valid, genuinely signed substitution can regress by reaching
the wrong guard, becoming an accepted journal event, changing activation, or
consuming/releasing reservations. A parser/bootstrap refusal does not test
that owner guard. A late REGISTER/EVALUATE/ADMIT negative can also pass for
the wrong reason because the positive event already exists. Therefore:

- Candidate negatives run after the original proposal/native publication.
- REGISTER, EVALUATE, ADMIT and ACTIVATE negatives run immediately **before**
  their respective unchanged positive calls, with the caller's independent
  original bodies. Canonical READ must prove the required preceding state.
- Every mutation is locally parsed with the actual exported command schema;
  candidate identities are recomputed and signatures use the existing keys.
- Exact HTTP status and owner code are required, not merely non-200.
- Canonical READ before/after each refusal must be identical, including
  history sequence, application state, uses, liabilities and accounting.
- A live-use positive RECHECK must succeed before testing guards dependent on
  currentness. It may retain evidence, but cannot allocate another use.
- A bounded private artifact records source/input digests, deterministic
  mutation descriptions, request identities, expected/observed dispositions,
  before/after state digests, controls, missing coverage and rerun order.
  It contains no tokens, keys, application credentials or private wire frames.

The original model/check, independent evaluation, revision, activation,
source pins, grants, original deadline and configured distinct evaluator/
promoter identities remain independent controls. Never revoke, replace,
expire, or exhaust the positive fixture revision to obtain a negative.

## Trusted owner dispositions

Expected values come from the current owner sources, not from a failed run:
`packages/capability-evolution/src/application-port.ts` (typed dispatch,
sources/model/currentness, signature separation and lease guards),
`lifecycle.ts` (authentication, serialized delivery, idempotency and replay),
and `contracts.ts` (`assertSignature`, fault status and HTTP classification).
Paths above are relative to `finnor-os`.

| Properly shaped/authenticated mutation | Exact expected disposition |
| --- | --- |
| Existing actor with the wrong application role | 403 `S8_OPERATION_NOT_AUTHORIZED` |
| Candidate/protocol/evaluation tenant or owner substitution | 403 `S8_TENANT_OR_OWNER_MISMATCH` |
| Existing other-role key signs an evaluator/promoter command | 403 `INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID` |
| Candidate source-pin digest substitution | 409 `S8_APPLICATION_SOURCE_CLOSURE_SUBSTITUTION` |
| Candidate dependency or internally consistent application/account-domain substitution | 409 `S8_APPLICATION_NATIVE_MODEL_SUBSTITUTION` |
| Registration evaluator/dependency/evidence/case/time substitution | 409 `S8_APPLICATION_PROTOCOL_INVALID` |
| Evaluation protocol/evaluator/dependency/evidence/oracle/case/time substitution | 409 `S8_APPLICATION_EVALUATION_BINDING` |
| Admission evaluation/dependency substitution | 409 `S8_APPLICATION_ADMISSION_BINDING` |
| Activation generation/predecessor/admission/dependency/expiry/policy-limit substitution | 409 `S8_APPLICATION_ACTIVATION_BINDING` |
| USE model/check/parent/profile/domain/operation/reservation/deadline/currentness-owner substitution | 403 `S8_APPLICATION_USE_BINDING` |
| Real resource preimages with changed resource-envelope digest | 403 `S8_APPLICATION_ORIGINAL_RESOURCE_BINDING` |
| Real currentness preimage with changed input/application-revision binding, or a different genuine incompatible currentness preimage | 403 `S8_APPLICATION_CURRENTNESS_INVALID` |
| RECHECK wrong exact lease digest | 409 `S8_APPLICATION_USE_IDENTITY` |
| Live RECHECK changed immutable request binding | 403 `S8_APPLICATION_USE_STALE_OR_RECONCILED` |
| Accepted command ID reused with a changed body or authenticated actor | 409 `S8_IDEMPOTENCY_SUBSTITUTION` |
| RECONCILE wrong revision, prior evidence or evidence owner | 403 `S8_APPLICATION_RECONCILIATION_BINDING` |
| Disposable sibling revocation wrong generation/activation | 409 `S8_APPLICATION_REVOCATION_BINDING` |
| Fresh signed command on that correctly revoked sibling | 403 `S8_APPLICATION_REVOKED` |
| CURRENT on revoked sibling | 200, `current: false`, no admission/activation |
| Genuine separately activated/leased disposable revision: USE/RECHECK, including exact accepted-command replay after revocation | 403 `S8_APPLICATION_UNADMITTED_REVOKED_OR_EXPIRED` |
| Genuine current command after an isolated cumulative use/cost bound is actually exhausted | 429 `S8_APPLICATION_CUMULATIVE_RESOURCE_BOUND` |

Activation limit mutations are only submitted when a value above the actual
signed policy limit still fits the command schema. Otherwise the intended
policy-limit guard is explicitly unavailable, not credited as a schema test.

## Disposable and stronger-coverage gates

The helper may propose a sibling whose only identity change is an explicit
parent edge to the original revision, then revoke that **unactivated**
sibling. It retains the exact original model, grants, deadline and source cut.
The sibling is never evaluated using invented or recycled one-use cases.
Revoking it must not change the original revision's domain generation or
activation. This reaches the real signed revocation and revoked-command
guards, but is not a revoked **live lease** or an expired activation test.

An optional isolated live-lease exercise must require an already independently
admitted/activated second candidate in a **different** parent/scope domain,
with real retained currentness, an unreconciled unexpired lease and the exact
accepted USE request identity. It may not use the positive fixture candidate.
Only that separate candidate may be exhausted or revoked. Genuine currentness
and the real command boundary, not a mutated `reservedCost` with an obsolete
stamp, are required before claiming cumulative-resource coverage.

The following are unavailable unless their explicit real prerequisites are
supplied; the returned matrix/artifact must say so:

- Expired/revoked evaluator or promotion keys: the frozen fixture contains
  only current, nonrevoked keys and cannot rewrite its signed policy.
- Same-principal evaluator/promoter command separation: fixture bootstrap and
  `CapabilityEvolution.open` reject that policy before authenticated dispatch.
  A wrong-key command tests signature/principal binding, not this deeper guard.
- Wrong-role-principal proposer/consumer with the correct role: current signed
  policy configures only the original native principal in those roles.
- Expired activated-domain/lease behavior: do not shorten shared deadlines,
  sleep through the original grant, or expire the positive activation.
- Revoked USE/RECHECK replay and cumulative reservation/use exhaustion require
  the separate independently qualified live subject described above.
- Different-owner currentness substitution requires a genuine schema-valid S4
  currentness preimage, not a fabricated receipt or an unrelated S4 model.
- The existing exact-original transition-evidence reconciliation mutant stays
  separate; these added binding refusals do not supersede its stronger check.

## Finite verification and handoff

READ is a complete, sequence-bound page with at most 256 retained rows;
an incomplete/racing snapshot is a precondition failure, not a test pass.
Deliver suites serially with no concurrent native worker/S8 writer. Each
expected refusal must leave the whole canonical snapshot unchanged. Accepted
controls/disposable events have explicit permitted state changes and must
leave the positive revision and positive-use/accounting projection unchanged.
Stop on the first unexpected disposition or state change.

Main reviews/adopts serially, then typechecks, performs fixture-only
reconstruction and executes only after native078 ends. No test, build,
server, browser, database, security scan, command delivery, publication,
protected activation or active installation/evidence/private-state mutation
is authorized during this authoring assignment.

## Implementation handoff addendum (not execution evidence)

Exported entry:

```ts
runNativeS8ApplicationCommandNegatives(
  fixture: NativeS8Fixture,
  input: NativeS8ApplicationCommandNegativeInput,
): Promise<NativeS8ApplicationCommandNegativeReport>;
```

It delegates to `fixture.checkApplicationCommandNegatives(input)`; existing
positive methods and their return types are unchanged. The finite input union
has `candidate`, `register`, `evaluate`, `admit`, `activate`, `retained-use`,
`live-use`, `disposable-revocation`, `isolated-live-use`, and
`isolated-expired-activation` phases. There is no automatic command delivery
when an existing caller merely bootstraps or uses the fixture.

### Main's serial insertion points

Import the helper from the same `native-s8-fixture.mts` module. Extract the
existing inline positive bodies into unchanged typed local variables; do not
regenerate evidence, case commitments, grades, grants or deadlines for these
tests.

```ts
const proposal = await s8.propose();
await runNativeS8ApplicationCommandNegatives(s8, { phase: "candidate" });

// protocolBody is the existing independent inspector's original registration.
await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "register", body: protocolBody,
});
const registered = await s8.register(protocolBody);

// Keep the original independent grading and original results/costs unchanged.
await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "evaluate", body: evaluationBody,
});
const evaluation = await s8.evaluate(evaluationBody);

await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "admit", body: admissionBody,
});
const admission = await s8.admit(admissionBody);

await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "activate", body: activationBody,
});
const activation = await s8.activate(activationBody);

await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "disposable-revocation", protocol: registered.signed.body,
});

// After actual native execution: lease comes unchanged from canonical READ.
await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "retained-use", lease: retainedUse.lease,
});
```

Registration additionally requires canonical `consumedCases === 0`, ensuring
the registration mutants cannot be masked by another already-consumed
population. Running any signed lifecycle phase after its positive event is a
precondition failure, not a passed negative.

For a live egress hook, while its actual native request is current and its
canonical lease is unexpired, unreconciled and has no possible-effect lineage:

```ts
await runNativeS8ApplicationCommandNegatives(s8, {
  phase: "live-use",
  command: realUseCommand,
  lease: realLease,
  // Optional: a different genuine, unexpired, incompatible S4 currentness ref.
  // alternateCurrentnessRef,
});
```

`realUseCommand` is the actual typed USE command, not consumer configuration
or a reconstruction claiming `current: true`. The stage first performs and
owner-reads-back one successful RECHECK. It requires the original currentness
and lease to remain live before **and after** binding mutations, so expiry
cannot explain a passing currentness-substitution refusal. Do not run it
against the driver's already reconciled terminal leases; use `retained-use`
there. Never extend the original 100..30,000ms currentness bound to make a
suite pass.

The separate-domain phases take an actual retained `candidate` and `command`;
`isolated-live-use` also requires its real live `lease`. They verify the
second candidate's authenticated S8 preimage and independent active domain,
and protect the original fixture's revision/activation/use/accounting
projection. They do **not** construct this second candidate's native
acquisition, independent registration/evaluation or currentness. Those are
additional real prerequisites not supplied by the current single-candidate
driver. The existing primary-only `register`/`evaluate` fences are not relaxed.

- `isolated-live-use` only submits a cumulative-resource negative if canonical
  counts/costs and the genuine signed activation show an actual existing
  bound. It creates no additional USE lease to exhaust a limit. It then
  revokes only the second revision and tests fresh USE/RECHECK and the exact
  original accepted USE plus successful RECHECK envelope/body replays.
- `isolated-expired-activation` requires an **already** expired authentic
  activation while its original parent and the positive fixture remain
  current. Its command must equal one of that subject's real retained USE
  commands. A fresh USE must return 403 `S8_APPLICATION_NOT_ACTIVE`; CURRENT
  must return 200/false. It never changes a deadline or sleeps.

### Implemented versus still conditional/deferred

All rows describe authored code, not a run or a qualified result.

| Phase/boundary | Authored coverage / remaining prerequisite |
| --- | --- |
| Candidate | Seven refusals: configured wrong role, tenant, principal, source cut, dependency cut, account domain, supported-domain substrate |
| Registration | Nine refusals before positive registration: role, signer, tenant, principal, evaluator, dependency, original evidence, duplicate cases, pre-candidate timestamp |
| Evaluation | Eleven refusals before positive evaluation: role, signer, tenant, principal, evaluator, protocol, dependency, evidence, oracle, cases, pre-registration timestamp |
| Admission | Four refusals: role, signer, evaluation ref, dependency; genuinely different negative evaluation counters remain deferred |
| Activation | Eight base refusals plus policy-use/cost ceilings only where schema-reachable; default policy permits the use-ceiling test but not a cost above 100 |
| Retained lease | Seven refusals: wrong exact lease digest, accepted USE body/actor idempotency substitution, reconciliation role/revision/prior-evidence/evidence-owner |
| Disposable revocation | Six refusals plus genuine propose/revoke/CURRENT controls; only the unactivated sibling is revoked |
| Live use | Twenty-five base refusals including retained-use checks, consumer role checks, exact model/check/parent/profile/domain/request/resource/currentness substitutions; requires a real live egress hook |
| Different genuine currentness | One additional refusal only with an actual, unexpired incompatible S4 preimage supplied and owner-read-back |
| Live revocation/replay | Four additional refusals only with an independently qualified different-domain live subject; not supplied by the current primary fixture results |
| Cumulative resource/use | One conditional 429 test; reports the exact actual triggering use/cost predicates and never credits a changed request with an obsolete currentness stamp |
| Expired activated domain | Conditional isolated already-expired activation stage; no expired positive revision or synthetic authority |
| Revoked/expired keys, same-principal evaluator/promoter, correct-role different proposer/consumer | Explicitly deferred by the unchanged signed policy/bootstrap fences; no policy/key/identity mutation |

### Artifacts and validation still required

Each suite bounds observations to 128 and writes new, no-follow, exclusive,
mode-0600 files under the newly bootstrapped fixture's private directory:

- `command-negatives-<run-id>.json`: expected/observed statuses and exact codes,
  mutation rules, command identities/digests, canonical before/after digests,
  controls, deferred boundaries, flags, failure code and timestamps.
- `command-negative-input-<run-id>.json`: strict typed base refs/bindings only
  for reconstruction. No native wire/observation preimage, token, key,
  application header, credential or session handle is serialized.

The report exposes both paths and the input/source-cut digests, not the input
body. `commands.jsonl` retains the actual HTTP attempts, canonical READ
responses and report digest/path. A failing suite writes its partial report
and stops rather than accepting a parser error, generic refusal or changed
state. PASS is **phase-local** and retains all explicit deferred coverage.

Authoring performed read-only source/diff inspection and a whitespace-only
`git diff --check`. No TypeScript validation, test, build, fixture
reconstruction, server, browser, database operation, command delivery or scan
was run. Main must review the owned diff, typecheck with the backend fixture
included, reconstruct the fixture-only cut, and deliver the staged native
checks serially after native078 ends. No publication is requested.