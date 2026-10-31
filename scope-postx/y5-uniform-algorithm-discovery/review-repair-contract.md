# Review repair contract, registered before repair code

This refinement follows the completed whole-change simplify review. It does not
replace the original failure model, verification contract, episode deadlines,
resource accounting, original S5 obligations, or protected qualification gates.
No post-code unit tests are authorized. Use real owner/API/worker/SQL/native
flows and retain inputs, observed responses, timing, source cut and rerun commands.

## Review custody and scope

- Base and merge base: `a7028e5816e24ff13206bf2bce20a7fc8f3d2aca`.
- Frozen manifest: `evidence/y5-preparation/review-input.json`.
- Intended diff: `evidence/y5-preparation/review-intended.diff`.
- Whole-change reviewers: reuse `dd8c3786-c2e4-4de1-a6f4-a7c521b819f2`,
  quality/provenance `13233b33-c55e-4659-9663-04f014a40d2f`,
  efficiency `82c648a5-fcec-4a0a-ac4d-35ae75ca70f1`.
- All three reports completed. They cover the same 71 task files, 301 helper
  entries and 38 compatibility sightings, not three disjoint file subsets.
- Original registered S5 regression output:
  `scope-5/scope-evidence/run-2026-10-21T23-38-18-7118fa97/results.json`.
  All nine selected cases passed, launcher exit 0, 2026-10-21
  23:38:23.998Z through 23:41:00.494Z. Its header-based development identity
  fixture is not hosted authentication or protected qualification.

## Failures and finite repair checks

### R1: source visibility is not method currentness (P1)

Failure: root/Work authorization plus a null top-level capsule still leaks a
bound source through immutable event bodies or the original-source envelope.
An allocation may lawfully bind inputs from another readable root. Revoking
that source must not leave historical counterexamples, weights, source values
or outstanding obligations visible through the discovery root.

Repair: reuse original S4 policy and S1 resource-pin owner reads to authorize
the bound historical sources separately from applicability/currentness.
Perform those owner reads outside the closing transaction, with source/rights
cuts before and after them, to avoid reversing existing lock order. If any
authorization or cut cannot be established, return only discovery/Work/root
identifiers, status, fixed withholding reason, event identifiers/kinds/times
and cost/count/deadline metadata. Do not expose exception details, event
bodies, original source references, values, capsules or obligations in that
projection. Do not alter stored history. A lawful reader must retain access
to unaffected theorem history even when P7, S6 or method changes make use stale.

Check: actual authenticated discovery with second-root source dependencies;
revoke only those dependencies while discovery-root/Work access remains.
Inspect the entire response, not just `capsule`, and compare immutable SQL
history before/after. Also check lawful stale-history readback.
The existing implementation-invalidation read must remain AUTHORIZED with
the stored KERNEL_ACCEPTED event body present, although method use is no longer current.
The second repair run passed AUTHORIZED / payloads-withheld=false after
implementation invalidation, then stopped on a driver assertion incorrectly
using the discovery status `CHECKED` as an event kind. The original durable
kind is `KERNEL_ACCEPTED`. Correct only that driver expectation; retain
`evidence/y5-owner-review-second/failure.json` and the failed command log.

### R2: derived quantities are not external inputs (P2)

Failure: the external 18-fractional-place / 10^12 codec rejects valid original
checker products and sums after they are correctly derived. Examples include
10^-18 times 0.1 and two 10^12 objective terms.

Repair: use the existing derived exact-quantity codec for canonical model
projections, checker objectives and evaluation comparisons. Preserve all
external request schemas and original exact rational-ledger semantics.

Check: authenticated owner discovery, same-definition use, original checker
and distinct evaluator on those two examples and an exact rational case.
Require matching exact original optimum and minimum-cardinality ties.

R2 boundary refinement, before the additional checker edit: the existing
versioned exact joint-model schema accepts supplied fractions such as `1/3`.
The original checker currently sends raw supplied joint values through the
derived-ledger parser, which accepts canonical `r3q:` results but not supplied
fraction syntax. Use the existing external quantity parser only at those
original supplied joint-value reads (subset objective, analytic upper bound
and canonical objective rows). Continue using the derived parser for projected
rows, accumulated results and ledger values. Do not widen either codec or the
v1 request schema. The rational E2E must use the existing
`finnor.joint-allocation-model.exact.v2` / `s5-joint-model-exact-v2`
commitment, compare the original clear/check and Y5 use/evaluation, and retain
the original finite-decimal S5 regression results at the repaired cut.

