# Connected release qualification

Governing source: V PRD revision 1.0, 10 October 2026, SHA-256
`2839fbdb5431ca5c6515c164215d73168b9d0f6c16d1e1affa59df416e982b79`.
Engineering base: `4a4c7b91074bca5b833897676546b8b6080a71da`,
PR #128. Applicable CI gates passed; that is not integrated acceptance.

## Frozen failure model before fixture changes

- Replacing the original tenant, principal, target, Opportunity, InvestmentCase,
  Deal, Work, input, objective, deadline, or finite counters breaks the chain.
- Reject missing, foreign, inactive, non-owner or stale-input continuations
  before scientific preparation. Recheck input and ownership after preparation.
- Recheck again after actor enrolment, allocation, approval and provider
  preparation, before returning a reusable financing request. Goal, input digest
  and original deadline must still match; spent counters may only increase.
  A change during preparation must fail rather than return a stale request.
- Never append a narrower Work instruction to obtain financing or closing.
- Primary acquisition must establish the additional USD5m and invalidate its
  actual underwriting descendants. A supplied number is not an acquisition.
- USD80m conditional debt plus USD40m indicative equity is not funding readiness.
- Concurrent material edits require conflict, rebase, recomputation and a fresh
  exact approval. No last-writer-wins financial state or reuse of old approvals.
- Lost draw acceptance stays UNKNOWN/RECONCILING until independently observed;
  duplicate delivery cannot mint another draw or release its exposure.
- Missing seller receipt, rights transfer or independently accepted legal
  conditions blocks close. An unauthorized waiver cannot remove that condition.
- Continuing duties survive close. Financing principal is never owner profit.
- Repeat refusal, unavailable primary evidence, financing withdrawal and
  unauthorized-waiver variants. Safe stopping is not business success.

## Execution and release order

1. Reuse shared S3/S4/S5 and V4 fixture owners with checked original identities.
   Typechecking a refactor is not execution evidence.
2. Register a fresh whole-mandate development campaign before V1, with original
   3,600-second, USD100, 900-human-second and 16-GiB episode ceilings. Keep
   narrower native limits, original source floors and all expired grants.
3. Execute PRD 8.1 over actual owner APIs/workers and independent test actors.
   Record exact source hashes, inputs, events, costs, limits and failed attempts.
4. Verify clean installed reconstruction, populated/in-flight upgrades,
   mounted multiuser control and the complete 504-clause acceptance ledger.
5. Independently review the final cut; repeat only affected checks after fixes.
   Run staging, backup/restore and release-recovery rehearsals before production.
6. Use the repository's existing authorized production-release workflow, not
   direct resource edits or a bypass of post-merge certification.

## Separate, non-fabricable gates

No development fixture supplies S8 admission, actual professional authority,
consented live activity or comparative economic qualification. PRD field gates
include V1's minimum 12-week observation and H2's 36-month outcome horizon.
These are external evidence requirements, not jobs that green CI completes.
Unadmitted profiles stay disabled in a software deployment. Actual live
financial activity requires complete current rights and authority profiles.

Current prerequisite observation: local free storage is below the unchanged
native campaign floors; the historical pinned scientific Python is absent.
Use a newly bounded isolated verification runtime, not peer-data cleanup or
renewal of earlier allocations. AWS authentication was renewed and the paid
plan was confirmed. No new verification resources have yet been provisioned.

## Financing draw boundary, not yet implemented

`capital-formation/store.ts:currentCapitalDraws` requires a native S6 obligation
whose financing binding, mandate, S5 consumption and compiled `financing_draw`
effect agree. The existing S6 origin producer prepares contingent interventions,
not financing draws. V3 instead compiles `execute_closing_operation` children and
stores their consumption in `pe_closing_node_links`. Neither path currently
produces the exact financing origin required by the V4 reader.

The connected campaign cannot seed that origin, rename an existing effect after
compilation, treat an indicative commitment as available funds, or weaken this
reader. A native adapter must bind the accepted current V4 commitment to the
original V3 funding requirement and S5 consumption before effect approval. It
must preserve the original effect hash and responsibility through unknown
delivery, revocation and reconciliation. Independent receiving settlement, not
dispatch success, remains the funding criterion.

Required end-to-end observations before accepting that adapter:

