# Exact coordinator integration request

Active request: `request-07/manifest.json`, with `request-07/shared.patch`.
Patch SHA-256:
`793cd28d935908cc50d3eebee513f0deda0e2f39e7f9e3e12d90a340a6794ef7`.
All eleven exact preimages and postimages are retained. Requests 01–06
are historical, not alternative permissions to apply stale bytes.
Historical request 05's shared patch is byte-identical to 04, but its required
owned SQL body changed. Request 06 changes only the new-file mode header;
all eleven source pre/postimages and migration metadata are byte-identical
to 05. Request 07 changes only the policies-route postimage to handle
bounded Z5 planning refusals; all eleven preimages, ten other postimages and
SQL metadata match 06. The current manifest SHA-256 is
`fb88fe4dc4b23d46927a92c716f8d64c2edfc2f33389f9282b4285fdd9a35f5c`.
The patch hash alone is insufficient to select the migration/source cut.

Base commit `9f3edfd3b4c6758832c53139da0773218062191e`, tree
`2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9`.
Product lock `61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf`.
Pack lock `4419731d2544d1c07fe275ec8071d5d783273942ca9947eda2ff6b4e2dffb9db`.
No final committed source/package receipt exists: Droid Shield blocked the
local commit. Current source membership is recorded in
`../source-current-checkpoint-08.json`, an exact metadata delta over its pinned
immutable checkpoint 02. SQL is unchanged; current proposed source includes
the narrow planning refusal fix. A proposal or fingerprint is not an
integrated source/build or reconstructed archive receipt.

The earlier public-runner change only audits duplicate frozen inputs and
enforces physical output containment. It does not require a new shared
proposal, alter native owner contracts or establish structural-family
qualification. The later serialization fix does require request 06.
Current 36-file code digest:
`017c02c2f1074abfaeb62134602391422d7401bb30071947605159e46d7f1b71`.

Real `git apply --check --whitespace=error` rejects requests 01–05 with
`dev/null: No such file or directory`. Request 06 adds the missing
`new file mode 100644` header for the one absent preimage. Its actual
generation, strict read-only Git check and independent exact-byte comparison
exit 0. Source preimages, postimages, symbols and authority are unchanged.
The historical packager pin was 06; no packaging was executed.
`../integration-patch-failure-model-01.md` precedes the fix, and
`../integration-patch-check-01.json` retains all five original failures.

The checkpoint-06 continuation changed evidence only: the current default public
runner executes all original 256 registered slots with its attached identity
audit, exit 0. All 512 process records are independently verified. Source
digest, active request 06, migration body and every actual shared pre/postimage
are unchanged; no additional shared request or application is needed for
that source-only validation.

The checkpoint-07 continuation adds consistent retained checked-request and actual
S4 head/use checks to final owned S4/S8 transactions. It also strengthens the
common E2E output guard. Request 07 is separately necessary because expected
planning refusals otherwise reach the original route's unexpected 500 fallback.
Only the new composition-plan case catches bounded uppercase Z5 codes,
returning the existing owned API's 403/409 distinction and fixed safe fields.
Other exceptions and original handlers are unchanged. The packager now pins
07 without execution. Generation, strict read-only Git validation and exact
comparison each exit 0; backend 12 checks actual request-07 virtual source.

The current driver-only correction rechecks installation headroom inside the
same held heavy lock before each root/backend `npm ci`. It changes neither
native owners, SQL, proposal bytes nor any coordinator preimage. Request 07
remains active. Its read-only diagnostic is not archive/install/native proof
and does not authorize a retry of the denied commit or packaging.

## Callers, contracts and order

1. Company Brain dispatch authenticates the original delivery session before
   bounded body IO. Eight strict operations call the owned service; intake
   enters through the orchestration adapter, not another Work/grant API.
2. `link_institution_components_v1`, protocol 1, is an INTERACTIVE,
   tenant-scoped, locally idempotent required job. The existing queue owns
   physical token/fence/lease and acknowledgment. Keep other phase exclusive
   worker early returns intact when rebasing the shared worker.
3. Original S8 lifecycle calls the owned evaluator only after its genuine
   CONSUMER role, tenant/principal/rights scope, signed policy, source and
   ordinary-disposable checks. Its signed source pins must cover every named
   phase/owner dependency in the actual loaded-source manifest, not just the
   producer/checker entry points. Its original transport signs and persists the
   assertion reference. `Z5_COMPOSITION_ADMIT` and `Z5_COMPOSITION_CURRENT`
   are additive lifecycle operations. This lane creates no policy, signer,
   token, S8 service or self-admission bypass.
4. Original S4 handoff producer/readers bind and recheck the exact selected
   conditional contract. The additive `policies/composition-plan` persists an
   immutable original S4 integration/replacement plan and only then records
   CONSUMED. It works while an old S6 liability is UNKNOWN, without choosing
   a new action, dispatching, compensating or weakening the original handoff
   refusal. An S4 selection event alone is not consumption.
5. The scoped Work panel mounts through WorldWorkRecord. Its finite literal
   route map includes the original S4 plan action. Result and draft state are
   scope tagged; the bounded projection retains a full-proof reference,
   fixed revisions, original resources/obligations, exact conditionality,
   counterexample truncation, source/build, costs and separate gates.
6. Canonical capability/OpenAPI generator changes are proposed. Actual
   generated manifests, clients, forms and coverage remain coordinator owned.
   Source reachability is not authenticated execution.
7. API tracing includes the owned native runners/assets and explicit
   reconstruction manifest. An installed target must declare its physical
   `FINNOR_Z5_SOURCE_ROOT`; parent Git identity and peer project fallback are
   forbidden.

