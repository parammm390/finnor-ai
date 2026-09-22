# Scope 5 audit and closure ledger

This ledger describes the current working tree, not the older P3 architecture
contract. A status is changed only after inspecting code, migration, and test
evidence. `REMAINING` is never treated as a release pass.

## Milestone A — two independent audits and ownership freeze

Status: COMPLETE for the code audit; REMAINING for implementation and release.

### Audit Pass 1: epistemic runtime

| Subsystem | Actual owner and production behavior | Decision |
| --- | --- | --- |
| Proposition definition and identity | `packages/epistemic-runtime/src/contracts.ts` and `state.ts` define the model. PE constructs stable semantic IDs in `packages/private-equity/src/epistemic.ts`; P2-derived IDs in `uncertainty.ts` are planning-scoped. No durable graph version exists. | EXTEND |
| Evidence and canonical truth | `belief-update.ts` retains immutable in-process `EvidenceRecord` objects. `context-adapter.ts` and PE `epistemic.ts` reconstruct them from OperatingContext or canonical PE reads. Source Truth's `evidence_source_versions` and PE canonical tables own persisted observations. `canonicalTruth` is a distinct in-memory selection projection. | EXTEND; never duplicate source bytes or canonical values |
| Precedence, freshness, confidence, conflicts | `source-precedence.ts` orders truth classes; `belief-update.ts` selects evidence, derives heuristic confidence/freshness, and retains conflicts. Freshness depends on the supplied clock but has no indexed durable due time. | KEEP semantics, EXTEND timing/indexes |
| Dependencies and transitions | `state.ts` creates proposition dependencies in memory. `belief-update.ts` performs full global passes and records process-local status transitions. No persisted dependency lookup, ChangeSet, or durable frontier exists. | EXTEND |
| Uncertainty and acquisition | `uncertainty.ts`, `information-actions.ts`, `scoring.ts`, `controller.ts`, and `p2-handoff.ts` are deterministic but the controller loop and budget live in memory. `shadow.ts` returns the authoritative planner result unchanged. No production call to `runEpistemicShadow`, `runEpistemicController`, or `resolveP2WithInformation` was found outside package/test paths. | KEEP pure contracts; DEFER new workflow owner; use Work/Wait for durable acquisition |
| Redaction and replay | `trace.ts` creates structured redacted traces and an adapter. No production call of the adapter was found. Read-model Causal Replay is the persisted projection owner. | EXTEND projection only |
| Production PE use | `private-equity/src/operational-queries.ts`, `world-state.ts`, and `domain-plugins/private-equity/index.ts` rebuild snapshots. The plugin uses a decision-readiness result during grounding. There is no execution-time persisted proposition/version recheck. | REFACTOR hot path and gate |
| Regression oracles | Full recompute tests, property tests, locked corpus, and `architecture/p3/epistemic-runtime-contract.json` encode existing P3 semantics. | KEEP |

### Audit Pass 2: business dependencies from the Phase-4 world

| Object | Exact currently persisted relationship | Impact eligibility |
| --- | --- | --- |
| Claim | `world-state.ts` maps epistemic propositions into Claim projections; no Claim table. | Proposition identity and evidence refs only |
| Thesis, InvestmentCase, Assumption, Decision | `0111_pe_world_truth.sql` persists case and assumption membership and decision truth. It has no exact Claim-to-Assumption support edge. Shared case membership or chronology is insufficient. | Explicit links must be added before direct Claim impact |
| Underwriting inputs/nodes/runs/sensitivities | `0126_pe_underwriting_runtime.sql` persists `underwriting_model_input_bindings` to an exact Assumption or EvidenceVersion; model definition owns node lineage; runs and sensitivities pin model/input snapshots. | Exact bindings and model graph; historical runs stay immutable |
| Finding and Risk | `0105_private_equity_execution_graph.sql` persists `pe_evidence_links` and `pe_finding_risk_links`. | Exact evidence and finding links only |
| Closing condition and item | `pe_evidence_links`, `pe_document_links`, and `pe_dependencies` persist precise endpoints. | Exact typed links only |
| IC question, condition, memo, recommendation, decision | `0127_pe_actions_ic_runtime.sql` persists typed `pe_ic_source_links`, frozen proposals, run refs, and `pe_ic_decision_links`. | Exact links; prior votes, runs, and final decisions remain historical |
| Work and PlanRevision | Work entity links and `work_plan_revisions` pin Work/plan context, while `0136_scope1_orchestration_kernel.sql` owns recovery. A shared Deal alone does not prove a Work node dependency. | Only explicitly pinned node/source refs |
| Phase-4 Fund/Vehicle/holding/ownership/debt/metric/benchmark/outcome/coverage | `0139_scope4_pe_digital_twin.sql` owns bitemporal canonical rows and exact EvidenceVersion refs. `pe_fact_coverage` distinguishes exhaustive absence from missing data. | Exact source/binding refs; no parallel canonical copies |

