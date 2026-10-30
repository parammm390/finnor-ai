# Z3 native session: failure model (written before the late-bound observer and the native driver)

Base: `w/z3-s4` after `s4-executable-consumption-failure-model.md` (cases C01-C26 still apply and are
exercised by the native driver where they can be observed on the stack). This file adds the cases that
exist only because the native session runs on the real stack with a real original Work, and the one
product change they require.

Nothing below has been executed when this file is committed. STATIC means read from source.

## Finding that forces a product change (STATIC, then confirmed by the run named in the report)

B3. A Z3 native map (`finnor.z3.original-native-map.v2`) is the Work instruction of the ORIGINAL Work.
Its `APPLICATION_SNAPSHOT` observer carries `responsibilityIdentity` (a hash that includes the mandate id,
which is only created after the Work exists) and every predicate carries `revision == model.ref` (which
embeds the knowledge cut of an acquisition that needs the original Work input). Both are therefore
unknowable at the time the Work input that must hold the map is written, and the Work input cannot be
appended (Z0 refuses it). A map for an institution-origin application can never be written honestly.

Smallest honest change: an additive observer binding `lateBinding: "ACCEPTED_ORIGIN_MODEL"` (no
`responsibilityIdentity`). It binds, at every read, to the ONE application session that continues the
ORIGINAL P1 request (`programId` = the original request id) AND whose acquisition parent is MODEL_READY
with an `S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event for exactly the child's retained model/check.
The predicates carry a fixed placeholder revision instead of the model ref; the actual model, check,
authority and original-parent digests stay in the owner `contextDigest`, the operation digests and the
cursor identity, so any change of model/check/authority still changes the evidence digest and invalidates
the session exactly as before. Maps without `lateBinding` parse, hash and resolve byte-identically.

## Cases

N01 Late-bound observer carrying a `responsibilityIdentity`, or an old-style observer without one.
Oracle: map parse. Expected: `Z3_GENERAL_NATIVE_MAPPING_SCHEMA`.

N02 Late-bound predicate whose revision is a real model ref (or any ref other than the placeholder).
Oracle: `resolveGeneralS4BindingsTx`. Expected: `Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED`.

N03 Two application sessions continue the same original P1 request (second governed child, a standalone
child). Oracle: `applicationContext`. Expected: `Z3_NATIVE_UNIQUE_ORIGINAL_APPLICATION_OWNER_REQUIRED`;
and the origin-child request refuses the second child (`Z3_ORIGINAL_EXECUTION_CHILD_ALREADY_EXISTS`).

N04 Child whose model/check differs from its acquisition parent's accepted model, or a parent with no
`S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED` event. Oracle: SQL read of both sessions and the event.
Expected: `Z3_NATIVE_ORIGINAL_APPLICATION_LINEAGE_CHANGED`; no session row and no job is written.

N05 Late-bound map submitted before the governed child exists. Expected:
`Z3_NATIVE_UNIQUE_ORIGINAL_APPLICATION_OWNER_REQUIRED` (HTTP 422 predicate), no Z3 session row.

N06 Map binds an operation id or semantic revision the accepted model does not contain.
Expected: `Z3_NATIVE_ADMITTED_TYPED_OPERATION_REQUIRED`, no session row.

N07 Z3 job selects the step. Oracle: portal journal (admin snapshot) and S5 charge rows before and after
the Z3 delivery. Expected: exactly one selection row SELECTED, exactly one `run_application_semantics_v1`
job carrying its id; the portal journal and the application request rows are unchanged until the X2 worker
claims the selection (the Z3 job has no application claim and no effect writer).

N08 Duplicate delivery. `viability-recover` twice while the selection is live, and a physically redelivered
Z3 job. Expected: the same selection id, one X2 job, portal records for the step written at most once.

N09 X2 worker consumes and Z3 resumes. Expected: selection RESULT_RETAINED, receipt `S4`
`finnor.s4.z3-application-step-receipt.v1` bound to the Z3 session/edge/cursor/map, S5 charge rows against the
ORIGINAL reservation only (reservation id unchanged, no new reservation), the portal record phase equals the
independent readback in the receipt, and the next Z3 cursor `from` the E state equals the typed outcome
selected from the receipt facts (never from the portal).

N10 SIGKILL of the application worker after the wire effect and before observation/receipt. Oracle: pid and
signal of the killed process, portal journal count for the idempotency identity (must stay 1 after restart),
S6 effect row (same id), selection status. Expected after restart: same Work, reservation, deadline, S6
identity; no second wire effect; selection stays CONSUMING (UNKNOWN retained) until independently observed;
while it is not VERIFIED a Z3 recovery cannot advance (the S6 obligation is outside the map universe:
`Z3_ORIGINAL_S6_IDENTITY_OR_UNKNOWN_CHANGED` or the pending-UNKNOWN refusal) and the E state is not entered.

N11 SIGKILL of the Z3 worker after selection and before the cursor write. Expected: restart recovers via
`viability-recover`; selection unchanged (one row, one X2 job); Z3 cursor advances once from the retained receipt.

N12 Cancellation of the governed child before consumption; revocation of the application profile grant before
consumption. Expected: selection STALE/REFUSED with a typed reason; no S5 charge, no portal write; Z3 refuses
(`Z3_S4_EXECUTABLE_SELECTION_REFUSED_OR_STALE`); the original Work is not completed or altered.

N13 Exhausted original S5 request allowance when the selected step is consumed. Expected: S5 refusal text,
selection REFUSED, used units unchanged, no new reservation, no renewal; Z3 reports the original budget
exhaustion truthfully.

N14 Original deadline passes with a live selection. Expected: selection STALE `X2_ORIGINAL_BUSINESS_DEADLINE_EXPIRED`,
child BLOCKED, original Work unchanged.

N15 Protected originals. `checker.py`, `reference.py`, `transition.ts` full sha256 before and after equal the
recorded values (b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e,
fa267cb6f8d70c4f07271d7ceef68a7a68b4fad9dd792185d2bf6fd17bcbf84e,
b4047f30a064521c0979854f0d469f5f1acc1be064628e9a2273eb13620a9029).

N16 v2 byte stability. The public Z3 suite (`scripts/project-z/run-ci.mjs --phase=z3`) before and after the
change shows identical evidence digests (runs `w3-z3ci-before-1` / `w3-z3ci-after-1` exist; a new pair is run
after this change).

N17 Acquisition child allocation smaller than the real exploration. OBSERVED in run w3-gov-05 (not predicted):
the child allocation of 128 request units under the original 520-unit envelope was exhausted by a full
two-target, two-role exploration of the fake portal (17 portal dispatches plus their independent reads); the
last exploration step recorded `Z0_ORIGINAL_BUDGET_EXHAUSTED` with disposition UNKNOWN and the learner then
raised `X2_EXPLORATION_RECONCILIATION_REQUIRED` (session UNKNOWN, G01 FAIL). The refusal is the correct
owner behavior, so the fix is in the scenario input, not in the owner: the Z3 scenarios request a 480-unit
allocation (still inside the original remaining) and wait up to 20 minutes for MODEL_READY. The same failure
and sizing were found independently by the Z0 worker (run w0-native-05, commit c7c41ec on its branch); the Z3
scenarios pass the values as options and do not edit the Z0-owned fixture default.

N18 Parked governed child "makes no S5 debit". OBSERVED in run w3-gov-07 (G06 FAIL, `S5_S6_ROWS_CHANGED_BY_PARKED_CHILD`)
and confirmed from the retained database: before parking the child composes the canonical steps through governed
original reads (context, record and documentation reads at the portal), and the original reservation charges them
under phase COMPOSITION (13 units, no new reservation, no S6 effect row, no child request row, no selection).
Case C14/D4 premise "no S5 debit" was too strong; the guarded property is: no EXECUTION-phase or any
non-COMPOSITION charge, no `domain_actions` row, no child request/wire, no selection, reservation and episode
digests unchanged until the Z3 writer selects. The scenario asserts exactly that and records the per-phase charges.
The product behavior is not changed.

N19 Driver input rejected by the strict submit schema. OBSERVED in run w3-z3s-01: `viability-submit` with a `root`
field answered 400 `VIABILITY_SCHEMA_INVALID` (SubmitSchema is strict and selects only by Work and idempotency key).
Z04 FAIL was a driver defect, not product behavior. It also exposed a false PASS: Z02 accepted any status >= 400,
so the same schema refusal satisfied "refused before the governed child". Z02 now requires the typed 422
`VIABILITY_PREDICATE_UNPASSED` with a `Z3_*` predicate, so only a Z3 owner refusal can pass it.

N20 Self-deadlock of the original-owner binding for an APPLICATION_SNAPSHOT observer. OBSERVED in run w3-z3s-02
(Z04 FAIL: `viability-submit` 422 `VIABILITY_TRANSITION_NOT_CONFIRMED` after 15.9 s; the generic predicate means the
error was not a Z3NativeFault). The retained Postgres log shows two `canceling statement due to statement timeout`
errors on `insert into finnor_os.authority_decisions`, blocked in `pg_advisory_xact_lock('v3-material-cut:<tenant>')`
(the V3 statement fence on authority tables). Cause: the submit transaction already holds that lock (the S5 snapshot
`authorize` inserts an authority decision on the transaction client) and `applicationContext` then calls
`nativeApplicationProfile` for each profile (two, one per role); that function resolves the profile on its OWN pooled
connections and inserts an authority decision, which waits for the lock held by the caller until statement timeout.
Z3 maps without an application observer never reached this path. The same nested call exists in
`composeEnterpriseApplicationOperations`. Guarded property: no Z3 transaction waits on its own locks through a second
connection. Fix: the profiles are resolved BEFORE the Z3 transaction opens (separate connections, no lock held) and
`nativeApplicationProfile` returns that retained result inside the Z3 scope; an id that was not prefetched fails closed
with a typed fault instead of opening a nested connection. The retained-authority binding-digest, role, grant and
target checks still run inside the transaction on the prefetched profile. Residual risk: the profile is read up to one
transaction earlier than the checks that consume it; a revocation in that window is caught by the next fenced
boundary, not by this one.

## Scope limits recorded up front (not silently narrowed later)

- The map is a controlled recurring cycle over the first canonical steps of the portal composition
  (`api.draft`, `api.validate`) and loops back; only the first prefix is executed on the stack. The portal
  record does not return to its initial phase by itself, so a second period is a mapping falsification
  (`Z3_NATIVE_ACTUAL_SOURCE_STATE_CHANGED`), reported as such, never papered over.
- S8 admission is "unconfigured development" on the disposable stack unless a capability policy is installed
  (`S8_APPLICATION_UNCONFIGURED_DEVELOPMENT` event). The report states which one the run observed.
- Fairness assumptions: none (empty assumption set, unconditional); no renewal, no settlement bindings.
