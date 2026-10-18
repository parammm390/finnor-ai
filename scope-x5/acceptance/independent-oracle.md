# X5 independently authored development acceptance oracle, revision 1

## Status, authorship and non-substitution

This document was authored before X5 product implementation, from the declared
architecture/protocol and inspection of the actual X3 parent. Parent:
`c421182fc4f322824d49cd444bc8f89d95e39736`; intended branch:
`codex/frontier5-x5-experience-to-policy-compiler`. It specifies checks, not
observations: **all X5 execution, validation and acceptance are NOT_RUN**.
No build, dependency installation, product implementation or test was performed
to author it. Its only authored repository file is this document.

The author is separate from the product implementation workstream, not an
independent business owner, institutional custodian or protected evaluator.
Disposable login services, signing keys, SQL fixture administration, source,
oracle code and public cases remain builder-controlled. A real signature proves
use of that development credential, not protected independence. Freeze exact
bytes and digest of this oracle before product edits; register later executable
checks and all literal fixtures against it before running them. Do not regenerate
expected answers from observed output. A changed expectation requires a new
version, rationale and invalidated affected evidence, not a repaired PASS.

This is a bounded development supplement to `architecture.md`,
`failure-model.md` and `protocol.md`, not a redefinition of X5 or a reduction
of any original gate. Unknown full governing-source parity remains unknown.
DESIGNED, CODE_COMPLETE and E2E_DEV_VERIFIED are distinct; none implies
DOMAIN_QUALIFIED, protected S8 admission, production activation, programme
operational gain or financial qualification.

## 1. Actual parent facts that the X5 checks must respect

Inspected source under `finnor-os/`:

- `scripts/x3/business-fixtures.mts`: declarative exact reconciliation,
  threshold-dependent independent approvals and a different exception-register
  application; neither is an X5 training dataset or a training consent.
- `packages/private-equity/src/enterprise-applications/{service,store}.ts`:
  installed commands construct authenticated native context, resolve current
  authority/evidence, run the interpreter, persist record changes and append
  `BUSINESS_COMMAND` or `BUSINESS_COMMAND_REFUSED` in one transaction.
- `packages/private-equity/src/enterprise-applications/{program,exact}.ts`:
  bounded data-only native interpreter; exact decimal arithmetic; full quantity
  dimensions; current approvals; host-owned persistence/authority/effect fences.
- `packages/private-equity/src/enterprise-applications/checker.ts`: separate
  rational tree semantics and reverse translation check. This checks fidelity
  to a supplied specification, not whether its business method is acceptable.
- `packages/db/migrations/0189_x3_enterprise_applications.sql`: immutable
  append-only events/releases, tenant RLS, record/allocation monotonicity.
- `scripts/x3/{run-installed,envelope-check,environment}.mts` and
  `scripts/r1/http-fixture.mts`: signed-user real route/HTTP/SQL/physical-worker
  fixture, with explicit disposable Auth service and optional emitted Next API.

Read actual prior output, not just test names:
`/home/factory-user/x3-delivery/evidence/completion-cut-3/installed-2/independent-cases.json`
and `release-snapshots/2986d80c-2afc-4634-b8d0-bcef79fec724/345.json`
under the same directory. The latter contains 152 events, including 90 native
business-command/refusal events. A concrete lineage is events `12,13,14`:
create DRAFT, reconcile RECONCILED, approve APPROVED, with native concurrency
revisions `1,2,3` but content references `1,2,2`. Approval does not change
business content. Therefore equal record digests are not equal workflow states,
and content-reference revision is not the concurrency revision.

Important parent limitations, not assumptions to paper over:

1. The exported release-snapshot event projection selects `id,kind,body`, not
   `actor_id`. It alone cannot prove the command actor or complete acceptance.
   Fresh evidence must resolve actual SQL/API `actor_id`, tenant/application,
   record and timestamps, not infer identity from a memo or action name.
2. History API pages are newest-first, bounded, with `before` pagination.
   Record filtering excludes events with no record ID; early host refusals can
   roll back before any `BUSINESS_COMMAND_REFUSED`. Include observed HTTP
   refusals and relevant owner audit evidence honestly; do not invent native
   events for them or call one filtered page complete.
3. Event `bigserial` IDs and `created_at DEFAULT clock_timestamp()` are not
   commit timestamps. An ID/time cutoff alone does not exclude a transaction
   allocated before the cut but committed afterwards.
4. An X3 checker PASS proves the compiled specification is faithfully executed.
   A permissive specification can faithfully approve without reconciliation.
   X5 must independently enforce the original method, not trust that PASS.
5. Native `RECONCILED` and `APPROVED` are durable states, not effect execution.
   Application read permission and native approval are not train/reuse rights.

Prior X3 receipts provide parent-behavior context only. Their amounts, record
IDs, approvals, source refs and development key custody do not qualify as fresh
X5 experience or transfer proof.

## 2. Non-negotiable original contract and outcome predicate

