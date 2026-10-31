#!/bin/bash
# Regenerate every generated artifact of the integrated candidate in a fixed order, then run the check chain.
# Runs from fzv-int-01 (the remote checkout of the integrated branch). Never commits.
set -u
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=3072
cd /home/factory-user/repos/fzv-int-01 || exit 97
git checkout -- next-env.d.ts 2>/dev/null
echo "HEAD $(git rev-parse HEAD) tree $(git rev-parse 'HEAD^{tree}')"
echo "node $(node --version) npm $(npm --version)"
fail=0
step() { local name=$1; shift; echo; echo "=== $name"; local t0=$(date +%s); "$@"; local rc=$?; echo "--- $name rc=$rc seconds=$(( $(date +%s) - t0 ))"; [ $rc = 0 ] || fail=$((fail+1)); }
FO="--prefix finnor-os"
step db-bundle npm run db:bundle $FO
step openapi npm run openapi $FO
step y1-constructor bash -c 'cd finnor-os && ./node_modules/.bin/tsx scripts/y1/build-constructor.mts'
for s in x3 x4 x5 y2; do step "stamp-$s" bash -c "cd finnor-os && ./node_modules/.bin/tsx scripts/$s/stamp-source.mts"; done
step workspace-generate npm run workspace:generate
step centropy-manifest npm run centropy:manifest
step centropy-coverage npm run centropy:coverage
step centropy-client npm run centropy:client
step centropy-forms npm run centropy:forms
step planner-manifest npm run capabilities:planner-manifest $FO
echo; echo "##### CHECK CHAIN"
step authz-matrix-check npm run authz:matrix:check $FO
step release-manifest-check npm run release:manifest $FO
step pe-domain-boundary npm run release:pe-domain-boundary $FO
step workspace-check npm run workspace:check
step client-check npm run centropy:client:check
step manifest-check npm run centropy:manifest:check
step forms-check npm run centropy:forms:check
step coverage-check npm run centropy:coverage:check
step p8-zero-resurrection npm run release:p8-zero-resurrection
echo; echo "##### CHANGED GENERATED FILES"
git status --short | grep -v '^??' | head -60
git diff --stat | tail -30
echo "failures=$fail"
exit $fail
