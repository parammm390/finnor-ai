# Centropy

Centropy is FINNOR's **Private Equity decision and execution infrastructure**. It connects canonical deal truth, underwriting lineage, IC governance, work planning and execution, evidence and receipts, and a governed AI workforce. The Centropy workspace is the owner operating surface.

The current product opens one Investigation workspace:

- `/centropy` — employee Thread, context-aware composer and persisted Canvas
- WORLD — contextual Company Brain, Digital Twin, Work and workforce inspection within that workspace
- `/centropy/login` — owner sign-in

The former `/centropy/deals`, `/centropy/work` and `/centropy/agents` URLs redirect into the workspace. They are retained entry links, not separate primary surfaces.

The Company Brain and Semantic Activity Theater are deterministic read projections over the existing P1–P7 system. They do not introduce another database, graph, event store, truth layer, authority system, action system, or agent system. Relationships and causes are rendered only when persisted source structure supports them.

## Product invariants

- Tenant identity comes from authenticated context, never a client-provided tenant ID.
- Facts expose source references, as-of time, and `KNOWN`, `UNKNOWN`, `STALE`, or `CONFLICTING` state.
- Every rendered Brain object and semantic activity item has an exact typed inspection target.
- Surface visibility never grants mutation permission.
- Candidate actions still cross the existing Policy, Authority, BusinessEffect, receipt, and proof boundaries.
- AI workers receive bounded Work assignments; they do not receive investment authority.
- Production Private Equity authority is gated on verified legacy-product retirement and consistent runtime truth.

## Repository map

| Area | Location |
|---|---|
| Public PE product and information architecture | `src/components/marketing/`, `src/components/resources/` |
| Public metadata and structured data | `src/app/layout.tsx`, `src/app/manifest.ts`, `src/config/site.ts` |
| Investigation workspace | `src/components/centropy/shell/`, `src/components/centropy/thread/`, `src/components/centropy/canvas/`, `src/components/centropy/world/` |
| Generated Workspace V3 browser contract | `src/components/centropy/lib/workspace-config.generated.ts` |
| Centropy API proxy boundary | `src/app/api/centropy/[...path]/route.ts` |
| Canonical execution platform | `finnor-os/` |
| Upgrade audit and Golden Flow evidence | `docs/centropy/`, `docs/release/` |
| Production release contract | `infra/deployment/production.contract.json` |

## Local development

Requirements: Node.js 20.19+ or 22.12+ and npm.

```bash
npm ci
npm run dev
```

The browser needs the configured Supabase public values for authentication. The server proxy uses `FINNOR_OS_API_URL`, falling back to `NEXT_PUBLIC_OS_API_URL`. Secrets remain server-side. See `.env.example` for the current environment contract.

Useful checks:

```bash
npm run workspace:check
npm run centropy:manifest:check
npm run centropy:forms:check
npx tsc --noEmit
node scripts/centropy/run-local-e2e.mjs e2e/centropy-browser-sweep.spec.ts --workers=1
```

## Production

Production deployment is governed by `infra/deployment/production.contract.json` and `.github/workflows/production-release.yml`. The workflow resolves the exact frontend, API, worker, orchestrator, database, release SHA, migration head, protocol, and product-authority state before mutation.

A frontend-only deployment is not a Centropy production release. Final Phase 8 activation must use the existing privileged retirement protocol and must not bypass blockers with application-side updates.

## UI credits

The counter and liquid orb adapt [Rare UI](https://rareui.com), copyright 2026 Swami Malode. Additional pattern credits and license conditions are recorded in [Third-party notices](THIRD_PARTY_NOTICES.md).
