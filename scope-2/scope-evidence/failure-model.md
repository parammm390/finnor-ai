# Pre-implementation failure model

Written before S2 production code. E2E property challenges must cover:

1. Malformed/unbounded input, invalid decimals/sums/priors, zero-probability paths,
   nonfinite outputs, near-threshold rounding, duplicated identities and empty loss.
2. False likelihood precision; nuisance uncertainty, dependence, cluster effects,
   interference, measurement error, informative missingness or strategic reactivity
   silently ignored; irrelevant information ranked as economic benefit.
3. Incorrect count multiplicity, marginal mass, risk, decision ties, discriminating
   power and joint stopped-path distribution; unavailable support mistaken for zero.
4. Repeated fixed-sample peeking presented as valid sequential testing; multiplicity
   hidden; endpoint/instrument/model edits resetting alpha, sample or exposure.
5. Forged/foreign S1 views/claim refs; stale source/rights/mandate/model revisions,
   source revocation, future knowledge, tenant/principal leakage or reuse across rights.
6. Protocol mutation; semantic revision overwritten; intended/attempted/acknowledged/
   actual exposure/measurement/analysis collapsed; noncompliance or censoring erased.
7. Duplicate telemetry IDs, duplicate measurement units/origins, conflicting retries,
   reordered clocks, bad references, impossible observation and unsupported category.
8. Unknown physical outcome retried blindly; incomplete/crashed history treated as
   complete; hash chain called tamper-proof protection; rollback losing observations.
9. Actual cost omitted or zero-filled; estimate versus limit confused; mixed quantity
   units; reservation overruns ignored; corrections double counted or overwriting.
10. Unsupported external handoff called production; prepared event called protected
    receipt; designer/compute scheduler dispatches effects or selects business policy.
11. Correlated/withheld/misspecified calibration cases not challenging predictions;
    simulator presumed optimal; retrospective fixture called prospective measurement.
12. Excessive response/memory/time, adverse numeric inputs, cache leakage, unrecorded
    backend/version/route/fallback/resource consumption, paid infrastructure left running.

Isolated numerical verification, if used, covers only mathematical computation
under supplied laws. It cannot establish empirical enterprise instrument validity.
