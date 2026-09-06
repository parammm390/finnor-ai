# FINNOR Phase 2 — Private Equity execution graph certification

Date: 2026-09-05
Scope: backend only; signed LOI → diligence → financing → documentation → conditions → verified close.

## Result

Phase 2 is implemented as a vertical-owned, tenant-scoped canonical transaction graph.  The PE package and database boundary now make a false close fail closed.  The focused Phase 2, upgrade, Water/Core, authority/security, type, migration, and release-contract checks described below passed.  The whole-repository suite still has unrelated/non-PE failures; this report does not call that suite green.

## Audit baseline (before Phase 2 edits)

- Repository: `/Users/paramdave/Desktop/FINNOR`; backend: `/Users/paramdave/Desktop/FINNOR/finnor-os`.
- Starting branch: `codex/p3-epistemic-runtime`.
- Starting commit: `181fbb039efb6fda8b23bec500b175a17fd0e07e`.
- Starting tree: `af35de304735674e90a0019e54f45cc46a328070`.
- The backend worktree was clean at the start of this implementation; the repository root also contained unrelated pre-existing dirty/untracked release and evidence work, which was preserved.
- The actual migration head/tracker was `0102`; earlier migration files existed through `0103`, but no `0104`/`0105` PE boundary/graph migrations existed.
- There was no persisted tenant vertical identity, explicit `none`, runtime vertical registry, or canonical-truth registry.  There was no PE package or PE execution graph.
- Water was an active existing vertical with its tables/actions/jobs/source mappings and tests.  It was not retired.
- Therefore the audit did not find a completed, runtime-enforced PE0 disposition ledger or PE1 Core ↔ Vertical boundary.  Migration `0104` establishes those missing prerequisite contracts from the actual state; it does not claim that an absent prior implementation was complete.

## Core owners reused

No parallel identity, work, document, evidence, or approval systems were created.

- Internal identity: `finnor_os.users` (employee identity) and `finnor_os.org_units` (team identity).
- External identity: `external_organizations` and `external_contacts`, resolved through the existing `PartyRef`/`resolveParty` path.
- Durable execution: `works`, `work_entity_links`, and existing `tasks`.
- Canonical documents: `documents` (including existing content/provenance ownership).
- Canonical evidence: `evidence_sources` and `evidence_source_versions`.
- Temporal/governance: `business_events`, `authority_decisions`, `authority_approval_requests`, `decision_receipts`, existing policy/authority evaluation, and existing Business Effects infrastructure.
- Tenant context/RLS and transaction conventions: the existing `request_tenant_id()` contract, tenant-scoped transactions, composite tenant foreign keys, and existing versioned rows.

## Vertical boundary and registry

`0104_core_vertical_runtime_boundary.sql` adds:

- `vertical_definitions` with `none`, `water`, and `private_equity`.
- `tenant_vertical_assignments` with one versioned, effective identity per tenant. Existing and newly-created legacy tenants default to `water`; `none` is explicit and persisted.
- `canonical_truth_registry`, which is the Phase 0 disposition ledger and the Business Truth Registry: one canonical source table and one deterministic writable owner per entity type.
- Runtime resolution functions for active vertical, canonical entity availability, Work-attachability, tenant ownership, and guarded vertical configuration.
- Work-link enforcement through the registry. Existing Water tables reject writes for `none`/PE tenants through vertical guards.

`0105_private_equity_execution_graph.sql` registers every PE-owned type with writable owner `@finnor/private-equity` and explicit mutation boundary. Work-attachable PE types are Deal, Workstream, Request, Deliverable, Finding, Deal Risk, Milestone, Closing Condition, and Closing Item; relationship-only rows are not Work targets.

## New PE canonical entities

The smallest PE-owned set required by the execution reality is:

1. `pe_deals` — transaction root.
2. `pe_deal_parties` — deal role over a canonical `PartyRef`.
3. `pe_workstreams` — concurrent business execution structure.
4. `pe_requests` — required input from another party/workstream, distinct from Task.
5. `pe_deliverables` — expected business artifact/result, distinct from Document.
6. `pe_findings` — discovered transaction fact.
7. `pe_deal_risks` — PE deal risk derived/linked from findings, distinct from Core policy risk.
8. `pe_finding_risk_links` — explicit Finding → Deal Risk relationship.
9. `pe_dependencies` — typed same-Deal business blockers.
10. `pe_milestones` — business outcomes/dates.
11. `pe_closing_conditions` — contractual/business eligibility conditions.
12. `pe_closing_items` — operational verification items.
13. `pe_document_links` — typed links to Core `documents`.
14. `pe_evidence_links` — typed links to Core evidence sources/versions.

