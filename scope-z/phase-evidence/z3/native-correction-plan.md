# Z3 native-owner correction, failure model before fixes

Actual starting source: `4b3889aac7455b8d9579071c68a61e5e0a263273`,
tree `6ff154dde8649b7cd21b641aa209e903ef8ca79f`.
This is an additive correction, not a replacement of the earlier evidence.
The actual coordinator reviews 04 and 05 in
`scope-z/orchestration/shared-computer-launch/` were read in this continuation.
They reject the event-only S4 acknowledgement, session-only write fences,
untrusted environment asset hashes and caller-chosen dependency/budget binding.
The old handoff's "nothing further" and "engineering closure" are superseded.
No coordinator acceptance, native execution or historical read is inferred.

## Finite expected-value cases, registered before source changes

| Case | Failure | Required observation |
| --- | --- | --- |
| N01 | Copied session fence with expired physical lease | Adoption, checkpoint, candidate, check, result and fault transactions refuse all writes, even without a successor delivery |
| N02 | Correct session but another physical job/type/payload/principal/worker/delivery | Exact physical job and unfinished delivery, protocol, retry safety, tenant, payload and live lease are checked in each writing transaction |
| N03 | New job fence restarts at 1 while session fence is higher | Physical fence remains separate; session fence is never substituted into a job query |
| N04 | Heartbeat/currentness failure during a stuck child | Abort, SIGKILL and observed child close precede handler completion; no orphan child or publication |
| N05 | Deadline has less time than the fixed process cap | Child cap is the minimum of the original remaining deadline and stage cap; expiration cannot start a fresh allowance |
| N06 | Caller points to a checker printing VIABLE | Approved source-bound checker digest rejects it before spawn; a caller-supplied expected hash is not accepted |
| N07 | Caller replaces producer or chooses a Python executable | Approved producer digest and fixed host interpreter identity reject substitution |
| N08 | Asset changes after pinning or before reuse/publication | Captured verified source bytes are executed; subsequent revalidation rejects changed assets and invalidates retained receipts through the runtime binding |
| N09 | Receipt says VIABLE but lacks complete/safe/live/nonconflicting/nonvacuous flags | Refuse the receipt; a schema name and verdict string are insufficient |
| N10 | Caller fabricates parent/source/mandate/observation/resource/deadline | Resolve from the latest original Work input, its canonical P1 institution continuation, original compiler episode, S5 reservation and S6 state; supplied expectations must match |
| N11 | Parent revised/cancelled, resource revoked, obligations changed or UNKNOWN omitted | Original native owners invalidate currentness; no fabricated settlement, new reservation or renewed deadline |
| N12 | Repeated/recovered deliveries hide physical compute | Debit the same original P1 episode and S5 physical CONTROL allowance once per real delivery; retain interrupted costs/gaps and original remaining budgets |
| N13 | VIABLE check with no S4 consumer installed | Keep consumption false and fail closed, never emit a consumption acknowledgement |
| N14 | Controller chooses an unmodelled or refused operation | Concrete S4 internal-readiness consumer executes only registered native reads, observes the original environment outcome, follows both original edges and updates actual finite memory; mismatch invalidates |
| N15 | Two native cycles or restart reset memory/obligations | Persist original state/memory and observed operations under the same session, Work, parent, reservation and deadline; no effect dispatch or UNKNOWN clearing |
| N16 | Installed package borrows source dependencies/assets | Reconstruction inventory, own lock install, emitted producer, checker and runtime pins plus offline report comparator distinguish source replay, installed replay and native execution |
| N17 | Mounted Work has no caller for submission (review 06, read before the UI correction) | Mounted control submits only the original Work ID and a stable retry key; no editable digests, parent, deadline or new allowance; a refusal stays visible and no current state is invented |
| N18 | Re-submission/revision starts another original parent, deadline, obligation set or resets consumed memory | Resolve the last original-Work session; only exact original-behavior identity refinement may carry its actual cursor. Re-derive the candidate/check under new source/rights, independently checked initialization must cover carried memory, otherwise refuse rather than reset |

N01–N05 and N10–N15 ultimately require an explicitly authorized existing
disposable native target for DB/Auth execution. The guarded executable must
contain these obligations now; lack of authority does not excuse missing code.
No DB, migrations, tenants, grants, listeners or fake credentials will be created.
Offline real-process scenarios cover N05–N09 and physical abort/protocol bounds.
They do not impersonate a native queue or an independently governed evaluator.

## Chosen bounded native profile

