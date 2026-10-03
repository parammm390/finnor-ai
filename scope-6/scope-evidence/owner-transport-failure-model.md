# Authenticated native owner transport, registered before implementation

S6 owns delivery/enforcement, not the semantics of S1–S5 or a replacement effect
ledger. This work adds signed transport intents and separately retained append
receipts. Existing prepared records, native effects and allocation consumption
origins remain unchanged and unadmitted. The first native integration is the actual
S6 obligation preparation/replay boundary. Broader upstream adapters remain owned
work; generic transport support is not evidence that all producers are integrated.

The dispatcher must not choose a credential from an unauthenticated database row.
Externally signed configuration pins one semantic owner/tenant/principal/rights
route, owner origin verification keys, endpoint and accepted ledger signer/release/
policy/verifier identities. Source handlers sign exact delivery preimages before
ordinary persistence. A dispatcher independently verifies that signature and
scope before reading a transport token. Configuration/root/key/OS separation are
inherited dependencies. Test keys are disposable authority only. Prepared owner
content remains an authenticated assertion, never independent business truth.

Missing configuration preserves existing preparation behavior and issues no
receipt. Configured mismatched credentials/keys cannot silently downgrade to an
unsigned path. A native owner retry may enqueue the same immutable origin after
configuration/recovery, retaining the original identity. Compatible historical
origin keys and receipt pins may be externally configured; revoked source keys
block pending delivery without deleting its responsibility. Release rotation may
not rewrite earlier receipts. No production admission is self-issued.

Failure families:

- Change owner, tenant, principal, rights, kind, identity, content or origin signer
  in ordinary storage; forge an origin signature or a receipt-shaped response.
  No such row may acquire an authenticated accepted receipt through the worker.
- Native preparation, outbox intent or receipt storage fails; duplicate delivery
  races; a worker loses its lease or dies after a real protected append but before
  native receipt persistence. Retain intent and recover the same signed receipt
  and sequence, with no second native business effect or consumption identity.
- Ledger/source authority expires/revokes, a referenced parent is missing, the
  audit process is unavailable, a response is lost, oversized, changed or redirected.
  Retain unresolved transport, and do not grant effect execution or settlement.
- A native same-identity replay substitutes bytes or a stale worker writes after
  takeover. Reject immutable conflicts and fence local receipt persistence.
- A reader requests a foreign/sealed reference or trusts an unverified local
  `ACCEPTED` projection. Verify authenticated protected readback/receipt binding.

Native persistence is ordinary SQL/RLS and is not hostile-caller authentication.
Origin signatures are required at the actual credential boundary. Outbox receipts
are authenticated history claims only; they cannot release S5 resources, establish
current effect authority, causal truth, H2 value or a nonrollbackable deployment.
The ledger's protected journal/witness assumptions remain explicitly inherited.

Bounds: at most 256 unresolved intents per owner route, 64 claim attempts per
intent, at most 32 claims per batch, bounded 8 MiB records/responses, 1–10 second
request deadlines, and 3–60 second lease bounds with lease longer than request
timeout. No credential redirects. Production endpoints require HTTPS; HTTP only
accepts literal loopback in disposable test authority. Worker logs expose bounded
identities/error codes, no keys, tokens or owner content. Provider/cost metering
is not established by this transport; no production/cloud effect is authorized.

Test-authoring gate:

1. Observable contract: actual native owner issues a signed delivery intent;
   actual separate ledger process commits it; failed local receipt persistence
   plus physical SIGKILL recovers that same receipt; independent protected readback
   matches original bytes; forged storage/response cannot authenticate content.
2. Credible regressions: credential selection from body-claimed owner; receipt
   persistence before signature/content checks; changed retries; dropped intent;
   unfenced old-worker completion. The capability is currently missing, so its
   initial absent-interface failure is not labelled a demonstrated production bug.
3. Existing coverage: ledger's manual sender tests protect append behavior but
   do not exercise a native owner hook, signed ordinary outbox or actual dispatcher
   crash/local-commit recovery. Extend that boundary with one genuine end-to-end
   runner; preserve every original ledger/native test.
