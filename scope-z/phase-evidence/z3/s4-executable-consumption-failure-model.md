# Z3 S4 executable application consumption: failure model

Status: written before any E2E test or product code. Base `a5209abc15fe40c68f30336c60d95dbfc343c13a`.
Nothing below has been executed. Observations marked STATIC come from reading the pinned
source at the base commit, not from a run.

## Scope

Z3 (`selectGeneralExecutableOperationTx`) must stop refusing with
`Z3_S4_EXECUTABLE_BINDING_APPLICATION_CONSUMER_NOT_INSTALLED` and instead cause the X2
application owner to execute exactly one next composition step of an accepted
institution-origin application model, under the ORIGINAL P1 request, ORIGINAL S5
reservation, ORIGINAL deadline and ORIGINAL S6 obligations, then retain a receipt that Z3
reads as the owner result for its E-state. Z3 never executes, never renews, never grants.

Planned write path (design, not yet built): Z3 job -> selection row (SELECTED) + one
`run_application_semantics_v1` job -> X2 worker with its own claim (CONSUMING) -> S5 debit
from the original reservation, S6 identity, S8, wire, independent observation -> receipt
retained (RESULT_RETAINED) -> Z3 reads receipt.

## Pre-implementation findings (STATIC) that bound the design

F1. S5 inherited consumption refuses an execution child.
`z0_s5_application_consumption` (migration `postz_z0_institution_application_bridge.sql`
lines 209-224) accepts any node other than `original-computation` only when a session `s`
exists with `s.id = s.parent_id`, `p_body->>'nodeId' LIKE s.id||':%'`, no cancel request,
deadline in the future, and status NOT IN (COMPLETED, MODEL_READY, CANCELLED, FAILED, STALE,
BLOCKED). `prepareApplicationObligation` (`application-semantics/obligations.ts:94`) builds
the node as `${session.id}:${nodeId}` using the session that executes. For an execution
child `session.id <> parent_id`, so no row can satisfy `s.id = s.parent_id` with a matching
prefix; the only session with `s.id = s.parent_id` that shares the allocation is the
accepted acquisition parent, which is MODEL_READY (excluded) and has a different id prefix.
Expected result when X2 first tries to debit the original reservation for a child:
`Z0 actual original application session required`.

F2. S5 frame requires a quiescent original P1. `z0_s5_application_frame` for the
non-recovery path (lines 101-132) requires `compiler.status IN ('WAITING','PARTIAL')`,
`programme.status IN ('WAITING','PARTIAL','FAILED')`, unchanged generation/revision/plan,
rights revision equal to the origin's, no newer compiler revision, a live mandate, live
subject consents, and an origin deadline not beyond the minimum of the original episode,
wall, duty and programme deadlines. Consumption and wire charges both go through it.
Whether the original P1 is quiescent while Z3 runs is not established by reading.

F3. Child currentness. `currentInstitutionApplicationSession` ends in
`assertInstitutionApplicationOriginCurrent(ctx, origin, row.request, ...)` whose reader
does `InstitutionApplicationSelectorSchema.parse(request.institutionalOrigin)`. An
execution child's `request` is an `ApplicationExecute` object with no
`institutionalOrigin`, so currentness would fail with an untyped schema error.
`requestApplicationExecution` also refuses origin parents
(`Z0_INSTITUTION_LEARNING_IS_NOT_FRESH_BUSINESS_AUTHORITY`).

F4. Original P1 delivery treats any origin application session not in a terminal or
MODEL_READY state, or with unresolved possible egress, as pending
(`assertNoPendingInstitutionApplication`). A parked child would therefore block the
original P1 unless the parked state is recognised.

## Failure cases

Each case lists the trigger, the independent oracle (what an external reader of durable
rows or the fake portal can check without trusting the code under test), and the expected
outcome.

C01 Duplicate Z3 delivery (same job redelivered, same claim and fence).
Oracle: count of selection rows for (tenant, session, composition_ref, step_id, cursor
edge) = 1; count of `run_application_semantics_v1` jobs for that selection = 1; portal
request count unchanged. Expected: second delivery returns the same selection id.

C02 Duplicate Z3 delivery with a new claim for the same cursor edge (replay of an old Z3
claim). Oracle: selection row stores the claim digest/fence of the first selection; stale
claim attempt does not insert, does not enqueue; typed refusal. Expected: refused or
returned existing selection, never a second selection.

C03 Selection raced by cancellation of the application session (`cancel_requested_at`
set between Z3 validation and insert). Oracle: no selection row in SELECTED/CONSUMING;
no S5 consumption row; portal count 0. Expected: typed refusal; if already SELECTED, the
X2 claim refuses and the selection becomes STALE without a debit.

C04 Selection raced by authority revocation (mandate/consent/grant revoked). Oracle: same
as C03 plus the S5 frame refusal text. Expected: STALE/REFUSED, no wire.

C05 Selection raced by a stale source (source revision or rights revision changed).
Oracle: Z3 cursor mapDigest mismatch; no selection. Expected: typed stale refusal.