The domain is `PE_FIRM_DELAYED_RECONCILIATION_V1` inside the installed typed
PE-firm application family. A successful assigned business task requires:

1. Authorized creation/observation of fresh native inputs.
2. An actual mandatory native reconciliation transition from the initial state
   using exact full-dimensional sums and all original guards.
3. A later current, correctly scoped, different-principal acceptance of that
   reconciled content, with all required approval roles and distinct principals.
4. An independently observed terminal native record and matching immutable
   event chain before the original assignment deadline, with no unauthorized
   mutation, stale dependency or unresolved effect violation.

For original release A1: DRAFT -> RECONCILED -> APPROVED; USD/INR; compliance
is additionally required at **inclusive** amount `100000` minor units. Partner
alone suffices below it. Keep all original exactness, evidence, authorization,
approval, lifecycle and effect floors. A signed request cannot supply a new
principal; approval is by another actual logged-in principal, never worker
impersonation or inherited training grants. One person holding both required
roles is not two principals. The author cannot approve their own record.

All quantities below are literal nonnegative integer minor-unit strings;
arithmetic is exact, with no Number/float conversion. Quantity equality also
requires exact currency, canonical entity reference, units, temporal mode/value
and accounting basis. No FX, unit, date or basis coercion. This fixture does
not restrict the installed parent's separate exact-decimal capabilities.
Use real owner-resolved source/version/digest refs and fresh scope-bound entity
refs, with fixture time `2026-03-07T00:00:00.000Z` unless explicitly varied.
Source statuses UNKNOWN/CONFLICTING are not zero or success. Stored-state
readback and currentness must remain separate.

Native refusal leaves stored content, state, approvals and effects unchanged;
diagnostic evaluated assignments are not persisted successful reconciliation.
Edits reset active approval/derived values and require fresh reconciliation.
Release/Work/source/grant/consent changes invalidate applicable use instead of
rewriting history. A later APPROVED-looking state cannot repair a missing
method or make an earlier stale/unauthorized event lawful.

The learned capsule may only select a guarded next step. Exact arithmetic,
fresh roles, current authority, CAS, approval receipts, obligations and effect
dispatch remain with their existing owners. No automatic independent approval
is permitted. PREPARED is at most intention; this campaign expects **zero
external dispatches and zero executed financial effects**.

## 3. Minimum real training lineage, fixed before training

Create at least eight distinct native A1 records E01-E08 through authenticated
HTTP. Do not seed terminal state, approval rows, reconciled values, success
receipts or experience labels in SQL. Fixture administration may create only
disposable tenants, principals, scoped roles and input sources. Every selected
positive record must have its own real create, successful reconcile and later
complete independent approval. Repeated principals are allowed but must be
reported in the dependence groups; eight approvals do not mean eight
independent institutions, humans or statistical units.

| Record | Currency | Final book lines | Final bank lines | Literal reconciled total | Required final approvers |
| --- | --- | --- | --- | --- | --- |
| E01 | USD | `1200,2300` | `3500` | `3500` | partner |
| E02 | INR | `41000,7000` | `48000` | `48000` | partner |
| E03 | USD | `99998,1` | `99999` | `99999` | partner |
| E04 | USD | `99999,1` | `100000` | `100000` | partner + compliance |
| E05 | INR | `100000,1` | `100001` | `100001` | partner + compliance |
| E06 | USD | `9007199254740994,3` | `9007199254740997` | `9007199254740997` | partner + compliance |
| E07 | INR | `700,600` | `1300` | `1300` | partner |
| E08 | USD | `19000,25000` | `44000` | `44000` | partner |

Mandatory observed nonpositive history within those same accepted lineages:

- E01: valid partner attempts approval while DRAFT: `INVALID_STATE`.
- E02: valid partner attempts analyst-only reconciliation: `ROLE_DENIED`.
- E03: start bank at `99998`; reconciliation refuses `AMOUNT_MISMATCH`,
  diagnostic delta `1`; analyst edits bank to the table value, reconciles and
  obtains a fresh partner approval. Preserve the refused preimage.
- E04: partner-only approval returns `APPROVAL_RECORDED`, remains RECONCILED;
  only a different compliance principal completes APPROVED.
- E05: give the partner actual current compliance membership too; their attempt
  to fill both approvals refuses `PRINCIPAL_SEPARATION_DENIED`; a different
  compliance principal subsequently completes the task.
- E06: give the author actual current partner membership; self approval refuses
  `SELF_APPROVAL_DENIED`; actual non-author approvers subsequently complete it.
- E07: delayed export begins with UNKNOWN quantity/status; reconciliation
  refuses `EVIDENCE_UNKNOWN`; a later analyst edit supplies the real current
  export and the table values before successful reconciliation/approval.
- E08: advance a pinned source version before reconciliation; refuse
  `SOURCE_STALE`; explicitly edit to owner-current source refs, then reconcile
  and independently approve.

