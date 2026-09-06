# Canonical deployment inventory

Validated against `infra/deployment/production.contract.json` and live targets on 2026-08-19. This is generated human-readable inventory; the JSON contract is authoritative.

| Component | Provider / target | Release proof |
| --- | --- | --- |
| Frontend / marketing | Vercel `finnor-agency` (`prj_dttKVOUzFBGnSg6zNdRualYjQ3oe`), `finnorai.com` | `/api/release` commit-derived metadata |
| API | Vercel `api` (`prj_BoMZ2AXdLIJQXAAe6RqDGBveyq3n`), `api-psi-brown-95.vercel.app` | `/api/release` commit-derived metadata |
| Worker | Azure subscription `899ba394-2364-46c2-bac6-d88b4b4efec1`, resource group `finnor-production-rg`, VM `finnor-jarvis-worker`, systemd `finnor-jarvis-worker.service` | database worker heartbeat release metadata plus Azure source checkout/unit verification |
| Orchestrator | Embedded in the Azure worker process; no separate production service is contracted | worker release identity and embedded orchestrator health contract |
| Database | Production PostgreSQL endpoint matching `aws-1-ap-northeast-1.pooler.supabase.com` | migration ledger head at or above contracted head `0080` |

All required components deploy from one exact `origin/main` SHA in `.github/workflows/production-release.yml`. Missing or mismatched evidence is FAILED/PARTIAL, never PASS.
