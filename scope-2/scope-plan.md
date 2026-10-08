# S2 — Experiment design implementation plan

REPO_ROOT is `/Users/paramdave/Desktop/FINNOR`; `/Users/paramdave/FINNOR` is its
filesystem alias. HEAD is `6ade745cfaca88bb199ed9cac2b37b86e6d5ef9a`, branch
`codex/p3-epistemic-runtime`. The initial working hashes and complete Git index
are retained in `scope-evidence/start-manifest.json` and `start-index.txt`.
Whole-tree Git status/diff was too slow; this limitation is recorded. No reset,
stage, commit, cloud resource, paid experiment or deployment is authorized here.
S1 and its root records remain upstream inputs. The locked specification digest
is `2288bb54a3f6a91ed2673c220e7d844842ace9de5f6ee1b6674e8a48980ff415`.

## Component classification from current execution contracts

| Component | Classification | Treatment |
|---|---|---|
| S1 BeliefView, actual enterprise view loader and pin validation | KEEP / BOUNDED | Consume current authorized qualified records; never manufacture a posterior or admission |
| Legacy information actions/scoring | KEEP / BOUNDED | Preserve heuristics and their authority/budget checks; they do not supply a calibrated experiment |
| Controller, P2 handoff and shadow | BOUNDED | Existing acquisition semantics stay unchanged; shadow execution does not establish a production S4 loop |
| ExperimentProtocol / ExperimentRealization | MISSING | Add one S2 contract, immutable content revisions and explicit actual-history states |
| Small exact finite likelihood design | MISSING | Bounded adapter with independent rational/enumerative reference; no surrogate optimization needed |
| Existing compute classifications/governors | KEEP / COMMODITY / BOUNDED | Retain existing machinery; local pure adapter records shared ModelComputeFabric provenance; no new worker/service |
| Protected ExperienceLedger admission | MISSING / BLOCKED_EXTERNAL | Prepared S2 typed records only; consume S1's exact S6 dependency; null receipts, no effects |
| Frozen S4/S5/S7 owners | MISSING for this supported handoff | Typed references/reference consumers only; do not implement their fundamental systems |

## Executable milestones

| Capability | Affected components | Validation | Failure condition |
|---|---|---|---|
| Canonical protocol and S1 integration | shared types, epistemic runtime, PE adapter and authenticated API | ordinary-role real S1 → protocol → S4 handoff handler | Detached demo, tenant mismatch, erased S1 qualifications, fabricated execution authority |
| Exact fixed design | finite likelihood/numerical adapter | independent Python Fraction ordered paths and multinomial reference, all registered inputs | Incorrect expected loss/power/distribution, information about irrelevant hypotheses preferred |
| Bounded sequential validity | registered two-simple-hypothesis likelihood ratio stopping | independent stopped-path enumeration, held-out outcomes, unchanged cumulative history | Optional fixed-sample peeking, reset error budget, adaptive endpoint changes, lost prior sample |
| Admissibility | request constraints, source/rights/dependency/expiry rechecks, collection IR | revocation/stale/malformed/adverse bounds | Local estimate mistaken for enforced S5/S6 limit; any effect dispatched |
| Complete realization history | S6 telemetry projection, typed prepared experience references, S7 evidence handoff | assignments/attempts/exposures/acknowledgments/observations/analyzable sample separate; crash/replay/dedup/deviations | Unknown retried blindly, duplicate sample, correction overwrites history, intended exposure credited as actual |
| Cost/recovery/provenance | independent quantity accounting, immutable supersession, compute invocation envelope | separate estimate/actual/unknown, duplicate/revision accounting, resource measurements | Missing = zero, mixed units, double counted revisions, unmeasured identity/speed/cost claim |
| Independent falsification | prewritten E2E runner and independent reference | fixed challenges, preserved failures and rerun artifacts | Oracle calls production implementation, post-result narrowing, skipped requirement presented as pass |
| Frozen gate audit | claims and dependency documents | explicit local qualification versus prospective enterprise/S4/protected ledger requirements | Simulated evidence promoted to prospective field validity or S2 completion to a system multiplier |

## Preregistered supported domain — s2-finite-v1

Before implementation/scored runs: 2–4 externally supplied hypotheses, strictly
positive finite decimal priors summing exactly to 1; 2–3 categorical outcomes,
finite decimal conditional probabilities summing exactly to 1 per hypothesis;
1–8 supplied terminal decisions with nonnegative supplied loss in one explicit
unit; 1–8 candidate instruments, each with 1–24 independent measurement units.
Single endpoint, observational measurement assignment. No business treatment,
cluster dependence, interference, strategic reactivity, informative missingness,
estimated nuisance distribution, continuous likelihood, model fit or transport
claim is supported. Material unknown assumptions/likelihoods yield limitations.
S1 claim references establish supplied context, not probability calibration.

Fixed-sample design uses exact count-vector probability and supplied Bayes loss.
Numerical probability/loss totals are rational; display rounding is separate.
Discrimination is the registered two-simple-hypothesis likelihood-ratio rule
with supplied alpha/beta and explicit inconclusive outcomes. Sequential collection
supports only two simple hypotheses; the threshold rules are likelihood ratio
>= 1/alpha or reciprocal >= 1/beta, at each permitted sample, under the declared
conditional IID law. This is a conservative Ville bound, not an unqualified
Wald approximation or a confidence sequence for arbitrary parameters. Time,
sample and exposure stops are distinguished from statistical and S4 business
stops. Adaptive instrument changes and multiple endpoints require new methods.

Exact-design baseline: independent Python standard-library Fraction enumeration
of ordered paths at n<=8 and an independent multinomial implementation through
n=24. Sequential baseline enumerates ordered stopping paths at n<=12 and a
separate forward-state solver through n=24. All observe the same supplied
likelihoods, priors, loss and limits. This gives a design optimum among supplied
feasible instruments, not a global business-policy optimum.

Held-out simulation: fixed PRNG seed 20261001; 2,000 independent episodes per
registered hypothesis/case. Register 6 calibration cases; a simultaneous
Hoeffding error tolerance of 0.06 on outcome frequencies and normalized loss.
Misspecified, duplicated, correlated, clustered, missing and reactive cases are
adversarial limitations, retained rather than made into in-domain passes.
Exact reference error tolerance: zero on rational totals, <=1e-12 on display
conversion for bounded probabilities and normalized loss. All deterministic
authority/tenant/history/quantity constraints must hold with zero observed
violations. Compute: local cold/warm/adverse request p95 <=5s; <=256MiB sampled
incremental process RSS; <=64KiB HTTP request, <=4MiB response, <=4,096 telemetry
events. True peak/process attribution, DB memory and billed local cost stay
qualified. Freeze source/reference/corpus hashes before scored runs.

The full gate additionally needs newly acquired prospective enterprise
measurements, actual S4 closed-loop selection, S5 commitments, protected S6
collection/ExperienceLedger and S7 integration. These cannot be fabricated from
fixtures. Finish every independent S2 capability and safe integration first;
classify the exact missing dependent requirements BLOCKED_EXTERNAL.

## Work conventions

No post-code unit tests. The failure model is written in advance in
`scope-evidence/failure-model.md`; challenges exercise the integrated path and
save inputs, versions, assertions, observed history, failures and rerun commands.
No additional subagents: the user explicitly stopped delegation on 2026-10-01.
Guidance defaults to medium while the optional preference remains unanswered.
