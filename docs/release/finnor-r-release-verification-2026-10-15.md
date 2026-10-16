# FINNOR cumulative R1–R8 release verification

Schema: `finnor.r.release-verification.v1`

This is a finite software-release audit record. It is not an admission,
business qualification, economic result, or claim that a draft is live.

## Observed release state — 2026-10-16

- Production `/api/release` reports commit
  `517003a4396bc8101a90be4b425ee01de9446740` (the current `main` base).
- Production `/api/ready` reports migration `0171_runtime_database_role_isolation.sql`
  and four compatible worker classes. R1–R8 candidate code is **not live**.
- Existing production state reports Water retired and Private Equity active;
  this release does not reapply or change that state. Scope-5 is not activated.
- Authorization for this release is software-only. Production Water/P8 and
  Scope-5 effects remain excluded.

## Candidate and source inputs

- Repository: `parammm390/finnor-ai`; release base: `main` at
  `517003a4396bc8101a90be4b425ee01de9446740`.
- PR #126 is open/draft at R8 commit
  `f70d71f5194cdb28c8bb293f9a538ebc205ef5df`.
- Existing cumulative PR #129 is open/draft at
  `5e8769eb7287deaffa9c79729e7f34476f5fec17`. Its history contains the R8
  commit above and the R3 delivery; it is the single intended release PR.
- R3 owner source: `3113d354f6b70369ee2f1b72b96820353d56f99f`.
  The in-progress local integration input is
  `a307e9df50ad603e7be59ab077f115e4bf914044`.
- Isolated working checkout:
  `/Users/paramdave/.codex/worktrees/finnor-release-candidate-5e8769e`.
- The local candidate merge/repairs are not yet published. No new PR or push,
  GitHub PR merge, or production deployment has been made for them. Do not
  treat old checks on `5e8769e` as checks on these local repairs.
- The PR #129 description still needs to be reconciled with the actual source
  input and explicit software-only authorization before it is marked ready.

## Included scope

| Scope | Candidate implementation | Release status |
| --- | --- | --- |
| R1 CertifiedStateReduction | Existing cumulative owner/runtime and migration | Candidate only |
| R2 RobustProgrammeSearch | Existing cumulative owner/runtime and migration | Candidate only |
| R3 IncentiveRuleSynthesis | R3 authenticated owner/API/worker, migration `0177`, installed runtime, and Work surface | Candidate only; exact mounted Work acceptance not run |
| R4 IdentificationPlanCompiler | Existing cumulative owner/runtime and migration | Candidate only |
| R5 CoalitionProgrammeSearch | Existing cumulative owner/runtime and migration | Candidate only |
| R6 VerifiedCapitalCompiler | Existing cumulative owner/runtime | Candidate only |
| R7 PolicyAtlasCompiler | Existing cumulative owner/runtime and migration `0176` | Candidate only |
| R8 CounterexampleGuidedSolverSynthesis | Existing R8 candidate, commit `f70d71f` | Candidate only |

## Bounded local verification

Passed on the isolated local candidate after the listed repairs:

- `npm run test:release`: 80 passed, 0 failed, 0 skipped; mutation inventory
  `ok: true`, break-glass false.
- `npm run release:truth` and the static production-mutation inventory.
- P8 zero-resurrection static/import-reachability check.
- Generated OpenAPI client parity and capability-manifest parity.
- Authz matrix check, migration bundle generation (179 migrations), TOML
  parsing for the Gitleaks config, and whitespace check.
- Previously observed CI defects have targeted repairs in the candidate:
  duplicate R3 migration identity, missing ARM64 QEMU setup, stale authz and
  generated artifacts, the P8 static false positive, R3 lockfile scan
  classification, Vercel token exposure through CLI arguments, and the
  production artifact tracing regression.

These local checks do not establish hosted image or production acceptance.

## Required gates still open

1. Freeze and publish one repaired source cut to the existing PR #129 branch;
   do not create another PR or separately merge #126.
2. On that exact commit, complete the hosted universal PR verdict and its
   constituent repository/security gates, including the Linux multi-arch
   worker build, migration compatibility, and installed authenticated API →
   durable queue → worker/checker → persisted result path.
3. Run and retain the exact `mounted-work-reload-switch` browser proof. The
   current worker-image smoke selects only authenticated-owner-positive and
   queued-original-and-R3-physical-restart; it explicitly does not run the
   browser/Work story. No result from another source cut substitutes for it.
4. Merge only after the exact source cut passes its required gates. Then verify
   production component SHAs, migration readiness, worker compatibility, and
   the deployed user journey. Keep protected production effects off.

The mounted Work story was **NOT RUN** for the repaired local candidate. This
host currently has no Docker, `psql`, or `agent-browser` executable, so the
local runner cannot establish that proof. Do not report R3 fully live or the
release complete until the exact candidate is accepted and production is
verified.
