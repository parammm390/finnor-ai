# Z3 native-owner correction — independent failure map (lane droid)

Written before reviewing any fix implementation, in answer to coordinator
reviews 04/05 (`scope-z/orchestration/shared-computer-launch/`). This map is
the acceptance checklist applied to the corrected source, whoever drafts it.
It extends, and does not replace, the pre-code failure model in
`engineering-plan.md` and the writer's `native-correction-plan.md` (N01–N16).
All cases are finite; each has one required observation. Cases marked
[offline] are executable without DB/Auth authority; cases marked [native]
additionally require the coordinator's disposable native target and remain
BLOCKED-COORDINATOR until then. Code-level invariants are checked
structurally at freeze time [static] and by full typecheck [types].

## D1 — false S4 consumption

Invariant: `s4_consumed` is true only after a real, current S4 owner consumer
has consumed the checked strategy through its own native seam. A check verdict
is not consumption. An event row is not consumption.

| Case | Failure | Required observation |
| --- | --- | --- |
| D1-a [native] | Receipt VIABLE, no S4 consumer installed | `s4_consumed` stays false; no event, column or read-model field claims consumption; boundary reported incomplete |
| D1-b [native] | S4 seam invoked with stale session fence/currentness | Consumption refuses; nothing recorded |
| D1-c [static] | Any code path sets `s4_consumed` from `receipt.status` alone | Absent from source |
| D1-d [static] | Event vocabulary contains a consumption claim without an owner call | No `Z3_S4_CONSUMPTION_RECORDED` emission keyed off verdict |
| D1-e [types] | Read model distinguishes "not consumed" from "consumed" | Panel/read model cannot render false as consumed |

## D2 — non-atomic physical lease fencing

Invariant: every session mutation (adopt, checkpoint, candidate, observation,
result, fault) revalidates the exact physical delivery — job id, delivery
attempt, claim token, physical claim fence, type, payload sessionId,
`status='running'`, live `lease_expires_at` — inside the same transaction.
The session fence overlay never substitutes for the physical job fence.

| Case | Failure | Required observation |
| --- | --- | --- |
| D2-a [static] | Boundary transaction without physical lease revalidation | All five writing boundaries contain the jobs⨯delivery-attempts check |
| D2-b [static] | Session fence used in a jobs-table predicate | Physical fence (`jobs.claim_fence`) and session fence (`active_claim_fence`) are distinct columns in distinct predicates |
| D2-c [native] | Lease expires mid-delivery, no successor | Next boundary write fails; fault recorded stale-fenced; no publication |
| D2-d [offline] | Heartbeat observes lease/currentness/deadline loss during a stuck child | Child receives SIGKILL and is reaped (close observed) before the handler settles; handler faults, no orphan |
| D2-e [native] | Recovered delivery (new job, fence restarts at 1) | Physical fence per job; session fence monotonic across deliveries; neither masks the other |

## D3 — untrusted checker/producer identity

Invariant: the executed producer bundle and checker source are verified bytes
pinned to source-bound approved digests; the binding's runtime identity covers
platform code AND both assets AND host interpreters; every boundary
revalidates. Caller-selected paths may only select, never approve.

| Case | Failure | Required observation |
| --- | --- | --- |
| D3-a [offline] | `FINNOR_Z3_CHECKER_SOURCE` points at a script printing VIABLE | Digest mismatch → typed refusal before spawn; no session mutation |
| D3-b [offline] | Producer bundle swapped after pinning, before publication | Revalidation at boundary fails; delivery faults |
| D3-c [static] | Approved digests compared against caller-supplied expected values | Expected digests are source constants, not env/input |
| D3-d [static] | `assertViabilityCurrent` omits assets | Binding runtime digest covers producer bundle + checker + node/python executables |
| D3-e [offline] | Host interpreter replaced (python symlink retarget) | Revalidation fails closed |
| D3-f [types] | Receipt retained without run-manifest binding the executed asset digests | Run manifest carries the verified identity |