Keep the general public mathematical profile unchanged. Its native first
consumer supports **internal readiness and S6 reconciliation observations**,
not financial interventions. The accepted original Work instruction contains
the exact public arena and operation meanings. Submission cannot supply a
replacement arena, semantic digest, parent or deadline. A real canonical P1
institution continuation and its original compiler/S5 parent must already exist.
Unsupported/missing native origins refuse intake.

The native profile has no fairness, renewal or settlement shortcuts. Every
controller operation is READINESS or RECONCILE; each targets an environment
vertex containing both actual possible observation outcomes. Original S6
identities remain occupied in every supported state. These read observations
do not claim effect reconciliation, per-request completion or infinite compute
authority. Each actual finite prefix separately spends original native compute;
exhaustion/refusal invalidates further use of the model guarantee.

S4's concrete owner entry invokes the owned continuation implementation, which
re-reads the original claim/check/currentness, executes the selected native
read, observes its result, advances the checked memory along both original
edges and appends a canonical original-Work observation. A bare Z3 event is
not consumption. S5 transaction helpers reuse its existing portfolio serializer,
validation and physical-charge planner, with no new ledger or grant.

Shared owner additions are exact preimage-bound proposals only. The prior
nine-patch packet and failed logs remain immutable. Coordinator-owned
OpenAPI/manifest/client/form completion is not claimed by this lane.

## Checks and original evidence

The sealed assembly check exited 0 in this continuation (20 lock members).
The existing full native/store/worker and actual owner sources were read.
Original failed typecheck, migration and mount logs remain retained, not
relabelled native proof. Review 05 says the coordinator's combined 14 checks
passed; this is coordinator feedback, not a locally fabricated run receipt.
The missing pinned-directory npm executable produced exit 127 during doctor;
PATH-selected npm is 11.19.1, Node 22.23.4, Python 3.12.3, GCC 13.3.0.
No supervisor, hook, settings, gate or foreign file is modified by these fixes.

## Reconstruction/driver audit failures, before their corrections

N19: killing a `tsx` CLI proxy can leave its runtime child alive. The guarded
driver must spawn pinned Node with the installed tsx import directly, bind the
durable-boundary IPC PID to that actual child, bound graceful shutdown, and
retain a real close observation. It must not claim a proxy's exit as a worker's.

N20: an inherited `DATABASE_URL`, dotenv file or managed secret bootstrap can
select a different database from the explicitly authorized observation target.
The proof worker must receive only the exact authorized loopback database and
a minimal non-provider environment; its own entry must refuse target drift
before secret bootstrap. No inherited credentials are evidence of authority.

N21: an archive can silently omit production files containing "credentials"
in their *source filename*, while an empty local node_modules directory can
fool a locality-only comparator. Include all canonical production source,
exclude credential data rather than source identifiers, check exact installed
source bytes, and require actual lock-install/build receipts and hashes.

For N01, the future native driver also suspends only its explicitly authorized
actual CLAIM worker until the real lease expires, resumes it without a
successor, waits for its typed refusal, and compares the whole durable session
preimage. `workerSuspensionAllowed:true` is a separate required authorization.
This is not executed without the existing-target contract. No DB mutation,
lease extension, replacement owner or mocked clock is used.

N22: the actual shared queue renewal UPDATE has no live-expiry predicate and
can revive the same claim after an expired lease. Its completion CAS has the
same omission. A coordinator-owned exact-preimage request must prevent both,
using `clock_timestamp()` rather than a transaction-start time. The native
suspend/resume case must reject publication with no successor; local source
guards are not proof that the global queue cannot resurrect an expired lease.

N18a: a caller loses its retry key and resubmits the identical original Work
while its first physical delivery is between transactions. Different keys must
not create independent valid sessions with reset finite memory. Under the
existing S5 original-parent serializer, an unchanged binding maps the new key
to the existing session before testing allowance for new work. Changed
bindings still require the original-behavior bridge and independent re-check.

The guarded native information case uses a second **pre-existing** real Auth
owner in a different explicitly authorized disposable tenant. It must deny
HTTP access to the primary sessions and original Work, whose existence was
already independently observed. Random absent UUIDs are not a cross-tenant
proof. Neither owner, tenant, credential nor grant may be created by the driver.

N23: lost-key semantic aliases must not grow an unbounded request ledger after
physical allowance is exhausted. New submit/recovery request keys share a
256-row original-Work history bound under the same native serializer; existing
keys still replay without a new row or charge. Refusal does not renew capacity.