Consumer version: `z5-s4-s8-declared-contract-consumer-v1`.
Kernel version: `z5-coupled-kernel-v1`. Preorder is named in the kernel README.
Schema versions are additive `finnor.z5.*.v1` / original S4/S8 declared-contract
records, not a change to X/Y meanings or protected qualification.

## Migration and compatibility

Complete **unapplied** body:
`finnor-os/packages/private-equity/src/project-z/z5-institution-linker/schema.sql`.
SHA-256 `b461945e729aeee02c90eec947c9b45db1fc5b7fdebb2d808587dcfd151fd71c`.
The manifest pins the real migrator/head/bundle preimages. No migration name,
number, head or bundle entry is invented. The coordinator must assign and
serialize these against its actual combined source, and may only execute SQL
after separately obtaining authority. No initialization or grants ran here.

Tables enforce principal/tenant RLS, immutable original inputs and artifacts,
monotone generations/fences/debits, original episode caps, retained storage,
real delivery lineage and bounded uses/events/profiles. SQL and all seven
procedural bodies pass grammar parsing. This does not validate live foreign
keys, RLS, privileges, concurrency, runtime SQL or original S5 charge authority.
All six local function privilege identities also match their definitions.

Existing S4 behavior is unchanged without an enabled Z5 head. Old immutable
preparations remain readable. An enabled but stale/revoked selection fails
closed. A composition-bound preparation is not a new “original” preparation
for a circular request: original owner inspection and currentness reject such
cycles rather than inventing a discharged starting state. Request 04 adds
the original S4 reader's `originalBeforeComposition` read mode. After exact
immutable-byte validation, it rejects a composition-bound preparation before
any recursive composition currentness resolver. Default S4/S6 callers keep
their ordinary currentness checks. The owned caller also retains its
post-read immutable-property rejection; the early integrated reader is not
claimed to exist in the unpatched baseline.

## Failure/currentness and resources

`failure-model.md` and `process-e2e-contract.json` were frozen before code.
Publication locks the actual queue delivery and the real enabled compute
permit in the same transaction. Source, rights, Work input, current owner
facts, deadline, reservation and native S8 assertion are rechecked at use.
Semantic idempotency compares exact request/event preimages.

After independent custody/debit/immutable-file work, final S4/S8 transactions
lock and recheck the retained request's generation, artifact/source/request
digests, deadline and terminal/cancel controls. Composition consumers also
lock the actual head and immutable use, verify admission and exact original
binding, then publish in that transaction. A previously checked owner cut
alone cannot override a newer cancellation fence or changed selection.
Native concurrency behavior is NOT_RUN; this is not distributed once-only
publication/effects or protected execution custody.

`capacity-fence-failure-model-01.md` precedes the final source correction.
Original request insertion prepays 512 bytes of bounded terminal metadata;
only terminal status/generation/cancel changes may use that reserve.
Cancellation, revocation and failure/exhaustion fences commit before
separately attempted audit records. A failed audit reports a gap and cannot
roll back the fence or erase original costs/liabilities. READ is non-mutating
and distinguishes computed status from stored status. Producer permit release
is detached from heartbeats before original S8's separate compute stack.
These corrected native edge cases remain runtime NOT_RUN.
The worker-only continuation also closes settled callbacks before final
permit release and directly checks its current fence before producer
dispatch. The native queue's claim/ACK fence and sticky lease-loss state
remain untouched. Its timing behavior remains native NOT_RUN.

At most four original-episode requests and four physical deliveries; no
retry renews the original deadline or allowance. Native S5 PREPARATION and
LIFECYCLE charges commit before corresponding work, including retries. A
killed worker leaves its real compute permit occupied until expiry. The
guarded E2E waits for this fact rather than shortening leases or consuming
extra queue deliveries. Its existing parent must already have at least
twelve minutes remaining and enough phase-specific allowance. Nothing here
creates that funding, a tenant, credentials, original S8 component contracts,
an independent observation or an initial original Work.

The native E2E requires an existing exact source-bound, owned frontend/API/S8
process set (including actual loopback listener inode/PID/port ownership),
genuine owner and second-tenant credentials, and a second
existing Work/root. It checks three actual worker SIGKILLs, the fourth real
queue acknowledgment, S4 plan consumption, mounted reload and context/session
changes, original idempotency conflict/exhaustion, delayed independent
observation, stale refusal, cancel and revoke. It is executable but NOT_RUN:
current authority is absent, and its tested guard exits 2 with zero actions.
Its actual durable observations use the original read-only tenant transaction
after genuine owner identity checks, not bare unscoped pool queries. A
repeated-read step compares request/episode/event/attempt state.
Its post-cancellation step also compares use/head state and requires S8
admission, S4 use and original planning to refuse without durable changes.
This is a post-commit negative, not an authored in-flight race scheduler.
Current native guard 08 exits 2, before all native actions.

Filesystem source custody and process resource bounds are not an adversarial
OS/network sandbox. Cross-owner transport/DB races and all installed native
behavior still require real qualified execution. No whole-code or once-only
external-effect claim is made.

## Finite affected validation and remaining coordinator obligations

Retain original type/checker/sweep failures. Current checks and exact exits
are indexed in the final handoff. Full proposed backend/frontend graphs use
virtual exact postimages and explicit third-party declarations, never shared
source writes or peer implementation fallback. Root catalogue checks use
the actual unchanged generated source and are not a combined-source rebuild.

After exact application/rebase, regenerate canonical outputs, run complete
combined types/lint/catalogue checks and both real application builds, then
freeze a separately installed source/build/native asset receipt. Run the
guarded native E2E only after separate DB/Auth/process authority exists.
Protected admission, full equipped X/Y comparison, operational/financial
qualification and activation remain independent and unpassed. Only the
coordinator can accept the engineering handoff or release the slot.
