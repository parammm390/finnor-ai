# FINNOR R cumulative release verification manifest

Schema: `finnor.r.release-verification.v1`

This manifest records the cumulative R1–R8 candidate after the exact R3 owner
integration and before the remaining hosted image and authenticated end-to-end
checks. It is a finite engineering verification record, not an admission,
deployment, post-X gain result, or economic qualification.

## Frozen source cut

- Repository: `parammm390/finnor-ai`
- R8 base commit: `f70d71f5194cdb28c8bb293f9a538ebc205ef5df`
- R8 base tree: `1dadcfe3f03c110223615a837d2ae91c967d6d33`
- Acquisition: public GitHub codeload archive, isolated checkout
- Current release worktree: `/Users/paramdave/.codex/worktrees/finnor-r-release-e5a590`
- Production mutation: prohibited for this verification; merge and deployment
  require separate explicit authorization.
- Candidate branch: `codex/r3-on-r8-cumulative-2026-10-16` (published head is
  recorded by the reviewable draft PR).

## Scope map and current inclusion

| R scope | Current implementation evidence | Current status |
| --- | --- | --- |
| R1 CertifiedStateReduction | `finnor-os/packages/epistemic-runtime/src/certified-state-reduction/`, `finnor-os/packages/private-equity/src/r1/`, migration `0172_r1_certified_state_reduction.sql` | present in source cut |
| R2 RobustProgrammeSearch | `finnor-os/packages/epistemic-runtime/src/r2-*`, `finnor-os/packages/private-equity/src/capital-program/r2-*`, migration `0173_r2_robust_programme_search.sql` | present in source cut |
| R3 IncentiveRuleSynthesis | `finnor-os/packages/epistemic-runtime/src/incentive-rule-synthesis/`, `finnor-os/packages/private-equity/src/r3/`, authenticated owner route `/api/elicitation-protocols/[operation]`, migration `0177_r3_incentive_rule_synthesis.sql`, installed-runtime and owner-e2e scripts, and `scope-r/r3-incentive-rule-synthesis/` handoff | present in candidate, hosted qualification pending |
| R4 IdentificationPlanCompiler | `finnor-os/packages/epistemic-runtime/src/identification-plan/`, `finnor-os/packages/private-equity/src/r4/`, migration `0174` | present, joined qualification incomplete |
| R5 CoalitionProgrammeSearch | `finnor-os/packages/epistemic-runtime/src/coalition-programme-search/`, `finnor-os/packages/private-equity/src/capital-program/r5-*`, migration `0175_coalition_programme_search.sql` | present, joined qualification incomplete |
| R6 VerifiedCapitalCompiler | `finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/`, `finnor-os/packages/private-equity/src/r6/` | present, joined qualification incomplete |
| R7 PolicyAtlasCompiler | `finnor-os/packages/epistemic-runtime/src/policy-atlas/`, `finnor-os/packages/private-equity/src/r7/`, migration `0176_r7_policy_atlas.sql` | present, joined qualification incomplete |
| R8 CounterexampleGuidedSolverSynthesis | `finnor-os/packages/epistemic-runtime/src/solver-synthesis/`, `finnor-os/packages/private-equity/src/r8/`, `scope-r/r8-repaired-adoption/`, existing cumulative draft PR #126 | present in existing cumulative R8 candidate |

R3 was recovered from the exact local owner worktree at commit
`3113d354f6b70369ee2f1b72b96820353d56f99f` and integrated additively into the
existing R8 candidate. R8 application behavior was not rebuilt or replaced.
The candidate still cannot claim production qualification until the hosted
Linux image, authenticated database/queue/owner flow, and finite acceptance
checks pass on the published branch head.

## Finite checks

### Already executed on this source cut

1. Parse all active GitHub workflow YAML files with Ruby YAML parser.
2. Confirm every GitHub Action reference uses a full 40-hex commit SHA.
3. Run `npm run release:truth`.
4. Run `npm run test:release` and retain the complete stdout. Expected result:
   80 passed, 0 failed, 0 skipped; production mutation inventory `ok: true`.
5. Recover and integrate the exact R3 owner source; verify Python syntax, the
   registered small complete-grid reference (`4096` allocations, `16` feasible),
   the four-party/three-type/81-profile fixture shape, shared contracts, route
   registration, migration bundle, and capability/OpenAPI generation.

### Remaining engineering checks

1. Run `bash -n scripts/release/smoke-worker-image.sh` and the changed workflow
   static checks.
2. On a Linux runner with Docker, install the locked `finnor-os` workspace,
   bundle/migrate a disposable PostgreSQL database, build the exact worker
   image from `finnor-os/Dockerfile.worker`, and run
   `scripts/release/smoke-worker-image.sh` with no production credentials.
3. Retain the image ID, image labels, Dockerfile digest, four class health and
   SIGTERM receipts, R1 owner/checker receipt, and installed R4 receipt when
   the source cut contains R4's integrated runtime.
4. Run the repository's applicable hosted backend/root/security checks on the
   exact published branch head. A green PR check is evidence for that exact
   head only.

### Explicitly not run or not authorized

- Authenticated protected owner/admission activation, production AWS/Vercel
  mutation, live financial effects, protected comparative gain, and S7 H2
  economics.
- Authenticated R3 owner/database/queue/worker E2E and installed runtime proof
  on Linux have not yet been run on this candidate.
- Any claim that the older Scope-3 compute-plane certification satisfies R3.

## Completion interpretation

`PASS` on the finite engineering checks means only that the named source,
runtime, workflow, and release-boundary checks passed. It does not upgrade
`UNKNOWN`, `UNQUALIFIED`, `NOT_RUN`, or `MISSING` owner/admission/economic
states into completion. The release gate remains closed while the joined
installed owner qualification and authenticated R3 acceptance are incomplete.