4. Production seams: native preparation hook, durable transport tables, signed
   owner configuration/client and recoverable worker are necessary interfaces.
   No pre-supplied receipt, test callback, transport flag or kill hook is introduced.

The runner uses an actual previously generated S1/S3/S4/S5-bound native obligation
in an authorized disposable PostgreSQL cluster. Native replay authenticates its
real owner and reads the original immutable row; the harness does not supply the
outbox signature or append receipt. A real database trigger rejects local receipt
persistence only after the real ledger commits. The supervisor observes that
failure, independently reads the committed reference, then kills/reaps the actual
worker. Recovery waits for the actual lease to expire. Inputs, faults, requests,
origin signatures, receipts, native readbacks, source freeze and rerun command are
retained. Local authority and development authentication do not become production
or live-provider qualification. The full frozen S6 gate remains required.

Before the first implemented scored run, strengthen the forged-storage case with
an actual missing credential file. Temporarily rename the disposable token file,
then require origin-signature refusal both through the actual dispatcher and its
real public transport boundary, with zero authenticated network requests. Restoring
the token happens in finally. A credential-first implementation would reach the
missing file instead of the intended signature refusal. This is an observable
negative control, not a credential-read spy or injected production callback.

The first native transport run passes all four challenges with source freeze.
Its supervisor/child CPU, memory and billing were not captured; those remain
explicit metering gaps, not zero cost. Next extension, registered before API code:
the actual authenticated obligation handler must resolve the native origin before
reading a protected commitment. It returns a separately named commitment receipt,
false execution authority and false settlement, leaving original prepared bodies
untouched. A foreign caller and extra authority field must fail before transport;
a changed signed receipt must yield unavailable (503), not a trusted native result.
Plausible failures are a caller/body-selected owner, an unverified local projection,
or promotion of a byte receipt into method/effect settlement. Existing four cases
do not cross this actual application authentication/schema/owner boundary. The
new read operation is a necessary production consumer interface, not a test seam.
Capture raw supervisor rusage and independent worker PID/parent/group/UID census
in new runs; retain their limited accounting scope. Every scored rerun uses fresh
actual upstream/native fixtures so earlier signed intents/receipts stay immutable.

`owner-api-absent-baseline` reaches the missing route (404), but also retains a
harness timing failure: `Date.parse(String(pgTimestamp))` rounds through a date
string without milliseconds. The recovery claim was attempted before native lease
expiry, inspected zero rows, then the dependent forged-row case reached that still
pending real intent. Do not qualify those two failures as production regressions.
Before API implementation, replace the wait with an independent PostgreSQL-clock
query over the actual persisted lease. The original native lease and claim checks
are preserved. This improves the oracle; it does not extend or weaken leases.

The corrected `owner-api-absent-baseline-clock` run passes the original four
challenges with unchanged source and fails only at the actual handler's missing
`read-commitment` operation (404). Implement that consumer after this baseline:
authenticate/read the existing native obligation first, then require the protected
reference's exact bytes and S6/principal commitment binding. Return the separate
commitment receipt without changing the original body or declaring execution or
settlement. Catch bounded transport faults without exposing secret file paths.

`owner-api-current` passes all five registered cases after the consumer is built.
The fresh actual upstream/native owner run also passes five cases; the original
17-case separate-process ledger run passes on the current protected sources.
All three source freezes pass. Root and S6 script typechecks pass. Test authority,
development headers, local filesystem/OS identity and supervisor-only resource
accounting remain exact limits. No test is removed or receipt/admission pre-supplied.

## Final append attempt recovery, registered before implementation

The native 64-attempt append budget must not strand a protected receipt when the
last append commits remotely but local persistence fails. Recovery must respect
that append limit, independently verify the original signed request and receipt,
and persist under a fresh native lease. A bounded read-only recovery claim may
retrieve existing history; it must never issue another POST, reset attempts,
trust an ordinary receipt projection or grant execution/settlement authority.
Missing/invalid protected history retains operator responsibility. Recovery checks
have their own maximum of 64 and the existing request/lease/batch byte/time bounds;
they do not fabricate S5 clearance or measured billing.

