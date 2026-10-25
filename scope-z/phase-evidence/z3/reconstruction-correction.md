# Current Z3 bounded reconstruction protocol

This supersedes `reconstruction.md`. The original mathematical profile and
native-owner correction at ae8d1f6 are unchanged. The final delivery adds
packaging corrections, not a new native implementation or qualification.
Exact cut/archive identities and exits are in the current handoff and frozen
delivery receipts. Historical failures and incomplete targets remain intact.

## Source distribution and source-only checks

Use pinned Node 22.23.4. From `/home/factory-user/repos/finnor-z3`:

```sh
node /home/factory-user/repos/finnor-z3/finnor-os/scripts/project-z/z3/prepare-reconstruction.mjs \
  --packet=/home/factory-user/repos/finnor-z3/scope-z/phase-evidence/z3/integration-corrections/v4 \
  --output=/absolute/fresh-owned-reconstruction
node /home/factory-user/repos/finnor-z3/finnor-os/scripts/project-z/z3/verify-reconstruction-source.mjs \
  --reconstruction=/absolute/fresh-owned-reconstruction \
  --original-repository=/home/factory-user/repos/finnor-z3 \
  --output=/absolute/fresh-owned-source-check
```

The source directory is a regular copy, not a worktree or symlink. The recipe
applies all sixteen exact patches with GNU patch, zero fuzz, checks preimages
and postimages, and retains every application exit. It includes canonical
packages/apps/frontend sources, the actual production `coverage/route.ts`,
root build configs, both inspected credential-free `.npmrc` policies, pinned
producer/checker, frozen public cases, independent oracle, finite runner,
and retained 3,892-record mathematical reference.

`source-inventory.json`, `source-modes.json` and normalized `source.tar.gz`
are authoritative, not HEAD alone. The verifier checks exact membership,
regular-file content/modes, actual compressed archive payload, both patch
directions and approved replay assets. The optional original repository is
used only for commit/tree/preimage/canonical-denominator correspondence,
never as a runtime or build fallback. Without that argument the stdlib-only
archive/patch checks require no Git objects or dependencies.

The archive excludes dependencies, Git metadata, dotenv files, credentials,
runtime data and bulky historical evidence. The separate retained/frozen
receipts identify older targets without replacing them. No source-only check
is an installation, native Work proof or accepted scheduling gate.

## Catalogue correspondence

V4's first four patches are byte-identical to v3. Its remaining three supply
the standalone generator, generated manifest and coverage postimages that
were missing from the first installed distribution. The real generator and
coverage audit run unchanged in `--check` mode. Expected standalone count:
583 HTTP + 77 planner = 660, zero unresolved dynamic calls.

The current coordinator already has equivalent Z3 catalogue semantics and
all four owner changes, including S5's disjoint Z1 composition. Do not
reapply this packet or replace the combined global generator/catalogues.
The exact full Z3 rows, shared modes/postimages and adopted owned leaves
are compared in the delivery correspondence receipt.

The exploratory catalogue copy openly uses existing dependency symlinks.
That is source-only generation evidence, never an independently installed
receipt. The final distribution itself contains no dependency symlinks.

## Producer reproduction and approved assets

Esbuild embeds entry-relative path banners. This exact **root-cwd** command,
using lockfile esbuild 0.25.12, is the approved recipe:

```sh
cd /absolute/reconstruction/source &&
finnor-os/node_modules/.bin/esbuild finnor-os/scripts/project-z/z3/cli.mts \
  --bundle --platform=node --format=esm --outfile=/absolute/fresh-output/cli.mjs
```

Do not use the historical backend-cwd command in `reconstruction.md`.
It produced a different bundle, correctly refused by the native asset guard.

| Asset | Approved SHA-256 |
| --- | --- |
| producer bundle | `43a3d180cf01602ccacfc01147d934a5a437f5767eccb1a1ce933bdaa4d7` |
| checker.py | `b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e` |
| Node 22.23.4 executable | `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90` |
| Python 3.12 executable | `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f` |

Reproducing the bundle with a declared existing esbuild proves source-byte
correspondence only. It does not establish an own-lock installed environment.

## Future own-lock install, currently blocked by headroom/user direction

Do not install, build full applications or run another large replay in this
attempt. The original safe requirement is at least 4 GiB free; the final
preflight records actual available bytes and refuses before npm/build/replay.
This is separate from missing native DB/Auth authority.

The correct argument names are `--reconstruction` and `--output`:

```sh
flock /home/factory-user/repos/finnor-z-shared-heavy.lock \
  node /home/factory-user/repos/finnor-z3/finnor-os/scripts/project-z/z3/install-reconstruction.mjs \
  --reconstruction=/absolute/fresh-owned-reconstruction \
  --output=/absolute/fresh-owned-install-receipt \
  --preflight-only
```

Only after safe headroom and renewed permission, omit `--preflight-only`.
The driver requires fresh local dependency directories, runs both own-lock
`npm ci` operations, real catalogue/client/form/workspace checks and lint,
native-module rebuild/load, full backend/entry types and frontend/API builds.
It initializes only disposable Git metadata for the coverage check, using
the configured identity, existing hooks and required bot coauthor. It never
creates a DB, owner, listener or authorization. Graph checks use 4096 MiB
only under the shared heavy lock; other steps stay at 1536 MiB.

It then builds the root-cwd producer, runs the finite public replay and
offline boundary cases, and records generated source deltas, dependency
locality, assets, actual exits and build IDs. Its comparator is:

```sh
node /absolute/source/finnor-os/scripts/project-z/z3/compare-reconstruction.mjs \
  --source-run=/absolute/source-reference \
  --installed-run=/absolute/installation/public \
  --reconstruction=/absolute/reconstruction \
  --installation=/absolute/installation \
  --output=/absolute/fresh-comparison
```

The comparator's qualification is separately lock-installed PUBLIC
engineering replay, not native-owner reconstruction. It cannot qualify the
final source from an older installation. `install-01/report.json` is FAIL
(catalogue, omitted configs, wrong-cwd producer); install-02 never installed
because its invocation used invalid flags. Preserve all originals.

## Native and other gates remain separate

`native-authorization-v2.md` specifies an existing-target contract, not
permission. The guarded native driver already exists and must remain NOT_RUN
until explicit existing disposable DB/Auth/owner/worker authority is delivered.
Do not rerun historical unauthorized DDL. No provisioning, fake owner,
renewed budget, S6 settlement or protected-material movement is authorized.
Mounted authenticated, installed native, protected, equipped, operational/
financial 100x and activation require their own evidence and authority.
