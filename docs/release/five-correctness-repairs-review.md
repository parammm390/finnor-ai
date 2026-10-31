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