Authoring gate: observable contract is actual final-attempt commit/SIGKILL recovery
without another append; a credible defect is the existing `attempts<64` selector
stranding that lease; the original attempt-one crash case cannot reach this bound;
parameterize that same real owner/process/database test with `--final-attempt`,
without a new production test seam. Before code, drive 63 actual native failed
claims with the disposable credential file absent. Independently inspect each
RETRY/attempt count, then advance only its retry-due timestamp with disposable
admin SQL to avoid hours of backoff. This is a stated scheduling fault, not
pre-supplied receipt, admission, attempt count or simulated claim ownership.
Restore the token, allow the real separate worker's attempt 64 to commit, inject
the existing local receipt-storage fault, physically SIGKILL/reap, remove the fault,
wait on PostgreSQL's actual lease clock and recover. Require exactly one actual
POST, the same independent signed receipt/sequence, attempts still 64 and captured
request/state/resource evidence. Fresh authentic upstream fixtures per scored run;
no relevant edits during any runner. Keep normal attempt-one coverage unchanged.

`owner-final-attempt-baseline` drives all 63 native failures, then commits one real
POST on attempt 64. Its recovery inspects zero rows and accepts zero receipts;
the four other challenges pass and source freeze holds. This reproduces the
exhausted-claim selector defect. The failed case did not save its PID census before
the final assertion, so that particular baseline has incomplete crash accounting.
Retain it and save crash-boundary evidence before recovery assertions in new runs.
The earlier sandbox-EPERM fixture run executed no tests and is unqualified; the
permitted fresh native fixture run passes all five cases with source freeze.

Repair with a native `RECOVERY_READ` claim mode and separate recovery-check count,
never a 65th append. Reconstruct the exact original request and its protected parent
receipts, verify origin before credentials and verify the returned commitment against
that request. Keep the actual database lease deadline through all parent/read calls;
expired/budget-exhausted claims retain explicit operator responsibility. Capture
claim mode/count and require append attempts=64, recovery checks=1 and one POST in
the repaired bound case. Ordinary receipt projections remain insufficient.

`owner-final-attempt-repaired` passes all five owner/process/API challenges with
unchanged sources after migration 0151 is actually applied and bundled. The real
worker PID 38760 is independently recorded as UID 501, physically SIGKILLed and
reaped. Native recovery persists the identical protected sequence-1 receipt under
`RECOVERY_READ`, append attempts stay 64, recovery checks become 1 and exactly one
actual POST is recorded. The fresh native upstream run passes its five cases;
root and S6 script typechecks pass. This is empirical disposable local recovery,
not production admission, S5 release, live-provider qualification or aggregate
resource accounting. Ordinary attempt-one compatibility remains to be rerun.

`owner-read-recovery-normal` subsequently passes all five unchanged challenges
with source freeze and terminal exit 0, using fresh authentic upstream fixtures.
The ordinary crash path retains its original same-receipt append retry behavior.

## Exhausted recovery lease, registered before test extension

1. Observable contract: the actual 64th read-only recovery claim commits no new
   append; a receipt-storage fault and physical worker SIGKILL on that final read
   leave REQUIRES_OPERATOR after native lease expiry. Append attempts remain 64,
   recovery checks remain 64, the original origin and protected commitment remain
   intact, and subsequent batches make no authenticated request for that intent.
2. Credible regression: read-claim count resets, an expired final read is silently
   skipped as CLAIMED forever, or recovery issues another POST after exhaustion.
3. Existing final-attempt coverage reaches recovery check 1, so it cannot exercise
   the terminal cleanup transition. Extend the same real native owner/process crash
   test with `--exhaust-recovery`, keeping both earlier modes and all five cases.
4. No production seam: a disposable HTTP proxy loses real protected GET responses;
   the existing real SQL fault rejects receipt persistence. The supervisor alone
   advances retry-due timestamps, never attempts/counts/signatures/receipts/leases.

