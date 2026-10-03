# Artifact publication dispatch registration

Extend the authoritative artifact owner E2E before repairing publication. Contract:
revocation after initial permission evaluation and after provider-transport resolution
must prevent new mutation, while retaining the prepared publication and its exact
logical provider-operation identity. Suspend the actual persisted principal from
the transport-resolution fault injector; the fixture never supplies authority,
receipts or settlement. Independently read publication, operation, invocation and
provider bytes/count. A stale single preflight is the credible regression. Existing
conflict/retry/readback cases do not revoke between preflight and mutation. No new
production interface solely for tests is needed. This proves the native owner
boundary with a disposable provider fixture, not isolated brokerage/live Graph.

Read the actual Microsoft adapter before changing it. It uses createUploadSession
with If-Match, not simple PUT-content. Official Graph v1.0 documentation describes
precondition rejection for session creation and permits resumable byte ranges. It
does not establish business authority or prove final semantic preservation under
all concurrent-session interleavings. Those contracts still require actual admitted
method and staging transcripts. Preserve existing qualified transport and independent
semantic artifact readback; do not transplant metadata or another provider's retry
semantics into it. Sources checked 2026-10-02:
https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0
https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0

Further owned work: effect-bound current authority/fences at every actual physical
Graph egress, exact account/record/version/bytes mediation, sealed credentials and
protected audit outage refusal. A new pre-primitive guard alone cannot certify that
complete boundary. Admission/production release is not issued by these fixtures.

## Physical upload lifecycle authoring gate

The same primary artifact owner now exercises the actual Graph client and file
adapter against a bounded HTTP response fixture. Three cases protect distinct
observable transitions: current authority revoked immediately before session
creation permits zero POST/PUT; revoked after an acknowledged upload session
permits no subsequent byte upload and retains unknown logical responsibility;
the unchanged-authority control completes the actual session plus byte upload and
independent artifact readback. The fixture supplies only provider HTTP responses
and a disposable cached delegated token, never native receipts or settlement.
The credible regressions are one-time authority checks, failure of a second
physical invocation under a single logical attempt, and erasing prior possible
delivery when the next request is known to have been refused before dispatch.
Existing replaceConditional fixtures cannot observe these internal physical
transitions; existing provider unit hooks do not use the native database owners.
No new production seam is needed: use the client's existing fetch option and the
artifact owner's existing transport dependency. This is actual client/native
protocol evidence, not Graph staging, credential brokerage, or protected isolation.

Failure model before isolated helper repair: overlapping physical requests must
not share an unfenced active attempt; a stale terminal/reconciliation attempt must
not prepare another invocation; sequential acknowledged or definitely rejected
transport requests can continue under the same logical attempt. Refusal of a
later request cannot erase an earlier acknowledged/possible request. Terminal
verified truth must not be downgraded by late failure bookkeeping. Preserve the
physical request's known refusal separately from the logical operation's unknown
outcome. Audit/authority failure blocks the dependent request; already dispatched
requests remain governed by readback/reconciliation and provider semantics.

Baseline retained before production changes:
`artifact-revocation-baseline` reaches persisted revocation and still writes once,
then falsely treats that unauthorized publication as verified. The three-case
`artifact-physical-baseline` reaches the real client/native invocation owner:
before-session revocation still emits POST; after-session refusal erases durable
unknown publication responsibility; the neutral control cannot create the second
physical invocation because preparation incorrectly requires the attempt to still
be `claimed`. All three failures are retained. The later-request authority case
is masked by that lifecycle defect, so it must be rerun after repairing only
sequential physical preparation, before adding the current-authority guard.
Root typecheck passes with the preregistered cases. No coverage was deleted.

`artifact-physical-authority-baseline` reruns after only sequential request
preparation repair: the neutral control passes and both revocation cases now
deliver session plus file bytes and reach `verified`. Thus both current-authority
counterexamples reach the intended boundary before the authority repair. The
pre-primitive case's initially written external-operation expectation used a
workflow-attempt state name; corrected to the existing native external-operation
contract `known_failed` before the repaired run. This does not change the
baseline's demonstrated unauthorized write or supply its native result.

Repair qualification: canonical current authority and immutable native publication/
binding/attempt checks run after transport resolution and again immediately before
each physical request's durable may-have-left marker. Native audit events retain
the exact current decision and attempt/invocation identities. The authority
snapshot, database event/marker commit, and provider call are separate boundaries;
revocation after that snapshot or a provider-accepted request cannot be undone.
This trusted-process repair is not an independently protected broker or credential
boundary, and the HTTP fixtures grant no live-provider admission. Prior possible
physical delivery remains unknown when a later request is refused; authority and
audit/parse errors must preserve publication recovery rather than terminate it.

## Sibling native artifact authoring gate

