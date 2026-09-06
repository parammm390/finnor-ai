# FINNOR Phase 3 — Private Equity truth + cognition certification

Date: 2026-09-05
Scope: backend only; no frontend or provider-connector rollout.

## Audit baseline

- Repository: `/Users/paramdave/Desktop/FINNOR`; backend: `/Users/paramdave/Desktop/FINNOR/finnor-os`.
- Branch: `codex/p3-epistemic-runtime`.
- Phase 3 starting commit: `c46e4e97ff250f53e6fcf20b7bfac5475a9a0b97`.
- Phase 3 starting tree: `e401206542f6666b947bcc6a81102da96819f355`.
- The parent repository contained unrelated dirty/untracked release, evidence, and configuration files. They were preserved and are not part of the Phase 3 commit.

The starting tree was verified to contain the PE0/PE1/PE2 runtime now in use: migration `0104_core_vertical_runtime_boundary.sql` provides versioned vertical identity and the canonical-truth/Work registry; migration `0105_private_equity_execution_graph.sql` provides the PE2 graph, guarded state machines, dependency graph, evidence/document links, and close eligibility. The Phase 2 report records that those migrations established prerequisite contracts that were absent in the earlier audited state; this report does not infer separate historical commits that are not present.

## Existing owners reused

There is one truth/evidence/query/planner path:

| Responsibility | Existing implementation used by Phase 3 |
| --- | --- |
| Canonical PE truth | `@finnor/private-equity` repository/state machines and `evaluateDealCloseEligibility` |
| Vertical/ownership boundary | `vertical_definitions`, `tenant_vertical_assignments`, `canonical_truth_registry` (0104/0105) |
| Source observations | `CanonicalSourceRecord`, `external_refs`, `materializeSourceRecord` in `@finnor/data-platform` |
| Evidence | Core `evidence_sources`/`evidence_source_versions` and append-only evidence APIs in `@finnor/memory` |
| Epistemic state | Core `@finnor/epistemic-runtime` (`EvidenceRecord`, propositions, freshness, conflicts, uncertainty, requirements) |
| Operational reads | Existing `@finnor/read-models` plane plus the tenant-aware dispatcher in `orchestration/src/operational-query-runtime.ts` |
| Context/planning | Existing Operating Context assembly and `LLMPlanner`; no PE-specific context or planner was created |

No second truth engine, evidence store, query engine, planner, or PE fact table was added.

## Bounded PE proposition catalog

The exact 20 predicates are published by `PE_PROPOSITION_PREDICATES` and receive deterministic IDs of the form `pe:v1:<deal>:<entity-type>:<entity>:<predicate>`:

`deal.exists`, `deal.loi_signed`, `deal.target_close_at`, `deal.lifecycle_state`, `workstream.state`, `request.acknowledged`, `request.fulfilled`, `request.overdue`, `deliverable.received`, `deliverable.accepted`, `finding.current`, `deal_risk.current`, `dependency.resolved`, `milestone.achieved`, `closing_condition.state`, `closing_condition.evidence_sufficient`, `closing_condition.waiver_valid`, `closing_item.ready`, `closing_item.verified`, `deal.close_eligible`.

Canonical graph rows and the PE2 eligibility result become `CANONICAL_DB` evidence through `canonicalOperationalQueryEvidence`. The mappings are exact: `closing_condition.evidence_sufficient` is canonical `true` only when evidence is not required or the condition state is `satisfied`; `closing_item.verified` is canonical `true` only for exact state `verified` (state `ready` remains distinct); `deal.close_eligible` is the result of the existing PE2 eligibility function. A linked Document or Evidence row does not promote either proposition by itself.

Provider observations, Document claims, and explicit user input use the Core evidence constructors and remain non-canonical assertions. Memory and public-web assertions are not admitted as proof of an internal Deal proposition. Canonical winners retain lower-authority contradictory evidence and its warning projection. Confidence remains the Core bounded evidence classification; no probability or model self-confidence is generated.

## Source Truth and evidence paths

- `CanonicalSourceRecord.materialization = "observe_only"` is used by the provider-neutral PE mapper. Source Truth still performs exact identity, tenant/vertical availability, ordering, observed-hash, conflict, reconciliation, and tombstone handling; it never invokes a PE lifecycle mutation for an observe-only record.
- An acknowledgement calls the existing `external_refs` acknowledgement path only. The receipt records the external identity and acknowledgement state; it does not create an observation, canonical transition, or verified proposition.
- A provider observation is capped at 100 typed claims, mapped to one exact Deal/entity, recorded with source version/sequence/time, and materialized as an immutable Core EvidenceSource/version. Duplicate content uses the existing evidence content-hash idempotency; an older sequence is rejected; a changed payload at the same provider position opens a Source Truth conflict/reconciliation case; an observe-only tombstone does not emit a canonical business event.
- A Document claim requires an exact active `pe_document_links` row for the authenticated Deal/entity. It creates an immutable `pe_document_claim` evidence source/version and attaches it to the PE evidence link; extracted text cannot transition PE2 state.
- Optional freshness requires an explicit `freshnessPolicyRef` whenever a maximum age is supplied. The Core runtime evaluates freshness, conflict, supersession, provenance, and uncertainty; Phase 3 adds no arbitrary default age.

## Decision requirements and acquisition

`buildPrivateEquityEpistemicSnapshot` emits Core `DecisionRequirement` records for the four PE decision types: `closing_condition_satisfaction`, `closing_item_verification`, `deal_close`, and `request_fulfillment`. Requirements are mandatory, accept only `KNOWN` values at their configured authority/confidence, and carry exact proposition IDs plus bounded acquisition options.

