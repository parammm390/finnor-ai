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
- Read-only AWS inspection in `us-east-1` confirms the production stack is
  `UPDATE_COMPLETE`, currently at `517003a`, with
  `ComputePlaneStage=finalized`; its last update was 2026-10-09. It has four
  active class services and no active legacy `finnor-worker` service. Secret
  inspection read metadata only (no secret values); neither database secret
  reports a customer-managed KMS key.
- The GitHub OIDC role trust is restricted to this repository's `production`
  environment. The role has no attached managed policy or permissions boundary;
  its inline policy enumerates actions, but grants broad resource scope for ECS,
  ELB, EC2, CloudFormation, and Application Auto Scaling. IAM lifecycle is
  limited to `finnor-*` / `finnor-compute-*`; `PassRole` is limited to five named
  task roles. The candidate now supplies four per-step STS session policies:
  ECR writes are restricted to `finnor-worker`, preflight reads are read-only
  except for the two exact database-secret ARNs, and compute mutations are
  scoped to the production stack, FINNOR ECS resources, and five named task
  roles. Static parsing confirms no wildcard service actions; the compute
  policy is 2,029 characters of the 2,048-character STS limit. The live/base
  role policy remains broader than these workflow sessions and has not been
  changed; the role itself is therefore not yet fully narrowed. No AWS role,
  stack, secret, or production resource was changed.

## Candidate and source inputs

- Repository: `parammm390/finnor-ai`; release base: `main` at
  `517003a4396bc8101a90be4b425ee01de9446740`.
- PR #126 is open/draft at R8 commit
  `f70d71f5194cdb28c8bb293f9a538ebc205ef5df`.
- Existing cumulative PR #129 is open/draft at
  `3ee2c8f51fff9d48caafb8599252ab059548a3bd`. Its history contains the R8
  commit above and the R3 delivery; it is the single intended release PR.
- R3 owner source: `3113d354f6b70369ee2f1b72b96820353d56f99f`.
  The in-progress local integration input is
  `a307e9df50ad603e7be59ab077f115e4bf914044`.
- Isolated working checkout:
  `/Users/paramdave/.codex/worktrees/finnor-release-candidate-5e8769e`.
- One candidate update was pushed to the existing PR #129 branch at
  `3ee2c8f`; no new PR was opened, and no PR merge or production deployment
  occurred. The follow-up repairs listed below remain uncommitted and
  unpublished in the isolated checkout. Do not treat run #160 as evidence for
  those repairs.
- PR #129 remains draft; its hosted-run status needs to be reconciled after
  the follow-up repair set is complete.

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

Passed on commit `3ee2c8f` before the current uncommitted follow-up repairs:

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

After the first hosted run, `npm run lint` passed locally with 0 errors and 6
warnings after restoring the missing frontend imports. A local backend
`npm run typecheck` remained at 0% CPU for 3m37s and was stopped; it is not a
pass. An earlier relocated-worker E2E attempt hit its child timeout, but that
result was superseded after tracing workspace resolution and the eager Steel
provider import. The latest bounded relocation E2E passed on `3ee2c8f` plus
the current uncommitted follow-up repairs in 6.05 seconds: every worker-index
dependency and owner imported, P4/M4 reported 868/870 source files, and the
projections package resolved inside the relocated candidate. Repeatable output
is at `/tmp/finnor-worker-layout-proof.C96ifV/worker-image-layout.json`.
This host-dependency relocation proof does not establish a Linux image,
multi-architecture build, or production acceptance.

## Registered worker-image relocation failure model

Before changing this isolated E2E harness, the bounded scenario is registered
as: copy the Dockerfile's worker source layout into a temporary directory,
import the real worker entry and owner modules there, then verify P4/M4 source
identity. One serial child is limited to 30 seconds and 2 MiB of captured
output. It uses the installed host dependency graph, no production credentials,
and no Docker daemon. This checks relocation/import/source-custody behavior; it
does not qualify a Linux image build, either architecture, QEMU/buildx, or the
four-class image smoke.