First actual repair run:
`evidence/y5-owner-review-first/review-repairs/progress.json` passed all
eight prepared coupled subsets, the nineteenth-fractional-place case, the
two-term `2e12` objective, and Y5 rational use/evaluation. The final original
S5 rational clear returned `INVALID_CANDIDATE` / `Unsupported derived exact
quantity`. The unchanged base `allocation-producer.ts` has the same raw
joint-value/derived-parser mismatch in its continuous objective bounds and
scenario rows (`git diff -- allocation-producer.ts` was empty before repair).
Apply the same existing external parser only to these supplied values.
Retain the original compiler, Python IPC v2 translation, deadline, numerical
producer, exact independent checker, dual verifier and public input schemas.

### R3: unresolved availability is unsupported, not malformed (P2)

Failure: inspection expands a valid null availability despite an existing
`RESOURCE_AVAILABILITY_UNRESOLVED` reason, throwing during submission.

Repair: stop before unsafe linear expansion when original preparation reports
unresolved inputs. Preserve the original reasons. Do not substitute zero,
omit a constraint from an accepted proof, claim infeasibility or launch native
proof work.

Check: register a valid current resource with null/UNKNOWN availability through
the original API, then submit and run the real worker. Require bounded
INCOMPLETE/unsupported output, no capsule/native proof and unchanged original
S5 uncertainty and responsibility state.

### R4: input bytes do not bound Cartesian expansion (P2)

Failure: allowed resources, unique covenants, periods and scenarios can expand
into 409,600 rows and millions of coefficient cells before a native deadline.
An event can exceed its bounded storage budget.

Repair: Y5 inspection must preflight a conservative original-row and
coefficient-cell bound before constructing the matrix. Initial Y5 inspection
limits are 2,048 rows and 131,072 coefficient cells. Reject nonadditive
interaction before product expansion. Bound structural evidence at 1 MiB.
Over-budget output is bounded unsupported evidence with no accepted/truncated
proof. Keep the original S5 solver and dual-checker domains unchanged.

Check: actual complete, generous maximum-cardinality covenant inputs through
original resource registration and authenticated Y5 submission/worker.
Require bounded refusal, small retained events, no native start, no authority
and no changes to S5 reservations, consumptions or S6 effects.

### R5: interrupted evaluation use is durable UNKNOWN (P2)

Failure: a STARTED-use replay has no original problem, yet evaluation
unconditionally dereferences it and permanently returns an untyped 500.

Repair: give consumption outcomes an explicit completion discriminator.
An interrupted durable STARTED use remains UNKNOWN with no automatic rerun.
Evaluation must record structured refused/incomplete evidence before reading
fields available only on a completed use. Preserve the original use ID,
assignment, episode, deadline, cost uncertainty and consumed use count.

Check: interrupt the actual evaluation process after its use is durably
STARTED and before completion, restart the actual handler, and retry through
the authenticated evaluator. Require structured incomplete response, same
use ID, unchanged use count and no second native invocation.

### R6: automatic polling must not invalidate itself (P2)

Failure: a four-second poll invalidates a healthy longer refresh before its
read phase, so repeated successful me/list responses never display a view.

Repair: single-flight automatic refresh per current private identity. A
skipped timer tick must not advance the epoch. Retain explicit identity,
selection, mutation, focus and late-response fences.

Check: actual mounted me/list delays of three seconds each must eventually
display the original Work view with bounded request concurrency. Retain the
late old-Work response check. Type checks alone do not pass this browser gate.
The previously observed mounted renderer blockage remains a separate blocker.

### R7: cleanup must survive orchestration expiry (P2)

Failure: cleanup uses the expired ten-minute workflow deadline, leaving an
installed browser interception, held response or suspended disposable
principal unrestored.

Repair: add one independent, finite cleanup-only drain. It may remove the
driver's own interception, release its held read and restore its disposable
principal, but may not run product work, advance a phase, renew an episode or
turn failure into success. Retain separate restoration receipts and failures.

Check: actual orchestration expiry with interception armed, then independent
observation of route removal and native fixture restoration. Preserve the
original failed run result.

### R8: reuse original preparation within one oracle invocation (P3)

Failure: exhaustive evaluation revalidates and reconstructs the same original
problem for every subset, including witnesses the oracle does not consume.

Repair: expose an original-checker-owned, invocation-local prepared subset
evaluator. Reuse preparation only inside that evaluation; keep every original
constraint, exact objective, tie rule, deadline and closing-currentness check.
Do not create a cross-invocation acceptance cache.

Check: compare every subset, including infeasible choices, against the
original full checker within the actual owner scenario. Record subset count,
preparation count and elapsed time in retained evaluation evidence.