- Reject foreign Work, mandate, commitment, amount, currency, provider, terms,
  allocation or expired approval before dispatch.
- Conditional debt plus indicative equity leaves readiness false.
- Material edits or withdrawn commitments invalidate old approval and block new
  effects without erasing possible delivery or releasing its S5 responsibility.
- A lost accepted draw retains its original operation identity and exposure;
  recovery observes that operation without a second physical draw.
- Only exact independent settlement can advance the original funding
  requirement. Seller receipt, legal conditions and rights transfer still gate
  transaction close independently.

The shared fixture's final continuation guard typechecks, and `git diff --check`
passes. These checks do not establish any of the runtime observations above.

## Clean Linux reconstruction failures retained

- The first selected typecheck lacked root lockfile dependencies. Installing
  both root and `finnor-os` lockfiles resolved it; the selected typecheck and
  installed API build then passed.
- The subsequent runner stopped before database creation because its environment
  assignment converted an absent Linux `TMPDIR` to the literal `undefined`.
  Use the platform temporary-directory fallback before assigning the environment.
  Preserve the failed attempt and rerun the affected installed fixture, without
  replacing any previously started Work or business grant.
- Scientific reconstruction also exposed missing S3 dependencies and then the
  independent V4 oracle's undeclared `cryptography` dependency. Retain both
  attempts. Install the committed S3/S5 pins and declare the historical oracle
  pin `cryptography==44.0.3`; check imports and every exact pin before database
  initialisation in subsequent runs. This does not turn prior failures into
  passes or supply protected checker admission.

## Original-Work fixture regression, registered before its driver

Create fresh disposable identities, then accept one bounded Work and its
explicit, deliberately unfulfilled whole-goal criterion through the native
Objective owner before financing preparation. This is a fixture-continuation
proof, not a V1–V5 chain or actual economic completion.

- Positive: prepare S3/S4/S5 and independently signed financing inputs using
  exactly that Work and input. Compare every goal field, deadline and ceiling;
  input count stays one and spent counters do not decrease.
- Stale-input negative: an incorrect original input must fail before scientific
  preparation or actor enrolment.
- Cancellation negative: cancel a fresh original Work through its native owner;
  financing preparation must fail before scientific work.
- Late-input negative: append a distinct instruction through the native Work
  owner during independent provider preparation. The final continuation guard
  must reject the request. Keep the changed Work and failure as observed; do
  not reset its input, goal, counters or deadline to obtain a pass.
- Retain the owner records, exact rejection, boundary-entry counts and source
  hashes. Neither fixture preparation nor these refusals establishes funding,
  transaction close, protected admission or field economics.

## Scoped-alias fixture failure, before its correction

The installed regression reached ten passing predicates, then
`D_SCOPED_SOURCES_AND_CYCLES` timed out while expecting `ALIASED_COMMITMENT`.
The native checker keys alias identity by provider, instrument identity and
tranche. The fixture copied the first instrument identity onto a second
commitment but retained its distinct `secondary` tranche, while the first
commitment remained `principal`. Those are not the same alias slot.

Correct the independently signed negative input to duplicate the exact tranche
as well as instrument identity. Do not change the checker, amounts, capacities,
publication rules or original programme ceilings. Preserve the failed run and
rerun the affected boundary case, including its preceding distinct-tranche
positive observations. It remains a development fixture, not a qualified draw
or a protected capital-formation evaluation.

## Wide-publication storage failure, before implementation

After correcting the alias fixture, the affected rerun passed that phase and
reached the wide-condition case. Core Evidence correctly rejected the complete
publication because both content and snapshot have a 262,144-byte transaction
bound. Do not raise either Core bound or shorten the declared conditions,
amounts, independent checks or provenance to obtain a pass.

Use a V4-owned, versioned, lossless gzip storage envelope only for oversized
publications. Preserve the logical digest over the complete canonical
publication and separately verify the immutable stored-byte digest. Retain
inline publication compatibility. Bound decoded output to 8 MiB and the encoded
content and snapshot to the unchanged Core limit; this is not a business grant
or a relaxation of the campaign's existing evidence cap.

