# S3 — Intervention dynamics implementation plan

Authority: actual runtime, AGENTS.md, the frozen specification (SHA-256
`2288bb54a3f6a91ed2673c220e7d844842ace9de5f6ee1b6674e8a48980ff415`),
and the S3 oneshot specification. Starting HEAD is
`6ade745cfaca88bb199ed9cac2b37b86e6d5ef9a`. Source copies, index, relevant
committed/working changes, and reference digests are in scope-evidence/start-*.
No reset, stage, commit, AWS resource, deployment or paid acquisition is planned.
Guidance defaults to medium pending the AGENTS.md preference response.
S1/S2 evidence and validity domains remain upstream qualifications.

## Current component decisions

| Component | Classification | Treatment |
|---|---|---|
| S1 permissioned owner revisions, scalar observations, as-of cut and current pins | KEEP / BOUNDED | Actual PE loader; select observed numeric series with owner/unit/time identity; never infer calibrated enterprise truth |
| S2 finite experiment design and realization | KEEP / BOUNDED | Preserve conditional IID law semantics; unresolved temporal mechanisms become inquiry needs, not fabricated IID laws |
| Underwriting compiler, scenarios and CompanyBrain | KEEP / BOUNDED | Deterministic financial/provenance consumers; no current learned causal dynamics found |
| Causal replay | KEEP / BOUNDED | Workflow/effect provenance, not business causal identification |
| Canonical intervention semantics / learned temporal response | MISSING | Versioned S3 contract, authorized histories, competing fitted mechanisms, query assessments and joint trajectories |
| Numerical fitting / dependent bootstrap | COMMODITY | Statsmodels OLS, SciPy convex hull, arch moving-block bootstrap; trusted local adapter configuration, no statistical engine duplication |
| General identification/discovery, nonlinear strategic equilibria | BOUNDED / MISSING | Explicit unresolved status outside registered sequential-g-formula subclass; no invented graph orientation or equilibrium |
| Protected ledger/admission and downstream owners | MISSING / BLOCKED_EXTERNAL | Typed unadmitted producer records; no protected receipts, promotion, execution or credit |

## Executable milestones

| Capability | Affected components | Validation | Failure condition |
|---|---|---|---|
| Meaning and permissioned history | shared types, PE adapter, API | Actual ordinary-role S1/API, exact units, series/target binding, semantic mutation attacks | Caller data replaces S1, future/foreign/revoked evidence accepted, dose/target/time changes preserve identity |
| Learned delayed joint dynamics | numerical backend and S3 runtime | Hidden-truth generator, independent least-squares/reference recurrence, repeated/delayed actions and interacting firms | Hardcoded effect table, spurious independence, absent actor history, incorrect learned or rollout answer |
| Identification and ambiguity | mechanism/assumption/query contracts | Equivalent observational mechanisms, latent confounding, IV, overlap, post-treatment adjustment, missing actual exposure | Convenient point claim from unidentified data; numerical failure confused with identification |
| Strategy and applicability | actor contracts, support/regime checks | Adaptive responses, changed actor laws, company/time/regime/context holdouts | Unique invented equilibrium, unqualified transport, omitted unsupported path mass |
| Uncertainty and calibration | synchronized block draws, joint residual trajectories, refutation | Prospective-in-generator trajectories, withheld times, independent effects/coverage/width | Interval or causal validity claimed beyond approximation/domain; useful bounds manufactured |
| Upstream/downstream integration | S1 pins, S2 inquiry/design bridge, typed response consumers | Existing S2 designer through supported IID bridge only; dependent laws rejected | Temporal rollouts disguised as IID; S3 selects policy/clears resources/awards credit |
| History, versions, costs and recovery | immutable S3 records, local ModelComputeFabric adapter | Failed attempts, source/artifact mutation, restart, concurrency, bounded requests | Missing = zero cost, fabricated receipt, partial fit treated complete, source change accepted |
| Frozen gate audit | S3 claims/status/evidence | Repeatable E2E artifacts, upstream regressions, current typecheck and adversarial audit | Generated evidence promoted to useful field dynamics/full gate or 100× economic value |

## Preregistered method domain — s3-temporal-linear-v1

Before implementation/scored evaluation: 1–8 same-tenant roots; 1–8 numerical
state variables (including measured counterparty response where material);
1–4 actual exposure/disclosure channels, canonical series/units and fixed period
duration; 1–4 competing mechanisms; at most 24 registered regression features
per equation, lag 0 for exposures and lag 1–3 for state variables (no
contemporaneous endogenous adjustment), optional registered products for
heterogeneity. At least 64 training and 20 chronological holdout periods, at
most 512 aligned periods. All rows remain accounted for. Missing, censored,
ambiguous, conflicting, nonnumeric or mismatched measured values prevent this
complete-history fit; no silent complete-case causal analysis.

