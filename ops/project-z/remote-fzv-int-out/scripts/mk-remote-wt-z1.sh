#!/bin/bash
set -e
BASE=a5209abc15fe40c68f30336c60d95dbfc343c13a
cd /home/factory-user/repos/fzv-int-01
W=/home/factory-user/repos/fzv-w-z1
if [ -e "$W" ]; then echo "exists $W"; exit 0; fi
git worktree add --detach "$W" $BASE >/dev/null 2>&1
cp -a /home/factory-user/repos/fzv-int-01/node_modules "$W/node_modules"
cp -a /home/factory-user/repos/fzv-int-01/finnor-os/node_modules "$W/finnor-os/node_modules"
echo "created $W $(git -C $W rev-parse HEAD)"
df -h /home/factory-user | tail -1
