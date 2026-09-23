# JARVIS + FINNOR OS system contract audit

Audit date: 2026-08-09  
Scope: authenticated JARVIS frontend → same-origin proxy → FINNOR OS API → tenant resolution → read models → PostgreSQL → surface renderer.

## Release result

Historical screenshots and root evidence referenced below are linked from [the artifact index](evidence/legacy-root-artifacts.md).

The repaired local production build passes the authenticated six-surface sweep. Home, Work, Customers, Schedule, Money, and Agents all returned HTTP 200 for their authoritative API reads, with zero browser console errors and zero page errors. The exact one-command acceptance chain completed and is visible across Work, Household, Schedule, Agents, and receipt evidence.

This does **not** claim that absent provider configuration or absent historical data exists. Vapi remains explicitly unconfigured in the acceptance environment, older failed attempts remain visible, and no route-optimization receipt is claimed for a schedule that was booked but never optimized.

## Cross-repository session and tenant contract

| Boundary | Authoritative contract | Failure reproduced | Root cause | Repaired behavior / proof |
| --- | --- | --- | --- | --- |
| Browser session | Supabase password/session yields a caller JWT; client requests attach it as `Authorization: Bearer …`. | Signed-in pages could initially render SIGN IN or issue reads before auth initialization settled. | Auth provider began in a non-loading state and surfaces did not consistently gate on session resolution. | Provider begins loading; Work/Customers wait for resolved session. Authenticated `/api/jarvis/me` is 200 in the final sweep. |
| Browser → proxy | The real caller bearer must survive the same-origin `/api/jarvis/*` boundary. | Some allowlisted GETs resolved under the proxy service identity rather than the signed-in user. | “Public GET” fallback replaced a present caller bearer. | Caller bearer is preserved; service identity is used only for anonymous allowlisted reads. |
| Streaming | Credentials belong in headers, never URLs. | Instruction/SSE URLs could contain the bearer token. | Native `EventSource` cannot set Authorization, so the token was moved into the query string. | Stream route rejects query-token auth; the browser uses authenticated fetch-stream parsing with reconnect and `Last-Event-ID`. No bearer appears in URLs. |
| JWT verification | FINNOR OS cryptographically verifies claims and resolves verified email → `users` mapping → tenant/role. | A browser session fanned out into slow remote `getUser` requests and manufactured read timeouts. | A new Supabase client and network user verification were created per API request. | One client reuses cached JWKS and calls `getClaims`; warm `/me` is tens to low hundreds of milliseconds. Tenant is `00000000-0000-4000-8000-000000000001`, role `owner`. |
| Configuration | Frontend and backend must be built against the same Supabase project and compatible API release. | Deployed FINNOR OS lacks `work-cases`; local backend `.env` points to an obsolete DNS-unresolvable Supabase project. A runtime URL override did not change a frontend production bundle. | Cross-repo environment drift plus Next build-time inlining of `NEXT_PUBLIC_*`. | Local production acceptance builds pin the same Supabase project and FINNOR OS URL at build time. The checked-in backend env remains an explicit deployment blocker until its secret/environment source is corrected. |
| Tenant database access | Verified identity is resolved before tenant GUC/RLS-scoped reads. | SOURCE UNAVAILABLE/401 surfaces obscured whether auth or projection had failed. | The earlier auth fanout and frontend gating collapsed distinct failures into generic UI states. | `/me` is checked independently; every surface then calls tenant-scoped routes that use `withTenant`. No projection row is invented client-side. |

## Surface-by-surface contract matrix