Not created: `TargetCompany`, `Banker`, `Lawyer`, `LenderPerson`, or other duplicate party tables; `DealDocument` content storage; a second evidence database; `DealWork`, `PEObjective`, a diligence/closing workflow runtime, a PE approval subsystem, or a CRM-stage substitute for transaction truth.

## Canonical identity decisions

- Deal target identity is `pe_deals.target_organization_id → external_organizations(tenant_id,id)`. No target-company duplicate row is used.
- Deal parties store `party_type` + `party_id` over employee, team, external organization, or external contact identity. The role is deal-local (`buyer_sponsor`, `target_management`, `seller`, `sell_side_banker`, `lender`, buyer/seller counsel, QoE, tax, commercial, technology, insurance, or bounded `other`). Cross-tenant and inactive PartyRefs fail closed.
- Signed LOI truth is required on the Deal (`signed_loi_at`) and can additionally point to the canonical Core Document (`signed_loi_document_id`); creation links that document as the governing LOI relationship.

## Graph relationships

The graph is relational, not a JSON blob. Composite `(tenant_id, deal_id, id)` foreign keys and scope triggers keep every PE child in one authenticated tenant and one Deal. The PE graph projection (`pe_deal_graph_nodes`/`pe_deal_graph_edges`) and `loadDealExecutionGraph` expose Deal, target, parties, workstreams, requests, deliverables, findings, risks, dependencies, milestones, conditions, items, documents, evidence, Work, Tasks, Business Events, authority decisions, approval requests, and receipts.

- Work path: existing `work_entity_links`, checked against `canonical_truth_registry`; `attachWorkToDealGraph` attaches one Core Work to Deal/Workstream/Request/Finding/Risk/ClosingCondition/ClosingItem (and other registered PE objects) without a PE Work subsystem. Existing Task remains a Core Task and is linked by its PE subject where applicable.
- Document path: `pe_document_links` points to Core `documents`, with explicit source/submission/accepted/rejected/superseded/governing/verification roles and same-endpoint supersession checks.
- Evidence path: `pe_evidence_links` points to Core `evidence_sources` and optional `evidence_source_versions`, with `supports`, `verifies`, or `authorizes` relationship. No P3 contradiction/freshness/ranking logic is included.
- Authority path: waiver/close/termination references point to existing `authority_decisions`, `authority_approval_requests`, and `decision_receipts`; selection or a role label is not treated as authority.

## State machines and transition guards

All lifecycle transitions have dedicated repository methods and database transition triggers. There is no public generic `setStatus` mutation. Terminal state rows cannot be rewritten; every non-idempotent transition increments `version` and records timestamps/provenance.

| Entity | Allowed transitions |
| --- | --- |
| Deal | `active → closed` or `terminated` |
| DealParty | `active → removed` |
| Workstream | `not_started → active/cancelled`; `active → complete/cancelled` |
| Request | `open → acknowledged/fulfilled/cancelled`; `acknowledged → fulfilled/cancelled` |
| Deliverable | `expected → received/superseded/cancelled`; `received → accepted/rejected/superseded/cancelled`; `rejected → received/superseded/cancelled`; `accepted → superseded` |
| Finding | `open → resolved/accepted/superseded`; `resolved/accepted → superseded` |
| Deal Risk | `open → mitigating/resolved/accepted`; `mitigating → resolved/accepted` |
| Milestone | `pending → achieved/cancelled` |
| ClosingCondition | `open → evidence_pending/satisfied/waived/failed`; `evidence_pending → satisfied/waived/failed` |
| ClosingItem | `open → ready/cancelled`; `ready → verified/cancelled` |

