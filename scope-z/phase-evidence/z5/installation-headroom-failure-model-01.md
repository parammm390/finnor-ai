# Point-of-use installation headroom failure model

Written before changing the reconstruction driver. Checkpoint 07 is immutable,
SHA-256 `882d3709b403d1bccb571b1a0c3b96906ed20aa3b8fa9044ca38acfbda9253a3`.
Its 36-file code digest still matches actual source:
`7f714420d589fd2e28e6bbe52d81b2f3bfb15c9e3b8eac98b205f5acada5d9b4`.
This is source diagnosis, not an executed installation failure.

## Failure and required behavior

The existing reconstruction driver checks the 8-GiB install floor before
extraction, source replays and heavy-lock waits. Both later `npm ci` commands
hold the heavy lock, but neither rechecks disk space after acquiring it.
Extraction, earlier steps or another lane can consume the observed space.
The first or second install can therefore start below the unchanged floor.

Keep the initial early refusal, then check actual free space again inside
the same held heavy lock immediately before EACH root/backend `npm ci`.
Keep that lock through the check and install, without a shell or lock gap.
Do not lower the threshold, clean another lane's files, borrow modules or
count the lock alone as a disk reservation against an uncoordinated writer.

Use one common headroom predicate for the initial check, point-of-use checks
and a strictly read-only diagnostic CLI. Require the pinned Node version and
an absolute diagnostic directory. Invalid or unrepresentable space cannot
grant installation. Missing paths/errors fail without install.

Under the floor, return exit 2 with measured/required bytes and explicit
zero installs, DB actions and listeners. At or above the floor, the diagnostic
returns 0 meaning HEADROOM ONLY, never installation/source/build proof.
The actual install path may continue only after its own fresh successful
check. Propagate guard/spawn/npm failures and preserve the original bounded
owned-process-group cleanup; no detached child or background install.

## Bounded verification before any product execution

Run the production driver's read-only headroom CLI on this existing worktree
under the shared heavy lock in a credential-free environment. It never reads
a delivery receipt/archive, creates an extraction target, installs modules
or invokes npm, regardless of free space. Current measured free space is
2,919,809,024 bytes versus the unchanged 8,589,934,592-byte requirement, so
the expected observed exit is 2. Retain the actual measurement and exit.

Check the changed MJS and its embedded install wrapper syntax without
executing the wrapper. Inspect that both `npm ci` calls are reached only
through the wrapper that holds the lock across preflight and installation.
This is a bounded real driver guard, not a unit suite, fake archive, staged
source package or substitute for installed engineering.

Actual archive extraction, npm execution, application builds and cold replay
remain NOT_RUN after Shield's denied commit. No flagged evidence read,
commit retry, exclusion, alternate package, new DB/Auth/listener authority or
coordinator gate is authorized. Preserve the original source-guard failure
and all earlier checkpoints/receipts.
