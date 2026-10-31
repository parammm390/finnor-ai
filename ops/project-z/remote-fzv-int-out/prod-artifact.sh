#!/bin/bash
# First-cut production artifact build: real vercel builder, no credentials.
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
TAG=${1:-01}
OUT=/home/factory-user/repos/fzv-int-out
TOOLS=/home/factory-user/repos/fzv-tools
R=/home/factory-user/repos/fzv-int-01
mkdir -p $TOOLS
if [ ! -x $TOOLS/node_modules/.bin/vercel ]; then
  echo "### installing vercel@50.15.1 $(date -u +%T)"
  (cd $TOOLS && npm install --no-audit --no-fund --prefix $TOOLS vercel@50.15.1) || exit 11
fi
export PATH=$TOOLS/node_modules/.bin:$PATH
vercel --version
cd $R
echo "### api-artifact handoff test $(date -u +%T)"
node --test scripts/release/api-artifact.e2e.test.mjs
RC1=$?
echo "### api-artifact rc=$RC1"
echo "### production-artifact $(date -u +%T)"
FINNOR_ARTIFACT_EVIDENCE_DIR=$OUT/production-artifact-$TAG node scripts/release/production-artifact.e2e.mjs
RC2=$?
echo "### production-artifact rc=$RC2 $(date -u +%T)"
exit $((RC1 + RC2))
