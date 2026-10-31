#!/bin/bash
# Measure the production API next build (same install + build commands the release artifact uses) for a checkout.
# usage: api-build-measure.sh LABEL REPO_ROOT HEAP_MB [WAIT_NAME]
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
LABEL=$1; ROOT=$2; HEAP=$3; WAIT=${4:-}
OUT=/home/factory-user/repos/fzv-int-out
if [ -n "$WAIT" ]; then while [ ! -f "$OUT/$WAIT.exit" ]; do sleep 10; done; fi
cd $ROOT
echo "### head $(git rev-parse HEAD) heap=$HEAP"
CTX=$(node --input-type=module -e "import('$ROOT/scripts/release/vercel-build-context.mjs').then(m=>console.log(m.apiBuildContext('$ROOT').directory))")
echo "### context $CTX"
cd $CTX
ls
cd finnor-os/apps/api 2>/dev/null || cd apps/api
echo "### install $(date -u +%T)"
npm ci --include-workspace-root --no-audit --no-fund 2>&1 | tail -3
echo "### build $(date -u +%T)"
NODE_OPTIONS=--max-old-space-size=$HEAP /usr/bin/time -v npm run build > $OUT/$LABEL.build.log 2>&1
RC=$?
echo "### build rc=$RC $(date -u +%T)"
grep -E "Maximum resident|Elapsed|Exit status" $OUT/$LABEL.build.log
grep -E "Compiled|Collecting build traces|Generating static|FATAL" $OUT/$LABEL.build.log | head
du -sh .next 2>/dev/null
exit $RC