Failure modes to distinguish are: (1) the Dockerfile or fixture omits source,
package metadata, or canonical lock inputs; (2) workspace package links escape
the relocated source tree and load a neighboring checkout; (3) an installed
dependency or ESM export is absent/incompatible; (4) eager imports require
runtime credentials, a database, or other startup side effects; (5) a cyclic
or overly broad import graph stalls before worker startup; (6) the worker or
canonical owner export is absent; and (7) P4/M4 identity omits or misidentifies
canonical source. The evidence must retain the last import marker, actual
resolved module path, process status/signal/timeout error, and source-identity
result. Rerun this scenario only after its resolved-path boundary is corrected.

An earlier bounded run failed in 4.9 seconds at `./sse-server`, but the failure
is not yet attributable to candidate code: `@finnor/projections` resolved
through the shared dependency symlink to
`/Users/paramdave/Desktop/FINNOR/finnor-os/packages/projections/src/index.ts`,
not the relocated candidate package. That checkout exports the older
`onJarvisEventMarkProjectionsDirty` name; the candidate source exports
`onCentropyEventMarkProjectionsDirty`. The fixture currently copies candidate
source and symlinks the candidate's `node_modules`, whose workspace links point
at `/Users/paramdave/FINNOR/finnor-os/node_modules`; this allows package
resolution to escape the fixture. Correct the fixture's workspace resolution
before interpreting the next result as a source failure.

After mapping every workspace link back to the relocated candidate, an earlier
30-second run passed `./sse-server` and stopped at
`./handlers/run-computer-task`. A serial per-module probe then imported
`packages/computer/src/repository.ts` and `runner.ts` within eight seconds,
while `steel-provider.ts` timed out at eight seconds. Its eager runtime imports
include `steel-sdk` and `playwright-core`. The handler only needs that provider
after a computer job is accepted and a Steel key is present. It now loads the
provider only at that execution boundary; the latest complete worker import
pass confirms it no longer blocks worker startup in this local fixture.

## First exact hosted run on `3ee2c8f`

- Dealer replay #371 passed; CodeRabbit passed.
- Universal PR verdict #160 failed. Scope classification, OSV, and deployment
  truth/release-policy tests passed. Gitleaks, worker-image source custody,
  backend typecheck, production artifacts, and root lint failed. The stable
  required verdict failed as a consequence.
- The redacted Gitleaks report has two `generic-api-key` detections on line 14
  of the R3 handoff README, in commits `e15bebd` and `3ee2c8f`. Both refer to
  the same public API/worker/installed-source SHA-256 sentence. Each digest
  matches the corresponding committed `source-seal.json` value; no credential
  was identified. The original allowlist expected a different sentence
  format. A narrow path- and sentence-specific correction is local and remains
  unverified by the hosted scanner.

The run also exposed non-additive integration regressions: the combined
epistemic-runtime barrel omitted existing R1/R3 exports; the Capital Program
panel omitted three existing component imports; the worker registration
replaced R1/R7 handlers with a duplicate R3 handler; and existing R5/R7 route
operations were dropped. These have targeted local restorations. The worker
runtime additionally relied on deep workspace imports that escaped through a
shared `node_modules` symlink during relocation; local TypeScript path aliases
now cover the shared-types and private-equity source subpaths. This exact hosted
run still failed on its published source cut. The later local relocation pass
is on an uncommitted tree and does not clear that hosted failure.

The failing worker-image source-custody step prevented the QEMU/buildx checks,
Dockerfile validation, exact image build, and four-class/image smoke from
running. No Linux Docker image was produced by run #160. The production artifact
job failed its frontend Next.js typecheck because the three panel imports were
missing; its API artifact path did not complete. The root gate stopped at lint,
so the later root typecheck/build/browser steps were skipped.

## Registered CI event/concurrency failure model