Drive the original 63 native pre-append failures and attempt-64 commit. After its
first crash, perform 63 genuine recovery claims with the protected GET response
lost at the proxy, independently inspect RETRY/count/receipt-null, and retain
each request and SQL state. A fresh separate worker performs recovery read 64
with the original receipt-persistence fault active, then is independently observed,
SIGKILLed and reaped. Remove the fault, wait on actual PostgreSQL lease time, and
require terminal operator responsibility with no new request or erased commitment.
Resource scope remains supervisor-only; test authority is not production admission.
This verifies an implemented budget contract; no pre-fix bug claim is made unless
the new case actually exposes a new failure before its repair.

`owner-exhausted-recovery` passes all five extended end-to-end challenges with
terminal exit 0 and unchanged sources. It records 63 real protected GET responses
lost at the proxy, recovery read 64 reaching the actual SQL receipt fault, physical
SIGKILL and native lease expiry. Cleanup retains REQUIRES_OPERATOR with append
attempts=64, recovery checks=64 and the exact recovery-budget error. Subsequent
batches issue no request for that intent; protected receipt sequence 1 remains
independently readable and there is exactly one POST. No additional production
repair was needed for this registered terminal transition. Fresh native fixtures
and the S6 script typecheck pass. The earlier normal and final-attempt evidence
remains retained with its exact source snapshot.

## Genuine native S5 reference transport, registered before implementation

S5 retains resource selection, commitments, consumption and release. Its authentic
ordinary owner boundary may sign and enqueue exact immutable resource, problem,
certificate, reservation-origin and consumption-origin bytes in the same existing
SQL transaction. Compatible authenticated read/replay may enqueue historical
origins after transport configuration becomes available. Changed projections,
current statuses and protected receipts must never replace signed origin bytes.
Every declared reference must have its actual canonical preimage; supplied opaque
BUSINESS_OWNER or SUPPLIED references are not relabelled, rehashed or fabricated.
No prepared S5 body is promoted to actual consumption, settlement or admission.

Failure families include signing another tenant/principal's allocation, signing
a mutable reservation/consumption projection under an immutable origin reference,
inventing missing upstream reference preimages, losing native intent on receipt
failure and allowing an S6 issuer key to sign as S5. Configuration and separate
origin keys remain externally pinned; local test UID is not production isolation.

Test-authoring gate:
1. Observable contract: the actual authenticated native S5 read issues signatures
   for its five real immutable record families; the actual dispatcher and separate
   ledger commit them, and independent SQL/protected readbacks match exact originals.
   Original false authority/null receipt qualifications and one native effect remain.
2. Credible failure: absent producer hook, incorrect projection preimage, foreign
   owner access or cross-owner signing key accepted before credential access.
3. Existing S6-origin cases and synthetic typed ledger events cannot reach authentic
   S5 owner issuance. Extend the existing end-to-end owner runner with one additional
   S5 case, reuse its real fixtures/processes, and preserve all five existing cases.
4. Necessary production interfaces are native owner hooks and existing transport;
   no new test-only export, callback, pre-supplied receipt or admission is needed.

Before code, configure a distinct disposable S5 origin key and transport token,
call the actual native S5 owner against fresh S1/S3/S4/S5-generated fixtures and
expect native signed origins. The missing-interface baseline is capability absence,
not a demonstrated existing production defect. Independently read actual immutable
SQL origins, verify native signatures with the separate public S5 key, deliver
through native leases and compare full protected reference/receipt bytes. Challenge
foreign native context and an S6 signature with the S5 token file physically absent;
require the intended signature refusal with no request. Retain sources, identity,
requests, origins and qualification. S5 experience-event DAG integration and broader
S1–S4/S7/S8 transport remain owned work after this reference boundary.

`owner-s5-transport-baseline` passes the original five cases and fails only the
registered S5 capability case: actual native S5 read returns its genuine records
but issues zero transport origins where five immutable record families are
required. Source freeze passes and terminal exit is 1. The native upstream fixture
and S6 script typecheck pass. Preserve this capability-absence baseline before
adding owner-transaction hooks; do not label it an existing production regression.

