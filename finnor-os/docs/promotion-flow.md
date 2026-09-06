# Canonical production promotion

The machine-readable authority is [`../../infra/deployment/production.contract.json`](../../infra/deployment/production.contract.json). If this document and the contract differ, production preflight fails.

Production topology:

- frontend and API: the exact Vercel projects in the contract;
- worker: the exact Azure VM and systemd unit in the contract;
- orchestrator: embedded in the worker process unless the contract explicitly changes to a separate required target;
- database: the contracted production host and migration head.

`.github/workflows/production-release.yml` is the only production release path. It has one production concurrency lock and executes one sequential release:

1. prove `HEAD` equals the fetched `origin/main` SHA and the tree is clean;
2. validate the deployment contract and required credentials;
3. resolve Vercel, Azure, database, environment, and migration targets before mutation;
4. run release and Phase 1–3 gates;
5. confirm migration compatibility and apply only pending migrations;
6. deploy Vercel frontend/API and the Azure worker at the same SHA;
7. verify API, frontend, worker heartbeat, embedded orchestrator, Azure source checkout, and database head;
8. run production smokes and repeat parity verification.

Any missing required runtime, stale target, dirty/non-main checkout, failed authentication, migration inconsistency, or SHA mismatch makes the release FAILED/PARTIAL. A partial deployment is never PASS.

Staging has no implied provider or guessed resource name. It may be enabled only after its own independently discovered contract is committed and validated; production identifiers must never be reused for staging.
