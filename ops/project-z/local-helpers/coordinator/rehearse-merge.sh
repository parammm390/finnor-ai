#!/usr/bin/env bash
# Coordinator rehearsal: merge the worker branches in order onto a scratch branch.
# Usage: rehearse-merge.sh NEWBRANCH [BASE]
# Never touches the integrated branch. Stops at the first unresolved conflict and prints it.
set -u
WT=/home/factory-user/repos/finnor-z-rehearsal
NEW=${1:?new branch name}
BASE=${2:-a5209abc15fe40c68f30336c60d95dbfc343c13a}
cd "$WT" || exit 2
if [ -n "$(git status --short)" ]; then echo "rehearsal worktree dirty"; git status --short | head; exit 3; fi
git checkout -q -B "$NEW" "$BASE" || exit 4
for b in w/z4-native w/z1-native w/z0-parent w/z3-s4 w/z5-native w/z2-native w/matrix; do
  echo "=== merge $b @ $(git rev-parse --short "$b")"
  if git -c rerere.enabled=true -c rerere.autoupdate=true merge --no-ff --no-edit -m "Rehearsal: merge $b" "$b" >/tmp/rehearse-merge.out 2>&1; then
    echo "  clean"
  else
    echo "  CONFLICT:"
    git diff --name-only --diff-filter=U
    grep -E "Resolved|CONFLICT|Recorded" /tmp/rehearse-merge.out | head -20
    unresolved=$(git diff --name-only --diff-filter=U | wc -l)
    if [ "$unresolved" != 0 ]; then echo "  unresolved: $unresolved"; exit 10; fi
    git -c core.editor=true commit -q --no-edit -m "Rehearsal: merge $b (rerere)" || exit 11
    echo "  resolved by rerere"
  fi
done
git log --oneline -n 1
git diff --stat "$BASE" HEAD | tail -1