`owner-s5-transport-current` passes all six cases with terminal exit 0 and source
freeze. Actual authenticated S5 read issues its real problem, certificate,
resource, reservation-origin and consumption-origin signatures. Native dispatch
accepts all five with no failure; protected independent readback matches exact
immutable SQL preimages and S5/principal receipt bindings. A foreign native context
and an S6 signature with the S5 credential physically absent fail before any
transport request. The original S6 effect remains singular; S5 bodies retain false
execution authority and null protected receipts. Fresh actual upstream checks and
both typechecks pass. These are byte/history commitments under disposable local
authority, not actual consumption, settlement or production isolation/admission.
Configured initial-write hooks, S5 event DAG transport and wider owners remain
separate owned validation/integration work.

The full existing S5 owner E2E suite is rerun for the native hook changes in
`s5-owner-transport-dependencies`: all 14 cases pass, terminal exit 0, and an
independent SHA-256 comparison finds no changed registered source. A fresh disposable
database applies all 150 migration files. The run covers original covenants,
coupled/temporal resources, multi-process reservation/replay, transaction/revision
faults, actual handoff/SIGKILL/unknown/expiry/release conservation, solver/deadline
refusal, stress, bounded registry, responsive cold certification and independent
accountability readback. Its generated H1 inputs/development authentication and
unconfigured transport remain exact limits; it does not qualify configured creation
hooks, external business effects, production keys or measured economic value.

### Configured resource writer extension, registered before test change

Extend the same S5 case with the actual authenticated resource API while the
separate S5 transport configuration is present. Reissue the real resource as a
linked revision with its exact native input and updated knowledge time. Observe
the new transport origin before any allocation read can backfill it, dispatch it,
and independently verify both historical and new protected bytes. The actual
reservation must become revoked for current clearance while retaining its full
resource envelope and unchanged immutable origin; validate must report stale and
false execution authority. No protected commitment may release S5 resources.

Authoring gate: this guards native creation/transaction coupling and revision
conservation; omitting the writer hook or signing a projected origin would fail.
The earlier S5 case only backfills through authenticated read and the full S5 suite
uses absent transport, so neither reaches configured creation. Use the existing
real resource/validate handlers and SQL/protected reads, without new production
seams or supplied signatures/receipts. This is end-to-end qualification of an
implemented interface, not a new pre-fix regression claim. Preserve prior cases
and source snapshots, and run against fresh native fixtures.

`owner-s5-configured-creation` retains five passes and one failure with unchanged
sources/terminal exit 1. The extended S5 case passes all historical origin/read
checks, then its resource writer returns actual STALE_INPUT (409): the native
upstream fixture's final revocation challenge has already invalidated the saved
S1 rights pins. This is the correct earlier source/rights guard, not a missing
writer hook or production regression. That run cannot qualify configured writer
coverage. Retain the refusal as an explicit negative control, then obtain fresh
pins through the actual permitted S1 owner for the new linked resource revision.
Do not change old pins, origin bytes or authority checks. Register that corrected
positive input and retain its actual S1 readback in the rerun artifacts before
the writer is tested again.

`owner-s5-configured-creation-current` passes all six cases with source freeze and
terminal exit 0. The saved stale pins are refused at the intended 409 guard with
no transport origin/request. Fresh actual S1 owner views supply the new linked
revision's pins. The real resource API issues revision 2 and retains its signed
PENDING origin before any read-backfill call; native dispatch accepts it and exact
new/historical protected reads agree with the immutable bodies. The outstanding
reservation becomes RESOURCE_REVISION_CHANGED for clearance, keeps its original
envelope/origin and is not released; validate reports STALE_INPUT/false authority.
Original S6 crash/signature/API and S5 historical transport checks remain passing.
Fresh upstream and S6 script typechecks pass. This configured resource writer
proof remains distinct from untested configured initial proposal/reservation/
consumption issuance and from missing event-DAG/production/provider qualification.
