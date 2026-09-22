# Phase 4 Company Brain and PE Digital Twin audit

## Scope and method

Two independent passes were completed against production reachable code before the Phase 4 ownership map was frozen. Pass 1 followed persisted owners and mutation paths. Pass 2 started from each required business concept and traced every equivalent identity, role, fact, calculation, history record, projection, API, and consumer. Repository searches covered PE and canonical entity unions, root unions, relationship kinds, source roots, artifact targets, Work references, API schemas, and OpenAPI generation.

The audit baseline was the working tree through migration `0138_scope3_compute_plane.sql`. Migration `0139_scope4_pe_digital_twin.sql` is the forward only implementation of the decisions below.

## Audit Pass 1: current truth owners

| Component | Identity/current truth | Mutation | History/source | Projection/consumer | Decision |
| --- | --- | --- | --- | --- | --- |
| Core organization/person | `external_organizations` / `external_contacts` | Core repositories and exact `PartyRef` resolution | canonical history plus `external_refs` and immutable observations | PE world, parties, Company Brain | **KEEP and extend history coverage** |
| Strategy, Opportunity, Deal | PE canonical tables | `@finnor/private-equity` repositories and state machines | `canonical_entity_versions`; evidence/document links | PE world, operational queries, Company Brain | **KEEP** |
| Deal target | `pe_opportunities.target_organization_id` and `pe_deals.target_organization_id` reference Core Company identity | PE repositories | canonical history | lifecycle projection | **KEEP; never copy Company** |
| Diligence and close graph | PE Deal children and verified close function | versioned PE state machines and governed close boundary | canonical history, business events, evidence | deal execution graph | **KEEP** |
| Investment cognition | InvestmentCase, Thesis, Assumption, Decision | PE repositories | canonical history and exact evidence | PE world, Underwriting, IC | **KEEP** |
| Underwriting | immutable model/version/scenario/run/sensitivity owners | Underwriting repository | immutable revisions | Company Brain linkage and IC inputs | **KEEP; no observed business truth moved here** |
| Investment Committee | IC owners and exact final Decision link | IC repository and Authority | canonical history and receipts | IC workspace, Company Brain | **KEEP** |
| Claim/epistemic state | `@finnor/epistemic-runtime` propositions and computed state | Epistemic Runtime | evidence references and existing runtime semantics | virtual Company Brain Claim nodes | **KEEP; project only** |
| Source truth | current `external_refs`; immutable `external_ref_observations` | data platform reconciliation | observation ledger, coverage history | PE evidence and Company Brain provenance | **EXTEND for identity decision lineage** |
| Canonical temporal truth | `canonical_entity_versions` and `canonical_history_coverage` | canonical history triggers | append only history; explicit baseline | world state and history APIs | **EXTEND** |
| Company Brain | no identity or writable truth | none | reads owner histories and sources | deterministic graph/query surface | **EXTEND projection; do not persist graph** |
| Work, Planning, Execution, Workforce | Core owners | their existing governed boundaries | existing owner histories/receipts | exact Company Brain references | **KEEP and extend type reachability** |
| Provider/source root binding | source scopes and provider root bindings | data platform administration | immutable scope/coverage records | evidence traversal | **EXTEND root vocabulary** |

## Audit Pass 2: required business concepts

