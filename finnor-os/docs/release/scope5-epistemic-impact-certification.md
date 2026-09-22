# Scope 5 Epistemic Intelligence certification

Generated: 2026-09-22T20:11:56.132Z
Migration head: 0140_scope5_epistemic_impact.sql

Local result: PASS_INTEGRATION. Staging and live remain BLOCKED_EXTERNAL.

| Gate | Status | Evidence |
| --- | --- | --- |
| fresh-migration | PASS_INTEGRATION | 141 migrations applied through 0140_scope5_epistemic_impact.sql |
| tenant-isolation | PASS_INTEGRATION | Cross-tenant source binding and historical graph replay rejected |
| bounded-baseline | PASS_INTEGRATION | Baseline resumed after one-node batch; 3 propositions evaluated without fabricated ChangeSets |
| bounded-frontier-retry | PASS_INTEGRATION | Root and derived child reevaluated across retries; unrelated proposition was not touched; concurrent duplicate delivery produced one ChangeSet |
| causal-replay | PASS_INTEGRATION | Existing read-only projection shows exact source, transition, Work impact and two proven edges |
| full-oracle | PASS_INTEGRATION | All 3 durable beliefs match independent full recomputation after source change |
| bitemporal-replay | PASS_INTEGRATION | Earlier knownAt remains good after later evidence changed the current belief to bad |
| activation-and-disable | PASS_INTEGRATION | Activation refused absent exact protocol-2 heartbeat; reversible kill switch restored legacy fallback without erasing immutable facts |
| exact-plan-gate | PASS_INTEGRATION | Activated stale mandatory pin blocks only the dependent PlanNode |
| final-pe-transaction | PASS_INTEGRATION | PE closing mutation rejected stale pin inside its final owner transaction; canonical condition remained open |
| atomic-source-rollback | PASS_INTEGRATION | Rolled-back source version left neither EvidenceChange nor committed source row |
| concurrent-ordered-sources | PASS_INTEGRATION | Two concurrently accepted source versions converged in ingestion order; out-of-order delivery deferred and full oracle matched |
| structural-refresh | PASS_INTEGRATION | New PE Deal advanced epoch, fenced execution, rebuilt/baselined graph and required explicit reactivation |
| populated-upgrade | PASS_INTEGRATION | 0139→0140 preserved existing canonical/evidence rows; new epistemic tables empty until explicit baseline; pre-baseline replay unavailable |
| outcome-calibration | PASS_INTEGRATION | Final PE Decision froze one exact Plan-pinned assessment; later Outcome comparison was contradicted and idempotent without modifying the assessment |
| durable-freshness | PASS_INTEGRATION | Indexed due scan accepted one idempotent clock change, propagated root→derived child and matched full oracle |
| digital-twin-restatement | PASS_INTEGRATION | Phase-4 metric revision generated a redacted canonical proposition delta and exact Underwriting input/node/run/IC Question paths; unlinked same-Deal Question/Decision were unaffected, historic Run/Question stayed immutable and structural epoch fenced activation |
| performance | PASS_INTEGRATION | 8 corpus scenarios matched full semantics; measured proposition counts and median latencies are in the JSON report |
| staging-and-live | BLOCKED_EXTERNAL | No staging/live deployment or exact release worker proof was supplied; local embedded PostgreSQL is not an external environment. |
