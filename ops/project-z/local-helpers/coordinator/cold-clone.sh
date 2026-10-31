#!/bin/bash
# usage: cold-clone.sh CUT_NAME SOURCE_REPO COMMIT
#
# Builds the cold target for one final cut: a full local clone of the owned checkout at exactly COMMIT, then the two
# locked `npm ci` installs. No donor modules, no pre-existing build output, no network Git. Writes a receipt with the
# commit, tree, lock hashes, toolchain, install exits and log hashes. Refuses an existing target (a new immutable
# name is required for every attempt). Run it through queue-run.sh in heavy mode (holds only disk and CPU).
set -uo pipefail
CUT=$1; SRC=$2; COMMIT=$3
ROOT=/home/factory-user/repos/fzv-cold
DEST=$ROOT/$CUT
OUT=/home/factory-user/repos/fzv-int-out/cold/$CUT
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
[ -n "$CUT" ] && [ -d "$SRC/.git" ] && [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: cold-clone.sh CUT_NAME SOURCE_REPO COMMIT40"; exit 2; }
[ ! -e "$DEST" ] && [ ! -e "$OUT" ] || { echo "TARGET_EXISTS_NEW_NAME_REQUIRED"; exit 3; }
FREE_KB=$(df --output=avail -k /home | tail -n1)
[ "$FREE_KB" -ge $((6 * 1024 * 1024)) ] || { echo "SIX_GIB_FREE_REQUIRED_HAVE_KB=$FREE_KB"; exit 4; }
mkdir -p "$ROOT" "$OUT"
step() { # name, command...
  local name=$1; shift
  local start=$(date +%s)
  "$@" >"$OUT/$name.log" 2>&1
  local rc=$?
  echo "{\"name\":\"$name\",\"exit\":$rc,\"wallS\":$(( $(date +%s) - start )),\"logSha256\":\"$(sha256sum "$OUT/$name.log" | cut -d' ' -f1)\"}" >>"$OUT/steps.jsonl"
  echo "### $name rc=$rc"
  return $rc
}
step clone git clone --no-hardlinks --no-checkout "$SRC" "$DEST" || exit 10
step checkout git -C "$DEST" checkout --detach "$COMMIT" || exit 11
[ "$(git -C "$DEST" rev-parse HEAD)" = "$COMMIT" ] || { echo "CHECKED_OUT_COMMIT_MISMATCH"; exit 12; }
[ -z "$(git -C "$DEST" status --porcelain)" ] || { echo "CLONE_NOT_CLEAN"; exit 13; }
[ ! -e "$DEST/node_modules" ] && [ ! -e "$DEST/finnor-os/node_modules" ] && [ ! -e "$DEST/.next" ] || { echo "DONOR_OR_BUILD_OUTPUT_PRESENT"; exit 14; }
# A fresh npm cache proves the install did not lean on a warm one; it is removed again below.
export npm_config_cache="$ROOT/.npm-cache-$CUT"
step root-npm-ci bash -c "cd '$DEST' && npm ci --no-audit --no-fund" || exit 15
step backend-npm-ci bash -c "cd '$DEST/finnor-os' && npm ci --no-audit --no-fund" || exit 16
rm -rf "$npm_config_cache"
python3 - "$DEST" "$OUT" "$COMMIT" "$SRC" <<'PY'
import hashlib, json, os, platform, subprocess, sys
dest, out, commit, src = sys.argv[1:5]
def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
escapes = []
for base in ("node_modules", "finnor-os/node_modules"):
    top = os.path.realpath(os.path.join(dest, base))
    if not top.startswith(os.path.realpath(dest) + os.sep):
        escapes.append(base)
        continue
    for current, dirs, files in os.walk(os.path.join(dest, base)):
        for name in dirs + files:
            path = os.path.join(current, name)
            if os.path.islink(path):
                target = os.path.realpath(path)
                if not target.startswith(os.path.realpath(dest) + os.sep):
                    escapes.append(os.path.relpath(path, dest))
steps = [json.loads(line) for line in open(os.path.join(out, "steps.jsonl"))]
receipt = {
    "schema": "finnor.project-z.cold-clone.v1",
    "commit": commit, "tree": run("git", "-C", dest, "rev-parse", "HEAD^{tree}"), "sourceRepository": src,
    "target": dest, "steps": steps,
    "locks": {name: sha(os.path.join(dest, name)) for name in ("package-lock.json", "finnor-os/package-lock.json")},
    "installedPackageCounts": {
        "root": len([d for d in os.listdir(os.path.join(dest, "node_modules")) if not d.startswith(".")]),
        "backend": len([d for d in os.listdir(os.path.join(dest, "finnor-os/node_modules")) if not d.startswith(".")]),
    },
    "symlinksEscapingTarget": escapes,
    "toolchain": {"node": run("node", "--version"), "npm": run("npm", "--version"),
                  "python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
                  "libc": list(platform.libc_ver()), "cc": run("cc", "--version").splitlines()[:1],
                  "make": run("make", "--version").splitlines()[:1], "nodeSha256": sha(run("which", "node"))},
    "npmCache": "fresh directory removed after the install",
    "borrowedNodeModules": bool(escapes), "buildOutputPresent": os.path.exists(os.path.join(dest, ".next")),
}
with open(os.path.join(out, "cold-receipt.json"), "w") as f:
    json.dump(receipt, f, indent=2)
    f.write("\n")
print(json.dumps({"commit": commit, "escapes": len(escapes), "root": receipt["installedPackageCounts"]}))
sys.exit(1 if escapes else 0)
PY
RC=$?
echo "### receipt rc=$RC"
exit $RC
