# Independent local reconstruction contract

Registered before the source-object reconstruction helper. This is a separate
gate from copied-asset installed execution and from protected qualification.

## Chosen construction

1. Commit the reviewed task source locally using the environment's configured
   identity. No push, publication, history rewrite, credential changes or donor
   checkout repair.
2. Reconstruct safe committed files into a new private directory by reading
   immutable Git blob objects, not by copying the working tree, `.git`,
   `node_modules`, build outputs or donor files.
3. Match the existing installed builder's exclusions: credentials ledger,
   `.env*`, Git/build/cache/evidence directories and dependency directories.
   Exclusions are recorded. Do not inspect or copy excluded content.
4. Verify Git blob IDs, byte lengths, SHA-256 hashes, file modes, safe relative
   paths and symlink containment. Bound the export to 512 MiB total and
   256 MiB per blob. Write new files with exclusive creation.
5. Initialize an independent Git repository, recreate its blob objects and
   index, and verify all selected blob IDs/modes. Stop for staged-diff/status
   review before its local snapshot commit. Never override author/committer
   identity or bypass hooks.
6. Recheck every emitted Y5 source pin from the reconstructed bytes. Record
   original commit/tree, sanitized snapshot tree, exclusions and all file
   hashes. A different sanitized tree is expected, not evidence of identical
   whole-repository custody.
7. Run the reconstructed installed builder with `--fresh-locks`, a new output
   directory and an isolated HOME/npm cache. Require both actual `npm ci`
   commands from the committed root/backend locks. Do not borrow a host
   `node_modules` tree or copied compiled API/worker/frontend output.
8. Explicitly declare the already selected Lean/Python base assets passed by
   `--native-assets`. Verify their inventories and rebuild the numerical
   environment using the existing requirements. This is not a fresh Lean
   download, complete package-hash lock, redistribution audit or trust proof.
9. Execute the new compiled API, emitted worker and native proof/check/use
   from that reconstructed runtime. Compare source pins, same-definition
   correspondence, original S5 results, authority flags and durable owner
   evidence. Keep copied-asset and fresh-lock receipts separate.

## Failures to retain

- Dirty or uncommitted required source, unavailable Git objects or missing
  source pins: refuse, do not silently use working-tree bytes.
- Unsupported object kind, malformed path, traversal, symlink escape,
  collision, oversized blob/export, byte/hash/mode mismatch: stop.
- Existing output directory: refuse; never merge, remove or overwrite it.
- Git identity missing, unexpected staged content or a failed hook: report
  and stop. Do not invent identity or disable verification.
- npm/Python resolution/build failure, dependency resolution escaping the
  new runtime, changed source during export/build, wrong emitted bytes or
  runtime accidentally resolving the checkout: fail reconstruction.
- Native physical completion unknown: retain the original lease/cost
  uncertainty and failed receipt. Do not relabel it as a clean shutdown.
- Source-tree/asset differences, unresolved LFS assets, unsupported host,
  unaudited package provenance or incomplete resource metering: state the
  exact boundary; do not promote reconstruction into a stronger trust claim.
- Browser renderer blockage: retain it as BLOCKED. A backend pass or cleanup
  receipt cannot satisfy mounted Work, delayed-poll or interaction gates.

Each build remains subject to its existing finite command deadlines and disk
preflight. Record source export, fresh dependency installs, builds and actual
runtime verification separately. Complete money and aggregate peak memory
remain unknown unless measured, never zero by default. No protected admission,
production activation, external provider action or 100x claim follows.
