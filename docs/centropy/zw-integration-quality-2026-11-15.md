# Z/W integration candidate — 15 November 2026

This branch is the integration candidate, not a phase-completion certificate.
It combines Z `6c9f9f693010c37e6786c083c708909495392797`, the employee/privacy/recovery
candidate `72b6657b6845fab988c0e02b58418f4796fd93d4`, and published W diagnostics
`25586e2e3f1a783d53591df548eabdee60c8d10f`. Main has not been changed.

## Concrete repairs

- Reconciled Z/W query intents, native owners, worker registrations, canonical
  planner imports, enterprise belief reads, authority calls, and generated inputs.
- Kept employee Work ownership and recovery fences. Native observation now
  checks the authenticated employee before private inputs, authority evaluation,
  or the four private readers. A refusal uses the ordinary opaque Work 404.
- Added explicit owner checks to capability administration. Participants are
  rejected before capability intake or connected-source creation.
- Added a forward migration for participant creation and owner demotion. The
  legacy authority trigger previously tried to assign a nonexistent participant
  role; participant identities now deactivate employee role assignments and use
  their explicit workforce bindings. No grant is created for them.
- Preserved serialized job renewal. Physical guards inherit the actual job
  lifetime; Z2/Z5 resource owners renew at the shortest acquired resource lease.
- Made native fixtures explicitly use loopback TCP, aligned Z3 reconstruction
  with the exact release Node pin, restored Z1 frontend install selection, and
  repaired the API webpack callback's missing development argument.
- Made Rust manifests, lockfiles, and toolchain configuration require dependency
  review, and added the actual Z4 Cargo lockfile to security scanning.
- Regenerated the combined migration bundle, API contracts, clients, capability
  inventory, forms, source stamps, and planner manifest with their generators.

## Verification actually completed

| Check | Observed result | Limit |
| --- | --- | --- |
| Frontend and backend TypeScript | Pass | Static verification |
| Fresh PostgreSQL migration | 263 applied; replay applied zero | Before new participant repair |
| Forward participant migration | 264 total; replay applied zero | Real local PostgreSQL |
| Authenticated HTTP suite | 19 passed, zero skipped | Synthetic identity provider; actual routes, SQL and app role |
| Job/lease verification | 6 passed | Actual PostgreSQL jobs, deliveries, permits and wall clock |
| Z1 process suite | 256 passed | Public original semantics; no native-owner acceptance |
| Z2 process suite | 256 passed; 32 structural families; 248 useful positives | Public source replay; no protected acceptance |
| Z3 process suite | 3,892 requests; zero failures | Finite public suite; no installed-owner acceptance |
| Release consistency | All 16 checks passed | Generated-source consistency, not runtime or business proof |
| Dependency policy | 6 tests passed | Gate behavior; not a completed vulnerability review |
| Frontend and API production builds | Both passed | Does not prove the mounted journeys |

HTTP tests reproduced both defects before repair: a foreign economic Work query
returned 500, and participant demotion failed in the authority trigger. After
repair, all 19 cases passed, including the four native reader refusals, seven
owner capability refusals, new participant creation and canonical query replay.
Lease verification retained a resource through two expiries, serialized slow
renewals, drained callbacks, rejected expired jobs and preserved a successor's
fence. Exit zero without the complete expected receipt was not counted as pass.

## Work still open, in order

1. **Run the mounted Z0 gate on this candidate.** The branch now selects the
   existing pinned browser workflow and all 11 M cases. Local setup stopped at
   pinned Auth installation, before the application ran. The newest previous
   hosted Z tip failed M01 (panel unmounted) and M04 (reload/budget comparison),
   leaving eight cases unrun. The merged candidate has not inherited a pass.
2. **Resolve W2's actual settlement currentness defect.** The prior atomic
   settlement receipt established the native payment operation, consumption and
   certificate joins, but the current cut differed from the checked/certified
   cut. Capture a structural cut delta at the original check, certificate and
   close boundary in a rollback-only diagnostic. Replacing the cut, relaxing
   currentness, or merely calling the receipt helper again cannot establish
   settlement correctness.
3. **Recover the current W4/W5 source.** The transcript references local
   `0b717dc8`, `25ee3ba6` and `f43bb91daf`; those objects were not available from
   the accessible repository. Integrate the real source, regenerate its inputs,
   then rerun its signed journey and effect-barrier acceptance. Transcript claims
   cannot substitute for those files.
4. **Build and qualify the installed native paths.** Local Z4 supplementary
   execution stopped because its compiled proof binary was absent. That is a
   blocked run, not twelve passing negative tests or an execution proof. Z1–Z5
   process success does not certify packaging, real owner custody, reconnect,
   revocation or physical recovery. W1/W3 full owner acceptance also remains open.
5. **Measure the product gain on a real completed journey.** Use one deal from
   signed instruction through evidence, check, close, payment and recovery.
   Record correctness, successful completion, elapsed time, human intervention,
   latency and actual cost against the same baseline cases. “10× product” and
   “100× utility” are targets until that comparison exists.

Keep one candidate and one gate ledger. A phase closes only with a passing
receipt tied to its actual source, installed artifact and original authority.
Fix the failing owner or contract before adding another feature or rewriting
the expected result. Do not merge this candidate to main on static checks alone.
