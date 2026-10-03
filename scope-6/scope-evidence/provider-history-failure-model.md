# Whole logical-operation delivery history, registered before repair

Contract: a later physical refusal, an abandoned prepared request, or a new runtime
attempt cannot erase an earlier possible/accepted delivery of the same logical
operation. After the real provider-key window expires, a subsequent claim must stay
blocked unless the native owner has independently reconciled absence. Physical
no-egress evidence describes that request alone. A preparatory request ACK also
cannot certify completion of a multi-request logical adapter.

Credible regressions: failure and stale recovery inspect only the newest invocation
or newest attempt; generic result bookkeeping then overwrites unknown with failed;
recovery promotes an intermediate adapter ACK into logical completion. Existing
Scope-2 crash tests kill only a one-request initial attempt. The artifact tests cover
same-attempt live refusal but not physical SIGKILL or a provider-key retry followed
by a known refusal. These are distinct missing history/lifecycle boundaries.

Primary owners: extend the actual ScopedToolRegistry/PostgreSQL test with a local
HTTP provider that accepts then drops a response, a fresh native retry refused by
the real pre-egress callback, actual expiry of the disposable persisted key and a
third caller. Extend the existing physical crash matrix/child fixture with an actual
HTTP accepted intermediate ACK followed by prepared-tail SIGKILL, a preparatory ACK
followed directly by SIGKILL, and an uncertain earlier attempt followed by a newly
prepared retry and SIGKILL. Native production owners create all claims, invocations,
outcomes and recovery state; HTTP fixtures supply only provider behavior. No new
production export, chaos hook, fake receipt or protected authority is required.

Inputs/effects, native whole history and recovery/refused claims are retained before
assertion. Independent provider request count remains one. The scoped-registry case
allows a pre-fix third request only to the disposable local provider and records the
duplicate consequence if it occurs; post-fix it must never reach that provider.
Preserve all existing tests and actual crash modes. Future verified-absence recovery
must remain usable: a reconciled absence is a native history barrier, not permission
to erase older facts. No live provider TTL, protected admission, S5 settlement or
universal exactly-once guarantee is claimed from these local cases.

Budgets: one local listener per case, 500 ms transport deadline, one wrapper attempt,
30 seconds child startup/physical SIGKILL, bounded native recovery batch <=500.
Expiry injection changes only the disposable operation's actual TTL column after
the second attempt; no production clock or idempotency rule is altered.

Retain a positive native-protocol control at its existing Scope-2 owner: an explicit
trusted-owner `reconcileOwnedExternalOperation(..., failed, evidence)` records an
absence barrier; subsequent definite pre-egress failure may still be retried. This
case guards accidental permanent blocking from scanning all historical invocations
without respecting native reconciliation. Existing tests stop after the first safe
reclaim and do not inspect a later failure after an absence barrier. No test-only
interface is added. The reconciliation input is explicitly a trusted-owner fixture,
not evidence that this core API independently observed a real provider's absence.

Observed baselines: `provider-history-retry-baseline` fails after two actual accepted
local HTTP POSTs for one logical member; the refused second attempt temporarily
classified the operation as failed and enabled the expired-window replay. The three
`provider-history-crash-baseline` cases all fail at the intended durable boundary:
an intermediate ACK becomes succeeded/awaiting-observation; prepared tails following
an ACK or older uncertain attempt become failed/known-failed. Full readbacks are
retained before assertion. No live provider conclusion follows from these fixtures.

Repair: scan possible delivery across all attempts after the latest native absence
reconciliation, preserve the prepared tail's physical no-egress evidence separately,
and require owner-persisted logical completion metadata before recovering an ACK as
logical success. Generic result bookkeeping is serialized with the native operation,
refuses older-attempt result updates and retains uncertainty instead of rewriting a
later refusal into absence. Physical metadata is kept out of cached business output.
Legacy ACKs without the new owner metadata require reconciliation; they are not
retroactively strengthened. The first focused repair passes five cases (22 explicit
filter skips); a retained TypeScript inference error is repaired before broad checks.
`provider-history-owner-final` passes all 27 cases with zero skips, including the
original crash suite and the new real SIGKILL cases; source freeze and root typecheck
pass. Existing trusted-owner fixture qualifications remain unchanged.

## Provider-key expiry at the last native dispatch boundary

Extend the same actual ScopedToolRegistry/local HTTP case as a two-row table,
preserving its refused-retry row. Contract: a retry admitted solely by a live provider
key cannot cross native may-have-left persistence once that actual window expires.
Credible regression: native claim checks TTL once, asynchronous pre-egress work
outlasts it, and the marker checks only attempt status. Existing expiry cases change
the TTL before the next claim; none expires it between claim and dispatch. No new
production seam: the existing dispatch callback awaits the actual native runtime
expiry plus 30 ms on the second attempt; the provider sees and records real POSTs.
Use a 1-second disposable key in this row, still one 500-ms transport attempt. The
post-fix marker must refuse the prepared retry before transport entry, record physical
definite pre-egress failure and preserve earlier logical uncertainty. A marker check
does not guarantee provider arrival before a TTL deadline; network delay/provider
enforcement remains an explicit contract limitation for any real retry admission.

`provider-expiry-dispatch-baseline` retains one passed refused-retry control and one
intended late-expiry failure: two actual POSTs and two may-have-left/unknown native
invocations. The first marker repair incorrectly equated physical and logical
request hashes, rejecting six valid artifact transport cases. The actual artifact
owner deliberately derives each physical hash from the logical hash, ordinal,
operation and method; these hashes name distinct protocol objects. Remove that
incorrect newly introduced equality, keep the native lock/current attempt/window
checks, and retain every original artifact assertion. Full concrete request binding
still requires the protected IR broker; a false hash equality cannot substitute it.
The same run retains a TypeScript closure narrowing error, fixed by capturing the
actual native expiry instant before the asynchronous wait. Neither failure is
qualified as a pass. No coverage or authority guard is weakened to hide the failures.

`provider-expiry-owner-final` passes all 57 selected owner/dependency cases with
zero skips and source freeze after both repairs. The delayed callback now reaches
the expired native window, the durable marker refuses the second dispatch with
definite pre-egress conflict, and the independent HTTP observer retains exactly one
accepted request. Artifact creation/publication/recalculation, subscriptions and
all original native crash cases remain intact. Root typecheck and targeted diff
checks pass. Earlier `provider-history-dependencies` passes 148 cases without skips
for its pre-TTL-fence snapshot; it is retained separately, not called current proof.
