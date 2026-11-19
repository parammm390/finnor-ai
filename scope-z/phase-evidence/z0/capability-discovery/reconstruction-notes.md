# Discovery evidence reconstruction, before packaging code

The private snapshots are retained locally and excluded from Git. The evidence
archive must preserve all six attempts, not only the passing run. Four early
attempts failed in harness setup; the actual unchanged-product baseline then
reached the intended boundary and failed 14 of 18 checks. The repaired run passed
18 of 18. Setup failures must not be counted as product regression evidence.

Credible packaging failures:

- The source hash exists but the matching source preimage is missing.
- CLI generation overwrote an initial manifest/report inside the snapshot.
- Borrowed workspace links resolve into the parent's product source.
- Failed runner versions or command errors are omitted.
- A path traversal, symlink or oversized file enters the archive.
- The archive changes across identical builds or cannot verify its own members.
- Credentials or user data are printed or inferred from successful tooling.

Package source inventories and per-run overlays against the exact recorded Git
base. Every overlay byte must match the initial inventory. Recover an initial
mutable JSON from the pinned Git object or a still-matching coordinator file,
not from a later generated output with a different digest. Fail rather than
invent a missing preimage. The archive excludes nested checkouts and dependency
directories. It includes original reports, commands, direct observations and
the exact runner/oracle versions needed to reproduce failures.

For each run, reconstruct a new task-owned checkout at its recorded Git base,
apply only that run's `source-overlay/` files, and verify every path/size/SHA-256
against its `source-inventory.json`. Install both locked dependency graphs with
Node 22, then run the corresponding `scripts/centropy/verify-capability-discovery.mjs`
with a new absolute evidence directory. Do not apply overlays over user work.
The first four runs are intentionally broken harness versions.

The TS loader's reviewed optional local parent-IPC attempt is denied and recorded
separately. Product registration has no permitted network or action attempt.
This is not OS-level confinement; esbuild subprocess confinement, all possible
network APIs, clean application installation and authenticated owner flows are
outside this source-contract evidence.
