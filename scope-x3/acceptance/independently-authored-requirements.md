# X3 independent development acceptance freeze v1

## Identity, provenance and limits
X3 means **Enterprise Application Synthesizer**, not historical R/X or X1/X2.
This finite PE-firm operations profile was authored before inspecting any X3
candidate implementation. Only repository instructions and owner README boundary
descriptions were read; no candidate functions, candidate outputs or unit tests
generated these expectations. This is an independent development oracle, NOT
protected custody, owner ratification, installed acceptance or product acceptance.
Model identity, human review identity, elapsed human effort and cost are UNKNOWN.
The supplied assignment does not include verbatim user evidence-family A–J
definitions; the manifest labels are explicit provisional crosswalks, not quotations.

## Bounded business contract
An analyst reconciles a deal's book and bank amounts, a different partner approves,
and compliance additionally approves at or above the currency's approval threshold.
The application compiles a declarative, stateful contract: typed data, exact
expressions, views, scoped commands, durable transitions and prepared effects.
It must not be a hard-coded reconciliation demo. A second release adds EUR and
lowers thresholds without deleting or silently rewriting original records.
Only bounded typed expressions over declared fields are allowed. No generated
JavaScript, Python, SQL, shell, eval, network calls or arbitrary source execution.
Existing FINNOR identity, evidence, database, Work/queue, Policy and Authority own
their boundaries; this fixture creates neither a second ledger nor new authority.
The vocabulary below is an acceptance interchange, NOT a proposed product API.

## Literal fixture rules
Tenant pe-a, scope deal-1, author u-a; analyst=u-a, partner=u-p, compliance=u-c.
Each has its named role, current authority and that exact tenant/scope by default.
Authentication, principal identity and grants MUST come from current canonical
owners in installed acceptance; input actor/grant data below are model assumptions.
Canonical development references have form owner/id/revision, with tenant carried
separately: P1/rec-1/1, S1/book/1, S1/bank/1. They are fixture names, not receipts.
Actual canonical reference encoding and ownership require integrator confirmation.

Amounts are nonnegative canonical base-10 **minor-unit strings**, 1–38 digits,
without signs, fractions, exponents, whitespace or leading zeroes except "0".
Each side has 1–128 lines; individual values and side sums fit 38 digits. USD/INR/EUR each
have two minor digits in this profile; "100000" means 1000.00 currency units.
Sum every book line and every bank line exactly. Delta = book sum minus bank sum,
as a signed decimal integer string. Never round through JavaScript Number.
Compare currency AND amount: there is no FX conversion or cross-currency netting.
Release r1 supports USD/INR with inclusive threshold "100000" in each currency.
Release r2 supports USD/INR/EUR with inclusive threshold "50000" in each currency.
These are bounded business examples, not claims of an appropriate real PE policy.

Evidence is KNOWN only when both pinned sources are KNOWN and current.
UNKNOWN, STALE and CONFLICTING are never replaced by zero, approval or success.
Refreshing an S1 current reference does not rewrite historical pinned references.
Readback exposes stored state separately from currentness (CURRENT or STALE).
No source acquisition or currentness is asserted by the fixture itself.

## State, authority and history
Only DRAFT -> RECONCILED -> APPROVED -> PREPARED are successful forward states.
Reconcile requires scoped, currently authorized analyst; exact currency/amount
agreement and KNOWN/current sources. Failed commands leave the stored state intact.
Approve requires RECONCILED (or APPROVED for an idempotent identical approval),
current role/authority/scope, and principal != record author, even with two roles.
Below threshold, partner alone suffices. At/above threshold, both partner and
compliance are required, in either order, and their principals must differ.
Each approval binds tenant, scope, canonical record revision, immutable release,
currency, exact amount and source-reference vector. A client label is not identity.
Prepare requires current analyst authority, active release equality, exact record
reference, current evidence and ALL still-authorized required approval principals.
Recheck authority and reference/currentness at durable commit, not merely rendering.
Authority revocation after approval prevents preparation; history remains visible.

PREPARED means a durable FINNOR **proposed effect**, never execution, settlement,
approval receipts, S8 admission or production authority. Same bound preparation
retried after restart creates exactly one proposal and zero executed effects.
Actual dispatch is outside this profile and cannot be smuggled through a command.
Record edit by the scoped analyst makes a new canonical revision in DRAFT, clears
active approvals/proposals and pins current sources; the original snapshot remains.
Release change never migrates old records implicitly or reinterprets old decisions.
New records may use r2; old r1 states remain readable but cannot prepare under r2.
No success transition or execution receipt may be seeded to bypass the workflow.

## Machine-readable interpretation and freeze
`cases.json` context `base` seeds a DRAFT record only. `input.set` overrides named
context fields; `input.record` overrides record fields. `events` execute in order.
Each event has `op`; authenticated actor is represented by `as`. `ref` is an
optional client expected-record precondition. Currency/source/quantity fields,
release identifiers and authorization flags are synthetic inputs, never authority.
`edit.record`, `activate.release`, `refresh.source/ref`, `revoke.actor`,
and `race.revision` are model interventions, not product mutation endpoints.
`expected` is a literal projection of final observations: exact ordered result
codes plus named state/binding/history fields. Unlisted fields are unconstrained,
not assumed successful. Every case must be selected exactly once, with no extras.
Each case is an isolated scenario. `actor_overrides` changes only named seed grant
fields. Source indices 0/1 mean book/bank. `readbacks` contains only authorized
record responses; owner-inspected final state is not an unauthorized response.
`amount_minor`/`delta_minor` can report a failed reconciliation's computed diagnostic,
not a persisted successful transition. Original history retains exact input lines.
`reference.py` checks projections using Decimal and a separate bounded state model.
It imports no product modules and only establishes internal oracle consistency.
It does not observe a browser, API, database, worker, identity or actual effects.
Installed verification must independently replay these inputs through strongest
owner boundaries, capture actual readbacks, and compare these frozen literals.
Freeze is SHA-256 of exact file bytes in `spec-digest.json`; changes require a new
freeze revision and explicit rationale, never regeneration from candidate outputs.

## Unanswered owner questions (remain gates)
Who ratifies this business policy and the verbatim A–J crosswalk? Which canonical
owner stores application records, releases and approvals? What exact reference,
source-currentness and atomic commit contracts exist? Who authorizes a migration?
Which FINNOR effect proposal/queue seam proves no dispatch? Who supplies ordinary
installed replay, independent protected custody and each external gate protocol?