Each mechanism is a supplied hypothesis with declared sequential exchangeability, positivity,
consistency, reliable actual-treatment measurement, selection/missingness,
support, interference, response information and regime invariance assumptions.
Fitting does not establish them. Unknown/contradicted identifying assumptions,
latent-confounded alternatives, invalid IV requests, post-treatment features and
unknown actor response retain unresolved identification. Fully observed lagged
state-space transitions, stable weak dependence and sufficient joint exposure
support permit only assumption-conditional g-formula responses. No method
admission, individual counterfactual, arbitrary graph identification, S7 credit
or field calibration is granted.

Statsmodels fits equations to real selected S1 observations. Synchronized arch
moving-block resamples of the full time row preserve joint parameter dependence;
joint residual blocks preserve shared shocks. Bootstrap uncertainty is an
asymptotic approximation under registered stationarity/mixing and model-form
assumptions, not finite-sample guaranteed coverage. Registered block length 4,
128 draws by default (64–256 allowed), seed 20261003. Candidate mechanisms are
not probability-weighted by predictive fit. Holdout normalized RMSE tolerance
0.15, mean residual-shift tolerance 0.10 and registered residual diagnostic
threshold 0.001; passing a refutation is failure to falsify, not identification.

Population intervention queries bind a joint fixed schedule and comparator,
initial measured history, target companies, regime/context, fitting revision,
start time, 1–24 periods and 256–4096 simulations (default 1024). Common shocks
pair scenarios only as a computational coupling for mean contrasts; unit-specific
counterfactuals require additional assumptions and are unsupported. Convex-hull
checks expose joint feature/dose extrapolation; unsupported trajectory mass is
retained and bounds require independently declared finite outcome ranges. No
full-feature convex hull is qualified above affine rank 6 or 100,000 facets;
unavailable support checks retain all path mass as unsupported with a reason.
No
survivor-only distribution becomes a population prediction. New companies,
regimes, contexts, lags, methods or semantic operations require new evidence and
admission envelopes; similarity does not grant reuse.

The immutable intervention binds numerical operation, target, channel, dose,
units, start/period/duration, intended exposure, context and permitted refinements.
Vocabulary version s3-intervention-v1 contains PRICE_CHANGE, WORKING_CAPITAL,
SUPPLIER_SWITCH, FINANCING_CHANGE and DISCLOSURE only as modeled proposal
meanings. It neither changes existing action execution semantics nor dispatches.
Measured source exposures are owner measurements under explicit reliability
assumptions, not independently verified S6 treatment or assignment credit.

## Preregistered verification

One E2E owner: finnor-os/scripts/s3/run-s3-e2e.mts, with disposable PostgreSQL,
ordinary finnor_app, real canonical owners/S1 pins and authenticated handlers.
The prewritten independent generator/reference lives in scripts/s3/reference.py;
hidden laws/coefficients never enter fitting requests. It independently evaluates
delayed dynamic effects and adaptive actors, joint shock covariance, temporal
holdouts and changed regimes. Exact fitted-reference tolerance 1e-8; supported
mean response error <=0.10 of fixed outcome range; 90% generated predictive
coverage 0.82–0.98 with mean width <=0.5 of fixed range; measured known-effect
mean bias <=0.08 of range. These are local H1 qualifications, not the frozen
system frontier trial or prospective field evidence. Adversarial cases have
independently specified rejection/ambiguity expectations, not favorable scores.

Cold/warm fit or query <=30s; child timeout 20s; <=512MiB observed child maximum
RSS, <=256MiB sampled incremental parent RSS; <=2MiB request, <=8MiB response
and numerical I/O. Two concurrent backend slots, no queue of unbounded work.
Full output/source/versions/input/steps/rerun evidence, including failures, is
retained per run. No post-code unit tests. Failure-model and authoring gate are
written first. Budgets/domain/tolerances will not be raised/narrowed after failure.

Additional registered owner challenges exercise the actual common observational
law A=U, Y=U+noise under causal Y=A+noise versus confounded Y=U+noise (true do
effects 1 versus 0), a counterparty coefficient change only in the withheld
32 periods, a positive S2 bridge with independently supplied IID instrument
laws, and 512 periods/24 features/256 parameter draws/4096 simulations/24-step
output within the original budgets. These expand evidence; no score tolerance
changes and no assertions that an unrelated numerical failure proves ambiguity.

The unchanged full S3 gate additionally requires useful field dynamics and
prospective enterprise interventions with independent exposure/outcome evidence,
company/time/regime holdouts, scientific/method admission and protected history.
Local generated trials cannot create those. Finish all independent S3 work and
safe integrations before recording exact external blockers. Economic 100×,
Muse/dots 10× and capability-frontier dominance remain separate, unmeasured
requirements.
