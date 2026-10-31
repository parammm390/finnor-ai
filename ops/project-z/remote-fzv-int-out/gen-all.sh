#!/bin/bash
# Write-mode generators for the integrated candidate, in dependency order. Exits non-zero on first failure.
set -u
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
R=/home/factory-user/repos/fzv-int-01
step(){ echo "### $1 $(date -u +%T)"; shift; "$@"; rc=$?; echo "### rc=$rc"; [ $rc -eq 0 ] || FAIL=1; }
FAIL=0
cd $R/finnor-os
step x3-stamp  npx tsx scripts/x3/stamp-source.mts
step x5-stamp  npx tsx scripts/x5/stamp-source.mts
step x4-stamp  npx tsx scripts/x4/stamp-source.mts
step y2-stamp  npx tsx scripts/y2/stamp-source.mts
step y1-constructor npx tsx scripts/y1/build-constructor.mts
step authz-matrix npx tsx scripts/generate-authz-matrix.ts
step openapi npm run openapi
step planner-manifest npm run capabilities:planner-manifest
cd $R
step workspace npm run workspace:generate
step centropy-client npm run centropy:client
step centropy-manifest npm run centropy:manifest
step centropy-forms npm run centropy:forms
step centropy-coverage npm run centropy:coverage
echo "### ALL_DONE fail=$FAIL"
exit $FAIL