Overdue Request and late Milestone are derived reads (`due_at`/`target_at` plus current state), not persisted mutable states. Request acknowledgement is separate from fulfilment. Deliverable receipt is separate from acceptance. `ready` is separate from `verified`. A required Workstream cannot complete while mandatory Requests, Deliverables, Findings, Risks, or unresolved blockers remain.

Evidence/document support is required by default to satisfy a ClosingCondition and verify a ClosingItem. Deliverable acceptance requires an explicitly accepted canonical Document link by default. Request fulfilment can require an accepted Deliverable. Findings and risks retain identity/history when resolved, accepted, or superseded.

## Dependency model

`pe_dependencies` has one relation, `blocks`, with bounded endpoint types:

`pe_workstream`, `pe_request`, `pe_deliverable`, `pe_finding`, `pe_deal_risk`, `pe_milestone`, `pe_closing_condition`, `pe_closing_item`.

Self edges are rejected. Endpoint tenant and Deal are resolved at the canonical write boundary. A per-Deal advisory transaction lock (`hashtextextended('pe_dependency:' || deal_id, 0)`) serializes edge mutation, and a recursive reachability check rejects two-node and longer cycles before commit. An unresolved blocker also prevents a downstream positive completion transition. Cross-Deal and cross-tenant edges fail with no partial relation.

## Close eligibility and the single close owner

`evaluateDealCloseEligibility`/`pe_evaluate_deal_close_eligibility` returns structured deterministic truth: `eligible`, Deal/version/graph version, blocking conditions, failed conditions, unverified Closing Items, blocking dependencies, invalid waivers, signed-LOI presence, and integrity errors. Eligibility is true only when:

1. the Deal is `active`;
2. signed-LOI truth exists;
3. every required ClosingCondition is `satisfied` or has valid governed `waived` proof;
4. no required condition is `open`, `evidence_pending`, or `failed`;
5. every required ClosingItem is `verified`;
6. no unresolved hard blocker reaches a required closing condition/item;
7. waiver authority/receipt proof is current and valid where approval is required; and
8. all rows are in the authenticated tenant and exact Deal snapshot.

The only close mutation is `declareDealClosed` in `@finnor/private-equity`, calling the `SECURITY DEFINER` SQL boundary `pe_declare_deal_closed`. It locks the Deal row, rejects missing/stale version or graph-version inputs, re-evaluates current eligibility, validates current Core authority, updates `status`, `actual_close_at`, authority/receipt references, and version atomically. The Deal trigger rejects any other `active → closed` write. The history trigger emits exactly one append-only `pe_deal_closed` event; a unique event index and explicit already-closed response make retries idempotent. Termination has the analogous governed `terminateDeal` boundary.

## Concurrency and temporal truth

PE writes use the existing tenant transaction boundary at `SERIALIZABLE` isolation with bounded retries for serialization/deadlock errors. Deal-root locking serializes child creation and close; lifecycle transitions lock the Deal and entity row and require expected `version`; graph maintenance uses `graph_version`; dependency writes use the per-Deal advisory lock. The SQL close/terminate functions fail closed when either expected version is NULL. This prevents a stale close from committing after a concurrent condition mutation or newly-required closing object.

Every consequential PE insert/update emits an append-only Core `business_events` row through the PE history trigger, carrying before/after state, actor/source, provenance, and relevant evidence/governance references. Direct PE event forgery and update/delete are rejected. `listDealHistory` reconstructs Deal-root history from durable events.

## RLS and isolation