### Frozen ownership

Canonical PE and Phase-4 Digital Twin own business truth; Source Truth owns
observations and immutable source evidence; Epistemic Runtime owns propositions,
belief, uncertainty, and causal impact facts; Underwriting owns deterministic
calculation and run history; IC owns process/decisions; Work/Planning own recovery;
Authority owns execution permission; BusinessEffect owns consequential effects;
Company Brain and Causal Replay are read projections.

### Audit-specific risks to resolve

1. `belief-update.ts` performs full recomputation even for a single evidence row;
   per-request PE snapshots are ordinary production reads.
2. The current `asOf` does not independently fence knowledge time and business
   valid time. A late correction can leak into an earlier replay without a fix.
3. No transaction currently couples a source/canonical mutation to accepted
   epistemic processing. A notification-only solution would lose changes.
4. Existing PE action grounding checks epistemic readiness before execution;
   execution can use a stale grounding unless the existing execution boundary
   revalidates exact mandatory dependencies and versions.
5. No durable graph, materiality/impact path, baseline, calibration history, or
   controlled shadow-to-active activation exists at migration head
   `0139_scope4_pe_digital_twin.sql`.

## Milestone reconciliation

| Milestone | State | Code/migration/test proof |
| --- | --- | --- |
| A: audits and ownership | COMPLETE | File references above; production caller search and migration inventory |
| B: semantic incremental runtime | COMPLETE for pure evaluation; durable hot-path loading remains C | `packages/epistemic-runtime/src/belief-update.ts` keeps `appendEvidenceAndRecompute` as the oracle and adds `appendEvidenceIncrementally`; `state.ts` rejects cycles and unknown edges; `private-equity/src/epistemic.ts` and `context-adapter.ts` use incremental evaluation. `incremental.test.ts` covers exact semantic comparison, unrelated work avoidance, duplicate behavior, freshness propagation, bitemporal correction, randomized delivery, and cycles. Focused P3/PE tests: 47 passed; new tests: 6 passed; typecheck passed. |
| C: durable change capture, graph, and processing | COMPLETE for repository implementation; adversarial certification REMAINING | `0140_scope5_epistemic_impact.sql` adds tenant-scoped graph versions, source bindings, atomic capture/queue triggers, immutable changes/ChangeSets, bounded frontier, and structural epoch fencing. `epistemic-runtime/src/durable.ts` stages, baselines, processes, replays and compares the graph; worker protocol 2 handles change, freshness, recovery and graph refresh. Fresh embedded PostgreSQL smoke applied 139 migrations through 0140, processed a source version to one ChangeSet, and full-oracle comparison matched 1/1. Restart/concurrency/property tests remain to be run. |
| D: exact downstream impact and governed execution | COMPLETE for implemented paths; end-to-end certification REMAINING | `durable.ts` follows exact persisted links only and records redacted impact paths; PE grounding pins mandatory propositions to a PlanRevision/PlanNode; orchestration preflight and PE's final owner transaction revalidate under tenant advisory lock 5141. Newly relevant unbound PE canonical/evidence sources advance a structural epoch in the source transaction, enqueue graph refresh, and block active high-risk execution until a rebuilt graph is shadow-compared and explicitly reactivated. `read-models/src/causal-replay.ts` projects exact Work Plan impact paths into existing read-only Causal Replay. No downstream business effect is written by epistemics. Proof currently consists of typecheck and fresh DB smoke; pinned execution, structural refresh, and replay integration still need focused DB tests. |
| E: migration, adversarial tests, benchmark, and release certification | COMPLETE for repository-controlled local integration; staging/live BLOCKED_EXTERNAL | `scripts/release/run-scope5-epistemic-impact-certification.ts` and `docs/release/scope5-epistemic-impact-certification.json` pass 18 embedded-PostgreSQL/incremental gates; see the final reconciliation below. |
| Staging/live verification | BLOCKED_EXTERNAL until exact environment evidence is produced | — |

## Milestone D reconciliation — 2026-09-21

The complete blueprint and production-closure addendum were reread before this
reconciliation. `npm run typecheck` passed after the durable graph, execution,
calibration, structural-fence and replay edits. `scripts/release/.scope5-db-smoke.ts`
applied all 139 migrations to fresh embedded PostgreSQL, baselined a graph,
accepted a source version in the source transaction, processed it to an immutable
ChangeSet, and matched the independent full oracle. `npm run db:bundle` rebuilt
the serverless migration bundle through `0140_scope5_epistemic_impact.sql`.

