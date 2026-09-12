# FINNOR Operating System

`finnor-os` is the canonical multi-tenant execution platform behind FINNOR’s Private Equity product. P1–P7 own the persisted PE, epistemic, underwriting, IC, Work, planning, execution, evidence, receipt, proof, attention, and workforce contracts. Phase 8 adds projections and product surfaces over those contracts; it does not redesign or duplicate them.

## Current architecture

| Layer | Ownership | Responsibility |
|---|---|---|
| PE truth | `packages/private-equity` | Strategy, Opportunity, Deal, InvestmentCase, diligence, closing, underwriting, and IC contracts |
| Epistemic and evidence truth | `packages/db`, `packages/read-models` | Sources, versions, observations, freshness, conflicts, provenance, and evidence lineage |
| Durable Work | `packages/db`, orchestration/runtime packages | Goals, plan revisions, plan nodes, actions, effects, receipts, proof, attention, recovery, and reconciliation |
| Governed workforce | P7 workforce tables and read models | Agent profiles, immutable revisions, grants, assignments, verified metrics, proposals, reviews, and promoted learning |
| Company Brain | `packages/private-equity` | Tenant-scoped node, fact, relationship, history, provenance, evidence, decision-lineage, action-candidate, search, and traversal projections |
| Semantic Activity | `packages/private-equity` | Deterministic business-event projection grouped by PE root and persisted causal thread |
| API | `apps/api` | Authentication, tenant context, read composition, Policy/Authority boundary, and exact product endpoints |
| Worker + orchestrator | `apps/worker`, `apps/orchestrator` | Persistent execution, recovery, reconciliation, and runtime truth |

## Non-negotiable boundaries

- The authenticated context supplies `tenantId`; request bodies do not.
- Company Brain lookup, search, traversal, provenance, history, evidence lineage, decision lineage, and inspection fail closed across tenants.
- Facts and relationships are backed by canonical rows. Chronology is never promoted to causality.
- `availableActions` are candidates only. Execution still requires the existing exact Policy and Authority evaluation.
- A capability grant permits an agent attempt; it does not bypass Work selection, Policy, Authority, BusinessEffect, DecisionReceipt, CompletionProof, or human review.
- Primary semantic Activity contains meaningful P1–P7 changes. Raw activity remains a technical diagnostic.
- Production Private Equity authority cannot report ready until the legacy authority protocol is durably retired and runtime release truth is consistent.

## Setup

Requirements: Node.js 20+ and the repository’s configured PostgreSQL test environment.

```bash
cd finnor-os
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed
```

Run the local services in separate terminals:

```bash
npm run dev:api
npm run dev:orchestrator
npm run dev:worker
```

## Verification

```bash
npm run typecheck
npm run test:unit
npm run test:integration
```

The Phase 8 focused suites cover Company Brain contracts, canonical relationships, temporal and epistemic behavior, exact persisted references, evidence and decision lineage, semantic Activity taxonomy and grouping, inspection targets, and cross-tenant denial.

## Production release

The repository root owns the production contract and guarded release workflow. A valid release must establish the same SHA, protocol, migration head, and authority state across frontend, API, worker, orchestrator, and database.

Legacy product retirement uses only the existing privileged boundaries:

- `finnor_os.freeze_water_intake(expected_epoch, actor, evidence)`
- `finnor_os.water_retirement_blockers()`
- `finnor_os.activate_private_equity_product_authority(expected_epoch, actor, evidence)`

Do not replace that protocol with direct updates to product authority or blocker rows. If durable tenant classification or Work terminalization is incomplete, activation remains blocked.
