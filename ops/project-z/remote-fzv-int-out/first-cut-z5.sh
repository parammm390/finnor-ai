#!/bin/bash
# Z5 public-lane gates (evidence dirs must be fresh and inside scope-z/phase-evidence/z5).
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
R=/home/factory-user/repos/fzv-int-01
OUT=/home/factory-user/repos/fzv-int-out
TAG=${1:-01}
FAIL=0
step(){ name=$1; shift; s=$(date +%s); echo "### $name start $(date -u +%T)"; "$@" > "$OUT/fcz5-$TAG-$name.log" 2>&1; rc=$?; e=$(date +%s); echo "### $name rc=$rc secs=$((e-s))"; echo $rc > "$OUT/fcz5-$TAG-$name.exit"; [ $rc -eq 0 ] || FAIL=$((FAIL+1)); }
cd $R/finnor-os
echo "### head $(git rev-parse HEAD)"
for s in finite-boundary process recovery offline; do
  step z5-$s node scripts/project-z/z5/$s-e2e.mjs $R/scope-z/phase-evidence/z5/integrated-$TAG-$s
done
echo "### FIRST_CUT_Z5_DONE failures=$FAIL"
exit $FAIL
