# Independent primary-evidence checker — acceptance contract

Frozen before `checker.mts` implementation. Governing sources are the V PRD
revision 1.0 §2/§4/§9, the frozen failure model and verification plan. This is
ordinary development checking, not protected admission, permission, an audit
opinion or a claim of live/domain/economic qualification.

## Process and exact frame

Run Node 22 with `--max-old-space-size=128 --import=tsx` and the absolute
`checker.mts` path. Send one UTF-8 JSON object, then close stdin. There are no
exports, network clients, credential/environment reads or producer imports.
The sole stdout line is one JSON result:

```
{
  assertion: DiligenceAssertion,
  assertionRef: VReference,
  semantics: PrimaryReferenceSemantics,
  observations: PrimaryObservation[],
  proposed: PrimaryReconciliation,
  startingEvidenceDigest: string,
  knowledgeCut: string,
  checkedAt: string,
  currentBindings: {
    sourceProfileRefs: VReference[],
    consentRefs: VReference[],
    authorityRef: VReference,
    semanticsRef: VReference
  }
}
```

Success is `{ok:true,data:PrimaryClaimCheck,usage:{cpuMicros,peakRSSBytes}}`.
Malformed/unsafe input, integrity/authentication failure and exhausted bounds
return `{ok:false,predicate,message,usage}` and exit status 1. Valid but
insufficient evidence returns a check with UNRESOLVED, never a fabricated value.
A proposed reconciliation that differs from the independent result returns
`result:REJECT`; its independent conclusion and reconciliation remain visible.

Limits: 8 MiB input, 128 observations, 128 requested assertion references,
1,024 records per observation, 16,384 records overall, nesting depth 32,
384 decimal digits in intermediate rational integers, 96 in emitted integers,
10 seconds waiting for stdin and 5 seconds synchronous checking. Unknown object
properties, prototype-mutating keys, duplicate JSON object keys, unsafe integer
numbers, unpaired UTF-16 surrogates and invalid UTF-8 are rejected. CPU and
process peak RSS are actual child measurements; the parent must retain them,
enforce an outer process timeout/resource limit and charge failed checks too.
Generated field witnesses are bounded to 4 MiB, reason/exclusion metadata to
1 MiB, each reason/exclusion list to 32,768 entries, and the stdout frame to
8 MiB. Exceeding these limits fails closed rather than dropping evidence.

## Canonical bytes and trust boundary

Canonical JSON recursively sorts object keys by JavaScript code-unit order,
preserves array order and uses JSON string/number serialization. SHA-256 is
lowercase hex. No undefined/nonfinite/unsafe numeric values are admitted.
Signature verification is Ed25519 over canonical response **body** bytes;
`rawDigest` hashes the entire `{body,signature}` object. The actual request hash
is independently recomputed, not taken from the response's claim.

Assertion/profile/consent/authority/semantics references bind their object ID,
decimal revision and canonical object digest. An observation source reference
binds `observationId`, response `sourceRevision` and `rawDigest`. Reference owner
names are opaque owner namespaces and must agree with the authenticated refs
supplied by the parent. Checker identity binds actual checker and specification
file bytes, not a producer-supplied version.

The parent independently reloads original permitted canonical observations,
not producer rows. It authenticates the frozen assertion, starting manifest,
knowledge cut and checked-at clock and resolves current S1/S6 owner references.
The child proves content/binding consistency; it cannot authenticate an issuer
of governance, recompute an absent starting manifest, resolve undisclosed
revocation, prove that the parent included every assigned acquisition, or
validate missing mandate/grant/contact-count/reservation/disclosure ledgers.
Those remain mandatory parent-owner fences, not checker-issued permission.
Current bindings must equal each observation's actual governance payloads and
request refs. Revoked/revised profiles cannot be represented as current.
Payloads must consistently use DEVELOPMENT or LIVE across semantics, source,
consent and authority. LIVE content uses the same exact replay contract. Before
acquisition and publication the parent separately verifies the source-specific
signed transport admission and current activity, consent and fixed-read budget.
The credential-free child does not issue transport, financial-domain, audit or
economic admission. A LIVE source cannot promote an engineering verification
grade or authorize a financial intervention.

