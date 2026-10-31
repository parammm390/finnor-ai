#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
R=/home/factory-user/repos/fzv-int-01
OUT=/home/factory-user/repos/fzv-int-out
FAIL=0
step(){ name=$1; shift; s=$(date +%s); echo "### $name start $(date -u +%T)"; "$@" > "$OUT/fc2-$name.log" 2>&1; rc=$?; e=$(date +%s); echo "### $name rc=$rc secs=$((e-s))"; echo $rc > "$OUT/fc2-$name.exit"; [ $rc -eq 0 ] || FAIL=$((FAIL+1)); }
cd $R
step tsc-backend npm --prefix finnor-os run typecheck
step tsc-root npx tsc --noEmit
step lint-root npm run lint
step p8-zero npm run release:p8-zero-resurrection
step test-release npm run test:release
echo "### FIRST_CUT2_DONE failures=$FAIL"
exit $FAIL
