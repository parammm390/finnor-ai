set -u
REPO=/home/factory-user/repos/finnor-z3
D=$REPO/scope-z/phase-evidence/z3
PATCHDIR=$D/integration-patches
WT=/tmp/z3-post-apply
LOG=$D/independent-verify-postapply-frontend.log
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
{
echo "== frontend post-apply re-check with next-env.d.ts $(date -u +%FT%TZ) node $(node --version) =="
rm -rf "$WT"
git -C "$REPO" worktree add --detach "$WT" HEAD >/dev/null 2>&1 || { echo "worktree add FAILED"; exit 1; }
cd "$WT"
for p in 0001-postz-z3-migration 0001b-bundle-generator-whitelist 0001c-migrations-bundle 0001d-migration-head 0002-compute-contract 0003-worker-register 0004-company-brain-route 0005-mounted-work-panel 0005b-viability-panel-file; do
  git apply -p1 "$PATCHDIR/$p.patch"
done
ln -s "$REPO/node_modules" "$WT/node_modules"
mkdir -p "$WT/z3-ui-check"
cat > "$WT/z3-ui-check/tsconfig.json" <<JSON
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "incremental": false, "baseUrl": ".", "paths": { "@/*": ["../src/*"] } },
  "include": ["../next-env.d.ts", "../src/components/centropy/world/WorldWorkRecord.tsx"]
}
JSON
"$WT/node_modules/.bin/tsc" -p "$WT/z3-ui-check/tsconfig.json"; echo "frontend-exit=$?"
echo "-- control: same check WITHOUT the two panel patches (pre-existing baseline) --"
cd /
git -C "$REPO" worktree remove --force "$WT"
git -C "$REPO" worktree add --detach "$WT" HEAD >/dev/null 2>&1
cd "$WT"
ln -s "$REPO/node_modules" "$WT/node_modules"
mkdir -p "$WT/z3-ui-check"
cat > "$WT/z3-ui-check/tsconfig.json" <<JSON
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "incremental": false, "baseUrl": ".", "paths": { "@/*": ["../src/*"] } },
  "include": ["../next-env.d.ts", "../src/components/centropy/world/WorldWorkRecord.tsx"]
}
JSON
"$WT/node_modules/.bin/tsc" -p "$WT/z3-ui-check/tsconfig.json"; echo "baseline-exit=$?"
cd /
git -C "$REPO" worktree remove --force "$WT" && echo "worktree removed"
} > "$LOG" 2>&1
