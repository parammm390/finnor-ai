#!/bin/bash
# Integrated candidate static + public-lane cut checks (remote, fzv-int-01). Never stops on first failure.
# usage: int-cut.body.sh TAG
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
R=/home/factory-user/repos/fzv-int-01
OUT=/home/factory-user/repos/fzv-int-out
TAG=${1:?tag}
FAIL=0
step(){ name=$1; shift; s=$(date +%s); echo "### $name start $(date -u +%T)"; "$@" > "$OUT/cut$TAG-$name.log" 2>&1; rc=$?; e=$(date +%s); echo "### $name rc=$rc secs=$((e-s))"; echo $rc > "$OUT/cut$TAG-$name.exit"; [ $rc -eq 0 ] || FAIL=$((FAIL+1)); }
cd $R || exit 97
git checkout -- next-env.d.ts 2>/dev/null
echo "### head $(git rev-parse HEAD) tree $(git rev-parse 'HEAD^{tree}') status=$(git status --short | grep -v '^??' | wc -l)"
chmod 0500 finnor-os/packages/epistemic-runtime/native/z4-execution-proof/bin/z4-proof finnor-os/packages/epistemic-runtime/native/z4-execution-proof/bin/z4-field-falsifier 2>/dev/null
step project-z-ci-e2e node scripts/release/project-z-ci.e2e.mjs
for ph in z1 z2 z3 z4; do
  step runci-$ph taskset -c 0,1 node scripts/project-z/run-ci.mjs --phase=$ph --evidence=$OUT/runci-$TAG-$ph
done
cd $R/finnor-os
for s in finite-boundary process recovery offline; do
  step z5-$s node scripts/project-z/z5/$s-e2e.mjs $R/scope-z/phase-evidence/z5/integrated-$TAG-$s
done
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
git checkout -- next-env.d.ts 2>/dev/null
echo "### INT_CUT_DONE failures=$FAIL head=$(git rev-parse HEAD) status=$(git status --short | grep -v '^??' | wc -l)"
exit $FAIL
