# Worker container startup repair

Merged base: `61d56545a37ea1de4d8da8063be6d5aafaf5287c`.
Failed production run: `37861328276`, release job `113599084809`.

Required PR CI, canonical traversal, root browser/build gates, Scope 4/5 and
post-merge certification passed. The image built successfully, then the worker
crashed before health startup:

`ENOENT /finnor-os/packages/private-equity/src/decision-slice/contracts.ts`.

The Dockerfile flattened the workspace into `/app`, while native source custody
uses canonical repository-relative paths. The image now retains
`/app/finnor-os`, the root lockfile and the canonical production contract.
Package-relative native methods, immutable source checks and execution authority
are unchanged. A Dockerfile-specific allowlist excludes credentials, host
dependencies and generated evidence from the root build context.

The before-code relocated-process proof reproduced the same missing-file crash.
After repair, the actual worker imports and P4/M4 rechecks pass with 723/725
source files. This host-dependency proof is not a Linux image result.

Both production and mandatory backend PR CI now execute the same smoke script.
It builds the real locked Linux image, starts all four compute classes against
disposable PostgreSQL, checks exact release/class health, requires clean SIGTERM
shutdown and retains repeatable receipts, health bodies, image identity and logs.
An early container exit fails immediately rather than generating a minute of
empty JSON errors. No production credential or cloud mutation is required.

Local validation: 80 release checks, relocated-worker end-to-end proof,
deployment truth, unchanged seven-writer inventory, scoped lint, all seven
workflow expression checks and shell syntax pass. Actual Linux image validation
must pass in the repair PR before merge; do not label a queued job as passing.

No AWS operation or deployment was performed. Existing live permission and
infrastructure-baseline prerequisites remain separate and are not bypassed.
