#!/bin/bash
# usage: sync-wt.sh LOCAL_WORKTREE REMOTE_WORKTREE
# Makes the remote worktree's tracked files identical to the local worktree's committed HEAD.
# Untracked remote files (evidence, build output) are preserved. Commit locally first; uncommitted edits are NOT synced.
# The bundle is always cut from the common base so rewritten local history still syncs.
set -e
L=$1; RW=$2
[ -n "$L" ] && [ -n "$RW" ] || { echo "usage: sync-wt.sh LOCAL_WORKTREE REMOTE_WORKTREE"; exit 2; }
F="-F /tmp/fzv-ssh-config"
BASE=a5209abc15fe40c68f30336c60d95dbfc343c13a
tag=$(basename "$RW")
HEADH=$(git -C "$L" rev-parse HEAD)
if [ "$HEADH" = "$BASE" ]; then
  ssh $F fzv "cd $RW && git reset -q --hard $BASE && git rev-parse HEAD" 2>/dev/null | tail -1
  exit 0
fi
git -C "$L" bundle create /tmp/$tag.bundle $BASE..HEAD >/dev/null 2>&1
scp $F -q /tmp/$tag.bundle fzv:/home/factory-user/repos/$tag.bundle 2>/dev/null
OUT=$(ssh $F fzv "cd $RW && git fetch -q ../$tag.bundle HEAD && git reset -q --hard FETCH_HEAD && git rev-parse HEAD" 2>/dev/null | tail -1)
if [ "$OUT" = "$HEADH" ]; then echo "synced $OUT"; else echo "SYNC MISMATCH local=$HEADH remote=$OUT"; exit 1; fi
