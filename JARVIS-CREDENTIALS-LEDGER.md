# FINNOR credential placement ledger

This file records credential locations, never values. The deployment topology authority is [`infra/deployment/production.contract.json`](infra/deployment/production.contract.json); target names must not be inferred from this ledger.

| Surface | Current purpose | Credential rule |
| --- | --- | --- |
| GitHub `production` environment | Runs the one guarded production release | `VERCEL_TOKEN` is a secret; `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` are environment variables used for workload-identity login. |
| Vercel project `api` | API runtime | Infrastructure/shared runtime vars only. Tenant provider credentials must not be stored here. |
| Vercel project `finnor-agency` | Frontend/marketing runtime | Public/build configuration only unless source explicitly requires a secret. |
| Azure VM `finnor-jarvis-worker` | Persistent worker with embedded orchestrator | Root-readable `/etc/finnor/jarvis-worker.env` contains existing runtime secrets; `/etc/finnor/release.env` contains non-secret commit-derived release identity. Deployments preserve the secret file. |
| Production database | Tenant credential references and operational state | Tenant integration rows store provider, reference, version, and non-secret metadata only; secret material stays in the referenced secret provider. |

Required release identity on every runtime: `FINNOR_COMMIT_SHA`, `FINNOR_BUILD_ID`, `FINNOR_VERSION`, `FINNOR_ENVIRONMENT`, `FINNOR_RELEASE_SOURCE`.

Tenant credentials are resolved per tenant and provider, remain immutable for one execution context, and fail closed on invalid/cross-tenant references. Never copy tenant credentials into process-global mutable state, logs, health responses, this repository, or CI evidence.

When a credential changes, update only its authoritative surface, keep its value out of transcripts, run the integration-health probe for the affected tenant, and deploy through the canonical release workflow when a runtime restart is required. Do not rotate unrelated credentials during a release repair.