Minimum census: eight distinct positive lineages, eight successful mandatory
reconciliations, eight complete independent acceptances, seven actual native
`BUSINESS_COMMAND_REFUSED` events above, one allowed-but-incomplete approval,
and genuine delayed-observation/correction events. These are minima, not a
license to discard other failures. Historical pre-action states are labeled
by what was lawful/known at that state, not by the later terminal outcome.
An eventual approved record does not make its earlier mismatch a positive
reconciliation sample. The prescribed failures must reach the native command
decision owner; a missing token, wrong tenant or expired application is not
substitute coverage.

Additionally submit at least six distinct nonpositive candidate lineages:
P01 poison below; P02 a genuinely approved record edited back to DRAFT before
selection; P03 a genuinely approved record with read permission but no training
consent; P04 a genuinely approved record whose acceptance is beyond the frozen
knowledge cut; P05 a fabricated/nonresolving acceptance reference; P06 a genuinely
approved record with consent expired or revoked before selection. Do not count
six variants of a caller-supplied PASS row. Retain rejection reasons and refs
where lawful, not positive samples from those records. Revocation-after-training
and late-commit races are separate mandatory checks in sections 4 and 9.

### P01: poisonous apparent success, reaching the actual X5 selector

Install a legal data-only native application whose supplied spec permits
initial-state approval, accepts a caller-provided total, and omits mandatory
reconciliation. Keep valid current evidence, scoped independent partner
authority, native Work/release binding and otherwise valid input. Use book
`199,1`, bank `199`, supplied total `200`. Actually create it, then obtain a
different principal's native approval without a reconciliation event.

Its native terminal state and its own spec checker can look successful. X5
must reject it as missing the original reconciliation method and exact
postcondition, **before any positive training**. Neither an approval receipt,
state name, critical requirement prose, matching spec digest nor checker PASS
can override this refusal. Compare structure/semantics against the independent
domain contract, not an action ID blacklist or the supplied acceptance cases.
Also reject an equivalent renamed permissive workflow. If a stronger native
owner refuses the poisonous spec, record that fact, but it does not exercise
the required X5 selector boundary; provide a lawful route to that selector
without bypassing native persistence or seeding a fake success.

## 4. History, rights, cut and partition oracle

Resolve the immutable installed spec/release, original Work/input digest, all
record events, current record, referenced sources, approvals and current owner
authority. Evidence must include SQL/API event actor IDs, body/digest, ordering,
preimages, both revision types, exact record/release binding and enumeration
bounds. Independently compare the lineage census with ordinary-role SQL reads
under tenant RLS. The oracle must not import an X5 selector's filtered records
as the complete universe.

For a selected record, resolve the whole bounded history through a stable
selection snapshot, not only successful action types or a final page. Resolve
application/Work/release invalidations that need not have record IDs. Exercise
a legal history crossing a small API page size, omission of one refusal, an
approved-then-edited record, and >64 events for one record. The last must refuse
or classify the record unsupported, not silently take a favorable 64-event
suffix. Missing/ambiguous history is not accepted experience.

At knowledge cut K, require events both known/committed in the chosen snapshot
and semantically dated no later than K. Deterministic race: hold an approval
transaction open after event allocation but before commit; freeze K and the
selection snapshot; commit later. The approval must not enter the K-positive
dataset despite its smaller ID/earlier created_at. Later correction or
revocation remains a current-use invalidation even when past selection was
legitimate. If historical commit visibility cannot be established, refuse that
historical selection; do not claim a timestamp filter implements it.

Consent is a separately owner-authorized, current durable record, with:
institution/tenant/application and semantic scope; train and derived-policy
reuse purposes; allowed destination/transfer scope; knowledge cut; expiry;
revocation behavior; owner identity and content/revision digest. A user who
may operate/read the application but cannot grant training rights must fail
at the consent owner. Test missing purpose, scope mismatch, future cut,
expiry, revoke-before-training, revoke-during-child and revoke-after-release.
Recheck on publish, evaluate, admit, current and use; lock/fence or reject
rights changing between decision and durable commit. A consent flag in a
request, old approval receipt or admin fixture read is insufficient.

Revocation blocks dependent use, evaluation/promotion and unsafe earlier
revision selection. Removing one row from a new dataset is **not unlearning**;
old learned checkpoints remain revoked unless a separately justified compliant
retraining/retirement policy applies. Preserve audit history without exposing
revoked private payloads through a portable artifact or stale UI response.

Training, calibration/development, transfer and retention manifests bind
institution, application spec/version, workflow structure, chronology and
shared-principal/source/dependence groups. F/R identifiers and values below
never become training samples. Training sees no evaluation expectations.
Public identities and reused local institution are disclosed, never described
as protected or population-independent transfer.

## 5. Data-only policy and real CPU controller oracle

Portable learned state contains bounded structural booleans only. Current
host-derived facts can represent knownness/status, full-dimensional agreement,
exact equality, current observations, pending effects and workflow stage.
Business quantities/text, tenant/record/source IDs, credentials, old grants,
evaluation labels and original transcript bytes do not enter features,
numeric parameters, class names or portable executable instructions.
Authorized provenance refs may be stored separately, scoped and revocable;
they are not portable lookup tables for decisions.