Read-only GitHub inspection found open draft PRs #120–#126 each had a completed
universal verdict and Dealer Zero replay on their inspected heads. Existing
candidate #129 head `3ee2c8f` launched two workflows: universal verdict #160
and Dealer Zero #371. Together they produced ten workflow jobs (eight in the
universal verdict and two in Dealer Zero); these are job counts, not a count
of shell steps. Run #160 failed and skipped downstream build/image stages, so
those skipped stages are not evidence of release acceptance.

Failure modes to prevent in the next publication are: (1) universal-verdict
concurrency keyed by commit SHA, so each PR head update creates a separate
group and cannot cancel a stale run; (2) Dealer Zero having no concurrency
group, allowing overlapping synchronize runs for the same PR; (3) grouping by
PR number without a repository-wide PR identity, which could cancel another
PR's work; (4) a cancellation expression that unintentionally kills scheduled
or manually dispatched replay; and (5) changing the production-release
concurrency policy, which must remain serialized and non-canceling. The repair
will scope cancellation to the same PR number in PR-triggered workflows and
leave production-release concurrency untouched. Validate the workflow syntax
and the final exact head's single-run behavior before treating this as fixed.

Local repair status: universal verdict now groups by PR number; Dealer Zero
groups by PR number for pull requests and does not cancel scheduled/manual runs.
Ruby YAML parsing passed for both edited workflow files. `actionlint` is not
installed here, and the new cancellation behavior has not yet been exercised
on a hosted exact-head run. These workflow edits are local and unpublished.

Production-path scope audit: the governed workflow includes production DB
migration, immutable ECR image publication, Vercel frontend/API and supplier
canary deployments, and the four-class ECS compute-plane rollout. It runs the
Scope-5 certification gate, but does not invoke `release:scope5:rollout`; it
does not invoke `run-p8-production-water-retirement.mjs`. The deployment-truth
validator also enforces those exclusions. The local AWS config's selected
Region and the production contract both say `us-east-1`.

## Registered finite verification manifest

The release source cut is the existing PR #129 branch after all currently
identified integration, CI, and permission fixes are consolidated. Do not
create another PR, push piecemeal fixes, or count the failed run on `3ee2c8f` as
evidence for unpublished edits. Publish one audited source update, then require
the complete exact-head verdict and Dealer Zero replay. If a gate fails, first
identify its causal boundary and repair every independently identified issue
before another update.

| Gate | Required independent result and retained evidence | Bound / rerun rule |
| --- | --- | --- |
| Universal PR verdict | Required aggregate is green; applicable backend/root workflows complete; Gitleaks full base-to-head history and OSV dependency scan pass; deployment truth and release-policy checks pass. | Existing ceilings: backend 60m, root 45m, worker image 45m, production artifacts 15m. Rerun only on a new exact head or diagnosed external transient. |
| Backend and populated-database compatibility | Workspace/typecheck, authz matrix, generated OpenAPI parity, production manifest/Private Equity boundary, migrations and seeded disposable PostgreSQL, backend suite, and required P7 certification pass. Separately verify forward upgrade from observed production migration `0171` through required `0177`, including existing rows/job compatibility, without changing production during pre-merge checks. | Hosted backend job is capped at 60m. No repeated local full typecheck; the prior run stalled and is not evidence. |
| Worker image | Relocated source-custody E2E passes; pinned QEMU can build the ARM64 helper stage; buildx checks and builds the exact Linux/x86_64 worker image required by ECS `X86_64` task definitions; image smoke proves authenticated-owner-positive and queued-original/R3 physical restart behavior; retain JSON/log/image identity evidence. This is not a multi-platform ECS image claim. | One hosted worker job, 45m. The previous run failed before QEMU/buildx/Docker/smoke, so none of those passed. |
| Production artifacts | Build every exact frontend, API, and supplier-canary artifact; run the compiled API durable-handoff scenario and retain artifact/runtime evidence. | One hosted job, 15m. Previous run failed before completion; no artifact pass is inferred. |
| Root application | Lint, workspace and Centropy manifest/forms checks, unit suite, TypeScript, release/P8 policy, contrast, production build, public browser contract, and median Lighthouse gate all pass. | One hosted root job, 45m. Public browser coverage does not substitute for authenticated mounted Work. |
| Dealer Zero replay | Exact candidate's dealer receipt-diff proof passes on the same source head. | One workflow per candidate head; do not launch duplicate replays. |
| Mounted authenticated Work journey | On the exact installed candidate: authenticate as an eligible owner, submit an R3 request, observe durable queue/worker/checker completion and persisted result, reload/switch mounted Work, and verify owner consumption. Retain replayable evidence with exact inputs, steps, expected/observed output, release identity, and privacy/currentness. | Required before declaring software complete; candidate proof is NOT RUN. Do not substitute worker-image smoke or another source SHA. |
| Production release and deployed verification | After authorization gates, existing main-push workflow runs DB admission/migration, ECR publication, Vercel canaries/frontend/API, governed ECS four-class deployment, parity/readiness, and post-merge certification. Verify frontend/API SHAs, migration `0177`, four worker heartbeats/image digests, and authenticated mounted Work. Keep Water/P8 and Scope-5 effects off. | Job ceilings include canonical DB graph 60m, Phase-5 readiness 120m, and release stage 90m; these are maxima, not elapsed-time predictions. Release is serialized/non-canceling. Retry only after diagnosis and compatible recovery check. |

