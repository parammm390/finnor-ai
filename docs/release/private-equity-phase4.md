# Private Equity Phase 4 certification

Status: **PASS**<br>
Generated: 2026-09-05T22:12:17.129Z

## Starting state

- Branch: `codex/p3-epistemic-runtime`
- SHA: `7e876b17b601b57b19d9c695ce714e2284b316b2`
- Tree: `finnor-os` was clean; unrelated outer-repository changes were preserved and excluded.
- PE0–PE3: audited as present: vertical contract/tenant routing, canonical PE2 Deal graph and mutation owners, and P3 evidence/DecisionRequirement/operational-query truth.

## Runtime owners found and retained

| Responsibility | Existing owner |
|---|---|
| instructionWorkAndLinks | `packages/db/index.ts + packages/db/schema.ts` |
| objectiveLoopAndBudgets | `packages/orchestration/src/objective-loop.ts` |
| objectiveSuccess | `packages/orchestration/src/objective-success.ts` |
| plannerAndCapabilityComposition | `packages/orchestration/src/planner.ts + packages/orchestration/src/plugin-registry.ts` |
| groundingAndBusinessEffectCompiler | `packages/orchestration/src/compiler.ts` |
| domainActionAndApproval | `packages/orchestration/src/index.ts` |
| authority | `packages/orchestration/src/authority-runtime.ts + packages/authority/src/index.ts` |
| durableExecution | `packages/orchestration/src/durable-execution.ts + apps/worker/src/handlers/run-workflow-step.ts` |
| commandsStepsReceiptsAndDlq | `packages/workflow-runtime/src` |
| eventsWaitsAndDeadlines | `packages/orchestration/src/event-waits.ts + packages/db/event-fabric.ts` |
| externalObservationAndReconciliation | `packages/orchestration/src/external-observation.ts` |
| computer | `packages/computer/src/runner.ts + packages/computer/src/repository.ts` |
| peTruthAndMutations | `packages/private-equity/src` |
| peEpistemicState | `packages/private-equity/src/epistemic.ts + packages/epistemic-runtime/src` |
| peOperationalQueries | `packages/private-equity/src/operational-queries.ts` |
| peActionAdapter | `packages/domain-plugins/private-equity/index.ts` |

Private Equity is an adapter into those owners. Program Search was not present as an active authoritative dependency and was not promoted. Speculative/outcome-shadow state remains non-authoritative and is not an execution dependency.

## Active vertical manifests

- Global replay registry: 74
- Water planner composition: 59
- Private Equity planner composition: 32 (17 shared/core + 15 PE)
- Manifest: `docs/release/generated/private-equity-phase4-action-manifest.json`

## PE DomainActions

| Action | PE2 mutation owner | BusinessEffect profile | Approval floor |
|---|---|---|---|
| `open_workstream` | `createWorkstream` | INTERNAL_WRITE | POLICY |
| `create_deal_request` | `createRequest` | INTERNAL_WRITE | POLICY |
| `submit_deliverable` | `receiveDeliverable` | OPERATIONAL_CHANGE | POLICY |
| `record_finding` | `createFinding` | INTERNAL_WRITE | POLICY |
| `resolve_finding` | `resolveFinding` | OPERATIONAL_CHANGE | POLICY |
| `raise_deal_risk` | `createDealRisk` | INTERNAL_WRITE | POLICY |
| `resolve_deal_risk` | `resolveDealRisk` | OPERATIONAL_CHANGE | POLICY |
| `link_deal_dependency` | `createDependency` | OPERATIONAL_CHANGE | POLICY |
| `mark_dependency_resolved` | `removeDependency` | OPERATIONAL_CHANGE | POLICY |
| `create_closing_condition` | `createClosingCondition` | INTERNAL_WRITE | POLICY |
| `submit_condition_evidence` | `attachCanonicalEvidence` | INTERNAL_WRITE | POLICY |
| `satisfy_closing_condition` | `satisfyClosingCondition` | OPERATIONAL_CHANGE | POLICY |
| `waive_closing_condition` | `waiveClosingCondition` | OPERATIONAL_CHANGE | REQUIRED |
| `verify_closing_item` | `verifyClosingItem` | OPERATIONAL_CHANGE | POLICY |
| `declare_deal_closed` | `declareDealClosed` | OPERATIONAL_CHANGE | TYPED_REQUIRED |

Every row has one strict payload schema, pre-authority Deal/Work/entity/version/evidence grounding, DomainAction identity as create idempotency identity, a frozen BusinessEffect, the Core authority/receipt/replay path, one PE2 mutation owner, and canonical return-plus-reread verification. `waive_closing_condition` always requires explicit approval; `declare_deal_closed` requires explicit typed approval. Approval never overrides a stale effect, stale grounding, unresolved mandatory P3 DecisionRequirement, or execution-time close ineligibility.

## Execution semantics proven