Reject unknown instructions, executable strings/modules, paths, URLs or
unbounded nesting. Loading a capsule cannot eval/import guest code, open files,
spawn children, acquire credentials or dispatch effects. Legitimate physical
training uses only fixed trusted modules outside the data-only capsule.
Procedure must expose observation requirements, operation signatures, guards,
postconditions, explicit wait/block/stop, failure monitoring, dependencies and
the original Work allocation. Check these against the original method.

The neural component must actually be a CPU multinomial linear softmax
controller, <=8 features and <=4 classes, bounded as declared. Freeze feature
order, class/disposition meaning, numeric precision, original seed/weights,
training sample ordering, loss, gradient rule, regularization, learning rate,
iteration count and tie-breaking **before scored evaluation**. Do not fit to
F/R outcomes. Class names need not match this document; their observed semantic
actions must distinguish lawful reconciliation, waiting/blocking, requesting
independent approval and terminal stopping. A request is not an approval.

Independently recompute `z_c = b_c + sum_j W_cj*x_j` and stable
`p_c = exp(z_c-max(z))/sum_k exp(z_k-max(z))` from retained safe arrays. Check
probabilities are finite, sum to 1 within `1e-10`, and selected class follows
the frozen rule. Reproduce at least one full-batch gradient update and final
parameters from original checkpoint, exact selected samples and frozen config
with a separate small reference calculation, not the candidate trainer.
Allow `1e-8` relative / `1e-10` absolute numerical tolerance for recomputation;
checkpoint byte/digest identity itself remains exact.

Require real nonzero parameter change, bounded training attempt, actual
separate physical child PID/exit/resource receipt, safe immutable JSON old/new
checkpoints, save/load and inference in fresh processes. A lower loss, renamed
file, changed digest, canned class output or model-adapter mock is not proof.
For at least one fresh supported assignment, new versus original parameters
must change the actual dispatched/waited action and resulting timely business
completion under fixed surroundings. Otherwise parameter benefit is NO_GAIN
or UNPROVEN and the parameter-behavior requirement is not met, even if a
procedural fallback completes every task. Do not cripple original weights
after seeing results to manufacture that difference.

Structural booleans deliberately throw away business detail. Therefore every
dispatch is rechecked by the full native semantic contract. A softmax output
cannot waive an extra fresh guard, current authority, mandatory reconciliation,
pending effect, distinct principal or original deadline. Two native states
with the same features but different extra consistency semantics must not be
treated as equally authorized actions.

## 6. Fresh differently structured binding and literal transfer outcomes

Create a new installed application B1, not a reused A1 record/release or the
old exception register. It has fresh application/entity/field/action/screen/
canonical-role names and current grants to fresh principals.

- Entity `settlementLot`, states `AWAITING_FEEDS -> TIED_OUT -> ATTESTED`
  (optional subsequent `PACKAGED` is not task completion).
- `openLot` creates initial state; `attachExport` is an additional initial-state
  update edge that clears derived values/approvals; `tieOut` reconciles;
  `attest` independently approves. Include a current third custody source.
- Reorder declaration arrays and input fields. Use `ledgerSlices`,
  `exportSlices`, `tiedTotal`, `tieDelta`, `feedCertified`, and fresh evidence/
  status fields. Express equality with reversed operands and nested boolean
  guards. Require `feedCertified === true` and all three sources current in
  BOTH reconciliation and approval; this additional condition is not optional.
- Fresh canonical roles `x5_ledger_operator`, `x5_finance_attestor`,
  `x5_risk_signer`; none authorizes by an old A1 role/receipt.
- Exact primary total is the ledger sum; delta is ledger minus export.
  Native success outcomes are `TIED_OUT`, then `ATTESTATION_PENDING` if an
  approval is missing, and finally `ATTESTED`. B1's inclusive risk-signoff
  threshold is `50000`, a stricter fresh rule, not a learned old threshold.

This is more than renaming: extra update edge, extra current source, additional
mandatory predicate and different threshold. Declare this transfer structure
before evaluation; bind it from the actual specification, not case IDs or a
test-only fixture adapter. Generic native guards may enforce fresh conditions;
do not claim the neural component learned the new business predicate.

All supported cases below start with valid dimensions, `feedCertified=true`,
current custody evidence and current fresh authority. Entries F09-F12 begin
with UNKNOWN export/status; actual signed `attachExport` later supplies the
listed values and current refs without changing the original deadline.