## Independent conjuncts

* Assertion entity, exact record/population identities, period/cutoff, field,
  unit/currency/scale/sign, basis and interpretation profile are frozen. One
  unique field rule must match. Profile gross/net, recognition, calendar and
  consolidation meanings must agree. No accounting/legal default is inferred.
* Actual acquisition and instruction-ineligible flags are exact literals.
  Source payloads must match issuer/system/control/class, independently
  resolved channel, respondent identity/role/knowledge and the exact request.
  External authoritative, direct respondent, target and computation classes
  map respectively to EXTERNAL_ISSUER, EXTERNAL_RESPONDENT, TARGET and
  COMPUTATION. A derived computation cannot establish primary acquisition.
  Target records retain their class. Unqualified intermediaries fail closed.
* Consent and source scopes include actual actor, entity, accounts, product,
  purpose, fields and requested history. Source rights match consent rights.
  Authority ACCESS_RECORDS and, for a confirmation, CONTACT bindings include
  the actual actor/channel. Suppression and zero contact allowance fail closed.
  INTERPRET and professional actor requirements are checked independently.
  Authority/consent/source/semantics are valid at request and check time; raw
  and derivative retention must still permit the check. Confidential/tax/
  benefits interpretation requires an actual professional review reference;
  there is no inference of personal-record rights. The executable authority
  class tokens are `TAX`, `BENEFITS`, `PERSONAL_RECORDS`; the last additionally
  requires `PERSONAL_RECORDS_PERMITTED` in both authority confidentiality rules
  and consent disclosure rules. The owner must actually qualify those tokens.
* Every request names the frozen assertion and exact semantic ref, population
  revision, required members, exact record IDs, period/cutoff and knowledge cut.
  Request time is not before the knowledge cut. Response observation is between
  request and retrieval; retrieval is not after checking. Signature is only
  issuer authentication, not truth or completeness. All observations bind the
  same tenant, programme, mandate and grant; the parent authenticates those
  programme bindings against the real owner state.
* NONRESPONSE, UNAVAILABLE_HISTORY, EMPTY_ACCESSIBLE_SUBSET, UNKNOWN and
  suspicious/missing-reason responses remain explicit gaps. NO_RECORD is
  useful only with complete relevant coverage. Failed observations are not
  silently discarded. Incompatible raw identities/semantics remain unresolved.
* Complete population coverage requires all registered members, required kinds
  and history, identical source/population revision within each source page
  stream, complete-member and complete-population witnesses, no missing reasons,
  and a contiguous page chain. Page IDs are `1..N` or `page-1..page-N`;
  `nextCursor` equals the next page ID, last cursor is null. Byte-equivalent
  repeated pages count once; conflicting repeats are unresolved. At least one
  complete registered stream must cover each member; every supplied stream
  must finish. Connectivity or an empty subset is never company coverage.
  Sampling/extrapolation and interval estimation are unsupported, even if a
  measurement-design reference is present: no executable design/bounds are
  supplied by this schema.
* Raw field values have independently built JSON-pointer witnesses. Required
  rule witness fields must be nonempty source-issued strings. Exact record
  predicates require every requested economic identity. Population totals and
  absence additionally require complete coverage; partial sums remain UNKNOWN.
  Required-complete record predicates retain that extra coverage obligation.
  A complete exact-record response stream may establish a narrow record while
  company/history coverage gaps remain in the reconciliation. These retained
  coverage gaps do not block that narrow predicate unless complete coverage
  was registered as required. Missing pages, conflicting pages, source failure,
  suspicious replies and missing record/field witnesses always block.
  Missing starting support is resolved only within the actually observed scope.

## Replay and executable financial meaning

Economic identities are namespaced by the frozen entity, not by a source's
transport record ID. Highest revision replaces previous revisions. Same-ID,
same-revision incompatible content is unresolved, including source disagreement.
Transport record ID and observation time do not create another economic value.
Aliases require a present acyclic target and matching economic content; they
count once. POSTED replacement records retire their named predecessor; pending
predecessors therefore cannot be added again. Missing/ambiguous replacements,
revision transitions and aliases stay unresolved.

