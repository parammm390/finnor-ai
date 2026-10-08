# S5 — Portfolio resource clearing implementation plan

Frozen owner: **S5 / AllocationCertificate**. The eight scopes, five contracts,
Ring-0 and benchmark remain unchanged. Starting HEAD
`6ade745cfaca88bb199ed9cac2b37b86e6d5ef9a`, branch
`codex/p3-epistemic-runtime`; historical audit
`ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`. Initial source/index hashes and the
unchanged architecture lock are recorded in `scope-evidence/start-manifest.json`.
Existing uncommitted upstream implementations are the runtime baseline.

## Preregistered validity domain, before implementation

Version `s5-joint-finite-v1`: discrete selection of exact current S4 policies
under one supplied EconomicMandate; fixed complete **common** finite joint paths,
with explicit linked joint value/interference terms and exact policy-node paths.
No probabilities, independence, causal identification, conversions, liquidity
from uncertain proceeds, or changes within a policy are inferred. Unsupported
compatibility requests linked S3/S4 revisions. Model/resource facts remain
authenticated ordinary owner assertions; protected admission remains external.

Canonical decimal quantities preserve resource owner, tenant, entity/legal
scope, unit/currency, rights, source/as-of/knowledge clocks and availability.
Stocks and cumulative expenditure use prefixes; flows, occupancy and exposure
use period quantities. Terminal commitments are explicit. Registry covenants
are reconstructed independently and cannot be omitted by the producer. Current
obligations and all durable outstanding reservations count in each clearing.
Different request scenario sets combine conservatively by their reserved
envelopes; optionality savings apply only inside a supported common-path batch.

Registered bounds: 32 policies, 16 resources, 24 business periods plus terminal,
32 common paths, 512 joint value terms, 256 live reservations, 2 MiB request,
8 MiB artifact, 30-second decision deadline, 16 GiB memory ceiling, 900 human
seconds and no paid/provider calls. Small exact proof region: at most 14 policies
and complete enumeration within the same decision budget. Exact decimal primal
checks have **zero feasibility tolerance**; configured safety margins are charged
before clearing. HiGHS FLOAT64 estimates never substitute for an exact witness.
Large cells retain the exact analytic upper bound as fallback; a mature LP
multiplier proposal can tighten it only through an independent exact canonical
Lagrangian box proof (design/failure model in dual-bound-design.md). Numerical
estimates remain qualified; unchanged scoring never treats them as proof.
External quantities are bounded to18 decimals/1e12; derived accounting supports
48 decimals/1e30. These structural limits refuse overflow, never round it away.
Normalization is the unchanged mandate scale, never an achieved-value ratio.

Failure model and four-question test authoring decisions are recorded in
`scope-evidence/failure-model.md` and `scope-evidence/test-selection.md` before
the affected tests are authored. The test domain includes coupled programmes,
complementarity, cross-period cash, branch exclusivity/correlation, multi-process
PostgreSQL contention, crash/restart, unknown outcomes and authority attacks.
Independent Python Fraction enumeration supplies baseline choices/bounds;
independent SQL supplies persisted commitment readback. A greedy diagnostic is
not the strongest baseline. Synthetic inputs never become field evidence.

## Executable milestones

| Capability | Affected components | Validation | Failure condition |
|---|---|---|---|
| Canonical resources, model, certificate and exact arithmetic | shared-types/allocation; epistemic-runtime/allocation-contracts | owner-boundary malformed/unit/identity/future/private-path challenges | unbound source/right/unit, omitted demand or fake joint uncertainty admitted |
| Coupled robust candidate generation and independent checking | replaceable SciPy/HiGHS adapter; canonical checker | independent Fraction oracle, omitted/altered covenant and false-bound attacks | infeasible selection, unrelated scenario independence, false optimality |
| Temporal and contingent reservation envelope | checker, S4 demand/node validation | liquidity timing and terminal debt; exclusive and correlated branches | future proceeds fund earlier cash, hindsight branch or simultaneous double use |
| Durable concurrent commitments | forward-only S5 migration; private-equity allocation owner | separate ordinary-role processes, independent SQL, abort/retry/restart | stale commit, double reservation, partial acquisition or changed-payload replay |
| Conservative consumption/reconciliation/release | S5 responsibility owner; existing S6 evidence resolver | unknown/expired effects, duplicate consume/release, cancellation and correction | disappearing exposure, double consumption or caller-counterfeited settlement |
| Actual S4 handoff and experience | minimal S4 owner seam; allocation API | real S1→S3→S4→S5 handlers and ordinary authority | request-body certificate accepted, reservation mistaken for S6 authority |
| Bounded re-clearing, costs and invalidation | source/current witnesses, resource revisions, compute/events | rights/source/method/resource races, solver failure, contention load | hard constraint relaxed, empty allocation hides existing breach, missing failure history |
| Qualification and independent attack | scripts/s5 E2E/reference; evidence/audit | focused upstream S4/S3/S2 checks, workspace/harness typechecks, independent review | unchanged gate fails or evidence overstates exact/empirical/field authority |

## Initial component decisions

KEEP: S1/S2/S3/S4 owners, immutable exact references, native provider budgets,
logical attempt reservations, effect identity, unknown-outcome responsibility,
tenant/authority guards and protected-boundary refusals.
BOUNDED: upstream finite supplied/learned scenarios and ordinary proposals.
MISSING: S5 issuer/resolver, canonical portfolio constraints, independent checker,
persisted shared reservations and resource-to-effect reconciliation joins.
REPLACE: no operational scheduler; S5 fills its frozen economic owner boundary.
COMMODITY: PostgreSQL transactions/RLS and mature HiGHS MILP candidate solving.
BROKEN: body-supplied allocation cannot resolve anything; complete that real seam.

Implementation and verification proceed continuously. Failed artifacts remain.
No upstream evidence is overwritten, no historical reset/stage/commit/deployment,
no post-code unit tests, no invented receipt, authority, field return or H2 credit.
