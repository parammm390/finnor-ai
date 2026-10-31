#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
R=/home/factory-user/repos/fzv-int-01
TAG=${1:-fix-01}
OUT=/home/factory-user/repos/fzv-int-out
cd $R/finnor-os
echo "### start $(date -u +%T) head=$(git rev-parse HEAD)"
npx --no-install tsx scripts/project-z/run-integrated-regression.mts --evidence=$OUT/regression-$TAG -- \
  tests/integration/microsoft365-sync-worker.test.ts tests/integration/production-query-surface.test.ts tests/unit/pe5-runtime-boundary.test.ts \
  > $OUT/regression-$TAG.stdout 2>&1
echo "### rc=$? $(date -u +%T)"