| Case | Currency | Ledger lines | Export lines | Literal tied total | Final fresh signers |
| --- | --- | --- | --- | --- | --- |
| F01 | USD | `3100,4900` | `8000` | `8000` | finance |
| F02 | INR | `16000,14000` | `30000` | `30000` | finance |
| F03 | USD | `49998,1` | `49999` | `49999` | finance |
| F04 | USD | `49999,1` | `50000` | `50000` | finance + risk |
| F05 | INR | `50000,1` | `50001` | `50001` | finance + risk |
| F06 | USD | `9007199254741000,9` | `9007199254741009` | `9007199254741009` | finance + risk |
| F07 | INR | `80000,120000` | `200000` | `200000` | finance + risk |
| F08 | USD | `0,0` | `0` | `0` | finance |
| F09 | USD | `6000,1250` | `7250` | `7250` | finance |
| F10 | INR | `21000,2000` | `23000` | `23000` | finance |
| F11 | USD | `48000,6000` | `54000` | `54000` | finance + risk |
| F12 | INR | `70000,30000` | `100000` | `100000` | finance + risk |
| F13 | USD | `1,999` | `1000` | `1000` | finance |
| F14 | INR | `15000,25000,9999` | `49999` | `49999` | finance |
| F15 | USD | `20000,20000,10000` | `50000` | `50000` | finance + risk |
| F16 | INR | `10000000000000000000000000,7` | `10000000000000000000000007` | `10000000000000000000000007` | finance + risk |

Literal success for each: native TIED_OUT event precedes complete ATTESTED
event, total equals its table string, delta `0`, actual signer count/roles match
the table, no signer is the author, required signers are distinct/current,
three pinned source refs are current and unchanged except explicit delayed
updates, zero prepared/executed effects. Pending first approval on high cases
is not completion. Distinct readback/events must confirm the final state.

F09-F12 must show a real initial WAIT/BLOCK with zero reconciliation/approval
mutations while the export is unknown, then resume only after actual owner
observation. A WAIT flag attached to an already-mutated record is a failure.
Release the external observations on the same preregistered schedule relative
to arm start, not in response to which checkpoint appears to be winning.

At least eight F cases must execute the compiled controller's guarded native
reconciliation path rather than all being delegated to a complete native
fallback. At least one must establish the parameter-dependent task difference
in section 5. All-fallback success is a safe interpreter integration but does
not establish learned compiled transfer or parameter-dependent behavior.

## 7. Changed consistency, negative strata and retention literals

Register eight additional assigned boundary strata, not post-result exclusions:

| Case | Actual native input/intervention | Literal allowed result |
| --- | --- | --- |
| C01 | New B2 spec additionally requires exact `sum(controlSlices)==sum(exportSlices)`; ledger `4100,900`, export `5000`, control `4999`; all else valid/current | no successful tie-out/attestation; explicit unsupported BLOCK/WAIT or actual native fallback refusal `CONTROL_TOTAL_MISMATCH`; initial state, no approvals |
| C02 | Same B2 semantics; ledger `4100,900`, export `5000`, control `5000` | actual native exact fallback succeeds tie-out then fresh finance approval, total `5000`, delta `0`, final ATTESTED |
| N01 | B1 ledger `12345,5`, export `12349` | tie-out refuses `AMOUNT_MISMATCH`; diagnostic delta `1`; stored initial state, no approvals/derived success |
| N02 | B1 ledger total `8000` USD, export `8000` INR | native `CURRENCY_MISMATCH` or pre-dispatch dimension block; no mutation |
| N03 | B1 totals `8000`, export AS_OF is `2026-03-08T00:00:00.000Z` | native `TIME_MISMATCH` or pre-dispatch dimension block; no mutation |
| N04 | B1 tied total `8000`; publish custody source v2 before signed approval using pinned v1 | `SOURCE_STALE`/currentness block; remains TIED_OUT, no accepted new approval |
| N05 | B1 tied total `8000`; author has real finance membership and tries to attest | native `SELF_APPROVAL_DENIED`; remains TIED_OUT with no approval |
| N06 | B1 record has a genuine canonical pending S6 preparation/UNKNOWN obligation | native pending-effect fence, no new command mutation/dispatch; exact obligation and effect identity retained |

C02 deliberately requires a **real** fallback, not a summary field. Its receipt
must identify a currently installed native method/release, actual invocation,
current authenticated binding and durable native events. For C01, either real
fallback refusal or explicit non-mutating unsupported disposition is safe;
never silently drop the third-list condition. An implementation that truly
generalizes B2 may separately demonstrate it, but that is not substitute proof
for the mandatory real-fallback path; retain C02's forced-safe native route.

Additional required owner-boundary probes outside these eight: units, entity
reference and accounting-basis mismatches; `feedCertified=false`; conflicting
status; stale expected concurrency revision/reference; removed actor scope;
revoked/expired prior approver; same principal filling finance/risk; role
membership changed after inference but before commit. Reach the intended owner
with all unrelated preconditions satisfied and show zero unlawful persistence.
For entity scope mismatch, an earlier native host rejection is the correct
owner boundary and must not be mislabeled a model/guard success.

Retention uses eight new A1 records, never E/F records, under original threshold
`100000` and original source/application rules:

| Case | Currency | Book lines | Bank total | Required final approvers |
| --- | --- | --- | --- | --- |
| R01 | USD | `1400,2600` | `4000` | partner |
| R02 | INR | `30000,69999` | `99999` | partner |
| R03 | USD | `60000,40000` | `100000` | partner + compliance |
| R04 | INR | `100000,9` | `100009` | partner + compliance |
| R05 | USD | `9007199254741010,1` | `9007199254741011` | partner + compliance |
| R06 | USD | `45,55` | `100` | partner |
| R07 | INR | `12345,54321` | `66666` | partner |
| R08 | USD | `0,1` | `1` | partner |

