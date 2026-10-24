set -u
REPO=/home/factory-user/repos/finnor-z3
D=$REPO/scope-z/phase-evidence/z3
PATCHDIR=$D/integration-patches
WT=/tmp/z3-post-apply
LOG=$D/independent-verify-postapply.log
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:$PATH
export NODE_OPTIONS=--max-old-space-size=4096
{
echo "== independent post-apply tree verification $(date -u +%FT%TZ) node $(node --version) =="
rm -rf "$WT"
git -C "$REPO" worktree add --detach "$WT" HEAD >/dev/null 2>&1 || { echo "worktree add FAILED"; exit 1; }
cd "$WT"
echo "-- applying nine patches in manifest order --"
node -e '
const fs=require("fs"),cp=require("child_process"),crypto=require("crypto");
const m=JSON.parse(fs.readFileSync("'"$PATCHDIR"'/manifest.json","utf8"));
let bad=0;
for(const name of m.applyOrder){
  const e=m.patches.find(p=>p.patch===name);
  cp.execFileSync("git",["apply","-p1",`'"$PATCHDIR"'/${name}`],{stdio:"pipe"});
  const blob=cp.execFileSync("git",["hash-object",e.path],{encoding:"utf8"}).trim();
  const sha=crypto.createHash("sha256").update(fs.readFileSync(e.path)).digest("hex");
  const okBlob=blob===e.postimageBlob;
  const okPayload=!e.payloadSha256||sha===e.payloadSha256;
  if(!okBlob||!okPayload){bad++;console.log("MISMATCH",name,e.path,blob,okBlob,okPayload);}
  else console.log("OK",name,"->",e.path);
}
console.log("postimage comparison failures:",bad);
process.exit(bad?1:0);
' || echo "POSTIMAGE-COMPARE-FAILED"
echo "-- status (must be exactly the nine targets) --"
git status --short
ln -s "$REPO/node_modules" "$WT/node_modules"
ln -s "$REPO/finnor-os/node_modules" "$WT/finnor-os/node_modules"
mkdir -p "$WT/z3-ui-check"
cat > "$WT/z3-ui-check/tsconfig.json" <<JSON
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "incremental": false, "baseUrl": ".", "paths": { "@/*": ["../src/*"] } },
  "include": ["../src/components/centropy/world/WorldWorkRecord.tsx"]
}
JSON
echo "-- backend typecheck (patched finnor-os) --"
"$WT/finnor-os/node_modules/.bin/tsc" -p "$WT/finnor-os/tsconfig.json"; echo "backend-exit=$?"
echo "-- frontend mount typecheck (patched WorldWorkRecord + ViabilityPanel) --"
"$WT/node_modules/.bin/tsc" -p "$WT/z3-ui-check/tsconfig.json"; echo "frontend-exit=$?"
echo "-- worker entry typecheck (patched worker registration context) --"
"$WT/finnor-os/node_modules/.bin/tsc" -p "$WT/finnor-os/scripts/project-z/z3/tsconfig.entry-check.json"; echo "entry-exit=$?"
cd /
git -C "$REPO" worktree remove --force "$WT" && echo "worktree removed"
} > "$LOG" 2>&1
