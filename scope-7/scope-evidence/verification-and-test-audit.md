> Historical original-worktree audit, retained for provenance. Current publication scope, base, migration and verification are recorded in [publication-audit.md](publication-audit.md); original final pins are in prepublication-final-source-manifest.json.

# S7 repeatable verification and test audit

Current selected artifacts and exact hashes are in `final-source-manifest.json`; gate disposition is in `completion-closure.json`. Every selected result is PASS, source-frozen, and matches the current candidate. Rerun from `/Users/paramdave/Desktop/FINNOR/finnor-os` into a **new** evidence directory with the commands below. These are real owner/API/process E2E challenges plus preregistered isolated inference falsifications, not newly written unit tests.

| Run | Cases | Exact command |
| --- | ---: | --- |
| statistical-qualified | 17 | `FINNOR_S7_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s7/run-statistical-e2e.mts` |
| protected-qualified | 4 | `FINNOR_S7_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s7/run-protected-e2e.mts` |
| owner-notices-qualified | 8 | `FINNOR_S7_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s7/run-owner-e2e.mts` |
| integrated-notices-qualified | 10 | `FINNOR_S7_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s7/run-integrated-e2e.mts` |
| maturity-qualified | 1 | `FINNOR_S7_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s7/run-maturity-e2e.mts` |

Native runners create temporary PostgreSQL databases and local signed ledger processes, apply the existing migration chain with the existing explicit test-only managed-extension omission, use real ordinary `finnor_app` transactions, and clean up their processes. The API uses the existing nonproduction auth bypass; role/tenant/principal behavior and ordinary SQL RLS are exercised, but production JWT issuance/provider configuration is not certified. No new production seam was introduced for these tests. Test signing keys commission only disposable generated observations; they cannot create field credit or production authority. Final artifacts save submitted accounting/assignment/preregistration data, exact received receipts, lawful native cuts, independent SQL readbacks, source hashes, failures, resource usage and rerun commands. Statistical generators save seeded potential truth through their source/version and independently score assignment vectors; trusted descriptor fixtures are restricted to the isolated mathematical checks.

Four authoring-gate answers apply to every case listed below: (1) the case name identifies its distinct observable contract, with actual inputs and observed outputs in the result artifact; (2) the credible regression is accepting its tampered/missing/stale input or miscomputing the independently known outcome, draw, coverage or conservation result; (3) prior tests did not own S7 estimand/credit semantics, while separated math/process/SQL tests reach distinct inference, crash/authority and storage risks that one API happy path cannot prove; (4) the cases use actual production owners or exported production arithmetic contracts, without test-only exports/flags/hooks. Preregistered Monte Carlo parameter cells exercise distinct zero/positive/negative effect and independent-cluster size domains; they are one calibration family rather than redundant happy paths. Detailed failure models were recorded before isolated implementation in `test-audit-plan.md` and `final-domain-failure-model.md`.

