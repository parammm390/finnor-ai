#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z4 || exit 97
exec /home/factory-user/repos/fzv-int-out/z4-native-run.sh w4-seed-02 z4 finnor-os/scripts/project-z/native/z4-session.mjs --session-stage=seed --auth-tls --no-worker
