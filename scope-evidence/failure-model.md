# Pre-implementation S1 failure model

Recorded before S1 implementation or new test execution. End-to-end evidence
must contain exact inputs, versions, steps, expectations, observations and rerun
commands; failed runs are retained. The reference implementation must not call
BeliefView/world/epistemic reconstruction to compute expected answers.

1. A source backdates retrieved/as-of timestamps and becomes visible before FINNOR
   inserted it. A source timestamp is substituted for the knowledge clock.
2. A correction overwrites older knowledge, old relationship versions reconnect a
   moved object, or a retracted row is selected again after restart/reordering.
3. Canonical record integrity is confused with factual truth. A forecast,
   assumption, model estimate or derived assertion becomes an observed fact.
4. Copies, reports sharing an upstream origin, or unresolved origins become
   independent corroboration. A scalar label becomes a calibrated probability.
5. Competing nonsuperseding claims are discarded; a later timestamp alone resolves
   a contemporaneous disagreement without authority or reconciliation.
6. Entity IDs, owners, units, currencies, value types or business periods are lost
   in a join/aggregate. Decimal precision loss flips a decisive predicate.
7. Tenant spoofing, foreign IDs, suspended users, revoked grants or disabled source
   rights leak values, source identities, counts, existence, provenance or errors.
   Trusted service-name prefixes are mistaken for authenticated credentials.
8. A revoked view is reused from cache, a pooled connection retains context, a
   rights race selects earlier permissions, or joins bypass the source boundary.
9. Missing/inaccessible/unconfigured/not-baselined/stale/failed inputs become zero,
   absence or completeness. Limits hide a decisive outlier or dependency.
10. Context/projections use a different meaning from the query. Their independent
    source cuts are represented as a globally atomic snapshot.
11. An externally supplied decision context is not versioned, incompatible requests
    are silently approximated, or the claimed error bound exceeds observed loss.
12. Source/interpretation/rights changes do not change view/pin witnesses. Duplicate
    delivery causes effects; concurrent updates mix incompatible snapshots;
    restart loses invalidations or unresolved responsibilities.
13. A local event log, hash or fake receipt is called a protected ExperienceLedger.
    Horizon maturity is fabricated; H0/H1 forecasts are presented as H2 value.
14. The expected-answer oracle reuses the implementation, test setup bypasses RLS,
    skipped tests count as success, or operating limits are raised after failure.
15. Cold/warm, high-fanout, 1,000-record and overflow performance miss the registered
    budgets; provider staleness/cost is hidden or local measurements extrapolated.
16. An implementation edit overwrites user work or broadens protected semantics.

Protected append/authentication semantics belong to the reviewed S6 release.
No protected migration, business planner or new semantic owner is authorized by
this failure model.
