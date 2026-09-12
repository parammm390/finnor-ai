# FINNOR

FINNOR is **Private Equity decision + execution infrastructure**. It connects canonical deal truth, underwriting lineage, IC governance, Work and planning, governed execution, evidence and receipts, and a governed AI workforce. JARVIS is the owner operating surface.

The Phase 8 product boundary is intentionally narrow:

- `/jarvis` — command context and operating attention
- `/jarvis/deals` — PE object world and Company Brain
- `/jarvis/work` — Work, plans, execution, proof, and recovery
- `/jarvis/agents` — governed workforce and reviewed learning

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
| JARVIS owner surfaces | `src/components/jarvis/pe/`, `src/components/jarvis/agents/` |
| Generated Workspace V3 browser contract | `src/components/jarvis/lib/workspace-config.generated.ts` |
| JARVIS API proxy boundary | `src/app/api/jarvis/[...path]/route.ts` |
| Canonical execution platform | `finnor-os/` |
| Phase 8 audit and release evidence | `docs/release/` |
| Production release contract | `infra/deployment/production.contract.json` |

## Local development

Requirements: Node.js 20+ and npm.

```bash
npm ci
npm run dev
```

The browser needs the configured Supabase public values for authentication and `NEXT_PUBLIC_OS_API_URL` for the FINNOR API. Secrets remain server-side. See `.env.example` for the current environment contract.

Useful checks:

```bash
npm run workspace:check
npm test
npx tsc --noEmit
cd finnor-os && npm test
```

## Production

Production deployment is governed by `infra/deployment/production.contract.json` and `.github/workflows/production-release.yml`. The workflow resolves the exact frontend, API, worker, orchestrator, database, release SHA, migration head, protocol, and product-authority state before mutation.

A frontend-only deployment is not a FINNOR production release. Final Phase 8 activation must use the existing privileged retirement protocol and must not bypass blockers with application-side updates.