The existing adapter seams used are `CANONICAL_OPERATIONAL_QUERY`, `EVIDENCE_CORPUS_RETRIEVAL`, `SOURCE_TRUTH_OBSERVATION`, `CLARIFICATION_REQUEST`, and `WORK_EVENT_WAIT`. P4 receives `ready`, unresolved proposition IDs, and these acquisition options; Phase 3 does not execute them autonomously.

## PE Operational Query Plane

The unified tenant-aware dispatcher registers exactly these PE intents:

`deal_context`, `deal_workstreams`, `open_requests`, `open_findings`, `open_deal_risks`, `critical_dependencies`, `closing_readiness`.

All requests derive tenant identity from the authenticated executor and reject a request-supplied `tenantId`. Deal resolution accepts exact Work anchors first, then an explicit UUID/name only when it resolves deterministically. PE pages default to 50 rows and clamp at 100; cursors contain intent, Deal, and graph version and fail closed when stale.

- `deal_context` returns a bounded Deal/target/lead summary, state counts, active Work references, and epistemic warnings.
- `deal_workstreams` returns canonical Workstreams with exact state/owner filters and deterministic dependency-derived blocking.
- `open_requests` returns only canonical `open`/`acknowledged` Requests and derives overdue from canonical data; fulfilled/cancelled rows are excluded.
- `open_findings` and `open_deal_risks` remain separate and include evidence references plus entity-level/top-level epistemic warnings.
- `critical_dependencies` walks the PE2 dependency graph with bounded depth and returns exact blocker/blocked nodes, states, due dates, owners, Work references, and paths—no score or solver.
- `closing_readiness` reuses `evaluateDealCloseEligibility`; it returns canonical blockers, unverified items, dependencies, invalid waivers, integrity errors, relevant findings/risks, epistemic warnings, decision readiness, and a query trace. It does not reimplement or override close rules.

## Operating Context, planner, and vertical isolation

Deal-rooted Operating Context resolves the active Deal, Workstream, ClosingCondition, bounded canonical summaries (`deal_context` and `closing_readiness`), and epistemic warnings through the existing context assembler. Work anchors outrank NLP inference. Water household resolution is restricted to Water/legacy contexts; PE contexts do not acquire Water household/inventory fields.

The existing planner receives PE doctrine covering Deal, Workstream, Request, Deliverable, Finding, DealRisk, Dependency, Milestone, ClosingCondition, and ClosingItem, including the distinctions `ready ≠ verified`, `acknowledged ≠ observed`, `observation/evidence ≠ canonical truth`, `Document ≠ Deliverable`, `Finding ≠ DealRisk`, `Task ≠ Request`, and `Workstream ≠ Work`. PE-specific planner actions are limited to registered `clarification_request` and `search_web`; no PE mutation action is exposed. Informational PE questions are resolved to the canonical read lane before planner inference. Water retains its existing query registry and planner doctrine; no registry leakage was introduced.

## Deterministic evidence

- `npm run typecheck`: passed.
- `npm run test:unit`: **127 files, 642 tests passed**.
- Focused PE/Core regression (`fast-read-lane`, query routing, adversarial hardening, PE epistemic/planner, PE2/PE3, operational query plane, planner repair, Phase 0 company world, and Jarvis contract): **11 files, 127 tests passed**.
- Direct `tests/integration/private-equity-phase3.test.ts`: **1 file, 4 tests passed**.
- PE epistemic/planner/PE3 targeted run after the final changes: **3 files, 13 tests passed**.
- `DATABASE_URL=postgres://finnor:finnor@localhost:55432/finnor npm run db:migrate`: already up to date; migration head is `0106_private_equity_truth_and_cognition.sql`.

The PE3 integration corpus covers acknowledgement versus observation, canonical immutability, Document evidence, duplicate and out-of-order observations, same-position conflict/reconciliation, tombstones, stale evidence, unknown/contradicted propositions, DecisionRequirements, all seven PE queries, Work read receipts, read-without-mutation, cross-tenant evidence/query rejection, PE/Water query isolation, and Work-anchored question routing.

The repository-wide integration sweep is **not green**: `npm run test:integration` reported **12 failed, 156 passed, 2 skipped files** and **28 failed, 826 passed, 4 skipped tests**. The observed failures were in unrelated legacy/shared-database concurrency, cleanup, locking, and timeout areas; the direct PE3 integration and focused PE/Core regression remained green. This report makes no whole-repository green claim.

## Residual limitations and Phase 4 handoff

- No real DealCloud, Datasite, Intralinks, CapIQ, PitchBook, Microsoft 365, Gmail, or other broad PE connector was required or implemented; proof uses deterministic synthetic observations and existing Core Document infrastructure.
- The bounded query projections cap returned rows and planner context. The current consistency read loads the Deal graph before projection; a future scale pass can add database-level child-row limits without changing the contracts.
- PE planner actions remain read/clarification/public-research only. There is no PE Worker, autonomous chasing/escalation, action fabric, solver, simulator, portfolio system, Fund/LP system, or playbook learning.
- Repository-wide release certification remains blocked by the pre-existing parent-worktree dirt and the unrelated integration failures above; those files were not mixed into this Phase 3 change.

**No Water capability was intentionally retired in Phase 3.**

**No broad PE connector/Data Fabric rollout was built in Phase 3.**

**No autonomous PE execution, PE Worker, solver, simulator, portfolio system, Fund/LP system or playbook learning was built in Phase 3.**

**FINNOR can now distinguish canonical Deal truth from evidence, uncertainty, staleness and contradiction, and its PE cognitive/read path consumes those distinctions deterministically.**