| Surface | Browser/session | API route(s) | Read model / database sources | Renderer contract | Original failure and root cause | Final evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Home | Resolved Supabase session; caller bearer retained through proxy. | `/me`, `/stats`, `/events`, `/comms`, `/workflows/runs`, pending actions, integrations, setup, insights, operational read models. | Tenant identity; domain actions; workflow runs/steps; business events; communications; CQRS projections and direct read models. | `PersonalizedHome` / operational console renders each source independently. | Auth verification fanout and a browser 5s read timeout aborted valid upstream work. | All 22 observed Home reads returned 200; no visible failure labels. |
| Work | Session gate precedes `workCases()`. | `/read-models/work-cases` plus exact deep links. | `instruction_sessions`, `instruction_events`, `domain_actions`, `pending_confirmations`, `commands`, `workflow_runs`, `workflow_steps`, `decision_receipts`, `action_log`, voice sessions/turns, exact linked business events. | `WorkSurface` groups only by durable instruction/action/plan/run edges. Status derives from durable action/workflow state; unanimous completion outranks a stale pre-execution trace. | Deployed API returned 404 because frontend/backend versions drifted. Completed work could still say “Needs you” because instruction trace stopped at `action_gated`. | `/read-models/work-cases` 200. Exact case `instruction:ec12b58d-5bd8-4ee4-859e-8224e2d1ac00` is **Completed** and contains the exact action, approval, links, and receipt. Future approval execution emits `executing` and terminal instruction phases. |
| Customers | Session gate precedes household list/read. | `/resources/households`, `/read-models/household-360?householdId=…`. | Canonical household/contact/contact-method rows plus equipment, leads, opportunities, quotes, invoices, work orders, legacy `service_visits`, canonical `appointments`, conversations, documents, communications, and timeline events. | `Household360Surface` opens only an exact household ID; empty sections remain honest empty arrays. | Customers inherited unrelated provider failure through a full-page data provider and could request before auth was ready. | Household list/read 200. Exact household `e40225f2-8063-40c3-bd8e-2c83c6b67feb` visibly shows address, phone, and scheduled Water Test. |
| Schedule | Authenticated reads; Work enrichment is optional, map is authoritative. | `/dispatch/map?date=…`; optional `/read-models/work-cases`. | Both legacy `service_visits` and canonical `appointments`; technicians are left-joined so unassigned work remains visible. | `DispatchMap` discriminates `sourceKind: service_visit | appointment` and matches exact IDs. | `Promise.all` made optional Work 404 blank the whole page. Legacy-only query hid canonical appointments; inner technician join hid unassigned visits. | Both reads 200. Exact service visit `5b3754f9-70a3-41ad-915e-9522180adc17` is visible with the exact household, time, and `sourceKind=service_visit`. “No completed B3 route receipt” is truthful: booking occurred, route optimization did not. |
| Money | Authenticated core reads do not depend on optional Work correlation. | `/read-models/cash-collections`, `/resources/invoices`; optional `/read-models/work-cases`. | Invoices, succeeded payments, and payment-link workflow steps. | `CashPressureSurface` renders core money facts even if Work correlation is unavailable. | Money looked “live” while other projections failed because it already isolated its authoritative reads with optional settlement; the other pages coupled optional and core requests. | All three Money reads returned 200; no visible failure labels. No money mutation is claimed by the acceptance command because this command schedules service rather than invoicing. |
| Agents | Session gates both integration and Work reads. | `/integrations/status`, `/read-models/work-cases`. | Environment/provider configuration; safe Vapi assistant verification; exact instruction/action/call/persona edges from Work. | `AgentFleetSurface` separates provider status from assistant status and never exposes assistant IDs or secrets. JARVIS activity is instruction-rooted; outbound agents require exact action/persona/call edges. | Provider-level Vapi health was promoted too broadly; configured assistant IDs were not individually verified. Work 404 erased the agent outcome. | Both reads 200. Exact JARVIS work shows **Completed** and Customer `e40225f2`. Vapi is honestly “provider not configured”; historical failed cases without entity evidence still say “Customer link unavailable.” |

## Canonical and pre-canonical ID contract

- Household identity is the canonical `households.id`. The sandbox contact tool now returns both `contactId` and `householdId`; the successful workflow receipt carries the exact household ID instead of requiring name/phone inference.
- Scheduling currently spans pre-canonical `service_visits` and canonical `appointments`. The dispatch API queries both independently and emits `sourceKind`; neither table is silently treated as the other.
- Work correlation follows exact durable IDs in action payloads, workflow-step evidence, action log output, receipts, calls, and business events. It does not group by customer name, timestamp, title, or fuzzy text.
- The renderer uses the exact action, Work case, household, visit, instruction, workflow, step, and receipt IDs recorded below.

