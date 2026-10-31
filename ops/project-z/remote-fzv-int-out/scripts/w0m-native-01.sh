#!/bin/bash
export PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/repos/fzv-int-s3-python/bin/python
cd /home/factory-user/repos/fzv-w-z0m || exit 97
exec /home/factory-user/repos/fzv-int-out/native-run-z0m.sh w0m-native-01 z0 finnor-os/scripts/project-z/native/z0-mounted-session.mjs --no-worker
