# Phase 4 Company Brain certification

Status: **PASS_INTEGRATION**

Live provider evidence: **BLOCKED_EXTERNAL**

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| fresh-database | PASS_INTEGRATION | 141 forward migrations; head 0139; 18 forced-RLS history owners |
| populated-upgrade | PASS_INTEGRATION | 0138 populated Core identities and PE Strategy preserved byte-for-byte; zero fabricated Scope 4 rows; honest baselines |
| typecheck | PASS_LOCAL | repository TypeScript project |
| relationship-contracts | PASS_LOCAL | 66 runtime relationship contracts exactly match checked-in certification matrix |
| pe-domain-boundary | PASS_LOCAL | canonical PE ownership boundary verifier |
| unit-regressions | PASS_LOCAL | Company Brain, PE state/epistemic/underwriting/IC, Source Truth, Scope 1 and Scope 3 contract suites |
| database-regressions | PASS_INTEGRATION | Scope 4 adversarial; existing PE close/world/Underwriting/IC; Source Truth, Work/Planning, and Scope 1-2 database suites; focused 44-test Scope 3 disposable suite |
| phase15a | PASS_LOCAL | production target, protected environment, PR verdict, mutation inventory, and release policy suite |
| postgres-graph-benchmark | PASS_INTEGRATION | 6 measured operations on representative 200-company / 1,000-observation corpus; all p95 guardrails passed |
| live-provider-validation | BLOCKED_EXTERNAL | No SEC, GLEIF, PitchBook, Preqin, CapIQ, Grata, SourceScrub, or equivalent credential/data source was supplied; no live-provider claim made |

## Benchmark corpus

```json
{
  "companies": 200,
  "funds": 10,
  "vehicles": 20,
  "closedDeals": 200,
  "holdings": 200,
  "securities": 200,
  "debtFacilities": 200,
  "ownershipInterests": 200,
  "coverageFacts": 400,
  "metricSeries": 200,
  "metricObservations": 1000
}
```

## Measured Postgres operations

| Operation | Samples | p50 ms | p95 ms | max ms | p95 guardrail ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| company lookup/search | 12 | 5.78 | 9.2 | 9.2 | 1000 |
| Company projection | 12 | 124.66 | 140.18 | 140.18 | 3500 |
| Fund/portfolio projection | 12 | 121.76 | 135.51 | 135.51 | 4000 |
| bounded traversal | 12 | 0.68 | 0.71 | 0.71 | 100 |
| historical/as-of projection | 12 | 121.92 | 135.1 | 135.1 | 4000 |
| ownership closed-world as-of | 12 | 3.28 | 3.59 | 3.59 | 1000 |

PostgreSQL met all measured guardrails. The evidence does not justify a graph database, bakeoff, or dual-write.

## Migration

Fresh database: **PASS_INTEGRATION**. Populated 0138 to 0139 upgrade: **PASS_INTEGRATION**. Existing Company, Person, and Strategy identities were preserved; no Phase 4 business row or pre-baseline history was fabricated.