All 14 PE tables use `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with authenticated tenant policies. Composite tenant foreign keys cover Deal children, Parties, Core Documents, authority decisions, receipts, and internal verifier identity. Scope triggers cover polymorphic PartyRef, Document, Evidence, Work, Task, dependency endpoint, vertical, and approval/receipt relationships. PE writes require the tenant's active vertical to be `private_equity`; Water rows reject PE/`none` tenants. A Water tenant cannot resolve PE types, and a PE tenant cannot use Water `technician`, `household`, or `service_visit` semantics.

## Migrations and release artifacts

- `0104_core_vertical_runtime_boundary.sql`: vertical identity, `none`/Water/PE registration, runtime canonical-truth registry, Work-link boundary, Water guards.
- `0105_private_equity_execution_graph.sql`: PE schema, constraints, triggers, event history, dependency graph, eligibility/close/terminate functions, RLS/grants, registry rows, and graph views.
- Migration head is now `0105_private_equity_execution_graph.sql`; the migration bundle was regenerated (`106 migrations`). Existing migrations were not modified.
- The package is `/Users/paramdave/Desktop/FINNOR/finnor-os/packages/private-equity` and is registered through the shared runtime/type aliases; Core does not import PE implementation.

## Deterministic evidence

Commands run against the temporary PostgreSQL 18.4 test server:

- PE state-machine + integration + upgrade: **3 files, 13 tests passed** (10 Phase 2 cases and 3 populated/rollback upgrade cases).
- Fresh database result: the Phase 2 suite ran after creating a new database and applying the complete migration bundle; all **10/10** Phase 2 cases passed.
- Populated database upgrade result: the upgrade suite migrated a database containing pre-existing Water/Core rows, verified the PE head and preserved those rows, reran migration idempotently, and verified rollback leaves no partial PE state; **3/3** passed.
- Fresh Water/Core regression set: **11 files, 42 tests passed**.
- Authority/security gate: **7 files, 41 tests passed**.
- Core/P1–P6 relevant regression result: the focused Water/Dealer Zero, tenant isolation, authority, transaction-serialization, and architecture gates above passed; this is distinct from the repository-wide failures listed below.
- `npm run typecheck`: passed.
- `npm run db:migrate`: already up to date on the final PE database.
- `npm run setup:langgraph`: checkpointer schema ready.
- `npm run policy:lint`: `59/59` registered action types covered.
- `npm run authz:matrix:check`: passed.
- `npm run release:manifest`: fixed spec/discovered registry match `59/59`.
- Seeded `release:contract` evidence in `docs/release/action-contract-results.md`: `59/59` rows PASS, frontend `59/59`, certified fallback mounts `0`; this core harness does not claim live provider credentials.
- App-role graph query against the final fixture returned tenant-scoped graph rows (nodes and edges) including history, authority, approval, and receipt relationships.

The full backend command was also run. It produced **295 passing, 10 failing, 3 skipped test files** and **1,503 passing, 25 failing, 5 skipped tests**. The failures were in broad pre-existing/non-PE agentic/workflow/conversation/cleanup/watchdog/universal-action areas; no PE Phase 2 test failed. Because those failures remain, no global suite-green or global release-certification claim is made. The source-provenance release certification is also blocked by the intentionally dirty starting repository tree; this report preserves that fact.

## Required acceptance outcomes

The deterministic Phase 2 suite covers Atlas-style signed-LOI creation, target identity reuse, DealParty role reuse, six concurrent Workstreams, Request vs Task, acknowledgement/derived overdue, Deliverable vs Document acceptance and supersession, Finding vs Deal Risk, dependency blockers/cycles/cross-Deal rejection, cross-tenant references, evidence-gated conditions, invalid transitions, governed waiver, `ready` vs `verified`, premature/failed/unverified/dependency-blocked close, valid close, duplicate close, stale close race, concurrent condition outcome race, Work attachment, temporal history, PE/Water/`none` isolation, registry/RLS/immutability guards, populated upgrade, idempotent migration, and rollback without partial migration state.

## Residual limitations and Phase 3 boundary

- P3 still owns external-source ingestion, field-level epistemic provenance, contradiction/freshness/source ranking, observation reconciliation, and query/cognition over this graph.
- No frontend was changed.
- No email/calendar/source connector, planner, query plane, automation/chasing/escalation, PE Worker, solver, simulator, fund/LP, or portfolio operating system was built.
- The broad non-PE test failures and dirty-tree source-provenance gate remain release blockers outside this Phase 2 graph implementation and must be resolved before asserting a repository-wide release certification.

Blocked configuration: repository-wide release certification is blocked by the pre-existing dirty/untracked starting tree and the non-PE failures observed in the full run. No Phase 2 PE test failed, and no claim is made that the blocked checks are fixed.

**No Water capability was retired in Phase 2.**

**No PE Data Fabric, PE planner/query cognition, autonomous execution, PE Worker, solver, simulator, Fund/LP system, or portfolio operating system was built in Phase 2.**

**FINNOR now has one canonical signed-LOI → verified-close transaction world that Phase 3 can observe and reason over.**