C06 Worker kill before the S5 debit. Physical SIGKILL of the application worker after
claim, before debit. Oracle: no consumption/charge row, portal 0. Restart: same Work, same
reservation, same deadline; exactly one debit afterwards.

C07 Worker kill after the S5 debit, before S6 identity. Oracle: one charge row with the
stable charge key; restart must not charge again (charge replay returns prior body); one
S6 identity afterwards.

C08 Worker kill after S6 identity, before wire. Oracle: obligation/effect row exists in
a pre-wire state; portal 0; restart reuses the same S6 identity and sends once.

C09 Worker kill after wire, before observation. Oracle: portal request count 1; request
row possible_egress and unresolved; restart reconciles, never re-sends, status UNKNOWN
retained until independently observed.

C10 Worker kill after observation, before receipt retention. Oracle: portal count 1,
observation present, no receipt; restart retains the receipt once against the selection;
no second wire effect.

C11 Worker kill after receipt retention, before Z3 reads. Oracle: receipt exactly one;
Z3 read returns it; E-state advances once.

C12 Wrong next step: Z3 selects a step id other than the first unexecuted composition
step, or a step that is not in the retained composition. Oracle: no selection row;
typed refusal naming the step. Expected: refusal.

C13 Z3 job attempts to execute directly (calls S5/S6/S8/wire itself). Oracle: Z3 code
path has no import of those writers; a Z3 claim cannot satisfy the X2 claim check; portal
count 0 when only a Z3 job runs. Expected: no effect without the X2 claim.

C14 Non-governed child steps alone: an execution child not marked viability-governed, or a
governed child with no selection, run by the X2 worker. Oracle: for governed child with no
selection no S5/S6/S8 rows and portal 0; for non-governed child the existing X2 behaviour
is byte-unchanged. Expected: governed child parks; non-governed unchanged.

C15 Other tenant / other principal. Oracle: every read and write keyed by tenant and
principal; RLS denies cross-tenant selection read; other principal cannot select or
consume. Expected: typed refusal and zero rows.

C16 Origin of child substituted (child `institutionalOriginRef` differs from the parent's,
or parent is not an accepted institution-origin session). Oracle: `originOf(child)` vs
`originOf(parent)` digest; refusal before insert.

C17 Original reservation exhausted. Oracle: S5 charge refusal text and unchanged
`usedAfter`; no renewal receipt; no new reservation row. Expected: truthful incomplete /
WAIT outcome; selection REFUSED; the original Work/deadline preserved.

C18 Remaining budget smaller than the next step cost (fallback). Oracle: Z3 observes
remaining from the original reservation, chooses the cheaper/WAIT alternative or declines;
no fresh budget. Expected: no overdraw.

C19 Original deadline expired. Oracle: `deadline_at <= now`; S5 frame refusal; selection
refused; no extension. Expected: terminal incomplete, original deadline echoed.

C20 Pending UNKNOWN (possible egress unresolved). Oracle: request row possible_egress and
status not VERIFIED/DENIED. Expected: no next selection
(`Z3_S6_PENDING_UNKNOWN_BLOCKS_EXECUTABLE_SELECTION`); UNKNOWN remains an environment
move.

C21 Model/check drift: retained model or check ref differs from the accepted one.
Oracle: ref digests. Expected: stale refusal at selection and again at claim.

C22 Semantic drift mid-composition: operationId/semanticRevision changes between the
selection and the consumption. Oracle: selection row operationId/semanticRevision vs the
current description. Expected: STALE, no wire.

C23 Selection for a superseded Z3 cursor (cursor advanced or mapDigest changed). Oracle:
cursor digest at selection vs current. Expected: STALE; the receipt is not applied to the
new cursor.

C24 Same step selected by two Z3 edges. Oracle: unique key (tenant, session,
composition_ref, step_id, cursor edge) plus a second partial uniqueness on
(tenant, session, composition_ref, step_id) for non-terminal selections. Expected: second
edge refused; one wire effect.

C25 Receipt retention replay: second retention of a different body for the same
selection. Oracle: receipt row immutable, digest equals first. Expected: refused.

C26 v2 byte stability: existing `finnor.s4.z3-original-observation.v2` evidence, mapDigests
and the Z3 public CI suite must be byte-identical before and after. Oracle: evidence
digests from `node scripts/project-z/run-ci.mjs --phase=z3` run before and after.

## Required oracle classes

- Database rows read by a separate connection: sessions, selections, jobs, S5
  consumptions/charges, S6 effects, requests, artifacts.
- The fake X2 portal request log (count and idempotency identity of wire requests).
- Z3 cursor/event rows.
- Physical process evidence for kills (PID, signal, exit status).

## Blockers recorded before implementation

B1 (F1) and B2 (F2) are not repairable inside the files owned by the Z3 S4 worker without
changing S5/Z0 owner SQL. See the worker report for the exact change and its owner.
