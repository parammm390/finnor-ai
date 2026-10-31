#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-r12 || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run.sh wr12-native-01 v2 finnor-os/scripts/project-z/native/z0-r12-session.mjs --no-worker
