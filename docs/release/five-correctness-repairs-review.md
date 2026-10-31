# Correctness repair review

This change ports the five local repair groups onto current remote main at `df9111da8c7a1170f1f074e43fdf5984eaa55b8b`. It preserves the current Centropy namespace, expanded operation registries, worker role isolation, release gates and production writer inventory. The original workspace and its unrelated staged changes were not used as the PR tree.

## Repairs and review findings

- Session memory uses principal-scoped keys and a Redis compare-and-set operation. Every production caller uses the same employee identity. Concurrent processes retain distinct turns within the existing cap.
- Named operation checks run against the current real proxy and generated catalogue. The generator retains current delegated registries and checks additional named route switches rather than restoring the older catalogue.
- OAuth transport preserves the expected state cookie and approved browser redirect. It retains current identity-denial and retry headers, refuses foreign redirect destinations, and enforces byte limits while streaming request bodies.
- The physical queue serializes and drains heartbeat work, schedules against each declared resource lifetime, and refuses expired claims. All current native worker callers supply the relevant lease lifetime. Registration returns an idempotent retirement function, including through existing completion harness wrappers.
- The scheduled planner, tenant and load tools execute current contracts and retain failed evidence. The planner script uses a current filename because the PE retirement gate correctly rejects the old retired entrypoint. Live probes require their documented fixture configuration.

The self-review also caught a root/backend Zod version difference, a nonexistent `.mts` helper import, missing workflow lease imports, and an unpinned Redis image. These are fixed. The native queue proof uses the separate `finnor_worker` role rather than weakening application RLS. The helper's declaration describes its actual runtime exports. No production role, inventory validator or retirement guard was weakened.

## Local verification

Fresh locked dependency installs completed in both workspaces. This macOS host needed its installed Node headers supplied to node-gyp for the backend native dependency. Both full canonical compiler commands pass without excluding an iCloud fixture.

- `npm run typecheck --prefix finnor-os` and `npx --no-install tsc --noEmit -p tsconfig.json`.
- `npm run lint` and `npm run test:unit`: all 29 root tests pass.
- `node scripts/release/verify-ci-workflows.mjs`: actual pinned actionlint, workflow policy and shell syntax checks pass.
- `npm run release:preflight`: deployment truth, generated source contracts, PE retirement boundaries, release governance and production mutation inventory.
- The real Redis memory driver passes all six cases, including process concurrency, identity isolation, TTL and malformed-data refusal.
- The real proxy driver passes its named operation, missing caller, unknown operation, OAuth protocol and byte-budget checks.
- The browser OAuth driver passes all eight checks against the actual connection owner and disposable PostgreSQL.
- The native queue driver passes all five timing, drain, retirement, expiry and successor-fence cases.
- The native tenant probe passes its valid case and rejects deliberate cross-tenant exposure and missing markers.
- The planner CLI passes all 41 fixture cases, fails at 40/41 for one wrong proposal, and fails at 0/41 for a bad envelope.
- The real k6 executable passes the valid protocol case, fails missing readback and approval conflicts, and refuses production before writing.

Commands and requirements for reproducing the drivers are in [correctness-regressions.md](correctness-regressions.md). Each driver produces machine-readable observations and rerun information. CI runs the regression drivers in one bounded job with its own Redis service, fresh dependency graphs, browser installation and retained artifacts.

## Qualification limits

This is sequential self-review by one agent. No independent review is claimed. GitHub CI results belong to the published PR head and are separate from these local results. Live model quality, hosted JWT isolation, real OAuth consent and staging throughput have not been qualified. No deployment or production mutation is requested. Current tenant marker and staging load fixture secrets require configuration before their scheduled live checks can pass.

## Follow-up after the first hosted run

The first hosted run failed before backend, root and readiness execution. Two distinct causes were retained and reproduced locally.

### Standards

The initial repair added Zod 3.25.76 to the memory workspace while the repository uses patched Zod 4.6.7. That introduced an advisory and a private nested dependency tree. The package now uses the repository version and the explicit key/value record schema. The lockfile contains no nested Zod 3.

The dependency gate also found glob and minimatch advisories in the root toolchain. Glob now resolves to 14.0.2. Modern minimatch consumers use 11.0.1; legacy callable consumers use the documented adapter in `vendor/minimatch-compat.md`, which delegates matching to unmodified 11.0.1. No scanner exclusions or advisory suppressions were added. OSV 2.3.8 scans both lockfiles with no findings.

### Spec

The required source check must prove that test shards partition the actual suite. The programmatic Vitest call replaced its default exclusions with a single retired-file exclusion. A nested dependency therefore added its own tests to the runtime discovery result. The verifier now combines the installed Vitest default exclusions with the existing retired fixture exclusion. It verifies all 231 active files, 77 per shard, and all public owner export resolutions. The exact original failure is reproduced before the correction; it was not a failure of the business test suite.

These are sequential self-review findings, with the fixed comparison point `df9111da8c7a1170f1f074e43fdf5984eaa55b8b` and diff `git diff df9111da8c...HEAD`. Standards sources are `AGENTS.md`, the existing CI process policy and production dependency/security gates. Requirements come from the five-issue repair request and this PR's repair record. Tool-enforced diagnostics are reported as verification results rather than style findings. No independent review is claimed.
