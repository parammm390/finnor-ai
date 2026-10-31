#!/usr/bin/env bash
# Coordinator: merge the current worker branch heads into the integrated candidate branch.
# Usage: merge-real.sh [branch ...]   (default: all, in the recorded order)
# Local only. Never pushes. Uses the recorded rerere resolutions; stops at the first unresolved conflict.
set -u
WT=/home/factory-user/repos/finnor-z-integrated
BRANCH=codex/project-z-integrated-20261030
cd "$WT" || exit 2
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || { echo "wrong branch"; exit 3; }
if [ -n "$(git status --short)" ]; then echo "integrated worktree dirty"; git status --short | head; exit 4; fi
ORDER=${*:-"w/z4-native w/z1-native w/z0-parent w/z3-s4 w/z5-native w/z2-native w/matrix"}
declare -A LABEL=( [w/z4-native]="Z4 native session" [w/z1-native]="Z1 native session" [w/z0-parent]="Z0 original-parent session"
  [w/z3-s4]="Z3 S4 consumption session" [w/z5-native]="Z5 native session" [w/z2-native]="Z2 installed native session"
  [w/matrix]="requirement-case matrix" )
TRAILER="Co-authored-by: factory-droid[bot] <138933559+factory-droid[bot]@users.noreply.github.com>"
for b in $ORDER; do
  head=$(git rev-parse "$b") || exit 5
  if git merge-base --is-ancestor "$head" HEAD; then echo "=== $b @ ${head:0:7} already merged"; continue; fi
  echo "=== merge $b @ ${head:0:7}"
  msg="Merge ${LABEL[$b]:-$b} head ${head:0:12} into the integrated candidate

$TRAILER"
  if git -c rerere.enabled=true -c rerere.autoupdate=true merge --no-ff --no-edit -m "$msg" "$b" >/tmp/merge-real.out 2>&1; then
    echo "  clean"
  else
    echo "  CONFLICT:"; git diff --name-only --diff-filter=U
    unresolved=$(git diff --name-only --diff-filter=U | wc -l)
    if [ "$unresolved" != 0 ]; then echo "  unresolved: $unresolved"; exit 10; fi
    git -c core.editor=true commit -q -m "$msg" || exit 11
    echo "  resolved by rerere"
  fi
done
git log --oneline -n 1
git diff --stat a5209abc15fe40c68f30336c60d95dbfc343c13a HEAD | tail -1
