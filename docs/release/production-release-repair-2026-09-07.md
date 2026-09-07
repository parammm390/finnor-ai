# Production release repair — 2026-09-07

Run 132 passed readiness and the worker image smoke test but stopped at database
preflight. The database records independent historical migrations 0104–0108 from
commit `f40526617c7e22258c12a2b669975ddaaf33e7fc`. The current PE branch reused those
numeric prefixes for different migrations. A name-only allowlist covered only 0102.

The release policy now recognizes the exact historical names while requiring the
0109 forward repair. Unknown migrations and a newer migration head remain errors.
No production migration records are deleted, renamed, or marked applied manually.

Replaying the historical SQL exposed a second failure: historical 0107 changes
`communications_log` into a view, while candidate 0104 and its copy in 0109 install
a BEFORE ROW trigger on it. Both now restrict those triggers to physical tables.
The underlying `messages` table retains its vertical guard. Existing migration
identities remain the same; this compatibility correction affects pending execution,
and 0109 carries the same correction for databases that already applied 0104.

The new disposable rehearsal runs in the canonical gate. It applies the current
shared baseline through 0103, seeds synthetic tenant/household/message history,
applies the five historical migrations fetched from the pinned old commit, and
upgrades to current migrations. It verifies retained message/ledger rows, a no-op
rerun, and fresh database migration. It does not clone production data and cannot
prove compatibility with every production row or external service state.

Release reruns now reuse the immutable ECR image for the commit and smoke-test it
again. The remaining release scripts use the bounded Git cleanliness scan already
used by verify-release, avoiding recursive traversal of untracked artifact trees.

Validation: historical/populated upgrade and fresh migration passed; TypeScript
typecheck passed; worker health regression passed; all seven release-policy tests
passed; deployment contract validation and workflow YAML/shell parsing passed.
Earlier run 132 passed the full Phase 5 readiness suite. The new production run
must still execute its own gates and live deployment verification.

This is a release-path audit and verified repair, not certification that the entire
application or every repository setting is defect-free.