- Request creation is one canonical PE action. Communication and follow-up reuse `send_message`; waits reuse durable Work event waits; escalation reuses `escalate_work`.
- The long-lived fixture keeps the same Deal, Request, Work, Objective Loop, provider conversation, wait, deadline, and evidence identities across process reconstruction. Provider acknowledgement remains partially verified until exact read-back; neither an event nor a deadline is treated as success.
- Mismatched and duplicate events cannot satisfy the exact wait. Deadline/event races settle once and re-read current truth. Provider unknown/divergent outcomes enter reconciliation instead of blind retry. DLQ redrive and causal replay retain the original effect identity.
- P3 UNKNOWN/STALE/CONFLICTING mandatory requirements block condition/item/close mutation. Fresh exact authoritative evidence permits the bounded PE2 mutation. Stale entity versions and materially changed approved effects fail closed.
- Computer fallback remains the existing governed `computer_task` path: fixed tenant application identity, allowed origin, exact authorized effect, restart inspection, and read-back; a click is not business success.
- “Ready to close” verifies PE2 eligibility and does not close. “Close” additionally requires current eligibility, typed human approval, atomic PE2 close, `actualCloseAt`, close BusinessEvent, finalized receipt, and canonical objective-success reread.
- PE external writes require an explicit tenant sandbox/emulator binding; the certification adapter has no production egress. Water and PE capability/provider resolution are tenant-specific in the same process.

## Deterministic evidence map

| Gate | Tests included in the full suite |
|---|---|
| pe_action_contract_and_vertical_composition | `tests/unit/private-equity-phase4-contract.test.ts`<br>`tests/unit/private-equity-planner-isolation.test.ts` |
| request_shadow_journey_condition_waiver_and_close | `tests/integration/private-equity-phase4.test.ts` |
| canonical_pe2_and_epistemic_pe3_regression | `tests/integration/private-equity-phase2.test.ts`<br>`tests/integration/private-equity-phase3.test.ts` |
| durable_event_wait_duplicate_wrong_event_deadline_race_and_cross_tenant | `tests/integration/event-driven-objective-runtime.test.ts` |
| provider_acknowledgement_observation_and_reconciliation | `tests/integration/external-effect-observation.test.ts` |
| computer_authorized_effect_identity_restart_and_readback | `tests/integration/computer-execution-fabric.test.ts` |
| durable_effect_approval_receipt_and_reconciliation_bridge | `tests/integration/single-action-runtime-bridge.test.ts` |
| dlq_redrive_and_causal_replay | `tests/integration/poison-job-replay-drill.test.ts`<br>`tests/integration/causal-replay.test.ts` |
| universal_actions_escalation_and_water_preservation | `tests/integration/universal-action-fabric.test.ts`<br>`tests/unit/universal-actions-contract.test.ts` |

## Release gates

| Gate | Result |
|---|---|
| isolatedFreshMigration | PASS |
| runtimeRegistryCount | PASS |
| privateEquityCompositionCount | PASS |
| waterCompositionCount | PASS |
| sharedCompositionCount | PASS |
| exactVerticalComposition | PASS |
| exactPeActionBoundary | PASS |
| payloadSchemasDiscovered | PASS |
| hardApprovalFloors | PASS |
| langgraphCheckpointer | PASS |
| policyCoverage | PASS |
| typecheck | PASS |
| pe4ShadowCertification | PASS |
| waterAndCoreRegression | PASS |

- Migration: `0107_private_equity_execution_semantics.sql` applied from a 108-migration fresh isolated database; bundle/source head matched.
- Commands: `npm run setup:langgraph` PASS; `npm run policy:lint` PASS; `npx --no-install tsc -p tsconfig.release-pe4.json` PASS; `npm test -- --reporter=dot` PASS.
- PE4 shadow certification: **PASS**.
- Water regression: **PASS**.
- Core/P1–P6 regression: **PASS**.
- Residual blockers: none.

## Phase 5 handoff

- 32-action PE planner composition (17 shared/core + 15 PE) derived from the runtime registry
- 59-action Water composition preserved independently
- 15 one-to-one PE DomainAction-to-PE2 mutation-owner contracts
- PE objective-success predicates over canonical Request/Finding/Risk/Condition/ClosingItem/readiness/close truth
- execution-time state/effect/authority revalidation with hard waiver and close approval floors
- isolated PE external sandbox/emulator requirement and tenant credential boundary
- green long-lived PE shadow corpus and full Core/P1-P6 regression evidence

**No Water capability was intentionally retired in Phase 4.**

**Private Equity runs through the existing FINNOR Work / Objective / Authority / BusinessEffect / Event-Wait / Reconciliation runtime; no second PE execution engine exists.**

**No full PE Worker architecture, full PE Action Fabric, broad Deal Data Fabric, solver, simulator, Deal Zero, Fund/LP system or Portfolio system was built.**

**The PE shadow runtime can maintain one Deal objective across actions, external waits, deadlines, approvals, ambiguity, restarts and verification without losing identity or falsely claiming success.**