## D4 — caller-supplied native dependency/budget identities

Invariant: original parent, source revision, mandate/observation/resource
digests, deadline and remaining budget are resolved from native owner tables
in the writing transaction; caller fields are at most expected-value
assertions that must equal owner values. Child wall caps never exceed the
remaining original deadline.

| Case | Failure | Required observation |
| --- | --- | --- |
| D4-a [native] | Caller fabricates parent/mandate/observation/resource/deadline | Intake resolves owner rows; mismatch or absence refuses with typed fault |
| D4-b [native] | Reservation revoked or deadline passed mid-flight | Boundary currentness fails; session STALE; no new reservation/deadline minted |
| D4-c [offline] | Deadline leaves 5s but checker cap is 300s | Child spawned with min(cap, remaining); expiry aborts; no fresh allowance |
| D4-d [native] | Physical compute unaccounted per delivery | Exactly one original-episode attempt/step debit per physical delivery, recovery included |
| D4-e [static] | Submit schema trusts caller hex for dependency digests | Binding fields populated only from owner reads |

## Cross-cutting

| Case | Failure | Required observation |
| --- | --- | --- |
| X-a [offline] | Receipt `status:"VIABLE"` with missing/incorrect obligation flags | Receipt refused before any publication (schema name insufficient) |
| X-b [static] | Recovered delivery trusts retained candidate/receipt without re-derivation | Digests re-verified; assets revalidated; fences re-checked |
| X-c [types] | Any new module fails backend/entry typecheck | Full backend tsc + staged entry tsc exit 0 |
| X-d [static] | Math profile drift | Epistemic contracts/producer/checker bytes either unchanged, or sweep re-run reproduces the frozen digest |

## Verification plan for the corrected packet

1. [offline] Full backend typecheck (`tsconfig.backend.json`) and staged
   worker-entry typecheck under pinned Node 22.23.4 / flock, plus the offline
   boundary-process scenarios (D2-d, D3-a/b/e, D4-c) with retained logs.
2. [static] Grep-verifiable invariants D1-c/d, D2-a/b, D3-c/d, D4-e, X-b over
   the exact frozen files; results recorded with hashes.
3. [native] D1-a/b, D2-c/e, D4-a/b/d execute only on the coordinator's
   authorized disposable target; the code paths exist and fail closed until
   then. Claiming them green without execution is itself a failure.

Correction to this historical checklist's command spelling: the actual backend
config is `finnor-os/tsconfig.json`, not `tsconfig.backend.json`. Full exact
overlay checks use that config, plus the actual root config and owned entry
config. Nineteen–twenty-two and N18a in `native-correction-plan.md` were added
before their respective driver/reconstruction/queue corrections. No native
case is promoted by an offline subprocess or static/type pass.

install-01 (first lock-installed run, logs retained) detected N24, N25 and
N26 from native-correction-plan.md: frontend-build module-not-found
(sentry server/edge configs omitted from the distribution), boundary-run
Z3_PRODUCER_ASSET_NOT_APPROVED (cwd-sensitive bundle recipe), and stale
catalogue checks (coordinator composition additions were never preimage-bound
here). These prompted source-distribution and driver corrections; their
planned status was previously overstated. The frontend build failure
was a distribution omission, not evidence of a native product regression. The coverage audit
requires git context (git rev-parse HEAD); a plain copy cannot run it, so the
installed run initialises disposable git metadata (info/exclude only, no
working-tree writes) before executing the real existing check.

The final bounded failure model is N27–N30 in `native-correction-plan.md`.
It additionally covers the omitted real `coverage/route.ts`, the ineffective
`.npmrc` exception, the pre-existing Git exclude file, insufficient installation
headroom, modes/archive correspondence, and already-integrated coordinator
catalogue semantics. Final source-only receipts must close these packaging
cases without promoting them to current-source installed or native proof.