R8 deadline refinement, before its additional edit: a retry can replay a
durably completed native use after its original deadline while an interrupted
evaluation has no final result. The oracle must not get a fresh 30-second
budget. Bound it by both the current invocation deadline and the immutable
original use deadline. In a built-API E2E, place a test-only advisory-lock
barrier on evaluation-result UPDATE (return NEW without changing data), run
the real assigned evaluation, and observe that UPDATE actually waiting after
the native use completes. SIGKILL only the receipted disposable API, release
the barrier, restart it and let the original use deadline expire naturally
within the same outer 900-second run. Authenticated retry must return durable
UNKNOWN with zero newly checked subsets/preparations, the same completed use,
same use count/deadline and unchanged physical start witnesses. Retain the
first lost request and all receipts. No inserted/modified scientific rows.

### R9: collapsed evidence must not serialize on every render (P3)

Failure: collapsed capsule/envelope/history traversals repeat on textarea
keystrokes and unchanged periodic observations.

Repair: serialize evidence lazily on expansion and memoize by evidence and
private identity. Suppress recurring no-change actor/list/view state updates
using immutable event/capsule identities plus mutable status/counter/privacy
metadata. Identity change or withholding must immediately hide prior private
observations.

Check: mounted expansion, typing, polling and identity-switch observations.
Do not claim this interaction check passed while the renderer remains blocked.

## Reuse and intentional retention

- Reuse `sumRationals` for exact summation and the original demand/funding
  inner schemas while preserving Y5 outer limits.
- Reuse the existing byte/string hash primitive only where byte semantics
  match; retain Y5 JSON-roundtrip canonicalization and custody hashes.
- Compose `usePrivateRequestScope` only if its owner-role/private-generation
  semantics preserve the Y5 mutation and idempotent retry fences. Otherwise
  record the concrete integration risk and retain the narrower tested fence.
- Keep original S5 resolution/model ownership, exact V2/rational-ledger
  encodings, worker recovery behavior, historical migrations and existing
  externally consumed schema unions. Their base-branch provenance was verified.
- Keep the native guardian, full toolchain/source byte hashes, independent
  proof reconstruction/replay, serial native capacity, physical UNKNOWN lease
  retention, closed capsule grammar, S8 independent authority and nonzero-cost
  uncertainty. These are not redundant compatibility or optional optimizations.
- No extra compatibility adapters for earlier shapes on this unmerged branch.
- Existing sandbox, scratch, aggregate memory, trust, discovery custody,
  formal translation, mounted renderer, economics and reconstruction limits
  remain separate and unestablished until actual evidence closes each gate.

Run each original operation inside its existing deadline. A repair verification
run has a 900-second outer wall limit; physical cleanup can only restore
verification-owned faults. No production grants, external provider effects,
publication, pushes, PRs or protected admission are authorized.

## Final whole-change reconciliation refinements

All three original reviewers resumed on the complete third frozen intended
diff, SHA-256
`0921d5d71f0ab68092e0e46513967bd8b1353310eb7bc7a01a4ee3bb213440c0`.
They retained prior dispositions and identified the following bounded repairs.
Their source review is not runtime verification.

- **Native witness read:** a pathname `stat` followed by reopening with
  `readFile` does not enforce the observed byte bound. Reuse the existing
  base `brokerPrivateFile(child, undefined, 8192)` descriptor-bound reader.
  Keep the bounded witness traversal, byte digest and exact JSON observation.
  Verify it against actual guardian-written 0600 files in the built faults.
- **Forward symlinks:** a containment check before all links exist can miss
  `a -> z/../source-object-reconstruction.json`, followed by `z -> .`.
  Resolve all emitted links again after the entire object tree is materialized
  and before staging or a verified receipt. Reject escapes and chain cycles.
  Preregister actual disposable Git-object CLI reconstructions with this
  chain, a two-link cycle, and a lawful internal link. The fixture may contain
  the real 66 source pins plus emitted manifest, but it is infrastructure
  validation, not full-repository reconstruction or algorithm discovery.
  Unsafe exports must fail without a verified receipt; keep partial outputs.
- **Oracle deadline completion:** check the immutable original deadline again
  after each asynchronous yield and after enumeration, including the final
  synchronous subset check. A result finishing after expiry is UNKNOWN, not
  supported development. Keep the actual completed-use/expired-retry fault;
  separately report whether last-subset crossing itself was observed.
