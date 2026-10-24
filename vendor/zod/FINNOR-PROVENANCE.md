# Local Zod compatibility security backport

This is `@finnor/zod` version `3.25.76+finnor.1`, a local fork, not a published upstream Zod 3 fix. It follows the existing `@finnor/braces` vendored dependency convention.

- Source: official npm `zod@4.6.7`, pinned by SHA-512 in `scripts/security/build-zod-compat.py`; MIT license and upstream attribution remain inside the archive.
- The normal import explicitly selects the bundled v3 compatibility entry. Declarations, legacy schema classes and internal JSON Schema readers therefore keep their existing contract. Explicit v4 exports retain the patched upstream v4 implementation.
- The upstream v3 compatibility implementation still traverses bounded oversized collections. The local backport refuses oversized `.max()`/`.length()` arrays and `.max()`/`.size()` sets before visiting their elements. It updates CJS, ESM and TypeScript source together. Valid data and lower-bound validation retain their original behavior.
- `collection-size.patch` records every source/manifest change from the pinned archive. No vulnerability ignore or security gate change is used.
- Rebuild: `TMPDIR=/dev/shm python3 scripts/security/build-zod-compat.py`. Rebuilding an existing artifact must reproduce its bytes exactly.
- Verification: `node scripts/security/zod-size-boundary.e2e.mjs /absolute/path/to/installed/zod /new/absolute/evidence.json`. It checks max/exact/nested/async bounds, valid transforms, lower bounds and retained legacy classes. Run the existing application checks and current OSV scan as well.

The compatibility fork is intentional maintenance debt. Remove it only after a qualified upstream v3 backport or a separately checked project-wide v4 migration, not by silently changing the default schema API.