REMOVED records and self-REVERSED records do not contribute. A linked reversal
requires its original and either an exact inverse field amount (POSTED) or the
same amount marked REVERSED; both identities are retired once. Multiple distinct
reversals of one original, absent originals and incompatible reversal values
are unresolved. Unreplaced PENDING records never supply established quantities.
Credits/returns/refunds use signed, basis-bound recorded amounts, not label
guesses. State classification comes from the exact authenticated field, never
from narrative instruction text.

`EXACT_RECORDED_VALUE` admits only rational EXACT fields; `EXACT_RECORDED_STATE`
admits only STATE fields for exact-record classification/value or an absence
counterexample; population state aggregation is unsupported.
Quantities multiply by the frozen scale and sign convention with reduced bigint
rational arithmetic. Record-state predicates require one consistent state.
ABSENCE yields STATE `ABSENT` or `PRESENT` under complete coverage.

`EARNED_REVENUE` has an intentionally narrow executable witness vocabulary.
The admitted rule must require all of `performance`, `recognition`, `cutoff`,
`grossNetTreatment`, `nonRevenueExclusions`. Included revenue records require
`performance=SATISFIED`, `recognition=<profile recognitionRule>`,
`cutoff=<assertion cutoff>`, `grossNetTreatment=<profile grossNetTreatment>`,
`nonRevenueExclusions=BORROWING_TRANSFERS_ADVANCES_EXCLUDED`, and known
related-party status. Every required witness must also be in the source's
authoritative fields and actual requested fields. A cash/deposit field alone
cannot pass. Other recognition/legal interpretations require an owner-approved
expanded semantic contract, not a silent guess by this checker.

## Conclusion, proposed result and deterministic reasons

Complete exact evidence matching the expected rational amount within the frozen
nonnegative error tolerance, or matching exact state, is SUPPORTED. Complete
sufficient incompatible evidence is CONTRADICTED. UNKNOWN expectations may
become SUPPORTED from newly observed exact scoped evidence. INTERVAL assertions
and incomplete/ambiguous evidence remain UNRESOLVED. Absence of support is never
contradiction. Discrepancy differences are `observed - asserted`, in normalized
units; materiality is not a license to relax the specified error tolerance.

Identity, measurement, sampling and interpretation uncertainties are separate
sorted reason sets. Gaps, exclusions, member/identity lists and excluded
interpretations use sorted unique values. Raw witnesses sort by observation ID,
raw pointer and economic ID. Proposed reconciliation must match every field of
the independently derived canonical reconciliation, including gaps, reasons,
witnesses, rejected interpretations and uncertainty; producer order is not an
alternative semantic contract. Reasons are stable machine predicates with
optional `:<identity>` suffixes. No producer conclusion is used as an oracle.
Equivalent reduced rational field representations do not create conflicts;
different witness meaning or economic content does. Exact-record identities
follow admitted replacement chains; the final posted successor counts once.
Multi-entity consolidation is unsupported by this single-entity source contract.
All raw field/witness keys must be explicitly requested and source-authoritative;
returned record kinds must agree with the source's coverage witness.

The default excluded interpretations, unioned with the admitted rule exclusions
and sorted uniquely, are `AUDIT_OPINION`, `S8_ADMISSION`,
`SOURCE_SIGNATURE_IS_TRUTH`, `PARTIAL_POPULATION_POINT_ESTIMATE`,
`TARGET_RECORD_IS_EXTERNAL_AUTHORITY`, `FORWARDED_REPLY_IS_DIRECT_CONFIRMATION`,
`CASH_IS_EARNED_REVENUE`, `UNOBSERVED_REMAINDER_IS_ZERO`.

The deterministic check ID and source-scope digest bind assertion, observation
refs, starting-evidence digest, knowledge cut, current bindings, semantics,
proposed digest, checker bytes and checked-at time. Output contains no admission
reference and cannot promote evidence to an audit/professional/legal opinion.
Actual authenticated E2E verification and retained repeatable artifacts are
owned by the main agent; no post-implementation unit tests are added here.
