#!/bin/bash
# Static/type/lint/release first-cut checks on the integrated candidate. Never stops on first failure.
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
R=/home/factory-user/repos/fzv-int-01
OUT=/home/factory-user/repos/fzv-int-out
FAIL=0
step(){ name=$1; shift; s=$(date +%s); echo "### $name start $(date -u +%T)"; "$@" > "$OUT/fc-$name.log" 2>&1; rc=$?; e=$(date +%s); echo "### $name rc=$rc secs=$((e-s))"; echo $rc > "$OUT/fc-$name.exit"; [ $rc -eq 0 ] || FAIL=$((FAIL+1)); }
cd $R
step tsc-backend npm --prefix finnor-os run typecheck
step tsc-root npx tsc --noEmit
step lint-root npm run lint
step workspace-check npm run workspace:check
step centropy-manifest-check npm run centropy:manifest:check
step centropy-coverage-check npm run centropy:coverage:check
step centropy-client-check npm run centropy:client:check
step centropy-forms-check npm run centropy:forms:check
step authz-check npm run authz:matrix:check --prefix finnor-os
step release-manifest npm run release:manifest --prefix finnor-os
step pe-domain-boundary npm run release:pe-domain-boundary --prefix finnor-os
step p8-zero npm run release:p8-zero-resurrection
step release-truth npm run release:truth
step test-release npm run test:release
step ci-workflows node scripts/release/verify-ci-workflows.mjs
step test-shards node scripts/release/verify-test-shards.mjs
echo "### FIRST_CUT_DONE failures=$FAIL"
exit $FAIL