R06 begins with an actual delayed UNKNOWN export, R07 with an outdated source;
after observed safe wait, lawful explicit correction supplies the table inputs.
For each, expected final APPROVED, exact table total, delta `0`, original
required current distinct non-author approvers, and zero effects. No B1
threshold/role transfer may weaken or silently replace A1 rules.

## 8. Independent evaluation and parameter attribution

Freeze candidate source/runtime/schema/procedure, old/new checkpoint bytes,
consent/experience/partition and this oracle digests before scoring. Use
four arms: `COMPILED_ORIGINAL`, `COMPILED_TRAINED`, `NATIVE_EXACT` and
`COMPILED_NO_NEURAL`. The exact native lawful interpreter is the strongest
available local task baseline; untrained softmax is only a parameter ablation.
Disable neural inference in the fourth arm without changing its procedure,
tools, authority or native safety checks; record its explicit dispatch/wait/
fallback policy. Do not force it to lose to manufacture a neural claim.

For each F/R/C/N assignment create four equivalent pre-action native replicas.
IDs may differ because side effects cannot be undone, but literal values,
binding semantics, principal grants, source versions/currentness, observations,
native method/source/runtime, available tools/context, Work bounds and remaining
allocation must match. No cross-arm mutated-state reuse. Alternate old/new
execution order. Record the exact equivalence projection, preparation costs,
arm order, timestamps and loaded model identity. Safety-relevant source/grant
interventions are replayed per arm. All replays retain their actual costs.

Only original/new parameters may differ between the two compiled arms:
same procedure bytes, feature extractor, input/binding semantics, API/native
tools, authority, provider configuration/context, decision budget, timing
schedule and native fallback rules. No changed prompt, fallback threshold,
extra observation, provider call, additional retry or candidate repair may be
credited to the weights. Loaded process receipt, not just database metadata,
must bind the procedure and checkpoint actually used at each decision.

The evaluation owner accepts an assignment identity and immutable refs, not
caller-supplied booleans, aggregate PASS/failure counts, final amount, grade,
receipt body or expected result. It independently enumerates assignments and
reads real events, records, owner currentness, queue/process/load receipts and
original deadlines. Recompute exact expected arithmetic independently, without
importing product compiler/trainer/checker arithmetic; table literals above
remain the ultimate expected values. A supplied native receipt ref is resolved
and verified, not treated as its asserted content.

Mandatory evaluator anti-forgery checks:

- Submit all-pass rows/grades with no native executions: cannot produce a
  successful evaluation or admission, regardless of their signature by the
  proposer. Reject extra caller grade fields or ignore them and still find
  the actual missing task evidence.
- Supply another assignment/tenant/release's real successful ref, an
  APPROVED-looking P01 ref, a missing reconciliation ref, wrong loaded weights
  or a withheld failed assignment: cannot satisfy the matching assignment.
- Freeze a census then omit, duplicate or replace a failed case: evaluation
  refuses/incomplete; failure remains in its originally assigned denominator.
- Mutate one literal expectation or the evaluator source after its digest is
  frozen: old evaluation/admission proof no longer validates.

Finite development disposition requires trained completion of all 16 supported
F tasks and all eight R tasks with every original critical floor, correct
outcomes for all eight C/N strata, and zero safety violations across all arms.
Report every arm's completion, waits, refusals, fallback, deadline failures,
latency and costs per stratum and overall. One lost supported case in 16 is
below the declared 95% target; do not round it to a pass. Any critical loss
blocks promotion irrespective of aggregate gain. Require at least one
original-fail/trained-pass supported task due to parameters, no hidden
trained critical regression, and report no-gain honestly. This small deterministic
campaign demonstrates neither a confidence-supported population endpoint nor
superiority to the native baseline.

The frozen eligible diagnostic demand is 32 assigned business scenarios:
16 F + 8 R + 8 C/N, each with four observed arms (128 physical arm executions).
Report paired F/R results separately from intended-safe negative outcomes;
safe refusal is not supported-task completion. Ancillary fault/poison/rights
probes and failed/repeated campaigns are additional visible lifecycle work,
not new favorable demand or denominator replacements. Include preparation,
training, storage, evaluation, fallback, repair, retries and human rescue.
Unknown money, labor, provider reasoning or simultaneous peak memory stays
UNKNOWN. Zero observed provider calls is not 10x less reasoning.

## 9. Harm, revocation, admission and restart checks

Use the existing typed signed S8 lifecycle, not a private admission flag.
Development proposer and evaluator identities must differ and have current
owner-scoped authority; neither creates protected custody. Training completion
cannot self-admit. Wrong artifact kind, incomplete proof, substituted checkpoint,
expired evaluator, identical proposer/evaluator, changed Work/source/rights/
partition/runtime and a revoked experience dependency all refuse at their
actual owners with no accepted current policy.

