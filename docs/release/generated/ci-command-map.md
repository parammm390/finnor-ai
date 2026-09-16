# CI Command Map

Source: `.github/workflows/*.yml`, root `package.json`, and `finnor-os/package.json`, audited in P0.T5.
Timeouts are the command-specific Vitest timeout where configured; GitHub workflow steps otherwise use
the platform default because no `timeout-minutes` value is set.

| Area | Workspace | Command | Timeout / execution constraint | Source |
| --- | --- | --- | --- | --- |
| Frontend lint | repository root | `npm run lint` | GitHub default; Next lint command | root package.json |
| Frontend build | repository root | `npm run build` | GitHub default | root package.json |
| Frontend unit | repository root | `npm run test:unit` | Vitest default | root package.json |
| Frontend E2E | repository root | `npm run test:e2e` | Playwright configuration | root package.json |
| Auth matrix | `finnor-os` | `npm run authz:matrix:check` | GitHub default | ci.yml |
| Typecheck | `finnor-os` | `npm run typecheck` | GitHub default | ci.yml |
| Planner evaluations | `finnor-os` | `npm run test:planner-evals` | Vitest 30 s per test | ci.yml + vitest.config.ts |
| Migration | `finnor-os` | `npm run db:migrate` | CI Postgres only; never an unverified target | ci.yml |
| Seed | `finnor-os` | `npm run db:seed` | CI Postgres only | ci.yml |
| LangGraph setup | `finnor-os` | `npm run setup:langgraph` | CI Postgres only | ci.yml |
| Backend/package tests | `finnor-os` | `npm test` | Vitest 30 s per test; serial files | ci.yml + vitest.config.ts |
| Backup/restore | `finnor-os` | `npx tsx scripts/backup-restore-drill.ts` | CI Postgres client required | ci.yml |
| Staging guard | `finnor-os` | `npm run test:staging` | script-defined | finnor-os package.json |
| Policy coverage | `finnor-os` | `npm run policy:lint` | script-defined | finnor-os package.json |
| Security secrets | repository root | `gitleaks/gitleaks-action@v2` | GitHub default | security.yml |
| Security dependencies | repository root | `google/osv-scanner-action` with `--lockfile=finnor-os/package-lock.json` | GitHub default | security.yml |
| Tenant isolation | `finnor-os` | `npx tsx scripts/probe-tenant-isolation.ts` | scheduled/manual; canonical production URL comes from the deployment contract and two production probe JWTs are required | tenant-isolation-nightly.yml |
| Marketing CI | repository root | workflow commands in `marketing-ci.yml` | workflow-specific | marketing-ci.yml |

Commands that mutate a database are safe to execute only against the disposable CI database declared
in `.github/workflows/ci.yml` or an independently verified non-production environment.