Before modifying new-file creation or recalculation, extend the same actual artifact
owner suite with a table: creation and recalculation revoked at second transport
resolution, plus recalculation revoked after its session is created. Required
observations are zero new creates/calculations after revocation, no cleanup write
under revoked authority, persisted known refusal before any adapter mutation, and
unknown responsibility after a possible session creation. The credible break is
the sibling owners' current single preflight and blind cleanup in finally. Existing
positive cases never revoke during these boundaries; replacement's owning guard
cannot cover a distinct creation row or workbook-session lifecycle. Existing public
transport dependencies and actual principal suspension supply the fault, with no
test-only production seam. Record all calls and native creation/operation truth.
These primitive fixtures remain bounded trusted-owner evidence. Physical recalculation
cleanup must precede logical acknowledgement so its actual client invocation stays
fenced; provider session/cleanup lifecycle and durable recovery will need further
physical-owner coverage, not an assumption derived from this table.

Sibling baseline retained: the first creation fixture reused an already provider-
bound document and hit the existing unique external-reference guard after its
unauthorized create. That is retained as a fixture limitation. Use a native blank
unbound document for creation and rerun before changing the creation/recalculation
owners. `artifact-sibling-revocation-baseline-owner` reaches all three intended
boundaries: creation and both recalculation cases produce `verified` after actual
principal suspension. The after-session case also performs calculate and close.

Repairs preserve one native logical owner. Creation checks its immutable row,
principal, byte identity, exact folder/name and currently enabled, permission-
verified source scope after transport resolution and at every physical request.
Recalculation rechecks current authority and exact binding at each primitive and
physical request; acknowledgement moves after range collection and session close.
Transport resolution now belongs to the native failure handler. Cleanup cannot
blindly retry a possibly delivered close or execute under revoked rights. Persisted
unknown responsibility is not a claim that all provider sessions can be discovered
or closed after process death; that recovery and protected brokerage remain owned.

Strengthen the existing positive creation/recalculation owner cases prospectively,
rather than duplicate them: use the real Graph adapters/client and native mutation
audit, with only HTTP state/token as fixture. Observable contracts are successful
session-plus-upload creation and create/calculate/close lifecycle, exact readback,
durable physical receipts and no extra creation on replay. Credible regressions
include premature logical acknowledgement fencing a later close, missing physical
receipts, or lost immutable folder/name/byte bindings. The primitive fixtures cannot
reach those actual native/client transitions. No production seam is added. This
is conformance strengthening of existing positive coverage; it does not retroactively
claim a newly demonstrated pre-fix regression or live Graph/provider admission.

`artifact-sibling-dispatch-repaired`: 27 owner cases pass (20 artifact, 7 subscription),
no skips, sources unchanged; root typecheck passes. The prospective actual-client
creation/recalculation run then reaches successful owner results but its added
evidence query fails on uuid/text inference. Preserve `artifact-native-transport-owner`
(18 passed, 2 evidence-harness errors); explicitly cast the document identity in
that query and rerun. Do not treat the evidence-harness failures as passing proof,
or modify production to satisfy them.

The wider `artifact-native-transport-dependencies` run has 116 passed, 2 failed,
zero skips. Both failures occur after actual native/client success, at the
evidence helper's wrong `business_events.created_at` sort column. The actual schema
uses `occurred_at`; fix that harness query and rerun the owner before another wider
dependency pass. Retain both harness-error runs and exact source snapshots.

## Exact provider identity authoring gate

Before changing DriveItem observation, extend the physical replacement and primary
Excel table with a wrong-record response after acknowledged mutation, preserving
identical artifact bytes and eTag. Contract: the concrete account/Drive/item request
and independent observation must agree on exact item identity; byte/semantic equality
from another item cannot establish verification. Plausible break: the adapter copies
the requested identity beside an unrelated response id, and the owner verifies only
artifact semantics. Existing wrong-semantic and version-conflict cases do not catch
identical bytes on the wrong record. Use the existing actual client HTTP fixture;
no production test seam or pre-supplied verification. Inspect native publication/
operation and physical requests. Retain uncertainty after possible delivery rather
than translating an invalid response into known absence. These are actual owning
boundary identity regressions with fixture response identity, not a claim that a
live Graph endpoint returns another user's file.

`artifact-wrong-record-baseline`: both actual-client owning paths accept decoy ids
after acknowledged writes and persist native `verified/reconciled`; preserve their
full readbacks before repair. After exact identity checks in the ordinary adapter
and native replacement/recalculation observation owners,
`artifact-target-readback-repaired` passes 29 cases (22 artifact, 7 subscription),
zero skips, sources unchanged. Wrong-record replacement remains unknown delivery;
wrong-record calculation refuses final verification and retains its native
awaiting-observation responsibility. Independent staging remains required for live
provider claims. Creation's exact folder/path independent resolution and durable
session discovery/cleanup after process death remain owned tasks.