## One-command acceptance chain

Instruction:

> Schedule a water test for Evidence Audit at 88 Proof Trail, Cedar Falls, IA, phone +13195559809, at 2026-08-09T16:30:00.000Z.

| Stage | Durable result |
| --- | --- |
| Instruction | `ec12b58d-5bd8-4ee4-859e-8224e2d1ac00` |
| Plan/action | `schedule_water_test`; action `66cf2c21-91fc-4c00-b491-aa55c26d0d51`; plan `5e91d04a-2d3f-4871-bd07-8a1e6961153a` |
| Approval | Approved by the authenticated owner; decision persisted before execution. |
| Execution | Action status `completed`; workflow run `5798b257-f654-4b93-8a81-40c5833a0fb7`; workflow step `aca3b9f2-6122-4069-bc48-a155fb7591a2`. |
| Work | Case `instruction:ec12b58d-5bd8-4ee4-859e-8224e2d1ac00`, status **Completed**. |
| Household | `e40225f2-8063-40c3-bd8e-2c83c6b67feb`, created at the supplied address with the supplied phone. |
| Schedule | Service visit `5b3754f9-70a3-41ad-915e-9522180adc17`, `water_test`, scheduled at the requested time, visible even though unassigned and ungeocoded. |
| Money | No change expected or claimed for a scheduling-only command. Money remains live from its own authoritative invoice/payment contract. |
| Agent | Exact instruction-rooted JARVIS outcome is **Completed**; no outbound Vapi call is claimed. |
| Receipt/evidence | Receipt `c99d34e6-5d1a-437a-a1d2-aafc3f88fa06`, successful actual result, exact household and visit IDs, policy ID/version, correlation ID, workflow-step evidence. |

The first cold approval completed in 30.6 seconds while the old proxy/browser write budgets were 30 seconds. The proxy now owns a 60-second durable-write budget and the browser waits 65 seconds, preventing a committed action from being presented as a failed request.

## Renderer and provider findings

- Action manifest discovery passes **44/44** against the fixed backend action specification.
- The frontend registry test confirms all generated types are registered with all six certified states and no certified fallback renderer. The reported 41/44 gap is not present in the current source tree; it is consistent with the same deployed-version skew that omitted `work-cases` from the deployed backend.
- Frontend production build initially found one stale typed Schedule fixture missing `sourceKind`; it was corrected and the clean build passes.
- Vapi provider health and per-assistant binding health are separate facts. When a provider key exists, FINNOR OS verifies configured assistants using Vapi `GET /assistant/:id`. Returned browser data contains logical agent/persona keys and health only—no provider assistant IDs or secrets.

## Verification evidence

- Exact-chain machine artifact: `evidence/system-audit-command-chain/chain.json`
- Exact-chain screenshots: `evidence/system-audit-command-chain/01-instruction.png` through `07-agent.png`
- Final six-surface sweep: `evidence/system-audit-local-fixed-production/matrix.json` and matching screenshots
- Frontend unit suite: 50 files, 483 tests passed
- Backend unit suite: 60 files, 305 tests passed
- Focused database/read-model chain: 3 files, 12 tests passed
- Proxy/API/stream contract: 3 files, 24 tests passed
- Frontend production build: passed
- FINNOR OS API production build: passed
- FINNOR OS typecheck: passed
- Action manifest: 44/44 passed

## Deployment closure required

The source fix is complete, but production will continue to show the old failure until both repositories are deployed together with one environment contract. In particular:

1. deploy the FINNOR OS revision that includes `work-cases`, dual Schedule sources, cached claims verification, terminal instruction trace, and safe Vapi assistant status;
2. build JARVIS with the matching `NEXT_PUBLIC_OS_API_URL` (it is build-time configuration);
3. replace the stale backend Supabase project values through the managed deployment environment—do not copy local secrets into source;
4. rerun the authenticated sweep against the deployed URLs before promotion.