Create a deliberate harmful candidate as a separately labeled, immutable
negative revision; do not edit the frozen successful candidate in place.
Demonstrate an actual observable defect, such as bypassing reconciliation/
extra fresh guard, or waiting past the original deadline on a supported
retention task. Its expected failure must be observed through fresh native
execution or trustworthy non-mutation/deadline evidence, not supplied by a
client's `harmful=true` or evaluation rows. The evaluator must withhold/reject
admission. A guard-caught unsafe proposal that causes no task loss is evidence
of the guard, not a demonstrated business regression.

After genuine development admission, revoke consent/authority or change a
dependency and prove: current/use deny; mounted Work reflects stale/revoked;
no new native mutation; old checkpoint bytes/history still auditable under
current permissions; no resurrection through cold API/worker restart.
An earlier revision may be selected only if its own dependencies, consents,
runtime/method and original resources are still compatible/current. Deliberately
revoke a dependency shared by both revisions: both must refuse, not roll back
around the revocation.

Kill/restart at each important boundary: child writing checkpoint, between
child completion and publication, during evaluation, after durable native
reconciliation but before response, during WAIT, and after admission/revocation.
Observe actual jobs, delivery claims/fences, processes and SQL before retry.
No partial checkpoint becomes current. Stale/duplicate delivery cannot publish
over a successor. Cancellation kills/fences remaining descendants; a late child
cannot release a policy. Two competing Works remain scope-isolated.

For response loss after committed reconciliation, reuse the original logical
invocation/idempotency identity; exactly one native reconciliation mutation
exists. Resume an old call only with its original exact policy/checkpoint/
binding/deadline or abort it explicitly. Publishing new parameters while the
old call waits must not silently change that call's method.

Original compilation allocation is immutable/cumulative across failed attempts,
fallback, evaluation, cancellation, replacement and restart: <=8 training
attempts, <=256 uses, 3600 seconds elapsed and <=16 MiB retained payload.
Child <=30 seconds, 256 MiB V8 heap, 64 KiB logs, 4 MiB IPC; <=256 accepted
records, <=4096 structural samples, <=64 history events/record, one child at
a time under the canonical compute lease. Exercise exhaustion exactly at and
past each boundary. Heap size is not total RSS or an OS sandbox: retain actual
CPU/wall/RSS observations where available, bound output/process lifetime and
document unavailable containment/money measurements. No limit resets on restart.

## 10. Defect-to-observable-assertion map

Each check must retain its contract, credible defect, owning boundary,
preconditions, why prior X3 checks are insufficient, exact inputs, actual
observations and rerun recipe. These are required falsifiers, not test names:

| Credible defect | Primary boundary and why X3 alone misses it | Observable assertion |
| --- | --- | --- |
| Treat native approval/spec checker PASS as valid learning | X5 accepted-experience selector; X3 proves spec fidelity, not original business adequacy | P01 has real apparent approval but zero positive training lineage |
| Label all prior states successful after eventual approval | history-to-sample projection; X3 does not train | E03/E07/E08 refusals/preimages retained; no positive reconcile sample for invalid state |
| Drop refusals or use only latest page | history owner/selector; old snapshot lacks actors and may be bounded | ordinary SQL census equals enumerated refs; omitted/refused/overflow histories cannot become complete positives |
| Admit pre-cut ID committed after cut | selection snapshot/cut owner; bigserial/time is not commit order | held-open approval is absent from K-positive selection |
| Read permission masquerades as train/reuse consent | consent owner/publication/use; native command rights are different | P03/P06 and scope/purpose races refuse; no published/useable dependent checkpoint |
| Memorize amounts/IDs or leak private text | child input, capsule loader, feature boundary; X3 does not define portability | inspect retained safe inputs/assets; F01-F16 run without source-history lookup/old grants |
| Cosmetic training or loss-only evidence | compute child/save/load/consumer; X3 has no controller | independently reproduced numeric update and actual fixed-surroundings old/new task difference |
| Extra fresh condition dropped by feature compression | fresh binding/native guard; Boolean feature equality is incomplete semantics | feedCertified=false/C01 cannot reconcile/approve; C02 real fallback preserves added check |
| Fake WAIT/fallback summary | native command/observation owner; metadata is not execution | F09-F12 have no premature mutation; C02 has actual native fallback events |
| Float totals or dimension coercion | native exact interpreter/host | F06/F16/R05 exact strings; N01 delta 1; dimension probes make no mutation |
| Self/dual-role/stale approver accepted | authentication/authority/native approval commit | E05/E06/N05 and expiry-after-decision refuse, no accepted receipt |
| Evaluation accepts favorable submitted rows | evaluation owner/S8; X3 has no X5 outcome census | all-pass rows without native tasks yield no success/admission; omitted failed case remains failed/incomplete |
| New checkpoint metadata, old process weights | consumer load boundary | recomputed actual loaded digest/class/action match; substitution refuses before use |
| Partial release/stale delivery wins | durable worker/publication owner | interruption leaves no current partial policy; duplicate/fenced child cannot overwrite successor |
| Revoke then recover old capability | P7/S8/current/native use | both dependent revisions refuse through cold restart; history intact |
| New weights resume old pending call | logical invocation/recovery owner | old exact checkpoint retained or call aborts; no identity substitution |
| Duplicate uncertain effect or refreshed allocation | S6/S5/native host | original obligation/UNKNOWN identity and counters survive; zero extra dispatch or replenishment |
| Hidden repair/pruning creates gain | evaluation/accounting owner | immutable census includes every failed arm/campaign and complete visible lifecycle costs |
| Late response resurrects private policy | maintained Work/auth scope epoch | selection/root/principal/token/logout changes clear private state; delayed success AND error cannot restore it |