| Concept | Pre Phase 4 representation | Audit conclusion | Canonical Phase 4 representation and proof |
| --- | --- | --- | --- |
| Fund | absent as canonical identity | genuinely absent | `pe_funds`; independent lifecycle and history |
| Vehicle | absent as canonical identity | genuinely absent; cannot equal Fund | `pe_vehicles` plus typed `pe_fund_vehicle_links` |
| Company / PortfolioCompany | Core organization identity already canonical | reuse identity; portfolio status is a relation | `external_organizations` plus `pe_portfolio_holdings` |
| Person | Core external contact identity already canonical | reuse identity | `external_contacts`; role changes never create a Person |
| Sponsor / Advisor | only partial DealParty role semantics | roles, not identities | temporal `pe_company_party_roles` using canonical organizations/contacts |
| Lender | DealParty could name a party but could not prove facility participation | role, not identity | canonical party plus temporal `pe_debt_facility_lenders` |
| Corporate hierarchy | absent | distinct from ownership | temporal acyclic `pe_company_hierarchy_relationships` |
| Ownership | underwriting analogues were hypothetical; no observed owner/subject fact | new observed fact owner required | temporal `pe_ownership_interests` with economic/voting/amount and evidence |
| Security | only underwriting inputs/outputs | observed security identity absent | `pe_securities` |
| DebtFacility | only underwriting/deal financing analogues | observed facility identity absent | `pe_debt_facilities` and exact lenders |
| CapitalStructure | no observed canonical aggregate; Underwriting calculates scenarios | deterministic projection is sufficient | Company Brain projection over Security, DebtFacility, Ownership, and exact coverage |
| Portfolio state | Deal close existed; post close investment relation did not | new relation required | `pe_portfolio_holdings`, created only from a verified closed Deal and same Company |
| MetricSeries/observations | no canonical longitudinal observed metric owner | new owner required | `pe_metric_series` and immutable, restatable `pe_metric_observations` |
| Benchmark | no separate canonical observed benchmark series | new owner required | `pe_benchmarks` and restatable `pe_benchmark_observations` |
| Claim | Epistemic Runtime already owns it | project existing owner | virtual Claim nodes and evidence backed edges; no Claim table |
| Outcome | Decision and Work completion are intent/process, not observed reality | new observed fact required | evidence backed temporal `pe_outcomes`, optionally linked to Decision |
| Exit | Deal/termination did not represent realization | new lifecycle fact required | `pe_exits` linked to Holding, original Deal, Company and optional buyer |
| Completeness | provider scope coverage could not prove an exact company proposition | proposition scoped fact required | revision preserving `pe_fact_coverage` with five explicit states |
| Identity correction | current mappings plus immutable observations existed, but decision semantics were incomplete | extend existing source truth | resolution fields on `external_ref_observations`; no second event subsystem |

## Frozen canonical ownership decisions

1. Core remains the sole Company and Person identity owner.
2. PE remains the sole owner of institutional PE identities, observed PE relations, portfolio facts, metric observations, outcomes, and exits.
3. Company Brain remains a bounded deterministic read projection and owns no business row.
4. Underwriting owns hypothetical models and deterministic calculations. It does not own observed securities, debt, ownership, metrics, outcomes, or exits.
5. Epistemic Runtime remains the sole Claim state owner. Company Brain projects its results.
6. Source Truth remains the owner of provider aliases, observations, and identity resolution decision lineage.
7. Core Authority, IC, Work, Planning, Execution, Evidence, Artifacts, and Workforce retain their owners and are linked by canonical references.
8. `pe_fact_coverage` alone can authorize an exhaustive or negative PE proposition for one exact subject, proposition, valid interval, and knowledge time.

No implementation evidence contradicted these ownership decisions. The only refinement after adversarial testing was making completeness corrections revision preserving rather than treating a coverage declaration as a one time row.

## Why each new persisted concept is necessary

Fund and Vehicle require stable independent identity and lifecycle. Holdings, hierarchy, party roles, securities, facilities, lenders, and ownership require different endpoints, temporal overlap rules, cardinality, and cycle behavior, so existing DealParty or a generic edge cannot express them correctly. MetricSeries separates metric definition from observations; observations and benchmarks use distinct owners because company facts and cohort facts must never merge. Outcome and Exit persist observed reality and lifecycle continuity that Decision, Deal status, and Work completion cannot represent. Fact coverage is persisted because open world absence cannot establish a negative claim. All other target nouns reuse an existing owner or remain projections.

## Temporal and migration conclusions

- Business valid time is stored only on facts and relationships that have domain valid intervals or event periods.
- Knowledge time comes from append only `canonical_entity_versions.recorded_at` and immutable source observations.
- Restatements create a new observation identity and revision linked to the superseded observation; earlier knowledge queries retain the earlier value.
- Existing Core Company/Person rows receive a truthful migration instant baseline and explicit `unavailable_before_history_baseline` coverage. No earlier state is synthesized.
- The migration creates no Fund, Vehicle, Holding, ownership, capital structure, provider identifier, metric, Outcome, or Exit row.

## Re-audit conclusion

The implementation uses one Company identity, one Person identity, distinct Fund and Vehicle owners, one observed ownership owner, a derived CapitalStructure, one metric owner, and the existing Claim owner. New tables are registered in canonical truth/history, protected by forced RLS, tenant qualified references and database triggers, and reachable through bounded Company Brain roots and inspection. The shared `PE_WORLD_ROOT_TYPES` vocabulary now drives PE, source administration, API validation, operational queries, schema types, and OpenAPI generation; the stale three-root live-test union and duplicate runtime lists were removed. Relationship behavior is certified in [phase4-relationship-contracts.md](./phase4-relationship-contracts.md). No production reachable generic `related_to` edge or name/time/LLM inferred edge was introduced.
