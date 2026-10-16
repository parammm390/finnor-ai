# Reconstruct the bounded serial source cut

These are explicit commands for a future newly registered finite campaign.
They are **not permission to rerun the exhausted current campaign**. They do not
publish, deploy, install dependencies or apply patches to common product source.

## 1. Verify source and shared custody

Start from the final exact local commit/tree in `sealed-cut.json`, with the
immutable base and lead objects available. Verify `source-pin.json`, origin
blobs/current postimages, repaired-origin patch and every shared proposal digest.
Use a new isolated destination; never overwrite a dirty path or existing cut.
The current final owned executable files match private `serial-cut-v7`; later
custody documents are separately hashed in `handoff-index.json`.

The helper reads the pinned cumulative base through Git, exports bounded actual
backend/frontend/config/font/public sources, overlays owned R7 leaves, checks
each exact shared preimage, applies ordered patches **only in that fresh cut**,
checks postimages and creates an explicit source manifest. It borrows dependency
directories by symlink; it does not copy their contents.

```sh
REPO=/Users/paramdave/.factory/worktrees/r7-bounded-adoption-producer-2026-10-11/FINNOR
BORROW=/Users/paramdave/.codex/visualizations/2026/10/09/01a121d2-7d60-77d2-8611-b4712a5bb84f/r2-package-final
CUT=/tmp/finnor-r7-new-registered-serial-cut
NODE=/Users/paramdave/.local/bin/node
cd "$REPO/finnor-os" &&
"$NODE" scripts/r7/serial-projection.mjs "$CUT" \
  "$BORROW/source/finnor-os/node_modules" "$BORROW/source/node_modules"
```

The destination must not already exist. `serial-projection.json` names all
source hashes and borrowed paths. On a different authorized host, supply actual
explicit dependency/runtime paths with verified hashes from
`runtime-licenses.json`; a missing asset is a gap, not permission to install or
guess an endpoint.

## 2. Structural checks and generation

```sh
cd "$CUT/finnor-os" &&
"$NODE" "$BORROW/source/finnor-os/node_modules/typescript/bin/tsc" \
  -p scripts/r7/tsconfig.json --noEmit
cd "$CUT" &&
"$NODE" scripts/centropy/generate-capability-manifest.mjs &&
"$NODE" scripts/centropy/generate-capability-manifest.mjs --check
cd "$CUT/finnor-os" &&
"$NODE" --import=tsx scripts/generate-openapi.ts
```

The previously used focused UI configuration is pinned as
`/tmp/finnor-r7-bounded-adoption-20261011.KAtOCr/serial-cut-v7/ui-tsconfig.json`.
Rebind only its documented root paths in a new isolated configuration; do not
weaken its includes/types. No root/production build or native behavior is inferred
from these checks. Generated files stay private until the integrator regenerates
them from an actual compatible joined source.

After rebinding only the configuration's absolute `extends` path:

```sh
cd "$CUT" &&
"$NODE" "$BORROW/source/node_modules/typescript/bin/tsc" \
  -p ui-tsconfig.json --noEmit --incremental false
```

## 3. Registered original exact and owner commands

Require an explicitly new external evidence root and an absolute global expiry/
full material-resource meter. Copy the frozen case selection/limits, record
commands/environment hashes and stop INCOMPLETE on exhaustion.

```sh
EVIDENCE=/tmp/finnor-r7-new-registered-evidence
cd "$CUT/finnor-os" &&
FINNOR_R7_EVIDENCE_DIR="$EVIDENCE/exact" \
  "$NODE" --import=tsx scripts/r7/run-exact.mts
cd "$CUT/finnor-os" &&
FINNOR_R7_EVIDENCE_DIR="$EVIDENCE/information" \
  "$NODE" --import=tsx scripts/r7/run-information.mts
```

For actual owner tests set:

```sh
cd "$CUT/finnor-os" &&
TMPDIR=/tmp \
TSX_TSCONFIG_PATH="$CUT/finnor-os/scripts/r7/tsconfig.json" \
FINNOR_R7_SERIAL_SCHEMA="$CUT/scope-r/r7-policy-atlas-compiler/handoff/proposals/r7-policy-atlas.sql" \
FINNOR_R7_ALT_PYTHON="$BORROW/python/bin/python3.12" \
FINNOR_R7_CASE_FILTER="<exact 23-case list from evidence-index.json>" \
FINNOR_R7_EVIDENCE_DIR="$EVIDENCE/owners" \
  "$NODE" --import=tsx scripts/r7/run-owner.mts
```

Do not use the placeholder literally or add unregistered cases. `--browser`
requires fresh verified assigned Factory tab/target, a sticky pane pin and the
original native target-hit/trusted-input checks. The old assignment is historical
evidence, not reusable authority. The mounted remainder remains failed/not run.
The strongest retained numeric S5 suite additionally requires an actual sealed
NumPy/SciPy interpreter absent in this campaign.

## 4. Actual serial release

Only the main cumulative integrator applies the six patches to shared source,
assigns the schema ordinal and regenerates head/bundle/guards/catalogs/clients.
The current unnumbered DDL and disposable source-native run do not qualify
fresh/upgrade/restart, installed builder/checker/API/worker, old job compatibility,
P7 dispatch, admission, activation or a combined R cut. Follow `requests.json`
and append actual independent receipts; do not replace missing receipts with this
reconstruction guide.
