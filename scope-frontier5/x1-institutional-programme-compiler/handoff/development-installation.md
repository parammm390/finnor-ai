# Compiled local development installation

This entry uses the existing API route handlers, `createWorker()` registrations,
native SQL migration owner and independent checker. It grants no qualification,
admission, effect permission or production authority. The normal Next production
entry retains its X1 refusal guard.

Build committed product source once, with at least the registered 2.5 GiB free:

```
node finnor-os/scripts/frontier5/x1/build-development.mjs --output <new-absolute-installation-directory>
```

The installation contains one canonical source tree required by the retained
owner fingerprint readers, both locks, profile and all migrations, compiled API
routes/worker/checker/migration owner, actual dependency bytes and internal links.
The fixed `finnor-os/x1-development-installation.json` records source commit/tree,
file hashes and modes, link targets, Node binary/platform, schema lineage and
compiled entrypoints. Startup verifies these preimages at its own installed
location; it cannot select a builder tree through CWD or an environment variable.

Use the recorded Node binary/runtime. Supply existing disposable loopback database
and Supabase-compatible local auth configuration through the host's secure
environment: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
Use restricted `finnor_app` for API and `finnor_worker` for worker. Neither may be
superuser/BYPASSRLS and the app must not inherit worker membership. The complete
packaged SQL lineage must be installed before API/worker startup.

```
NODE_ENV=development AUTH_DEV_BYPASS=0 FINNOR_P4_PROFILE=ordinary_disposable node <installation>/finnor-os/x1-runtime/api.mjs
NODE_ENV=development AUTH_DEV_BYPASS=0 FINNOR_P4_PROFILE=ordinary_disposable node <installation>/finnor-os/x1-runtime/worker.mjs
```

The API binds `127.0.0.1`, default port3100 (`PORT` may choose another local port).
The worker uses actual queue lease recovery and fenced job delivery, and drains
after the registered600-second development worker bound. The separate compiled
checker receives only PATH, development mode and the non-secret disposable
profile marker, with no database/app credentials. Its three-source algorithm
revision remains separate from the compiled installation identity. Relocation
creates a new installed method identity; restart at the same location preserves it.

Finite checks:

```
node finnor-os/scripts/frontier5/x1/installed-contract-cases.mjs --installation <installation> --evidence <fresh-registered-private-directory>
node finnor-os/scripts/frontier5/x1/verify.mjs --stage installed --case delivery --installation <installation> --evidence <fresh-registered-private-directory>
node finnor-os/scripts/frontier5/x1/verify.mjs --stage installed --case upgrade-installed --installation <installation> --evidence <fresh-registered-private-directory>
```

The first checks precise production/profile/byte/link/custody refusal and restores
every temporary mutation. The others require actual installed auth/API/SQL/job/
worker/checker/native Work behavior. Restart requires new queue processing under
the original frame, not reading a historical completed request. Retained upgrade
proof binds the unchanged173 base SQL files to the historical base and applies
the current additive190-file lineage, preserving old Work/users/Core and old/new
job dispositions. A command or manifest is not a PASS; use actual run receipts.

Whole backend types previously exceeded the frozen1536 MiB heap and remain a
retained failure. Leaf/scoped types and source-run E2Es do not replace installed
proof, final mounted proof, matched diagnosis, independent native scrutiny or
the remaining delivery gates. Monetary/human/aggregate-memory costs remain
unknown where no actual owner measurement exists; local build bytes/time are
development measurements, not qualified business gain.