| Primary owner/run | Retained observable case |
| --- | --- |
| statistical-qualified | `exact-256-assignments-effect-0` |
| statistical-qualified | `exact-256-assignments-effect-30` |
| statistical-qualified | `exact-256-assignments-effect--30` |
| statistical-qualified | `observational-confounding-never-becomes-positive-credit` |
| statistical-qualified | `informative-missingness-retains-adverse-cohort` |
| statistical-qualified | `financial-conservation-independent-statement-oracle` |
| statistical-qualified | `interacting-contingent-regime-is-not-additive-action-credit` |
| statistical-qualified | `unsupported-interference-and-horizon-forgery-cannot-earn-H2` |
| statistical-qualified | `registered-looks-wide-support-and-budget-refusals` |
| statistical-qualified | `self-value-missing-cost-and-duplicate-items-do-not-become-wealth` |
| statistical-qualified | `registered-medium-population-compute-domain` |
| statistical-qualified | `monte-carlo-24-0` |
| statistical-qualified | `monte-carlo-24-30` |
| statistical-qualified | `monte-carlo-24--30` |
| statistical-qualified | `monte-carlo-64-0` |
| statistical-qualified | `monte-carlo-64-30` |
| statistical-qualified | `monte-carlo-64--30` |
| protected-qualified | `s7-h2-exact-immutable-commitment` |
| protected-qualified | `foreign-owner-h2-cannot-borrow-s7-permission` |
| protected-qualified | `s7-detail-cannot-borrow-other-subject-digest` |
| protected-qualified | `restart-exact-history-and-tenant-refusal` |
| owner-notices-qualified | `authenticated-native-register-and-sql-independent-readback` |
| owner-notices-qualified | `immutable-read-and-concurrent-idempotent-semantic-retry` |
| owner-notices-qualified | `unprotected-retrospective-owner-attribution-retains-all-unknowns` |
| owner-notices-qualified | `late-correction-keeps-original-and-knowledge-cut` |
| owner-notices-qualified | `commit-after-cut-cannot-be-backdated-into-economic-history` |
| owner-notices-qualified | `tenant-principal-role-and-HTTP-evidence-authority-attacks` |
| owner-notices-qualified | `same-tenant-principal-isolation-at-ordinary-SQL-boundary` |
| owner-notices-qualified | `post-assignment-question-cannot-be-called-prospective` |
| integrated-notices-qualified | `protected-prospective-question-and-S2-owned-law` |
| integrated-notices-qualified | `S2-independent-draws-concurrent-retry-and-no-rerandomization` |
| integrated-notices-qualified | `signed-financial-joins-and-generated-programme-ITT-not-field-H2` |
| integrated-notices-qualified | `authentic-but-unrelated-money-is-rejected-as-economic-support` |
| integrated-notices-qualified | `company-portfolio-and-S8-readback-preserve-uncertainty-no-action-reward` |
| integrated-notices-qualified | `atomic-owner-record-origin-rollback` |
| integrated-notices-qualified | `S7-full-source-manifest-survives-event-bound` |
| integrated-notices-qualified | `native-benchmark-keeps-required-unrun-and-H1-comparisons-inconclusive` |
| integrated-notices-qualified | `late-economic-notice-cannot-be-ignored-by-fresh-assessment` |
| integrated-notices-qualified | `late-invalidation-retained-and-propagated-to-S8` |
| maturity-qualified | `preendpoint-source-cannot-become-field-H2-through-age-or-labels` |

Retained pre-fix evidence: `protected-detail-regression` (wrong subject detail accepted), `owner-native-read-regression` (FOR SHARE in read-only transaction), prior native commit-cut/replay failures, `principal-sql-regression` (same-tenant peer SQL access), `maturity-temporal-regression` (pre-endpoint evidence became H2), `statistical-final` (medium input exhausted Ring-0 node bound), `late-cost-regression` (two benchmark event dependencies absent), `late-cost-semantic-regression` (actual new adverse invoice silently ignored), and `integrated-final` (recursive-history 413 on subsequent assessment). No meaningful case or registered threshold was removed, skipped or narrowed to obtain green. Original fixture protocol/identity/bootstrap/window failures remain recorded separately from production defects. The final repairs passed at the owning boundary in the selected current-source runs.

Repository checks: `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/tsc -p scripts/s7/tsconfig.json`, `npm run authz:matrix:check`, and `npm run PE-DOMAIN-BOUNDARY` passed with their captured logs. Existing upstream arithmetic tests passed 37 tests/three files and outcome/epistemic/learning consumers 19 tests/four files; their exact logs are `upstream-arithmetic.log` and `upstream-consumers.log`. Broad unrelated suite repetition was avoided after focused checks passed.

Review provenance: the full OpenClaw test-audit instructions were retained with their MIT license at source commit `a30e6c86356a416a7802671089e0a0bff34e04ce`. Unavailable OpenClaw runners/crabbox/autoreview were replaced by verified installed FINNOR CLI/TypeScript/Vitest/SQL/separate-process mechanisms, not a fabricated automated approval. The user's stop-subagents request revoked the planned independent agent final review. Root performed source attacks alone. Independent oracles/processes corroborate their bounded contracts but do not constitute a separate human/code-review approval. No production release or genuine field completion is asserted.

Operational limitations: Node v22.18.0 scored final runs; start snapshot v22.22.3 is historical, not substituted. Next 15.5.25's requested bundled guide directory is absent; existing installed source/types and the actual imported route contract were followed and typechecked. Managed database extensions, production JWT/authority custody, real providers, full maximum-size native source/record combinations and mature economic evidence remain unverified. Local measured CPU/RSS/time does not bill human/provider/development costs or certify S5 production quotas. Preserve UNKNOWN rather than assigning zero.
