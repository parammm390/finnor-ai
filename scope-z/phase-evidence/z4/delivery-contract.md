# Reconstructible delivery, failure model before packaging implementation

The handoff must contain all seven required labels, actual source/base/head/tree
and build/patch identities, a complete owned-source inventory and archive,
native binaries with their source/build receipts, exact shared proposals,
generated deltas, original failures and a hashed evidence index. No coordinator
acceptance gate may be written by the lane.

Packaging must reject path escape, external symlinks, missing or changed source,
missing runtime trace assets, incomplete check reports or source drift. A
source archive is not an installed archive. An installed archive must contain
the actual independently built frontend/API, canonical source/native assets,
declared Node/npm, required runtime dependency traces and the concrete replay
driver's Playwright packages. Never silently borrow another checkout's module,
binary, Git directory or source after extraction.

Archives use normalized metadata and content hashes. Verify every archived
regular member against its manifest by reading it back. The evidence index
excludes only declared reconstruction payload caches, generated target trees
and the output bundle itself. It retains failed reports and original logs.
No protected definitions, credentials, Auth tokens, private logs or customer
content may enter a publication artifact. This local engineering bundle is
not publication permission.

No actual native E2E or protected/financial qualification can be inferred from
successful packaging. Actual source/installed native execution still requires
separate current coordinator-owned grants and independent original-case
custody. Missing or failed engineering remains a blocker, never a PASS.

Replay dependencies require their complete declared installed dependency
closure, not just the top-level tsx or Playwright directory. Include the exact
workspace production roots and recursively resolved dependencies, with
platform-absent optional/peer dependencies distinguished from missing required
dependencies. Do not resolve outside the target.
Include both frontend and API traces. Workspace links must include their
actual package source and production dependencies, since the concrete worker
imports source rather than only the compiled API. Staging-only lineage and
inventory files are delivery metadata, not proposed shared product files.

Identical regular archive members may use an earlier declared hardlink with
the same content hash and executable mode. Readback must validate that target
and extract/hash every member; this must not introduce external filesystem
links or weaken the complete denominator.

An installed loader declares its actual extracted root. Runtime source/native
paths must use that root if a bundled import URL still names the build host.
No installed replay may drop the import-boundary preload. Credential-free
packaging is not proof of an authenticated running server.
