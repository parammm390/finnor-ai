#!/bin/bash
# usage: regen-int.sh [DIR]   (run on the remote host; DIR defaults to the integrated checkout)
# Regenerates every generated artifact that merging phase heads can stale, in dependency order, twice so the
# result is a fixed point, then runs each artifact's own --check. Writes only tracked generated files.
# Order (from the generators' own headers): OpenAPI, then the X3 -> X5 -> X4 stamps and the Y2 stamp, then the
# capability manifest, forms, client types, the planner replay manifest and last the coverage audit.
set -euo pipefail
D=${1:-/home/factory-user/repos/fzv-int-01}
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd "$D"
TSX="$D/finnor-os/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "NO_TSX_IN_$D"; exit 97; }
run() { echo "+ $*"; "$@"; }
pass() {
  (cd finnor-os && run "$TSX" scripts/bundle-migrations.ts)
  (cd finnor-os && run "$TSX" scripts/generate-openapi.ts)
  (cd finnor-os && run "$TSX" scripts/x3/stamp-source.mts && run "$TSX" scripts/x5/stamp-source.mts &&
    run "$TSX" scripts/x4/stamp-source.mts && run "$TSX" scripts/y2/stamp-source.mts)
  run node scripts/centropy/generate-capability-manifest.mjs
  run node scripts/centropy/generate-human-forms.mjs
  run node scripts/centropy/generate-openapi-client.mjs
  (cd finnor-os && run "$TSX" scripts/release/generate-planner-replay-manifest.mts)
  run node scripts/centropy/audit-capability-coverage.mjs
}
echo "== pass 1"; pass
git status --short | sed 's/^/  after pass 1: /' | head -30
H1=$(git diff | sha256sum | cut -d' ' -f1)
echo "== pass 2 (must change nothing)"; pass
H2=$(git diff | sha256sum | cut -d' ' -f1)
[ "$H1" = "$H2" ] || { echo "REGEN_NOT_A_FIXED_POINT $H1 $H2"; exit 98; }
echo "== checks"
(cd finnor-os && run "$TSX" scripts/x3/stamp-source.mts --check && run "$TSX" scripts/x5/stamp-source.mts --check &&
  run "$TSX" scripts/x4/stamp-source.mts --check && run "$TSX" scripts/y2/stamp-source.mts --check)
run node scripts/centropy/generate-capability-manifest.mjs --check
run node scripts/centropy/generate-human-forms.mjs --check
run node scripts/centropy/generate-openapi-client.mjs --check
run node scripts/centropy/audit-capability-coverage.mjs --check
run node scripts/generate-workspace-contract.mjs --check
echo "REGEN_OK"
git status --short | sed 's/^/  changed: /'