Failure model for this storage seam: corrupt bytes, wrong logical digest,
incorrect decoded length, noncanonical base64/JSON, unsupported encoding,
unknown envelope fields, excessive compressed/decoded bytes, decompression
bombs and silent truncation must fail closed. Small historical inline
publications must remain byte/digest compatible. Write isolated adversarial
codec checks before its implementation because immutable owner records cannot
legitimately be edited to inject corrupt bytes through the live owner API.

Extend the existing native wide-condition E2E to verify the whole round trip,
exact logical digest and both actual Core byte bounds. Preserve zero received
funding and incomplete readiness. Retain the original failed attempts and rebuild
the installed API for the changed, method-pinned product source.

## Missing-publication currentness, before implementation

Installed attempt 008 passed the wide owner-path proof with 1,089 conditions,
50,393 stored content bytes and 50,402 snapshot text bytes, zero received funds
and incomplete readiness. Attempt 009 retained fourteen passes before
`E_UNRESOLVED_COST_RECEIPT` failed while reading artifacts from a null publication.

Inspection shows `readCapitalFormation` initializes currentness to true and
does not clear it when no publication exists. Its consumer's changed-digest
predicate can therefore accept a null digest as a new current publication.
Absence must be explicitly noncurrent, without inventing a new publication,
altering programme grants or suppressing source invalidation.

Before the reader change, strengthen the existing native finality E2E:
after authenticated conflicting receipts invalidate the publication with the
worker stopped, require noncurrent/null publication data. Wait for an actual
nonnull new publication, and bind subsequent historical inspection to the
immutable evidence version and digest returned by that owner read. A later
source invalidation must not be presented as a still-current historical cut.
Retain unresolved cost, the one original POST and all original receipt facts.

## S7 delivery configuration, before fixture correction

Attempt 012 passed sixteen predicates, including original-Work preservation,
wide storage, cost finality and original recovery after stop. The S7 atomic
notice case then found no S6 delivery origins. The native delivery owner
explicitly returns `OWNER_TRANSPORT_UNCONFIGURED` without an enrolled route;
this fixture supplied no route but asserted two origins.

Enroll only the case's S7 owner using an independently keyed, signed
`DISPOSABLE_TEST_AUTHORITY` transport policy and mode-0600 temporary files.
Use an owned loopback endpoint that deliberately supplies no protected ledger
receipt. Require the same original rights reference, Work, budget and deadline.
Do not enable a protected/live route or treat a prepared delivery origin as an
actual ledger append, financial result or protected receipt. Preserve the
notice-refusal rollback, source/cost retention and two original delivery intents.

## Native financing adapter, implementation boundary

Use a genuinely compiled `financing_draw` action, not a renamed
`execute_closing_operation` effect. An optional strict capital reference in the
original accepted funding requirement selects this action; legacy requirements
retain their existing operation. Ground its binding from the exact immutable
V4 commitment receipt and a fresh independent current owner check. Preserve
tenant, original Work/input, mandate, provider, terms, currency, exact minor
units, original deadlines and all existing ceilings.

Create a typed S6 financing origin only from that actual compiled effect and
its native S5 consumption, in the original closing child's persistence
transaction. An origin is intent, not authority or receipt of funds. Preserve
native approval, qualified USD ceilings, independent V3 readiness, S5 egress
clearance and the original physical operation/deduplication/recovery machinery.
Do not weaken V4's exact binding reader.

The receiving-state adapter must consume the original independently signed
S6/V3 `SETTLED_DRAW` observation and verify the enrolled receiving issuer and
original operation binding. Never synthesize an externally signed V4 funding
event or treat acknowledgement, SQL persistence, availability or UNKNOWN as
settlement. Reconciliation must retain original exposure after cancellation,
rights loss, expiry or process death, without another POST or grant.

Failure cases: missing/foreign/stale/conditional/indicative/withdrawn capital;
wrong borrower/provider/terms/reference/units/amount; stale Work or full-goal
binding; exhausted or revoked authority; replaced compiled effect or S5
consumption; concurrent over-allocation; missing independent approval; duplicate
origin; source change before egress; acceptance followed by SIGKILL/UNKNOWN;
forged or partial receiving observations; and repayment or financing principal
misreported as owner profit. Verify through native owner/worker E2Es with
repeatable source/receipt artifacts. Protected/live admission remains a separate
gate, not something this adapter or its development fixtures can grant.
