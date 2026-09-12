# P8 active production boundary audit

## Baseline truth

| Required truth | Observed value before P8 code changes |
| --- | --- |
| Repository HEAD | `5d04b64dac8a15e70af0f1c15d41aeaeba075614` on `codex/p3-epistemic-runtime` |
| Working tree | Seven pre-existing user-edited paths; preserved and merged. Copies are under `.git/codex-p8-user-before-sync`, `/tmp/finnor-p8-audit.D8Oig6/preserved-working`, and `/tmp/finnor-p8-audit.D8Oig6/merged-user`. |
| Audited/deployed reference | `c7eff34f85eb1d3624fd755a6a01df09cfceba43`; `origin/main`, frontend `/api/release`, and API `/api/release` agreed. |
| Production migration head | `0129_phase7_governed_workforce_learning.sql` |
| Product runtime authority | Epoch 5, `state=preparing`, `active_product_vertical=private_equity`, minimum protocol 5. This is not retired authority. |
| Active production vertical | Four tenant assignments remain `water` v1; none has a retirement disposition or activation authorization. |
| Workspace rows | Two rows: one V2 and one versionless; both contain Water-era presentation semantics. |

The live production migration head remains `0129_phase7_governed_workforce_learning.sql`. The P8 candidate now advances its declared head to `0130_phase8_cutover_runtime_head_compatibility.sql`; that forward migration replaces only the two existing privileged cutover function bodies and creates no table, column, truth store, authority store, or event store.

The P8 dependency closure was traced from 18 JARVIS, 3 planner, 1 orchestrator, 2 worker, 1 supplier-canary, 2 demo, 54 public-site, and 137 production-API entrypoints. Generated artifacts, migrations, certification evidence, and tests count as active only when a production entrypoint imports or executes them.

## KEEP

| Path / symbol | Runtime entrypoint and inbound owner | Data owner | Verification |
| --- | --- | --- | --- |
| `@finnor/private-equity` P1 world state, epistemic state, provenance, operational queries | Authenticated PE query plane | `@finnor/private-equity` | P1/P3 regressions plus Company Brain temporal, provenance, and tenant tests |
| P4 underwriting repositories/artifacts | Underwriting API routes and Company Brain composition | `@finnor/private-equity`, `@finnor/underwriting` | P4 composition and regression tests |
| P5 IC repositories/aggregation | IC API routes and Company Brain composition | `@finnor/private-equity` | P5 composition and regression tests |
| P6 `Work`, selected `PlanRevision`, plan node/edge, `DomainAction`, `BusinessEffect`, `DecisionReceipt`, `CompletionProof`, Attention | Work APIs, Company Brain, Semantic Activity | existing Core/P6 owners | exact-reference Brain/Activity tests and P6 regressions |
| P7 workforce status, agent revisions, assignments, learning | `/api/read-models/workforce-status`, `/jarvis/agents`, Company Brain | `@finnor/read-models`, `@finnor/workforce` | P7 composition, tenant, workforce regressions |
| `finnor-os/apps/api/app/api/activity/route.ts` raw activity feed | `/api/activity` diagnostic consumer only | existing activity query | contract test includes server-emitted `work_event`; primary theater imports `/api/semantic-activity` |
| Existing Policy, Authority, BusinessEffect, receipt, proof, and worker runtimes | governed mutation paths | P1-P7 owners | P1-P7 regression matrix; no alternate P8 mutation runtime |

## REWIRE

Every row records the reference runtime edge and the resulting production owner.