Still REMAINING: populated 0139→0140 upgrade proof; PE graph fixture and derived
semantic equivalence; actual Plan pin and final-transaction race proof; graph
refresh proof; Causal Replay query proof; decision/outcome calibration proof;
restart/duplicate/concurrent/out-of-order tests; performance corpus; Scope 1–4
and Phase-15A regressions; final repository re-audit; focused certification
command and reports. Staging and live cutover remain BLOCKED_EXTERNAL until
environment-specific evidence is available. No deployment or operational
activation is claimed by local smoke results.

## Milestone E reconciliation — 2026-09-22

The complete Phase-5 blueprint and production-closure addendum were reread
after local integration. These statuses describe the current working tree and
the checked reports, not a staging or live deployment.

| Requirement group | State | Exact implementation and proof |
| --- | --- | --- |
| Existing semantics, authority and Claim ownership (1–12, 20, 34) | COMPLETE | `packages/epistemic-runtime/src/belief-update.ts` retains the independent full oracle and adds affected-subgraph evaluation; `source-precedence.ts`, `contracts.ts`, `state.ts`, `incremental.test.ts`, the frozen P3 corpus, and the Scope-4 PE epistemic regression preserve categorical confidence, selected evidence, contradiction, provenance, source rank and stable semantic IDs. `private-equity/src/world-state.ts` remains a Claim projection. |
| Durable graph, capture, ChangeSet and concurrency (13–17, 37, 43–46, 48–49) | COMPLETE for local integration | `packages/db/migrations/0140_scope5_epistemic_impact.sql` defines frozen graph/source indexes, tenant FKs/RLS, atomic source-version capture with Scope-3 jobs, ordered durable frontiers and immutable redacted ChangeSets/impact paths. `epistemic-runtime/src/durable.ts` stages, baselines, processes, replays and verifies. Focused certification proves source rollback, one logical ChangeSet under concurrent duplicate delivery, bounded resumed frontier, out-of-order deferral, exact microsecond acceptance ordering, graph epoch fencing, tenant isolation, fresh install and 0139→0140 populated upgrade. |
| Clock, bitemporal and completeness (14–15, 35–36) | COMPLETE for bound source classes | Indexed `next_freshness_at` and `scanDueEpistemicFreshness` enqueue deterministic clock changes. `boundEvidence` fences canonical `recorded_at`/EvidenceVersion `retrieved_at` by `knownAt`, and evaluates business validity independently. Phase-4 `pe_fact_coverage` remains the only closed-world source; a missing row never becomes a negative proposition. Focused `durable-freshness`, `bitemporal-replay`, and `digital-twin-restatement` gates pass. |
| Exact downstream impact and operational safety (18–31, 41–42) | COMPLETE for persisted links; unsupported edges omitted | `durable.ts` follows exact PE evidence/finding-risk links, EvidenceVersion/Assumption Underwriting bindings, model node lineage, IC source/proposal/condition links, and PlanRevision proposition pins. `private-equity/src/epistemic.ts`, `domain-plugins/private-equity/index.ts`, `orchestration/src/durable-execution.ts`, `private-equity/src/repository.ts` and the SQL final gate revalidate mandatory pins before consequential execution. Scope 1 still owns recovery, Scope 2 still owns effects, and Epistemic Runtime writes no canonical Assumption, Decision or UnderwritingRun. `read-models/src/causal-replay.ts` projects the structured path. Focused exact-plan, final-transaction, causal-replay and metric-restatement gates pass. The restatement fixture now creates a valid governed IC Case and two Questions; only the Question with an exact EvidenceVersion source link receives impact, while a same-Deal Question and Decision remain unaffected and the Question history is unchanged. Shared Deal/case membership, text and chronology are not causal edges. |
| Phase-4 Digital Twin integration (19) | COMPLETE for registered canonical rows | `private-equity/src/durable-epistemic.ts` registers all 18 Phase-4 registry types from owner history as bounded source-backed facts; `epistemic.ts` gives each row stable subject/predicate identity. `durable.ts` hashes business fields for the belief projection and follows exact underlying EvidenceVersion refs. A new unbound fact advances the structural epoch in the source transaction; refreshing blocks consequential PE execution until a new graph is baselined, shadow-compared and explicitly activated. `digital-twin-restatement` proves a real metric revision reaches an exact Underwriting input, model nodes and immutable historical run. |
| Information actions and acquisition (32–33) | COMPLETE within existing owners | `epistemic-runtime/src/information-actions.ts`, `controller.ts`, and `p2-handoff.ts` remain read-only deterministic adapters. PE grounding exposes acquisition options for unresolved mandatory requirements, and `orchestration/src/graph/nodes.ts` persists the blocked action as `needs_human_review` in existing Work/Action records. No second epistemic workflow store or direct BusinessEffect path was created. |
| Calibration (39–40) | COMPLETE for explicit comparisons | The final PE Decision trigger in `0140` freezes exact pinned assessment/heuristic/evidence hashes. `epistemic-runtime/src/durable.ts` compares an explicitly named later Phase-4 Outcome/value path, append-only and idempotently; `private-equity/src/durable-epistemic.ts` and `apps/api/app/api/private-equity/calibration/route.ts` expose the tenant-authenticated operation. The `outcome-calibration` gate proves the prior assessment is unchanged. No probability or policy auto-promotion exists. |
| Performance, release and regressions (47, 50–53) | COMPLETE_LOCAL / COMPLETE_INTEGRATION; external layers BLOCKED_EXTERNAL | `npm run release:scope5-epistemic-impact` passes 18 gates and compares eight full-vs-incremental corpus scenarios in `docs/release/scope5-epistemic-impact-certification.json`. `npm run release:scope4-digital-twin` passes 10 integration gates. `npm run release:scope3` passed 75/75 mandatory cases, 100001-job load and nested Scope-1/2/Phase-15A. Separate Scope-2 passed 75/75 and Scope-1 passed 35/35. |

