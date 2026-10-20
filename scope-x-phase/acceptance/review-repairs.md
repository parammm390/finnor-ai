# Integrated review repairs, preregistered 20 October 2026

The first review inventories 605 changed files relative to published main
`cf18f3491993564a5acbc28a62188699a2b29a31`. Five independent read-only
groups returned nine concrete candidates. The kernel continuation subsequently
closed all 102 assigned files (101 full reads and one independently validated
generated bundle), with no additional findings. No whole-phase completion or
production readiness is claimed.

## Failure models and bounded repairs

1. X1 compiler publication locks its request before tenant mutex 5510 while
   cancellation takes them in the opposite order. Acquire 5510 first in
   the shared live-claim helper, before request/job/source locks. Preserve
   actual delivery/generation/fence/lease checks and rollback-only retries.
   The independent second pass found that the initial parent reservation
   then reentered 5510 on a second connection. Join reservation to the
   existing transaction instead. For this path, acquire the canonical S5
   portfolio lock before 5510, matching S5's existing mandate-check order;
   retain request/control fencing and atomically publish the parent binding.
   Do not hold either mutex while awaiting a second connection that needs it.
2. A revised X1 request with an unpublished predecessor is accepted and
   necessarily fails immutable-parent construction. Reject that request
   before acceptance/queueing or spending another original attempt, and
   do not advertise revision readiness for an unpublished parent. Original
   resume/reconciliation and costs remain retained; do not invent an artifact.
3. X2 native settlement can finish before S8 reconciliation fails. Select
   terminal requests with an unreconciled original S8 use as recovery work.
   Use retained canonical settlement/evidence to reconcile that original use,
   without observing a replacement outcome, renewing authority or dispatching
   the application mutation again. Preserve stopped-session status.
4. X3 installation can cross synthesis-authority expiry after its first
   check. Capture the actual authority owner's temporal boundary, then check
   it after installation writes before commit. Expiry rolls back migration
   and release publication, without extending the application deadline.
5. X5 generation changes terminate pending uses but strand evaluations.
   Mark QUEUED/RUNNING evaluations FAILED with the original identity and an
   explicit abort reason in the same retrain/control transaction. Preserve
   completed results and the independent evaluator/partition restrictions.
6. Historical X2 migration 0191 replaces X1's schema-qualified charge-phase
   constraint and rejects existing X1 COMPILE/CHECK/etc. Keep every historical
   SQL byte. Use an explicit reviewed migration-execution union, analogous to
   the existing P1 immutable-history bridge, so 0191 validates existing
   original charges. Add a forward migration for already-applied databases.
   Preserve X1's institution-schema qualifier, not an unqualified phase union.
   Validate fresh and populated exact directory/bundle migration paths,
   replay, all retained phases and rejection of unknown/unqualified phases.
7. R3's commit-time copied snapshot dereferences an X1 null certificate.
   Replace the copy with the existing typed canonical S5 snapshot under the
   same portfolio lock and retain exact precommit snapshot digest checks.
   Update both clearance and consumption callers. The first type check and
   independent second pass caught the remaining consumption call; its failed
   receipt remains retained as `backend-types-review-1.json`.
8. X2 directly reads RLS-filtered reservations and misses another principal's
   private X1 occupation. Use the existing typed S5 aggregate snapshot under
   the portfolio lock, including the security-definer occupation projection,
   while keeping origin bodies private and all current resource/horizon checks.
9. X2 and coalition browser panels construct the old user/token session key
   although the owner now includes access generation. Bind the same current
   generation while still requiring the rendered session's user/token match.
   Preserve synchronous render masks, aborts, scope fences and backend authority.

## Artifact-producing validation

Before declaring any repair verified, run affected ordinary type/source checks
and real SQL/native/mounted campaigns. Extend existing disposable scenarios or
add a separately preregistered E2E driver, not post-code unit tests. Receipts
must retain original inputs/identities, observed owner state, failure paths,
exact source cut, replay commands and ending custody. Cover actual concurrent
cancel/publication, rejected unpublished revision with no child/charge,
post-settlement S8 transport outage/restoration without another business
request, authority expiry during installation with rollback, queued evaluation
generation changes, populated X1 phase upgrade, mixed-principal capacity and
generation-aware authenticated panels. Do not label type checks as these E2Es.

`native-x2-s8-4` fails overall at the unchanged live-suite deadline after the
same twelve completed checks and incomplete thirteenth. Its original bounds
and all failed receipts remain retained. Batched hashing alone has not fixed
that gate. Diagnose the remaining command/state-read cost before a further
scored live-gate run; do not increase the suite or remove state comparisons.

## Independent follow-up and next native cut

The independent follow-up resolves R1 and R7 in source, with no new findings
in its assigned delta. This closes all nine source candidates, not their
runtime verification. Its S6 concurrency disposition is accepted in source,
native verification pending.

`native-x2-s8-5` still FAILS overall (141.165 seconds, sampled aggregate RSS
2,931,290,112 bytes). The same actual second-use pause and original seven-second
suite now complete eighteen refusals and two controls; the nineteenth refusal
returns the expected 403 but its ending-state read does not finish in time and
is not credited. Beginning/ending source digests match. No deadline or oracle
has changed, and later live-subject prerequisites remain unproved.

Before the first integrated X1 native run, change only its historical expected
migration count from 192 to the independently checked exact 217-file integrated
union, head 0194. This remains an exact assertion, not a dynamic count, skip or
relaxation. Preserve the original 900-second wall, 5 GiB sampled memory stop,
one live stack, grants, worker leases, original-parent and effect assertions.
Use the existing authenticated `api` scenario first. The Linux/Node 22.23.3 run
is new development evidence, not the historical Darwin/Node 22.18.0 product
qualification. Follow with the original publication-race/resource scenarios
only after this first parent/reservation path completes.

The first integrated X1 attempt fails before database setup at `git diff
--binary`: Node's implicit 1 MiB synchronous-output buffer cannot hold the
reconciled merge cut (`ENOBUFS`). No owner path was exercised. Keep its failed
meter/log. Match the driver's source observer to the existing canonical X1
baseline and Linux observer's explicit 64 MiB bound, within the original
64 MiB small-check output allowance; keep the five-second Git timeout.
On Git failure, throw only a fixed diagnostic, not the exception containing
the full source diff. This changes source-observation capacity, not any
execution grant, episode limit, custody assertion or business oracle.

`native-x1-api-2` PASS_LOCAL_OWNER_SLICE: four existing authenticated API/owner
checks pass, including quantitative semantics, canonical owner creation,
compute attribution and original-parent lifecycle. The outer meter passes in
34.696 seconds with sampled aggregate RSS 2,253,385,728 bytes. Source custody
matches. This exercises the same-connection initial parent reservation repair,
not concurrent cancellation, all-principal capacity or full X1 qualification.

`native-x1-publication-race-1` PASS_LOCAL_OWNER_SLICE: the actual restricted
publisher holds the original artifact-insert boundary while an authenticated
revision waits on its canonical serializer. After release, both immutable
artifacts and the revision's independently observed lifecycle retain the same
original reservation/deadlines. Both existing cases pass, source custody
matches, and the outer meter passes in 32.979 seconds with sampled aggregate
RSS 2,536,476,672 bytes. Concurrent cancellation and explicit rejection before
publication starts remain separate pending cases.
