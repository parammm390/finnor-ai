# FINNOR

FINNOR is a governed execution system for water treatment companies. It turns an instruction into grounded context, an executable plan, policy-scoped action, durable recovery and permanent evidence. JARVIS is the command surface through which the operation is understood, directed and verified.

This repository contains the public product story and demos, the JARVIS command experience, and the `finnor-os` execution stack. Voice is one supported instruction channel; it is not the product category.

## Tech Stack
- **Framework:** Next.js (App Router)
- **Styling:** Tailwind CSS + shadcn/ui
- **Motion and spatial storytelling:** GSAP, Framer Motion, Three.js and React Three Fiber
- **Icons:** lucide-react
- **Database/Backend:** Supabase

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the example environment file and add your Supabase credentials:
```bash
cp .env.example .env.local
```
Fill in the credentials in `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Your Supabase anon key (safe for browser)
- `SUPABASE_URL`: Your Supabase Project URL for server-side lead writes
- `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key (kept secret on the server)
- `GEMINI_API_KEY`: Optional, server-side only, used by `/api/generate-demo` for conservative profile personalization
- `GEMINI_MODEL`: Optional, defaults to `gemini-2.5-flash-lite`
- `NEXT_PUBLIC_VAPI_PUBLIC_KEY`: Optional, enables the live browser voice demo
- `NEXT_PUBLIC_VAPI_ASSISTANT_ID`: Optional, reusable Vapi assistant for the dispatch demo
- `VAPI_WEBHOOK_SECRET`: Optional, protects `/api/voice/webhook` when configured in Vapi
- `NEXT_PUBLIC_DEMO_MOCK_MODE`: Set to `true` to force polished mock mode
- `LEAD_NOTIFY_WEBHOOK_URL`: Optional webhook for demo-generated notifications
- `GMAIL_USER` and `GMAIL_APP_PASSWORD`: Optional, used by the contact form email notification

### 3. Run Locally
```bash
npm run dev
```
Navigate to [http://localhost:3000](http://localhost:3000).

## Supabase Setup
1. Create a new project in [Supabase](https://supabase.com).
2. Go to the SQL Editor and paste the contents of `supabase/schema.sql` to create the `leads` and `demo_leads` tables.
3. Configure your API keys in the `.env.local` file.
4. _(Optional but recommended)_ Setup Row Level Security (RLS) policies as commented in the schema.

## Product and positioning sources

- **Product truth, live-site audit and positioning decision:** `docs/FINNOR-REBUILD-PRODUCT-TRUTH.md`
- **Public product story:** `src/components/rebuild/`
- **Editorial resources and trust:** `src/components/resources/`
- **JARVIS product surface:** `src/components/jarvis/`
- **Execution system:** `finnor-os/`
- **Brand configuration and links:** `src/config/site.ts`

## Editing supporting content

Shared information and route-specific content are organized by surface.
- **Brand name, tagline, email, links:** Edit `src/config/site.ts`.
- **Homepage:** Edit `src/components/rebuild/`.
- **Field notes, trust, checklist, glossary and estimator:** Edit `src/components/resources/`.
- **Contact Form:** Logic is handled in `src/app/api/contact/route.ts` and UI in `src/components/sections/ContactForm.tsx`.

## Public instruction demo

The demo at `/demo` isolates one instruction channel and produces a governed handoff preview. It is explicitly not a representation of FINNOR’s complete execution system.

- **Route:** `src/app/demo/page.tsx`
- **Client experience:** `src/components/demo/`
- **API endpoint:** `src/app/api/generate-demo/route.ts`
- **Lead APIs:** `src/app/api/demo-leads/route.ts` and `src/app/api/demo-leads/update/route.ts`
- **Scraping:** `src/lib/scrape/scrape-site.ts`
- **Profile extraction:** `src/lib/llm/gemini.ts`
- **Voice prompt builder:** `src/lib/llm/prompt-builder.ts`
- **Supabase lead writes:** `src/lib/leads/supabase.ts`
- **Backend readiness:** `src/app/api/health/route.ts`
- **Voice webhook:** `src/app/api/voice/webhook/route.ts`

The endpoint reads a company website with bounded timeouts and public-host guardrails. It marks unknown facts as unknown and falls back to a generic, clearly labelled workflow when scraping or model summarization is unavailable.

For Vapi, use one reusable assistant and reference the dynamic variables passed by the browser call:
- `{{ companyName }}`
- `{{ websiteUrl }}`
- `{{ companySummary }}`
- `{{ detectedServices }}`
- `{{ dispatchAngle }}`
- `{{ safeDemoScenario }}`
- `{{ voicePrompt }}`
- `{{ techAlertPreview }}`
- `{{ crmPreview }}`

The browser also sends the safe system context into the live call. If Vapi keys are not configured, the page reports that voice is not configured instead of failing silently.

## Lifecycle Demo
The customer lifecycle demo is available at `/demo/lifecycle`.

- **Route:** `src/app/demo/lifecycle/page.tsx`
- **Client experience:** `src/components/lifecycle/`
- **Water lookup API:** `src/app/api/lifecycle/water/route.ts`
- **Diagnosis API:** `src/app/api/lifecycle/diagnose/route.ts`
- **Scenario math:** `src/lib/lifecycle/`
- **Narrative layer:** `src/lib/llm/lifecycle-diagnosis.ts`

The flow takes a service-area ZIP, pricing tier, household size, services, and concern. It pulls public water data, computes sizing and quote logic locally, optionally uses Gemini for the narrative layer, and falls back to deterministic copy when Gemini is unavailable.

Before publishing, call `/api/health` locally or in preview. `readyForProduction` should be `true` after Gemini, Supabase, and Vapi browser credentials are configured. Configure Vapi to send call events to `/api/voice/webhook` and set the same `VAPI_WEBHOOK_SECRET` in Vercel and Vapi.

## Deployment
Production deployment is governed by [`infra/deployment/production.contract.json`](infra/deployment/production.contract.json) and the single guarded [`production-release.yml`](.github/workflows/production-release.yml) workflow.

That workflow resolves the exact Vercel frontend/API projects, Azure worker runtime, embedded orchestrator, database, credentials, and migration head before mutation; it accepts only a clean checkout of the exact remote `main` SHA and refuses PASS until every runtime reports the same release identity. A direct `vercel --prod` deploy is not a production release because it bypasses worker/orchestrator deployment and parity verification.

For local or preview work, use the relevant framework's development commands. Do not infer production targets, provider names, or credentials from this README; update the canonical contract first and let its validator fail closed.