### Final production-path audit

Repository searches found full global recomputation only in the retained
oracle/replay path and test fixtures; PE request snapshots now use incremental
evaluation, and durable source changes use the indexed frontier. No second
Claim, canonical fact, EvidenceVersion, Work, Authority, IC Decision or
BusinessEffect owner was added. Operational changes flow through the existing
planning and PE final mutation boundaries. Source content remains with
canonical/EvidenceVersion owners; ChangeSets, impact paths, calibration and
Causal Replay contain IDs, hashes and structured reasons. Closed-world
coverage and source precedence remain unchanged.

### External gates and bounded limitations

- **Release state:** the isolated `codex/scope5-release` candidate integrates
  prerequisite migrations 0127–0139 and current `origin/main` fixes with the
  Scope-5 implementation. `CODE_COMPLETE` is supported by local integration;
  `RELEASE_READY` still requires a clean commit, canonical PR/merged-SHA gates,
  and the governed release. `LIVE_CERTIFIED` is false until the exact production
  SHA, migration, worker, per-tenant activation and read-only post-cutover
  verification pass.
- **Governed cutover:** `scripts/release/rollout-scope5-production.ts` runs only
  from the canonical production release after Phase-8 readiness. It binds the
  protected database target, exact release SHA, migration head and protocol-2
  worker; performs bounded baseline and full-oracle shadow comparison for
  eligible PE tenants; preserves a preexisting kill switch; activates each
  passing graph; and disables newly activated tenants if a later activation
  fails. `epistemic-impact-activate` is inventoried and OIDC-authorized. The
  focused integration gate proves the kill switch remains set across refresh.
- **Observed production blocker (2026-09-22 UTC):** read-only AWS inspection
  found stack `finnor-production` in `UPDATE_ROLLBACK_COMPLETE` after the
  2026-09-21 release. `WorkerExecutionRole` failed because that GitHub AWS
  session omitted `ecr:DescribeRepositories`; other resource failures were
  cancelled. The release workflow now grants that read in the compute session,
  and preflight/deployer accept the stable rollback state for a governed retry.
  Production API `/api/ready` returned HTTP 503 with migration head 0138 and
  no converged four-class fleet. No production migration, worker deployment,
  Scope-5 activation or live disable verification is claimed from local tests.
  `PASS_INTEGRATION` refers only to disposable PostgreSQL.
- New unbound PE entities temporarily fence consequential PE execution until a
  bounded graph refresh and explicit reactivation. A tenant exceeding the
  10,000-proposition graph cap remains fenced and requires owner-reviewed scope
  reduction.
- No Claim→Assumption, Underwriting→Risk, or shared-Deal→Work causal edge is
  invented. Those downstream objects appear only when their owner persisted
  an exact source, model, risk, IC or Plan pin link.
- The focused certification exercises an owner-validated IC Question source
  link and a same-Deal negative case. Finalized IC proposal→Decision support
  traversal is implemented against persisted links but has no focused
  Scope-5 end-to-end fixture; it is not claimed as integration-certified.
- Historical epistemic state before the explicit Scope-5 baseline is reported
  unavailable. Earlier source/canonical history remains inspectable with its
  owner; no pre-baseline ChangeSet is synthesized.