- **Unacknowledged browser faults:** record possible interception, held-read
  and suspended-principal obligations before dispatch, not after an
  acknowledgement. If an action applies and its acknowledgement times out,
  the original failure must still enter the finite cleanup drain. Clear each
  obligation only after its restoration is acknowledged. Keep remaining
  obligations/errors in the failed report. Actual delayed-acknowledgement
  restoration remains a browser/native-fixture check, not a syntax pass.

The third actual repair run passed all prepared subsets, all three numeric
Y5 use/evaluations, the original rational S5 clear, lawful implementation-stale
history and second-root source withdrawal with unchanged SQL history. It then
stopped before the null-availability worker check because the driver expected
`UNKNOWN`; the original S5 owner correctly returned
`UNCERTAINTY_UNRESOLVED`. Preserve that original state and correct only the
driver expectation. Save that response before assertions in the next run.
Retain `evidence/y5-owner-review-third` and its failed command log.

## Installed boundary observation, 22 October 2026

`evidence/y5-installed-owner-fifth/failure.json` retains a real compiled-API
failure, not a numeric counterexample. The nineteenth-fractional-place native
use/evaluation passed. The following two-term `2e12` case reached CHECKED
discovery after a 55,226-ms emitted-worker delivery, but its authenticated
consume returned HTTP 408 `Y5_ORIGINAL_REQUEST_DEADLINE` after 28,535.522 ms.
The complete run exited after 289.6 seconds. Do not turn this into a pass,
silently rerun its original use, discount its cost or extend either the
28.5-second request/DB or 30-second native limits.

Before any latency repair, inspect its physical start/close witnesses,
toolchain and source checking costs, currentness-read scheduling and native
lease handoff. Keep full byte custody and independent kernel replay. A
replacement development run is a separately receipted trial, never a renewed
original request. Built interruption/deadline cases were not reached.

The final authorization-matrix `--check` also reports a stale generated
artifact. Regenerate with the existing owner generator, inspect the exact
generated delta and require a second check to pass. This is a generated
contract update, not permission to change authorization policy. Other
downstream parity checks did not run after that failure and remain pending.

### Separate finite compiled-fault selection

The retained native receipts show all five failed-use child processes closed
normally, including same-definition output selecting both policies. They do
not establish that the later owner publication met the original request
deadline. Native currentness polling already has a single-flight guard;
do not add a redundant guard or weaken byte/currentness/kernel checks.

Add a closed verification-only `--review-faults` selection to the existing
owner driver. It requires the actual built API and emitted worker, rejects
combination with `--review-repairs`, and runs only the two already-registered
compiled interruption/deadline cases after the original owner setup. Record
every unexecuted numeric/privacy/structural case as skipped, with a distinct
scoped result, never a full repair-matrix pass. Default full selection and
all expected numeric values/statuses remain unchanged.

Execute the updated driver from a newly built artifact, not by patching the
previous installed tree. This separates unobserved crash behavior from the
retained timing failure; it does not fix or forgive that timing failure.
No product deadline, episode, source closure, proof plan, codec, authority or
scientific admission changes are authorized by this refinement.

### Fresh lock reconstruction: build dependencies

The first full source-object reconstruction verified all 3,679 source files
and the independent Git index. Its fresh installation then failed at the
actual API Next type checker: `@types/react` was missing. The builder sets
`NODE_ENV=production` and calls plain `npm ci`, which omits development
dependencies, including the declared build types. Root/backend installs
reported 297/377 packages, unlike the original complete preparation installs.
See `evidence/y5-preparation/reconstruction-installed-first.log` and
`../y5-reconstructed-installed-first/build-failure.json` (170,997.84725 ms).

Before editing the builder, register this repair: use `npm ci --include=dev`
for both unchanged lock files in the fresh-build branch and record that
choice in the build-start receipt. Keep the sanitized HOME/cache, production
Next build, full type checks, native-asset declaration and original budgets.
Do not add a dependency, edit a lock, inject missing types, skip type checking,
copy installed dependencies or patch the failed runtime.

Require a new reviewed local source commit, Git-object reconstruction and
new fresh-build output before the compiled fault cases. The failed source,
compiled output, logs and receipts remain evidence. Available disk is now
below the existing fresh-build preflight; do not lower that preflight.
Any removal of generated dependency/cache directories requires specific
permission and an inventory first. No broader cleanup is authorized here.

The installer is one of the 66 pinned files. The second source export
correctly rejected its stale generated hash before issuing a verified
receipt. Preserve that rejection and regenerate with the existing source
owner, without weakening the checker. The new closure is `ded91d42…`;
previous source/installed observations keep their `088a9779…` identity.
