#!/bin/bash
# Measure the production API next build (same install + build commands the release artifact uses) for a checkout.
# usage: api-build-measure2.sh LABEL REPO_ROOT HEAP_MB [WAIT_NAME]
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
LABEL=$1; ROOT=$2; HEAP=$3; WAIT=${4:-}
OUT=/home/factory-user/repos/fzv-int-out
if [ -n "$WAIT" ]; then while [ ! -f "$OUT/$WAIT.exit" ]; do sleep 10; done; fi
cd $ROOT
echo "### head $(git rev-parse HEAD) heap=$HEAP"
CTX=$(node --input-type=module -e "import('$ROOT/scripts/release/vercel-build-context.mjs').then(m=>console.log(m.apiBuildContext('$ROOT').directory))")
echo "### context $CTX"
cd $CTX
cd finnor-os/apps/api 2>/dev/null || cd apps/api
echo "### install $(date -u +%T)"
npm ci --include-workspace-root --no-audit --no-fund 2>&1 | tail -3
echo "### build $(date -u +%T)"
NODE_OPTIONS=--max-old-space-size=$HEAP python3 -c '
import resource, subprocess, sys, time
t = time.time()
p = subprocess.run(["npm", "run", "build"], stdout=open(sys.argv[1], "wb"), stderr=subprocess.STDOUT)
r = resource.getrusage(resource.RUSAGE_CHILDREN)
print("maxrss_children_mb", r.ru_maxrss // 1024, "elapsed_s", round(time.time() - t), "rc", p.returncode)
sys.exit(p.returncode)' "$OUT/$LABEL.build.log"
RC=$?
echo "### build rc=$RC $(date -u +%T)"
grep -E "Compiled|Collecting build traces|Generating static|FATAL|heap out of memory" $OUT/$LABEL.build.log | head
du -sh .next 2>/dev/null
find .next -name "*.nft.json" 2>/dev/null | wc -l
cd /
case "$CTX" in /tmp/finnor-api-build-*) rm -rf "$CTX";; esac
exit $RC
