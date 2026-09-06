# Finnor AI Operating System

A multi-tenant platform where water treatment dealers configure business rules **as data**, and an AI core takes voice/text instructions, plans actions, **stops for human approval on anything consequential**, executes through your existing tools (Vapi, GoHighLevel, Supabase), and logs every step forever.

This folder is fully self-contained. It does not touch the marketing site at the repo root.

## The one idea that matters

Nothing Finnor plans actually happens until a human clicks **Approve** in the Confirmation Queue. That gate is enforced in the executor and in the database — not in the UI.

## What's inside

| Piece | Where | What it does |
|---|---|---|
| API | `apps/api` | Auth, tenant resolution, actions/confirm/reject/audit/policies routes, Vapi + GHL webhooks |
| Console | `apps/console` | Confirmation Queue, Audit Log, Policy Editor |
| Orchestrator | `packages/orchestration` (+ `apps/orchestrator` service host) | Planner → confirmation gate → Executor → Reflection |
| Worker | `apps/worker` | Postgres-backed job queue: transcripts, reminders, reconciliation |
| Domain plugins | `packages/domain-plugins/*` | 17 engines behind one interface, 38 action types total — real business logic throughout; a handful of integration-bound actions (ads, QuickBooks, GHL) demo-fall-back until a dealer's real provider credentials land |
| Memory | `packages/memory` | Short-term (Redis), long-term (households), semantic (pgvector), episodic (append-only audit) |
| Database | `packages/db` | Schema, migrations with row-level security, seed data |

## Setup (first time, ~10 minutes)

You need Node 20+ and Docker Desktop (for the local database). Then:

```bash
cd finnor-os

# 1. Install dependencies
npm install

# 2. Start the local database + Redis
docker compose up -d

# 3. Copy the environment file and fill in what you have
cp .env.example .env
# For local dev you only need the defaults plus AUTH_DEV_BYPASS=1.
# GROQ_API_KEY is needed for the AI planner (free at console.groq.com).

# 4. Create the tables and load the test dealer
npm run db:migrate
npm run db:seed
```

## Running it

Three processes (three terminal tabs, or use a process manager):

```bash
npm run dev:api       # API on http://localhost:3100
npm run dev:console   # Console on http://localhost:3101
npm run dev:worker    # Background worker (reminders, Vapi transcripts)
```

Open http://localhost:3101/confirm — that's the Confirmation Queue.

To create work for it, send an instruction (this is what a Vapi transcript does automatically):

```bash
curl -X POST http://localhost:3100/api/actions \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: 00000000-0000-4000-8000-000000000001' \
  -d '{"instruction": "Schedule a water test for the Hendersons at 412 Maple Ridge Rd, phone +13195550142, next Tuesday morning"}'
```

(The `x-tenant-id` header works because `.env` has `AUTH_DEV_BYPASS=1`. In production, requests carry a Supabase login token instead and that header is ignored.)

## Tests

```bash
npm test                    # everything (integration tests need docker compose up)
npm run test:unit           # plugin validate/draft logic, tool framework — no DB needed
npm run test:integration    # the safety-critical path: gate → approve → execute → audit
```

The integration suite proves, against a real database: the confirmation gate blocks all tool calls before approval, rejection is permanent, failures retry once then escalate to a human, tenant A can never see tenant B's data, and the audit log physically cannot be edited.

## Environment variables

Every variable is documented inline in [.env.example](.env.example). Values marked `PLACEHOLDER_NEEDS_REAL_VALUE` are intentional — they mark real-world input that doesn't exist yet (e.g. a QuickBooks key nobody has asked for).

## Deploying

- **Frontend + API** → the Vercel projects named in [`../infra/deployment/production.contract.json`](../infra/deployment/production.contract.json).
- **Worker + embedded orchestrator** → the Azure VM and systemd unit named in that same contract. They hold persistent loops and are deployed by the guarded production workflow.
- **Database** → the production database endpoint and required migration head in the contract. Production migration is allowed only after the full runtime preflight succeeds.
- **Release rule** → `.github/workflows/production-release.yml` is the only production path; it accepts only the exact `origin/main` SHA and must verify DB/API/frontend/worker/orchestrator parity before PASS.
- **Webhooks** → point Vapi's server URL at `https://<api-domain>/api/webhooks/vapi` (set `VAPI_WEBHOOK_SECRET` on both sides) and GHL webhooks at `/api/webhooks/ghl`.

## Voice-native confirmation

The Confirmation Queue now has a voice channel — same DB rows, same audit trail, different input:

- **Live call**: give your Vapi assistant two server tools pointed at `/api/webhooks/vapi` — `finnor_instruct(instruction)` and `finnor_confirm(decision)`. The assistant plans the action, reads the draft back in the same call, and applies the spoken yes/no through the identical audit-first path the Approve button uses.
- **No call active**: when an action gates, a `voice_confirm_request` job places an outbound Vapi call to the tenant's `owner_phone`, reads the draft, and the end-of-call transcript is parsed for the decision. **Unclear speech never approves** — the action just stays pending in the queue.
- **Failures speak**: when an integration blocks an action, Finnor calls the owner and names exactly what broke ("your GoHighLevel key isn't working — want to give me a working one?"), in addition to the audit entry and the Blocked queue card.

Voice uses the tenant's Vapi credential reference (`apiKey`, `assistantId`, and `phoneNumberId` in the referenced JSON secret), plus that tenant's `owner_phone`. Global Vapi env vars are an explicitly allowlisted legacy migration path only.

## Where business rules live

Nowhere in this codebase. Pricing, cadences, service radius, confirmation wording, who can approve what — all of it is rows in `domain_policies` and `role_permissions`, editable per dealer in the Policy Editor at `/policy`. The nine domain engines are thin plugins over one interface; a dealer's real SOPs populate them as configuration over time.