Drive actual mounted accessible Work controls for submission, evidence inspection,
training/evaluation, fresh use, wait/fallback, admission/revocation and recovery.
Reload, automatic token refresh, logout/fresh login, delayed network response and
scope switches must preserve logical invocation identity without private-state
resurrection. UI-only screenshots or direct service calls do not replace the
signed emitted API -> queue -> physical worker/child -> SQL -> native command
-> separate-principal approval -> ordinary readback chain.

Final installed evidence must bind emitted API/worker/training/evaluator/consumer
assets, migration upgrade/replay/in-flight behavior, generated contracts,
backend/frontend checks and standalone source/lock/checkpoint reconstruction.
No hidden donor directory, builder-only trainer or stale source manifest may
be required. These are planned checks, not claims that any command has run.

## 11. High-confidence design risks to resolve before calling X5 verified

1. **Original-method anchoring:** native approval plus a faithful supplied spec
   does not establish reconciliation. Define and verify a semantic original-
   contract anchor independent of applicant labels, names and acceptance cases.
2. **Historical visibility/completeness:** current X3 snapshot exports omit
   actors; ID/time cuts are not commit cuts; some denials have no durable record
   event. Add an honest bounded resolution contract without asserting evidence
   the parent never stored. Refuse unresolvable historical positives.
3. **Transfer versus delegation:** eight booleans/finite controller can safely
   choose readiness, not invent new business semantics. Preserve full native
   guards and show nontrivial compiled fresh-binding behavior; all-fallback or
   renamed A1 is not the declared transfer/parameter proof.
4. **Causal parameter evidence:** lower loss/new hashes can coexist with all
   real behavior coming from hard-coded guards. Fix surroundings and observe
   actual actions/completion, while disclosing that a simple exact baseline
   may equal or outperform this controller.
5. **Consent and revocation races:** native grants do not confer training
   rights, and row removal does not unlearn. Bind explicit rights to every
   learned descendant and fence decision-to-commit invalidation.
6. **Evaluation self-attestation:** a builder-controlled evaluator can be
   independently implemented but is still not protected custody. Reject
   supplied pass rows, enumerate actual assignments and keep promotion
   authority separate. Label developer credentials accurately.
7. **Resource/identity continuity:** checkpoint publication, load identity,
   pending calls, original counters and effect obligations must survive
   physical restart together. A V8 heap cap alone is not memory containment.

### Recommended strongest-boundary proof

Run one sealed end-to-end emitted-runtime campaign with real signed disposable
users and ordinary SQL roles: create E01-E08 including their actual refusals,
separate-principal approvals and explicit owner consent; resolve complete
committed native histories; submit P01 and prove selector exclusion; submit
the original Work through the canonical durable queue; observe the real bounded
CPU child, immutable original/new checkpoints and actual loaded identities;
run frozen four-arm F/R/C/N assignments on fresh B1/B2/A1 records; obtain
real fresh independent approvals; independently read exact native outcomes;
try supplied PASS rows and harmful revision admission; revoke a shared
training dependency, cold-restart and prove current/use and rollback deny
without replenishment or effect replay. Hash-bind source, oracle, inputs,
partitions, consents, process/queue/delivery identities, every failed attempt
and raw readbacks. This is the strongest available **development** proof.

Protected qualification remains unchanged and NOT_RUN: three independently
controlled sequences, ten successive cycles each, >=1000 paired fresh
assignments per sequence, >=95% supported completion, simultaneous 95%
retention-change lower bound >=-0.02 with every original critical floor,
three prespecified material promotions per sequence, and the preregistered
confidence-supported 3x failure-risk or 10x complete-cost parameter endpoint
with positive old lower bound. Separately require 10x less metered frontier
reasoning and lower complete lifecycle cost over frozen eligible demand/horizon.
No endpoint switching after results.

All original scientific/correctness/regret/forecast/financial/resource/
authority/exposure/reach/novelty/operational/S7 attribution floors remain.
B_V, qualified equipped B_ref, 30 institution/period blocks, all five engine-off
ablations, 90-day operation, 36-month mature economics and the separate $100m
owner-value objective require their original external inputs and custody.
Finite public oracle success cannot supply or waive them.
