# S4 — Contingent control implementation plan

Authority: unchanged architecture-locked-specification.md, SHA256
2288bb54a3f6a91ed2673c220e7d844842ace9de5f6ee1b6674e8a48980ff415.
Starting HEAD 6ade745cfaca88bb199ed9cac2b37b86e6d5ef9a, codex/p3-epistemic-runtime.
Existing checkout and staged index are preserved. No subagents, deployment,
new service, paid call, allocation issuance or external intervention.

KEEP: actual S1 permissioned views/pins, S2 finite instruments/realizations,
S3 learned joint dynamics/vocabulary, ordinary private immutable artifacts,
existing effect/authority/settlement guards. BOUNDED: upstream qualification,
finite observed-state learned models, supplied instruments. MISSING: executing
ContingentPolicy owner, economic mandate input, contingent resource demand and
closed-loop consumer. REPLACE: none of the existing operational planner paths;
their graph/heuristic scores do not establish economic control. COMMODITY:
bounded exhaustive scenario-tree search, Node/PostgreSQL, SciPy support geometry.
BROKEN: historical browser verification is out of this mission; no claim to fix it.

| Capability | Components | Validation | Failure condition |
|---|---|---|---|
| Immutable mandate input and policy contract | shared-types/control, runtime/control-contracts | prewritten boundary challenges | inferred utility/prior, mismatched units/rights/horizon, missing cost treated as zero |
| Qualified joint dynamics and instrument interface | minimal S3 control-kernel and S2 temporal instrument extensions | independent recurrence/support challenges and actual learned S3 path | midpoint/marginal reconstruction, rectangularized ambiguity, hidden observations |
| Joint contingent optimization | runtime/control solver | independent exhaustive finite oracle, fixed inputs and normalization | wrong robust total utility, absent inquiry/wait/stop, unsafe terminal truncation |
| Budgeted search and fallback | solver, compute invocation | exhaustion/failure/large-history challenges | false global gap, unchecked incumbent, deadline overrun, universal safe WAIT |
| Actual owner and revision path | PE/control owner, authenticated policies API | disposable PG, ordinary-role S1/S2/S3, restart/rights/source attacks | detached fixture only, stale activation, lost obligations, cross-tenant disclosure |
| S5/S6/S7/S8 handoffs | demand, bounded choice IR, typed prepared experience | forged allocation/admission and no-effects readback | self-issued clearance/authority/settlement/credit or protected receipt |
| Independent falsification and preservation | scripts/s4, evidence | retained failures, replay, fixed oracle scores, scoped review | post-result narrowing, duplicate evidence-only tests, upstream/index mutation |

## Preregistered domain: s4-finite-contingent-v1

One immutable externally supplied linear scalar utility in explicitly bound units;
complete period discount factors, terminal/tail terms, action costs, resource
envelopes and a hard worst-path utility floor. No utility inferred from tasks.
Mandate ambiguity is ROBUST_FIXED_JOINT_SCENARIOS or explicitly UNRESOLVED.
The robust objective is minimum full-horizon utility across fixed complete
scenarios, never a sum of independent per-period worst cases. S3 parameter draws
remain bootstrap approximations, not Bayesian samples. No mechanism probabilities.
An exhaustive result certifies only the supplied finite scenario decision problem.
Omitted distribution/identification/field/model gaps are explicitly unresolved.

Up to 24 periods, 8 choices, 4 mechanisms, 64 paths/mechanism, 8 observation
instruments and 32 outstanding commitments; 50,000 search expansions and
30 seconds per decision, 8 MiB artifact/response and 2 MiB request. Independent
small exact cases use horizons 2–4 and enumerate nonanticipative policies.
Every choice compares the same scalar total utility/units, feasible set, lawful
observation information, horizon, ambiguity semantics and resources. Fixed
normalization S=100 for synthetic monetary cases; maximum normalized regret
upper bound 0.05, numerical agreement tolerance 1e-8. Search-exhausted cases
retain sound bounds; a wide gap is inconclusive, never a passing score.

Cases fixed before implementation: profitable complete-cost inquiry, useless and
noisy inquiry, delayed signal, action learning, private-state noninterference,
adaptive counterparty reversal, option waiting/deadline, stopping with tail debt,
resource coupling, unsupported model/ambiguity, unsafe waiting, exhausted search,
unknown effects, source/model/rights changes, tamper/foreign references, recovery,
forged S5/S6 certificates, bounded concurrent requests and large search history.
Independent oracle and failure model are authored before production code.
Generated economic cases are H1 and are not prospective PE value.

Actual integration consumes server-resolved S3 model refs and S2 protocols,
S1 current pins, authenticated business-owner supplied mandate assertions and
explicitly qualified observation/settlement inputs. An assertion is not protected
mandate admission. S5 alone resolves cleared allocations; the absent issuer is
BLOCKED_EXTERNAL. S6 alone verifies/executes/settles. Unknown effects with no
justified continuation withhold activation. Stopping rolls through the original
horizon and retains existing exposure, resource occupancy and terminal debt.

S4-OWNED passes only after every independently achievable capability in this
registered domain is implemented, integrated and challenged. FROZEN FULL S4
additionally needs protected S5/S6 integration, independent prospective
decision-value evidence and equipped external comparator trials. No weaker gate,
H2 value, frontier dominance or FINNOR economic 100×/Muse/dots 10× is asserted.

Guidance: medium assumption while the optional help preference remains pending.

## Completion addendum (2026-10-01 UTC)

All milestones above are implemented and independently challenged. Exact source,
inputs, seeds, steps, results and failure repairs are retained in scope-evidence.
The original twelve evaluation cells and their scoring remain unchanged; added
challenges were registered in additional-challenge-registration.json and
final-challenge-registration.json before their first scored use.

Final implementation also separates remaining obligation resource consumption
from occupied stock, preserves settled residual debt and earlier commitments,
binds business periods as well as issuance time, projects temporal measurements
through an S2-owned permitted-S1 interface, and publishes policies after their
immutable dependencies. Full source identity covers owner/consumer extensions.

S4-OWNED passes the independently achievable implementation/integration/falsification
gate for this fragment. Frozen full S4 remains unpassed. Exact small numerical
scoring and honest bounded failure behavior do not substitute for the full
economic quality, protected execution or prospective evidence gates. The larger
stress cell's regret assessment is INCONCLUSIVE, unchanged from its registered
scoring basis. See completion-audit.md for the capability and evidence matrix.