| Path / symbol | Reference runtime entrypoint and inbound imports | Reference owner / problem | Target owner and action | Verification |
| --- | --- | --- | --- | --- |
| `finnor-os/apps/api/lib/workspace-config.ts`; browser `workspace-config.ts`; `WorkspaceConfigProvider` | `/api/workspace-config`, JARVIS provider, nav, metric/action registries | Server/browser V2 contracts diverged and encoded Water roles, metrics, actions, projections | One server-owned Workspace V3; generated hashed browser artifact; runtime accepts V3 only and fails closed to canonical V3; release-only `workspace-v3-repair.ts` transactionally retains neutral presentation and replaces semantic fields before deployment | generator `--check`, server/browser tests, embedded-Postgres repair test |
| `surface-routes.ts`: `HouseholdContext`, six operational routes | all active JARVIS navigation and surfaces | browser-owned Water routing and household identity | exact `PeOperatingContext { root, selectedObject, workId }`; exact Home/Deals/Work/Agents registry; authenticated Company Brain resolves context | route/context unit tests and E2E |
| `PersonalizedHome`, legacy `WorkSurface`, `AgentFleetSurface` inspection navigation | `/jarvis`, `/jarvis/work`, `/jarvis/agents` | Water role landing, field projections, ad-hoc selection links | PE command/attention surface, canonical Work aggregate, P7 workforce, and typed inspection targets | browser unit tests, API integration tests, E2E |
| `src/lib/jarvis-client.ts` raw `ActivityItem.source` consumers | diagnostic activity browser clients | browser omitted API-emitted `work_event` | raw diagnostic contract includes `work_event`; semantic theater uses the new typed semantic contract | raw contract and semantic activity tests; obsolete client deleted after consumers rewired |
| `ready/route.ts`, `worker-readiness.ts`, `product-readiness.ts`, production release scripts/workflow | `/api/ready` and final release verification | vertical name alone could pass while authority was `preparing`; mixed fresh fleet was tolerated | production-only hard gate requires `water_retired`, `private_equity`, exact release/epoch/migration/protocol convergence; only executable authority writes heartbeats | 8 readiness tests, runtime contract, guarded workflow |
| `worker/src/heartbeat.ts`; embedded orchestrator and scheduler-owner attestations | ECS worker release heartbeat loop | the deployed worker proved only one of the three durable roles it owns | the existing worker process emits exact-release, exact-epoch heartbeats for `worker`, `orchestrator`, and `scheduler-owner`; no separate orchestrator deployment is introduced | heartbeat integration test requires all three roles |
| supplier-canary `/health`, deployment contract, and release verifier | two existing Vercel supplier-canary projects | canaries did not expose cutover-compatible provenance | exact app/auth role, deployment ID, release SHA/build/version/source, migration 0130, and protocol 5 are mandatory; the protected operator records one combined supplier-canary heartbeat only after both pass | supplier-canary tests and parity/release gates |
| `run-p8-production-water-retirement.mjs`; policy/store helpers | protected `production-release` workflow only | no deterministic P8 operator joined deployment proof, tenant classification, operational census, Phase-5 barriers, drain, and final readiness | exact four-tenant census; pre-cutover authority/fleet/Work/jobs/workflows/outbox/effects/scheduled work/calls/messages/canonical-state evidence; two serializable freeze/drain transactions; existing privileged functions only; rerun-safe convergence | policy tests and forward-head PostgreSQL integration test |
| `0130_phase8_cutover_runtime_head_compatibility.sql`; `freeze_water_intake`; `activate_private_equity_product_authority` | migration runner and privileged Phase-5 cutover operator only | immutable 0109 function bodies required heartbeats to claim migration 0109 even after the canonical database advanced to 0129, making every legitimate forward-migrated fleet ineligible | preserve both signatures, evidence requirements, role set, single-release check, zero-blocker census, and authority mutation; resolve the expected head from the existing authoritative `_migrations` lineage at invocation time | isolated fresh/upgrade database tests reject an old-head worker, accept only all-role current-head provenance, freeze, require zero blockers, activate, and confirm `finnor_app` still lacks execute privilege |
| `/`, product/capabilities/process/pricing/resources/trust/FAQ/legal, metadata, manifest, JSON-LD, site config | 54 public-site entrypoints | active Water/home-service proposition | `PrivateEquityPublicPage`, PE resources/legal wrappers, PE metadata and structured data; synthetic examples are explicitly labeled | public metadata 13/13, route smoke 76/76, doctrine/import gate |
| `ai-concierge`, demo/prompt/scrape surface | public APIs and demo routes | Water intake generation, lifecycle diagnosis, scrape-driven demo doctrine | PE concierge only; executable Water demo/scrape/lifecycle routes removed; no active demo files | public-demo closure 13/13 and zero-resurrection runtime contract |
| Legacy route modules `/jarvis/{customers,schedule,money,bridge,classic,next,showtime,stage}` | direct URL entry | obsolete product surface or shell | deterministic redirects to an exact active PE surface; no obsolete renderer import | redirect tests, route smoke, import reachability |

## DELETE

| Path / symbol | Reference runtime entrypoint and inbound imports | Data owner / problem | Action | Verification |
| --- | --- | --- | --- | --- |
| `Household360Surface`, `DispatchFieldSurface`, `CashPressureSurface`, `TechnicianBoard`, `DispatcherBoard`, `MyDay`, `DispatchMap` and their Water presentation models | Customers/Schedule/Money pages and Home/work shells | stale browser presentation over Water tables/read models | renderer and active imports deleted; legacy URLs redirect | source absence, Next build, route E2E, import reachability |
| `experience/*` Water role/metric/action registries, `workspaces/*` V2 projector, obsolete `views.tsx` resources | Workspace provider and legacy JARVIS shells | second active product contract | deleted after V3 generation and PE surface wiring | V3 runtime contract and browser exhaustiveness tests |
| obsolete bridge/kernel/panel/lib visual and interaction graph | bridge/classic/showtime/stage shells | retained active dependency paths back into Water presentation | deleted when no PE responsibility remained; 283 stale JARVIS source/test files removed in the materialized cutover | production-entry import graph, lint, typecheck, build, E2E |
| `src/app/api/{demo-leads,demo-profile,demo-scrape,demo/extract-intake,generate-demo,lifecycle/*,voice/*}`, `src/app/demo/**`, `src/lib/demo/**`, Water-only LLM/scrape modules | public demo and API routes | generated Water doctrine and executable lifecycle/voice intake | deleted; no compatibility endpoint retained | demo closure, public route scan, runtime contract |
| Water-era marketing implementation and live-system widgets | public route wrappers | active Water commercial narrative | replaced by PE page/resources and removed from imports/source | metadata/route tests and doctrine scan |
| 12 obsolete Water-era release/QA utilities | package scripts or direct operator execution | executable demo/lifecycle/dispatch verification outside production import graph | deleted and package script removed | exact path absence and zero-resurrection scan |