Known failure boundaries to clear before publishing: run #160 on `3ee2c8f`
failed Gitleaks on source-seal digests, worker source custody, backend
TypeScript exports/unknown catch typing, production-artifact missing UI imports,
and root lint imports. Targeted local repairs exist but have not passed exact
hosted checks. Docker build/smoke, compiled artifact E2E, and mounted Work
remain unproven. The checked-in workflow session scopes still need the exact
hosted policy gate, and the broader live/base role policy remains an open
security issue. These checks are distinct: local source-layout proof does not
clear hosted Linux image construction, and worker smoke does not clear mounted
Work.

## Required gates still open

CI-process follow-up: the shared workflow audit and local process repair are now
complete for publication (see ci-process-audit-2026-10-16.md and its receipts).
The updated backend suite uses three independent 25-minute maximum shard jobs
plus one separate 25-minute maximum P7 job; Scope-4/5 readiness uses two separate
60-minute maximum certification jobs. Older ceilings in the registered manifest
describe the prior graph, not the revised pipeline or a promised duration.
Local backend types timed out at 120.005 seconds with no compiler output, so
only exact-head hosted execution can clear that gate. No production or mounted
Work result is inferred from the process repair or zero-issue code review.

1. Finish the finite audit of all release paths before one consolidated update
   to the existing PR #129 branch. Do not create another PR or separately
   merge #126.
2. On the final exact commit, pass the universal verdict and constituent
   repository/security gates, including the QEMU ARM64 helper-stage check and
   the exact Linux/x86_64 worker image required by ECS, migration compatibility,
   production artifact builds, and authenticated API → durable queue →
   worker/checker → persisted result. The ECS image is not multi-platform.
3. Run and retain the exact `mounted-work-reload-switch` browser proof. The
   current worker-image smoke selects only authenticated-owner-positive and
   queued-original-and-R3-physical-restart; it does not run the browser/Work
   story. No result from another source cut substitutes for it.
4. Merge only after the exact source cut passes its required gates. Then verify
   production component SHAs, migration readiness, worker compatibility, and
   the deployed user journey. Keep protected production effects off.

The mounted Work story was **NOT RUN** for the candidate. The current local
host has no Docker or `agent-browser` executable, so it cannot establish the
exact mounted Work proof; the workflow's worker smoke is not a substitute.
Production was freshly checked at `/api/release` and `/api/ready`: it still
serves `517003a4396bc8101a90be4b425ee01de9446740`, with migration
`0171_runtime_database_role_isolation.sql` and four compatible worker classes.
R1–R8 are not live. Do not report the release complete until the exact candidate
passes, the mounted Work proof runs, and production is verified after merge.