The final `c7eff34`-to-P8 release tree contains 58 added files, 93 changed files, and 472 deleted files (623 paths total). Deletion remains limited to the audited reference paths; unrelated local-only artifacts and three pre-existing regenerated Phase-5 evidence files are excluded from the release commit.

## HISTORY-ONLY

| Path / symbol | Runtime entrypoint / inbound imports | Data owner / reason retained | Target owner / action | Verification |
| --- | --- | --- | --- | --- |
| `finnor-os/packages/db/migrations/0000`–`0130` and `migrations-bundle.ts` | migration runner only | immutable schema/product history plus the forward-only cutover function repair | database history; exact allowlist category `history` | migration regression and reachability gate |
| `freeze_water_intake`, `water_retirement_blockers`, `activate_private_equity_product_authority` | privileged Phase-5 certification/release tooling only | sole authorized cutover protocol | retirement authority; retain, never bypass | Phase-5 blocker/activation tests and live read-only census |
| Water disposition ledger, historical canonical rows, release certifications/evidence | database history and audit tooling | required data/evidence integrity | history/retirement allowlist; never planner/UI/demo/prompt mutation input | 37-entry exact path/reason allowlist; unused entries fail CI |
| retired Water webhooks, planner/worker guards, quarantine contracts | reachable only to reject/quarantine old input | permanent non-execution boundary | `deny_guard`/`retirement`; retain negative behavior only | runtime contract and guard regressions |

The zero-resurrection gate reports 37 exact allowlist entries, 102 retired implementation paths, and zero violations. Reachable-module counts are JARVIS 47, planner 233, orchestrator 262, worker 300, supplier canary 1, demo 9, public website 113, and production API 420.

## Completion gate

Repository/source verification passes conditions 1–17 and 23–30. Live production conditions 18–22 are false, so P8 is not complete.

| Conditions | Result |
| --- | --- |
| 1–5 Workspace/surfaces/context | PASS in repository: one V3 contract; four surfaces; legacy pages redirect; no active `HouseholdContext`; PE context is source-backed |
| 6–11 Company Brain composition | PASS in repository: projection only; canonical refs; exact persisted edge registry; fact provenance; P1 time/epistemics; P4–P7 composition |
| 12–15 Activity/inspection | PASS in repository: semantic causal projection; raw diagnostic only; no inferred cause; typed target on every visible item |
| 16–17 brand/demo doctrine | PASS in repository: PE public contract; no executable Water demo/prompt/scrape doctrine |
| 18 freeze Water intake | **FAIL live**: authority remains `preparing`; intake not frozen |
| 19 zero retirement blockers | **FAIL live**: disposition 4, Water action 1015, business effect 3, job 1, objective 3; nonterminal Work remains |
| 20 retired PE authority | **FAIL live**: not `water_retired`; active vertical is not durably activated despite the preparing target value |
| 21 honest production readiness | **FAIL live**: deployed pre-P8 `/api/ready` reports healthy while authority detail is `preparing`; repository replacement fails closed |
| 22 zero executable Water in active production graph | **FAIL live** until the verified P8 release is deployed after retirement |
| 23 historical Water intact/non-executable | PASS in repository and database census: retained as history, retirement, or deny guards |
| 24–26 no new truth/authority/event store | PASS: zero new schema objects or replacement stores; one forward-only migration replaces two immutable privileged function bodies so the existing Phase-5 protocol accepts the authoritative current migration head |
| 27–28 no fabricated edges/causes | PASS: exact relationship registry, persisted causal field tests, negative label/chronology tests |
| 29 P1–P7 regressions | PASS: focused embedded-Postgres matrix 18/18 files and 144/144 tests, zero skips; includes forward-head cutover, operational-census proof, and isolated Workspace V3 repair |
| 30 no AWS work | PASS: no AWS architecture, resource, deployment, or migration introduced |

The latest read-only production census found two fresh service instances in the last ten minutes, both on release `c7eff34`, migration 0129, epoch 5, and protocol 5: one worker and one scheduler-owner. The previous stale 0108 worker is no longer fresh, but the required API, orchestrator, and supplier-canary provenance is absent. Production still runs the pre-repair function bodies that require heartbeat migration `0109_atomic_water_runtime_retirement.sql`; candidate migration 0130 removes that contradiction without weakening the fleet gate. Production must still receive the candidate release, converge every required role, and drain/classify the real blockers before freeze or activation is safe.

One forward-only P8 migration replaces two existing privileged function bodies because immutable migration 0109 cannot be edited and an application/read projection cannot change a database-owned transaction boundary. It derives the required release head from the already-existing `_migrations` lineage and adds no schema object or data. No graph, event, truth, authority, action, or agent store was added. Production was inspected read-only and left unchanged.
